import type { PumpWorkMode, ScheduleEntry, WorkMode } from '../modules/heat-pump/types';

// Typy części wspólnej: urządzenie, jego ustawienia i opis rodzaju sterownika.

// Wartości są zapisane w bazie (devices.deviceType, rekordy danych) i wysyłane
// przez sterowniki przy zgłoszeniu; zmiana wymaga migracji i firmware.
export enum DeviceType {
  HP = 'heat_pump',
  WATER_PRESSURE_TANK = 'water-pressure-tank',
  PELLET_BOILER_PELUX200 = 'pellet-boiler-pelux200',
  SWITCH = 'switch',
  // instalacja PV (DTU Hoymiles czytane przez sterownik co); urządzenie zakłada serwer
  PHOTOVOLTAIC = 'photovoltaic',
}

// Dni harmonogramu (pompa ciepła i włącznik); ten sam kontrakt w kliencie (zmieniać razem).
// WORKDAYS pomija święta, DAYS_OFF obejmuje weekendy i polskie święta
// (core/services/calendar.service.ts).
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

// Ustawienia urządzenia (pole properties). Jedno pole w bazie dla wszystkich
// rodzajów sterowników; każdy rodzaj używa swojej części.
export interface DeviceProperties {
  // pompa ciepła: tryb pracy (ręczny / automatyczny / OFF) i temperatura od–do poza harmonogramem
  // (scheduler, pump-mode.service.ts); temperatury jako napisy, bo tak idą do sterownika w operacji.
  // co_* i cwu_* oraz work_mode M/A/CWU to dawne ustawienia (do 2026-10-05), czytane, gdy brak nowych.
  work_mode?: PumpWorkMode | WorkMode;
  temp_min?: String;
  temp_max?: String;
  co_min?: String;
  co_max?: String;
  cwu_min?: String;
  cwu_max?: String;
  // hydrofor
  compressor_seconds?: number;
  // kocioł pelletowy Pellux 200: odstęp odpytywania regulatora [s], 30–3600
  poll_interval_seconds?: number;
  // kocioł pelletowy: cena pelletu [zł/t] do kosztu ogrzewania (wykres „Spalony pellet”)
  pellet_price_per_ton?: number;
  // włącznik: domyślny czas „Włącz” [min] (0 = bez limitu), podpowiadany w aplikacji i na stronie sterownika
  default_on_minutes?: number;
}

// Definicja pompy ciepła (okno „Dane sterownika”), ustawiana raz przy montażu; nie zmienia trybu
// pracy ani temperatur. Osobne pole urządzenia, bo PUT /device/properties zastępuje całe properties.
export type PumpConnection = 'cwu' | 'co';
export interface PumpConfig {
  /** cwu: pompa grzeje zasobnik CWU; co: bufor CO albo wodę w piecu */
  connection: PumpConnection;
  /** pojemność zbiornika [l] (COP zbiornika w co); brak = jeszcze nie wpisana (serwer podaje co domyślne 300 l) */
  tankLiters?: number;
  /** panele Hoymiles podłączone przez DTU (RS-485 sterownika co) */
  pvDtu: boolean;
  /** wymuszenie pracy przy produkcji PV > 2 kW; tylko z pvDtu */
  pvForce: boolean;
}

// Definicja kotła pelletowego (okno „Dane sterownika”): pompa ciepła, z którą kocioł pracuje w trybie
// „Pompa ciepła”. null = bez pompy ciepła: kocioł pracuje tylko na pellecie, aplikacja nie pokazuje trybu pracy.
export interface BoilerConfig {
  heatPumpRootId: string | null;
}

// Zapis definicji odrzucony przez moduł rodzaju (np. usunięcie pompy ciepła przy trybie „Pompa ciepła”): 409.
export class DefinitionConflictError extends Error {}

