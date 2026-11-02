// Automatyczne przejście na tryb Pellet (decyzja użytkownika 2026-10-04): gdy kocioł w trybie „Pompa ciepła”
// (nr 99 < 50 °C) zgłosi rozpalanie (stan 2), serwer od razu zleca nastawy trybu Pellet (profiles.pellet
// z ustawień harmonogramu) — bez wyłączania regulatora, w trakcie palenia; to jedyny wyjątek od zasady
// „zmiana trybu tylko na postoju albo przy wyłączonym kotle” (Ustawienia → Tryb pracy). Kolejność jak
// w aplikacji (orderChanges): granice zadanej, zadane, reszta (od 2026-11-02 minimum 30 → 65 przed zadaną
// 30 → 67; do tego dnia zadana szła pierwsza).
// Ekran główny kotła pokazuje czerwony komunikat do kliknięcia „OK” (POST …/auto-pellet/ack); powrót na
// pompę ciepła tylko ręcznie. Do potwierdzenia komunikatu przejście nie jest powtarzane.
// Wołane po każdym odczycie kotła (kontroler /add; firmware 1.6.x wysyła odczyt od razu po zmianie stanu).
// Nie dotyczy rozpalenia na CWU przy włączonym „CWU - grzanie peletem”: trwający cykl albo pracująca pompa CWU
// (regulator sam zaczął ładowanie, zanim scheduler uruchomił cykl) — wtedy od razu krok cyklu, tryb zostaje
// „Pompa ciepła” (produkcja 2026-10-21: rozpalenie na CWU o 8:44 przełączyło kocioł na stałe na Pellet).
import { sendMessage } from '../../../core/websocket';
import { PelletBoilerCommandModel } from '../models/pellet-boiler-pelux200-command.model';
import { PelletBoilerScheduleSettingsModel } from '../models/pellet-boiler-pelux200-schedule.model';
import { PelletBoilerSettingsEntry, PelletBoilerSettingsModel } from '../models/pellet-boiler-pelux200-settings.model';
import { PelletBoilerAutoPellet, PelletBoilerCommandChange } from '../types';
import { createCommands } from './pellet-boiler-pelux200-command.service';
import { systemMeta } from '../../../core/services/operation-log.service';
import { getPelletBoilerPelux200Last } from './pellet-boiler-pelux200.service';
import { getScheduleSettings } from './pellet-boiler-pelux200-schedule.service';
import { buildSettingsView } from './pellet-boiler-pelux200-settings.service';
import { effectiveBoilerMode } from './pellet-boiler-pelux200-heat-pump-link.service';
import { getPelletCwu, pelletCwuBlocksPump, runPelletCwu } from './pellet-boiler-pelux200-pellet-cwu.service';

const KINDLING = 2;
// odczyt starszy niż to nie wyzwala przejścia (np. zaległy odczyt po powrocie łączności)
const READING_MAX_AGE_MS = 5 * 60 * 1000;

// Bieżąca wartość surowa parametru z odczytu ustawień (kocioł albo mieszacz).
const currentRaw = (view: ReturnType<typeof buildSettingsView>, change: PelletBoilerCommandChange) =>
  (change.kind === 'mixer'
    ? view.mixers.find((m) => m.mixer === change.mixer)?.parameters.find((p) => p.index === change.index)
    : view.groups.flatMap((g) => g.parameters).find((p) => p.index === change.index))?.raw[0];

