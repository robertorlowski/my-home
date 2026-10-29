// Włącznik: przekaźniki, ich tryby, polecenia dla sterownika i historia włączeń.
// Sterownik co kilka sekund zgłasza stan przekaźników (POST /switch/state) i w
// odpowiedzi dostaje polecenie dla każdego: wyłącz albo włącz na offAfterS sekund
// (bez limitu w trybie on). Polecenie liczy się przy każdym zgłoszeniu z trybu i
// harmonogramu, więc nie ma osobnego schedulera; zmiana trybu albo harmonogramu
// budzi sterownik komunikatem WebSocket "operation".
import { SwitchActivationModel } from '../models/switch-activation.model';
import { SwitchRelayModel } from '../models/switch-relay.model';
import { SwitchScheduleModel } from '../models/switch-schedule.model';
import {
  ActivationSource, CommandSource, RELAY_MODES, RelayCommand, RelayMode, RelayReport, SwitchRelay, SwitchSchedule,
} from '../types';
import { activeSchedule, nextScheduleStart } from './switch-schedule.service';
import { noteRelayReport } from './switch-operation-log.service';
import { notify } from '../../../core/services/push.service';
import { both, t } from '../../../core/i18n';

export const MAX_RELAYS = 16;
// „Włącz na…”: od 1 min do 7 dni
export const MAX_TIMER_MINUTES = 7 * 24 * 60;
// sterownik zgłasza się co 5 s; po 5 min ciszy aplikacja i kafelek pokazują „offline” (do 2026-10-08: 30 s, potem 60 s)
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;
// stan, który sterownik ma od startu, przy wyłączeniu po restarcie: koniec włączenia
// jest nieznany (utrata zasilania), więc przyjmujemy ostatnie zgłoszenie
const BOOT_MARGIN_S = 5;

type RelayDoc = SwitchRelay & { _id?: unknown };
type ScheduleDoc = SwitchSchedule & { _id?: unknown };

// Liczba przekaźników ze zgłoszenia albo zgłoszenia stanu: całkowita 1–MAX_RELAYS.
export const isRelayCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_RELAYS;

// Mniej zapytań przy zgłoszeniu co 5 s (2026-10-29, limit transferu Render; wcześniej ok. 12 operacji na bazie
// na zgłoszenie): pamięć procesu, po restarcie serwera pierwsze zgłoszenie robi wszystko jak dawniej.
// - knownRelayCount: przekaźniki zakładane tylko przy innej liczbie niż ostatnio (zmienia je tylko ensureRelays);
// - reported: ostatni przetworzony stan przekaźnika (historia włączeń sprawdzana tylko przy zmianie stanu) i dokładny
//   czas ostatniego zgłoszenia, bo lastSeenAt w bazie jest zapisywane najwyżej raz na LAST_SEEN_WRITE_MS.
const knownRelayCount = new Map<string, number>();
const reported = new Map<string, { on: boolean; changedAt: number; seenAt: Date }>();
const relayKey = (rootId: string, relay: number) => `${rootId}:${relay}`;
// lastSeenAt służy do „online” (5 min) i „dane sprzed”; minuta wystarcza
const LAST_SEEN_WRITE_MS = 60_000;
// changedAt = now − changedS różni się między zgłoszeniami o sekundę z powodu czasu przesyłu
const CHANGED_AT_TOLERANCE_MS = 5_000;

// Przekaźniki 1…count istnieją (nowe w trybie harmonogramu, wyłączone), a nadmiarowe
// (sterownik zgłasza mniej niż wcześniej) są usuwane razem z harmonogramami.
export async function ensureRelays(rootId: string, deviceId: string, count: number): Promise<void> {
  if (knownRelayCount.get(rootId) === count) return;
  await Promise.all(Array.from({ length: count }, (_, index) =>
    SwitchRelayModel.updateOne(
      { rootId, relay: index + 1 },
      { $setOnInsert: { deviceId, name: '', mode: 'schedule', on: false } },
      { upsert: true },
    )));
  await SwitchRelayModel.deleteMany({ rootId, relay: { $gt: count } });
  await SwitchScheduleModel.deleteMany({ rootId, relay: { $gt: count } });
  knownRelayCount.set(rootId, count);
}