export interface Device {
  deviceType: DeviceType;
  deviceId: string;
  name?: string;
  /** właściciel (users._id); brak = bez właściciela */
  ownerId?: string | null;
  /** sterownik otwierany po starcie aplikacji; najwyżej jeden (od kont użytkowników: users.defaultRootId) */
  isDefault?: boolean;
  /** miejsce na liście sterowników (0 = pierwszy, wspólne z kafelkami pogody); brak = na końcu */
  sortOrder?: number;
  /** kafelek ukryty na liście (widoczny tylko w trybie „Zmień kolejność”) */
  hidden?: boolean;
  /** wersja firmware zgłoszona przez sterownik przy ostatnim zgłoszeniu (pole version) i kiedy */
  firmwareVersion?: string;
  firmwareSeenAt?: Date;
  /** zlecenie aktualizacji z aplikacji (wersja, kiedy); oferta idzie do sterownika tylko przy nim */
  firmwareUpdate?: { version: string; requestedAt: Date };
  /** przekaźnik poczty (włącznik, co): zatwierdzony klucz publiczny płytki i klucz czekający na zatwierdzenie */
  mailKey?: { publicKey: string; fingerprint: string; approvedAt: Date; seenAt?: Date };
  mailKeyPending?: { publicKey: string; fingerprint: string; seenAt?: Date };
  /** adres IPv4 sterownika w sieci lokalnej z ostatniego zgłoszenia (pole ip) i kiedy */
  ipAddress?: string;
  ipSeenAt?: Date;
  /** pompa ciepła: podłączenie, zbiornik i fotowoltaika; brak = jeszcze nie ustawione (PUMP_CONFIG_DEFAULTS) */
  pumpConfig?: PumpConfig;
  /** kocioł pelletowy: powiązana pompa ciepła; brak pola = jeszcze nie ustawione (uzupełniane przy starcie serwera) */
  boilerConfig?: BoilerConfig;
  // pompa ciepła: harmonogramy
  schedules?: ScheduleEntry[];
  properties?: DeviceProperties;
}

// Opis rodzaju sterownika: to, czym rodzaje różnią się w części wspólnej
// (urządzenia i zgłoszenie). Każdy moduł podaje swój (device-type.ts), a
// core/device-types.ts zbiera je w rejestr.
export interface DeviceTypeModule {
  type: DeviceType;
  /** ustawienia (properties) nowego urządzenia utworzonego przy zgłoszeniu */
  initialProperties?: DeviceProperties;
  /** ustawienia odsyłane sterownikowi w odpowiedzi na zgłoszenie (pole settings) */
  controllerSettings?: (properties: DeviceProperties, device: Device) => unknown;
  /** sterownik aktualizuje firmware przez sieć, na zlecenie z aplikacji: odpowiedź na zgłoszenie (i odpowiedzi
   * włącznika i pieca) niesie wtedy ofertę firmware (core/services/firmware.service.ts) */
  firmwareUpdates?: boolean;
  /** dodatkowe pola zgłoszenia (np. liczba przekaźników włącznika); wołane przy każdym zgłoszeniu */
  onRegister?: (rootId: string, deviceId: string, body: Record<string, unknown>) => Promise<void>;
  /** wołane po zapisie ustawień urządzenia (PUT /device/properties), np. pompa kasuje ręczne nadpisania;
   * meta: kto zapisał (dziennik operacji) */
  onPropertiesSaved?: (rootId: string, meta?: OperationMeta) => Promise<void>;
  /** dziennik operacji: nazwy ustawień (properties) do opisu zmiany „przed → po”; pozostałe klucze są pomijane */
  propertyLabels?: Record<string, PropertyLabel>;
  /** sterownik dostaje ustawienia dopiero przy zgłoszeniu (hydrofor): zmiana czeka w dzienniku do zgłoszenia */
  propertiesOnRegister?: boolean;
  /** sprawdzenie definicji przed zapisem (okno „Dane sterownika”); DefinitionConflictError = 409 */
  checkDefinition?: (rootId: string, definition: { boilerConfig?: BoilerConfig }) => Promise<void>;
  /** definicja pompy nadawana automatycznie przy zgłoszeniu sterownika (okno „Dane sterownika” może ją zmienić) */
  initialPumpConfig?: PumpConfig;
  /** kafelek sterownika na stronie /devices; null = brak danych do pokazania (kafelek tylko z nazwą) */
  tile?: (rootId: string, device: Device, now?: Date, lang?: 'pl' | 'en') => Promise<DeviceTile | null>;
  /** dziennik operacji: operacje zaplanowane od now do końca doby (np. przejścia harmonogramu) */
  plannedOperations?: (rootId: string, now: Date, dayEnd: Date) => Promise<PlannedOperation[]>;
}

