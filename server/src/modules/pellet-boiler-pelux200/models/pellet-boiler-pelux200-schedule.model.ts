// Harmonogram kotła (kolekcje pellet_boiler_pelux200_schedules i ..._schedule_settings).
// Wpis: CWU od–do albo sezon Lato / Zima (type season, od 2026-10-04, opcjonalnie z progiem temperatury
// zewnętrznej coldBelow) w oknie godzin (dzień tygodnia albo data, jak harmonogram włącznika), osobno dla
// trybu pracy „heat-pump” (pompa ciepła) i „pellet”. Ustawienia: harmonogram działa / nie działa (enabled,
// przyciski „Włącz/Wyłącz regulator”), CWU i sezon poza harmonogramem dla każdego trybu, nastawy kotła stosowane
// przy przełączeniu trybu (profiles) i ostatnio zastosowany stan. Dawne wpisy pracy kotła (type work,
// usunięte 2026-10-04) zostają w bazie, ale są pomijane.
import { Schema, model } from 'mongoose';
import { WeekDay } from '../../../core/types';
import { PelletBoilerScheduleEntry, PelletBoilerScheduleSettings } from '../types';

const time = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mode = { type: String, enum: ['heat-pump', 'pellet'] };
const cwu = { cwuFrom: Number, cwuTo: Number };
const season = { type: String, enum: ['winter', 'summer'] };

const PelletBoilerScheduleSchema = new Schema<PelletBoilerScheduleEntry>(
  {
    rootId: { type: String, required: true },
    type: { type: String, default: 'cwu' },
    mode: { ...mode, required: true },
    enabled: { type: Boolean, default: true },
    dayOfWeek: { type: Number, enum: Object.values(WeekDay).filter((v) => typeof v === 'number') },
    date: { type: Date },
    startTime: { type: String, match: time, required: true },
    endTime: { type: String, match: time, required: true },
    cwuFrom: { type: Number },
    cwuTo: { type: Number },
    // type season: „Tryb Zima” w oknie, opcjonalnie według temperatury zewnętrznej (Zima poniżej winterBelow,
    // Lato powyżej summerAbove); coldBelow to dawny jeden próg (do 2026-10-15)
    season,
    winterBelow: { type: Number },
    summerAbove: { type: Number },
    coldBelow: { type: Number },
  },
  { timestamps: true, collection: 'pellet_boiler_pelux200_schedules' }
);
PelletBoilerScheduleSchema.index({ rootId: 1, mode: 1 });

export const PelletBoilerScheduleModel = model<PelletBoilerScheduleEntry>(
  'PelletBoilerSchedule', PelletBoilerScheduleSchema);

const PelletBoilerScheduleSettingsSchema = new Schema<PelletBoilerScheduleSettings>(
  {
    rootId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    // cwuUnchanged: CWU poza wpisami „bez zmiany” (harmonogram nie zleca nr 119 i 123)
    defaults: { 'heat-pump': { ...cwu, season, cwuUnchanged: Boolean }, pellet: { ...cwu, season, cwuUnchanged: Boolean } },
    // nastawy trybu: klucz „ecomax:<nr>” albo „mixer<n>:<nr>” → wartość surowa
    profiles: { 'heat-pump': { type: Schema.Types.Mixed }, pellet: { type: Schema.Types.Mixed } },
    lastApplied: { mode, ...cwu, season, seasonScheduleId: String, paused: Boolean, pelletCwu: Boolean, cwuUnchanged: Boolean },
    lastAppliedAt: { type: Date },
    lastError: { type: String },
    // ładowanie CWU w trybie pompy ciepła (pellet-boiler-pelux200-cwu-loading.service.ts)
    cwuLoading: { type: Schema.Types.Mixed },
    // automatyczne przejście na Pellet po rozpalaniu w trybie pompy ciepła (komunikat do „OK”)
    autoPellet: { type: Schema.Types.Mixed },
    // cykl Zimy w trybie pompy ciepła (pellet-boiler-pelux200-winter-cycle.service.ts) i sezon z przycisku
    winterCycle: { type: Schema.Types.Mixed },
    manualSeason: { type: Schema.Types.Mixed },
    // CWU z peletu w trybie pompy ciepła (pellet-boiler-pelux200-pellet-cwu.service.ts): znacznik i faza
    pelletCwu: { type: Schema.Types.Mixed },
    // włączenie regulatora po nagrzaniu kotła (pellet-boiler-pelux200-turn-on.service.ts)
    pendingTurnOn: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'pellet_boiler_pelux200_schedule_settings', minimize: false }
);

export const PelletBoilerScheduleSettingsModel = model<PelletBoilerScheduleSettings>(
  'PelletBoilerScheduleSettings', PelletBoilerScheduleSettingsSchema);
