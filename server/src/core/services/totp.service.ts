// Logowanie kodem z aplikacji na telefonie (TOTP, od 2026-11-13): mechanizm wspólny z Archiwum i panelem admin, według
// planu oracle-cloud/vm-prod/admin/docs/plan-logowanie-system-kodem.md („Logowanie kodem z aplikacji na telefonie”
// i „Ustalenia techniczne wspólne dla aplikacji”). W telefonie jest jeden wpis „mojeturnie.pl” na adres e-mail, a ten sam
// kod działa we wszystkich aplikacjach, bo klucze leżą we wspólnej bazie MongoDB (nazwa LOGIN_KEYS_DB, domyślnie
// „logowanie”). Serwer łączy się z nią tym samym klientem co z własną bazą (mongoose useDb), więc konto bazy z MONGODB_URI
// musi mieć do niej rolę readWrite.
// - totp_klucze: {_id: adres małymi literami, sekret: "<iv>.<tag>.<szyfrogram>", utworzono: Date, aplikacja: "my-home"}
//   — jeden dokument na adres; sekret to surowe 20 bajtów zaszyfrowane AES-256-GCM kluczem LOGOWANIE_KLUCZ (iv 12 B,
//   znacznik 16 B, bez danych dodatkowych), części w base64url bez dopełnienia. Usunięcie dokumentu wyłącza kod z telefonu
//   we wszystkich aplikacjach.
// - totp_uzyte: {_id: "<adres>:<numer okna 30 s, w którym kod pasuje>", czas: Date}, indeks TTL 180 s na czas; dokument
//   jest wstawiany przed przyjęciem kodu, a duplikat oznacza, że kod już użyto (także w innej aplikacji).
// - TOTP: RFC 6238 (HOTP z RFC 4226), HMAC-SHA1, 6 cyfr, okno 30 s, przyjmowane okno bieżące i po jednym obok (±30 s).
// Bez LOGOWANIE_KLUCZ (32 bajty w base64, tylko w środowisku serwera, nigdy w bazie ani w repozytorium) albo bez dostępu
// do bazy kod z telefonu jest wyłączony, a kod z maila działa jak dotąd. Limity prób, sesje, rejestracja i komunikaty
// są w auth.service.ts; tu tylko mechanizm (kody, szyfrowanie, baza kluczy, kod QR).
import crypto from 'crypto';
import mongoose from 'mongoose';
import { toDataURL } from 'qrcode';

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** okna przyjmowane po obu stronach bieżącego */
const TOTP_DRIFT = 1;
const SECRET_BYTES = 20;
const USED_TTL_S = 180;
export const TOTP_ISSUER = 'mojeturnie.pl';
/** pole aplikacja w totp_klucze: gdzie zarejestrowano telefon */
export const TOTP_APP = 'my-home';
const KEYS = 'totp_klucze';
const USED = 'totp_uzyte';

/** nazwa wspólnej bazy kluczy (środowisko testowe: logowanie_test) */
export const loginKeysDbName = () => (process.env.LOGIN_KEYS_DB ?? '').trim() || 'logowanie';

/** baza kluczy niedostępna (brak uprawnień, brak połączenia) albo klucz nie odszyfrowuje się tym LOGOWANIE_KLUCZ */
export class TotpStoreError extends Error {}

// ------------------------------------------------------------------ klucz szyfrujący

// Klucz jak w Archiwum (vm-prod/archiwum/server/src/core/totp.ts): zwykłe base64, po odkodowaniu dokładnie 32 bajty;
// każda aplikacja musi uznać ten sam napis za poprawny albo zły, inaczej jedna widziałaby telefon, a druga nie.
function encryptionKey(): Buffer | null {
  const text = (process.env.LOGOWANIE_KLUCZ ?? '').trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const key = Buffer.from(text, 'base64');
  return key.length === 32 ? key : null;
}

export const totpConfigured = () => encryptionKey() !== null;

/** powód wyłączenia kodu z telefonu w konfiguracji (dziennik przy starcie) albo null */
export function totpConfigProblem(): string | null {
  if (!(process.env.LOGOWANIE_KLUCZ ?? '').trim()) return 'brak LOGOWANIE_KLUCZ';
  return encryptionKey() ? null : 'LOGOWANIE_KLUCZ to nie 32 bajty w base64';
}

// ------------------------------------------------------------------ base32 (RFC 4648, bez dopełnienia)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** klucz przepisany ręcznie: wielkość liter, spacje, myślniki i dopełnienie bez znaczenia */
export function base32Decode(text: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Znak spoza base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ kody (RFC 4226 / RFC 6238)

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** numer okna 30 s (licznik TOTP) */
export const totpWindow = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_S);

export const totpCode = (secret: Buffer, now = Date.now()) => hotp(secret, totpWindow(now));

