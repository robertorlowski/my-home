// Strona /devices w wyglądzie „Instrument” (2026-10-17, makiety/src/makieta.html, ekran #s-lista): pasek pogody domu
// (.outdoor-strip), w trybie „Zmień układ” pasek .layout-bar, szachownica kafelków .tiles (sterowniki z GET /api/devices
// i /devices/summary, kafelki pogody z /weather-tiles) i stopka .statusbar z zajętością bazy (GET /api/devices/db-stats).
// Kafelek ma stały układ z makiety (core/components/DeviceTileCard; projektant kafelka usunięty 2026-10-27).
// Każdy kafelek ma numer pola (sortOrder); kolumn tyle, ile mieści szerokość (kafelek co najmniej 300 px, 1–4), puste
// pola na komputerze zostają puste, na telefonie (jedna kolumna) kafelki idą po kolei. Wybór sterownika kliknięciem
// kafelka, ołówek w nagłówku (po najechaniu): popup „Dane sterownika” albo „Kafelek pogody”, trybik: firmware rodzaju.
// Ikona siatki w górnym pasku włącza „Zmień układ”: „Przenieś” i wybór pola (zamiana, gdy zajęte), puste pola
// „+ kafelek pogody” (nowy kafelek w tym miejscu), oko (ukrycie kafelka: PUT /devices/:rootId {hidden} albo
// PUT /weather-tiles/:id, od razu); „Gotowe” zapisuje układ (PUT /api/devices/order z null w pustych polach). Ukryte
// kafelki widać tylko w tym trybie (wyszarzone, chip „Ukryty”). Kafelek „Dom” pokazuje temperaturę z czujnika kotła
// (GET /temperature), gdy jest świeża. Nie ma sterownika domyślnego ani automatycznego wyboru: lista jest zawsze
// ekranem startowym (DeviceGuard przekierowuje tu, gdy nie wybrano sterownika).
// Konta użytkowników: każde konto ma własny układ szachownicy, ukryte kafelki i kafelki pogody (zapis w koncie);
// ołówek tylko przy własnych sterownikach (udostępnione: zakładki w podpowiedzi), trybik firmware i zajętość bazy tylko
// dla użytkownika systemowego.
// Kafelek prosty (2026-10-20): sterownik z device.simple (przełącznik w oknie „Dane sterownika” albo udostępnienie
// „Panel prosty”) rysuje SimpleTile rodzaju z rejestru (włącznik: duże przyciski Włącz / Wyłącz) zamiast DeviceTileCard;
// taki kafelek nie jest odnośnikiem — pełne widoki otwiera jego nazwa (nie u osoby z samym „Panelem prostym”).
// Kafelki odświeżają się jak ekran główny pompy: po komunikacie WebSocket „update” któregokolwiek sterownika (jedno
// połączenie ?rootIds=…, najwyżej raz na TILES_UPDATE_MIN_MS) i co TILES_REFRESH_MS, gdy żaden nic nie wysyła.
import { CSSProperties, KeyboardEvent, MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { DeviceRequests, WeatherTileRequests } from '../../api';
import { wsAddressServer } from '../../http';
import { canEditDevice, DatabaseStats, Device, DeviceTiles, OutdoorConditions, WeatherTile } from '../../types';
import { getDeviceTypeView } from '../../device-types';
import { DeviceEditModal } from '../../components/DeviceEditModal';
import { ageLabel, DeviceTileCard, ListIcon, SourceTip, TILE_KINDS, WeatherTileCard } from '../../components/DeviceTileCard';
import { viewLabel } from '../../components/Header';
import { precipitationText, WeatherCodeIcon, weatherDescription } from '../../components/WeatherIcon';
import { WeatherTileModal } from '../../components/WeatherTileModal';
import { useDevice } from '../../context/DeviceContext';
import { useAuth } from '../../context/AuthContext';
import { t as tr, useLang } from '../../i18n';
import './style.css';

const MB = 1024 * 1024;
const megabytes = (bytes: number, locale: string) => (bytes / MB).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
// próg ostrzeżenia o zapełnieniu bazy (żółty tekst)
const DATABASE_WARNING_PERCENT = 80;

// Zajętość bazy (dane + indeksy) względem limitu planu Atlas M0 jako procent („Baza danych 44 %”, .db-usage z makiety),
// szczegóły w podpowiedzi po najechaniu; „nie odpowiada”, gdy serwer nie ma połączenia.
function DatabaseUsage() {
  const { t, locale } = useLang();
  const [stats, setStats] = useState<DatabaseStats | null | undefined>(undefined);
  useEffect(() => { DeviceRequests.getDatabaseStats().then(setStats); }, []);
  if (stats === undefined) return <span className="db-usage">{t('devices.db')}: …</span>;
  if (!stats?.ok) return <span className="db-usage db-usage-error"><i className="dot" />{t('devices.dbDown')}</span>;
  const percent = Math.round((stats.usedBytes / stats.limitBytes) * 100);
  const mb = (bytes: number) => megabytes(bytes, locale);
  return (
    <span className={`db-usage${percent >= DATABASE_WARNING_PERCENT ? ' db-usage-warning' : ''}`}
      title={t('devices.dbDetail', { used: mb(stats.usedBytes), limit: mb(stats.limitBytes), free: mb(Math.max(stats.limitBytes - stats.usedBytes, 0)), data: mb(stats.dataBytes), index: mb(stats.indexBytes), collections: stats.collections, documents: stats.documents.toLocaleString(locale), ping: stats.pingMs })}>
      <i className={`dot${percent >= DATABASE_WARNING_PERCENT ? '' : ' dot-ok'}`} aria-hidden="true" />
      {t('devices.db')} {percent} %
    </span>
  );
}

// Kafelek ma zawsze nazwę (bez numeru seryjnego): gdy użytkownik jej nie nadał, nazwę rodzaju (słownik
// tile.defaultName.<rodzaj>), a przy kilku takich samych sterownikach bez nazwy dopisuje końcówkę numeru, żeby dało
// się je odróżnić.

// Ostatni stan listy w localStorage (sterowniki, dane kafelków, kafelki pogody, temperatura): po otwarciu lista
// rysuje się od razu w znanym układzie i rozmiarze, a dane z serwera (ok. 2 s) podmieniają go w tle. Wiek danych
// w stopkach liczy się z czasu odczytu, więc stare dane nie udają świeżych.
// klucze osobno dla konta: po przelogowaniu nie widać przez chwilę cudzych kafelków
const cacheKeys = (userId = '') => ({
  devices: `chpc.devices.${userId}`, tiles: `chpc.deviceTiles.${userId}`, weather: `chpc.weatherTiles.${userId}`, outdoor: 'chpc.outdoor',
});
function readCache<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* bez pamięci podręcznej */ }
}