// Dziennik operacji (zakładka „Operacje”, core/services/operation-log.service.ts). Kto: użytkownik aplikacji, system
// (moduł w source) albo sterownik (zmiana na jego stronie). Status zlecenia: pending czeka, sent wysłane do sterownika,
// delivered odebrane przez sterownik, który nie potwierdza wykonania (pompa ciepła, hydrofor; status końcowy),
// done wykonane, error błąd, replaced zastąpione nowszym albo odwołane.
export type OperationActorType = 'user' | 'system' | 'controller';
export interface OperationActor {
  type: OperationActorType;
  name?: string;
  userId?: string;
}
export type OperationStatus = 'pending' | 'sent' | 'delivered' | 'done' | 'error' | 'replaced';

/** kto i dlaczego: przekazywane do miejsca, które tworzy zlecenie */
export interface OperationMeta {
  actor: OperationActor;
  source: string;
  reason?: string;
  conditions?: string;
}

/** nazwa ustawienia w dzienniku: values tłumaczy wartości (np. work_mode), unit dopisywana do liczby */
export interface PropertyLabel {
  label: string;
  unit?: string;
  values?: Record<string, string>;
}

export interface PlannedOperation {
  at: Date;
  actor: OperationActor;
  source: string;
  action: string;
  reason?: string;
  conditions?: string;
  /** przejście bez godziny, po spełnieniu warunku (np. cykl Zimy); at = chwila odczytu, klient pokazuje „—” */
  conditional?: boolean;
}

// Kafelek sterownika na stronie /devices (GET /devices/summary): stan, kilka kluczowych wartości i ewentualny
// błąd albo ostrzeżenie. Każdy rodzaj buduje go w swoim tile.ts (pole tile w DeviceTypeModule), a klient
// rysuje jednym komponentem. Teksty i wartości są gotowe do wyświetlenia.
export type TileLevel = 'ok' | 'warn' | 'err' | 'off';

/** nazwa piktogramu z klienta (client/src/core/components/pictograms.tsx) */
export type TileIcon =
  'thermo' | 'target' | 'bolt' | 'sliders' | 'sun' | 'drop' | 'timer' | 'repeat' | 'flame' | 'tap'
  | 'pellet' | 'power' | 'battery' | 'panel' | 'bubbles' | 'waves';

export interface TileFact { icon: TileIcon; value: string; label?: string }

export interface TileRelay {
  name: string;
  on: boolean;
  text: string;
  /** pola kafelka prostego (włącznik, 2026-10-20): numer, tryb, stan żądany przez chmurę, koniec włączenia albo
   *  przerwy (ISO) i najbliższe włączenie z harmonogramu po bieżącym stanie (ISO) */
  relay?: number;
  mode?: string;
  desiredOn?: boolean;
  until?: string | null;
  nextStart?: string | null;
}