/** okno, w którym kod pasuje (bieżące albo jedno obok), albo null; porównanie w stałym czasie */
export function matchTotp(secret: Buffer, code: string, now = Date.now()): number | null {
  if (code.length !== TOTP_DIGITS || !/^\d+$/.test(code)) return null;
  const current = totpWindow(now);
  let found: number | null = null;
  for (let window = current - TOTP_DRIFT; window <= current + TOTP_DRIFT; window += 1) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, window)), Buffer.from(code)) && found === null) found = window;
  }
  return found;
}

export const newTotpSecret = () => crypto.randomBytes(SECRET_BYTES);

/** adres dla kodu QR; w telefonie widać „mojeturnie.pl” i adres e-mail. Znaki adresu, które w URI coś znaczą, są
 *  kodowane, a „@” zostaje, jak w opisie formatu i w Archiwum (ten sam wpis w telefonie z każdej aplikacji) */
export const otpauthUrl = (address: string, secretBase32: string) =>
  `otpauth://totp/${TOTP_ISSUER}:${encodeURIComponent(address).replace(/%40/g, '@')}?secret=${secretBase32}&issuer=${TOTP_ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;

/** kod QR jako obrazek PNG (data URL), ciemne moduły na białym tle niezależnie od motywu aplikacji */
export const qrDataUrl = (text: string) => toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 240 });

// ------------------------------------------------------------------ szyfrowanie sekretu

export function encryptSecret(secret: Buffer, key = encryptionKey()): string {
  if (!key) throw new TotpStoreError('brak LOGOWANIE_KLUCZ');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(text: string, key = encryptionKey()): Buffer {
  if (!key) throw new TotpStoreError('brak LOGOWANIE_KLUCZ');
  const parts = String(text).split('.');
  if (parts.length !== 3) throw new TotpStoreError('zły format sekretu w totp_klucze');
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new TotpStoreError('zły format sekretu w totp_klucze');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new TotpStoreError('sekret z totp_klucze nie odszyfrowuje się (inny LOGOWANIE_KLUCZ niż w aplikacji, która go zapisała?)');
  }
}

// ------------------------------------------------------------------ wspólna baza kluczy

export interface TotpKeyDoc {
  _id: string;
  sekret: string;
  utworzono: Date;
  aplikacja: string;
}

interface TotpUsedDoc {
  _id: string;
  czas: Date;
}

const store = () => mongoose.connection.useDb(loginKeysDbName(), { useCache: true });
const keys = () => store().collection<TotpKeyDoc>(KEYS);
const used = () => store().collection<TotpUsedDoc>(USED);

const storeError = (error: unknown) =>
  (error instanceof TotpStoreError ? error : new TotpStoreError(`baza ${loginKeysDbName()}: ${(error as Error)?.message ?? String(error)}`));
const duplicate = (error: unknown) => (error as { code?: number })?.code === 11000;

async function guard<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw storeError(error);
  }
}

/** dokument klucza adresu albo null; rzuca TotpStoreError, gdy baza jest niedostępna */
export const findTotpKey = (address: string) => guard(() => keys().findOne({ _id: address }));

/** zapis po pierwszym poprawnym kodzie; false, gdy adres ma już klucz (także z innej aplikacji) */
export async function insertTotpKey(address: string, secret: Buffer): Promise<boolean> {
  const doc: TotpKeyDoc = { _id: address, sekret: encryptSecret(secret), utworzono: new Date(), aplikacja: TOTP_APP };
  try {
    await keys().insertOne(doc);
    return true;
  } catch (error) {
    if (duplicate(error)) return false;
    throw storeError(error);
  }
}

export const deleteTotpKey = (address: string) => guard(async () => (await keys().deleteOne({ _id: address })).deletedCount > 0);

// indeks TTL zakłada pierwsza aplikacja, która go potrzebuje; ten sam indeks założony już gdzie indziej (także z innymi
// opcjami) nie przeszkadza w sprawdzaniu kodów, więc błąd jest tylko w dzienniku
let usedIndex: Promise<void> | null = null;
const ensureUsedIndex = () => {
  usedIndex ??= Promise.resolve()
    .then(() => used().createIndex({ czas: 1 }, { expireAfterSeconds: USED_TTL_S }))
    .then(() => undefined)
    .catch((error) => console.warn(`[totp] indeks TTL ${USED}:`, (error as Error)?.message ?? error));
  return usedIndex;
};

/** znak „kod z okna window użyty”; false = już użyty (w tej albo innej aplikacji) */
export async function markTotpUsed(address: string, window: number): Promise<boolean> {
  await ensureUsedIndex();
  try {
    await used().insertOne({ _id: `${address}:${window}`, czas: new Date() });
    return true;
  } catch (error) {
    if (duplicate(error)) return false;
    throw storeError(error);
  }
}

/** przy starcie serwera: powód, dla którego kod z telefonu nie działa, albo null */
export async function totpProblem(): Promise<string | null> {
  const config = totpConfigProblem();
  if (config) return config;
  try {
    await keys().findOne({}, { projection: { _id: 1 } });
    return null;
  } catch (error) {
    return storeError(error).message;
  }
}

/** testy: indeks zakładany od nowa */
export const resetTotpIndex = () => { usedIndex = null; };
