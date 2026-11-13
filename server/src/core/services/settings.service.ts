// Ustawienia aplikacji w bazie (od 2026-11-07, decyzja użytkownika): poczta, adres kodów konta system, adres klienta,
// wersja demo, klucze powiadomień i zadania w tle. W środowisku zostaje tylko MONGODB_URI, a PORT służy pracy lokalnej
// (SYSTEM_PASSWORD od 2026-11-13 nie jest używane: konto system loguje się kodem z maila, auth.service.ts).
// Serwer czyta dokument raz po połączeniu z bazą i trzyma go w pamięci, więc setting() jest synchroniczne.
// Brak wartości w bazie: wartość ze środowiska, używana tylko lokalnie i w testach (npm run local, vitest).
// Dokument dotyczy bazy o nazwie równej jego _id, więc kopia produkcji pod inną nazwą nie włączy poczty ani zadań w tle.
// Sekrety są w bazie jawnym tekstem i w jej kopiach; API ich nie zwraca, podaje tylko, czy są ustawione.
// Odczyt i zapis: tylko zalogowane konto system (middleware/session.ts, systemOnly), bez dodatkowego hasła
// (do 2026-11-13 hasło ustawień z nazwą dnia tygodnia).
import mongoose from 'mongoose';
import { SettingsModel } from '../models/settings.model';

export const SETTING_GROUPS = ['mail', 'app', 'push', 'server'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

const DEFINITIONS = {
  SMTP_HOST: { group: 'mail', kind: 'text' },
  SMTP_PORT: { group: 'mail', kind: 'port' },
  SMTP_USER: { group: 'mail', kind: 'text' },
  SMTP_PASS: { group: 'mail', kind: 'secret' },
  MAIL_FROM: { group: 'mail', kind: 'email' },
  MAIL_ADMIN: { group: 'mail', kind: 'email' },
  // adres, na który idzie kod logowania konta system (od 2026-11-13); pusty = MAIL_ADMIN (auth.service.ts systemEmail)
  SYSTEM_EMAIL: { group: 'mail', kind: 'email' },
  CLIENT_URL: { group: 'app', kind: 'urls' },
  DEMO_OWNER_EMAIL: { group: 'app', kind: 'email' },
  VAPID_PUBLIC_KEY: { group: 'push', kind: 'text' },
  VAPID_PRIVATE_KEY: { group: 'push', kind: 'secret' },
  VAPID_SUBJECT: { group: 'push', kind: 'text' },
  BACKGROUND_JOBS: { group: 'server', kind: 'jobs' },
  // adres:port QNAP-a w sieci domowej dla poleceń przez sterownik co (od 2026-11-13, próbnie, qnap.service.ts); bez
  // pola w aplikacji (hidden), zapis: --api PUT /settings '{"values":{"QNAP_ADRES":"…"}}' albo zmienna środowiska
  QNAP_ADRES: { group: 'server', kind: 'hostport', hidden: true },
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

// Widok dla ekranu ustawień: wartości z bazy, bez sekretów i bez wartości ze środowiska; bez ustawień ukrytych (hidden).
export const settingsView = (): SettingView[] => SETTING_KEYS.filter((key) => !('hidden' in DEFINITIONS[key])).map((key) => {
  const { group, kind } = DEFINITIONS[key];
  const value = values[key];
  return { key, group, kind, isSet: value !== undefined, ...(kind !== 'secret' && value !== undefined ? { value } : {}) };
});

/** „a.b.c.d:port” w sieci prywatnej (10/8, 172.16/12, 192.168/16), jak sprawdza firmware co i usługa na QNAP-ie */
export function isPrivateHostPort(text: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text);
  if (!match) return false;
  const [a, b, c, d, port] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255) || port < 1 || port > 65535) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

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
  jobs: (text) => text === 'on' || text === 'off',
  hostport: isPrivateHostPort,
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

/** testy: bez wartości z bazy */
export const resetSettingsCache = () => { values = {}; };
