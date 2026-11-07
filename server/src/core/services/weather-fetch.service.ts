// Pogoda z Open-Meteo pobierana przez serwer (od 2026-11-07). Na Renderze serwer dzielił adres IP z innymi usługami
// i Open-Meteo odrzucało zapytania (limit na adres), dlatego od 2026-10-15 pobierały ją sterowniki z domowego łącza.
// Na Oracle (vm-prod) serwer ma własny adres 158.101.211.105, więc pobiera sam: jedno zapytanie na wszystkie miejsca
// z weatherQueries (dom i widoczne kafelki), co FETCH_INTERVAL_MS, po błędzie po RETRY_MS, a od razu po zmianie listy
// miejsc. Odczyty trafiają do meteo.service jako źródło 'server'. Włącznik i co pobierają już tylko zapasowo, gdy
// serwer nie ma świeżej pogody dla miejsca od WEATHER_BACKUP_AFTER_MS (meteo.service, weatherStale).
import { setServerWeatherActive, setWeatherFromController } from './meteo.service';
import { weatherQueries } from './weather-tile.service';

export const FETCH_INTERVAL_MS = 15 * 60 * 1000;
export const RETRY_MS = 5 * 60 * 1000;
const CHECK_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;
const FIELDS = 'temperature_2m,weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,is_day';

type Place = { id: string; lat: number; lon: number };
type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// To samo zapytanie co w firmware (devices/common/weather/src/weather.hpp, openMeteoUrl): model DWD ICON, czas
// Warszawy; kilka miejsc po przecinku w jednym zapytaniu (odpowiedź jest wtedy tablicą).
export function openMeteoUrl(places: Place[]): string {
  const coords = (key: 'lat' | 'lon') => places.map((place) => place[key].toFixed(4)).join(',');
  return `https://api.open-meteo.com/v1/forecast?latitude=${coords('lat')}&longitude=${coords('lon')}`
    + `&current=${FIELDS}&timezone=Europe%2FWarsaw&models=icon_seamless`;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Odczyt w formacie sterowników ({temp, code, cloud, precip, rain, snow, wind, day, age_s}) albo null przy braku pola.
function toReading(item: unknown) {
  const current = (item as { current?: Record<string, unknown> } | null)?.current;
  if (!current || !FIELDS.split(',').every((key) => isNumber(current[key]))) return null;
  return {
    temp: current.temperature_2m, code: current.weather_code, cloud: current.cloud_cover, precip: current.precipitation,
    rain: current.rain, snow: current.snowfall, wind: current.wind_speed_10m, day: current.is_day, age_s: 0,
  };
}

// Odpowiedź Open-Meteo dla miejsc w tej samej kolejności: obiekt (jedno miejsce) albo tablica.
export function parseOpenMeteo(body: unknown, places: Place[]) {
  const items = Array.isArray(body) ? body : [body];
  if (items.length !== places.length) return [];
  return places.flatMap((place, index) => {
    const reading = toReading(items[index]);
    return reading ? [{ id: place.id, ...reading }] : [];
  });
}

// Jedno pobranie dla wszystkich miejsc; true = odczyt dla każdego miejsca.
export async function fetchServerWeather(places: Place[], now = new Date(), fetcher: Fetcher = fetch): Promise<boolean> {
  if (!places.length) return true;
  const response = await fetcher(openMeteoUrl(places), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const readings = parseOpenMeteo(await response.json(), places);
  setWeatherFromController(readings, now, 'server');
  return readings.length === places.length;
}

let timer: NodeJS.Timeout | null = null;
let lastKey = '';
let lastOkAt = 0;
let lastAttemptAt = 0;
let failing = false;

// Co CHECK_MS: pobranie, gdy zmieniła się lista miejsc, minął FETCH_INTERVAL_MS od udanego albo RETRY_MS od nieudanego.
async function check() {
  const now = Date.now();
  try {
    const places = await weatherQueries(now);
    const key = JSON.stringify(places);
    const due = key !== lastKey || now - lastOkAt >= FETCH_INTERVAL_MS;
    if (!due || (failing && key === lastKey && now - lastAttemptAt < RETRY_MS)) return;
    lastKey = key;
    lastAttemptAt = now;
    if (!(await fetchServerWeather(places, new Date(now)))) throw new Error('Open-Meteo: odpowiedź bez części miejsc');
    lastOkAt = now;
    if (failing) console.log('[weather] pobieranie z serwera znowu działa');
    failing = false;
  } catch (error) {
    if (!failing) console.error('[weather] pobieranie z serwera nie działa, ponowienie co 5 min:', String(error));
    failing = true;
  }
}

// Start przy uruchomieniu serwera (server.ts); od tej chwili sterowniki dostają miejsca tylko zapasowo.
export function startServerWeather() {
  if (timer) return;
  setServerWeatherActive(true);
  void check();
  timer = setInterval(() => void check(), CHECK_MS);
  timer.unref();
}
