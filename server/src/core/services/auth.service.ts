// Konta użytkowników (2026-10-11): logowanie i rejestracja kodem albo linkiem z maila (jeden przebieg),
// sesje (token w nagłówku Authorization, bo klient i API są na różnych domenach), użytkownik systemowy
// (od 2026-11-13 kod z maila na stały adres z ustawień zamiast hasła SYSTEM_PASSWORD), kod z aplikacji na telefonie
// (TOTP, od 2026-11-13: logowanie, rejestracja i wyłączenie; mechanizm w totp.service.ts), dane konta, zmiana e-maila
// i usunięcie konta z danymi sterowników.
import { setting } from './settings.service';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { both, DEFAULT_LANG, isLang, Lang, t, Texts, texts } from '../i18n';
import { AuthCodeEntry, AuthCodeModel, AuthCodePurpose, SessionEntry, SessionModel, SystemCodeDelivery } from '../models/auth.model';
import { DeviceShareModel } from '../models/device-share.model';
import { DeviceModel } from '../models/device.model';
import { UserEntry, UserLocation, UserModel } from '../models/user.model';
import { forgetDeviceInfo } from './device-info.service';
import { assertMailAvailable } from './mail-relay.service';
import {
  adminEmail, clientBaseUrl, deleteAccountMail, emailChangeMail, emailChangedMail, formatCode, loginMail, mailConfigured,
  phoneDisableMail, registrationAdminMail, sendMail, systemLoginMail, until,
} from './mail.service';
import {
  base32Encode, decryptSecret, deleteTotpKey, findTotpKey, insertTotpKey, markTotpUsed, matchTotp, newTotpSecret,
  otpauthUrl, qrDataUrl, totpConfigured,
} from './totp.service';

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
export const SYSTEM_LOGIN = 'system';

// Błąd dla aplikacji: komunikat w obu językach (core/i18n.ts texts / both); kontroler wybiera język żądania
// (messageFor). Sam napis = ten sam tekst w obu językach. extra: dodatkowe pola odpowiedzi (np. locked przy blokadzie).
export class AuthError extends Error {
  readonly texts: Texts;
  constructor(message: string | Texts, public status = 400, public retryAfterSeconds?: number, public extra?: Record<string, unknown>) {
    super(typeof message === 'string' ? message : message.pl);
    this.texts = typeof message === 'string' ? { pl: message, en: message } : message;
  }
  messageFor(lang: Lang): string { return this.texts[lang]; }
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

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
  const code = newCode();
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
  return signInVerifiedEmail(doc.email);
}

// Adres potwierdzony kodem z maila, linkiem albo kodem z telefonu (telefon mógł zostać zarejestrowany w innej aplikacji
// mojeturnie.pl, więc i tu konto może jeszcze nie istnieć): sesja, a dla nowego adresu nowe konto.
async function signInVerifiedEmail(email: string) {
  let user = await UserModel.findOne({ email }).lean<UserEntry>();
  const created = !user;
  if (!user) {
    user = (await UserModel.create({ email })).toObject();
    if (adminEmail()) void sendMail(registrationAdminMail(adminEmail(), email)).catch((error) => console.error('[mail] administrator:', error));
  }
  // zaproszenia wysłane na ten adres przed założeniem konta
  await DeviceShareModel.updateMany({ email, userId: null }, { $set: { userId: String(user._id) } });
  const token = await createSession(String(user._id));
  return { token, created, user: publicUser(user) };
}

