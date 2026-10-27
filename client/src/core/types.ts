import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { PumpWorkMode, WorkMode } from '../devices/heat-pump/types';

// Typy części wspólnej: urządzenie i jego ustawienia oraz opis rodzaju sterownika dla rejestru
// (device-types.tsx). Odpowiadają dokumentom kolekcji devices (GET /api/devices, /api/device/properties).

// Wartości deviceType z bazy; nowy rodzaj wymaga też wpisu w rejestrze device-types.tsx.
export enum DeviceType {
  HP = 'heat_pump',
  WATER_PRESSURE_TANK = 'water-pressure-tank',
  PELLET_BOILER_PELUX200 = 'pellet-boiler-pelux200',
  SWITCH = 'switch',
  PHOTOVOLTAIC = 'photovoltaic',
}

// Dni harmonogramu (pompa ciepła i włącznik); wartości ujemne to grupy dni, DAYS_OFF obejmuje
// weekendy i polskie święta (calendar.service na serwerze). Ten sam kontrakt na serwerze.
export enum WeekDay {
  ANY_DAY = -1,
  WORKDAYS = -2,
  DAYS_OFF = -3,
  SUNDAY = 0,
  MONDAY = 1,
  TUESDAY = 2,
  WEDNESDAY = 3,
  THURSDAY = 4,
  FRIDAY = 5,
  SATURDAY = 6,
}

// Ustawienia urządzenia (properties): jedno pole dla wszystkich rodzajów sterowników.
export type DeviceProperties = {
  // pompa ciepła: tryb pracy i temperatura od–do poza harmonogramem; M/A/CWU i pary co_*/cwu_*
  // to dawne ustawienia (do 2026-10-05), serwer czyta je, gdy brak nowych
  work_mode?: PumpWorkMode | WorkMode;
  temp_min?: string;
  temp_max?: string;
  co_min?: string;
  co_max?: string;
  cwu_min?: string;
  cwu_max?: string;
  // hydrofor
  compressor_seconds?: number;
  // kocioł pelletowy: co ile sterownik odpytuje piec, 30–3600 s (domyślnie 300)
  poll_interval_seconds?: number;
  // kocioł pelletowy: cena pelletu [zł/t] do kosztu ogrzewania (wykres „Spalony pellet”), domyślnie 2000
  pellet_price_per_ton?: number;
  // włącznik: domyślny czas „Włącz” [min], 0 (bez limitu) – 10080
  default_on_minutes?: number;
};

// rootId to _id dokumentu w MongoDB, deviceId to SN sterownika (MAC ESP32); pusta nazwa
// oznacza sterownik zarejestrowany automatycznie (w interfejsie deviceLabel pokazuje wtedy deviceId).
// Przekaźnik poczty (2026-10-17): płytka wysyła maile z domowego łącza; klucz płytki zatwierdza użytkownik systemowy.
export interface MailKeyInfo {
  fingerprint?: string;
  approvedAt?: string;
  pendingFingerprint?: string;
  /** ostatnie pytanie płytki o maile (tylko w pamięci serwera) */
  seenAt?: string;
  /** MAIL_RELAY=1 na serwerze */
  relayEnabled: boolean;
}

export type Device = {
  rootId: string;
  deviceType: DeviceType;
  deviceId: string;
  name: string;
  isDefault?: boolean;
  // miejsce na liście sterowników ustawione w trybie „Zmień kolejność” (0 = pierwszy, wspólne z kafelkami pogody);
  // lista z serwera jest już posortowana
  sortOrder?: number;
  // kafelek ukryty na liście (widoczny tylko w trybie „Zmień kolejność”)
  hidden?: boolean;
  // kafelek prosty na liście tego konta (duże przyciski zamiast wartości; włącznik, 2026-10-20): przełącznik
  // w oknie „Dane sterownika” albo udostępnienie „Panel prosty” (tabs: ['simple'])
  simple?: boolean;
  // wersja firmware zgłoszona przy ostatnim uruchomieniu sterownika i czas zgłoszenia (ISO);
  // starsze sterowniki ich nie wysyłają
  firmwareVersion?: string;
  firmwareSeenAt?: string;
  // zlecenie „Aktualizuj” czekające na sterownik; znika, gdy sterownik zgłosi oferowaną wersję
  firmwareUpdate?: FirmwareUpdateRequest;
  // adres IPv4 sterownika w sieci lokalnej z ostatniego zgłoszenia i czas zgłoszenia (ISO)
  ipAddress?: string;
  ipSeenAt?: string;
  // przekaźnik poczty (włącznik, pompa ciepła): odcisk zatwierdzonego klucza płytki i klucza czekającego na zatwierdzenie
  mailKey?: MailKeyInfo;
  // pompa ciepła: definicja z okna „Dane sterownika”; brak = jeszcze nie ustawiona
  pumpConfig?: PumpConfig;
  // kocioł pelletowy: powiązana pompa ciepła (null = kocioł tylko na pellecie)
  boilerConfig?: BoilerConfig;
  properties?: DeviceProperties;
  // konta użytkowników (GET /api/devices z sesją): rodzaj dostępu, zakładki udostępnienia i właściciel
  access?: DeviceAccess;
  tabs?: string[];
  owner?: DeviceOwner | null;
};

