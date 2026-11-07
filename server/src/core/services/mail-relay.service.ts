// Przekaźnik poczty przez sterowniki (2026-10-17). Render na darmowym planie blokuje wychodzące SMTP (porty 25,
// 465, 587), więc przy MAIL_RELAY=1 serwer nie łączy się z pocztą: składa wiadomość, odkłada ją w kolejce
// (mail_outbox) i budzi sterowniki komunikatem WebSocket „mail”. Wysyła włącznik (pierwszy), a gdy go nie ma
// albo nie odbierze maila w FAILOVER_MS, sterownik co — oba z domowego łącza, przez SMTP_HOST:587 (STARTTLS).
//
// Bezpieczeństwo: płytka sama tworzy parę kluczy P-256 (prywatny nie opuszcza płytki) i wysyła klucz publiczny
// w zgłoszeniu (pole mailKey). Klucz musi zatwierdzić w aplikacji użytkownik systemowy (odcisk widać też na
// stronie /install płytki): endpointy sterownika przyjmują sam SN, więc bez tego ktoś znający SN podstawiłby swój
// klucz. Dla zatwierdzonego klucza serwer szyfruje (ECDH P-256 + SHA-256 + AES-256-GCM, encryptFor): dane SMTP
// raz w odpowiedzi na zgłoszenie i w GET /mail/config (płytka trzyma je tylko w RAM, bez zapisu w NVS) oraz każdy
// mail w GET /mail/next (niesie kody logowania). Wynik (POST /mail/result) jest przyjmowany tylko z potwierdzeniem
// (receipt) z odszyfrowanego zadania.
import { setting } from './settings.service';
import crypto from 'crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { DeviceDocument, DeviceModel } from '../models/device.model';
import { MailOutboxDocument, MailOutboxModel } from '../models/mail-outbox.model';
import { DeviceType } from '../types';
import { Lang, t } from '../i18n';
import { sendMessage } from '../websocket';

/** sterowniki, które mogą wysyłać pocztę, i ich kolejność (mniejsza liczba = pierwszy) */
export const RELAY_PRIORITY: Partial<Record<DeviceType, number>> = {
  [DeviceType.SWITCH]: 1,
  [DeviceType.HP]: 2,
};
/** sterownik jest „w sieci”, gdy pytał o maile w tym czasie (płytki pytają co 60 s, po sygnale „mail” co 25 s) */
export const RELAY_ALIVE_MS = 150_000;
/** po tym czasie mail nieodebrany przez pierwszy sterownik może wziąć następny */
export const FAILOVER_MS = 20_000;
/** czas na wysłanie wziętego maila; bez wyniku mail wraca do kolejki */
export const LEASE_MS = 60_000;
/** mail niewysłany w tym czasie przepada (kod logowania jest ważny 10 min) */
export const MAIL_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 3;
const KDF_LABEL = 'chpc-mail-v1';

export const relayEnabled = () => setting('MAIL_RELAY') === '1';
export const isRelayType = (type: DeviceType) => RELAY_PRIORITY[type] !== undefined;

export class MailRelayError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** brak sterownika, który wyśle mail: logowanie dostaje 503 zamiast „kod wysłany” */
export class MailUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super(t('pl', 'err.mailUnavailable'));
  }
  messageFor(lang: Lang): string { return t(lang, 'err.mailUnavailable'); }
}

// ------------------------------------------------------------------ klucze płytek

/** klucz publiczny P-256 w postaci nieskompresowanej (65 B, 0x04…) jako base64; inny = null */
export function parsePublicKey(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 65 || key[0] !== 0x04) return null;
  try {
    // nieprawidłowy punkt krzywej rzuca wyjątek
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(key);
    return key;
  } catch {
    return null;
  }
}