// ------------------------------------------------------------------ konto system: kod z maila (od 2026-11-13)
// Plan właściciela: oracle-cloud/vm-prod/admin/docs/plan-logowanie-system-kodem.md. Hasła systemowego nie ma nigdzie:
// „system” w polu e-mail → kod (6 cyfr, jednorazowy, SYSTEM_CODE_TTL_MS) zawsze na stały adres z ustawień instalacji
// (systemEmail: SYSTEM_EMAIL, bez niego MAIL_ADMIN), nigdy z formularza; w mailu adres IP, z którego zamówiono kod.
// Bez poczty (środowisko testowe, npm run local, nowa instalacja) albo bez adresu kod trafia do dziennika serwera.
// Limity: nowy kod najwyżej raz na RESEND_MS i SYSTEM_CODES_PER_HOUR razy na godzinę; MAX_ATTEMPTS błędnych kodów
// (z maila, awaryjnych i z telefonu razem, w odstępach krótszych niż SYSTEM_LOCK_MS) unieważnia kod i blokuje
// logowanie system (wysłanie i wpisanie kodu) na SYSTEM_LOCK_MS. Polecenie awaryjne (core/cli.ts, --kod-awaryjny)
// wypisuje kod w terminalu serwera bez poczty i zdejmuje blokadę oraz limity. Stan jest w auth_codes (purpose
// system-login / system-sent / system-fail / system-lock, email 'system'), a nie w pamięci, bo polecenie awaryjne to
// osobny proces. Zamówienie, błędny kod, blokada i logowanie trafiają do dziennika serwera. Konto system z telefonem
// (klucz adresu systemEmail()) loguje się też kodem z aplikacji: POST /auth/system/verify przyjmuje każdy z tych kodów.
export const SYSTEM_CODE_TTL_MS = 5 * 60 * 1000;
export const SYSTEM_CODES_PER_HOUR = 5;
export const SYSTEM_LOCK_MS = 15 * 60 * 1000;
const SYSTEM_SENT_WINDOW_MS = 60 * 60 * 1000;
const SYSTEM_PURPOSES: AuthCodePurpose[] = ['system-login', 'system-sent', 'system-fail', 'system-lock'];

/** adres kodów konta system: ustawienie instalacji, nigdy wpisany w kod (kod jest publiczny, a cudza instalacja
 *  wysyłałaby kody właścicielowi); pusty = adres administratora, bez obu kod idzie do dziennika serwera */
export const systemEmail = () => (setting('SYSTEM_EMAIL') || setting('MAIL_ADMIN') || '').trim();

const minutes = (ms: number) => Math.round(ms / 60_000);
const lockedError = (seconds: number) =>
  new AuthError(texts('err.systemLocked', { minutes: Math.max(1, Math.ceil(seconds / 60)) }), 429, seconds, { locked: true });

async function systemLockSeconds(now: number): Promise<number> {
  const lock = await AuthCodeModel.findOne({ purpose: 'system-lock', email: SYSTEM_LOGIN, expiresAt: { $gt: new Date(now) } })
    .sort({ expiresAt: -1 }).lean<AuthCodeEntry>();
  return lock ? Math.ceil((new Date(lock.expiresAt).getTime() - now) / 1000) : 0;
}

