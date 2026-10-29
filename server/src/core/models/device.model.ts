// Model urządzenia (kolekcja devices): rodzaj, deviceId (SN sterownika), nazwa,
// sterownik domyślny, ustawienia (properties) i — dla pompy ciepła — osadzone
// harmonogramy. _id dokumentu to rootId używany w API, WebSocket i rekordach danych.
import { forgetDevices } from '../services/device-cache-store';
import mongoose, { Schema, Model, Document } from 'mongoose';
import { Device, DeviceProperties, DeviceType } from '../types';
import { ScheduleEntrySchema } from '../../modules/heat-pump/models/schedule.model';

// Ustawienia wszystkich rodzajów sterowników w jednym polu properties.
const DevicePropertiesSchema = new Schema<DeviceProperties>(
  {
    // pompa ciepła: tryb pracy i temperatura od–do; M, A, CWU i pary co_*/cwu_* to dawne ustawienia
    temp_min: { type: String },
    temp_max: { type: String },
    co_min: { type: String },
    co_max: { type: String },
    cwu_min: { type: String },
    cwu_max: { type: String },
    work_mode: {
      type: String,
      enum: ['MANUAL', 'AUTO', 'OFF', 'M', 'A', 'CWU'],
      // domyślna wartość dopisuje się także hydroforowi, który jej nie używa
      default: 'MANUAL',
    },
    // hydrofor
    compressor_seconds: { type: Number, min: 1, max: 3600 },
    // kocioł pelletowy Pellux 200; pełne sekundy, sprawdzane też przy PUT /device/properties
    poll_interval_seconds: {
      type: Number, min: 30, max: 3600,
      validate: { validator: Number.isInteger, message: 'poll_interval_seconds: pełne sekundy 30–3600.' },
    },
    // kocioł pelletowy: aktualna cena pelletu [zł/t] do kosztu ogrzewania na wykresie (2026-10-13, domyślnie 2000)
    pellet_price_per_ton: { type: Number, min: 0, max: 100000 },
    // włącznik: domyślny czas włączenia w pełnych minutach, 0 = bez limitu, najwyżej 7 dni
    default_on_minutes: {
      type: Number, min: 0, max: 10080,
      validate: { validator: Number.isInteger, message: 'default_on_minutes: pełne minuty 0–10080.' },
    },
  },
  { _id: false }
);

export interface DeviceDocument extends Device, Document {
  createdAt: Date;
  updatedAt: Date;
}

const DeviceSchema = new Schema<DeviceDocument>(
  {
    deviceType: {
      type: String,
      enum: Object.values(DeviceType),
      required: true,
    },
    // SN sterownika (MAC ESP32, 12 znaków hex); bez indeksu unikalnego
    deviceId: {
      type: String,
      required: true,
      trim: true,
    },
    // nazwa nadawana przez użytkownika; sterownik zarejestrowany automatycznie jej nie ma
    name: {
      type: String,
      default: '',
      trim: true,
    },
    // miejsce kafelka na liście /devices (0 = pierwszy), ustawiane w trybie „Zmień kolejność”; brak = na końcu, po nazwie
    sortOrder: { type: Number },
    // kafelek ukryty na liście /devices (widoczny tylko w trybie „Zmień kolejność”)
    hidden: { type: Boolean, default: false },
    // wersja firmware ze zgłoszenia sterownika (strona /firmware); starsze sterowniki jej nie wysyłają
    firmwareVersion: { type: String, trim: true },
    firmwareSeenAt: { type: Date },
    // zlecenie aktualizacji z aplikacji („Aktualizuj”): oferta idzie do sterownika tylko przy nim
    // (core/services/firmware.service.ts); znika, gdy sterownik zgłosi oferowaną wersję
    firmwareUpdate: {
      type: new Schema({ version: { type: String, required: true }, requestedAt: { type: Date, required: true } }, { _id: false }),
      default: undefined,
    },
    // przekaźnik poczty (włącznik, co): klucz publiczny P-256 płytki ze zgłoszenia (pole mailKey). Zatwierdzony
    // (mailKey) dostaje zaszyfrowane dane SMTP i maile; inny klucz czeka w mailKeyPending na zatwierdzenie
    // w aplikacji (użytkownik systemowy), żeby nikt znający SN nie podstawił swojego (mail-relay.service.ts)
    mailKey: {
      type: new Schema({ publicKey: String, fingerprint: String, approvedAt: Date, seenAt: Date }, { _id: false }),
      default: undefined,
    },
    mailKeyPending: {
      type: new Schema({ publicKey: String, fingerprint: String, seenAt: Date }, { _id: false }),
      default: undefined,
    },
    // adres IPv4 sterownika w sieci lokalnej ze zgłoszenia (pole ip) i czas tego zgłoszenia
    ipAddress: { type: String, trim: true },
    ipSeenAt: { type: Date },
    // pompa ciepła: definicja sterownika (okno „Dane sterownika”), walidacja w device.service.ts
    pumpConfig: {
      type: new Schema({
        connection: { type: String, enum: ['cwu', 'co'], required: true },
        tankLiters: { type: Number }, // opcjonalna: brak = nie wpisana
        pvDtu: { type: Boolean, required: true },
        pvForce: { type: Boolean, required: true },
      }, { _id: false }),
      default: undefined,
    },
    // kocioł pelletowy: powiązana pompa ciepła (Root ID urządzenia heat_pump albo null), walidacja w device.service.ts
    boilerConfig: {
      type: new Schema({
        heatPumpRootId: { type: String, default: null },
      }, { _id: false }),
      default: undefined,
    },
    // właściciel (konta użytkowników, 2026-10-11): _id z users; brak = sterownik bez właściciela (widzi go tylko
    // użytkownik systemowy). Sterownik zgłaszający się sam nie dostaje właściciela.
    ownerId: { type: String, default: null, index: true },
    // pompa ciepła (dawne pole settings — starszy model ustawień czasowych — usunięte 2026-10-21; w starych dokumentach zostaje, schemat je pomija)
    schedules: { type: [ScheduleEntrySchema] },
    properties: { type: DevicePropertiesSchema },
  },
  { timestamps: true, collection: 'devices' }
);

// Każdy zapis do devices kasuje pamięć dokumentów urządzeń (core/services/device-cache.service.ts, 2026-10-29).
// Zapis przerwany błędem (rzadki) pokrywa odświeżanie pamięci po DEVICE_CACHE_TTL_MS.
DeviceSchema.post('save', () => forgetDevices());
DeviceSchema.post(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  () => forgetDevices(),
);
DeviceSchema.post('insertMany', () => forgetDevices());
DeviceSchema.post('bulkWrite', () => forgetDevices());

// Nazwa modelu „Root” jest historyczna; kolekcja to devices.
// mongoose.models.Root chroni przed ponowną rejestracją modelu (testy, hot reload).
export const DeviceModel: Model<DeviceDocument> =
  mongoose.models.Root ||
  mongoose.model<DeviceDocument>('Root', DeviceSchema);