// Kolejność jak orderChanges w kliencie (components/MainParameters.tsx): 0 granice zadanej (min, max), 1 zadana,
// 2 reszta; w obrębie rangi kolejność profilu. Zakres granic jest w regulatorze stały, a zakres zadanej wynika
// z granic (decyzja użytkownika 2026-11-02: najpierw minimalna temperatura kotła, potem zadana).
export function orderProfileChanges(changes: PelletBoilerCommandChange[]) {
  const rank = (change: PelletBoilerCommandChange) => {
    const role = change.kind === 'ecomax'
      ? ({ 99: 'bound', 100: 'bound', 98: 'target' } as Record<number, string>)[change.index]
      : ({ 1: 'bound', 2: 'bound', 0: 'target' } as Record<number, string>)[change.index];
    return role === 'bound' ? 0 : role === 'target' ? 1 : 2;
  };
  return changes.map((change, i) => ({ change, i, r: rank(change) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map(({ change }) => change);
}

// Klucz profilu „ecomax:<nr>” / „mixer<n>:<nr>” → zmiana.
const changeOf = (key: string, value: number): PelletBoilerCommandChange => {
  const [kind, index] = key.split(':');
  return kind === 'ecomax'
    ? { kind: 'ecomax', index: Number(index), value }
    : { kind: 'mixer', mixer: Number(kind.slice(5)), index: Number(index), value };
};

export async function getAutoPellet(rootId: string): Promise<PelletBoilerAutoPellet | null> {
  const saved = await PelletBoilerScheduleSettingsModel.findOne({ rootId }).lean<{ autoPellet?: PelletBoilerAutoPellet }>();
  return saved?.autoPellet && !saved.autoPellet.acknowledged ? saved.autoPellet : null;
}

export async function acknowledgeAutoPellet(rootId: string) {
  await PelletBoilerScheduleSettingsModel.updateOne({ rootId }, { $set: { 'autoPellet.acknowledged': true } });
  sendMessage('update', rootId);
}

// Po odczycie kotła: rozpalanie w trybie pompy ciepła → nastawy trybu Pellet. Zwraca zlecone zmiany albo null.
export async function checkAutoPellet(rootId: string, now = new Date()) {
  const [last, settings] = await Promise.all([
    getPelletBoilerPelux200Last(rootId),
    PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>(),
  ]);
  const readingAt = last ? new Date((last as { createdAt?: Date }).createdAt ?? 0) : null;
  if (last?.state !== KINDLING || !readingAt || now.getTime() - readingAt.getTime() > READING_MAX_AGE_MS) return null;
  if (!settings || (await effectiveBoilerMode(rootId, settings)) !== 'heat-pump') return null;
  if (await getAutoPellet(rootId)) return null;
  // rozpalenie na CWU z peletu (pellet-cwu.service.ts) zostaje w trybie pompy ciepła
  const pelletCwu = await getPelletCwu(rootId);
  if (pelletCwuBlocksPump(pelletCwu)) return null;
  // regulator sam ładuje CWU przy włączonym znaczniku: start cyklu CWU z peletu zamiast przejścia na Pellet
  if (pelletCwu.enabled && (last as { water_heater_pump?: boolean }).water_heater_pump === true) {
    await runPelletCwu(rootId, now);
    return null;
  }
  const { profiles } = await getScheduleSettings(rootId);
  // przejście już w drodze: zadana albo minimum kotła z wartością trybu Pellet czeka na kocioł
  // (starsze oczekujące zlecenia z innymi wartościami zostaną zastąpione)
  const inFlight = [98, 99].map((index) => ({ index, value: profiles.pellet[`ecomax:${index}`] })).filter((c) => c.value !== undefined);
  if (inFlight.length && await PelletBoilerCommandModel.exists({
    rootId, kind: 'ecomax', status: { $in: ['pending', 'sent'] }, $or: inFlight,
  })) return null;

  const view = buildSettingsView(settings);
  const current = (change: PelletBoilerCommandChange) => currentRaw(view, change);
  const changes = orderProfileChanges(
    Object.entries(profiles.pellet).map(([key, value]) => changeOf(key, value)).filter((c) => current(c) !== c.value),
  );
  const autoPellet: PelletBoilerAutoPellet = { at: readingAt, acknowledged: false, changes: changes.length };
  try {
    if (changes.length) {
      await createCommands(rootId, { changes }, systemMeta(
        'Tryb pracy', 'Kocioł rozpala się w trybie Pompa ciepła — przejście na nastawy trybu Pellet.',
        `stan kotła: rozpalanie (odczyt ${readingAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' })})`,
      ));
    }
  } catch (error) {
    autoPellet.error = String((error as Error).message ?? error);
  }
  await PelletBoilerScheduleSettingsModel.updateOne({ rootId }, { $set: { autoPellet } }, { upsert: true });
  console.log(`[pellet] ${rootId} rozpalanie w trybie pompy ciepła — przejście na Pellet, zmian: ${changes.length}${autoPellet.error ? ` (${autoPellet.error})` : ''}`);
  sendMessage('update', rootId);
  return changes;
}
