// Ustawienia aplikacji (kolekcja app_settings, od 2026-11-07; kolekcja settings to pozostałość po dawnym modelu ustawień czasowych pompy), zmieniane na ekranie konta systemowego: jeden dokument,
// a jego _id to nazwa bazy (core/services/settings.service.ts). Kopia produkcji odtworzona pod inną nazwą
// (hpdb_test) ma dokument z _id hpdb, więc środowisko testowe go nie użyje.
import mongoose, { Schema } from 'mongoose';

export interface SettingsEntry {
  _id: string;
  values: Record<string, string>;
  updatedAt: Date;
}

const SettingsSchema = new Schema<SettingsEntry>({
  _id: { type: String, required: true },
  values: { type: Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'app_settings', versionKey: false, minimize: false });

export const SettingsModel = mongoose.models.AppSettings as mongoose.Model<SettingsEntry>
  ?? mongoose.model<SettingsEntry>('AppSettings', SettingsSchema);
