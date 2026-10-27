// Telemetria pompy: zapis (addHpData z POST /hp/add), wykrywanie zdarzeń błędów CHPC,
// ostatni błąd i odczyty kolekcji hp. Trzyma w pamięci ostatnią telemetrię i listę
// dni z danymi per rootId (do restartu serwera); scheduler też czyta stąd ostatnie dane.
import { comparisonKey, createPlateauWriter } from '../../../core/services/plateau-writer.service';
import { HpEntry } from '../types';
import { sendMessage } from '../../../core/websocket';
import { HpEntryModel } from '../models/hp.model';
import { getTemperature } from '../../../core/services/meteo.service';
import { formatInTimeZone } from 'date-fns-tz';
import { TIME_ZONE, warsawDayBoundsUTC } from '../../../core/time';
import { getDeviceInfo } from '../../../core/services/device-info.service';
import { notify } from '../../../core/services/push.service';
import { both, Lang, t } from '../../../core/i18n';

// opisy kodów błędów CHPC do powiadomień (te same co client/src/devices/heat-pump/utils/errors.ts; zmieniać razem)
const ERROR_TEXTS: Record<Lang, Record<number, string>> = {
  pl: {
    1: 'czujnik', 2: 'przeciążenie', 3: 'brak przepływu', 4: 'za mała moc', 5: 'Tho', 6: 'Tsump za wysoka', 7: 'Tbc',
    8: 'Tae', 9: 'Tco', 10: 'przekaźnik', 11: 'blokada po 5 błędach', 12: 'Tsump za niska', 13: 'Tbe',
  },
  en: {
    1: 'sensor', 2: 'overload', 3: 'no flow', 4: 'power too low', 5: 'Tho', 6: 'Tsump too high', 7: 'Tbc',
    8: 'Tae', 9: 'Tco', 10: 'relay', 11: 'locked after 5 errors', 12: 'Tsump too low', 13: 'Tbe',
  },
};
const hpsOn = (value: unknown) => value === true || Number(value) > 0;
const tankText = (data: HpEntry, lang: Lang) => (typeof data.HP?.Ttarget === 'number' ? t(lang, 'push.tank', { value: data.HP.Ttarget.toFixed(1) }) : '');

// Powiadomienia Web Push (core/services/push.service.ts): start i stop sprężarki oraz nowy błąd CHPC.
// Wołane przy zapisie telemetrii, więc porównanie z poprzednim odczytem jest już policzone.
async function notifyHpEvents(rootId: string, previous: HpEntry | undefined, data: HpEntry, errorCode: number | undefined) {
  if (previous?.HP && data.HP && hpsOn(previous.HP.HPS) !== hpsOn(data.HP.HPS)) {
    const on = hpsOn(data.HP.HPS);
    const minutesOn = typeof data.HP.lt_hp_on === 'number' && !on ? Math.round(data.HP.lt_hp_on / 60) : null;
    await notify(rootId, on ? 'compressor-on' : 'compressor-off', {
      body: both((lang) => t(lang, on ? 'push.compressorOn' : 'push.compressorOff', { minutes: minutesOn === null ? '' : t(lang, 'push.afterMinutes', { n: minutesOn }), tank: tankText(data, lang) })),
      url: '/',
    });
  }
  if (errorCode) {
    await notify(rootId, 'error', {
      body: both((lang) => t(lang, 'push.hpError', { code: errorCode, text: ERROR_TEXTS[lang][errorCode] ?? t(lang, 'push.hpErrorUnknown'), tank: tankText(data, lang) })),
      url: '/settings',
    });
  }
}

// const parseDate = (str: String | undefined ):string   => !str ? "" : str.replace(/\./g, "-").replace(" ", "T");
// Ostatnia telemetria w postaci, w jakiej przyszła (z polami spoza schematu, bez
// createdAt); po restarcie odtwarzana z bazy przy pierwszym odczycie.
const lastDataByRoot = new Map<string, HpEntry>();

