import type { DeviceType, WeekDay } from '../../core/types';

// Typy kotła pelletowego Plum Pellux 200 (regulator ecoMAX): odczyt wysyłany
// przez sterownik co (kolekcja pellet_boiler_pelux200). Wszystkie pola pomiarowe
// są opcjonalne: sterownik wysyła to, co udało się odczytać.

export interface PelletBoilerPelux200Measurements {
  /** stan kotła 0..11: OFF, STABILIZATION, KINDLING, WORKING, SUPERVISION, PAUSED, STANDBY, BURNING_OFF, ALERT, MANUAL, UNSEALING, OTHER */
  state?: number;
  // temperatury [°C]
  heating_temp?: number;
  feeder_temp?: number;
  water_heater_temp?: number;
  outside_temp?: number;
  return_temp?: number;
  exhaust_temp?: number;
  optical_temp?: number;
  upper_buffer_temp?: number;
  lower_buffer_temp?: number;
  heating_target?: number;
  water_heater_target?: number;
  heating_status?: number;
  water_heater_status?: number;
  /** poziom paliwa [%] */
  fuel_level?: number;
  /** moc dmuchawy [%] */
  fan_power?: number;
  /** obciążenie kotła [%] */
  boiler_load?: number;
  /** moc kotła [kW] */
  boiler_power?: number;
  /** zużycie paliwa [kg/h] */
  fuel_consumption?: number;
  /** poziom tlenu w spalinach (lambda) [%] */
  lambda_level?: number;
  // wyjścia
  fan?: boolean;
  feeder?: boolean;
  heating_pump?: boolean;
  water_heater_pump?: boolean;
  circulation_pump?: boolean;
  lighter?: boolean;
  alarm?: boolean;
  // mieszacze 1 (grzejniki) i 2 od firmware 1.2.0; brak pól = mieszacz niepodłączony
  /** temperatura obiegu mieszacza [°C] */
  /** termostat pokojowy eSTER: temperatura w pokoju i zadana (firmware pieca od 1.8.0) */
  room_temp?: number;
  room_target_temp?: number;
  mixer1_temp?: number;
  /** zadana mieszacza [°C] */
  mixer1_target?: number;
  mixer1_pump?: boolean;
  /** siłownik zaworu otwiera */
  mixer1_opening?: boolean;
  /** siłownik zaworu zamyka */
  mixer1_closing?: boolean;
  mixer2_temp?: number;
  mixer2_target?: number;
  /** liczba aktywnych alarmów kotła (firmware pieca od 1.7.0) */
  alerts_active?: number;
  /** surowe output_flags z SensorData (firmware pieca od 1.8.0), bez pokazywania w aplikacji */
  output_flags?: number;
  /** narastający licznik spalonego pelletu [kg] (firmware pieca od 1.7.1) */
  fuel_burned_kg?: number;
  mixer2_pump?: boolean;
  mixer2_opening?: boolean;
  mixer2_closing?: boolean;
  /** tryb „Pompa ciepła”: sprężarka pompy ciepła pracowała przy zapisie odczytu (dopisuje serwer) */
  heat_pump_running?: boolean;
}

/** Ustawienia regulatora ze sterownika: surowe dane odpowiedzi (hex), jak /boiler-settings.json. */
export interface PelletBoilerSettingsRaw {
  /** odpowiedź 0xB1: [0, pierwszy nr, liczba] + liczba × (wartość, min, max) */
  ecomax_parameters?: string;
  /** odpowiedź 0xB2: [0, pierwszy nr, liczba, mieszacze] + mieszacze × liczba × 3 */
  mixer_parameters?: string;
  thermostat_parameters?: string;
  schedules?: string;
  regulator_data_schema?: string;
}

/** Parametr po rozkodowaniu (wartość, min i max w jednostkach, raw = bajty z ramki). */
export interface PelletBoilerParameter {
  index: number;
  name: string | null;
  label?: string;
  description?: string;
  /** ocena zmiany z docs/parametry-kotla.md */
  rating?: string;
  unit?: string;
  kind?: 'switch';
  /** wartość = (surowa − offset) × step (brak = 1 i 0) */
  step?: number;
  offset?: number;
  value: number;
  min: number;
  max: number;
  raw: [number, number, number];
  /** wartość nieznana: regulator nie podaje tej nastawy (mieszacz 2); value i raw[0] to wtedy minimum */
  unknown?: boolean;
}

