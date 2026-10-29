// Odczyty kotła Pellux 200: walidacja body sterownika, zapis, ostatni odczyt
// w pamięci per rootId (po restarcie serwera z bazy) i lista z jednego dnia. Czujnik zewnętrzny kotła
// (outside_temp) ustawia temperaturę zewnętrzną serwera (core meteo.service: t_out pompy ciepła).
import { PelletBoilerPelux200Entry, PelletBoilerPelux200Measurements } from '../types';
import { PelletBoilerPelux200Model } from '../models/pellet-boiler-pelux200.model';
import { getDeviceInfo } from '../../../core/services/device-info.service';
import { cachedDeviceById } from '../../../core/services/device-cache.service';
import { sendMessage } from '../../../core/websocket';
import { setOutdoorTemperature } from '../../../core/services/meteo.service';
import { comparisonKey, createPlateauWriter } from '../../../core/services/plateau-writer.service';
import { notify } from '../../../core/services/push.service';
import { both, Lang, t } from '../../../core/i18n';

export const DEFAULT_POLL_INTERVAL_SECONDS = 300;

// stany z płomieniem (jak w tile.ts): rozpalanie, praca, nadzór, wygaszanie
const FLAME_STATES = new Set([1, 2, 3, 4, 7]);
const burning = (reading: { state?: number } | undefined) => reading?.state !== undefined && FLAME_STATES.has(reading.state);

// Powiadomienia Web Push (core/services/push.service.ts): kocioł zaczął palić / wygaszony, nowy alarm.
// previous = poprzedni odczyt (pamięć albo baza); bez niego (pierwszy odczyt) nic nie idzie.
async function notifyBoilerEvents(rootId: string, previous: PelletBoilerPelux200Entry | undefined, reading: PelletBoilerPelux200Measurements) {
  if (!previous) return;
  const temp = (lang: Lang) => (typeof reading.heating_temp === 'number' ? t(lang, 'push.boilerTemp', { value: reading.heating_temp.toFixed(1) }) : '');
  if (burning(previous) !== burning(reading)) {
    const key = burning(reading) ? 'push.burningOn' : 'push.burningOff';
    await notify(rootId, burning(reading) ? 'burning-on' : 'burning-off', { body: both((lang) => t(lang, key, { temp: temp(lang) })), url: '/' });
  }
  if (reading.alarm === true && previous.alarm !== true) {
    await notify(rootId, 'alarm', { body: both((lang) => t(lang, 'push.boilerAlarm', { temp: temp(lang) })), url: '/alarms' });
  }
}

const NUMBER_FIELDS = [
  'state', 'heating_temp', 'feeder_temp', 'water_heater_temp', 'outside_temp', 'return_temp',
  'exhaust_temp', 'optical_temp', 'upper_buffer_temp', 'lower_buffer_temp', 'heating_target',
  'water_heater_target', 'heating_status', 'water_heater_status', 'fuel_level', 'fan_power',
  'boiler_load', 'boiler_power', 'fuel_consumption', 'lambda_level',
  'mixer1_temp', 'mixer1_target', 'mixer2_temp', 'mixer2_target',
  // liczba aktywnych alarmów kotła (SensorData, firmware pieca od 1.7.0)
  'alerts_active',
  // narastający licznik spalonego pelletu [kg] (fuel_meter.hpp, firmware pieca od 1.7.1)
  'fuel_burned_kg',
  // termostat pokojowy eSTER: temperatura w pokoju i zadana (firmware pieca od 1.8.0)
  'room_temp', 'room_target_temp',
  // surowe output_flags z SensorData (firmware pieca od 1.8.0): tylko zapis, do sprawdzenia, czy zmieniają się przy pracy
  'output_flags',
] as const;
const BOOLEAN_FIELDS = [
  'fan', 'feeder', 'heating_pump', 'water_heater_pump', 'circulation_pump', 'lighter', 'alarm',
  'mixer1_pump', 'mixer1_opening', 'mixer1_closing', 'mixer2_pump', 'mixer2_opening', 'mixer2_closing',
] as const;

// Zwraca tylko znane pola pomiarowe albo null, gdy body nie jest obiektem, pole
// ma zły typ (liczba skończona / boolean) albo nie ma żadnego pola pomiarowego.
// Pole `time` i nieznane klucze są ignorowane.
export function validateReading(body: unknown): PelletBoilerPelux200Measurements | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const result: Record<string, number | boolean> = {};
  for (const key of NUMBER_FIELDS) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) return null;
    result[key] = source[key] as number;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== 'boolean') return null;
    result[key] = source[key] as boolean;
  }
  return Object.keys(result).length ? result : null;
}

const lastByRoot = new Map<string, PelletBoilerPelux200Entry>();