// POST /auth/system: nowy kod konta system (poprzedni przestaje działać). delivery: 'mail' albo 'log' (kod w dzienniku).
export async function startSystemLogin(ip: string, lang: Lang = DEFAULT_LANG) {
  const now = Date.now();
  const locked = await systemLockSeconds(now);
  if (locked) {
    console.warn(`[konta] system: zamówienie kodu z IP ${ip} odrzucone, blokada jeszcze ${locked} s`);
    throw lockedError(locked);
  }
  // ślady wysłanych kodów z ostatniej godziny (TTL usuwa starsze), od najstarszego
  const sent = await AuthCodeModel.find({ purpose: 'system-sent', email: SYSTEM_LOGIN, expiresAt: { $gt: new Date(now) } })
    .sort({ createdAt: 1 }).lean<AuthCodeEntry[]>();
  const last = sent[sent.length - 1];
  if (last && now - new Date(last.createdAt).getTime() < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (now - new Date(last.createdAt).getTime())) / 1000);
    throw new AuthError(texts('err.codeRecently', { wait }), 429, wait);
  }
  if (sent.length >= SYSTEM_CODES_PER_HOUR) {
    const wait = Math.max(1, Math.ceil((new Date(sent[0].expiresAt).getTime() - now) / 1000));
    console.warn(`[konta] system: zamówienie kodu z IP ${ip} odrzucone, ${sent.length} kodów w ciągu godziny`);
    throw new AuthError(texts('err.systemCodesHourly', { minutes: Math.ceil(wait / 60) }), 429, wait);
  }
  const to = systemEmail();
  const delivery: SystemCodeDelivery = to && mailConfigured() ? 'mail' : 'log';
  // przekaźnik poczty bez sterownika w sieci: błąd przed utworzeniem kodu (jak przy zwykłym logowaniu)
  if (delivery === 'mail') await assertMailAvailable();
  const user = await ensureSystemUser();
  const code = newCode();
  const expiresAt = new Date(now + SYSTEM_CODE_TTL_MS);
  await AuthCodeModel.deleteMany({ purpose: 'system-login', email: SYSTEM_LOGIN });
  const doc = await AuthCodeModel.create({
    purpose: 'system-login', email: SYSTEM_LOGIN, codeHash: codeHash(SYSTEM_LOGIN, code), expiresAt, ip, delivery,
  });
  await AuthCodeModel.create({ purpose: 'system-sent', email: SYSTEM_LOGIN, ip, delivery, expiresAt: new Date(now + SYSTEM_SENT_WINDOW_MS) });
  if (delivery === 'mail') {
    try {
      await sendMail(systemLoginMail(to, code, expiresAt, ip, {
        minutes: minutes(SYSTEM_CODE_TTL_MS), attempts: MAX_ATTEMPTS, lock: minutes(SYSTEM_LOCK_MS),
      }, mailLang(user, lang), new Date(now)));
    } catch (error) {
      // kod nie dotarł, więc nie zostaje; ślad wysłania zostaje, żeby ponowienia nie zalewały serwera poczty
      await AuthCodeModel.deleteOne({ _id: doc._id });
      console.error(`[konta] system: nie udało się wysłać kodu (IP ${ip}); bez poczty: node dist/server.js --kod-awaryjny`, error);
      throw new AuthError(texts('err.systemMailFailed'), 503);
    }
    console.log(`[konta] system: kod wysłany na adres z ustawień, zamówiony z IP ${ip}`);
  } else {
    const why = to ? 'poczta nie jest ustawiona' : 'brak adresu SYSTEM_EMAIL i MAIL_ADMIN';
    console.log(`[konta] system: kod logowania ${formatCode(code)}, ważny do ${until(expiresAt, 'pl')} (${why}; zamówiony z IP ${ip})`);
  }
  return {
    delivery, expiresInSeconds: Math.round(SYSTEM_CODE_TTL_MS / 1000), resendAfterSeconds: Math.round(RESEND_MS / 1000),
  };
}

// POST /auth/system/verify {code}: sesja konta system (klient pyta potem o zapamiętanie, jak u innych kont).
export async function verifySystemLogin(codeValue: unknown, ip: string) {
  const source = await consumeSystemCode(codeValue, ip);
  const user = await ensureSystemUser();
  console.log(`[konta] system: zalogowano ${SOURCE_TEXT[source]} z IP ${ip}`);
  return { token: await createSession(String(user._id)), created: false, user: publicUser(user) };
}

type SystemCodeSource = SystemCodeDelivery | 'phone';
const SOURCE_TEXT: Record<SystemCodeSource, string> = {
  mail: 'kodem z maila', log: 'kodem z dziennika serwera', emergency: 'kodem awaryjnym', phone: 'kodem z telefonu',
};

/** błędny kod: licznik w oknie windowMs od ostatniego błędu (system-fail konta system, totp-fail kodu z telefonu) */
async function countFailure(purpose: 'system-fail' | 'totp-fail', key: string, now: number, windowMs: number, ip?: string) {
  const doc = await AuthCodeModel.findOneAndUpdate(
    { purpose, email: key, expiresAt: { $gt: new Date(now) } },
    { $inc: { attempts: 1 }, $set: { expiresAt: new Date(now + windowMs), ...(ip ? { ip } : {}) } },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).lean<AuthCodeEntry>();
  return doc?.attempts ?? 1;
}