// Ostatnie POST /hp/add od sterownika co, także bez odczytu z CHPC (puste HP nie jest zapisywane). Pozwala odróżnić
// brak łączności ze sterownikiem od wyłączonej pompy (CHPC). Tylko w pamięci: po restarcie serwera do pierwszego
// zgłoszenia co (najdalej 30 s) czasu kontaktu nie ma.
const lastContactByRoot = new Map<string, Date>();
export const markHpContact = (rootId: string, at = new Date()) => { lastContactByRoot.set(rootId, at); };
export const getHpContactAt = (rootId: string): Date | undefined => lastContactByRoot.get(rootId);

// Liczniki diagnostyczne co (punkt 5 CLAUDE.md) z każdego POST /hp/add, także z pustym HP (2026-10-14: CHPC milczał
// godzinami, a serwer odrzucał całe zgłoszenie). Ostatnie, poprzednie i z ostatniego zgłoszenia z odczytem CHPC —
// przyrost od tamtej chwili pokazuje, czy CHPC milczy (serial_read_timeout), czy odpowiada uszkodzoną ramką
// (hp_json_error, serial_receive_overflow). Tylko w pamięci; liczniki co zerują się przy jego restarcie.
// Od co 1.2.5 (bus_diagnostics.hpp) także serial_unexpected_frame, hp_late_frame, hp_last_ok_s, echo aktywnego
// zlecenia diag i zrzuty diag_hp_raw / diag_bus. Od co 1.3.2 wynik zapasowego pobierania pogody: weather_ok,
// weather_fail (liczniki od startu co) i weather_code (kod HTTP ostatniego pobrania).
const DIAGNOSTIC_KEYS = [
  'serial_queue_overflow', 'serial_read_timeout', 'serial_receive_overflow', 'pv_crc_error', 'hp_json_error',
  'pv_frame_error', 'cloud_http_status', 'cloud_request_error', 'websocket_disconnect', 'cloud_response_parse_error',
  'operation_validation_error', 'preference_validation_error', 'serial_unexpected_frame', 'hp_late_frame',
  'hp_last_ok_s', 'weather_ok', 'weather_fail', 'weather_code',
] as const;
// wartości, które nie są licznikami (kod HTTP, wiek w sekundach): bez przyrostu
const NOT_COUNTERS = new Set<string>(['cloud_http_status', 'hp_last_ok_s', 'weather_code']);
const DIAGNOSTIC_OBJECTS = ['diag', 'diag_hp_raw', 'diag_bus'] as const;
type HpCounters = Partial<Record<(typeof DIAGNOSTIC_KEYS)[number], number>>;
type HpCountersAt = { at: Date; counters: HpCounters };
type HpDiagnostics = {
  last: HpCountersAt & { hp: boolean; objects: Record<string, unknown> };
  previous?: HpCountersAt;
  lastHp?: HpCountersAt;
};
const diagnosticsByRoot = new Map<string, HpDiagnostics>();

export function noteHpDiagnostics(rootId: string, data: unknown, at = new Date()) {
  const body = (data ?? {}) as Record<string, unknown>;
  const counters: HpCounters = {};
  for (const key of DIAGNOSTIC_KEYS) if (typeof body[key] === 'number') counters[key] = body[key] as number;
  const objects: Record<string, unknown> = {};
  for (const key of DIAGNOSTIC_OBJECTS) if (body[key] && typeof body[key] === 'object') objects[key] = body[key];
  const hp = !!(body.HP as { Ttarget?: unknown } | undefined)?.Ttarget;
  const saved = diagnosticsByRoot.get(rootId);
  const current = { at, counters };
  diagnosticsByRoot.set(rootId, {
    last: { ...current, hp, objects },
    previous: saved?.last,
    lastHp: hp ? current : saved?.lastHp,
  });
}

const countersDelta = (now: HpCounters, before?: HpCounters) => before && Object.fromEntries(DIAGNOSTIC_KEYS
  .filter((key) => !NOT_COUNTERS.has(key) && typeof now[key] === 'number' && typeof before[key] === 'number')
  .map((key) => [key, (now[key] as number) - (before[key] as number)]));

