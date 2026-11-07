// Konta użytkowników (2026-10-11): logowanie i rejestracja kodem albo linkiem z maila (jeden przebieg),
// sesje (token w nagłówku Authorization, bo klient i API są na różnych domenach), użytkownik systemowy
// (hasło SYSTEM_PASSWORD), dane konta, zmiana e-maila i usunięcie konta z danymi sterowników.
import { setting } from './settings.service';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { both, DEFAULT_LANG, isLang, Lang, t, Texts, texts } from '../i18n';
import { AuthCodeEntry, AuthCodeModel, AuthCodePurpose, SessionEntry, SessionModel } from '../models/auth.model';
import { DeviceShareModel } from '../models/device-share.model';
import { DeviceModel } from '../models/device.model';
import { UserEntry, UserLocation, UserModel } from '../models/user.model';
import { forgetDeviceInfo } from './device-info.service';
import { assertMailAvailable } from './mail-relay.service';
import {
  adminEmail, clientBaseUrl, deleteAccountMail, emailChangeMail, emailChangedMail, loginMail, registrationAdminMail, sendMail,
} from './mail.service';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const SESSION_REMEMBER_MS = 90 * 24 * 60 * 60 * 1000;
// sesja bez „Zapamiętaj”: klient trzyma token do zamknięcia przeglądarki, serwer najwyżej 24 h od ostatniego użycia
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** wersja demo: sesja 2 h bez przedłużania (publiczny podgląd konta z DEMO_OWNER_EMAIL, tylko odczyt) */
export const SESSION_DEMO_MS = 2 * 60 * 60 * 1000;
const DEMO_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 10 };
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const SYSTEM_MAX_FAILURES = 5;
const SYSTEM_LOCK_MS = 60 * 1000;
export const SYSTEM_LOGIN = 'system';

