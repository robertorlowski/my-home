// Dziennik operacji włącznika (zakładka „Operacje”): zmiana trybu przekaźnika (aplikacja albo strona sterownika),
// zmiana polecenia bez udziału człowieka (początek i koniec okna harmonogramu, koniec włączenia na czas) i zaplanowane
// przejścia do końca doby. Wpis z aplikacji czeka, aż sterownik zgłosi przekaźnik w żądanym stanie (wtedy „wykonana”);
// zmiana na stronie sterownika jest już wykonana. Polecenie z poprzedniego zgłoszenia jest tylko w pamięci, więc po
// restarcie serwera pierwsze zgłoszenie jest punktem odniesienia.
import { formatInTimeZone } from 'date-fns-tz';
import { appUserMeta, controllerMeta, logOperation, setStatusByRef, systemMeta } from '../../../core/services/operation-log.service';
import { OperationMeta, PlannedOperation } from '../../../core/types';
import { TIME_ZONE } from '../../../core/time';
import { SwitchRelayModel } from '../models/switch-relay.model';
import { SwitchScheduleModel } from '../models/switch-schedule.model';
import { CommandSource, RelayMode, SwitchRelay, SwitchSchedule } from '../types';
import { scheduleWindow } from './switch-schedule.service';
import { relayCommand } from './switch.service';

type RelayDoc = SwitchRelay & { _id?: unknown };
type ScheduleDoc = SwitchSchedule & { _id?: unknown };

const MODE_NAMES: Record<RelayMode, string> = {
  schedule: 'Harmonogram', on: 'Włączony', timer: 'Włączony na czas', off: 'Wyłączony', pause: 'Wyłączony do końca okna',
};
const hhmm = (date: Date) => formatInTimeZone(date, TIME_ZONE, 'HH:mm');
const label = (relay: Pick<SwitchRelay, 'name' | 'relay'>) => relay.name?.trim() || `Przekaźnik ${relay.relay}`;
const ref = (relay: number) => `relay:${relay}`;
const window = (schedule: ScheduleDoc) => `${schedule.startTime}–${schedule.endTime}`;
const switchText = (relay: RelayDoc, on: boolean, until: Date | null) =>
  `${label(relay)}: ${on ? (until ? `włącz do ${hhmm(until)}` : 'włącz') : 'wyłącz'}`;

// polecenie z ostatniego zgłoszenia: {on, tryb, koniec, wpis}
type Desired = { on: boolean; mode: RelayMode; until: Date | null; scheduleId: string | null };
const lastDesired = new Map<string, Desired>();
// przekaźniki z wpisem „czeka” (sprawdzane przy zgłoszeniu bez zapytania do bazy za każdym razem)
const awaiting = new Set<string>();
const key = (rootId: string, relay: number) => `${rootId}:${relay}`;

async function logRelay(rootId: string, relay: RelayDoc, meta: OperationMeta, action: string, done: boolean) {
  await setStatusByRef(rootId, ref(relay.relay), ['pending'], 'replaced');
  if (!done) awaiting.add(key(rootId, relay.relay));
  return logOperation(rootId, meta, action, done ? {} : { status: 'pending', refs: [ref(relay.relay)] });
}

/** zmiana trybu (PUT /switch/mode): relay to dokument po zmianie, minutes dla „włącz na czas” */
export async function noteModeChange(rootId: string, relay: RelayDoc, source: CommandSource, now = new Date(), minutes?: number) {
  const schedules = await SwitchScheduleModel.find({ rootId, enabled: true }).lean<ScheduleDoc[]>();
  const { command, mode, until, scheduleId } = relayCommand(relay, schedules, now);
  lastDesired.set(key(rootId, relay.relay), { on: command.on, mode, until, scheduleId });
  const action = relay.mode === 'timer' && until
    ? `${label(relay)}: włącz na ${minutes ?? Math.round((until.getTime() - now.getTime()) / 60000)} min (do ${hhmm(until)})`
    : relay.mode === 'on' ? `${label(relay)}: włącz bez limitu`
    : relay.mode === 'off' ? `${label(relay)}: wyłącz (harmonogram zablokowany)`
    : relay.mode === 'pause' && until ? `${label(relay)}: wyłącz do ${hhmm(until)} (potem harmonogram)`
    : `${label(relay)}: tryb Harmonogram (${command.on ? `włączony${until ? ` do ${hhmm(until)}` : ''}` : 'wyłączony'})`;
  const button = {
    on: '„Włącz” bez limitu', timer: `„Włącz” z czasem ${minutes ?? '?'} min`, off: '„Wyłącz”', schedule: '„Harmonogram”',
    pause: '„Wyłącz” do końca okna harmonogramu (kafelek prosty)',
  }[relay.mode];
  const meta = source === 'controller'
    ? controllerMeta('Strona sterownika', 'Zmiana na stronie sterownika (sieć lokalna albo jego punkt dostępowy).')
    : appUserMeta('Włącznik', `Przycisk ${button}.`);
  // strona sterownika: przekaźnik już przełączony; aplikacja: czeka na zgłoszenie stanu
  return logRelay(rootId, relay, meta, action, source === 'controller' || relay.on === command.on);
}

