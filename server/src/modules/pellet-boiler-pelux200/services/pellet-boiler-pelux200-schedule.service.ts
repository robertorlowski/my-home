// Harmonogram kotła (zakładka Harmonogram pieca): CWU od–do w oknach godzin, osobna lista i osobne
// wartości poza harmonogramem dla trybu „Pompa ciepła” i „Pellet”; działa lista trybu, w którym kocioł
// jest teraz (z ostatniego odczytu ustawień: minimalna temperatura kotła nr 99 < 50 °C = pompa ciepła,
// jak w aplikacji). Serwer co minutę (startPelletBoilerScheduler, server.ts) wylicza stan dla każdego
// kotła z działającym harmonogramem i — tylko gdy stan zmienił się od ostatnio zastosowanego
// (lastApplied) — zleca zmianę parametrów tą samą drogą co aplikacja (createCommands): zadana CWU
// nr 119 = do, histereza nr 123 = do − od. Harmonogram działa po „Włącz regulator” i stoi po „Wyłącz
// regulator” w Ustawieniach (enabled); włączanie i wyłączanie regulatora robią same przyciski (zlecenie
// control), harmonogram regulatora nie przełącza (wpisy pracy kotła usunięte 2026-10-04, decyzja
// użytkownika; dawne wpisy type work są pomijane). Zmiana ręczna w aplikacji albo na panelu zostaje do
// następnej zmiany stanu (jak ręczne nadpisanie w pompie ciepła) — poza trybem pompy ciepła: tam CWU
// zmienione na panelu wraca co minutę do harmonogramu (pompa ciepła nie dogrzeje wyższej temperatury),
// a „CWU do” jest ograniczone do HEAT_PUMP_CWU_MAX (45 °C). Okno przez północ należy do dnia
// startu (jak harmonogram włącznika); data ma pierwszeństwo przed dniem tygodnia, potem późniejszy start.
// Od 2026-10-04 drugi rodzaj wpisu: sezon Lato / Zima (type season, parametr nr 125: 0 zima, 1 lato) w oknach
// godzin, z sezonem poza harmonogramem w defaults. Od 2026-10-15 wpis to „Tryb Zima” z dwoma progami temperatury
// zewnętrznej z czujnika kotła (outside_temp z ostatniego odczytu): zaczyna działać (Zima) poniżej winterBelow,
// przestaje (Lato spoza harmonogramu) powyżej summerAbove, między progami zostaje, jak było (seasonThresholds,
// coldEnough). Dawny jeden próg coldBelow działa jak winterBelow = coldBelow, summerAbove = coldBelow + 0,5 °C.
// Bez temperatury wpis z progami nie działa. Bez wpisu i bez sezonu w defaults
// harmonogram sezonem nie steruje. Zmiany sezonu i CWU idą do kotła jednym zleceniem (createCommands).
// W trybie pompy ciepła Zimą steruje cykl (pellet-boiler-pelux200-winter-cycle.service.ts): Zima przy kotle ≥ max pompy ciepła − 3 °C,
// Lato przy kotle < 30 °C i stojącej pompie CO, w Lecie wymuszanie startu pompy ciepła. Przycisk Lato/Zima
// w Ustawieniach (tryb pompy ciepła) zapisuje sezon (manualSeason), który wygrywa do najbliższej granicy okien wpisów
// sezonu (start albo koniec, np. 22:00 / 06:00, niezależnie od progu temperatury) albo wcześniejszej zmiany sezonu
// z harmonogramu (2026-10-11: Zima z przycisku przy 11 °C trzymała się po 06:00, bo wpis z progiem 10 °C nie działał
// i harmonogram nie zmienił sezonu). Wybór sezonu, który harmonogram i tak teraz ustawia, wraca do harmonogramu.
// Co minutę też ładowanie CWU (pellet-boiler-pelux200-cwu-loading.service.ts: pompa ciepła 47–49 °C) i CWU z peletu
// w trybie pompy ciepła (pellet-boiler-pelux200-pellet-cwu.service.ts); przy jego znaczniku CWU od–do jest z trybu Pellet.
// Tu są też nastawy trybów (profiles), które aplikacja zleca po wyborze „Pompa ciepła” / „Pellet”.
// CWU poza harmonogramem może być „bez zmiany” (defaults[mode].cwuUnchanged, 2026-10-13): poza wpisami CWU
// harmonogram nie zleca nr 119 i 123 i nie przywraca CWU zmienionego na panelu (także w trybie pompy ciepła);
// zostaje zadana z panelu albo z ostatniego wpisu. Zadaną wyższą niż temperatura, do której grzeje włączona pompa ciepła
// (heatPumpCwuMax), aplikacja pokazuje na czerwono z getCurrentSchedule (cwuTooHigh).
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { scheduleDayMatches } from '../../../core/services/calendar.service';
import { TIME_ZONE } from '../../../core/time';
import { DeviceModel } from '../../../core/models/device.model';
import { DeviceType, PlannedOperation, WeekDay } from '../../../core/types';
import { sendMessage } from '../../../core/websocket';
import {
  PelletBoilerScheduleModel, PelletBoilerScheduleSettingsModel,
} from '../models/pellet-boiler-pelux200-schedule.model';
import { PelletBoilerSettingsEntry, PelletBoilerSettingsModel } from '../models/pellet-boiler-pelux200-settings.model';
import {
  PelletBoilerCommandChange, PelletBoilerCwuRange, PelletBoilerMode, PelletBoilerProfile, PelletBoilerScheduleEntry,
  PelletBoilerScheduleSettings, PelletBoilerScheduleState, PelletBoilerManualSeason, PelletBoilerSeason, PelletBoilerWinterCycle,
} from '../types';
import { createCommands } from './pellet-boiler-pelux200-command.service';
import { appUserMeta, systemMeta } from '../../../core/services/operation-log.service';
import { boilerMode, buildSettingsView } from './pellet-boiler-pelux200-settings.service';
import { getPelletBoilerPelux200Last } from './pellet-boiler-pelux200.service';
import { evaluateCwuLoading } from './pellet-boiler-pelux200-cwu-loading.service';
import {
  HeatPumpControl, SUMMER_BELOW, WINTER_FROM, heatPumpControl, heatPumpCwuMax, runWinterCycle, stopWinterCycle,
} from './pellet-boiler-pelux200-winter-cycle.service';
import { PelletBoilerCommandModel } from '../models/pellet-boiler-pelux200-command.model';
import { effectiveBoilerMode, linkedHeatPumpRootId, migrateBoilerDefinitions } from './pellet-boiler-pelux200-heat-pump-link.service';
import { getPelletCwu, runPelletCwu } from './pellet-boiler-pelux200-pellet-cwu.service';
import { getPendingTurnOn, runPendingTurnOn } from './pellet-boiler-pelux200-turn-on.service';

export { boilerMode };

