// Typy kotła pelletowego Plum Pellux 200 (regulator ecoMAX): odczyt ze sterownika.
// Kontrakt z modułem serwera pellet-boiler-pelux200; wszystkie pola odczytu są opcjonalne.

import type { WeekDay } from '../../core/types';

export type PelletBoilerReading = {
  createdAt?: string;
  /** GET /last: czy kocioł przesyła dane (odczyt młodszy niż 3 odstępy odpytywania, najmniej 3 min) */
  responding?: boolean;
  /** stan kotła 0..11 (BOILER_STATE_NAMES) */
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
  // temperatury zadane [°C] i stany obiegów (liczby z regulatora)
  heating_target?: number;
  water_heater_target?: number;
  heating_status?: number;
  water_heater_status?: number;
  // paliwo i praca
  fuel_level?: number;
  fan_power?: number;
  boiler_load?: number;
  boiler_power?: number;
  fuel_consumption?: number;
  lambda_level?: number;
  // wyjścia
  fan?: boolean;
  feeder?: boolean;
  heating_pump?: boolean;
  water_heater_pump?: boolean;
  circulation_pump?: boolean;
  lighter?: boolean;
  alarm?: boolean;
  // mieszacze 1 (grzejniki) i 2 od firmware 1.2.0; brak pól = niepodłączony albo starszy firmware
  /** termostat pokojowy eSTER: temperatura w pokoju i zadana (firmware pieca od 1.8.0) */
  room_temp?: number;
  room_target_temp?: number;
  mixer1_temp?: number;
  mixer1_target?: number;
  mixer1_pump?: boolean;
  mixer1_opening?: boolean;
  mixer1_closing?: boolean;
  mixer2_temp?: number;
  mixer2_target?: number;
  /** liczba aktywnych alarmów kotła (firmware pieca od 1.7.0) */
  alerts_active?: number;
  /** narastający licznik spalonego pelletu [kg] (firmware pieca od 1.7.1) */
  fuel_burned_kg?: number;
  /** tylko w kliencie (zakładka Dane): przyrost licznika od poprzedniego odczytu [kg] */
  fuel_delta_kg?: number;
  mixer2_pump?: boolean;
  mixer2_opening?: boolean;
  mixer2_closing?: boolean;
  /** tryb „Pompa ciepła”: sprężarka pompy ciepła pracowała przy zapisie odczytu (dopisuje serwer) */
  heat_pump_running?: boolean;
};

/** Parametr regulatora z GET /pellet-boiler-pelux200/settings (rozkodowany na serwerze). */
export type PelletBoilerParameter = {
  /** numer parametru w regulatorze (ramka zmiany 0x33 / 0x34) */
  index: number;
  /** nazwa w PyPlumIO, null dla pozycji bez nazwy */
  name: string | null;
  label?: string;
  description?: string;
  /** ocena zmiany: „Bezpieczny z aplikacji”, „Ostrożnie”, „Tylko serwis”, „Nie ruszać” */
  rating?: string;
  unit?: string;
  kind?: 'switch';
  /** wartość = (surowa − offset) × step (brak = 1 i 0); z nich aplikacja liczy wartość surową zlecenia */
  step?: number;
  offset?: number;
  value: number;
  min: number;
  max: number;
  raw: [number, number, number];
  /** wartość nieznana: regulator nie podaje tej nastawy (mieszacz 2); value i raw[0] to wtedy minimum */
  unknown?: boolean;
};

/** Zmiana parametru dla regulatora: kotła (0x33) albo mieszacza (0x34), wartość surowa (bajt). */
export type PelletBoilerChange = {
  /** control: włącz (1) / wyłącz (0) regulator; schedule: harmonogram nr index włącz (1) / wyłącz (0) */
  kind: 'ecomax' | 'mixer' | 'control' | 'schedule';
  /** numer mieszacza od 1 */
  mixer?: number;
  index: number;
  value: number;
  /** wysłać dopiero, gdy kocioł zgłosi stan „wyłączony” (zmiana trybu pracy) */
  waitOff?: boolean;
};

/** Zlecenie zmiany z GET/POST /pellet-boiler-pelux200/commands. */
export type PelletBoilerCommand = PelletBoilerChange & {
  _id: string;
  previous?: number;
  label?: string;
  /** pending: czeka na sterownik, sent: u sterownika, done: regulator potwierdził, replaced: zastąpione nowszym */
  status: 'pending' | 'sent' | 'done' | 'error' | 'replaced';
  error?: string;
  createdAt: string;
  doneAt?: string;
};

/** Tryb pracy kotła: pompa ciepła (bez palenia) albo pellet. */
export type PelletBoilerMode = 'heat-pump' | 'pellet';

/** Sezon regulatora (nr 125): zima (CO i CWU) albo lato (tylko CWU). */
export type PelletBoilerSeason = 'winter' | 'summer';