export function tileName(device: Device, all: Device[]): string {
  const name = device.name?.trim();
  if (name) return name;
  const key = `tile.defaultName.${device.deviceType}`;
  const translated = tr(key);
  const base = translated !== key ? translated : device.deviceType;
  const same = all.filter((item) => !item.name?.trim() && item.deviceType === device.deviceType);
  return same.length > 1 ? `${base} …${device.deviceId.slice(-4)}` : base;
}

// miejsce w górnym pasku (App.tsx), do którego strona wstawia ikonę siatki „Zmień układ”
export const DEVICES_HEADER_ACTIONS_ID = 'devices-header-actions';

// liczba kafelków z poprzedniej wizyty: tyle duszków pokazuje strona, zanim przyjdzie lista (localStorage może
// być niedostępny, więc każdy odczyt i zapis jest w try/catch)
const DEVICE_COUNT_KEY = 'chpc.deviceCount';
const rememberedDeviceCount = (): number => {
  try {
    const count = Number(localStorage.getItem(DEVICE_COUNT_KEY));
    return Number.isInteger(count) && count > 0 && count <= 12 ? count : 3;
  } catch {
    return 3;
  }
};
const rememberDeviceCount = (count: number) => {
  try { localStorage.setItem(DEVICE_COUNT_KEY, String(count)); } catch { /* bez zapamiętania */ }
};

// Podpowiedź na kafelku udostępnionego sterownika: właściciel i zakładki z dostępem.
function sharedInfo(device: Device): string | undefined {
  if (device.access !== 'shared') return undefined;
  const view = getDeviceTypeView(device.deviceType);
  const tabs = (device.tabs ?? []).map((path) => path === '/' ? tr('view.overview') : path === SIMPLE_TAB ? tr('view.simple') : view.views.find((entry) => entry.path === path) ? viewLabel(path, device.deviceType, tr) : path);
  const owner = device.owner?.name || device.owner?.email;
  return `${owner ? `${tr('devices.sharedBy', { owner })} ` : ''}${tr('app.sharedAccess')}: ${tabs.join(', ')}`;
}