// Błąd dla aplikacji: komunikat w obu językach (core/i18n.ts texts / both); kontroler wybiera język żądania
// (messageFor). Sam napis = ten sam tekst w obu językach.
export class AuthError extends Error {
  readonly texts: Texts;
  constructor(message: string | Texts, public status = 400, public retryAfterSeconds?: number) {
    super(typeof message === 'string' ? message : message.pl);
    this.texts = typeof message === 'string' ? { pl: message, en: message } : message;
  }
  messageFor(lang: Lang): string { return this.texts[lang]; }
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export const isProfileComplete = (user: UserEntry) => !!(user.isSystem || (user.firstName && user.lastName && user.country));
export const userName = (user: UserEntry) =>
  user.isSystem ? SYSTEM_LOGIN : [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '';

export function publicUser(user: UserEntry) {
  // wersja demo: zamiast danych właściciela stały profil „Demo” (bez e-maila, adresu i lokalizacji)
  if (user.isDemo) {
    return {
      id: String(user._id), email: null, isSystem: false, isDemo: true, firstName: 'Demo', lastName: '', street: '', postalCode: '',
      city: '', country: '', location: null, language: user.language ?? '', profileComplete: true,
    };
  }
  return {
    isDemo: false,
    id: String(user._id),
    email: user.email ?? null,
    isSystem: !!user.isSystem,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    street: user.street ?? '',
    postalCode: user.postalCode ?? '',
    city: user.city ?? '',
    country: user.country ?? '',
    location: user.location ?? null,
    language: user.language ?? '',
    profileComplete: isProfileComplete(user),
  };
}

// Język konta (PUT /auth/me/language, wersja językowa 2026-10-21): 'pl' albo 'en'. Zapisany w koncie, żeby maile
// i powiadomienia szły w języku użytkownika, a nowe urządzenie zaczynało od tego samego języka.
export const LANGUAGES = ['pl', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const userLanguage = (user: UserEntry | null | undefined): Language =>
  user?.language === 'en' ? 'en' : 'pl';

export async function setLanguage(user: UserEntry, value: unknown) {
  if (!LANGUAGES.includes(value as Language)) throw new AuthError(texts('err.language'));
  if (user.isDemo) throw new AuthError(texts('err.demoReadOnly'), 403);
  const updated = await UserModel.findByIdAndUpdate(user._id, { $set: { language: value } }, { new: true }).lean<UserEntry>();
  forgetUserSessions(String(user._id));
  return publicUser(updated as UserEntry);
}

// ------------------------------------------------------------------ kody i linki z maila

async function createCode(purpose: AuthCodePurpose, email: string, options: { userId?: string; link?: boolean } = {}) {
  const now = Date.now();
  const filter = options.userId ? { purpose, userId: options.userId } : { purpose, email };
  const recent = await AuthCodeModel.findOne(filter).sort({ createdAt: -1 }).lean<AuthCodeEntry>();
  if (recent && now - new Date(recent.createdAt).getTime() < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (now - new Date(recent.createdAt).getTime())) / 1000);
    throw new AuthError(texts('err.codeRecently', { wait }), 429, wait);
  }
  await AuthCodeModel.deleteMany(filter);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const token = options.link ? newToken() : undefined;
  const expiresAt = new Date(now + CODE_TTL_MS);
  await AuthCodeModel.create({
    purpose, email, userId: options.userId, codeHash: codeHash(email, code), tokenHash: token ? sha256(token) : undefined, expiresAt,
  });
  return { code, token, expiresAt };
}

// Kod albo link: jednorazowy, ważny CODE_TTL_MS; po MAX_ATTEMPTS błędnych kodach trzeba wysłać nowy.
async function consumeCode(
  purpose: AuthCodePurpose,
  by: { token?: unknown; code?: unknown; email?: string; userId?: string },
): Promise<AuthCodeEntry> {
  const now = new Date();
  if (typeof by.token === 'string' && by.token) {
    const doc = await AuthCodeModel.findOneAndDelete({ purpose, tokenHash: sha256(by.token), expiresAt: { $gt: now } }).lean<AuthCodeEntry>();
    if (!doc) throw new AuthError(texts('err.linkUsed'));
    return doc;
  }
  const code = typeof by.code === 'string' ? by.code.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code)) throw new AuthError(texts('err.codeDigits'));
  const filter = by.userId ? { purpose, userId: by.userId } : { purpose, email: by.email };
  const doc = await AuthCodeModel.findOne({ ...filter, expiresAt: { $gt: now } }).sort({ createdAt: -1 });
  if (!doc) throw new AuthError(texts('err.codeExpired'));
  if (doc.attempts >= MAX_ATTEMPTS) throw new AuthError(texts('err.tooManyAttempts'));
  if (doc.codeHash !== codeHash(doc.email, code)) {
    doc.attempts += 1;
    await doc.save();
    const left = MAX_ATTEMPTS - doc.attempts;
    throw new AuthError(left > 0 ? texts('err.wrongCodeLeft', { left }) : texts('err.wrongCodeNew'));
  }
  await AuthCodeModel.deleteOne({ _id: doc._id });
  return doc.toObject();
}

// ------------------------------------------------------------------ sesje

// Pamięć podręczna sesji (token → sesja i użytkownik) na 30 s: aplikacja odpytuje API co kilka sekund.
const SESSION_CACHE_MS = 30 * 1000;
const sessionCache = new Map<string, { at: number; session: SessionEntry; user: UserEntry }>();
/** po zmianie dokumentu users poza tym serwisem (np. reguły powiadomień): następne żądanie czyta go z bazy */
export const forgetUserSessions = (userId: string) => {
  for (const [key, value] of sessionCache) if (value.session.userId === userId) sessionCache.delete(key);
};

async function createSession(userId: string, remember = false) {
  const token = newToken();
  const now = Date.now();
  await SessionModel.create({
    tokenHash: sha256(token), userId, remember,
    expiresAt: new Date(now + (remember ? SESSION_REMEMBER_MS : SESSION_IDLE_MS)), lastSeenAt: new Date(now),
  });
  return token;
}

export async function sessionFromToken(token: string): Promise<{ session: SessionEntry; user: UserEntry } | null> {
  const key = sha256(token);
  const now = Date.now();
  const cached = sessionCache.get(key);
  if (cached && now - cached.at < SESSION_CACHE_MS && new Date(cached.session.expiresAt).getTime() > now) {
    return { session: cached.session, user: cached.user };
  }
  const session = await SessionModel.findOne({ tokenHash: key, expiresAt: { $gt: new Date(now) } }).lean<SessionEntry>();
  let user = session ? await UserModel.findById(session.userId).lean<UserEntry>() : null;
  if (!session || !user) {
    sessionCache.delete(key);
    return null;
  }
  // sesja demo: konto właściciela widziane tylko do odczytu (flaga w pamięci, nie w bazie), bez przedłużania
  if (session.demo) {
    user = { ...user, isDemo: true };
    sessionCache.set(key, { at: now, session, user });
    return { session, user };
  }
  // bez „Zapamiętaj”: 24 h od ostatniego użycia (zapis najwyżej co 5 min)
  if (!session.remember && now - new Date(session.lastSeenAt).getTime() > SESSION_TOUCH_MS) {
    session.lastSeenAt = new Date(now);
    session.expiresAt = new Date(now + SESSION_IDLE_MS);
    await SessionModel.updateOne({ _id: session._id }, { $set: { lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt } });
  }
  sessionCache.set(key, { at: now, session, user });
  return { session, user };
}