// Temperatury (pola *_temp) zapisywane z dokładnością 0,1 °C: sterownik podaje je z 5 miejscami po przecinku
// (np. 50.90883), co nic nie wnosi (decyzja użytkownika 2026-10-07).
const isTemperature = (key: string) => key.endsWith('_temp');
export function roundTemperatures(reading: PelletBoilerPelux200Measurements): PelletBoilerPelux200Measurements {
  const result: Record<string, number | boolean> = { ...reading };
  for (const [key, value] of Object.entries(result)) {
    if (isTemperature(key) && typeof value === 'number') result[key] = Math.round(value * 10) / 10;
  }
  return result as PelletBoilerPelux200Measurements;
}

// Zapis bez identycznych powtórzeń (core/services/plateau-writer.service.ts): temperatury porównywane
// po zaokrągleniu do 0,5 °C (decyzja użytkownika 2026-10-07), pozostałe pola dokładnie.
const writeReading = createPlateauWriter(PelletBoilerPelux200Model);
const readingKey = (cast: Record<string, unknown>) => comparisonKey(cast, [], { test: isTemperature, step: 0.5 });

export async function addPelletBoilerPelux200Reading(
  rootId: string,
  measured: PelletBoilerPelux200Measurements,
) {
  const reading = roundTemperatures(measured);
  const device = await getDeviceInfo(rootId);
  const previous = (await getPelletBoilerPelux200Last(rootId)) ?? undefined;
  const { doc } = await writeReading(rootId, {
    ...reading, rootId, deviceType: device.deviceType, deviceId: device.deviceId,
  }, readingKey);
  lastByRoot.set(rootId, doc as unknown as PelletBoilerPelux200Entry);
  await notifyBoilerEvents(rootId, previous, reading);
  // czujnik zewnętrzny kotła = temperatura zewnętrzna całego serwera (pompa ciepła: t_out, ekran co)
  if (typeof reading.outside_temp === 'number') setOutdoorTemperature(reading.outside_temp, new Date());
  sendMessage('update', rootId);
  return doc;
}

// Po starcie serwera: temperatura zewnętrzna z ostatniego odczytu kotła z czujnikiem (wiek sprawdza core).
export async function restoreOutdoorTemperature() {
  const last = await PelletBoilerPelux200Model
    .findOne({ outside_temp: { $type: 'number' } }).sort({ createdAt: -1 })
    .lean<PelletBoilerPelux200Entry & { createdAt?: Date }>();
  if (typeof last?.outside_temp === 'number' && last.createdAt) setOutdoorTemperature(last.outside_temp, new Date(last.createdAt));
  return last?.outside_temp;
}

export async function getPelletBoilerPelux200Last(rootId: string) {
  const cached = lastByRoot.get(rootId);
  if (cached) return cached;
  const last = await PelletBoilerPelux200Model
    .findOne({ rootId }).sort({ createdAt: -1 }).lean<PelletBoilerPelux200Entry>();
  if (last) lastByRoot.set(rootId, last);
  return last ?? undefined;
}

export const getPelletBoilerPelux200Range = (rootId: string, start: Date, end: Date) =>
  PelletBoilerPelux200Model
    .find({ rootId, createdAt: { $gte: start, $lt: end } })
    .sort({ createdAt: -1 })
    .lean<PelletBoilerPelux200Entry[]>();

// Ustawiony w aplikacji odstęp odpytywania kotła; domyślny, gdy brak w properties.
// Z pamięci dokumentów urządzeń: kafelek liczony co minutę i odpowiedź na każdy odczyt.
export async function getPollIntervalSeconds(rootId: string): Promise<number> {
  const device = await cachedDeviceById(rootId);
  return device?.properties?.poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
}

// Odpowiedź na odczyt: odstęp odpytywania.
export async function getControllerReply(rootId: string) {
  return { poll_interval_seconds: await getPollIntervalSeconds(rootId) };
}

// Kocioł odpowiada, gdy ostatni odczyt jest młodszy niż RESPONDING_INTERVALS odstępów odpytywania
// (najmniej RESPONDING_MIN_MS). Sterownik pieca wysyła odczyt tylko przy działającej komunikacji
// z regulatorem, więc brak świeżego odczytu = regulator milczy na magistrali (2026-10-05 16:48–17:25
// i 17:28–17:37 przy zasilonym kotle, 0 bajtów; wcześniej regulator bez zasilania) albo przerwany
// przewód. Ta sama zasada co „Dane nieaktualne” w aplikacji (utils/boiler.ts isStale).
export const RESPONDING_INTERVALS = 3;
export const RESPONDING_MIN_MS = 3 * 60 * 1000;

export const readingResponding = (createdAt: Date | string | undefined, pollSeconds: number, now = Date.now()) =>
  !!createdAt && now - new Date(createdAt).getTime() <= Math.max(RESPONDING_INTERVALS * pollSeconds * 1000, RESPONDING_MIN_MS);

export async function isBoilerResponding(rootId: string, now = Date.now()): Promise<boolean> {
  const last = await getPelletBoilerPelux200Last(rootId) as (PelletBoilerPelux200Entry & { createdAt?: Date }) | undefined;
  return readingResponding(last?.createdAt, await getPollIntervalSeconds(rootId), now);
}