// udostępnienie „Panel prosty” (server access.service SIMPLE_TAB): sam kafelek prosty, bez widoków sterownika
const SIMPLE_TAB = 'simple';
// osoba z samym „Panelem prostym” nie otwiera widoków sterownika (nazwa kafelka nie jest odnośnikiem)
const canOpenViews = (device: Device) => device.access !== 'shared' || (device.tabs ?? []).some((tab) => tab !== SIMPLE_TAB);

// odświeżanie stanu kafelków i wieku danych w stopce kafelka
const TILES_REFRESH_MS = 30 * 1000;
// po „update” z WebSocket: kafelki najwyżej raz na tyle (pompa wysyła co 10–30 s, włącznik przy każdej zmianie)
const TILES_UPDATE_MIN_MS = 5 * 1000;

// kafelek na szachownicy: sterownik albo kafelek pogody; pole = sortOrder
type ListItem = { kind: 'device'; id: string; device: Device } | { kind: 'weather'; id: string; weather: WeatherTile };
const rank = (item: ListItem) => (item.kind === 'device' ? item.device.sortOrder : item.weather.sortOrder);
const isHidden = (item: ListItem) => item.kind === 'device' ? !!item.device.hidden : item.weather.hidden;
const itemLabel = (item: ListItem, devices: Device[]) => item.kind === 'device' ? tileName(item.device, devices) : item.weather.name;

// Pola szachownicy z sortOrder: kafelek z numerem pola dostaje je, gdy wolne; bez numeru (nowy sterownik), z ujemnym
// (kafelek „Dom” przed sterownikami) albo przy zajętym polu dostaje pierwsze wolne. Wynik: tablica pól (id albo null).
function assignSlots(items: ListItem[]): (string | null)[] {
  const cells: (string | null)[] = [];
  const sorted = [...items].sort((a, b) => (rank(a) ?? Number.MAX_SAFE_INTEGER) - (rank(b) ?? Number.MAX_SAFE_INTEGER));
  const firstFree = () => { let i = 0; while (cells[i]) i += 1; return i; };
  sorted.forEach((item) => {
    const wanted = rank(item);
    const slot = wanted !== undefined && wanted >= 0 && !cells[wanted] ? wanted : firstFree();
    cells[slot] = item.id;
  });
  for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = null;
  return cells;
}

// szachownica: kolumn tyle, ile kafelków o szerokości co najmniej TILE_MIN_WIDTH z odstępem GAP się mieści (1–4),
// jak siatka auto-fill 300 px w makiecie (.tiles); GAP = --gap z theme.css
const MAX_COLUMNS = 4;
const TILE_MIN_WIDTH = 300;
const GAP = 12;

