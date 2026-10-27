// Pomocnicze funkcje widoków kotła pelletowego: nazwy stanów, formaty, nieaktualność, CSV.
import { PelletBoilerParameter, PelletBoilerPelletCwu, PelletBoilerReading, PelletBoilerSettings } from '../types';
import { getLang, locale, t as tr } from '../../../core/i18n';

const TIME_ZONE = 'Europe/Warsaw';
const loc = () => locale(getLang());

// odczyt kotła co minutę (domyślne poll_interval_seconds od 2026-10-05)
export const DEFAULT_POLL_SECONDS = 60;

// Nazwy stanów 0..11 z regulatora ecoMAX (5 = „Postój”, jak na panelu ecoMAX): słownik pb.state.<n> (core/i18n).
export const BOILER_STATE_COUNT = 12;

export const stateName = (state?: number) =>
  state === undefined ? '---' : state >= 0 && state < BOILER_STATE_COUNT ? tr(`pb.state.${state}`) : tr('pb.stateN', { n: state });

// Tryb „Pompa ciepła” i pracująca sprężarka pompy ciepła (heat_pump_running z serwera): „Praca” zamiast stanu
// regulatora (zwykle Postój), poza stanem Wyłączony i Alarm (decyzja użytkownika 2026-10-05).
export const heatPumpWorking = (reading?: Pick<PelletBoilerReading, 'state' | 'heat_pump_running'> | null) =>
  !!reading?.heat_pump_running && reading.state !== undefined && reading.state !== 0 && reading.state !== 8;

export const readingStateName = (reading?: Pick<PelletBoilerReading, 'state' | 'heat_pump_running'> | null) =>
  heatPumpWorking(reading) ? tr('pb.state.3') : stateName(reading?.state);

// Tryb „Pompa ciepła”, kocioł się nie pali, a przy odczycie serwer nie miał świeżych danych pompy ciepła
// (heat_pump_running brak: pompa offline albo jej sterownik CHPC nie odpowiada): nie wiadomo, czy sprężarka pracuje,
// więc przy „Postój” dopisek (2026-10-13, produkcja: od 21:41 CHPC milczał, a pompa grzała).
export const heatPumpDataMissing = (reading: Pick<PelletBoilerReading, 'state' | 'heat_pump_running'> | null | undefined, heatPumpMode: boolean) =>
  heatPumpMode && !!reading && reading.heat_pump_running === undefined && reading.state !== undefined
  && reading.state !== 0 && reading.state !== 8 && !isBurning(reading.state);

export const formatNumber = (value: number | undefined, digits = 1) =>
  value === undefined || value === null ? '---' : value.toLocaleString(loc(), { maximumFractionDigits: digits });

export const formatTemp = (value?: number) => value === undefined || value === null ? '---' : `${formatNumber(value)} °C`;

export const formatTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString(loc(), { timeZone: TIME_ZONE }) : '---';
export const formatDateTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(loc(), { timeZone: TIME_ZONE }) : '---';

// Dzisiejsza data w Warszawie jako YYYY-MM-DD (format en-CA).
export const todayWarsaw = () => new Date().toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

// Odczyt nieaktualny: starszy niż 3 interwały odpytywania (albo bez czasu).
export const isStale = (createdAt: string | undefined, pollSeconds: number) =>
  !createdAt || Date.now() - new Date(createdAt).getTime() > 3 * pollSeconds * 1000;

// Parametr kotła (ramka 0x33) z ostatniego odczytu ustawień, po numerze.
export const findParameter = (settings: PelletBoilerSettings | null, index: number): PelletBoilerParameter | undefined =>
  settings?.groups?.flatMap((group) => group.parameters).find((parameter) => parameter.index === index);

// Tryb LATO (nr 125): kolejność 0 Zima / 1 Lato / 2 Auto jak w PyPlumIO, na kotle niepotwierdzona
// (0 przy grzaniu CO pasuje do Zimy).
const SUMMER_MODE_KEYS = ['pb.winter', 'pb.summer', 'pb.auto'];
export const summerModeName = (settings: PelletBoilerSettings | null) => {
  const parameter = findParameter(settings, 125);
  return parameter ? (SUMMER_MODE_KEYS[parameter.value] ? tr(SUMMER_MODE_KEYS[parameter.value]) : `${parameter.value}`) : '---';
};

