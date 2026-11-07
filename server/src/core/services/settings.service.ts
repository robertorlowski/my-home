// Ustawienia aplikacji w bazie (od 2026-11-07, decyzja użytkownika): poczta, adres klienta, wersja demo, klucze
// powiadomień i zadania w tle. W środowisku zostają tylko MONGODB_URI i SYSTEM_PASSWORD, a PORT służy pracy lokalnej.
// Serwer czyta dokument raz po połączeniu z bazą i trzyma go w pamięci, więc setting() jest synchroniczne.
// Brak wartości w bazie: wartość ze środowiska, używana tylko lokalnie i w testach (npm run local, vitest).
// Dokument dotyczy bazy o nazwie równej jego _id, więc kopia produkcji pod inną nazwą nie włączy poczty ani zadań w tle.
// Sekrety są w bazie jawnym tekstem i w jej kopiach; API ich nie zwraca, podaje tylko, czy są ustawione.
// Odczyt i zapis wymagają konta systemowego i osobnego hasła ustawień (niżej).
import crypto from 'crypto';
import { formatInTimeZone } from 'date-fns-tz';
import mongoose from 'mongoose';
import { TIME_ZONE } from '../time';
import { SettingsModel } from '../models/settings.model';

export const SETTING_GROUPS = ['mail', 'app', 'push', 'server'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

const DEFINITIONS = {
  MAIL_RELAY: { group: 'mail', kind: 'relay' },
  SMTP_HOST: { group: 'mail', kind: 'text' },
  SMTP_PORT: { group: 'mail', kind: 'port' },
  SMTP_USER: { group: 'mail', kind: 'text' },
  SMTP_PASS: { group: 'mail', kind: 'secret' },
  MAIL_FROM: { group: 'mail', kind: 'email' },
  MAIL_ADMIN: { group: 'mail', kind: 'email' },
  CLIENT_URL: { group: 'app', kind: 'urls' },
  DEMO_OWNER_EMAIL: { group: 'app', kind: 'email' },
  VAPID_PUBLIC_KEY: { group: 'push', kind: 'text' },
  VAPID_PRIVATE_KEY: { group: 'push', kind: 'secret' },
  VAPID_SUBJECT: { group: 'push', kind: 'text' },
  BACKGROUND_JOBS: { group: 'server', kind: 'jobs' },
} as const;

export type SettingKey = keyof typeof DEFINITIONS;
export const SETTING_KEYS = Object.keys(DEFINITIONS) as SettingKey[];

export class SettingsError extends Error {
  constructor(public key: string) {
    super(`Nieprawidłowe ustawienie: ${key}`);
  }
}

let values: Partial<Record<SettingKey, string>> = {};

export const setting = (key: SettingKey): string | undefined => values[key] ?? process.env[key];

const documentId = () => {
  const name = mongoose.connection.db?.databaseName;
  if (!name) throw new Error('Brak połączenia z bazą danych.');
  return name;
};

export async function loadSettings(): Promise<void> {
  const entry = await SettingsModel.findById(documentId()).lean();
  values = (entry?.values ?? {}) as Partial<Record<SettingKey, string>>;
}

export type SettingView = { key: SettingKey; group: SettingGroup; kind: string; isSet: boolean; value?: string };

// Widok dla ekranu ustawień: wartości z bazy, bez sekretów i bez wartości ze środowiska.
export const settingsView = (): SettingView[] => SETTING_KEYS.map((key) => {
  const { group, kind } = DEFINITIONS[key];
  const value = values[key];
  return { key, group, kind, isSet: value !== undefined, ...(kind !== 'secret' && value !== undefined ? { value } : {}) };
});

const isEmail = (text: string) => /^[^\s@]+@[^\s@]+$/.test(text);
const isHttpUrl = (text: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
};

const VALIDATORS: Record<string, (text: string) => boolean> = {
  text: () => true,
  secret: () => true,
  email: isEmail,
  port: (text) => /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535,
  relay: (text) => text === '1' || text === '0',
  jobs: (text) => text === 'on' || text === 'off',
  urls: (text) => text.split(',').every((url) => isHttpUrl(url.trim())),
};

// Zmienia tylko podane klucze; pusty tekst albo null usuwa wartość.
export async function saveSettings(changes: Record<string, unknown>): Promise<SettingView[]> {
  const set: Record<string, string> = {};
  const unset: Record<string, ''> = {};
  for (const [key, raw] of Object.entries(changes)) {
    if (!(key in DEFINITIONS)) throw new SettingsError(key);
    if (raw !== null && typeof raw !== 'string') throw new SettingsError(key);
    const definition = DEFINITIONS[key as SettingKey];
    const text = definition.kind === 'secret' ? raw ?? '' : (raw ?? '').trim();
    if (text === '') {
      unset[`values.${key}`] = '';
    } else {
      if (!VALIDATORS[definition.kind](text)) throw new SettingsError(key);
      set[`values.${key}`] = text;
    }
  }
  await SettingsModel.updateOne(
    { _id: documentId() },
    { $set: { ...set, updatedAt: new Date() }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { upsert: true, strict: false },
  );
  await loadSettings();
  return settingsView();
}

// ------------------------------------------------------------------ hasło ustawień

// Decyzja użytkownika 2026-11-07: hasło konta system i polska nazwa dnia tygodnia (czas warszawski), np. …Sobota.
// Serwer sprawdza je przy każdym odczycie i zapisie; klient trzyma je tylko w pamięci karty.
const WEEKDAYS = ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const failures = { count: 0, lockedUntil: 0 };

export class SettingsLockError extends Error {
  constructor(public status: 403 | 429) {
    super('Ustawienia zablokowane.');
  }
}

export const settingsPassword = (now = new Date()): string | null => {
  const base = process.env.SYSTEM_PASSWORD;
  return base ? `${base}${WEEKDAYS[Number(formatInTimeZone(now, TIME_ZONE, 'i')) - 1]}` : null;
};

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest();

export function checkSettingsPassword(password: unknown, now = new Date()): void {
  if (failures.lockedUntil > now.getTime()) throw new SettingsLockError(429);
  const expected = settingsPassword(now);
  if (expected && typeof password === 'string' && crypto.timingSafeEqual(sha256(password), sha256(expected))) {
    failures.count = 0;
    return;
  }
  failures.count += 1;
  if (failures.count >= MAX_FAILURES) {
    failures.count = 0;
    failures.lockedUntil = now.getTime() + LOCK_MS;
  }
  throw new SettingsLockError(403);
}

/** testy */
export const resetSettingsLock = () => { failures.count = 0; failures.lockedUntil = 0; };

/** testy: bez wartości z bazy */
export const resetSettingsCache = () => { values = {}; };