// Ostatnie zgłoszenie przekaźnika: dokładne z pamięci, a po restarcie serwera z bazy.
const lastSeen = (rootId: string, relay: RelayDoc): Date | undefined => {
  const seen = reported.get(relayKey(rootId, relay.relay))?.seenAt;
  const stored = relay.lastSeenAt ? new Date(relay.lastSeenAt) : undefined;
  return seen && (!stored || seen > stored) ? seen : stored;
};

// Tryby z końcem (timer, pause) po upływie until działają jak harmonogram (zapis w bazie przy najbliższym zgłoszeniu).
const timed = (mode: RelayMode) => mode === 'timer' || mode === 'pause';
const effectiveMode = (relay: RelayDoc, now: Date): RelayMode =>
  timed(relay.mode) && (!relay.until || new Date(relay.until) <= now) ? 'schedule' : relay.mode;

// tryb w poleceniu dla sterownika: firmware zna schedule / on / timer / off i odrzuca polecenie z inną nazwą
const wireMode = (mode: RelayMode): RelayMode => (mode === 'pause' ? 'schedule' : mode);

const secondsUntil = (until: Date, now: Date) => Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));

// Polecenie dla przekaźnika w chwili now, z końcem włączenia (until) i wpisem harmonogramu.
export function relayCommand(
  relay: RelayDoc,
  schedules: ScheduleDoc[],
  now: Date,
): { command: RelayCommand; mode: RelayMode; until: Date | null; scheduleId: string | null } {
  const mode = effectiveMode(relay, now);
  if (mode === 'on') return { command: { on: true }, mode, until: null, scheduleId: null };
  if (mode === 'off') return { command: { on: false }, mode, until: null, scheduleId: null };
  if (mode === 'timer') {
    const until = new Date(relay.until as Date);
    return { command: { on: true, offAfterS: secondsUntil(until, now) }, mode, until, scheduleId: null };
  }
  // pause: wyłączony do końca okna, w którym go wyłączono; until to koniec tej przerwy
  if (mode === 'pause') return { command: { on: false }, mode, until: new Date(relay.until as Date), scheduleId: null };
  const active = activeSchedule(schedules.filter((schedule) => schedule.relay === relay.relay), now);
  return active
    ? { command: { on: true, offAfterS: secondsUntil(active.until, now) }, mode, until: active.until, scheduleId: active.scheduleId }
    : { command: { on: false }, mode, until: null, scheduleId: null };
}

// Zgłoszenie sterownika: {uptimeS?, relays: [{on, changedS}]}. Błąd = null.
export function parseStateReport(body: unknown): { uptimeS?: number; relays: RelayReport[] } | null {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(input.relays) || !isRelayCount(input.relays.length)) return null;
  const relays: RelayReport[] = [];
  for (const item of input.relays as unknown[]) {
    const relay = (item ?? {}) as Record<string, unknown>;
    const changedS = relay.changedS ?? 0;
    if (typeof relay.on !== 'boolean' || typeof changedS !== 'number' || !Number.isFinite(changedS) || changedS < 0) {
      return null;
    }
    relays.push({ on: relay.on, changedS });
  }
  const uptimeS = input.uptimeS;
  if (uptimeS !== undefined && (typeof uptimeS !== 'number' || !Number.isFinite(uptimeS) || uptimeS < 0)) return null;
  return { uptimeS: uptimeS as number | undefined, relays };
}

// Przyczyna włączenia: harmonogram albo ten, kto ustawił tryb ręczny.
const activationSource = (relay: RelayDoc, now: Date): ActivationSource =>
  effectiveMode(relay, now) === 'schedule' ? 'schedule' : relay.modeSource ?? 'app';

// Historia włączeń według stanu zgłoszonego przez sterownik. changedAt to chwila
// zmiany stanu według sterownika (now − changedS), więc włączenie i wyłączenie mają
// czas ze sterownika także po przerwie w łączności.
async function recordActivation(
  rootId: string,
  relay: RelayDoc,
  report: RelayReport,
  changedAt: Date,
  bootAt: Date | null,
  now: Date,
  seen: Date | undefined,
) {
  const open = await SwitchActivationModel.findOne({ rootId, relay: relay.relay, offAt: null }).sort({ onAt: -1 });
  if (report.on) {
    if (open && open.onAt.getTime() >= changedAt.getTime() - BOOT_MARGIN_S * 1000) return;
    if (open) {
      // włączenie zaczęło się później niż otwarte w historii: wyłączenie w przerwie łączności
      open.offAt = seen && seen < changedAt ? seen : changedAt;
      open.approximate = true;
      await open.save();
    }
    await SwitchActivationModel.create({
      rootId, deviceId: relay.deviceId, relay: relay.relay, onAt: changedAt, source: activationSource(relay, now),
    });
    return;
  }
  if (!open) return;
  // wyłączony od startu sterownika: koniec to utrata zasilania, czyli ostatnie zgłoszenie przed nią
  const offSinceBoot = bootAt !== null && changedAt.getTime() <= bootAt.getTime() + BOOT_MARGIN_S * 1000;
  let offAt = changedAt;
  if (offSinceBoot && seen && seen < changedAt) offAt = seen;
  open.offAt = offAt < open.onAt ? open.onAt : offAt;
  open.approximate = offSinceBoot;
  await open.save();
}