// Tryb pracy z ustawień (kociol-ustawienia.md, punkt 4b): minimalna temperatura kotła (nr 99)
// 30 °C w zestawie „bez palenia” (pompa ciepła), 65 °C przy pracy na pellecie. Granica 50 °C. W trakcie „CWU z peletu”
// (faza heating albo cooling, GET …/schedules/current) kocioł ma nastawy Pellet, ale pracuje w trybie Pompa ciepła
// (jak effectiveBoilerMode na serwerze).
export type WorkModeKey = 'heat-pump' | 'pellet';
export const workModeKey = (settings: PelletBoilerSettings | null, pelletCwu?: PelletBoilerPelletCwu | null): WorkModeKey | null => {
  const parameter = findParameter(settings, 99);
  if (!parameter) return null;
  if (pelletCwu?.phase === 'heating' || pelletCwu?.phase === 'cooling') return 'heat-pump';
  return parameter.value < 50 ? 'heat-pump' : 'pellet';
};
export const workModeLabel = (key: WorkModeKey | null) => (key === 'heat-pump' ? tr('type.heat_pump') : key === 'pellet' ? tr('pb.pellet') : '---');

// Kocioł się pali: stabilizacja, rozpalanie, praca, nadzór i wygaszanie (płomień na stronie głównej).
const BURNING_STATES = [1, 2, 3, 4, 7];
export const isBurning = (state?: number) => state !== undefined && BURNING_STATES.includes(state);

// Ruch zaworu mieszacza z bitów SensorData.
export const valveText = (opening?: boolean, closing?: boolean) =>
  opening === undefined && closing === undefined ? '---' : tr(opening ? 'pb.valveOpening' : closing ? 'pb.valveClosing' : 'pb.valveIdle');
// klucze stanów zaworu do porównań (Home: strzałki)
export const valveState = (opening?: boolean, closing?: boolean): 'none' | 'opening' | 'closing' | 'idle' =>
  opening === undefined && closing === undefined ? 'none' : opening ? 'opening' : closing ? 'closing' : 'idle';

const num = (value?: number) => value === undefined || value === null ? '' : String(value).replace('.', ',');
const yesNo = (value?: boolean) => value === undefined || value === null ? '---' : tr(value ? 'common.yesLower' : 'common.noLower');

// Kolumny zakładki Dane i CSV. `main` = widoczne od razu, reszta po „Pokaż wszystkie parametry”.
export type ReadingColumn = {
  key: string;
  header: string;
  csvHeader: string;
  main?: boolean;
  cell: (r: PelletBoilerReading) => string;
  csv: (r: PelletBoilerReading) => string;
};

const temp = (key: keyof PelletBoilerReading, header: string, csvHeader: string, main = false): ReadingColumn => ({
  key, header, csvHeader: `${csvHeader} [°C]`, main,
  cell: (r) => formatNumber(r[key] as number | undefined),
  csv: (r) => num(r[key] as number | undefined),
});
const flag = (key: keyof PelletBoilerReading, header: string, main = false): ReadingColumn => ({
  key, header, csvHeader: header, main,
  cell: (r) => yesNo(r[key] as boolean | undefined),
  csv: (r) => yesNo(r[key] as boolean | undefined),
});
const value = (key: keyof PelletBoilerReading, header: string, csvHeader: string, digits = 1): ReadingColumn => ({
  key, header, csvHeader,
  cell: (r) => formatNumber(r[key] as number | undefined, digits),
  csv: (r) => num(r[key] as number | undefined),
});