// Kod konta system przy logowaniu i przy wyłączaniu telefonu: z maila, z dziennika serwera, awaryjny albo z aplikacji
// na telefonie (klucz adresu systemEmail()). Każdy błędny kod idzie do wspólnego licznika (system-fail).
async function consumeSystemCode(codeValue: unknown, ip: string): Promise<SystemCodeSource> {
  const now = Date.now();
  const locked = await systemLockSeconds(now);
  if (locked) throw lockedError(locked);
  const code = typeof codeValue === 'string' ? codeValue.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code)) throw new AuthError(texts('err.codeDigits'));
  const doc = await AuthCodeModel.findOne({ purpose: 'system-login', email: SYSTEM_LOGIN, expiresAt: { $gt: new Date(now) } })
    .sort({ createdAt: -1 }).lean<AuthCodeEntry>();
  if (doc && doc.codeHash === codeHash(SYSTEM_LOGIN, code)) {
    // usunięcie przed utworzeniem sesji: przy dwóch żądaniach naraz kod działa tylko w jednym
    const used = await AuthCodeModel.findOneAndDelete({ _id: doc._id }).lean<AuthCodeEntry>();
    if (!used) throw new AuthError(texts('err.codeExpired'));
    await AuthCodeModel.deleteMany({ purpose: 'system-fail', email: SYSTEM_LOGIN });
    return used.delivery ?? 'mail';
  }
  const phone = await checkPhoneCode(systemEmail().toLowerCase(), code, now);
  if (phone === 'ok') {
    await AuthCodeModel.deleteMany({ purpose: 'system-fail', email: SYSTEM_LOGIN });
    return 'phone';
  }
  // ten sam kod z telefonu drugi raz (np. podwójne kliknięcie) nie jest zgadywaniem
  if (phone === 'used') throw new AuthError(texts('err.totpUsed'));
  if (!doc && phone === 'unavailable') throw new AuthError(texts('err.totpUnavailable'), 503);
  // bez kodu z maila i bez telefonu nie ma czego zgadywać
  if (!doc && phone === 'none') throw new AuthError(texts('err.codeExpired'));
  const attempts = await countFailure('system-fail', SYSTEM_LOGIN, now, SYSTEM_LOCK_MS, ip);
  console.warn(`[konta] system: błędny kod z IP ${ip} (${attempts}/${MAX_ATTEMPTS})`);
  if (attempts < MAX_ATTEMPTS) throw new AuthError(texts('err.wrongCodeLeft', { left: MAX_ATTEMPTS - attempts }));
  await AuthCodeModel.deleteMany({ purpose: { $in: ['system-login', 'system-fail'] }, email: SYSTEM_LOGIN });
  await AuthCodeModel.create({ purpose: 'system-lock', email: SYSTEM_LOGIN, ip, expiresAt: new Date(now + SYSTEM_LOCK_MS) });
  console.warn(`[konta] system: ${MAX_ATTEMPTS} błędnych kodów (ostatni z IP ${ip}), kod unieważniony, logowanie system`
    + ` zablokowane na ${minutes(SYSTEM_LOCK_MS)} min; blokadę zdejmuje node dist/server.js --kod-awaryjny`);
  throw lockedError(Math.round(SYSTEM_LOCK_MS / 1000));
}

// Polecenie awaryjne (core/cli.ts, --kod-awaryjny; tylko na serwerze, bez poczty): zdejmuje blokadę i limit kodów
// na godzinę, unieważnia wysłany kod i zwraca nowy, ważny SYSTEM_CODE_TTL_MS.
export async function issueEmergencySystemCode() {
  await ensureSystemUser();
  await AuthCodeModel.deleteMany({ purpose: { $in: SYSTEM_PURPOSES }, email: SYSTEM_LOGIN });
  const code = newCode();
  const expiresAt = new Date(Date.now() + SYSTEM_CODE_TTL_MS);
  await AuthCodeModel.create({
    purpose: 'system-login', email: SYSTEM_LOGIN, codeHash: codeHash(SYSTEM_LOGIN, code), expiresAt, delivery: 'emergency',
  });
  return { code, expiresAt };
}

// ------------------------------------------------------------------ kod z aplikacji na telefonie (TOTP, od 2026-11-13)
// Mechanizm i wspólna baza kluczy (jeden wpis „mojeturnie.pl” w telefonie dla Mojego domu, Archiwum i panelu admin):
// totp.service.ts. Tu zasady: krok 1 logowania mówi, czy adres ma telefon (POST /auth/methods); kod z telefonu ma
// te same limity błędnych prób co kod z maila (MAX_ATTEMPTS; u zwykłego konta blokuje wtedy sam kod z telefonu na
// PHONE_LOCK_MS, a kod z maila działa dalej; u konta system liczy się do blokady system); rejestracja w ustawieniach
// konta trzyma nowy sekret najwyżej PHONE_SETUP_MS w pamięci przy sesji i zapisuje go dopiero po pierwszym poprawnym
// kodzie; wyłączenie wymaga kodu z telefonu albo z maila. Konto system używa klucza adresu systemEmail(), zwykłe konto
// adresu konta (po zmianie adresu telefon trzeba zarejestrować od nowa, klucz starego adresu zostaje dla innych
// aplikacji). Bez LOGOWANIE_KLUCZ albo bez dostępu do bazy kluczy wszystko działa jak bez telefonu.
export const PHONE_SETUP_MS = 10 * 60 * 1000;
export const PHONE_LOCK_MS = 15 * 60 * 1000;