// Sterowniki rejestrują się same (POST /api/devices/register), więc tu można je tylko wybrać i nazwać.
export const Devices: React.FC = () => {
  const navigate = useNavigate();
  const { clearDevice, selectDevice } = useDevice();
  const { user } = useAuth();
  const { t, locale } = useLang();
  const isSystem = !!user?.isSystem;
  const CACHE_KEYS = cacheKeys(user?.id);
  const [devices, setDevices] = useState<Device[]>(() => readCache(CACHE_KEYS.devices, []));
  const [weatherTiles, setWeatherTiles] = useState<WeatherTile[]>(() => readCache(CACHE_KEYS.weather, []));
  // pola szachownicy w trybie „Zmień układ” (id albo null), do zapisu przy „Gotowe”
  const [cells, setCells] = useState<(string | null)[] | null>(null);
  // kafelek wybrany „Przenieś”: następne kliknięcie pola go tam stawia (zamiana, gdy zajęte)
  const [moving, setMoving] = useState<string | null>(null);
  // „+ kafelek pogody” w pustym polu: nowy kafelek pogody trafi do tego pola
  const [addAt, setAddAt] = useState<number | null>(null);
  // liczba kolumn z szerokości listy
  const listRef = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(MAX_COLUMNS);
  // popup „Kafelek pogody”: null = nowy, undefined = zamknięty
  const [editingWeather, setEditingWeather] = useState<WeatherTile | null | undefined>(undefined);
  const [tiles, setTiles] = useState<DeviceTiles>(() => readCache(CACHE_KEYS.tiles, {}));
  // do czasu pierwszej odpowiedzi kafelki pokazują duszki
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [tilesLoaded, setTilesLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Device | null>(null);
  // tryb „Zmień układ”: kafelki dostają przyciski, wybór sterownika jest wyłączony; układ
  // zapisuje dopiero „Gotowe”, „Anuluj” przywraca listę z serwera
  const [reordering, setReordering] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  // temperatura z czujnika kotła i pogoda z Open-Meteo (GET /temperature), odświeżane razem z kafelkami;
  // undefined = wczytywanie
  const [outdoor, setOutdoor] = useState<OutdoorConditions | null | undefined>(() => readCache<OutdoorConditions | undefined>(CACHE_KEYS.outdoor, undefined));

  const loadDevices = () => {
    DeviceRequests.getDevices()
      .then((list) => {
        if (list) {
          setDevices(list);
          writeCache(CACHE_KEYS.devices, list);
          rememberDeviceCount(list.length);
        } else {
          setError(t('devices.loadFailed'));
        }
      })
      .catch(() => setError(t('devices.loadFailed')))
      .finally(() => setDevicesLoaded(true));
  };

  const loadTiles = () => {
    DeviceRequests.getDeviceTiles().then((result) => {
      if (result) { setTiles(result); writeCache(CACHE_KEYS.tiles, result); }
      setTilesLoaded(true);
      setNow(Date.now());
    });
    DeviceRequests.getOutdoorConditions().then((result) => { setOutdoor(result); if (result) writeCache(CACHE_KEYS.outdoor, result); });
    WeatherTileRequests.list().then((result) => { if (result) { setWeatherTiles(result); writeCache(CACHE_KEYS.weather, result); } });
  };

  // wejście na listę kasuje bieżący wybór (także w localStorage): menu znika, a powrót
  // do widoków jest możliwy tylko przez wybór kafelka
  useEffect(() => {
    clearDevice();
    setHeaderSlot(document.getElementById(DEVICES_HEADER_ACTIONS_ID));
    loadDevices();
    loadTiles();
    const timer = window.setInterval(loadTiles, TILES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // „update” któregokolwiek sterownika: kafelki od nowa (z ograniczeniem częstości); połączenie od nowa przy zmianie listy
  const rootIdsKey = devices.map((device) => device.rootId).sort().join(',');
  const lastTilesLoad = useRef(0);
  const pendingTilesLoad = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!rootIdsKey) return undefined;
    const reload = () => {
      pendingTilesLoad.current = undefined;
      lastTilesLoad.current = Date.now();
      loadTiles();
    };
    const wsUrl = new URL(wsAddressServer());
    wsUrl.searchParams.set('rootIds', rootIdsKey);
    const ws = new WebSocket(wsUrl.toString());
    ws.onmessage = (event) => {
      try {
        if ((JSON.parse(event.data) as { type?: string }).type !== 'update' || pendingTilesLoad.current !== undefined) return;
        const wait = Math.max(0, lastTilesLoad.current + TILES_UPDATE_MIN_MS - Date.now());
        pendingTilesLoad.current = window.setTimeout(reload, wait);
      } catch { /* inne komunikaty */ }
    };
    return () => {
      ws.close();
      window.clearTimeout(pendingTilesLoad.current);
      pendingTilesLoad.current = undefined;
    };
  }, [rootIdsKey]);

  const chooseDevice = (device: Device) => {
    selectDevice(device);
    navigate('/');
  };

  // liczba kolumn z szerokości listy
  useEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setColumns(Math.max(1, Math.min(MAX_COLUMNS, Math.floor((entry.contentRect.width + GAP) / (TILE_MIN_WIDTH + GAP)))));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // wszystkie kafelki i ich pola; w trybie edycji według lokalnego układu
  const allItems: ListItem[] = [
    ...devices.map((device): ListItem => ({ kind: 'device', id: device.rootId, device })),
    ...weatherTiles.map((weather): ListItem => ({ kind: 'weather', id: weather.id, weather })),
  ];
  const byId = new Map(allItems.map((item) => [item.id, item]));
  const layout = cells ?? assignSlots(allItems);
  // poza trybem edycji ukryte kafelki znikają (pole zostaje puste)
  const visibleLayout = reordering ? layout : layout.map((id) => id && byId.get(id) && !isHidden(byId.get(id)!) ? id : null);
  // telefon (jedna kolumna): bez pustych pól; komputer w trybie edycji: cały prostokąt pól plus jeden wolny wiersz
  const occupied = visibleLayout.map((id, index) => ({ id, index })).filter(({ id }) => id && byId.has(id));
  const lastSlot = occupied.length ? occupied[occupied.length - 1].index : -1;
  const rows = Math.ceil((lastSlot + 1) / columns) + (reordering ? 1 : 0);
  const cellIndexes = columns === 1
    ? [...occupied.map(({ index }) => index), ...(reordering ? [lastSlot + 1] : [])]
    : Array.from({ length: rows * columns }, (_, index) => index);
  // Pusty wiersz w układzie dzieli listę (decyzja użytkownika 2026-10-16): kafelki pod pierwszym pustym wierszem
  // stoją przy dole ekranu (odstęp między częściami wypełnia wolne miejsce). W trybie edycji pusty wiersz widać
  // jako puste pola. Na telefonie (jedna kolumna) pustym wierszem jest puste pole między kafelkami.
  const rowOf = (slot: number) => columns === 1 ? slot : Math.floor(slot / columns);
  const emptyRow = (() => {
    if (reordering) return -1;
    for (let row = 0; row < rowOf(lastSlot); row += 1) {
      const start = columns === 1 ? row : row * columns;
      const end = columns === 1 ? row + 1 : start + columns;
      if (visibleLayout.slice(start, end).every((id) => !id || !byId.has(id))) return row;
    }
    return -1;
  })();
  const topCells = emptyRow < 0 ? cellIndexes : cellIndexes.filter((slot) => rowOf(slot) < emptyRow);
  const bottomCells = emptyRow < 0 ? [] : cellIndexes.filter((slot) => rowOf(slot) > emptyRow);
  // odstęp między częściami: tyle, żeby dolna część kończyła się nad stałą stopką (mierzone po każdej zmianie
  // układu i okna)
  const bottomRef = useRef<HTMLElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const [spacer, setSpacer] = useState(0);
  // dolny margines listy: nad stałą stopką taki sam odstęp jak między kafelkami (decyzja użytkownika 2026-10-16);
  // gdy dolna część mieści się na ekranie, odstęp ustawia spacer, a margines znika (strona się nie przewija)
  const [bottomPad, setBottomPad] = useState(0);
  const [bottomFits, setBottomFits] = useState(false);
  const layoutKey = `${visibleLayout.join(',')}|${columns}|${emptyRow}`;
  useLayoutEffect(() => {
    const measure = () => {
      const footer = document.querySelector<HTMLElement>('.devices-footer');
      const footerHeight = footer?.offsetHeight ?? 0;
      setBottomPad(footerHeight + GAP);
      const bottom = bottomRef.current;
      const spacerElement = spacerRef.current;
      if (!bottom || !spacerElement) { setSpacer(0); setBottomFits(false); return; }
      const limit = window.innerHeight - footerHeight - GAP;
      // bez zerowania odstępu w DOM (React nie przywróciłby go przy tej samej wartości): bieżący odstęp się dolicza
      const free = limit - bottom.getBoundingClientRect().bottom + spacerElement.getBoundingClientRect().height;
      // co najmniej zwykły odstęp między kafelkami: na telefonie i przy długiej liście dolna część nie przykleja się do górnej
      setSpacer(Math.max(GAP, Math.round(free)));
      setBottomFits(free >= GAP);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [layoutKey, tilesLoaded, devicesLoaded]);

  const startReordering = () => {
    setCells(assignSlots(allItems));
    setMoving(null);
    setReordering(true);
  };

  // „Przenieś” → kliknięcie pola: postawienie w pustym polu albo zamiana z kafelkiem, który tam stoi
  const placeAt = (slot: number) => {
    if (!moving) return;
    setCells((current) => {
      const next = [...(current ?? layout)];
      while (next.length <= slot) next.push(null);
      const from = next.indexOf(moving);
      const other = next[slot];
      next[slot] = moving;
      if (from >= 0) next[from] = other;
      return next;
    });
    setMoving(null);
  };

  const saveOrder = async () => {
    setSavingOrder(true);
    try {
      const trimmed = [...layout];
      while (trimmed.length && trimmed[trimmed.length - 1] === null) trimmed.pop();
      const sorted = await DeviceRequests.setDevicesOrder(trimmed);
      if (!sorted) throw new Error('order');
      setDevices(sorted);
      const refreshed = await WeatherTileRequests.list();
      if (refreshed) setWeatherTiles(refreshed);
      setReordering(false);
      setCells(null);
      setMoving(null);
      setError('');
    } catch {
      setError(t('devices.orderFailed'));
    } finally {
      setSavingOrder(false);
    }
  };

  const cancelOrder = () => {
    setReordering(false);
    setCells(null);
    setMoving(null);
    setError('');
    loadDevices();
  };

  // ukrycie / pokazanie od razu (nie czeka na „Gotowe”)
  const toggleHidden = async (item: ListItem) => {
    try {
      if (item.kind === 'device') {
        const updated = await DeviceRequests.setDeviceHidden(item.id, !item.device.hidden);
        setDevices((list) => list.map((device) => device.rootId === item.id ? { ...device, hidden: updated.hidden } : device));
      } else {
        const updated = await WeatherTileRequests.update(item.id, { hidden: !item.weather.hidden });
        setWeatherTiles((list) => list.map((tile) => tile.id === item.id ? updated : tile));
      }
    } catch {
      setError(t('devices.hideFailed'));
    }
  };

  // nowy kafelek pogody: do wybranego pola („+ kafelek pogody”) albo pierwszego wolnego za ostatnim; w trybie edycji
  // w lokalnym układzie
  const weatherSaved = (tile: WeatherTile) => {
    const isNew = !weatherTiles.some((item) => item.id === tile.id);
    setWeatherTiles((list) => isNew ? [...list, tile] : list.map((item) => item.id === tile.id ? tile : item));
    if (isNew && cells) {
      setCells((current) => {
        const next = [...(current ?? [])];
        const slot = addAt ?? next.length;
        while (next.length <= slot) next.push(null);
        if (next[slot]) next.push(tile.id); else next[slot] = tile.id;
        return next;
      });
    }
    setAddAt(null);
    setEditingWeather(undefined);
  };

  const weatherRemoved = (id: string) => {
    setWeatherTiles((list) => list.filter((item) => item.id !== id));
    setCells((current) => current ? current.map((cell) => cell === id ? null : cell) : current);
    setEditingWeather(undefined);
  };

  const saved = (updated: Device) => {
    setDevices((list) => list.map((device) => device.rootId === updated.rootId ? updated : device));
    setEditing(null);
  };

  // przycisk w kafelku nie wybiera sterownika (kafelek jest odnośnikiem)
  const stop = (event: MouseEvent) => event.stopPropagation();

  // pasek pogody domu: ikona nieba (od 2026-10-18) i opis z Open-Meteo, wiatr, źródło tekstem; temperatura z czujnika
  // zewnętrznego kotła, gdy serwer ma jego świeży odczyt (GET /temperature, temperatureSource = boiler, do 15 min), inaczej
  // z Open-Meteo (od 2026-10-20: model z siatką ok. 2 km nie widzi inwersji w dolinie, różnica do ±3 °C; 17–19.10 pasek
  // pokazywał tylko Open-Meteo)
  const outdoorStrip = (() => {
    const weather = outdoor?.weather;
    const fromBoiler = outdoor?.temperatureSource === 'boiler' && typeof outdoor.temperature === 'number';
    const value = fromBoiler ? outdoor!.temperature as number : weather?.temperature;
    const temperature = outdoor === undefined ? '…' : typeof value === 'number'
      ? `${value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C` : '--- °C';
    const desc = weather
      ? [weatherDescription(weather.code), precipitationText(weather), `${t('weather.windLower')} ${Math.round(weather.windSpeed)} km/h`].join(' · ')
      : outdoor === undefined ? '' : t('weather.noneFromSwitch');
    const source = weather ? `Open-Meteo · ${t('weather.ago', { age: ageLabel(now - new Date(weather.at).getTime()) })}` : '';
    const title = fromBoiler
      ? t('devices.outdoorBoiler', { model: weather ? ` (Open-Meteo: ${weather.temperature.toLocaleString(locale, { maximumFractionDigits: 1 })} °C)` : '' })
      : t('devices.outdoorMeteo');
    return (
      <div className="outdoor-strip" title={title}>
        {weather && <span className="outdoor-icon"><WeatherCodeIcon code={weather.code} isDay={weather.isDay} size={24} /></span>}
        <span className="outdoor-temp">{temperature}</span>
        <span className="outdoor-desc">{desc}</span>
        {source && <span className="outdoor-src"><SourceTip text={source} detail={t('weather.switchDetail')} /></span>}
      </div>
    );
  })();

  const gridStyle = { '--cols': columns } as CSSProperties;

  // pola dolnej części są numerowane od jej pierwszego wiersza (grid-row liczony od 1)
  const renderCell = (slot: number, rowOffset: number) => {
    const id = visibleLayout[slot];
    const item = id ? byId.get(id) : undefined;
    const position = columns === 1 ? undefined : { gridColumn: slot % columns + 1, gridRow: Math.floor(slot / columns) + 1 - rowOffset };
    if (!item) {
      if (!reordering) return null;
      return (
        <article key={`empty-${slot}`} className="tile tile-empty" aria-label={t('devices.emptySlot')} style={position}>
          {moving ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => placeAt(slot)}>{t('devices.placeHere')}</button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" title={t('devices.addWeatherHere')}
              onClick={() => { setAddAt(slot); setEditingWeather(null); }}>{t('devices.addWeather')}</button>
          )}
        </article>
      );
    }
    const label = itemLabel(item, devices);
    const hidden = isHidden(item);
    const tile = item.kind === 'device' ? tiles[item.device.rootId] : undefined;
    const kind = item.kind === 'device' ? TILE_KINDS[item.device.deviceType] : 'weather';
    // kafelek prosty (poza trybem „Zmień układ” i poza ukrytymi): przyciski w kafelku, nazwa otwiera widoki
    const SimpleTile = item.kind === 'device' && item.device.simple && !reordering && !hidden
      ? getDeviceTypeView(item.device.deviceType).SimpleTile : undefined;
    // kafelek pogody prowadzi do strony pogody (/weather/:id), sterownika — do jego widoków
    const link = !reordering && !SimpleTile && (item.kind === 'weather' || canOpenViews(item.device));
    const canEdit = item.kind === 'weather' ? !user?.isDemo : canEditDevice(item.device);
    const tools = (
      <>
        {canEdit && (
          <button type="button" className="icon-btn sm" onClick={(event) => { stop(event); item.kind === 'device' ? setEditing(item.device) : setEditingWeather(item.weather); }}
            title={item.kind === 'device' ? t('deviceEdit.title') : t('devices.editWeather')}
            aria-label={`${item.kind === 'device' ? t('deviceEdit.title') : t('devices.editWeather')} ${label}`}>
            <ListIcon name="edit" />
          </button>
        )}
        {isSystem && item.kind === 'device' && getDeviceTypeView(item.device.deviceType).firmwareUpdates && (
          <button type="button" className="icon-btn sm" title={t('devices.firmwareOfType')} aria-label={`${t('devices.firmwareOfType')} ${label}`}
            onClick={(event) => { stop(event); navigate(`/firmware/${encodeURIComponent(item.device.deviceType)}`); }}>
            <ListIcon name="chip" />
          </button>
        )}
      </>
    );
    const classes = ['tile', item.kind === 'device' ? 'tile-device' : 'tile-weather'];
    if (link) classes.push('is-link');
    if (SimpleTile) classes.push('tile-simple');
    if (tile?.running && !hidden) classes.push('is-running');
    if (hidden) classes.push('is-hidden');
    if (moving === item.id) classes.push('is-moving');
    const open = () => {
      if (item.kind === 'device') chooseDevice(item.device);
      else navigate(`/weather/${encodeURIComponent(item.id)}`, { state: { tile: item.weather } });
    };
    const onKey = (event: KeyboardEvent) => {
      if (link && (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); open(); }
    };
    return (
      <article key={item.id} className={classes.join(' ')} data-kind={kind} style={position}
        role={link ? 'link' : undefined} tabIndex={link ? 0 : undefined}
        aria-label={link ? t('devices.openTile', { label }) : `${label}${hidden ? ` (${t('tile.hiddenLower')})` : ''}`}
        onClick={link ? open : undefined} onKeyDown={link ? onKey : undefined}
        title={item.kind === 'device' ? sharedInfo(item.device) : item.weather.lat === null || item.weather.lon === null
          ? t('devices.currentWeatherTitle')
          : `${item.weather.lat.toFixed(4)} N, ${item.weather.lon.toFixed(4)} E · ${t('devices.forecastOpenMeteo')}`}>
        {item.kind === 'device' ? (
          SimpleTile ? (
            <SimpleTile device={item.device} name={label} tile={tile} now={now} loading={!tilesLoaded} tools={tools}
              onOpen={canOpenViews(item.device) ? () => chooseDevice(item.device) : undefined} onChanged={loadTiles} />
          ) : (
            <DeviceTileCard deviceType={item.device.deviceType} name={label} tile={tile} now={now} loading={!tilesLoaded} hidden={hidden} tools={tools} />
          )
        ) : (
          <WeatherTileCard tile={item.weather} now={now} hidden={hidden} tools={tools}
            sensor={(item.weather.home || item.weather.nearHome) && outdoor?.temperatureSource === 'boiler' ? outdoor.temperature : null} />
        )}
        {reordering && (
          <>
            {/* kafelek, do którego ma trafić przenoszony: zamiana miejsc */}
            {moving && moving !== item.id && (
              <button type="button" className="tile-swap btn btn-primary btn-sm" onClick={() => placeAt(slot)}>{t('devices.swap')}</button>
            )}
            <div className="tile-layout">
              <button type="button" className={`icon-btn sm${moving === item.id ? ' is-active' : ''}`}
                title={moving === item.id ? t('devices.cancelMove') : t('devices.move')} aria-pressed={moving === item.id}
                aria-label={`${t('devices.move')} ${label}`} onClick={() => setMoving(moving === item.id ? null : item.id)}>
                <ListIcon name="move" />
              </button>
              <button type="button" className={`icon-btn sm${hidden ? ' is-active' : ''}`} title={hidden ? t('devices.showTile') : t('devices.hideTile')}
                aria-label={`${hidden ? t('devices.showTile') : t('devices.hideTile')} ${label}`} aria-pressed={hidden} onClick={() => toggleHidden(item)}>
                <ListIcon name={hidden ? 'eye-off' : 'eye'} />
              </button>
            </div>
          </>
        )}
      </article>
    );
  };

  return (
    <>
      <main className={`page page-lista device-selection${reordering ? ' is-layout' : ''}`}
        style={{ paddingBottom: bottomCells.length && bottomFits ? 0 : bottomPad }}>
        <h1 className="sr-only">{t('nav.deviceList')}</h1>
        {/* ikona siatki w górnym pasku włącza tryb „Zmień układ” (pola, ukrywanie, kafelki pogody) */}
        {headerSlot && devicesLoaded && createPortal(
          <button type="button" className={`icon-btn header-layout${reordering ? ' is-active' : ''}`} disabled={reordering}
            title={t('devices.layout')} aria-label={t('devices.layoutTiles')} onClick={startReordering}>
            <ListIcon name="grid" />
          </button>,
          headerSlot,
        )}
        {outdoorStrip}
        {reordering && (
          <div className="layout-bar">
            <span>{moving ? t('devices.layoutMoveHint') : t('devices.layoutHint')}</span>
            <span className="layout-bar-buttons">
              <button type="button" className="btn btn-sm" onClick={cancelOrder} disabled={savingOrder}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={saveOrder} disabled={savingOrder}>{t('common.done')}</button>
            </span>
          </div>
        )}
        {error && <p className="device-selection-error">{error}</p>}
        <section className="tiles device-grid" ref={listRef} style={gridStyle} aria-label={t('devices.tiles')}>
          {topCells.map((slot) => renderCell(slot, 0))}
          {!devicesLoaded && devices.length === 0 && !error && Array.from({ length: rememberedDeviceCount() }, (_, index) => (
            <article key={`skeleton-${index}`} className="tile tile-device tile-loading" aria-busy="true">
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-main" />
              <span className="skeleton skeleton-row" />
              <span className="skeleton skeleton-foot" />
            </article>
          ))}
          {devicesLoaded && devices.length === 0 && !error && (
            <p className="devices-empty">{t('devices.empty')}</p>
          )}
        </section>
        {bottomCells.length > 0 && (
          <>
            <div className="device-list-spacer" ref={spacerRef} style={{ height: spacer }} aria-hidden="true" />
            <section className="tiles device-grid device-grid-bottom" ref={bottomRef} style={gridStyle} aria-label={t('devices.bottomTiles')}>
              {bottomCells.map((slot) => renderCell(slot, emptyRow + 1))}
            </section>
          </>
        )}
      </main>

      {editing && <DeviceEditModal device={editing} onClose={() => setEditing(null)} onSaved={saved} />}
      {editingWeather !== undefined && (
        <WeatherTileModal tile={editingWeather} canAddCurrent={!weatherTiles.some((tile) => tile.current)} onClose={() => setEditingWeather(undefined)} onSaved={weatherSaved} onRemoved={weatherRemoved} />
      )}

      {/* stopka listy (.statusbar z makiety): zajętość bazy tylko dla użytkownika systemowego, po prawej nazwa aplikacji */}
      <footer className="statusbar devices-footer">
        {isSystem ? <DatabaseUsage /> : <span />}
        <span className="version">My Home</span>
      </footer>
    </>
  );
};