// POST /switch/state: zapisuje stan przekaźników i historię, zwraca polecenia.
// changed = któryś przekaźnik zmienił stan (aplikacja dostaje wtedy "update").
export async function reportState(
  rootId: string,
  deviceId: string,
  report: { uptimeS?: number; relays: RelayReport[] },
  now = new Date(),
): Promise<{ relays: RelayCommand[]; changed: boolean }> {
  await ensureRelays(rootId, deviceId, report.relays.length);
  const [relays, schedules] = await Promise.all([
    SwitchRelayModel.find({ rootId }).sort({ relay: 1 }).lean<RelayDoc[]>(),
    SwitchScheduleModel.find({ rootId, enabled: true }).lean<ScheduleDoc[]>(),
  ]);
  const bootAt = report.uptimeS !== undefined ? new Date(now.getTime() - report.uptimeS * 1000) : null;

  let changed = false;
  const commands: RelayCommand[] = [];
  for (const relay of relays) {
    const state = report.relays[relay.relay - 1];
    const changedAt = new Date(now.getTime() - state.changedS * 1000);
    const key = relayKey(rootId, relay.relay);
    const previous = reported.get(key);
    const seen = lastSeen(rootId, relay);
    // ten sam stan co w poprzednim zgłoszeniu: historia jest już zapisana (recordActivation nic by nie zmienił)
    const sameState = previous !== undefined && previous.on === state.on
      && Math.abs(previous.changedAt - changedAt.getTime()) <= BOOT_MARGIN_S * 1000;
    if (!sameState) await recordActivation(rootId, relay, state, changedAt, bootAt, now, seen);
    reported.set(key, { on: state.on, changedAt: sameState && previous ? previous.changedAt : changedAt.getTime(), seenAt: now });
    if (relay.on !== state.on) {
      changed = true;
      // powiadomienie Web Push (core/services/push.service.ts): zmiana stanu przekaźnika według sterownika
      await notify(rootId, state.on ? 'relay-on' : 'relay-off', {
        body: both((lang) => t(lang, state.on ? 'push.relayOn' : 'push.relayOff', { name: relay.name || t(lang, 'switch.relay', { n: relay.relay }) })),
        url: '/',
      }, now);
    }

    const expired = timed(relay.mode) && effectiveMode(relay, now) === 'schedule';
    // zapis tylko przy zmianie stanu, trybu albo właściciela SN; samo „widziany” najwyżej raz na minutę
    const stale = !relay.lastSeenAt || now.getTime() - new Date(relay.lastSeenAt).getTime() >= LAST_SEEN_WRITE_MS;
    const moved = !relay.changedAt || Math.abs(new Date(relay.changedAt).getTime() - changedAt.getTime()) > CHANGED_AT_TOLERANCE_MS;
    if (stale || moved || expired || relay.on !== state.on || relay.deviceId !== deviceId) {
      await SwitchRelayModel.updateOne({ rootId, relay: relay.relay }, {
        $set: {
          on: state.on, changedAt, lastSeenAt: now, deviceId,
          ...(expired ? { mode: 'schedule', modeChangedAt: now } : {}),
        },
        ...(expired ? { $unset: { until: 1 } } : {}),
      });
    }
    const { command, mode, until, scheduleId } = relayCommand(relay, schedules, now);
    // dziennik operacji: polecenie zmienione przez harmonogram albo koniec czasu, potwierdzenie czekających zmian
    await noteRelayReport(rootId, relay, state.on, { on: command.on, mode, until, scheduleId }, schedules, now);
    commands.push({ ...command, mode: wireMode(mode) });
  }
  return { relays: commands, changed };
}