type PhoneCheck = 'ok' | 'wrong' | 'used' | 'none' | 'unavailable';

// baza kluczy niedostępna albo inny klucz szyfrujący: najwyżej jedno ostrzeżenie na minutę, logowanie idzie mailem
let lastStoreWarning = 0;
const warnStore = (error: unknown) => {
  if (Date.now() - lastStoreWarning < 60_000) return;
  lastStoreWarning = Date.now();
  console.warn('[totp] kod z telefonu niedostępny:', (error as Error)?.message ?? error);
};

/** adres, którego klucz z telefonu dotyczy konta: system → systemEmail(), inne → e-mail konta */
const phoneAddress = (user: UserEntry) => (user.isSystem ? systemEmail().toLowerCase() : user.email ?? '');

/** sekret telefonu adresu, jeśli ten serwer umie go sprawdzić (LOGOWANIE_KLUCZ odszyfrowuje klucz) */
async function phoneSecret(address: string): Promise<Buffer | null> {
  if (!address || !totpConfigured()) return null;
  const doc = await findTotpKey(address);
  return doc ? decryptSecret(doc.sekret) : null;
}

/** krok 1 logowania: czy pokazać pole „Kod z aplikacji”; błąd bazy = nie (zostaje kod z maila) */
async function hasPhone(address: string): Promise<boolean> {
  try {
    return !!(await phoneSecret(address));
  } catch (error) {
    warnStore(error);
    return false;
  }
}

// Kod z telefonu bez limitów prób (limity liczą wywołujący): okno ±30 s, potem znak w totp_uzyte, więc ten sam kod
// nie zadziała drugi raz w żadnej aplikacji.
async function checkPhoneCode(address: string, code: string, now = Date.now()): Promise<PhoneCheck> {
  let secret: Buffer | null;
  try {
    secret = await phoneSecret(address);
  } catch (error) {
    warnStore(error);
    return 'unavailable';
  }
  if (!secret) return 'none';
  const window = matchTotp(secret, code, now);
  if (window === null) return 'wrong';
  try {
    return (await markTotpUsed(address, window)) ? 'ok' : 'used';
  } catch (error) {
    warnStore(error);
    return 'unavailable';
  }
}

const phoneLockedError = (seconds: number) =>
  new AuthError(texts('err.totpLocked', { minutes: Math.max(1, Math.ceil(seconds / 60)) }), 429, seconds, { locked: true });

async function phoneLockSeconds(email: string, now: number): Promise<number> {
  const doc = await AuthCodeModel.findOne({
    purpose: 'totp-fail', email, attempts: { $gte: MAX_ATTEMPTS }, expiresAt: { $gt: new Date(now) },
  }).lean<AuthCodeEntry>();
  return doc ? Math.ceil((new Date(doc.expiresAt).getTime() - now) / 1000) : 0;
}

/** błędny kod z telefonu zwykłego konta: komunikat z liczbą prób albo blokada kodu z telefonu */
async function phoneFailure(email: string, now: number, ip: string): Promise<AuthError> {
  const attempts = await countFailure('totp-fail', email, now, PHONE_LOCK_MS);
  if (attempts < MAX_ATTEMPTS) return new AuthError(texts('err.wrongCodeLeft', { left: MAX_ATTEMPTS - attempts }));
  console.warn(`[konta] kod z telefonu zablokowany na ${minutes(PHONE_LOCK_MS)} min po ${MAX_ATTEMPTS} błędnych kodach (ostatni z IP ${ip})`);
  return phoneLockedError(Math.round(PHONE_LOCK_MS / 1000));
}

const cleanCode = (value: unknown) => (typeof value === 'string' ? value.replace(/\s/g, '') : '');