export interface PelletBoilerSettingsView {
  readAt: Date;
  deviceId?: string;
  groups: { key: string; label: string; parameters: PelletBoilerParameter[] }[];
  /** assumed: regulator nie podaje nastaw mieszacza (u nas mieszacz 2), parametry z ASSUMED_MIXER (wartość nieznana) */
  mixers: { mixer: number; parameters: PelletBoilerParameter[]; assumed?: boolean }[];
  /** przełączniki harmonogramów regulatora z odpowiedzi 0xB6 (godzin nie pokazujemy) */
  schedules: PelletBoilerScheduleSwitch[];
}

/** Harmonogram regulatora: numer jak w PyPlumIO (4 = czyszczenie kotła), włączony albo nie. */
export interface PelletBoilerScheduleSwitch {
  index: number;
  name: string;
  label: string;
  enabled: boolean;
}

/** Zmiana parametru z aplikacji: parametr kotła (0x33) albo mieszacza (0x34), wartość surowa. */
export interface PelletBoilerCommandChange {
  /** control: włącz (1) / wyłącz (0) regulator, index 0; schedule: harmonogram nr index włącz (1) / wyłącz (0), ramka 0x37 (firmware od 1.8.0) */
  kind: 'ecomax' | 'mixer' | 'control' | 'schedule';
  /** numer mieszacza od 1 (kind = mixer) */
  mixer?: number;
  index: number;
  value: number;
  /** wysłać dopiero, gdy kocioł zgłosi stan „wyłączony” (0) w odczycie nowszym niż zlecenie — zmiana trybu pracy */
  waitOff?: boolean;
}

export type PelletBoilerCommandStatus = 'pending' | 'sent' | 'done' | 'error' | 'replaced';