// owner: właściciel, shared: udostępniony (tylko zakładki tabs), system: użytkownik systemowy
export type DeviceAccess = 'owner' | 'shared' | 'system' | 'demo';
/** sterownik do edycji: własny albo systemowy; udostępniony i wersja demo tylko do odczytu */
export const canEditDevice = (device?: Device | null) => !!device && device.access !== 'shared' && device.access !== 'demo';
export type DeviceOwner = { id: string; name: string; email: string | null };

// Konto (GET /api/auth/me); profileComplete = imię, nazwisko i kraj wpisane (system zawsze)
export type UserLocation = { lat: number; lng: number };
export type User = {
  id: string;
  email: string | null;
  isSystem: boolean;
  /** wersja demo (2026-10-21): konto właściciela tylko do odczytu, profil „Demo” */
  isDemo: boolean;
  firstName: string;
  lastName: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  location: UserLocation | null;
  /** język konta ('pl' | 'en'; pusty = nie wybrano) — core/i18n */
  language: string;
  profileComplete: boolean;
};

// Powiadomienia Web Push (karta „Powiadomienia” w /account, 2026-10-21; GET /push/settings)
export type PushEventDefinition = { key: string; label: string; default: boolean; urgent?: boolean };
export type PushSubscriptionInfo = { id: string; endpoint: string; label: string; createdAt: string; lastUsedAt: string | null };
export type PushRule = { rootId: string; events: string[] };
export type PushSettings = {
  /** klucze VAPID są na serwerze */
  configured: boolean;
  publicKey: string | null;
  subscriptions: PushSubscriptionInfo[];
  rules: PushRule[];
  quietFrom: string | null;
  quietTo: string | null;
  /** katalog zdarzeń według rodzaju sterownika */
  events: Partial<Record<DeviceType, PushEventDefinition[]>>;
  /** sterowniki konta, które mają zdarzenia */
  devices: { rootId: string; name: string; deviceType: DeviceType }[];
};

// Osoba z dostępem do sterownika (karta „Udostępnianie”); registered = false: zaproszenie czeka na rejestrację
export type DeviceShare ={ id: string; email: string; name: string | null; registered: boolean; tabs: string[]; createdAt: string };

// Definicja kotła pelletowego (kontrakt z serwerem, core/types.ts): pompa ciepła trybu „Pompa ciepła”.
export type BoilerConfig = { heatPumpRootId: string | null };

// Definicja pompy ciepła (kontrakt z serwerem, core/types.ts): podłączenie, zbiornik i fotowoltaika.
export type PumpConnection = 'cwu' | 'co';
export type PumpConfig = {
  connection: PumpConnection;
  /** pojemność zbiornika [l], pełne litry 20–2000; brak = jeszcze nie wpisana (pole w oknie puste) */
  tankLiters?: number;
  /** panele Hoymiles podłączone przez DTU (RS-485) */
  pvDtu: boolean;
  /** wymuszenie pracy przy produkcji PV > 2 kW; tylko z pvDtu */
  pvForce: boolean;
};

// Pola okna „Dane sterownika” poza nazwą (PUT /devices/:rootId), zależne od rodzaju.
export type DeviceDefinition = { pumpConfig?: PumpConfig; boilerConfig?: BoilerConfig };