// „Zapamiętać Twoje dane … na najbliższe 90 dni?”: tak = 90 dni od zalogowania, nie = 24 h od ostatniego użycia.
export async function setRemember(token: string, remember: boolean) {
  const key = sha256(token);
  const session = await SessionModel.findOne({ tokenHash: key });
  if (!session) throw new AuthError(texts('err.sessionExpired'), 401);
  session.remember = remember;
  session.expiresAt = new Date(remember ? new Date(session.createdAt).getTime() + SESSION_REMEMBER_MS : Date.now() + SESSION_IDLE_MS);
  await session.save();
  sessionCache.delete(key);
  return { remember, expiresAt: session.expiresAt };
}

export async function logout(token: string) {
  const key = sha256(token);
  sessionCache.delete(key);
  await SessionModel.deleteOne({ tokenHash: key });
}

// ------------------------------------------------------------------ logowanie i rejestracja

// Język maila (wersja językowa 2026-10-21): język konta, gdy je ma i wybrało język; inaczej język żądania (klient
// wysyła Accept-Language według ekranu logowania), inaczej polski.
const mailLang = (user: UserEntry | null | undefined, requested: Lang): Lang => (isLang(user?.language) ? user!.language as Lang : requested);

export async function startLogin(emailValue: unknown, origin?: string, lang: Lang = DEFAULT_LANG) {
  const email = normalizeEmail(emailValue);
  if (!email) throw new AuthError(texts('err.emailInvalid'));
  // przekaźnik poczty bez sterownika w sieci: błąd przed utworzeniem kodu (inaczej kolejna próba czekałaby 60 s)
  await assertMailAvailable();
  const existing = await UserModel.findOne({ email }).lean<UserEntry>();
  const { code, token, expiresAt } = await createCode('login', email, { link: true });
  const url = `${clientBaseUrl(origin)}/login?token=${encodeURIComponent(token as string)}`;
  await sendMail(loginMail(email, code, url, expiresAt, mailLang(existing, lang)));
  return { email, resendAfterSeconds: Math.round(RESEND_MS / 1000) };
}

// Kod (z e-mailem) albo link (token): nowy adres zakłada konto (bez danych osobowych — formularz w kliencie).
export async function verifyLogin(body: { email?: unknown; code?: unknown; token?: unknown }) {
  const email = normalizeEmail(body.email);
  if (!body.token && !email) throw new AuthError(texts('err.emailRequired'));
  const doc = await consumeCode('login', { token: body.token, code: body.code, email: email ?? undefined });
  let user = await UserModel.findOne({ email: doc.email }).lean<UserEntry>();
  const created = !user;
  if (!user) {
    user = (await UserModel.create({ email: doc.email })).toObject();
    if (adminEmail()) void sendMail(registrationAdminMail(adminEmail(), doc.email)).catch((error) => console.error('[mail] administrator:', error));
  }
  // zaproszenia wysłane na ten adres przed założeniem konta
  await DeviceShareModel.updateMany({ email: doc.email, userId: null }, { $set: { userId: String(user._id) } });
  const token = await createSession(String(user._id));
  return { token, created, user: publicUser(user) };
}

