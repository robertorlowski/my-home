// Kafelek kotła Pellux 200 na stronie /devices (GET /devices/summary), układ z makiety (2026-10-17): temperatura
// kotła z zadaną, przy paleniu czas od początku palenia (since) i wskaźniki pomp CO / CWU, pola CWU oraz
// temperatury mieszaczy 1 i 2. Błąd (czerwony): aktywny alarm regulatora albo brak
// odczytu dłużej niż godzinę (od 3 odstępów odpytywania do godziny to uwaga, pomarańczowa). Ostrzeżenie (pomarańczowy): mało pelletu (< 15 %) albo ostatnie
// zlecenie zmiany parametru zakończone błędem w ciągu doby.
import { DEFAULT_LANG, Lang, t } from '../../core/i18n';
import { Device, DeviceTile } from '../../core/types';
import { formatAge, formatTemperature, formatUnit, formatWhen, offlineLevel } from '../../core/services/tile-format';
import { PelletBoilerCommandModel } from './models/pellet-boiler-pelux200-command.model';
import { PelletBoilerPelux200Model } from './models/pellet-boiler-pelux200.model';
import { listAlerts } from './services/pellet-boiler-pelux200-alert.service';
import { getPelletBoilerPelux200Last, getPollIntervalSeconds, readingResponding } from './services/pellet-boiler-pelux200.service';
import { PelletBoilerPelux200Entry } from './types';
import { simpleBoilerState } from './services/pellet-boiler-pelux200-simple.service';

// stany z płomieniem (jak w kliencie): stabilizacja, rozpalanie, praca, nadzór, wygaszanie
const FLAME_STATES = new Set([1, 2, 3, 4, 7]);
export const LOW_FUEL_PERCENT = 15;
const COMMAND_ERROR_WINDOW_MS = 24 * 3600 * 1000;

const target = (value?: number) => (typeof value === 'number' ? ` → ${value}` : '');
// początek palenia szukany najwyżej dobę wstecz (dłuższe palenie: kafelek pokazuje czas od tej granicy)
const BURN_LOOKBACK_MS = 24 * 3600 * 1000;

// Początek bieżącego palenia: pierwszy odczyt po ostatnim odczycie bez płomienia (odczyty są zapisywane tylko przy
// zmianie, więc to dokładność odstępu odpytywania). Indeks {rootId, createdAt}; ok. 0,1 s na produkcji (2026-10-17).
async function burnStart(rootId: string, lastAt: Date): Promise<Date> {
  const lookback = new Date(lastAt.getTime() - BURN_LOOKBACK_MS);
  const notBurning = await PelletBoilerPelux200Model
    .findOne({ rootId, createdAt: { $gte: lookback, $lte: lastAt }, state: { $nin: [...FLAME_STATES] } })
    .sort({ createdAt: -1 }).select({ createdAt: 1 }).lean<{ createdAt: Date }>();
  const first = await PelletBoilerPelux200Model
    .findOne({ rootId, createdAt: { $gt: notBurning?.createdAt ?? lookback, $lte: lastAt } })
    .sort({ createdAt: 1 }).select({ createdAt: 1 }).lean<{ createdAt: Date }>();
  return first?.createdAt ?? lastAt;
}