// GET /api/devices/db-stats (stopka strony /devices): zajętość bazy (dane + indeksy) względem limitu
// planu Atlas M0 (512 MB) i odpowiedź bazy na ping; ok = false albo brak odpowiedzi = baza nie działa.
/** pogoda z Open-Meteo pobrana przez sterownik włącznika (GET /temperature, serwer core/services/meteo.service.ts) */
export type Weather = {
  /** temperatura z prognozy [°C] */
  temperature: number;
  /** kod pogody WMO */
  code: number;
  /** zachmurzenie [%] */
  cloudCover: number;
  /** opad i deszcz [mm], śnieg [cm] z ostatniego kwadransa */
  precipitation: number;
  rain: number;
  snowfall: number;
  /** wiatr [km/h] */
  windSpeed: number;
  isDay: boolean;
  at: string;
};

// Kafelek pogody na liście sterowników (GET /api/weather-tiles; kontrakt: server/src/core/services/weather-tile.service.ts):
// miejscowość z pogodą z Open-Meteo pobieraną przez sterownik włącznika. home = kafelek domu (powstaje sam, bez usuwania);
// sortOrder wspólne ze sterownikami; weather = null bez świeżych danych (45 min). current = kafelek bieżącej
// lokalizacji (bez współrzędnych i pogody z serwera; położenie i pogoda z przeglądarki, core/currentPlace.ts).
export type WeatherTile = {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  sortOrder?: number;
  hidden: boolean;
  home: boolean;
  /** „Dom” albo kafelek konta przy domu (do 3 km): temperatura z czujnika kotła (od 2026-10-21; starszy serwer go nie wysyła) */
  nearHome?: boolean;
  current: boolean;
  weather: Weather | null;
};

/** GET /temperature: temperatura (czujnik kotła, bez niego prognoza) i pogoda; null = brak świeżych danych */
export type OutdoorConditions = {
  temperature: number | null;
  temperatureSource: 'boiler' | 'forecast' | null;
  weather: Weather | null;
};

export type DatabaseStats = {
  ok: boolean;
  usedBytes: number;
  dataBytes: number;
  indexBytes: number;
  limitBytes: number;
  collections: number;
  documents: number;
  pingMs: number;
};

// Część okna „Dane sterownika” dla rodzaju sterownika: zmiany zgłasza przez onChange,
// a null blokuje zapis (pole z błędem, opis w komponencie).
export type DeviceDefinitionFieldsProps = {
  device: Device;
  onChange: (definition: DeviceDefinition | null) => void;
};

export type FirmwareUpdateRequest = { version: string; requestedAt: string };

// Stan firmware rodzaju sterownika (GET /api/firmware/:rodzaj): oferta i pliki w bazie
// (bieżący i jeden poprzedni).
export type FirmwareImage = {
  version: string;
  size: number;
  description: string;
  sha256: string;
  createdAt: string;
  active: boolean;
};

export type FirmwareSummary = {
  enabled: boolean;
  version: string | null;
  previousVersion: string | null;
  images: FirmwareImage[];
};

// Widok w menu: ścieżka, nazwa i ikona w nagłówku oraz strona.
export type DeviceView = {
  path: string;
  label: string;
  icon: ReactNode;
  element: ReactElement;
};

// Opis rodzaju sterownika w kliencie: ikona kafelka na liście urządzeń i widoki
// w kolejności menu (path '/' to strona główna). Każdy rodzaj podaje swój
// (devices/<rodzaj>/device-type.tsx), a core/device-types.tsx zbiera je w rejestr.
export type DeviceTypeView = {
  type: DeviceType;
  tileIcon: ReactNode;
  /** nazwa rodzaju w nagłówkach (np. strona firmware) */
  label?: string;
  /** sterownik aktualizuje firmware przez sieć: kafelek ma trybik prowadzący do /firmware/:deviceType */
  firmwareUpdates?: boolean;
  views: DeviceView[];
  /** dodatkowe pola okna „Dane sterownika” (np. konfiguracja pompy ciepła) */
  DefinitionFields?: ComponentType<DeviceDefinitionFieldsProps>;
  /** dodatkowe ścieżki poza menu (np. /hp jako strona główna pompy) */
  extraRoutes?: { path: string; element: ReactElement }[];
  /** kafelek prosty (duże przyciski na liście); rodzaj bez niego nie ma przełącznika „Kafelek prosty” ani
   *  udostępnienia „Panel prosty” */
  SimpleTile?: ComponentType<SimpleTileProps>;
};