export const PELLET_SCHEDULER_INTERVAL_MS = 60 * 1000;

const MODES: PelletBoilerMode[] = ['heat-pump', 'pellet'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PROFILE_KEY = /^(ecomax|mixer[1-5]):\d{1,3}$/;
const WEEK_DAYS = Object.values(WeekDay).filter((v): v is WeekDay => typeof v === 'number');
// CWU od–do: rozsądne granice (zakres regulatora sprawdza serwer przy zleceniu)
const CWU_MIN = 10;
const CWU_MAX = 80;
// tryb pompy ciepła: CWU najwyżej 45 °C (wyżej pompa ciepła nie dogrzeje, nawet przy 47–49 °C w kotle)
export const HEAT_PUMP_CWU_MAX = 45;
// zmiana CWU z panelu wraca do harmonogramu dopiero, gdy od ostatniego zlecenia CWU minęło tyle czasu
const CWU_RESTORE_AFTER_MS = 5 * 60 * 1000;
// sezon: nr 125 (0 zima, 1 lato; kolejność z PyPlumIO, jak przełącznik Zima/Lato w Ustawieniach)
const SEASON_PARAMETER = 125;
const SEASON_VALUE: Record<PelletBoilerSeason, number> = { winter: 0, summer: 1 };
const SEASONS: PelletBoilerSeason[] = ['winter', 'summer'];
// progi temperatury wpisu „Tryb Zima” [°C], co 0,5 °C
const SEASON_TEMP_MIN = -30;
const SEASON_TEMP_MAX = 30;
// dawny jeden próg coldBelow: powrót Lata powyżej progu + tyle
export const LEGACY_SUMMER_MARGIN = 0.5;
// temperatura zewnętrzna z czujnika kotła (outside_temp) tylko z odczytu nie starszego niż (3 × domyślny interwał)
const OUTDOOR_MAX_AGE_MS = 15 * 60 * 1000;

// Temperatura zewnętrzna z ostatniego odczytu kotła (czujnik zewnętrzny regulatora; od 2026-10-04 zamiast
// IMGW Zakopane, decyzja użytkownika); null bez odczytu, bez czujnika albo gdy odczyt jest starszy niż 15 min.
export async function boilerOutdoorTemperature(rootId: string, now = new Date()): Promise<number | null> {
  const last = await getPelletBoilerPelux200Last(rootId);
  const at = (last as { createdAt?: Date } | undefined)?.createdAt;
  if (typeof last?.outside_temp !== 'number' || !at || now.getTime() - new Date(at).getTime() > OUTDOOR_MAX_AGE_MS) return null;
  return last.outside_temp;
}

// Wartości startowe (kociol-ustawienia.md, punkt 4b; CWU z ustaleń 2026-10-04): pompa ciepła CWU
// 35–40 °C, pellet zadana 55 °C z histerezą 15 °C. Nastawy trybów bez CWU — CWU ustawia harmonogram.
export const DEFAULT_SCHEDULE_SETTINGS: Omit<PelletBoilerScheduleSettings, 'rootId'> = {
  enabled: false,
  defaults: { 'heat-pump': { cwuFrom: 35, cwuTo: 40 }, pellet: { cwuFrom: 40, cwuTo: 55 } },
  profiles: {
    'heat-pump': {
      'ecomax:99': 30, 'ecomax:98': 30, 'ecomax:17': 20, 'ecomax:101': 30, 'ecomax:105': 5, 'ecomax:122': 1,
      'mixer1:1': 30, 'mixer1:2': 50, 'mixer1:4': 0, 'mixer1:0': 35,
    },
    // histereza 12: start kotła przy 67 − 12 = 55 °C (decyzja użytkownika 2026-10-04)
    pellet: {
      'ecomax:99': 65, 'ecomax:98': 67, 'ecomax:17': 12, 'ecomax:101': 50, 'ecomax:105': 5, 'ecomax:122': 2,
      'mixer1:1': 40, 'mixer1:2': 50, 'mixer1:4': 1, 'mixer1:0': 40,
    },
  },
};

type ScheduleInput = Omit<PelletBoilerScheduleEntry, 'rootId'>;

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

const parseRange = (from: unknown, to: unknown, mode?: PelletBoilerMode): PelletBoilerCwuRange | string => {
  const max = mode === 'heat-pump' ? HEAT_PUMP_CWU_MAX : CWU_MAX;
  return isInteger(from) && isInteger(to) && from >= CWU_MIN && to <= max && from < to
    ? { cwuFrom: from, cwuTo: to }
    : `CWU od–do: liczby całkowite ${CWU_MIN}–${max} °C${mode === 'heat-pump' ? ' (tryb pompy ciepła)' : ''}, „od” mniejsze niż „do”.`;
};

// Wpis z body (POST/PUT) albo napis z błędem.
export function parseScheduleEntry(body: unknown): ScheduleInput | string {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!MODES.includes(input.mode as PelletBoilerMode)) return 'mode: heat-pump albo pellet.';
  const type = input.type ?? 'cwu';
  if (type !== 'cwu' && type !== 'season') return 'type: cwu albo season (włączanie i wyłączanie kotła z harmonogramu usunięto).';
  if (typeof input.startTime !== 'string' || !TIME.test(input.startTime)
    || typeof input.endTime !== 'string' || !TIME.test(input.endTime)) {
    return 'startTime i endTime w formacie HH:mm.';
  }
  let what: Partial<ScheduleInput>;
  if (type === 'season') {
    // „Tryb Zima”: bez season = zima (dawne wpisy Lato zostają, formularz ich już nie tworzy)
    const season = input.season ?? 'winter';
    if (!SEASONS.includes(season as PelletBoilerSeason)) return 'season: winter albo summer.';
    const winter = input.winterBelow;
    const summer = input.summerAbove;
    const given = (value: unknown) => value !== undefined && value !== null;
    if (given(winter) !== given(summer)) return 'winterBelow i summerAbove: oba albo żaden.';
    if (given(winter)) {
      const valid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value * 2)
        && value >= SEASON_TEMP_MIN && value <= SEASON_TEMP_MAX;
      if (!valid(winter) || !valid(summer)) {
        return `winterBelow i summerAbove: ${SEASON_TEMP_MIN}–${SEASON_TEMP_MAX} °C co 0,5 °C.`;
      }
      if (summer <= winter) return 'summerAbove musi być wyższe niż winterBelow.';
    }
    what = {
      season: season as PelletBoilerSeason,
      winterBelow: given(winter) ? winter as number : null,
      summerAbove: given(summer) ? summer as number : null,
      coldBelow: null,
    };
  } else {
    const range = parseRange(input.cwuFrom, input.cwuTo, input.mode as PelletBoilerMode);
    if (typeof range === 'string') return range;
    what = range;
  }
  let date: Date | undefined;
  if (input.date !== undefined && input.date !== null && input.date !== '') {
    date = new Date(String(input.date));
    if (Number.isNaN(date.getTime())) return 'Nieprawidłowa data.';
  }
  if (!date && !WEEK_DAYS.includes(input.dayOfWeek as WeekDay)) return 'Podaj dayOfWeek (-3…6) albo date.';
  return {
    type, mode: input.mode as PelletBoilerMode, enabled: input.enabled !== false,
    dayOfWeek: date ? undefined : input.dayOfWeek as WeekDay, date,
    startTime: input.startTime, endTime: input.endTime, ...what,
  };
}