// Zlecenie diagnostyki dla co (PUT /hp/diagnostics): pole "diag" w odpowiedzi na każde /hp/add do wygaśnięcia.
// Tylko w pamięci: restart serwera albo koniec czasu = brak pola, co wraca do zwykłej pracy.
export type HpDiagRequest = { hp_raw: 0 | 1; bus_sniff: 0 | 1; hp_timeout_s: number };
const diagRequestByRoot = new Map<string, { request: HpDiagRequest; until: Date }>();

export function setHpDiagRequest(rootId: string, request: HpDiagRequest | null, until?: Date) {
  if (!request || !until) diagRequestByRoot.delete(rootId);
  else diagRequestByRoot.set(rootId, { request, until });
}

export function getHpDiagRequest(rootId: string, now = new Date()) {
  const saved = diagRequestByRoot.get(rootId);
  if (saved && saved.until.getTime() <= now.getTime()) {
    diagRequestByRoot.delete(rootId);
    return undefined;
  }
  return saved;
}

// Do GET /hp i GET /hp/diagnostics: liczniki, przyrost od poprzedniego zgłoszenia i od ostatniego odczytu CHPC,
// echo zlecenia i zrzuty z co (1.2.5) oraz zlecenie po stronie serwera.
export function getHpDiagnostics(rootId: string) {
  const saved = diagnosticsByRoot.get(rootId);
  const request = getHpDiagRequest(rootId);
  if (!saved && !request) return undefined;
  return {
    ...(saved ? {
      at: saved.last.at.toISOString(),
      hp: saved.last.hp,
      counters: saved.last.counters,
      sincePrevious: countersDelta(saved.last.counters, saved.previous?.counters),
      lastHpAt: saved.lastHp?.at.toISOString() ?? null,
      sinceLastHp: countersDelta(saved.last.counters, saved.lastHp?.counters),
      ...saved.last.objects,
    } : {}),
    request: request ? { ...request.request, until: request.until.toISOString() } : null,
  };
}
// Dni z danymi (YYYY.MM.DD, Warszawa); addHpData dopisuje dzień tylko do już wczytanego zbioru.
const availableDatesByRoot = new Map<string, Set<string>>();

export const getHpAvailableDates = async (rootId: string): Promise<string[]> => {
  const cachedDates = availableDatesByRoot.get(rootId);
  if (cachedDates) {
    return Array.from(cachedDates).sort().reverse();
  }

  const result = await HpEntryModel.aggregate<{ date: string }>([
    {
      $match: {
        rootId,
        createdAt: { $exists: true },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y.%m.%d',
            date: '$createdAt',
            timezone: TIME_ZONE,
          },
        },
      },
    },
    { $project: { _id: 0, date: '$_id' } },
  ]);

  const dates = new Set(result.map(({ date }) => date));
  availableDatesByRoot.set(rootId, dates);

  return Array.from(dates).sort().reverse();
};

// Ostatnia telemetria urządzenia albo {} gdy brak. Używana przez GET /hp, /operation,
// scheduler (temperatury domyślne), wykrywanie błędów i getHpLastError.
export const getHpLastData = async (rootId: string) => {

  const cached = lastDataByRoot.get(rootId);
  if (cached) return cached;

  const lastData = await HpEntryModel.findOne({ rootId }).sort({ createdAt: -1 }).lean<HpEntry>();
  if (lastData) {
    lastDataByRoot.set(rootId, lastData);
  }
  
  if (!lastData) {
    return {};
  }
  return lastData;
}

// GET /hp/all: rekordy od 1 stycznia bieżącego roku. Granica roku liczona w strefie
// serwera (na Render UTC), nie w czasie warszawskim.
// Dane od początku bieżącego roku w czasie warszawskim (do 2026-10-21: rok w strefie serwera, czyli UTC na Render).
export const getHpAllData = async (rootId: string) => {
  const currentYear = formatInTimeZone(new Date(), TIME_ZONE, 'yyyy');
  const startOfCurrentYear = warsawDayBoundsUTC(`${currentYear}-01-01`).startUTC;

  const doc = await HpEntryModel
    .find({ rootId, createdAt: { $gte: startOfCurrentYear } })
    .sort({ createdAt: -1 })
    .lean<HpEntry>();
  return doc;
}

