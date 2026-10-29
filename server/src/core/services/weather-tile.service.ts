// Kafelki pogody (core/models/weather-tile.model.ts): lista z bieżącą pogodą, dodawanie, zmiana, usuwanie,
// miejsca do pobrania przez włącznik (weather_queries w odpowiedzi POST /switch/state) i kafelek „Dom”.
// Pogodę dla każdego miejsca trzyma w pamięci meteo.service (klucz = id kafelka; dom także pod kluczem
// ze starszego włącznika, który pobiera jedno miejsce).
// Konta użytkowników: każde konto ma własne kafelki (ownerId; bez właściciela: „Dom” i kafelki sprzed kont,
// użytkownika systemowego), pole i ukrycie w układzie konta (tile-layout.service.ts). viewer = undefined
// (AUTH_DISABLED=1): wszystkie kafelki i układ wspólny jak przed kontami.
// Kafelek bieżącej lokalizacji (current): bez współrzędnych i bez pogody z włącznika — położenie i pogodę
// pobiera przeglądarka (client core/currentPlace.ts); najwyżej jeden na konto.
// nearHome (2026-10-21): kafelek „Dom” albo kafelek konta do NEAR_HOME_KM od WEATHER_LOCATION — klient pokazuje na nim
// temperaturę z czujnika zewnętrznego kotła, jak na „Domu” (inne konta mają własny kafelek w miejscu domu, a „Dom”
// widzi tylko użytkownik systemowy; bez tego ten sam dom pokazywał 10 °C z modelu przy 6,8 °C z czujnika).
import { Types } from 'mongoose';
import { DeviceModel } from '../models/device.model';
import { WeatherTileDocument, WeatherTileModel } from '../models/weather-tile.model';
import { getWeatherFor, setHomeWeatherKey, switchWeatherStale, WEATHER_LOCATION, Weather } from './meteo.service';
import { appendToViewerOrder, placeForViewer, setViewerHidden, TileViewer, viewersHiding } from './tile-layout.service';

export const MAX_WEATHER_TILES = 8;
// tyle miejsc przyjmuje włącznik (WEATHER_MAX_PLACES w devices/switch/src/weather.hpp)
const MAX_SWITCH_PLACES = 8;
const NAME_MAX = 40;
// promień „przy domu” dla temperatury z czujnika kotła
export const NEAR_HOME_KM = 3;
export const CURRENT_PLACE_NAME = 'Moja lokalizacja';

export type WeatherTileInput = { name?: unknown; lat?: unknown; lon?: unknown; hidden?: unknown; current?: unknown };
export type WeatherTile = {
  id: string; name: string; lat: number | null; lon: number | null; sortOrder?: number; hidden: boolean; home: boolean;
  nearHome: boolean; current: boolean; weather: Weather | null;
};

// odległość po kole wielkim [km]
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isNearHome = (tile: WeatherTileDocument) => !!tile.home || (!tile.current
  && typeof tile.lat === 'number' && typeof tile.lon === 'number'
  && distanceKm({ lat: tile.lat, lon: tile.lon }, WEATHER_LOCATION) <= NEAR_HOME_KM);

const isObjectId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

// Sprawdza pola z aplikacji; przy create wszystkie wymagane, przy update tylko podane. Kafelek bieżącej
// lokalizacji (current: true przy create albo istniejący current przy update) nie przyjmuje współrzędnych,
// a nazwa jest opcjonalna (domyślnie „Moja lokalizacja”).
export function parseWeatherTile(input: WeatherTileInput, partial = false, current = input.current === true) {
  const out: { name?: string; lat?: number; lon?: number; hidden?: boolean; current?: boolean } = {};
  if (input.current !== undefined && (partial || typeof input.current !== 'boolean')) throw new Error('current: tylko przy dodawaniu, true albo false.');
  if (current) {
    if (input.lat !== undefined || input.lon !== undefined) throw new Error('Kafelek bieżącej lokalizacji nie ma współrzędnych.');
    if (input.name === undefined && !partial) input = { ...input, name: CURRENT_PLACE_NAME };
    if (!partial) out.current = true;
    partial = true;
  }
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > NAME_MAX) {
      throw new Error(`name: napis do ${NAME_MAX} znaków.`);
    }
    out.name = input.name.trim();
  }
  if (input.lat !== undefined || !partial) {
    if (typeof input.lat !== 'number' || !Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new Error('lat: liczba od -90 do 90.');
    out.lat = input.lat;
  }
  if (input.lon !== undefined || !partial) {
    if (typeof input.lon !== 'number' || !Number.isFinite(input.lon) || input.lon < -180 || input.lon > 180) throw new Error('lon: liczba od -180 do 180.');
    out.lon = input.lon;
  }
  if (input.hidden !== undefined) {
    if (typeof input.hidden !== 'boolean') throw new Error('hidden: true albo false.');
    out.hidden = input.hidden;
  }
  return out;
}