export interface PelletBoilerCommandEntry extends PelletBoilerCommandChange {
  _id?: unknown;
  rootId: string;
  previous?: number;
  label?: string;
  status: PelletBoilerCommandStatus;
  error?: string;
  sentAt?: Date;
  doneAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Tryb pracy kotła: pompa ciepła (kocioł bez palenia) albo pellet (kociol-ustawienia.md, punkt 4b). */
export type PelletBoilerMode = 'heat-pump' | 'pellet';

/** CWU od (start ładowania) i do (zadana) [°C]: zadana nr 119 = do, histereza nr 123 = do − od. */
export interface PelletBoilerCwuRange {
  cwuFrom: number;
  cwuTo: number;
}

/** Sezon regulatora (Tryb LATO, nr 125): zima = 0 (CO i CWU), lato = 1 (tylko CWU). */
export type PelletBoilerSeason = 'winter' | 'summer';

/** Wpis harmonogramu dla jednego trybu pracy kotła w oknie godzin: type cwu = CWU od–do, type season =
 * „Tryb Zima” (od 2026-10-15; wcześniej Lato / Zima z jednym progiem coldBelow), opcjonalnie według temperatury
 * zewnętrznej: Zima poniżej winterBelow, powrót Lata powyżej summerAbove, między progami bez zmiany.
 * Włączanie i wyłączanie kotła z harmonogramu usunięto 2026-10-04; stare wpisy type = work są pomijane. */
export interface PelletBoilerScheduleEntry extends Partial<PelletBoilerCwuRange> {
  _id?: unknown;
  rootId: string;
  type: 'cwu' | 'season';
  mode: PelletBoilerMode;
  enabled: boolean;
  dayOfWeek?: WeekDay;
  date?: Date;
  startTime: string;
  endTime: string;
  /** type season: sezon w oknie */
  season?: PelletBoilerSeason;
  /** type season: Zima, gdy temperatura zewnętrzna (czujnik kotła) spadnie poniżej [°C]; brak = przez całe okno */
  winterBelow?: number | null;
  /** type season: z powrotem Lato (poza harmonogramem), gdy temperatura wzrośnie powyżej [°C]; > winterBelow */
  summerAbove?: number | null;
  /** dawny jeden próg (do 2026-10-15): działa jak winterBelow = coldBelow, summerAbove = coldBelow + 0,5 °C;
   *  zapis wpisu z formularza go kasuje */
  coldBelow?: number | null;
}

/** Stan, który harmonogram ustawia w kotle; paused = harmonogram nie działa („Wyłącz regulator”).
 * season brak = sezonem harmonogram nie steruje (brak wpisu i brak sezonu poza harmonogramem);
 * seasonScheduleId = działający wpis sezonu (do histerezy progu temperatury). */
export interface PelletBoilerScheduleState extends PelletBoilerCwuRange {
  mode: PelletBoilerMode;
  season?: PelletBoilerSeason;
  seasonScheduleId?: string | null;
  paused?: boolean;
  /** znacznik „Grzej CWU peletem” w trybie pompy ciepła (CWU od–do z trybu Pellet) */
  pelletCwu?: boolean;
  /** poza wpisami CWU „bez zmiany”: harmonogram nie zleca nr 119 i 123 (cwuFrom/cwuTo to tylko zapisane wartości) */
  cwuUnchanged?: boolean;
}

/** Wartości poza harmonogramem dla trybu: CWU od–do i sezon (brak sezonu = harmonogram go nie zmienia).
 *  cwuUnchanged: CWU „bez zmiany” — poza wpisami zostaje zadana z panelu kotła albo ustawiona ręcznie parametrem
 *  (2026-10-13); cwuFrom/cwuTo zostają zapisane i wracają po odznaczeniu. */
export interface PelletBoilerScheduleDefaults extends PelletBoilerCwuRange {
  season?: PelletBoilerSeason;
  cwuUnchanged?: boolean;
}

/** Nastawy trybu: klucz „ecomax:<nr>” albo „mixer<n>:<nr>” → wartość surowa. */
export type PelletBoilerProfile = Record<string, number>;

/** Ładowanie CWU w trybie pompy ciepła (pellet-boiler-pelux200-cwu-loading.service.ts) dla ekranu kotła. */
export interface PelletBoilerCwuLoading {
  active: boolean;
  since: Date | null;
  /** pompa ciepła w trybie OFF: ładowanie trwa, ale pompa nie dogrzewa wody */
  heatPumpOff: boolean;
  /** błąd zgłoszenia do pompy ciepła (brak pompy, HTTP) */
  error?: string;
  /** pompa ciepła wstrzymana: kocioł pali (stany 1–4) albo ma ≥ hotBoilerFrom, albo trwa CWU z peletu */
  pumpBlocked?: boolean;
  /** próg gorącego kotła [°C] z odpowiedzi pompy ciepła na zgłoszenie (52 °C; brak = HOT_BOILER_FROM) */
  hotBoilerFrom?: number;
}

/** Automatyczne przejście na Pellet po rozpalaniu w trybie pompy ciepła (komunikat do „OK”). */
export interface PelletBoilerAutoPellet {
  /** czas odczytu z rozpalaniem */
  at: Date;
  acknowledged: boolean;
  /** liczba zleconych zmian nastaw */
  changes: number;
  error?: string;
}

export interface PelletBoilerScheduleSettings {
  rootId: string;
  /** „Praca kotła” w Ustawieniach: true = włączony, pracuje według harmonogramu; false = wyłączony
   *  (zlecenie wyłącz, harmonogram stoi) */
  enabled: boolean;
  /** CWU i praca kotła poza harmonogramem, osobno dla trybu */
  defaults: Record<PelletBoilerMode, PelletBoilerScheduleDefaults>;
  /** nastawy kotła stosowane przy przełączeniu trybu (Ustawienia → Tryb pracy) */
  profiles: Record<PelletBoilerMode, PelletBoilerProfile>;
  lastApplied?: PelletBoilerScheduleState;
  lastAppliedAt?: Date;
  lastError?: string;
  /** ładowanie CWU w trybie pompy ciepła, dla ekranu kotła */
  cwuLoading?: PelletBoilerCwuLoading;
  /** automatyczne przejście na Pellet (pellet-boiler-pelux200-auto-pellet.service.ts) */
  autoPellet?: PelletBoilerAutoPellet;
  /** cykl Zimy w trybie pompy ciepła (pellet-boiler-pelux200-winter-cycle.service.ts); null = nie działa */
  winterCycle?: PelletBoilerWinterCycle | null;
  /** sezon wybrany przyciskiem w Ustawieniach (tryb pompy ciepła); obowiązuje do zmiany sezonu z harmonogramu */
  manualSeason?: PelletBoilerManualSeason | null;
  /** CWU z peletu w trybie pompy ciepła (pellet-boiler-pelux200-pellet-cwu.service.ts) */
  pelletCwu?: PelletBoilerPelletCwu;
  /** włączenie regulatora po nagrzaniu kotła (pellet-boiler-pelux200-turn-on.service.ts); null = nie czeka */
  pendingTurnOn?: PelletBoilerPendingTurnOn | null;
}

/** Czy włączenie regulatora rozpali kocioł (tryb pompy ciepła): zadana i próg z nastaw i odczytu. */
export type PelletBoilerTurnOnCheck = {
  mode: 'heat-pump' | 'pellet';
  ignites: boolean;
  /** co podnosi zadaną: boiler = sama zadana kotła, cwu = ładowanie CWU, mixer = mieszacz zimą */
  cause: 'boiler' | 'cwu' | 'mixer' | null;
  boilerTemp: number | null;
  cwuTemp: number | null;
  /** zadana po podniesieniu [°C] i próg rozpalenia (zadana − histereza) */
  target?: number;
  startBelow?: number;
  /** CWU ładuje się poniżej (zadana CWU − histereza) */
  cwuStartBelow?: number;
};

/** Włączenie regulatora czeka, aż kocioł nagrzeje się do startBelow (wtedy w trybie pompy ciepła się nie rozpali). */
export type PelletBoilerPendingTurnOn = {
  since: Date;
  startBelow: number | null;
  /** pompa ciepła była wyłączona i została uruchomiona (tryb ręczny) */
  heatPumpStarted: boolean;
};

/**
 * CWU z peletu w trybie „Pompa ciepła”: idle = czeka na CWU poniżej „od” (ustawienia trybu Pellet);
 * heating = kocioł ma zadaną i histerezę trybu Pellet i grzeje CWU do „do”; cooling = nastawy pompy ciepła
 * przywrócone, pompa ciepła wstrzymana do spadku kotła poniżej 50 °C (PELLET_CWU_PUMP_BLOCK_BELOW 52 °C i histereza).
 */
export type PelletBoilerPelletCwu = {
  /** znacznik „CWU grzej peletem” w Ustawieniach */
  enabled: boolean;
  phase: 'idle' | 'heating' | 'cooling';
  /** początek fazy */
  since: Date | null;
  /** w fazie heating: kocioł zgłosił palenie (stany 1–4) */
  burning?: boolean;
  /** CWU od–do trybu Pellet z ostatniego przebiegu [°C] */
  cwuFrom?: number;
  cwuTo?: number;
  /** koniec grzania: niższa z cwuTo i zadanej CWU z odczytu kotła (water_heater_target) [°C] */
  cwuEnd?: number;
  /** temperatura kotła i CWU z ostatniego świeżego odczytu [°C] */
  boilerTemp?: number | null;
  cwuTemp?: number | null;
  /** powód przerwania ostatniego grzania (brak rozpalenia, za długo); kasowany przy następnym starcie */
  error?: string | null;
};

/** Cykl Zimy: waiting = Lato, czeka na kocioł albo wodę w pompie ≥ max pompy ciepła − 3 °C (wymuszając start pompy ciepła);
 *  winter = Zima do kotła < 30 °C przy stojącej pompie CO. Tylko sezon i wymuszenie, bez mieszacza (od 2026-10-27). */
export type PelletBoilerWinterCycle = {
  phase: 'waiting' | 'winter';
  since: Date;
  /** temperatura kotła (heating_temp) z ostatniego świeżego odczytu [°C] */
  temperature: number | null;
  /** próg Zimy w fazie waiting: max pompy ciepła (HP.Tmax) − 3 °C, bez jej danych 45 °C */
  winterFrom?: number;
  /** HP.Ttarget pompy ciepła w fazie waiting (próg Zimy sprawdzany też na nim) [°C] */
  pumpTemperature?: number | null;
  /** ostatnie wymuszenie startu sprężarki pompy ciepła */
  forcedAt?: Date | null;
};

export type PelletBoilerManualSeason = {
  season: PelletBoilerSeason;
  at: Date;
  /** sezon z harmonogramu w chwili wyboru (null = harmonogram sezonem nie sterował); jego zmiana kończy wybór */
  scheduled: PelletBoilerSeason | null;
  /** najbliższa granica okien wpisów sezonu: wtedy wybór się kończy; brak/null = bez wpisów sezonu */
  until?: Date | null;
};

export interface PelletBoilerPelux200Entry extends PelletBoilerPelux200Measurements {
  rootId: string;
  deviceType?: DeviceType;
  deviceId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