export interface DeviceTile {
  /** kolor paska kafelka: ok (zielony), warn (pomarańczowy), err (czerwony, z ramką), off (szary) */
  level: TileLevel;
  /** Online / Offline / „Brak danych” / „Brak uruchomień”: od 2026-10-27 kafelek nie rysuje Online / Offline (zostaje dla
   *  wartownika push i pamięci kafelków), tylko „Brak …”; brak odpowiedzi idzie w note (czerwona linia z czasem) */
  chip: string;
  /** stan sterownika zamiast chipu Online / Offline (2026-10-27): on = zielony „ON”, off = szary „OFF”; pompa: tryb inny
   *  niż OFF i zgoda CO na sterowniku, kocioł: regulator (stan ≠ 0), hydrofor: pompa pracuje; włącznik i PV bez tego pola */
  power?: 'on' | 'off';
  running?: boolean;
  /** wartość główna (duża, po lewej) i pozostałe w prawej kolumnie, wyrównane do prawej */
  main?: TileFact;
  /** druga wartość obok głównej (hydrofor: woda w miesiącu obok wody dziś); bez własnej ikony */
  main2?: TileFact;
  side?: TileFact[];
  /** drugi wiersz wartości: pierwsza po lewej, ostatnia po prawej */
  row?: TileFact[];
  /** włącznik: przekaźniki zamiast wartości */
  relays?: TileRelay[];
  /** jedna linia o błędzie albo ostrzeżeniu; icon: 'offline' = brak odpowiedzi sterownika (klient rysuje przekreślony
   *  sygnał jak w pasku „Offline od…” na ekranie sterownika, tylko mniejszy) */
  note?: { level: 'warn' | 'err'; text: string; icon?: 'offline' };
  /** czas ostatnich danych (ISO): klient pisze „dane sprzed …” */
  updatedAt?: string;
  /** własny tekst stopki zamiast „dane sprzed …” */
  foot?: string;
  /** hydrofor: początek ostatniego uruchomienia (ISO), gdy pompa nie pracuje; klient pisze „ostatnie uruchomienie …” w swoim języku */
  lastRunAt?: string;
  /** początek bieżącej pracy przy running (ISO; kocioł: palenie): klient pokazuje czas pracy („2 h 08 min”) */
  since?: string;
  /** wskaźniki pomp obiegu (kocioł: CO, CWU); on = pompa pracuje */
  pumps?: { label: string; on: boolean }[];
  /** włącznik: domyślny czas „Włącz” w minutach (0 = bez limitu) dla przycisku „Włącz bojler” kafelka prostego */
  onMinutes?: number;
  /** kocioł: stan dla kafelka prostego (modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-simple.service.ts) */
  boiler?: SimpleBoilerState;
}

/** Kafelek prosty pieca (2026-10-21): regulator, palenie, sezon, CWU, temperatury i zlecenie w toku. */
export interface SimpleBoilerState {
  online: boolean;
  /** regulator włączony (stan ≠ 0); null bez odczytu */
  regulatorOn: boolean | null;
  burning: boolean;
  season: 'winter' | 'summer' | null;
  /** pompa CWU w regulatorze (nr 122 ≠ 0); null bez odczytu ustawień */
  cwuOn: boolean | null;
  boilerTemp: number | null;
  cwuTemp: number | null;
  cwuTarget: number | null;
  /** tryb Pompa ciepła: „Włącz piec” ustawia Zimę przez cykl Zimy, a włączenie może być odrzucone (409) */
  heatPumpMode: boolean;
  /** zlecenie w toku: włącz/wyłącz regulator albo zmiana CWU */
  pending: 'control' | 'cwu' | null;
}

// Wzór kafelka listy sterowników (projektant kafelka, GET/PUT /devices/tile-template; kontrakt z
// client/src/core/tile-template.ts): rozmiar komórki i odstęp w px, pola w % komórki.
export const TILE_SLOTS = [
  'icon', 'name', 'status', 'main', 'mainLabel', 'divider', 'side1', 'side2', 'side3', 'row', 'relays', 'warning',
  'footer',
] as const;
export type TileSlot = typeof TILE_SLOTS[number];
export interface TileField { x: number; y: number; w: number; h: number; a: 'left' | 'center' | 'right'; v: boolean }
export interface TileTemplate { w: number; h: number; gap: number; f: Record<TileSlot, TileField> }