// Zmiana trybu z aplikacji albo strony sterownika. minutes tylko dla timer. pause wyłącza do końca okna
// harmonogramu działającego teraz; poza oknem (przekaźnik włączony ręcznie albo wyłączony) to zwykły harmonogram.
export async function setRelayMode(
  rootId: string,
  input: { relay?: unknown; mode?: unknown; minutes?: unknown },
  source: CommandSource,
  now = new Date(),
): Promise<RelayDoc | string> {
  const { relay, minutes } = input;
  let mode = input.mode;
  if (typeof mode !== 'string' || !RELAY_MODES.includes(mode as RelayMode)) {
    return 'mode: schedule, on, timer, off albo pause.';
  }
  if (typeof relay !== 'number' || !Number.isInteger(relay)) return 'relay: numer przekaźnika.';
  let until: Date | undefined;
  if (mode === 'timer') {
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMER_MINUTES) {
      return `minutes: pełne minuty 1–${MAX_TIMER_MINUTES}.`;
    }
    until = new Date(now.getTime() + minutes * 60 * 1000);
  }
  if (mode === 'pause') {
    const active = activeSchedule(await SwitchScheduleModel.find({ rootId, relay, enabled: true }).lean<ScheduleDoc[]>(), now);
    if (active) until = active.until;
    else mode = 'schedule';
  }
  const updated = await SwitchRelayModel.findOneAndUpdate(
    { rootId, relay },
    {
      $set: { mode, modeSource: source, modeChangedAt: now, ...(until ? { until } : {}) },
      ...(until ? {} : { $unset: { until: 1 } }),
    },
    { new: true },
  ).lean<RelayDoc>();
  return updated ?? 'Nie ma takiego przekaźnika.';
}

// Nazwa przekaźnika z Ustawień (pusta = „Przekaźnik N” w aplikacji); null, gdy nie ma przekaźnika.
export async function renameRelay(rootId: string, relay: number, name: string) {
  return SwitchRelayModel.findOneAndUpdate({ rootId, relay }, { $set: { name } }, { new: true, runValidators: true }).lean();
}

// Liczba przekaźników sterownika (dokumenty switch_relays): górna granica numeru w harmonogramie.
export async function relayCount(rootId: string): Promise<number> {
  return SwitchRelayModel.countDocuments({ rootId });
}

// Przekaźniki dla aplikacji: stan ze sterownika, tryb, koniec włączenia (until),
// wpis harmonogramu działający teraz i najbliższe włączenie z harmonogramu.
export async function listRelays(rootId: string, now = new Date()) {
  const [relays, schedules] = await Promise.all([
    SwitchRelayModel.find({ rootId }).sort({ relay: 1 }).lean<RelayDoc[]>(),
    SwitchScheduleModel.find({ rootId, enabled: true }).lean<ScheduleDoc[]>(),
  ]);
  return relays.map((relay) => {
    const { command, mode, until, scheduleId } = relayCommand(relay, schedules, now);
    const own = schedules.filter((schedule) => schedule.relay === relay.relay);
    return {
      relay: relay.relay,
      name: relay.name,
      mode,
      modeSource: relay.modeSource ?? null,
      modeChangedAt: relay.modeChangedAt ?? null,
      on: relay.on,
      changedAt: relay.changedAt ?? null,
      lastSeenAt: relay.lastSeenAt ?? null,
      online: relay.lastSeenAt ? now.getTime() - new Date(relay.lastSeenAt).getTime() < OFFLINE_AFTER_MS : false,
      desiredOn: command.on,
      until,
      scheduleId,
      // pause: najbliższe włączenie po końcu przerwy (bieżące okno jest przerwane)
      nextStart: (mode === 'schedule' || mode === 'pause') && !command.on ? nextScheduleStart(own, mode === 'pause' ? until as Date : now) : null,
    };
  });
}

// Włączenia nachodzące na zakres [from, to): także trwające i zaczęte dzień wcześniej.
export async function listActivations(rootId: string, from: Date, to: Date, relay?: number, now = new Date()) {
  const activations = await SwitchActivationModel.find({
    rootId,
    ...(relay ? { relay } : {}),
    onAt: { $lt: to },
    $or: [{ offAt: null }, { offAt: { $gt: from } }],
  }).sort({ onAt: 1 }).lean();
  return activations.map((activation) => ({
    ...activation,
    durationS: Math.round(((activation.offAt ? new Date(activation.offAt) : now).getTime() - new Date(activation.onAt).getTime()) / 1000),
  }));
}