// POST /auth/methods {email}: krok 1 logowania; „system” oznacza konto system (klucz adresu systemEmail()).
export async function loginMethods(emailValue: unknown) {
  if (typeof emailValue === 'string' && emailValue.trim().toLowerCase() === SYSTEM_LOGIN) {
    return { email: SYSTEM_LOGIN, totp: await hasPhone(systemEmail().toLowerCase()) };
  }
  const email = normalizeEmail(emailValue);
  if (!email) throw new AuthError(texts('err.emailInvalid'));
  return { email, totp: await hasPhone(email) };
}

// POST /auth/totp/verify {email, code}: logowanie zwykłego konta kodem z telefonu (konto system: /auth/system/verify).
export async function verifyPhoneLogin(body: { email?: unknown; code?: unknown }, ip: string) {
  const email = normalizeEmail(body.email);
  if (!email) throw new AuthError(texts('err.emailRequired'));
  const now = Date.now();
  const locked = await phoneLockSeconds(email, now);
  if (locked) throw phoneLockedError(locked);
  const code = cleanCode(body.code);
  if (!/^\d{6}$/.test(code)) throw new AuthError(texts('err.codeDigits'));
  const result = await checkPhoneCode(email, code, now);
  if (result === 'unavailable') throw new AuthError(texts('err.totpUnavailable'), 503);
  if (result === 'none') throw new AuthError(texts('err.totpOff'));
  if (result === 'used') throw new AuthError(texts('err.totpUsed'));
  if (result === 'wrong') throw await phoneFailure(email, now, ip);
  await AuthCodeModel.deleteMany({ purpose: 'totp-fail', email });
  return signInVerifiedEmail(email);
}

export type PhoneStatus = {
  /** można włączyć albo wyłączyć (klucz szyfrujący, baza kluczy i adres są) */
  available: boolean;
  enabled: boolean;
  address: string;
  /** gdzie zarejestrowano telefon (my-home, archiwum, admin) i kiedy */
  app?: string;
  since?: Date;
  /** dlaczego niedostępne: off = serwer bez LOGOWANIE_KLUCZ, store = baza kluczy niedostępna, address = system bez adresu */
  reason?: 'off' | 'store' | 'address' | 'demo';
};

// GET /auth/totp: stan dla karty „Logowanie kodem z telefonu”.
export async function phoneStatus(user: UserEntry): Promise<PhoneStatus> {
  if (user.isDemo) return { available: false, enabled: false, address: '', reason: 'demo' };
  const address = phoneAddress(user);
  if (!totpConfigured()) return { available: false, enabled: false, address, reason: 'off' };
  if (!address) return { available: false, enabled: false, address, reason: 'address' };
  try {
    const doc = await findTotpKey(address);
    return doc
      ? { available: true, enabled: true, address, app: doc.aplikacja, since: doc.utworzono }
      : { available: true, enabled: false, address };
  } catch (error) {
    warnStore(error);
    return { available: false, enabled: false, address, reason: 'store' };
  }
}

// rejestracje w toku: skrót tokenu sesji → sekret (tylko w pamięci, najwyżej PHONE_SETUP_MS)
const pendingSetups = new Map<string, { address: string; secret: Buffer; expiresAt: number }>();

// POST /auth/totp/setup: nowy sekret, kod QR i klucz tekstem; nic nie trafia jeszcze do bazy kluczy.
export async function startPhoneSetup(user: UserEntry, sessionToken: string) {
  const status = await phoneStatus(user);
  if (!status.available) throw new AuthError(texts(status.reason === 'address' ? 'err.totpNoAddress' : 'err.totpUnavailable'), 503);
  if (status.enabled) throw new AuthError(texts('err.totpAlreadyOn'), 409);
  const now = Date.now();
  for (const [key, entry] of pendingSetups) if (entry.expiresAt <= now) pendingSetups.delete(key);
  const secret = newTotpSecret();
  pendingSetups.set(sha256(sessionToken), { address: status.address, secret, expiresAt: now + PHONE_SETUP_MS });
  const key = base32Encode(secret);
  const url = otpauthUrl(status.address, key);
  return { address: status.address, secret: key, otpauthUrl: url, qr: await qrDataUrl(url), expiresInSeconds: Math.round(PHONE_SETUP_MS / 1000) };
}