/** Wpis harmonogramu dla trybu w oknie godzin: type cwu = CWU od–do (od = start ładowania, do = zadana),
 *  type season = „Tryb Zima” (od 2026-10-15), opcjonalnie według temperatury zewnętrznej: Zima poniżej winterBelow,
 *  Lato powyżej summerAbove, między progami bez zmiany. coldBelow = dawny jeden próg (Lato powyżej progu + 0,5 °C). */
export type PelletBoilerSchedule = {
  _id?: string;
  type: 'cwu' | 'season';
  mode: PelletBoilerMode;
  enabled: boolean;
  dayOfWeek?: WeekDay;
  date?: string;
  startTime: string;
  endTime: string;
  cwuFrom?: number;
  cwuTo?: number;
  season?: PelletBoilerSeason;
  winterBelow?: number | null;
  summerAbove?: number | null;
  coldBelow?: number | null;
};

/** Progi wpisu „Tryb Zima” (dawny coldBelow: Lato powyżej progu + 0,5 °C); null = bez temperatury, Zima przez całe okno. */
export const seasonThresholds = (schedule: PelletBoilerSchedule): { winterBelow: number; summerAbove: number } | null =>
  typeof schedule.winterBelow === 'number'
    ? { winterBelow: schedule.winterBelow, summerAbove: schedule.summerAbove ?? schedule.winterBelow + 0.5 }
    : typeof schedule.coldBelow === 'number' ? { winterBelow: schedule.coldBelow, summerAbove: schedule.coldBelow + 0.5 } : null;

export type PelletBoilerCwuRange = { cwuFrom: number; cwuTo: number };

/** Poza harmonogramem: CWU od–do i tryb pracy Lato / Zima (brak = harmonogram go nie zmienia);
 *  cwuUnchanged: CWU „bez zmiany” — zostaje zadana z panelu kotła (od–do zapisane na później). */
export type PelletBoilerScheduleDefaults = PelletBoilerCwuRange & { season?: PelletBoilerSeason; cwuUnchanged?: boolean };

/** Nastawy trybu: klucz „ecomax:<nr>” albo „mixer<n>:<nr>” → wartość surowa. */
export type PelletBoilerProfile = Record<string, number>;

/** Ustawienia harmonogramu: działa / nie działa (enabled, przyciski „Włącz/Wyłącz regulator”),
 *  CWU poza harmonogramem oraz nastawy trybów. */
export type PelletBoilerScheduleSettings = {
  enabled: boolean;
  defaults: Record<PelletBoilerMode, PelletBoilerScheduleDefaults>;
  profiles: Record<PelletBoilerMode, PelletBoilerProfile>;
  lastError?: string;
};

export type PelletBoilerCurrentSchedule = {
  enabled: boolean;
  /** tryb z odczytu ustawień kotła; null bez odczytu */
  mode: PelletBoilerMode | null;
  /** cwuUnchanged: teraz poza wpisami CWU z „CWU bez zmiany” (harmonogram nie zmienia CWU w kotle);
   *  pelletCwu: tryb pompy ciepła ze znacznikiem „CWU - grzanie peletem” — CWU od–do i scheduleId z listy Pellet */
  state: ({ mode: PelletBoilerMode; season?: PelletBoilerSeason; cwuUnchanged?: boolean; pelletCwu?: boolean } & PelletBoilerCwuRange) | null;
  /** CWU ustawione teraz w kotle: zadana (nr 119) i „od” = zadana − histereza (nr 123) */
  boilerCwu?: Partial<PelletBoilerCwuRange>;
  /** tryb pompy ciepła (bez „CWU - grzanie peletem”) z zadaną CWU wyższą niż heatPumpCwuMax: pompa ciepła jej nie dogrzeje */
  cwuTooHigh?: boolean;
  /** do ilu grzeje włączona pompa ciepła powiązana z kotłem (temp_max z telemetrii); null: wyłączona, offline albo brak pompy */
  heatPumpCwuMax?: number | null;
  /** działający wpis CWU (null = poza harmonogramem) */
  scheduleId: string | null;
  /** działający wpis trybu pracy Lato / Zima (null = poza harmonogramem) */
  seasonScheduleId?: string | null;
  /** temperatura zewnętrzna z czujnika kotła; null bez świeżego pomiaru */
  outdoorTemperature?: number | null;
  /** cykl Zimy w trybie pompy ciepła; null = nie działa */
  winterCycle?: PelletBoilerWinterCycle | null;
  /** sezon wybrany przyciskiem w Ustawieniach (do zmiany sezonu z harmonogramu) */
  manualSeason?: PelletBoilerSeason | null;
  /** do kiedy działa sezon z przycisku (ISO); null = do zmiany sezonu w harmonogramie */
  manualSeasonUntil?: string | null;
  /** CWU z peletu w trybie pompy ciepła (znacznik w Ustawieniach) */
  pelletCwu?: PelletBoilerPelletCwu;
  /** pompa ciepła stoi przy kotle od tej temperatury [°C] (Ustawienia pompy ciepła; rusza 2 °C niżej) */
  hotBoilerFrom?: number;
  /** włączenie regulatora czeka na nagrzanie kotła; null = nie czeka */
  pendingTurnOn?: PelletBoilerPendingTurnOn | null;
  lastError: string | null;
};

