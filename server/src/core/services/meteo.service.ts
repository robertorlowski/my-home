// Temperatura zewnętrzna i pogoda (pasek nad kafelkami, t_out w rekordach hp, ekran sterownika co, GET /temperature).
//
// Temperatura: z czujnika zewnętrznego kotła pelletowego (outside_temp z odczytu sterownika pieca; od 2026-10-04
// zamiast stacji IMGW Zakopane, decyzja użytkownika). Ustawia ją moduł kotła przy każdym odczycie i po starcie
// serwera z ostatniego odczytu w bazie (core nie importuje modułów). Pomiar starszy niż OUTDOOR_MAX_AGE_MS jest
// pomijany; wtedy (i w domu bez kotła) temperatura z prognozy Open-Meteo, jeśli jest świeża (od 2026-10-15).
//
// Pogoda (niebo, opady, wiatr, dzień/noc, temperatura z prognozy) z Open-Meteo: od 2026-11-07 pobiera ją serwer
// (core/services/weather-fetch.service.ts) dla domu i widocznych kafelków pogody, bo na Oracle ma własny adres IP.
// Tylko w pamięci, klucz = id kafelka; odczyt starszy niż WEATHER_MAX_AGE_MS jest pomijany.
// Historia: od 2026-10-15 pobierał ją włącznik z domowego łącza (na Renderze Open-Meteo odrzucało zapytania serwera,
// bo adres IP był wspólny z innymi usługami), a od 2026-10-17 zapasowo także sterownik co. Od 2026-11-07 oba były już
// tylko zapasem, a 2026-11-13 zapas usunięto (decyzja właściciela; co 1.4.0, włącznik 1.4.0): serwer nie podaje
// sterownikom miejsc, a pole weather od starszego firmware pomija.

export const OUTDOOR_MAX_AGE_MS = 15 * 60 * 1000;
export const WEATHER_MAX_AGE_MS = 45 * 60 * 1000;
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
const weatherByKey = new Map<string, WeatherEntry>();
// id kafelka „Dom” (weather-tile.service): pogoda domu = pogoda pod tym id
let homeKey = '';
export function setHomeWeatherKey(id: string) { homeKey = id; }

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Jeden odczyt {temp, code, cloud, precip, rain, snow, wind, day, age_s} pod kluczem; błędny albo starszy od
// zapamiętanego jest pomijany.
function storeWeather(key: string, input: unknown, now: Date) {
  const value = (input ?? {}) as Record<string, unknown>;
  const keys = ['temp', 'code', 'cloud', 'precip', 'rain', 'snow', 'wind', 'day', 'age_s'];
  if (!input || typeof input !== 'object' || !keys.every((key) => isNumber(value[key]))) return;
  const ageS = Math.max(0, value.age_s as number);
  const at = new Date(now.getTime() - ageS * 1000);
  const previous = weatherByKey.get(key);
  if (previous && previous.at > at) return;
  weatherByKey.set(key, {
    temperature: value.temp as number, code: Math.round(value.code as number), cloudCover: value.cloud as number,
    precipitation: value.precip as number, rain: value.rain as number, snowfall: value.snow as number,
    windSpeed: value.wind as number, isDay: value.day !== 0, at,
  });
}

// Odczyty serwera (weather-fetch.service): tablica [{id, temp, code, cloud, precip, rain, snow, wind, day, age_s}].
export function setWeatherReadings(input: unknown, now = new Date()) {
  if (!Array.isArray(input)) return;
  input.forEach((item) => {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id) storeWeather(id, item, now);
  });
}

// Ostatnia świeża pogoda dla klucza (id kafelka) albo null.
export function getWeatherFor(key: string, now = new Date()): Weather | null {
  const entry = key ? weatherByKey.get(key) : undefined;
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