// POST /auth/totp/confirm {code}: pierwszy kod z aplikacji zapisuje telefon w totp_klucze (od tej chwili wszystkie
// aplikacje mojeturnie.pl proszą o kod z telefonu dla tego adresu).
export async function confirmPhoneSetup(user: UserEntry, sessionToken: string, codeValue: unknown) {
  const entry = pendingSetups.get(sha256(sessionToken));
  if (!entry || entry.expiresAt <= Date.now() || entry.address !== phoneAddress(user)) throw new AuthError(texts('err.totpSetupExpired'));
  const code = cleanCode(codeValue);
  if (!/^\d{6}$/.test(code)) throw new AuthError(texts('err.codeDigits'));
  const window = matchTotp(entry.secret, code);
  if (window === null) throw new AuthError(texts('err.totpWrongSetup'));
  try {
    if (!(await markTotpUsed(entry.address, window))) throw new AuthError(texts('err.totpUsed'));
    if (!(await insertTotpKey(entry.address, entry.secret))) throw new AuthError(texts('err.totpAlreadyOn'), 409);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    warnStore(error);
    throw new AuthError(texts('err.totpUnavailable'), 503);
  }
  pendingSetups.delete(sha256(sessionToken));
  if (user.isSystem) console.log('[konta] system: zarejestrowano telefon (kod z aplikacji)');
  return phoneStatus(user);
}

/** rezygnacja z rejestracji w toku (przycisk „Anuluj”) */
export const cancelPhoneSetup = (sessionToken: string) => { pendingSetups.delete(sha256(sessionToken)); };

// POST /auth/totp/disable/code: kod z maila do wyłączenia telefonu (konto system: zwykły kod konta system).
export async function sendPhoneDisableCode(user: UserEntry, ip: string, lang: Lang = DEFAULT_LANG) {
  if (user.isSystem) return startSystemLogin(ip, lang);
  if (!user.email) throw new AuthError(texts('err.totpOff'));
  await assertMailAvailable();
  const { code, expiresAt } = await createCode('totp-disable', user.email, { userId: String(user._id) });
  await sendMail(phoneDisableMail(user.email, code, expiresAt, mailLang(user, lang)));
  return { delivery: 'mail' as const, expiresInSeconds: Math.round(CODE_TTL_MS / 1000), resendAfterSeconds: Math.round(RESEND_MS / 1000) };
}

// POST /auth/totp/disable {code}: kod z telefonu albo z maila; usuwa klucz adresu we wspólnej bazie, więc kod z telefonu
// przestaje działać we wszystkich aplikacjach. Potem można zarejestrować nowy telefon.
export async function disablePhone(user: UserEntry, codeValue: unknown, ip: string) {
  const status = await phoneStatus(user);
  if (!status.enabled) throw new AuthError(texts('err.totpOff'));
  if (user.isSystem) {
    await consumeSystemCode(codeValue, ip);
  } else {
    const code = cleanCode(codeValue);
    if (!/^\d{6}$/.test(code)) throw new AuthError(texts('err.codeDigits'));
    const now = Date.now();
    const locked = await phoneLockSeconds(status.address, now);
    const phone = locked ? 'wrong' : await checkPhoneCode(status.address, code, now);
    if (phone === 'used') throw new AuthError(texts('err.totpUsed'));
    if (phone !== 'ok') {
      const userId = String(user._id);
      // kod z maila (zamówiony przyciskiem „Wyślij kod na maila”) ma własne limity (consumeCode)
      if (await AuthCodeModel.exists({ purpose: 'totp-disable', userId, expiresAt: { $gt: new Date(now) } })) {
        await consumeCode('totp-disable', { code, userId });
      } else if (locked) {
        throw phoneLockedError(locked);
      } else if (phone === 'unavailable') {
        throw new AuthError(texts('err.totpUnavailable'), 503);
      } else {
        throw await phoneFailure(status.address, now, ip);
      }
    } else {
      await AuthCodeModel.deleteMany({ purpose: 'totp-fail', email: status.address });
    }
  }
  try {
    await deleteTotpKey(status.address);
  } catch (error) {
    warnStore(error);
    throw new AuthError(texts('err.totpUnavailable'), 503);
  }
  if (user.isSystem) console.log(`[konta] system: wyłączono kod z telefonu (IP ${ip})`);
  return phoneStatus(user);
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