/**
 * CWU z peletu w trybie „Pompa ciepła” (serwer: pellet-boiler-pelux200-pellet-cwu.service.ts): idle = czeka na CWU
 * poniżej „od” trybu Pellet, heating = kocioł grzeje CWU peletem, cooling = pompa ciepła czeka na kocioł < 50 °C.
 */
/** Czy „Włącz regulator” rozpali kocioł w trybie pompy ciepła (GET …/turn-on, 409 przy „włącz”). */
export type PelletBoilerTurnOnCheck = {
  mode: PelletBoilerMode;
  ignites: boolean;
  cause: 'boiler' | 'cwu' | 'mixer' | null;
  boilerTemp: number | null;
  cwuTemp: number | null;
  target?: number;
  startBelow?: number;
  cwuStartBelow?: number;
  /** włączenie zablokowane (GET); message: opis dla okna */
  blocked?: boolean;
  message?: string;
};

/** Włączenie regulatora czeka, aż kocioł nagrzeje się do startBelow. */
export type PelletBoilerPendingTurnOn = {
  since: string;
  startBelow: number | null;
  heatPumpStarted: boolean;
};

export type PelletBoilerPelletCwu = {
  enabled: boolean;
  phase: 'idle' | 'heating' | 'cooling';
  since: string | null;
  cwuFrom?: number;
  cwuTo?: number;
  /** koniec grzania: niższa z cwuTo i zadanej CWU w kotle [°C] */
  cwuEnd?: number;
  boilerTemp?: number | null;
  cwuTemp?: number | null;
  error?: string | null;
};

/** Cykl Zimy (tryb pompy ciepła): waiting = Lato, czeka na kocioł albo wodę w pompie ≥ max pompy ciepła − 3 °C (wymuszając
 *  start pompy ciepła); winter = Zima do kotła < 30 °C przy stojącej pompie CO. Tylko sezon i wymuszenie, bez mieszacza. */
export type PelletBoilerWinterCycle = {
  phase: 'waiting' | 'winter';
  since: string;
  temperature: number | null;
  /** próg Zimy w fazie waiting (max pompy ciepła − 3 °C) */
  winterFrom?: number;
  /** HP.Ttarget pompy ciepła w fazie waiting (próg Zimy sprawdzany też na nim) [°C] */
  pumpTemperature?: number | null;
  forcedAt?: string | null;
};

/** Ostatni odczyt ustawień regulatora; {} (brak readAt), gdy sterownik jeszcze ich nie wysłał. */
export type PelletBoilerSettings = {
  readAt?: string;
  groups?: { key: string; label: string; parameters: PelletBoilerParameter[] }[];
  /** assumed: regulator nie podaje nastaw mieszacza (mieszacz 2), parametry zakładane, wartości nieznane */
  mixers?: { mixer: number; parameters: PelletBoilerParameter[]; assumed?: boolean }[];
  /** przełączniki harmonogramów regulatora (4 = czyszczenie kotła); godziny ustawia się na panelu */
  schedules?: { index: number; name: string; label: string; enabled: boolean }[];
};

/** Ładowanie CWU w trybie pompy ciepła (GET /pellet-boiler-pelux200/cwu-loading); pompa ciepła grzeje wtedy 47–49 °C. */
export type PelletBoilerCwuLoading = {
  active: boolean;
  since: string | null;
  /** pompa ciepła w trybie OFF: nie dogrzeje wody */
  heatPumpOff: boolean;
  /** pompa ciepła wstrzymana: kocioł pali albo ma ≥ 50 °C, albo trwa CWU z peletu */
  pumpBlocked?: boolean;
  error?: string;
};

/** Automatyczne przejście na Pellet po rozpalaniu w trybie pompy ciepła (GET …/auto-pellet), do „OK”. */
export type PelletBoilerAutoPellet = {
  at: string;
  acknowledged: boolean;
  changes: number;
  error?: string;
};

// Dziennik alarmów z panelu kotła (GET /pellet-boiler-pelux200/alerts, firmware pieca od 1.7.0).
export type PelletBoilerAlert = {
  code: number;
  from: string;
  /** null = alarm trwa (albo trwał przy ostatnim przesłaniu) */
  to: string | null;
  active: boolean;
  /** data z nieustawionego zegara regulatora (rok < 2020, np. po zaniku zasilania) */
  uncertain: boolean;
  /** z pierwszego przesłania dziennika (historia sprzed wdrożenia): na liście tak, na pasku nie */
  initial: boolean;
};
export type PelletBoilerAlerts = { readAt: string | null; alerts: PelletBoilerAlert[] };

// Spalony pellet w okresie (GET /pellet-boiler-pelux200/fuel, firmware pieca od 1.7.1).
export type PelletBoilerFuelPeriod = 'day' | 'month' | 'year';
export type PelletBoilerFuel = {
  period: PelletBoilerFuelPeriod;
  date: string;
  buckets: { key: number; kg: number }[];
  totalKg: number;
  counterKg: number | null;
};
