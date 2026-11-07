// Temperatura zewnętrzna i pogoda (pasek nad kafelkami, t_out w rekordach hp, ekran sterownika co, GET /temperature).
//
// Temperatura: z czujnika zewnętrznego kotła pelletowego (outside_temp z odczytu sterownika pieca; od 2026-10-04
// zamiast stacji IMGW Zakopane, decyzja użytkownika). Ustawia ją moduł kotła przy każdym odczycie i po starcie
// serwera z ostatniego odczytu w bazie (core nie importuje modułów). Pomiar starszy niż OUTDOOR_MAX_AGE_MS jest
// pomijany; wtedy (i w domu bez kotła) temperatura z prognozy Open-Meteo, jeśli jest świeża (od 2026-10-15).
//
// Od 2026-11-07 pogodę pobiera serwer (core/services/weather-fetch.service.ts, źródło 'server'): na Oracle ma własny
// adres IP. Włącznik, a po nim co, pobierają już tylko zapasowo: dostają miejsca, dla których serwer nie ma świeżej
// pogody od WEATHER_BACKUP_AFTER_MS (weatherStale). Bez uruchomionego pobierania (testy) działa jak niżej.
//
// Pogoda (niebo, opady, wiatr, dzień/noc, temperatura z prognozy) od 2026-10-15: pobiera ją sterownik włącznika
// z Open-Meteo z domowego łącza (Open-Meteo liczy limit zapytań na adres IP, a Render dzieli adres z innymi usługami —
// w lipcu 2026 pobieranie z serwera nie działało; włącznik, bo nie każdy dom będzie miał sterownik co). Miejsca
// podaje serwer w odpowiedzi POST /switch/state: weather_query (dom, włącznik 1.1.3) i weather_queries
// [{id, lat, lon}] (kafelki pogody, core/services/weather-tile.service.ts, włącznik od 1.2.0). Włącznik odsyła
// w zgłoszeniu stanu pole weather: obiekt (dom) albo tablicę [{id, …}]. Tylko w pamięci, klucz = id kafelka
// (dom także pod HOME_KEY); starsza niż WEATHER_MAX_AGE_MS jest pomijana.
//
// Zapasowo (od 2026-10-17, jak przekaźnik poczty) pogodę pobiera sterownik co (od 1.3.1): w odpowiedzi POST /hp/add
// dostaje weather_queries tylko z miejscami, dla których włącznik nie dostarczył odczytu od WEATHER_BACKUP_AFTER_MS
// (weatherStale; po starcie serwera najpierw tyle samo czeka na włącznik), i odsyła pole weather w następnym
// hp/add. Gdy włącznik wróci, lista co jest pusta. Odczyty obu sterowników trafiają do tej samej mapy (nowszy wygrywa).

export const OUTDOOR_MAX_AGE_MS = 15 * 60 * 1000;
export const WEATHER_MAX_AGE_MS = 45 * 60 * 1000;
// włącznik pobiera co 15 min (po błędzie ponowienie po 5 min), więc 25 min bez jego odczytu = włącznik nie działa
export const WEATHER_BACKUP_AFTER_MS = 25 * 60 * 1000;
const startedAt = Date.now();
// dom: ul. Jana Pawła II, Biały Dunajec (zweryfikowane w OpenStreetMap 2026-10-14); przy kontach użytkowników
// położenie z adresu albo miejscowości
export const WEATHER_LOCATION = { lat: 49.374298, lon: 20.007237 };

let outdoor: { value: number; at: Date } | null = null;

// Nowy pomiar z czujnika kotła (moduł pellet-boiler-pelux200); starszy niż zapamiętany jest pomijany.
export function setOutdoorTemperature(value: number, at = new Date()) {
  if (!Number.isFinite(value)) return;
  if (outdoor && outdoor.at > at) return;
  outdoor = { value, at };
}

/** bieżące warunki z Open-Meteo: temperatura z prognozy [°C], kod WMO, zachmurzenie [%], opad i deszcz [mm],
 *  śnieg [cm] z ostatniego kwadransa, wiatr [km/h] */
export type Weather = {
  temperature: number; code: number; cloudCover: number; precipitation: number; rain: number; snowfall: number;
  windSpeed: number; isDay: boolean; at: string;
};