/** odcisk klucza do porównania z płytką: pierwsze 8 B SHA-256, np. „3F2A-91C0-7B5D-E814” */
export function keyFingerprint(key: Buffer): string {
  const hex = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

/** zgłoszenie z polem mailKey: zatwierdzony klucz odświeża seenAt, nowy czeka na zatwierdzenie */
export async function recordMailKey(device: DeviceDocument, value: unknown): Promise<void> {
  if (!isRelayType(device.deviceType)) return;
  const key = parsePublicKey(value);
  if (!key) return;
  const publicKey = key.toString('base64');
  const now = new Date();
  if (device.mailKey?.publicKey === publicKey) {
    device.set('mailKey.seenAt', now);
    if (device.mailKeyPending) device.set('mailKeyPending', undefined);
  } else if (device.mailKeyPending?.publicKey === publicKey) {
    device.set('mailKeyPending.seenAt', now);
  } else {
    device.set('mailKeyPending', { publicKey, fingerprint: keyFingerprint(key), seenAt: now });
  }
  await device.save();
}

/** przycisk „Zatwierdź klucz” (użytkownik systemowy): klucz czekający staje się kluczem przekaźnika */
export async function approveMailKey(rootId: string, fingerprint?: string): Promise<DeviceDocument> {
  const device = await DeviceModel.findById(rootId);
  if (!device) throw new MailRelayError('Nie znaleziono sterownika.', 404);
  const pending = device.mailKeyPending;
  if (!pending?.publicKey) throw new MailRelayError('Sterownik nie zgłosił nowego klucza.', 409);
  if (fingerprint && fingerprint !== pending.fingerprint) throw new MailRelayError('Odcisk klucza się zmienił — odśwież stronę.', 409);
  device.set('mailKey', { publicKey: pending.publicKey, fingerprint: pending.fingerprint, approvedAt: new Date(), seenAt: pending.seenAt });
  device.set('mailKeyPending', undefined);
  await device.save();
  // płytka od razu pobiera dane SMTP (GET /mail/config)
  void sendMessage('mail', rootId);
  return device;
}

/** „Usuń klucz”: sterownik przestaje wysyłać pocztę do czasu zatwierdzenia nowego klucza */
export async function revokeMailKey(rootId: string): Promise<void> {
  const device = await DeviceModel.findById(rootId);
  if (!device) throw new MailRelayError('Nie znaleziono sterownika.', 404);
  device.set('mailKey', undefined);
  device.set('mailKeyPending', undefined);
  await device.save();
  relaySeen.delete(rootId);
}

/** stan klucza do aplikacji (karta „Sterownik”) */
export function mailKeyInfo(device: DeviceDocument) {
  if (!isRelayType(device.deviceType)) return undefined;
  return {
    fingerprint: device.mailKey?.fingerprint,
    approvedAt: device.mailKey?.approvedAt,
    pendingFingerprint: device.mailKeyPending?.fingerprint,
    seenAt: relaySeen.has(String(device._id)) ? new Date(relaySeen.get(String(device._id))!) : undefined,
    relayEnabled: relayEnabled(),
  };
}

// ------------------------------------------------------------------ szyfrowanie

export interface Sealed {
  /** klucz publiczny jednorazowy serwera (65 B), wektor IV (12 B), szyfrogram, znacznik GCM (16 B); base64 */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

/** szyfruje obiekt JSON dla klucza płytki: ECDH z kluczem jednorazowym, klucz AES = SHA-256(wspólny ‖ epk ‖ etykieta) */
export function encryptFor(publicKeyB64: string, payload: unknown, aad: string): Sealed {
  const ecdh = crypto.createECDH('prime256v1');
  const epk = ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(publicKeyB64, 'base64'));
  const key = crypto.createHash('sha256').update(shared).update(epk).update(KDF_LABEL).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** odwrotność encryptFor po stronie płytki (testy i ewentualne narzędzia; firmware robi to samo w mbedtls) */
export function decryptWith(privateKey: Buffer, sealed: Sealed, aad: string): unknown {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const epk = Buffer.from(sealed.epk, 'base64');
  const shared = ecdh.computeSecret(epk);
  const key = crypto.createHash('sha256').update(shared).update(epk).update(KDF_LABEL).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8'));
}

// ------------------------------------------------------------------ dane SMTP

const smtpSettings = () => {
  const host = setting('SMTP_HOST');
  const user = setting('SMTP_USER');
  const pass = setting('SMTP_PASS');
  if (!host || !user || !pass) return null;
  return { host, port: Number(setting('SMTP_PORT') ?? 587), user, pass };
};

/** część odpowiedzi na zgłoszenie i GET /mail/config: stan klucza i zaszyfrowane dane SMTP */
export function mailConfigFor(device: DeviceDocument) {
  if (!relayEnabled() || !isRelayType(device.deviceType)) return undefined;
  if (!device.mailKey?.publicKey) {
    return { key: device.mailKeyPending ? 'pending' : 'none', fingerprint: device.mailKeyPending?.fingerprint };
  }
  const smtp = smtpSettings();
  return {
    key: 'approved',
    fingerprint: device.mailKey.fingerprint,
    ...(smtp ? { config: encryptFor(device.mailKey.publicKey, smtp, `config:${String(device._id)}`) } : {}),
  };
}

// ------------------------------------------------------------------ kolejka

/** Root ID przekaźnika → ostatnie pytanie o maile (ms); tylko w pamięci, po restarcie serwera płytki zgłaszają się w ≤ 60 s */
const relaySeen = new Map<string, number>();
export const resetRelaySeen = () => relaySeen.clear();

const markSeen = (rootId: string, now: number) => relaySeen.set(rootId, now);

/** zatwierdzone przekaźniki w sieci, od pierwszego (włącznik) do zapasowego (co) */
async function aliveRelays(now: number): Promise<DeviceDocument[]> {
  const ids = [...relaySeen.entries()].filter(([, at]) => now - at <= RELAY_ALIVE_MS).map(([id]) => id);
  if (ids.length === 0) return [];
  const devices = await DeviceModel.find({ _id: { $in: ids }, 'mailKey.publicKey': { $exists: true } });
  return devices
    .filter((device) => isRelayType(device.deviceType))
    .sort((a, b) => (RELAY_PRIORITY[a.deviceType]! - RELAY_PRIORITY[b.deviceType]!) || String(a._id).localeCompare(String(b._id)));
}

/** czy jest kto wysłać pocztę (logowanie sprawdza to przed „kod wysłany”) */
export async function relayAvailable(now = Date.now()): Promise<boolean> {
  return (await aliveRelays(now)).length > 0;
}

/** przed utworzeniem kodu z maila: przy MAIL_RELAY=1 bez sterownika w sieci od razu 503 */
export async function assertMailAvailable(): Promise<void> {
  if (relayEnabled() && !(await relayAvailable())) throw new MailUnavailableError();
}

interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** składa wiadomość MIME tak, jak wysłałby ją nodemailer: nadawca = konto SMTP, odpowiedzi na MAIL_FROM */
async function composeRaw(mail: OutgoingMail): Promise<string> {
  const user = setting('SMTP_USER') ?? '';
  const mailFrom = setting('MAIL_FROM');
  const replyTo = mailFrom && mailFrom !== user ? mailFrom : undefined;
  const message = new MailComposer({ from: `Mój Dom <${user}>`, ...(replyTo ? { replyTo } : {}), ...mail }).compile();
  message.keepBcc = false;
  const raw: Buffer = await new Promise((resolve, reject) => message.build((error, out) => (error ? reject(error) : resolve(out))));
  return raw.toString('utf8');
}

/** sendMail przy MAIL_RELAY=1: mail do kolejki i pobudka przekaźników; bez przekaźnika w sieci — błąd 503 */
export async function enqueueMail(mail: OutgoingMail, now = Date.now()): Promise<MailOutboxDocument> {
  const relays = await aliveRelays(now);
  if (relays.length === 0) throw new MailUnavailableError();
  const doc = await MailOutboxModel.create({
    to: [mail.to],
    subject: mail.subject,
    raw: await composeRaw(mail),
    expiresAt: new Date(now + MAIL_TTL_MS),
  });
  for (const relay of relays) void sendMessage('mail', String(relay._id));
  return doc;
}

/** GET /mail/next: najstarszy mail, który ten sterownik może teraz wziąć, zaszyfrowany jego kluczem; null = brak */
export async function nextMailFor(device: DeviceDocument, now = Date.now()): Promise<{ id: string; mail: Sealed } | null> {
  const rootId = String(device._id);
  markSeen(rootId, now);
  if (!relayEnabled() || !device.mailKey?.publicKey) return null;

  const at = new Date(now);
  await MailOutboxModel.updateMany({ status: { $in: ['pending', 'sending'] }, expiresAt: { $lte: at } }, { $set: { status: 'expired' } });
  // wzięty mail bez wyniku po LEASE_MS wraca do kolejki (płytka mogła się zrestartować w trakcie)
  await MailOutboxModel.updateMany(
    { status: 'sending', leaseUntil: { $lte: at } },
    { $set: { status: 'pending', leasedBy: null, leaseUntil: null, receipt: null } },
  );

  const relays = await aliveRelays(now);
  const candidates = await MailOutboxModel.find({ status: 'pending', attempts: { $lt: MAX_ATTEMPTS } }).sort({ createdAt: 1 }).limit(20);
  for (const job of candidates) {
    const failed = new Set(job.failedBy ?? []);
    // pierwszy przekaźnik, któremu ten mail się jeszcze nie udał; po FAILOVER_MS weźmie go każdy
    const preferred = relays.find((relay) => !failed.has(String(relay._id))) ?? relays[0];
    const waited = now - new Date(job.createdAt ?? now).getTime() >= FAILOVER_MS;
    if (preferred && String(preferred._id) !== rootId && !waited) continue;
    const receipt = crypto.randomBytes(16).toString('hex');
    const claimed = await MailOutboxModel.findOneAndUpdate(
      { _id: job._id, status: 'pending' },
      { $set: { status: 'sending', leasedBy: rootId, leaseUntil: new Date(now + LEASE_MS), receipt }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!claimed) continue;
    const id = String(claimed._id);
    return {
      id,
      mail: encryptFor(device.mailKey.publicKey, { to: claimed.to, from: setting('SMTP_USER') ?? '', raw: claimed.raw, receipt }, `mail:${id}`),
    };
  }
  return null;
}

/** POST /mail/result {id, ok, receipt, error?}: wynik wysyłki od sterownika, który wziął mail */
export async function mailResult(device: DeviceDocument, body: { id?: unknown; ok?: unknown; receipt?: unknown; error?: unknown }, now = Date.now()) {
  const rootId = String(device._id);
  markSeen(rootId, now);
  const id = typeof body.id === 'string' ? body.id : '';
  const job = /^[0-9a-f]{24}$/.test(id) ? await MailOutboxModel.findById(id) : null;
  if (!job) throw new MailRelayError('Nieznany mail.', 404);
  if (job.status !== 'sending' || job.leasedBy !== rootId) throw new MailRelayError('Mail nie jest przypisany do tego sterownika.', 409);
  if (typeof body.receipt !== 'string' || body.receipt !== job.receipt) throw new MailRelayError('Błędne potwierdzenie.', 403);

  if (body.ok === true) {
    job.set({ status: 'sent', sentBy: rootId, sentAt: new Date(now), leaseUntil: null, error: null });
    await job.save();
    return { status: 'sent' };
  }
  const error = String(body.error ?? 'błąd wysyłki').slice(0, 300);
  console.warn(`[mail] sterownik ${device.deviceId} nie wysłał maila ${id}: ${error}`);
  const failedBy = [...new Set([...(job.failedBy ?? []), rootId])];
  const final = job.attempts >= MAX_ATTEMPTS;
  job.set({ status: final ? 'error' : 'pending', leasedBy: null, leaseUntil: null, receipt: null, error, failedBy });
  await job.save();
  // drugi przekaźnik może spróbować od razu
  if (!final) for (const relay of await aliveRelays(now)) if (String(relay._id) !== rootId) void sendMessage('mail', String(relay._id));
  return { status: job.status };
}

/** wspólne dla endpointów sterownika: urządzenie po rootId i deviceId (oba wymagane, rodzaj przekaźnika) */
export async function relayDevice(rootId: unknown, deviceId: unknown): Promise<DeviceDocument> {
  const id = typeof rootId === 'string' ? rootId.trim() : '';
  const sn = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!/^[0-9a-f]{24}$/.test(id) || !sn) throw new MailRelayError('rootId i deviceId są wymagane.', 400);
  const device = await DeviceModel.findById(id);
  if (!device) throw new MailRelayError('Nieznany sterownik.', 404);
  if (device.deviceId !== sn) throw new MailRelayError('rootId należy do innego sterownika.', 409);
  if (!isRelayType(device.deviceType)) throw new MailRelayError('Ten rodzaj sterownika nie wysyła poczty.', 400);
  return device;
}
