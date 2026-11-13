// /api/auth/* (konta użytkowników, 2026-10-11): logowanie kodem lub linkiem z maila, logowanie systemowe (od 2026-11-13
// kodem z maila na stały adres z ustawień, bez hasła), „Zapamiętaj 90 dni”, wylogowanie, dane konta, zmiana e-maila
// i usunięcie konta. Ścieżki są publiczne dla middleware (session.ts), więc te, które dotyczą zalogowanego, sprawdzają
// req.user same (signedIn).
import { Request, Response } from 'express';
import {
  AuthError, confirmDeleteAccount, demoAvailable, demoLogin, logout, publicUser, setRemember, startDeleteAccount, startEmailChange,
  setLanguage, startLogin, startSystemLogin, updateProfile, verifyEmailChange, verifyLogin, verifySystemLogin,
} from '../services/auth.service';
import { MailUnavailableError } from '../services/mail-relay.service';
import { requestLang, t, texts } from '../i18n';

// komunikaty w języku żądania (Accept-Language od klienta, inaczej język konta; core/i18n.ts)
const fail = (req: Request, res: Response, error: unknown) => {
  const lang = requestLang(req);
  if (error instanceof AuthError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({ message: error.messageFor(lang), retryAfterSeconds: error.retryAfterSeconds, ...error.extra });
  }
  // przekaźnik poczty (MAIL_RELAY=1) bez sterownika w sieci: komunikat zamiast „Błąd serwera”
  if (error instanceof MailUnavailableError) return res.status(error.status).json({ message: error.messageFor(lang) });
  console.error('[konta]', error);
  return res.status(500).json({ message: t(lang, 'err.server') });
};

const signedIn = (req: Request, res: Response) => {
  if (req.user && req.sessionToken) return true;
  res.status(401).json({ message: t(requestLang(req), 'err.signIn') });
  return false;
};

const run = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await handler(req, res);
  } catch (error) {
    fail(req, res, error);
  }
};

// POST /auth/start {email}: kod i link na e-mail (nowy adres = rejestracja po weryfikacji)
export const authStart = run(async (req, res) => {
  res.status(200).json(await startLogin(req.body?.email, req.header('origin'), requestLang(req)));
});

// POST /auth/verify {email, code} albo {token}: sesja; created = nowe konto (formularz danych)
export const authVerify = run(async (req, res) => {
  res.status(200).json(await verifyLogin(req.body ?? {}));
});

// Adres IP klienta (za nginx: trust proxy w core/app.ts, X-Forwarded-For); IPv4 bez przedrostka ::ffff:
const clientIp = (req: Request) => (req.ip ?? '').replace(/^::ffff:/, '') || 'nieznany';

// POST /auth/system: kod logowania użytkownika systemowego (w kliencie: „system” wpisane w pole e-mail) na stały adres
// z ustawień albo do dziennika serwera → {delivery, expiresInSeconds, resendAfterSeconds}. Hasła nie ma: żądanie
// z {password} (klient sprzed 2026-11-13) dostaje 400 z prośbą o odświeżenie strony i nie wysyła kodu.
export const authSystem = run(async (req, res) => {
  if (req.body?.password !== undefined) throw new AuthError(texts('err.systemPasswordGone'));
  res.status(200).json(await startSystemLogin(clientIp(req), requestLang(req)));
});

// POST /auth/system/verify {code}: sesja użytkownika systemowego, jak POST /auth/verify
export const authSystemVerify = run(async (req, res) => {
  res.status(200).json(await verifySystemLogin(req.body?.code, clientIp(req)));
});

// POST /auth/remember {remember}: odpowiedź na „Zapamiętać Twoje dane … na najbliższe 90 dni?”
// GET /auth/demo: czy wersja demo jest włączona (przycisk pod logowaniem); POST /auth/demo: sesja demo (2 h, tylko odczyt)
export const authDemoAvailable = run(async (_req, res) => {
  res.status(200).json({ available: demoAvailable() });
});

export const authDemo = run(async (req, res) => {
  res.status(200).json(await demoLogin(req.ip ?? ''));
});

export const authRemember = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await setRemember(req.sessionToken as string, req.body?.remember === true));
});

export const authLogout = run(async (req, res) => {
  if (req.sessionToken) await logout(req.sessionToken);
  res.status(204).end();
});

export const authMe = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(publicUser(req.user!));
});

export const authUpdateMe = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await updateProfile(req.user!, req.body ?? {}));
});

// PUT /auth/me/language {language}: język aplikacji konta ('pl' | 'en'); także użytkownik systemowy
export const authSetLanguage = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await setLanguage(req.user!, req.body?.language));
});

// POST /auth/email-change {email}: kod na nowy adres; POST /auth/email-change/verify {code}: zmiana
export const authEmailChange = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await startEmailChange(req.user!, req.body?.email, requestLang(req)));
});

export const authEmailChangeVerify = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await verifyEmailChange(req.user!, req.body?.code));
});

// POST /auth/delete: link potwierdzenia na e-mail konta; POST /auth/delete/confirm {token}: usunięcie
// (link z maila działa bez zalogowania — token potwierdza dostęp do skrzynki)
export const authDelete = run(async (req, res) => {
  if (!signedIn(req, res)) return;
  res.status(200).json(await startDeleteAccount(req.user!, req.header('origin'), requestLang(req)));
});

export const authDeleteConfirm = run(async (req, res) => {
  res.status(200).json(await confirmDeleteAccount(req.body?.token));
});