type WeatherEntry = Omit<Weather, 'at'> & { at: Date };
// klucz pogody ze starszego włącznika (jedno miejsce = dom)
const HOME_KEY = 'home';
const weatherByKey = new Map<string, WeatherEntry>();
export type WeatherSource = 'server' | 'switch' | 'co';
// chwila ostatniego odczytu od źródła dla klucza (do decyzji o zapasowym pobieraniu przez sterowniki)
const sourceAt: Record<WeatherSource, Map<string, number>> = { server: new Map(), switch: new Map(), co: new Map() };
// pobieranie przez serwer uruchomione (weather-fetch.service, startServerWeather) i od kiedy
let serverWeatherSince: number | null = null;
export function setServerWeatherActive(active: boolean, now = Date.now()) { serverWeatherSince = active ? now : null; }
export const serverWeatherActive = () => serverWeatherSince !== null;
// id kafelka „Dom” (weather-tile.service); pogoda domu = pod tym id albo pod HOME_KEY
let homeKey = HOME_KEY;
export function setHomeWeatherKey(id: string) { homeKey = id; }

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Jeden odczyt {temp, code, cloud, precip, rain, snow, wind, day, age_s} pod kluczem; błędny albo starszy od
// zapamiętanego jest pomijany.
function storeWeather(key: string, input: unknown, now: Date, source: WeatherSource) {
  const value = (input ?? {}) as Record<string, unknown>;
  const keys = ['temp', 'code', 'cloud', 'precip', 'rain', 'snow', 'wind', 'day', 'age_s'];
  if (!input || typeof input !== 'object' || !keys.every((key) => isNumber(value[key]))) return;
  const ageS = Math.max(0, value.age_s as number);
  const at = new Date(now.getTime() - ageS * 1000);
  sourceAt[source].set(key, Math.max(sourceAt[source].get(key) ?? 0, at.getTime()));
  const previous = weatherByKey.get(key);
  if (previous && previous.at > at) return;
  weatherByKey.set(key, {
    temperature: value.temp as number, code: Math.round(value.code as number), cloudCover: value.cloud as number,
    precipitation: value.precip as number, rain: value.rain as number, snowfall: value.snow as number,
    windSpeed: value.wind as number, isDay: value.day !== 0, at,
  });
}

// Pole weather ze zgłoszenia sterownika: obiekt (włącznik 1.1.3, dom) albo tablica [{id, …}] (włącznik od 1.2.0,
// co od 1.3.1).
export function setWeatherFromController(input: unknown, now = new Date(), source: WeatherSource = 'switch') {
  if (Array.isArray(input)) {
    input.forEach((item) => {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id) storeWeather(id, item, now, source);
    });
    return;
  }
  storeWeather(HOME_KEY, input, now, source);
}

// true = źródło nie dostarczyło pogody dla klucza od WEATHER_BACKUP_AFTER_MS (dom: także pod HOME_KEY), a działa
// co najmniej tyle (po starcie serwera albo pobierania najpierw czeka na to źródło); wtedy pobiera następne źródło.
export function weatherStale(key: string, source: WeatherSource, now = new Date()): boolean {
  const since = source === 'server' ? serverWeatherSince ?? now.getTime() : startedAt;
  if (now.getTime() - since < WEATHER_BACKUP_AFTER_MS) return false;
  const times = sourceAt[source];
  const last = Math.max(times.get(key) ?? 0, key === homeKey ? times.get(HOME_KEY) ?? 0 : 0);
  return now.getTime() - last > WEATHER_BACKUP_AFTER_MS;
}

// Ostatnia świeża pogoda dla klucza (id kafelka) albo null; dla domu nowsza z dwóch (id kafelka i HOME_KEY).
export function getWeatherFor(key: string, now = new Date()): Weather | null {
  const candidates = [weatherByKey.get(key), key === homeKey ? weatherByKey.get(HOME_KEY) : undefined]
    .filter((item): item is WeatherEntry => !!item);
  const entry = candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!entry || now.getTime() - entry.at.getTime() > WEATHER_MAX_AGE_MS) return null;
  return { ...entry, at: entry.at.toISOString() };
}

// Ostatnia świeża pogoda domu albo null.
export const getWeather = (now = new Date()): Weather | null => getWeatherFor(homeKey, now);

// Temperatura zewnętrzna i jej źródło: czujnik kotła, a bez świeżego pomiaru prognoza Open-Meteo; null = brak obu.
export function getOutdoor(now = new Date()): { temperature: number; source: 'boiler' | 'forecast' } | null {
  if (outdoor && now.getTime() - outdoor.at.getTime() <= OUTDOOR_MAX_AGE_MS) return { temperature: outdoor.value, source: 'boiler' };
  const forecast = getWeather(now);
  return forecast ? { temperature: forecast.temperature, source: 'forecast' } : null;
}

// Ostatni świeży pomiar (czujnik kotła albo prognoza) albo null.
export function getTemperature(now = new Date()): number | null {
  return getOutdoor(now)?.temperature ?? null;
}