const systemFailures = { count: 0, lockedUntil: 0 };
export async function systemLogin(password: unknown) {
  const expected = process.env.SYSTEM_PASSWORD;
  if (!expected) throw new AuthError(texts('err.systemLoginOff'), 403);
  const now = Date.now();
  if (systemFailures.lockedUntil > now) {
    throw new AuthError(texts('err.tooManyTryMinute'), 429, Math.ceil((systemFailures.lockedUntil - now) / 1000));
  }
  const ok = typeof password === 'string'
    && crypto.timingSafeEqual(Buffer.from(sha256(password)), Buffer.from(sha256(expected)));
  if (!ok) {
    systemFailures.count += 1;
    if (systemFailures.count >= SYSTEM_MAX_FAILURES) {
      systemFailures.count = 0;
      systemFailures.lockedUntil = now + SYSTEM_LOCK_MS;
    }
    throw new AuthError(texts('err.wrongPassword'), 401);
  }
  systemFailures.count = 0;
  const user = await ensureSystemUser();
  return { token: await createSession(String(user._id)), created: false, user: publicUser(user) };
}

// ------------------------------------------------------------------ wersja demo (2026-10-21)
// Publiczny podgląd konta z DEMO_OWNER_EMAIL: przycisk „Zobacz wersję demo” pod logowaniem, bez linku i hasła.
// Sesja na dokumencie właściciela z demo: true (sessionFromToken dokłada isDemo); zapisy blokuje authorize
// (core/middleware/session.ts), a dane wrażliwe ukrywają kontrolery (SN, IP, współrzędne, imiona).
const demoAttempts = new Map<string, number[]>();

export const demoAvailable = () => !!setting('DEMO_OWNER_EMAIL');

export async function demoOwner(): Promise<UserEntry | null> {
  const email = setting('DEMO_OWNER_EMAIL')?.trim().toLowerCase();
  if (!email) return null;
  return UserModel.findOne({ email }).lean<UserEntry>();
}

export async function demoLogin(ip: string) {
  const owner = await demoOwner();
  if (!owner) throw new AuthError(texts('err.demoOff'), 404);
  // najwyżej DEMO_RATE_LIMIT.max wejść z jednego adresu w oknie (darmowy plan Render i Atlas)
  const now = Date.now();
  const recent = (demoAttempts.get(ip) ?? []).filter((at) => now - at < DEMO_RATE_LIMIT.windowMs);
  if (recent.length >= DEMO_RATE_LIMIT.max) {
    throw new AuthError(texts('err.demoRate'), 429, Math.ceil(DEMO_RATE_LIMIT.windowMs / 1000));
  }
  recent.push(now);
  demoAttempts.set(ip, recent);
  const token = newToken();
  await SessionModel.create({
    tokenHash: sha256(token), userId: String(owner._id), remember: false, demo: true,
    expiresAt: new Date(now + SESSION_DEMO_MS), lastSeenAt: new Date(now),
  });
  return { token, created: false, user: publicUser({ ...owner, isDemo: true }) };
}

/** testy */
export const resetDemoAttempts = () => demoAttempts.clear();

export async function ensureSystemUser(): Promise<UserEntry> {
  return (await UserModel.findOneAndUpdate(
    { isSystem: true },
    { $setOnInsert: { isSystem: true } },
    { upsert: true, new: true },
  ).lean<UserEntry>()) as UserEntry;
}

// ------------------------------------------------------------------ dane konta

const text = (value: unknown, field: string, max: number, required: boolean) => {
  const result = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : null;
  if (result === null || result.length > max) throw new AuthError(both((lang) => t(lang, 'err.textTooLong', { field: t(lang, `field.${field}`), max })));
  if (required && !result) throw new AuthError(both((lang) => t(lang, 'err.required', { field: t(lang, `field.${field}`) })));
  return result;
};