// CHPC podaje kod ostatniego błędu (ERR) i numer kolejny zdarzenia (ERRn).
// Nowy błąd to zmiana ERRn przy niezerowym ERR; zwraca jego kod albo undefined.
export const detectErrorEvent = (previous: HpEntry | undefined, current: HpEntry) => {
  const code = current.HP?.ERR;
  const sequence = current.HP?.ERRn;
  if (!code || sequence === undefined || sequence === null) return undefined;
  if (previous?.HP?.ERRn === sequence) return undefined;
  return code;
};

// Ostatni błąd z ostatnich 24 godzin (okno ruchome); starszy nie jest już pokazywany.
// Wyjątek: zablokowany sterownik (HP.ERRc >= 5) pokazuje ostatni błąd bez limitu czasu, aż do odblokowania.
export const LAST_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ERROR_LOCK_LIMIT = 5;

// Blokadę ocenia się z ostatniej telemetrii (pamięć podręczna), a sam błąd z bazy.
export const getHpLastError = async (rootId: string, now = new Date()) => {
  const current = await getHpLastData(rootId) as HpEntry;
  const locked = Number(current?.HP?.ERRc ?? 0) >= ERROR_LOCK_LIMIT;
  const since = new Date(now.getTime() - LAST_ERROR_WINDOW_MS);
  const doc = await HpEntryModel
    .findOne({ rootId, error_code: { $gt: 0 }, ...(locked ? {} : { createdAt: { $gte: since } }) })
    .sort({ createdAt: -1 })
    .select('time createdAt error_code HP.ERRc')
    .lean<HpEntry & { createdAt?: Date }>();
  return doc ?? {};
};

// Zapis bez identycznych powtórzeń (core/services/plateau-writer.service.ts). Porównanie pomija czas ze
// sterownika, t_out (serwer) oraz lt_hp_on i lt_pow (w pracy i tak rosną, więc seria to w praktyce postój).
const writeHp = createPlateauWriter(HpEntryModel);
const hpKey = (cast: Record<string, unknown>) => comparisonKey(cast, ['time', 't_out', 'lt_hp_on', 'lt_pow']);

// Zapis rekordu hp: dopisuje t_out (czujnik kotła), rootId, rodzaj, deviceId i ewentualny
// error_code, aktualizuje pamięć podręczną i wysyła WebSocket "update" do klienta.
export const addHpData = async (rootId: string, data :HpEntry) => {
  data.t_out = getTemperature()!;
  const device = await getDeviceInfo(rootId);

  // Porównanie z poprzednim zapisanym odczytem. Czas błędu = czas pierwszego rekordu
  // z nowym ERRn (dokładność 10–30 s, CHPC nie ma zegara).
  const previous = await getHpLastData(rootId) as HpEntry;
  const errorCode = detectErrorEvent(previous, data);
  await notifyHpEvents(rootId, previous ?? undefined, data, errorCode || undefined);

  const dataWithRoot = {
    ...data,
    rootId,
    deviceType: device.deviceType,
    deviceId: device.deviceId,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
  // pamięć podręczna przed zapisem: surowe dane, także pola, które schemat pominie
  lastDataByRoot.set(rootId, dataWithRoot);

  const { doc } = await writeHp(rootId, dataWithRoot as unknown as Record<string, unknown>, hpKey);
  // po zapisie pamięć podręczna dostaje też czas rekordu: bez niego kafelek na /devices (tile.ts) nie wie, kiedy
  // sterownik ostatnio nadał, i do restartu serwera pokazuje „Brak danych” (błąd z produkcji 2026-10-08)
  lastDataByRoot.set(rootId, { ...dataWithRoot, createdAt: (doc as { createdAt?: Date }).createdAt ?? new Date() } as HpEntry);

  const cachedDates = availableDatesByRoot.get(rootId);
  if (cachedDates) {
    const createdAt = (doc as unknown as { createdAt?: Date }).createdAt ?? new Date();
    const date = formatInTimeZone(createdAt, TIME_ZONE, 'yyyy.MM.dd');
    cachedDates.add(date);
  }

  sendMessage('update', rootId);
  return doc;
}