// Kafelek sterownika na stronie /devices (GET /api/devices/summary, kontrakt z serwerem: core/types.ts DeviceTile).
// level: pasek kafelka (ok zielony, warn pomarańczowy, err czerwony z ramką, off szary); running: niebieski chip
// „teraz pracuje”; main + side: wartość główna po lewej i reszta w prawej kolumnie; row: drugi wiersz wartości.
export type TileLevel = 'ok' | 'warn' | 'err' | 'off';
export type TileIcon =
  'thermo' | 'target' | 'bolt' | 'sliders' | 'sun' | 'drop' | 'timer' | 'repeat' | 'flame' | 'tap'
  | 'pellet' | 'power' | 'battery' | 'panel' | 'bubbles' | 'waves';
export type TileFact = { icon: TileIcon; value: string; label?: string };
// relay, mode, desiredOn, until, nextStart: pola kafelka prostego włącznika (devices/switch/components/SimpleTile)
export type TileRelay = {
  name: string; on: boolean; text: string;
  relay?: number; mode?: string; desiredOn?: boolean; until?: string | null; nextStart?: string | null;
};
export type DeviceTile = {
  level: TileLevel;
  chip: string;
  /** stan sterownika zamiast Online / Offline: on = zielony „ON”, off = szary „OFF” (pompa, kocioł, hydrofor); brak odpowiedzi w note */
  power?: 'on' | 'off';
  running?: boolean;
  main?: TileFact;
  main2?: TileFact;
  side?: TileFact[];
  row?: TileFact[];
  relays?: TileRelay[];
  note?: { level: 'warn' | 'err'; text: string; icon?: 'offline' };
  updatedAt?: string;
  foot?: string;
  /** hydrofor: początek ostatniego uruchomienia (ISO), gdy pompa nie pracuje; kafelek pisze „ostatnie uruchomienie …” */
  lastRunAt?: string;
  /** początek bieżącej pracy przy running (ISO; kocioł: palenie) — czas pracy w plakietce stanu */
  since?: string;
  /** wskaźniki pomp obiegu (kocioł: CO, CWU) */
  pumps?: { label: string; on: boolean }[];
  /** włącznik: domyślny czas „Włącz” w minutach (0 = bez limitu) dla kafelka prostego */
  onMinutes?: number;
  /** kocioł: stan dla kafelka prostego (serwer: core/types.ts SimpleBoilerState) */
  boiler?: SimpleBoilerState;
};
export type DeviceTiles = Record<string, DeviceTile>;

// Kafelek prosty pieca (2026-10-21): regulator, palenie, sezon, CWU, temperatury i zlecenie w toku.
export type SimpleBoilerState = {
  online: boolean;
  regulatorOn: boolean | null;
  burning: boolean;
  season: 'winter' | 'summer' | null;
  cwuOn: boolean | null;
  boilerTemp: number | null;
  cwuTemp: number | null;
  cwuTarget: number | null;
  heatPumpMode: boolean;
  pending: 'control' | 'cwu' | null;
};

// Kafelek prosty na liście sterowników (zamiast DeviceTileCard, gdy device.simple): treść kafelka z dużymi
// przyciskami; onChanged po wysłaniu polecenia (lista odświeża kafelki), onOpen = nazwa otwiera pełne widoki
// (brak u osoby z samym udostępnieniem „Panel prosty”).
export type SimpleTileProps = {
  device: Device;
  name: string;
  tile?: DeviceTile;
  now: number;
  loading?: boolean;
  tools?: ReactNode;
  onOpen?: () => void;
  onChanged: () => void;
};

// Dziennik operacji (GET /api/operations?date=, zakładka „Operacje”; kontrakt: server/src/core/types.ts i
// core/services/operation-log.service.ts). planned: najpierw wpisy w toku, potem przejścia harmonogramu
// do końca doby (status „planned”, bez id); done: reszta dnia, najnowsze u góry.
export type OperationActorType = 'user' | 'system' | 'controller';
export type OperationActor = { type: OperationActorType; name?: string; userId?: string };
export type OperationStatus = 'planned' | 'pending' | 'sent' | 'delivered' | 'done' | 'error' | 'replaced';
export type OperationEntry = {
  id?: string;
  at: string;
  actor: OperationActor;
  source: string;
  action: string;
  status: OperationStatus;
  statusAt?: string | null;
  error?: string | null;
  reason?: string | null;
  conditions?: string | null;
  /** zaplanowane bez godziny: po spełnieniu warunku (cykl Zimy pieca) */
  conditional?: boolean;
};
export type OperationsDay = { date: string; today: boolean; planned: OperationEntry[]; done: OperationEntry[] };