function parseLocation(value: unknown): UserLocation | null {
  if (value === null || value === undefined) return null;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AuthError(texts('err.location'));
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

// Obowiązkowe: imię, nazwisko i kraj (decyzja 2026-10-11; miejscowość nie).
export async function updateProfile(user: UserEntry, body: Record<string, unknown>) {
  if (user.isSystem) throw new AuthError(texts('err.systemNoProfile'), 403);
  const data = {
    firstName: text(body.firstName, 'firstName', 80, true),
    lastName: text(body.lastName, 'lastName', 80, true),
    street: text(body.street, 'street', 120, false),
    postalCode: text(body.postalCode, 'postalCode', 20, false),
    city: text(body.city, 'city', 120, false),
    country: text(body.country, 'country', 80, true),
    location: parseLocation(body.location),
  };
  const updated = await UserModel.findByIdAndUpdate(user._id, { $set: data }, { new: true }).lean<UserEntry>();
  forgetUserSessions(String(user._id));
  return publicUser(updated as UserEntry);
}

export async function startEmailChange(user: UserEntry, emailValue: unknown, lang: Lang = DEFAULT_LANG) {
  if (user.isSystem) throw new AuthError(texts('err.systemNoEmail'), 403);
  const email = normalizeEmail(emailValue);
  if (!email) throw new AuthError(texts('err.emailInvalid'));
  if (email === user.email) throw new AuthError(texts('err.sameEmail'));
  if (await UserModel.exists({ email })) throw new AuthError(texts('err.emailTaken'), 409);
  await assertMailAvailable();
  const { code, expiresAt } = await createCode('email-change', email, { userId: String(user._id) });
  await sendMail(emailChangeMail(email, code, expiresAt, mailLang(user, lang)));
  return { email, resendAfterSeconds: Math.round(RESEND_MS / 1000) };
}

export async function verifyEmailChange(user: UserEntry, codeValue: unknown) {
  const doc = await consumeCode('email-change', { code: codeValue, userId: String(user._id) });
  if (await UserModel.exists({ email: doc.email, _id: { $ne: user._id } })) throw new AuthError(texts('err.emailTaken'), 409);
  const updated = await UserModel.findByIdAndUpdate(user._id, { $set: { email: doc.email } }, { new: true }).lean<UserEntry>();
  // udostępnienia: adres przy istniejących i zaproszenia czekające na nowy adres
  await DeviceShareModel.updateMany({ userId: String(user._id) }, { $set: { email: doc.email } });
  await DeviceShareModel.updateMany({ email: doc.email, userId: null }, { $set: { userId: String(user._id) } });
  forgetUserSessions(String(user._id));
  if (user.email) void sendMail(emailChangedMail(user.email, doc.email, mailLang(user, DEFAULT_LANG))).catch((error) => console.error('[mail] zmiana e-maila:', error));
  return publicUser(updated as UserEntry);
}

// ------------------------------------------------------------------ usunięcie konta

export async function startDeleteAccount(user: UserEntry, origin?: string, lang: Lang = DEFAULT_LANG) {
  if (user.isSystem || !user.email) throw new AuthError(texts('err.systemNoDelete'), 403);
  const devices = await DeviceModel.countDocuments({ ownerId: String(user._id) });
  await assertMailAvailable();
  const { token } = await createCode('delete-account', user.email, { userId: String(user._id), link: true });
  const url = `${clientBaseUrl(origin)}/account/delete?token=${encodeURIComponent(token as string)}`;
  await sendMail(deleteAccountMail(user.email, url, devices, mailLang(user, lang)));
  return { email: user.email, devices };
}

export async function confirmDeleteAccount(token: unknown) {
  const doc = await consumeCode('delete-account', { token });
  if (!doc.userId) throw new AuthError(texts('err.linkNoAccount'));
  return deleteUserAndData(doc.userId);
}

// Kolekcje bez danych sterowników (pozostałe z polem rootId należą do sterowników).
const NOT_DEVICE_DATA = new Set(['users', 'sessions', 'auth_codes', 'device_shares', 'devices', 'firmware_images', 'firmware_offers']);

// Konto, jego sterowniki z całą historią (każda kolekcja z rootId), udostępnienia (jego i jemu) i sesje.
// Sterownik, który dalej działa, zgłosi się później sam jako nowy, bez właściciela.
export async function deleteUserAndData(userId: string) {
  const devices = await DeviceModel.find({ ownerId: userId }).select('_id').lean<{ _id: mongoose.Types.ObjectId }[]>();
  const ids = devices.map((device) => String(device._id));
  const rootIds = [...ids, ...devices.map((device) => device._id)];
  const db = mongoose.connection.db;
  if (db && ids.length) {
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (NOT_DEVICE_DATA.has(name) || name.startsWith('system.')) continue;
      await db.collection(name).deleteMany({ rootId: { $in: rootIds } });
    }
  }
  await DeviceModel.deleteMany({ _id: { $in: ids } });
  ids.forEach((id) => forgetDeviceInfo(id));
  await DeviceShareModel.deleteMany({ $or: [{ rootId: { $in: ids } }, { userId }, { ownerId: userId }] });
  await SessionModel.deleteMany({ userId });
  await AuthCodeModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });
  forgetUserSessions(userId);
  return { devices: ids.length };
}