// Dlaczego polecenie zmieniło się bez udziału człowieka.
function changeMeta(previous: Desired, next: Desired, schedules: ScheduleDoc[], now: Date): OperationMeta {
  const conditions = `tryb ${MODE_NAMES[next.mode]}`;
  if (previous.mode === 'timer' && next.mode === 'schedule') {
    return systemMeta('Harmonogram', 'Koniec włączenia na czas — dalej harmonogram.', conditions);
  }
  if (previous.mode === 'pause' && next.mode === 'schedule') {
    return systemMeta('Harmonogram', 'Koniec wyłączenia do końca okna — dalej harmonogram.', conditions);
  }
  const entry = (id: string | null) => schedules.find((schedule) => String(schedule._id) === id);
  const started = entry(next.scheduleId);
  const ended = entry(previous.scheduleId);
  if (next.on && started) return systemMeta('Harmonogram', `Początek wpisu ${window(started)}.`, conditions);
  if (!next.on && ended && previous.until && previous.until.getTime() <= now.getTime() + 10_000) {
    return systemMeta('Harmonogram', `Koniec wpisu ${window(ended)}.`, conditions);
  }
  return systemMeta('Harmonogram', 'Zmiana wpisów harmonogramu.', conditions);
}

/** zgłoszenie stanu (POST /switch/state): nowe polecenie bez udziału człowieka i potwierdzenie czekających */
export async function noteRelayReport(
  rootId: string, relay: RelayDoc, reportedOn: boolean, next: Desired, schedules: ScheduleDoc[], now = new Date(),
) {
  const id = key(rootId, relay.relay);
  const previous = lastDesired.get(id);
  lastDesired.set(id, next);
  if (previous && previous.on !== next.on) {
    await logRelay(rootId, relay, changeMeta(previous, next, schedules, now), switchText(relay, next.on, next.until), reportedOn === next.on);
  }
  if (awaiting.has(id) && reportedOn === next.on) {
    awaiting.delete(id);
    await setStatusByRef(rootId, ref(relay.relay), ['pending'], 'done', now);
  }
}

/** dziennik operacji, „Zaplanowane”: włączenia i wyłączenia z harmonogramu i koniec włączenia na czas do dayEnd */
export async function plannedSwitchOperations(rootId: string, now: Date, dayEnd: Date): Promise<PlannedOperation[]> {
  const [relays, schedules] = await Promise.all([
    SwitchRelayModel.find({ rootId }).sort({ relay: 1 }).lean<RelayDoc[]>(),
    SwitchScheduleModel.find({ rootId, enabled: true }).lean<ScheduleDoc[]>(),
  ]);
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const yesterday = formatInTimeZone(new Date(now.getTime() - 24 * 3600 * 1000), TIME_ZONE, 'yyyy-MM-dd');
  const planned: PlannedOperation[] = [];
  for (const relay of relays) {
    // granice: okna wpisów przekaźnika (wczorajsze przez północ i dzisiejsze) i koniec włączenia na czas
    const reasons = new Map<number, string>();
    for (const schedule of schedules.filter((item) => item.relay === relay.relay)) {
      for (const day of [yesterday, today]) {
        const range = scheduleWindow(schedule, day);
        if (!range) continue;
        reasons.set(range.start.getTime(), `Początek wpisu ${window(schedule)}.`);
        reasons.set(range.end.getTime(), `Koniec wpisu ${window(schedule)}.`);
      }
    }
    if (relay.mode === 'timer' && relay.until) reasons.set(new Date(relay.until).getTime(), 'Koniec włączenia na czas — dalej harmonogram.');
    if (relay.mode === 'pause' && relay.until) reasons.set(new Date(relay.until).getTime(), 'Koniec wyłączenia do końca okna — dalej harmonogram.');
    for (const time of [...reasons.keys()].filter((t) => t > now.getTime() && t < dayEnd.getTime()).sort((a, b) => a - b)) {
      const before = relayCommand(relay, schedules, new Date(time - 1000));
      const after = relayCommand(relay, schedules, new Date(time + 1000));
      if (before.command.on === after.command.on) continue;
      planned.push({
        at: new Date(time), actor: { type: 'system' }, source: 'Harmonogram',
        action: switchText(relay, after.command.on, after.until), reason: reasons.get(time),
        conditions: `przekaźnik w trybie ${MODE_NAMES[after.mode]}`,
      });
    }
  }
  return planned.sort((a, b) => a.at.getTime() - b.at.getTime());
}