const toPublic = (tile: WeatherTileDocument): WeatherTile => ({
  id: String(tile._id), name: tile.name, lat: tile.current ? null : tile.lat ?? null, lon: tile.current ? null : tile.lon ?? null,
  sortOrder: tile.sortOrder, hidden: tile.hidden ?? false, home: tile.home ?? false, nearHome: isNearHome(tile), current: tile.current ?? false,
  weather: tile.current ? null : getWeatherFor(String(tile._id)),
});

// Kafelek „Dom” z WEATHER_LOCATION, gdy go nie ma (pierwsze uruchomienie po wdrożeniu); przed sterownikami
// (sortOrder -1). Zapamiętuje jego id w meteo.service, żeby pogoda ze starszego włącznika i GET /temperature
// dotyczyły domu.
export async function ensureHomeWeatherTile(): Promise<WeatherTileDocument> {
  let home = await WeatherTileModel.findOne({ home: true }).lean<WeatherTileDocument>();
  if (!home) {
    home = (await WeatherTileModel.create({ name: 'Dom', ...WEATHER_LOCATION, home: true, sortOrder: -1 })).toObject();
  }
  setHomeWeatherKey(String(home._id));
  return home;
}

// kafelki konta: własne, a u użytkownika systemowego także bez właściciela
const ownedFilter = (viewer: TileViewer) => viewer.isSystem
  ? { $or: [{ ownerId: String(viewer._id) }, { ownerId: null }, { ownerId: { $exists: false } }] }
  : { ownerId: String(viewer._id) };

async function findTile(id: string, viewer?: TileViewer): Promise<WeatherTileDocument> {
  if (!isObjectId(id)) throw new Error('Weather tile not found.');
  const tile = await WeatherTileModel.findOne({ _id: id, ...(viewer ? ownedFilter(viewer) : {}) }).lean<WeatherTileDocument>();
  if (!tile) throw new Error('Weather tile not found.');
  return tile;
}

export async function listWeatherTiles(viewer?: TileViewer): Promise<WeatherTile[]> {
  await ensureHomeWeatherTile();
  const tiles = await WeatherTileModel.find(viewer ? ownedFilter(viewer) : {}).sort({ name: 1 }).lean<WeatherTileDocument[]>();
  const list = viewer ? await placeForViewer(viewer, tiles.map(toPublic)) : tiles.map(toPublic);
  const rank = (tile: WeatherTile) => tile.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return list.sort((a, b) => rank(a) - rank(b));
}

export async function createWeatherTile(input: WeatherTileInput, viewer?: TileViewer): Promise<WeatherTile> {
  const data = parseWeatherTile(input);
  await ensureHomeWeatherTile();
  if (await WeatherTileModel.countDocuments(viewer ? ownedFilter(viewer) : {}) >= MAX_WEATHER_TILES) {
    throw new Error(`Najwyżej ${MAX_WEATHER_TILES} kafelków pogody.`);
  }
  if (data.current && await WeatherTileModel.exists({ current: true, ...(viewer ? { ownerId: String(viewer._id) } : {}) })) {
    throw new Error('Kafelek bieżącej lokalizacji już jest (najwyżej jeden na konto).');
  }
  if (viewer) {
    const tile = (await WeatherTileModel.create({ ...data, hidden: false, ownerId: String(viewer._id) })).toObject();
    forgetWeatherQueries();
    const sortOrder = await appendToViewerOrder(viewer, String(tile._id));
    return { ...toPublic(tile), sortOrder, hidden: false };
  }
  // nowy kafelek w pierwszym wolnym polu za ostatnim zajętym (sterownik albo kafelek pogody)
  const [lastTile, lastDevice] = await Promise.all([
    WeatherTileModel.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean<WeatherTileDocument>(),
    DeviceModel.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean<{ sortOrder?: number }>(),
  ]);
  const tile = await WeatherTileModel.create({ ...data, sortOrder: Math.max(lastTile?.sortOrder ?? -1, lastDevice?.sortOrder ?? -1) + 1 });
  forgetWeatherQueries();
  return toPublic(tile.toObject());
}