// Ustawienia z body: enabled, defaults dla obu trybów, profiles (klucz → bajt 0–255).
export function parseScheduleSettings(body: unknown): Omit<PelletBoilerScheduleSettings, 'rootId'> | string {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') return 'enabled: true albo false.';
  const defaults = (input.defaults ?? {}) as Record<string, Record<string, unknown>>;
  const profiles = (input.profiles ?? {}) as Record<string, Record<string, unknown>>;
  const result = { enabled: input.enabled, defaults: {}, profiles: {} } as Omit<PelletBoilerScheduleSettings, 'rootId'>;
  for (const mode of MODES) {
    const range = parseRange(defaults[mode]?.cwuFrom, defaults[mode]?.cwuTo, mode);
    if (typeof range === 'string') return range;
    const season = defaults[mode]?.season;
    if (season !== undefined && season !== null && !SEASONS.includes(season as PelletBoilerSeason)) {
      return 'Sezon poza harmonogramem: winter albo summer.';
    }
    const unchanged = defaults[mode]?.cwuUnchanged;
    if (unchanged !== undefined && unchanged !== null && typeof unchanged !== 'boolean') return 'cwuUnchanged: true albo false.';
    result.defaults[mode] = {
      ...range, ...(season ? { season: season as PelletBoilerSeason } : {}), ...(unchanged ? { cwuUnchanged: true } : {}),
    };
    const profile = profiles[mode] ?? {};
    if (typeof profile !== 'object' || Array.isArray(profile)) return 'profiles: obiekt klucz → wartość.';
    const clean: PelletBoilerProfile = {};
    for (const [key, value] of Object.entries(profile)) {
      if (!PROFILE_KEY.test(key) || !isInteger(value) || value < 0 || value > 255) return `profiles.${mode}.${key}: wartość 0–255.`;
      clean[key] = value;
    }
    result.profiles[mode] = clean;
  }
  return result;
}

// --- wyliczenie stanu ---