// nagłówki kolumn ze słownika: pb.col.<klucz> (tabela) i pb.csv.<klucz> (CSV); kolumny temperatur dostają „ [°C]” w CSV
const c = (key: string) => tr(`pb.col.${key}`);
const cv = (key: string) => tr(`pb.csv.${key}`);
export const readingColumns = (): ReadingColumn[] => [
  { key: 'createdAt', header: c('createdAt'), csvHeader: cv('createdAt'), main: true,
    cell: (r) => formatTime(r.createdAt), csv: (r) => formatDateTime(r.createdAt) },
  { key: 'state', header: c('state'), csvHeader: cv('state'), main: true,
    cell: (r) => readingStateName(r), csv: (r) => readingStateName(r) },
  temp('heating_temp', c('heating_temp'), cv('heating_temp'), true),
  temp('heating_target', c('heating_target'), cv('heating_target'), true),
  temp('water_heater_temp', c('water_heater_temp'), cv('water_heater_temp'), true),
  temp('water_heater_target', c('water_heater_target'), cv('water_heater_target'), true),
  // przy „Pokaż wszystkie” pompa i zawór mieszacza stoją przy jego temperaturach, a pompy CO/CWU
  // i temperatura zewnętrzna za zaworem mieszacza 2
  temp('mixer1_temp', c('mixer1_temp'), cv('mixer1_temp'), true),
  temp('mixer1_target', c('mixer1_target'), cv('mixer1_target'), true),
  flag('mixer1_pump', c('mixer1_pump')),
  { key: 'mixer1_valve', header: c('mixer1_valve'), csvHeader: c('mixer1_valve'),
    cell: (r) => valveText(r.mixer1_opening, r.mixer1_closing), csv: (r) => valveText(r.mixer1_opening, r.mixer1_closing) },
  temp('mixer2_temp', c('mixer2_temp'), cv('mixer2_temp'), true),
  temp('mixer2_target', c('mixer2_target'), cv('mixer2_target'), true),
  flag('mixer2_pump', c('mixer2_pump')),
  { key: 'mixer2_valve', header: c('mixer2_valve'), csvHeader: c('mixer2_valve'),
    cell: (r) => valveText(r.mixer2_opening, r.mixer2_closing), csv: (r) => valveText(r.mixer2_opening, r.mixer2_closing) },
  flag('heating_pump', c('heating_pump'), true),
  flag('water_heater_pump', c('water_heater_pump'), true),
  temp('outside_temp', c('outside_temp'), cv('outside_temp'), true),
  temp('room_temp', c('room_temp'), cv('room_temp')),
  temp('room_target_temp', c('room_target_temp'), cv('room_target_temp')),
  temp('feeder_temp', c('feeder_temp'), cv('feeder_temp')),
  temp('optical_temp', c('optical_temp'), cv('optical_temp')),
  temp('upper_buffer_temp', c('upper_buffer_temp'), cv('upper_buffer_temp')),
  temp('lower_buffer_temp', c('lower_buffer_temp'), cv('lower_buffer_temp')),
  value('fuel_level', c('fuel_level'), cv('fuel_level'), 0),
  value('fan_power', c('fan_power'), cv('fan_power'), 0),
  value('boiler_load', c('boiler_load'), cv('boiler_load'), 0),
  value('boiler_power', c('boiler_power'), cv('boiler_power')),
  value('fuel_consumption', c('fuel_consumption'), cv('fuel_consumption'), 2),
  // spalony pellet od poprzedniego wiersza (licznik ze sterownika, firmware pieca od 1.7.1; withFuelDelta)
  value('fuel_delta_kg', c('fuel_delta_kg'), cv('fuel_delta_kg'), 3),
  value('lambda_level', c('lambda_level'), cv('lambda_level')),
  flag('fan', c('fan')),
  flag('feeder', c('feeder')),
  flag('lighter', c('lighter')),
  flag('circulation_pump', c('circulation_pump')),
  flag('alarm', c('alarm')),
];

// CSV dla Excela z polskimi ustawieniami: separator ';', przecinek dziesiętny; zawsze wszystkie kolumny.
export const readingsToCsv = (readings: PelletBoilerReading[]) => {
  const columns = readingColumns();
  const header = columns.map((column) => column.csvHeader);
  const rows = readings.map((r) => columns.map((column) => column.csv(r)).join(';'));
  return [header.join(';'), ...rows].join('\n');
};

// Przyrost licznika pelletu względem starszego odczytu (lista malejąco po czasie, jak z serwera); spadek licznika
// (nowa płytka) = cały nowy stan, jak na serwerze. Bez licznika w którymś z odczytów pole zostaje puste.
export const withFuelDelta = (readings: PelletBoilerReading[]): PelletBoilerReading[] =>
  readings.map((reading, index) => {
    const older = readings[index + 1];
    if (reading.fuel_burned_kg === undefined || older?.fuel_burned_kg === undefined) return reading;
    const delta = reading.fuel_burned_kg >= older.fuel_burned_kg ? reading.fuel_burned_kg - older.fuel_burned_kg : reading.fuel_burned_kg;
    return { ...reading, fuel_delta_kg: Math.round(delta * 1000) / 1000 };
  });

export const downloadText = (content: string, fileName: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};