// Zmiana kafelka; z kontem ukrycie (hidden) trafia do układu konta, nie do dokumentu.
export async function updateWeatherTile(id: string, input: WeatherTileInput, viewer?: TileViewer): Promise<WeatherTile> {
  const existing = await findTile(id, viewer);
  const data = parseWeatherTile(input, true, existing.current === true);
  if (viewer && data.hidden !== undefined) {
    await setViewerHidden(viewer, id, data.hidden, await listWeatherTiles(viewer));
    delete data.hidden;
  }
  const tile = await WeatherTileModel.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true }).lean<WeatherTileDocument>();
  forgetWeatherQueries();
  if (!tile) throw new Error('Weather tile not found.');
  return viewer ? (await placeForViewer(viewer, [toPublic(tile)]))[0] : toPublic(tile);
}

export async function removeWeatherTile(id: string, viewer?: TileViewer): Promise<void> {
  const tile = await findTile(id, viewer);
  if (tile.home) throw new Error('Kafelka „Dom” nie można usunąć.');
  await WeatherTileModel.deleteOne({ _id: id });
  forgetWeatherQueries();
}

// id kafelków pogody konta (do sprawdzenia układu w PUT /devices/order)
export async function viewerWeatherTileIds(viewer: TileViewer): Promise<string[]> {
  return (await WeatherTileModel.find(ownedFilter(viewer)).select('_id').lean<{ _id: unknown }[]>()).map((tile) => String(tile._id));
}

export const countWeatherTiles = (ids: string[]) => WeatherTileModel.countDocuments({ _id: { $in: ids } });

export async function setWeatherTilesOrder(entries: { id: string; index: number }[]): Promise<void> {
  if (!entries.length) return;
  await WeatherTileModel.bulkWrite(entries.map(({ id, index }) => ({
    updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } },
  })));
}

// Wynik weatherQueries w pamięci (2026-10-29, limit transferu Render): włącznik pyta co 5 s, a pompa przy każdym
// hp/add, a za każdym razem to 3 zapytania do bazy. Kasowany przy dodaniu, zmianie (także ukryciu) i usunięciu
// kafelka; po minucie liczony od nowa na wypadek zmiany inną drogą (np. usunięcie konta z kafelkami).
const WEATHER_QUERIES_TTL_MS = 60_000;
type WeatherQuery = { id: string; lat: number; lon: number };
let weatherQueriesCache: { at: number; queries: WeatherQuery[] } | null = null;
const forgetWeatherQueries = () => { weatherQueriesCache = null; };

// Miejsca, dla których włącznik pobiera pogodę: dom zawsze (GET /temperature), pozostałe tylko widoczne dla
// właściciela (kafelek bez właściciela: ukryty wspólnie albo przez użytkownika systemowego); najwyżej tyle, ile
// przyjmuje włącznik, najstarsze kafelki pierwsze.
export async function weatherQueries(now = Date.now()): Promise<WeatherQuery[]> {
  if (weatherQueriesCache && now - weatherQueriesCache.at < WEATHER_QUERIES_TTL_MS) return weatherQueriesCache.queries;
  const home = await ensureHomeWeatherTile();
  const tiles = await WeatherTileModel.find({ home: { $ne: true }, current: { $ne: true } }).sort({ _id: 1 })
    .select('lat lon hidden ownerId').lean<WeatherTileDocument[]>();
  const hiding = await viewersHiding(tiles.map((tile) => String(tile._id)));
  const hidden = (tile: WeatherTileDocument) => {
    const id = String(tile._id);
    if (tile.ownerId) return hiding.some((viewer) => viewer.id === tile.ownerId && viewer.hidden.has(id));
    const system = hiding.find((viewer) => viewer.isSystem);
    return system ? system.hidden.has(id) : !!tile.hidden;
  };
  const queries = [home, ...tiles.filter((tile) => !hidden(tile))].slice(0, MAX_SWITCH_PLACES)
    .map((tile) => ({ id: String(tile._id), lat: tile.lat as number, lon: tile.lon as number }));
  weatherQueriesCache = { at: now, queries };
  return queries;
}

// Miejsca dla zapasowego pobierania przez sterownik co (odpowiedź POST /hp/add, co od 1.3.1): te same co dla
// włącznika, ale tylko bez świeżej pogody od włącznika (meteo.service, switchWeatherStale); pusta lista = włącznik działa.
export async function backupWeatherQueries(now = new Date()): Promise<{ id: string; lat: number; lon: number }[]> {
  return (await weatherQueries()).filter((query) => switchWeatherStale(query.id, now));
}