export async function pelletBoilerTile(rootId: string, _device: Device, now = new Date(), lang: Lang = DEFAULT_LANG): Promise<DeviceTile | null> {
  const last = await getPelletBoilerPelux200Last(rootId) as (PelletBoilerPelux200Entry & { createdAt?: Date }) | undefined;
  if (!last?.createdAt) return { level: 'off', chip: 'Brak danych' };

  const at = new Date(last.createdAt);
  const [pollSeconds, alerts, failed] = await Promise.all([
    getPollIntervalSeconds(rootId),
    listAlerts(rootId),
    PelletBoilerCommandModel
      .findOne({ rootId, status: { $in: ['done', 'error'] } }).sort({ doneAt: -1 })
      .lean<{ status: string; label?: string; doneAt?: Date }>(),
  ]);
  const activeAlerts = alerts.alerts.filter((alert) => alert.active);
  const alarm = activeAlerts.length > 0 || last.alarm === true || last.state === 8;
  const responding = readingResponding(at, pollSeconds, now.getTime());

  let level: DeviceTile['level'] = 'ok';
  let note: DeviceTile['note'];
  // chip: Online / Offline (jak na wszystkich kafelkach); palenie = niebieski chip (running)
  let chip = 'Online';
  if (!responding) {
    const age = now.getTime() - at.getTime();
    level = offlineLevel(age); // do godziny uwaga, potem błąd
    chip = 'Offline';
    note = { level: 'err', icon: 'offline', text: t(lang, 'tile.notResponding', { age: formatAge(age, lang) }) };
  } else if (alarm) {
    level = 'err';
    const code = activeAlerts[0]?.code;
    note = { level: 'err', text: `${t(lang, 'boiler.alarm')}${code !== undefined ? t(lang, 'boiler.alarmCode', { code }) : ''}` };
  } else if (typeof last.fuel_level === 'number' && last.fuel_level < LOW_FUEL_PERCENT) {
    level = 'warn';
    note = { level: 'warn', text: t(lang, 'boiler.lowFuel', { value: formatUnit(last.fuel_level, '%', 0, lang) }) };
  } else if (failed?.status === 'error' && failed.doneAt && now.getTime() - new Date(failed.doneAt).getTime() < COMMAND_ERROR_WINDOW_MS) {
    level = 'warn';
    note = { level: 'warn', text: t(lang, 'boiler.commandFailed', { label: failed.label ?? t(lang, 'boiler.parameter'), when: formatWhen(new Date(failed.doneAt), now, lang) }) };
  }

  // pola kafla: CWU (side), temperatura mieszacza 1 i temperatura mieszacza 2;
  // tryb pracy (pompa ciepła / pellet) jest w pasku i podglądzie
  const row = [];
  if (typeof last.mixer1_temp === 'number') row.push({ icon: 'thermo' as const, value: formatTemperature(last.mixer1_temp, lang), label: t(lang, 'boiler.mixer', { n: 1 }) });
  if (typeof last.mixer2_temp === 'number') row.push({ icon: 'thermo' as const, value: formatTemperature(last.mixer2_temp, lang), label: t(lang, 'boiler.mixer', { n: 2 }) });
  const running = level !== 'err' && last.state !== undefined && FLAME_STATES.has(last.state);
  const pumps = [
    ...(typeof last.heating_pump === 'boolean' ? [{ label: t(lang, 'boiler.co'), on: last.heating_pump }] : []),
    ...(typeof last.water_heater_pump === 'boolean' ? [{ label: t(lang, 'boiler.cwu'), on: last.water_heater_pump }] : []),
  ];

  return {
    level,
    chip,
    // ON = regulator włączony (stan ≠ 0, jak w karcie „Regulator”); bez stanu w odczycie bez chipu
    ...(typeof last.state === 'number' ? { power: last.state !== 0 ? 'on' as const : 'off' as const } : {}),
    running,
    ...(running ? { since: (await burnStart(rootId, at)).toISOString() } : {}),
    ...(pumps.length ? { pumps } : {}),
    main: { icon: 'flame', value: formatTemperature(last.heating_temp, lang), label: `${t(lang, 'boiler.boiler')}${target(last.heating_target)}` },
    side: [{ icon: 'tap', value: formatTemperature(last.water_heater_temp, lang), label: `${t(lang, 'boiler.cwu')}${target(last.water_heater_target)}` }],
    row,
    note,
    updatedAt: at.toISOString(),
    // kafelek prosty (2026-10-21): regulator, sezon, CWU i zlecenie w toku
    boiler: await simpleBoilerState(rootId, now),
  };
}