const shiftDate = (localDate: string, days: number) => {
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const warsawTime = (localDate: string, time: string) => fromZonedTime(`${localDate}T${time}:00`, TIME_ZONE);

// Okno wpisu zaczynające się danego dnia (przez północ: koniec następnego dnia).
function entryWindow(entry: PelletBoilerScheduleEntry, localDate: string) {
  if (!entry.enabled || entry.startTime === entry.endTime) return null;
  if (!scheduleDayMatches(entry, localDate)) return null;
  const endDate = entry.startTime < entry.endTime ? localDate : shiftDate(localDate, 1);
  return { start: warsawTime(localDate, entry.startTime), end: warsawTime(endDate, entry.endTime) };
}

// Najbliższa po now granica (start albo koniec) okien włączonych wpisów sezonu trybu, w ciągu 8 dni; null = brak wpisów.
// Progi temperatury (winterBelow, summerAbove) nie mają znaczenia: to godzina, o której harmonogram przejmuje sezon od przycisku.
export function nextSeasonBoundary(entries: PelletBoilerScheduleEntry[], mode: PelletBoilerMode, now: Date): Date | null {
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const times = entries.filter((e) => e.mode === mode && e.type === 'season').flatMap((entry) =>
    Array.from({ length: 10 }, (_, i) => entryWindow(entry, shiftDate(today, i - 1)))
      .flatMap((window) => (window ? [window.start, window.end] : [])))
    .filter((time) => time.getTime() > now.getTime());
  return times.length ? new Date(Math.min(...times.map((time) => time.getTime()))) : null;
}

// Działający wpis danego rodzaju (cwu albo season) trybu: z datą przed cyklicznym, potem późniejszy start
// (dawne wpisy pracy kotła pomijane). eligible odrzuca wpisy, które teraz nie mogą działać (próg temperatury).
export function activeEntry(
  entries: PelletBoilerScheduleEntry[], mode: PelletBoilerMode, now: Date,
  type: 'cwu' | 'season' = 'cwu', eligible: (entry: PelletBoilerScheduleEntry) => boolean = () => true,
) {
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const matches = entries.filter((e) => e.mode === mode && (e.type ?? 'cwu') === type && eligible(e)).flatMap((entry) =>
    [today, shiftDate(today, -1)].flatMap((day) => {
      const window = entryWindow(entry, day);
      return window && window.start <= now && now < window.end ? [{ entry, start: window.start }] : [];
    }));
  matches.sort((a, b) => Number(!!b.entry.date) - Number(!!a.entry.date) || b.start.getTime() - a.start.getTime());
  return matches[0]?.entry ?? null;
}

// Progi wpisu „Tryb Zima”; dawny jeden próg coldBelow = Zima poniżej, Lato powyżej progu + LEGACY_SUMMER_MARGIN.
// null = wpis bez temperatury (Zima przez całe okno).
export function seasonThresholds(entry: PelletBoilerScheduleEntry): { winterBelow: number; summerAbove: number } | null {
  if (typeof entry.winterBelow === 'number') {
    return { winterBelow: entry.winterBelow, summerAbove: entry.summerAbove ?? entry.winterBelow + LEGACY_SUMMER_MARGIN };
  }
  if (typeof entry.coldBelow === 'number') {
    return { winterBelow: entry.coldBelow, summerAbove: entry.coldBelow + LEGACY_SUMMER_MARGIN };
  }
  return null;
}

// Wpis z progami zaczyna działać poniżej winterBelow; wpis, który już działał (lastSeasonScheduleId), działa do
// temperatury powyżej summerAbove. Między progami zostaje, jak było. Bez temperatury wpis z progami nie działa.
const coldEnough = (entry: PelletBoilerScheduleEntry, outdoor: number | null, lastSeasonScheduleId?: string | null) => {
  const thresholds = seasonThresholds(entry);
  if (!thresholds) return true;
  if (outdoor === null) return false;
  const wasActive = !!lastSeasonScheduleId && String(entry._id) === lastSeasonScheduleId;
  return wasActive ? outdoor <= thresholds.summerAbove : outdoor < thresholds.winterBelow;
};

export function scheduleState(
  settings: Omit<PelletBoilerScheduleSettings, 'rootId'>, entries: PelletBoilerScheduleEntry[], mode: PelletBoilerMode, now: Date,
  outdoor: number | null = null, lastSeasonScheduleId?: string | null,
) {
  const entry = activeEntry(entries, mode, now);
  const seasonEntry = activeEntry(entries, mode, now, 'season', (e) => coldEnough(e, outdoor, lastSeasonScheduleId));
  const defaults = settings.defaults[mode];
  const season = seasonEntry?.season ?? defaults.season;
  const seasonScheduleId = seasonEntry?._id ? String(seasonEntry._id) : null;
  const state: PelletBoilerScheduleState = {
    mode,
    cwuFrom: entry?.cwuFrom ?? defaults.cwuFrom,
    cwuTo: entry?.cwuTo ?? defaults.cwuTo,
    ...(season ? { season } : {}),
    seasonScheduleId,
    // poza wpisami CWU „bez zmiany”: CWU zostaje w kotle
    ...(!entry && defaults.cwuUnchanged ? { cwuUnchanged: true } : {}),
  };
  return { state, scheduleId: entry?._id ? String(entry._id) : null, seasonScheduleId };
}

const sameState = (a?: PelletBoilerScheduleState, b?: PelletBoilerScheduleState) =>
  !!a && !!b && a.mode === b.mode && a.cwuFrom === b.cwuFrom && a.cwuTo === b.cwuTo && a.season === b.season
  && !!a.paused === !!b.paused && !!a.pelletCwu === !!b.pelletCwu && !!a.cwuUnchanged === !!b.cwuUnchanged;

// Stan harmonogramu teraz: wpisy i ustawienie poza harmonogramem trybu, sezon z przycisku, a przy znaczniku
// „Grzej CWU peletem” (tryb pompy ciepła) CWU od–do z trybu Pellet.
async function currentState(
  rootId: string, settings: PelletBoilerScheduleSettings, mode: PelletBoilerMode, now: Date,
  last?: PelletBoilerScheduleState,
) {
  const entries = await PelletBoilerScheduleModel.find({ rootId }).lean<PelletBoilerScheduleEntry[]>();
  let { state } = scheduleState(settings, entries, mode, now, await boilerOutdoorTemperature(rootId, now), last?.seasonScheduleId);
  const manual = await activeManualSeason(rootId, state.season ?? null, now);
  if (manual) state = { ...state, season: manual };
  if (mode === 'heat-pump' && (await getPelletCwu(rootId)).enabled) {
    const pellet = scheduleState(settings, entries, 'pellet', now).state;
    const { cwuUnchanged: _unchanged, ...withoutUnchanged } = state;
    state = {
      ...withoutUnchanged, cwuFrom: pellet.cwuFrom, cwuTo: pellet.cwuTo, pelletCwu: true,
      ...(pellet.cwuUnchanged ? { cwuUnchanged: true } : {}),
    };
  }
  return state;
}

// Wartość surowa parametru kotła z ostatniego odczytu ustawień.
const currentParameter = (settings: PelletBoilerSettingsEntry, index: number) =>
  buildSettingsView(settings).groups.flatMap((g) => g.parameters).find((p) => p.index === index)?.raw[0];

// Sezon kotła z ostatniego odczytu ustawień (nr 125: 0 zima, 1 lato).
const boilerSeasonOf = (settings: PelletBoilerSettingsEntry): PelletBoilerSeason | undefined =>
  SEASONS.find((season) => SEASON_VALUE[season] === currentParameter(settings, SEASON_PARAMETER));

// Sezon z przycisku w Ustawieniach: obowiązuje do until (granica okien wpisów sezonu) albo do zmiany sezonu
// z harmonogramu, co pierwsze; potem znika i sezon ustawia harmonogram.
async function activeManualSeason(rootId: string, scheduled: PelletBoilerSeason | null, now: Date) {
  const manual = (await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('manualSeason')
    .lean<{ manualSeason?: PelletBoilerManualSeason | null }>())?.manualSeason;
  if (!manual) return undefined;
  const expired = !!manual.until && now.getTime() >= new Date(manual.until).getTime();
  if (expired || (manual.scheduled ?? null) !== scheduled) {
    await PelletBoilerScheduleSettingsModel.updateOne({ rootId }, { $set: { manualSeason: null } });
    return undefined;
  }
  return manual.season;
}

// Przycisk Lato / Zima w Ustawieniach w trybie pompy ciepła (PUT /season): sezon zapamiętany przy harmonogramie,
// od razu przebieg (Lato: zlecenie, Zima: krok cyklu). W trybie Pellet aplikacja zleca nr 125 wprost.
export async function setManualSeason(rootId: string, season: PelletBoilerSeason, now = new Date(), pump: HeatPumpControl = heatPumpControl) {
  const settings = await getScheduleSettings(rootId);
  const boiler = await PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>();
  const mode = await effectiveBoilerMode(rootId, boiler);
  if (!boiler || !mode) throw new Error('Brak odczytu ustawień kotła — nie wiadomo, który tryb działa.');
  const entries = await PelletBoilerScheduleModel.find({ rootId }).lean<PelletBoilerScheduleEntry[]>();
  const { state } = scheduleState(settings, entries, mode, now, await boilerOutdoorTemperature(rootId, now), settings.lastApplied?.seasonScheduleId);
  // sezon, który harmonogram i tak teraz ustawia: powrót do harmonogramu (bez ręcznego wyboru)
  const manualSeason: PelletBoilerManualSeason | null = season === state.season
    ? null
    : { season, at: now, scheduled: state.season ?? null, until: nextSeasonBoundary(entries, mode, now) };
  await PelletBoilerScheduleSettingsModel.updateOne({ rootId }, { $set: { manualSeason } }, { upsert: true });
  // Lato od razu, także gdy harmonogram ma już Lato w ostatnim stanie (np. Zima ustawiona na panelu)
  if (season === 'summer' && boilerSeasonOf(boiler) !== 'summer') {
    const until = manualSeason?.until ? formatInTimeZone(manualSeason.until, TIME_ZONE, 'HH:mm') : null;
    await createCommands(rootId, { changes: [{ kind: 'ecomax', index: SEASON_PARAMETER, value: SEASON_VALUE.summer }] }, appUserMeta(
      'Ustawienia',
      manualSeason
        ? `Przycisk Lato — ustawienie ręczne${until ? ` do ${until}, potem zgodnie z harmonogramem` : ''}.`
        : 'Przycisk Lato — sezon zgodny z harmonogramem, wybór wraca do harmonogramu.',
    ));
  }
  await applySchedule(rootId, now, pump);
}

// CWU ustawione teraz w kotle: zadana (nr 119; z ostatniego odczytu kotła, bez niego z odczytu ustawień) i „od”
// = zadana − histereza (nr 123). Dla CWU „bez zmiany” (progi „CWU - grzanie peletem”, ostrzeżenie w aplikacji).
export async function boilerCwuSetting(rootId: string, boiler: PelletBoilerSettingsEntry | null): Promise<Partial<PelletBoilerCwuRange>> {
  const target = (await getPelletBoilerPelux200Last(rootId))?.water_heater_target ?? (boiler ? currentParameter(boiler, 119) : undefined);
  const hysteresis = boiler ? currentParameter(boiler, 123) : undefined;
  if (typeof target !== 'number') return {};
  return { cwuTo: target, ...(typeof hysteresis === 'number' ? { cwuFrom: target - hysteresis } : {}) };
}

// Zmiany dla regulatora (sezon i CWU w jednym zleceniu): tylko pola różne od ostatniego odczytu ustawień kotła.
// CWU „bez zmiany” poza wpisami: bez nr 119 i 123.
function changesFor(state: PelletBoilerScheduleState, settings: PelletBoilerSettingsEntry): PelletBoilerCommandChange[] {
  const current = (index: number) => currentParameter(settings, index);
  const wanted: PelletBoilerCommandChange[] = [
    ...(state.season ? [{ kind: 'ecomax' as const, index: SEASON_PARAMETER, value: SEASON_VALUE[state.season] }] : []),
    ...(state.cwuUnchanged ? [] : [
      { kind: 'ecomax' as const, index: 119, value: state.cwuTo },
      { kind: 'ecomax' as const, index: 123, value: state.cwuTo - state.cwuFrom },
    ]),
  ];
  return wanted.filter((change) => current(change.index) !== change.value);
}

// Jeden kocioł: stan harmonogramu i zlecenie zmian, gdy stan się zmienił. Błąd (np. brak odczytu
// ustawień, wartość poza zakresem regulatora) zostaje w lastError i przebieg powtarza się co minutę.
export async function applySchedule(rootId: string, now = new Date(), pump: HeatPumpControl = heatPumpControl) {
  const settings = await getScheduleSettings(rootId);
  const last = settings.lastApplied;
  try {
    // harmonogram nie działa („Wyłącz regulator”): nic nie zleca; zapamiętuje przerwę, żeby po wznowieniu
    // zastosować stan od razu. Wyjątek (decyzja użytkownika 2026-10-10): po zmianie trybu (Pompa ciepła / Pellet)
    // albo znacznika „Grzej CWU peletem” CWU z bieżącego harmonogramu idzie od razu (bez włączania). Sezon tylko
    // przy przejściu na tryb pompy ciepła: Lato, chyba że harmonogram chce Zimy (2026-10-26: Zima z trybu Pellet
    // została w kotle i pompy CO wychładzały wodę z pompy ciepła, bo cykl Zimy przy zatrzymanym harmonogramie nie działa).
    if (!settings.enabled) {
      const boiler = await PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>();
      const mode = await effectiveBoilerMode(rootId, boiler);
      if (boiler && mode) {
        const { season, seasonScheduleId: _seasonId, ...cwu } = await currentState(rootId, settings, mode, now, last);
        if (last?.mode !== mode || !!last?.pelletCwu !== !!cwu.pelletCwu) {
          const summer = last?.mode !== mode && mode === 'heat-pump' && season !== 'winter';
          const changes = changesFor(summer ? { ...cwu, season: 'summer' } : cwu, boiler);
          if (changes.length) {
            await createCommands(rootId, { changes }, systemMeta(
              'Harmonogram',
              last?.mode !== mode ? `Zmiana trybu pracy — CWU z bieżącego harmonogramu${summer ? ' i Lato' : ''} (regulator wyłączony).`
                : 'Zmiana „CWU - grzanie peletem” — CWU z bieżącego harmonogramu (regulator wyłączony).',
              `tryb ${MODE_NAMES[mode]}${cwu.pelletCwu ? ', CWU z peletu (wartości trybu Pellet)' : ''}`,
            ));
          }
          await PelletBoilerScheduleSettingsModel.updateOne(
            { rootId }, { $set: { lastApplied: { ...cwu, paused: true }, lastAppliedAt: now }, $unset: { lastError: 1 } }, { upsert: true });
          console.log(`[pellet scheduler] ${rootId} harmonogram zatrzymany, zmiana trybu albo CWU z peletu — CWU`, cwu, `zleceń: ${changes.length}`);
          sendMessage('update', rootId);
          return;
        }
      }
      if (!last || last.paused) return;
      const paused = { ...last, paused: true };
      await PelletBoilerScheduleSettingsModel.updateOne(
        { rootId }, { $set: { lastApplied: paused, lastAppliedAt: now }, $unset: { lastError: 1 } }, { upsert: true });
      sendMessage('update', rootId);
      return;
    }
    const boiler = await PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>();
    const mode = await effectiveBoilerMode(rootId, boiler);
    if (!boiler || !mode) throw new Error('Brak odczytu ustawień kotła — nie wiadomo, który tryb działa.');
    // sezon z przycisku w Ustawieniach (tryb pompy ciepła) wygrywa do zmiany sezonu z harmonogramu;
    // CWU z peletu w trybie pompy ciepła: CWU od–do jak w trybie Pellet (kocioł grzeje wtedy CWU sam)
    let state = await currentState(rootId, settings, mode, now, last);
    // Tryb pompy ciepła i Zima: sezonem steruje cykl Zimy (winter-cycle.service.ts), więc stan jest bez sezonu
    // (harmonogram zleca tylko CWU); koniec cyklu = Lato ze zwykłej ścieżki (stan z sezonem różny od ostatniego).
    if (mode === 'heat-pump' && state.season === 'winter') {
      const { season: _cycle, ...withoutSeason } = state;
      state = withoutSeason;
      await runWinterCycle(rootId, boilerSeasonOf(boiler), now, pump);
    } else {
      await stopWinterCycle(rootId);
    }
    if (sameState(state, last)) {
      // ten sam sezon z innego wpisu (np. kolejne okno): zapamiętuje wpis dla histerezy progu
      if (last && (last.seasonScheduleId ?? null) !== state.seasonScheduleId) {
        await PelletBoilerScheduleSettingsModel.updateOne({ rootId }, { $set: { 'lastApplied.seasonScheduleId': state.seasonScheduleId } });
      }
      if (mode === 'heat-pump') await restoreCwu(rootId, state, boiler, now);
      return;
    }
    const changes = changesFor(state, boiler);
    if (changes.length) await createCommands(rootId, { changes }, await transitionMeta(rootId, settings, mode, now, state, last));
    await PelletBoilerScheduleSettingsModel.updateOne(
      { rootId }, { $set: { lastApplied: state, lastAppliedAt: now }, $unset: { lastError: 1 } }, { upsert: true });
    console.log(`[pellet scheduler] ${rootId}`, state, `zleceń: ${changes.length}`);
  } catch (error) {
    await PelletBoilerScheduleSettingsModel.updateOne(
      { rootId }, { $set: { lastError: String((error as Error).message ?? error) } }, { upsert: true });
  }
  sendMessage('update', rootId);
}

// Tryb pompy ciepła: CWU zmienione na panelu wraca do harmonogramu. Zadaną kocioł podaje w każdym odczycie
// (water_heater_target), histerezę tylko w odczycie ustawień. Nie częściej niż co CWU_RESTORE_AFTER_MS
// od ostatniego zlecenia CWU (odczyt tuż po zapisie może jeszcze mieć starą wartość).
// CWU „bez zmiany” poza wpisami: nic nie przywraca.
async function restoreCwu(rootId: string, state: PelletBoilerScheduleState, boiler: PelletBoilerSettingsEntry, now: Date) {
  if (state.cwuUnchanged) return;
  // zlecenie CWU w toku albo świeże: najpierw jego wynik i nowy odczyt
  const recent = await PelletBoilerCommandModel.exists({
    rootId, kind: 'ecomax', index: { $in: [119, 123] },
    $or: [{ status: { $in: ['pending', 'sent'] } }, { createdAt: { $gt: new Date(now.getTime() - CWU_RESTORE_AFTER_MS) } }],
  });
  if (recent) return;
  const target = (await getPelletBoilerPelux200Last(rootId))?.water_heater_target;
  // tylko CWU: sezon zmieniony ręcznie zostaje do następnej zmiany stanu harmonogramu
  const changes = changesFor(state, boiler).filter((change) => change.index !== SEASON_PARAMETER);
  if (target !== undefined && target !== state.cwuTo && !changes.some((c) => c.index === 119)) {
    changes.unshift({ kind: 'ecomax', index: 119, value: state.cwuTo });
  }
  if (!changes.length) return;
  await createCommands(rootId, { changes }, systemMeta(
    'Harmonogram', 'CWU zmienione na panelu — w trybie Pompa ciepła wraca do harmonogramu (pompa nie dogrzeje wyższej temperatury).',
    `zadana CWU w kotle ${target ?? '?'} °C, harmonogram ${state.cwuFrom}–${state.cwuTo} °C`,
  ));
  console.log(`[pellet scheduler] ${rootId} CWU zmienione poza harmonogramem — przywracam`, changes);
}

const MODE_NAMES: Record<PelletBoilerMode, string> = { 'heat-pump': 'Pompa ciepła', pellet: 'Pellet' };
const window = (entry: PelletBoilerScheduleEntry) => `${entry.startTime}–${entry.endTime}`;

// Dziennik operacji: dlaczego harmonogram zleca zmianę (który wpis albo „poza harmonogramem”, sezon z przycisku,
// zmiana trybu) i przy jakich warunkach (temperatura zewnętrzna przy wpisie z progiem).
async function transitionMeta(
  rootId: string, settings: PelletBoilerScheduleSettings, mode: PelletBoilerMode, now: Date,
  state: PelletBoilerScheduleState, last?: PelletBoilerScheduleState,
) {
  const entries = await PelletBoilerScheduleModel.find({ rootId }).lean<PelletBoilerScheduleEntry[]>();
  const outdoor = await boilerOutdoorTemperature(rootId, now);
  const { scheduleId, seasonScheduleId } = scheduleState(settings, entries, mode, now, outdoor, last?.seasonScheduleId);
  const cwuEntry = entries.find((entry) => String(entry._id) === scheduleId);
  const seasonEntry = entries.find((entry) => String(entry._id) === seasonScheduleId);
  const manual = (await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('manualSeason')
    .lean<{ manualSeason?: PelletBoilerManualSeason | null }>())?.manualSeason;
  const reasons: string[] = [];
  if (last?.mode && last.mode !== mode) reasons.push(`zmiana trybu pracy na ${MODE_NAMES[mode]}`);
  if (state.season && state.season !== last?.season) {
    reasons.push(manual?.season === state.season ? 'sezon z przycisku w Ustawieniach'
      : seasonEntry ? `wpis sezonu ${window(seasonEntry)}` : 'sezon poza harmonogramem');
  }
  if (state.cwuFrom !== last?.cwuFrom || state.cwuTo !== last?.cwuTo || !!state.pelletCwu !== !!last?.pelletCwu
    || !!state.cwuUnchanged !== !!last?.cwuUnchanged) {
    reasons.push(state.cwuUnchanged ? 'CWU poza harmonogramem: bez zmiany (zostaje zadana z kotła)'
      : state.pelletCwu ? 'CWU z peletu (wartości trybu Pellet)'
      : cwuEntry ? `wpis CWU ${window(cwuEntry)}` : 'CWU poza harmonogramem');
  }
  const conditions = [`tryb ${MODE_NAMES[mode]}`];
  const thresholds = seasonEntry && seasonThresholds(seasonEntry);
  if (thresholds) {
    conditions.push(`temperatura zewnętrzna ${outdoor ?? '?'} °C (Zima poniżej ${thresholds.winterBelow} °C, Lato powyżej ${thresholds.summerAbove} °C)`);
  } else if (!seasonEntry && last?.seasonScheduleId && state.season !== last.season) {
    // wpis „Tryb Zima” przestał działać przez temperaturę (okno trwa dalej)
    const ended = entries.find((entry) => String(entry._id) === last.seasonScheduleId);
    const endedThresholds = ended && seasonThresholds(ended);
    if (endedThresholds) conditions.push(`temperatura zewnętrzna ${outdoor ?? '?'} °C powyżej ${endedThresholds.summerAbove} °C`);
  }
  return systemMeta('Harmonogram', `Przejście harmonogramu: ${reasons.join(', ') || 'zmiana stanu'}.`, conditions.join(', '));
}

// Dziennik operacji, „Zaplanowane”: przejścia harmonogramu od now do dayEnd — początki i końce włączonych wpisów
// CWU i sezonu trybu, w którym kocioł jest (przy „CWU - grzanie peletem” CWU z trybu Pellet), oraz koniec sezonu
// z przycisku. Wpis z progiem temperatury jest pokazany z warunkiem (zadziała tylko poniżej progu).
export async function plannedScheduleOperations(rootId: string, now: Date, dayEnd: Date): Promise<PlannedOperation[]> {
  const settings = await getScheduleSettings(rootId);
  if (!settings.enabled) return [];
  const boiler = await PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>();
  const mode = await effectiveBoilerMode(rootId, boiler);
  if (!mode) return [];
  const entries = await PelletBoilerScheduleModel.find({ rootId }).lean<PelletBoilerScheduleEntry[]>();
  const pelletCwu = mode === 'heat-pump' && (await getPelletCwu(rootId)).enabled;
  const outdoor = await boilerOutdoorTemperature(rootId, now);
  const cwuMode: PelletBoilerMode = pelletCwu ? 'pellet' : mode;
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd');
  const boundaries = new Map<number, PelletBoilerScheduleEntry[]>();
  for (const entry of entries.filter((e) => (e.type === 'season' && e.mode === mode) || ((e.type ?? 'cwu') === 'cwu' && e.mode === cwuMode))) {
    for (const day of [shiftDate(today, -1), today]) {
      const range = entryWindow(entry, day);
      for (const time of range ? [range.start, range.end] : []) {
        if (time > now && time < dayEnd) boundaries.set(time.getTime(), [...(boundaries.get(time.getTime()) ?? []), entry]);
      }
    }
  }
  // stan bez progu temperatury (-100 °C: każdy wpis z progiem działa) — warunek jest w opisie
  const stateAt = (time: number) => ({
    season: scheduleState(settings, entries, mode, new Date(time), -100).state.season,
    cwu: scheduleState(settings, entries, cwuMode, new Date(time)).state,
  });
  const planned: PlannedOperation[] = [];
  for (const time of [...boundaries.keys()].sort((a, b) => a - b)) {
    const before = stateAt(time - 1000);
    const after = stateAt(time + 1000);
    const actions: string[] = [];
    if (after.season && after.season !== before.season) actions.push(`Sezon: ${SEASON_NAMES_PL[before.season ?? 'summer']} → ${SEASON_NAMES_PL[after.season]}`);
    if (after.cwu.cwuUnchanged) {
      if (!before.cwu.cwuUnchanged) actions.push('CWU: bez zmiany (zostaje zadana z kotła)');
    } else if (before.cwu.cwuUnchanged || after.cwu.cwuFrom !== before.cwu.cwuFrom || after.cwu.cwuTo !== before.cwu.cwuTo) {
      actions.push(`CWU od–do: ${after.cwu.cwuFrom}–${after.cwu.cwuTo} °C`);
    }
    if (!actions.length) continue;
    const local = formatInTimeZone(new Date(time), TIME_ZONE, 'HH:mm');
    const touched = boundaries.get(time) ?? [];
    const reasons = touched.map((entry) => `${entry.startTime === local ? 'początek' : 'koniec'} wpisu ${entry.type === 'season' ? 'sezonu' : 'CWU'} ${window(entry)}`);
    const cold = touched.map((entry) => entry.type === 'season' ? seasonThresholds(entry) : null).find(Boolean);
    planned.push({
      at: new Date(time), actor: { type: 'system' }, source: 'Harmonogram', action: actions.join(' · '),
      reason: `${reasons.join(', ')}${pelletCwu ? ' (CWU z peletu: wpisy trybu Pellet)' : ''}.`,
      ...(cold ? { conditions: `według temperatury: Zima poniżej ${cold.winterBelow} °C, Lato powyżej ${cold.summerAbove} °C (teraz ${outdoor ?? '?'} °C)` } : {}),
    });
  }
  // koniec sezonu z przycisku
  const manual = (await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('manualSeason')
    .lean<{ manualSeason?: PelletBoilerManualSeason | null }>())?.manualSeason;
  if (manual?.until && new Date(manual.until) > now && new Date(manual.until) < dayEnd) {
    planned.push({
      at: new Date(manual.until), actor: { type: 'system' }, source: 'Harmonogram',
      action: `Koniec ręcznego sezonu (${SEASON_NAMES_PL[manual.season]})`,
      reason: 'Sezon wybrany przyciskiem działa do granicy wpisu sezonu; dalej sezon ustawia harmonogram.',
    });
  }
  // cykl Zimy (tryb Pompa ciepła): przejście po spełnieniu warunku, bez godziny; po wykonaniu wpis z godziną jest
  // w „Wykonanych” (winter-cycle.service.ts)
  const cycle = (await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('winterCycle')
    .lean<{ winterCycle?: PelletBoilerWinterCycle | null }>())?.winterCycle;
  const temp = (value: number | null | undefined) =>
    typeof value === 'number' ? `${value.toLocaleString('pl-PL', { maximumFractionDigits: 1 })} °C` : '?';
  if (mode === 'heat-pump' && cycle?.phase === 'waiting') {
    planned.push({
      at: now, conditional: true, actor: { type: 'system' }, source: 'Cykl Zimy', action: 'Sezon: Lato → Zima',
      reason: 'Kocioł na Lecie czeka, aż pompa ciepła nagrzeje wodę; na Zimie ruszają pompy kotła.',
      conditions: `gdy kocioł albo woda w pompie osiągnie ${cycle.winterFrom ?? WINTER_FROM} °C; teraz kocioł ${temp(cycle.temperature)}, pompa ${temp(cycle.pumpTemperature)}`,
    });
  }
  if (mode === 'heat-pump' && cycle?.phase === 'winter') {
    planned.push({
      at: now, conditional: true, actor: { type: 'system' }, source: 'Cykl Zimy', action: 'Sezon: Zima → Lato',
      reason: 'Woda w kotle się wychłodzi — kocioł wraca na Lato do ponownego nagrzania przez pompę ciepła.',
      conditions: `gdy kocioł spadnie poniżej ${SUMMER_BELOW} °C i stanie pompa CO; teraz kocioł ${temp(cycle.temperature)}`,
    });
  }
  return planned.sort((a, b) => Number(!!b.conditional) - Number(!!a.conditional) || a.at.getTime() - b.at.getTime());
}

const SEASON_NAMES_PL: Record<PelletBoilerSeason, string> = { winter: 'Zima', summer: 'Lato' };

export async function runPelletBoilerSchedulerOnce(now = new Date()) {
  const devices = await DeviceModel.find({ deviceType: DeviceType.PELLET_BOILER_PELUX200 }).select('_id').lean();
  for (const device of devices) {
    await applySchedule(String(device._id), now);
    await runPelletCwu(String(device._id), now).catch((error) => console.error('[pellet cwu z peletu] error:', error));
    await runPendingTurnOn(String(device._id), now).catch((error) => console.error('[pellet] włączenie po nagrzaniu:', error));
    await evaluateCwuLoading(String(device._id), now).catch((error) => console.error('[pellet cwu] error:', error));
  }
}

export function startPelletBoilerScheduler(): NodeJS.Timeout {
  let running = false;
  // kotły sprzed powiązania z pompą ciepła dostają ją raz, przed pierwszym przebiegiem
  const migrated = migrateBoilerDefinitions().catch((error) => console.error('[pellet] powiązanie z pompą ciepła:', error));
  const tick = async () => {
    await migrated;
    if (running) return;
    running = true;
    try {
      await runPelletBoilerSchedulerOnce();
    } catch (error) {
      console.error('[pellet scheduler] error:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), PELLET_SCHEDULER_INTERVAL_MS);
}

// --- dane dla aplikacji ---

// Zapisane ustawienia uzupełnione wartościami startowymi (brak dokumentu = harmonogram wyłączony).
export async function getScheduleSettings(rootId: string): Promise<PelletBoilerScheduleSettings> {
  const saved = await PelletBoilerScheduleSettingsModel.findOne({ rootId }).lean<Partial<PelletBoilerScheduleSettings>>();
  const base = DEFAULT_SCHEDULE_SETTINGS;
  return {
    rootId,
    enabled: saved?.enabled ?? base.enabled,
    defaults: {
      'heat-pump': { ...base.defaults['heat-pump'], ...(saved?.defaults?.['heat-pump']?.cwuTo ? saved.defaults['heat-pump'] : {}) },
      pellet: { ...base.defaults.pellet, ...(saved?.defaults?.pellet?.cwuTo ? saved.defaults.pellet : {}) },
    },
    profiles: {
      'heat-pump': saved?.profiles?.['heat-pump'] ?? base.profiles['heat-pump'],
      pellet: saved?.profiles?.pellet ?? base.profiles.pellet,
    },
    ...(saved?.lastApplied ? { lastApplied: saved.lastApplied } : {}),
    ...(saved?.lastError ? { lastError: saved.lastError } : {}),
  };
}

// Zapis ustawień harmonogramu; od razu przebieg dla tego kotła (zmiana domyślnych działa bez czekania).
export async function saveScheduleSettings(rootId: string, input: Omit<PelletBoilerScheduleSettings, 'rootId'>) {
  await PelletBoilerScheduleSettingsModel.updateOne(
    { rootId }, { $set: { enabled: input.enabled, defaults: input.defaults, profiles: input.profiles, rootId } }, { upsert: true });
  await applySchedule(rootId);
  return getScheduleSettings(rootId);
}

export async function getCurrentSchedule(rootId: string, now = new Date()) {
  const settings = await getScheduleSettings(rootId);
  const boiler = await PelletBoilerSettingsModel.findOne({ rootId }).lean<PelletBoilerSettingsEntry>();
  const mode = await effectiveBoilerMode(rootId, boiler);
  const entries = await PelletBoilerScheduleModel.find({ rootId }).lean<PelletBoilerScheduleEntry[]>();
  const outdoor = await boilerOutdoorTemperature(rootId, now);
  // pelletCwu: CWU z peletu w trybie pompy ciepła (znacznik, faza, CWU od–do trybu Pellet)
  const pelletCwu = await getPelletCwu(rootId);
  const current = mode
    ? scheduleState(settings, entries, mode, now, outdoor, settings.lastApplied?.seasonScheduleId)
    : { state: null, scheduleId: null, seasonScheduleId: null };
  // znacznik „CWU - grzanie peletem” w trybie pompy ciepła: tak jak scheduler (currentState) CWU od–do i działający
  // wpis CWU z listy Pellet (sezon zostaje z listy Pompa ciepła); do 2026-10-20 zakładka pokazywała tu listę pompy
  if (mode === 'heat-pump' && pelletCwu.enabled && current.state) {
    const pellet = scheduleState(settings, entries, 'pellet', now, outdoor);
    const { cwuUnchanged: _unchanged, ...withoutUnchanged } = current.state;
    current.state = {
      ...withoutUnchanged, cwuFrom: pellet.state.cwuFrom, cwuTo: pellet.state.cwuTo, pelletCwu: true,
      ...(pellet.state.cwuUnchanged ? { cwuUnchanged: true } : {}),
    };
    current.scheduleId = pellet.scheduleId;
  }
  // winterCycle: cykl Zimy w trybie pompy ciepła (winter-cycle.service.ts), manualSeason: sezon z przycisku
  const saved = await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('winterCycle manualSeason')
    .lean<{ winterCycle?: PelletBoilerWinterCycle | null; manualSeason?: PelletBoilerManualSeason | null }>();
  // pendingTurnOn: włączenie regulatora czeka na nagrzanie kotła (turn-on.service.ts)
  const pendingTurnOn = await getPendingTurnOn(rootId);
  // hotBoilerFrom: pompa ciepła stoi przy kotle od tej temperatury (z odpowiedzi pompy; opis znacznika CWU z peletu)
  const hotBoilerFrom = (await PelletBoilerScheduleSettingsModel.findOne({ rootId }).select('cwuLoading')
    .lean<{ cwuLoading?: { hotBoilerFrom?: number } }>())?.cwuLoading?.hotBoilerFrom ?? 52;
  // boilerCwu: CWU ustawione teraz w kotle (dla „CWU bez zmiany”); heatPumpCwuMax: do ilu grzeje włączona pompa ciepła
  // powiązana z kotłem (null: wyłączona, offline, brak pompy); cwuTooHigh: tryb pompy ciepła (bez „CWU - grzanie peletem”)
  // z zadaną CWU wyższą niż heatPumpCwuMax — czerwona informacja w aplikacji (harmonogram i ekran kotła)
  const boilerCwu = await boilerCwuSetting(rootId, boiler);
  const heatPump = mode === 'heat-pump' && !pelletCwu.enabled ? await linkedHeatPumpRootId(rootId) : null;
  const pumpCwuMax = heatPump ? await heatPumpCwuMax(heatPump).catch(() => null) : null;
  const cwuTooHigh = pumpCwuMax !== null && typeof boilerCwu.cwuTo === 'number' && boilerCwu.cwuTo > pumpCwuMax;
  // outdoorTemperature: temperatura zewnętrzna z czujnika kotła (ostatni odczyt) dla zakładki Harmonogram
  return {
    enabled: settings.enabled, mode, ...current, outdoorTemperature: outdoor,
    boilerCwu, cwuTooHigh, heatPumpCwuMax: pumpCwuMax,
    winterCycle: saved?.winterCycle ?? null, manualSeason: saved?.manualSeason?.season ?? null,
    // do kiedy działa sezon z przycisku (null: do zmiany sezonu w harmonogramie albo kolejnego naciśnięcia)
    manualSeasonUntil: saved?.manualSeason ? saved.manualSeason.until ?? null : null, pelletCwu, pendingTurnOn, hotBoilerFrom,
    lastError: settings.lastError ?? null,
  };
}

// dawne wpisy pracy kotła (type work) nie są pokazywane
export const listScheduleEntries = (rootId: string) =>
  PelletBoilerScheduleModel.find({ rootId, type: { $ne: 'work' } }).sort({ mode: 1, type: 1, startTime: 1 }).lean<PelletBoilerScheduleEntry[]>();

export async function createScheduleEntry(rootId: string, entry: ScheduleInput) {
  const created = await PelletBoilerScheduleModel.create({ ...entry, rootId });
  await applySchedule(rootId);
  return created.toObject();
}

export async function replaceScheduleEntry(rootId: string, id: string, entry: ScheduleInput) {
  const updated = await PelletBoilerScheduleModel.findOneAndReplace({ _id: id, rootId }, { ...entry, rootId }, { new: true }).lean();
  if (updated) await applySchedule(rootId);
  return updated;
}

export async function removeScheduleEntry(rootId: string, id: string) {
  const result = await PelletBoilerScheduleModel.deleteOne({ _id: id, rootId });
  if (result.deletedCount > 0) await applySchedule(rootId);
  return result.deletedCount > 0;
}
