// Maile kont użytkowników (2026-10-11): kod i link logowania, kod logowania konta system (od 2026-11-13, z adresem IP,
// z którego go zamówiono), zmiana e-maila, usunięcie konta, udostępnienie sterownika, powiadomienie administratora o rejestracji. SMTP tylko ze zmiennych środowiskowych (SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_ADMIN; Render: Environment, lokalnie server/.env).
// Bez SMTP_HOST (testy, środowisko bez poczty) mail trafia do outbox w pamięci i do logu.
// MAIL_RELAY=1: serwer nie łączy się z pocztą, mail idzie do kolejki i wysyła go sterownik (mail-relay.service.ts).
// Office 365 wysyła tylko z adresu konta SMTP_USER, chyba że ma ono uprawnienie „Send As” do MAIL_FROM
// (próba 2026-10-11: inny nadawca = 5.2.252 SendAsDenied), dlatego przy odmowie mail idzie z SMTP_USER.
import { setting } from './settings.service';
import nodemailer, { Transporter } from 'nodemailer';
import { enqueueMail, relayEnabled } from './mail-relay.service';
import { DEFAULT_LANG, Lang, locale } from '../i18n';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** maile wysłane bez SMTP (testy); najnowszy na końcu */
export const outbox: OutgoingMail[] = [];

let transport: Transporter | null = null;
const smtpTransport = () => {
  if (!setting('SMTP_HOST')) return null;
  transport ??= nodemailer.createTransport({
    host: setting('SMTP_HOST'),
    port: Number(setting('SMTP_PORT') ?? 587),
    secure: false,
    requireTLS: true,
    auth: { user: setting('SMTP_USER'), pass: setting('SMTP_PASS') },
    // limity czasu (ms): bez nich zwlekający serwer pocztowy trzymał żądanie logowania bez końca
    // (2026-10-17: przycisk „Wyślij kod” wisiał), a użytkownik nie dostawał żadnego błędu
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
};

/** po zmianie ustawień poczty w bazie */
export const resetMailTransport = () => { transport = null; };

export const adminEmail = () => setting('MAIL_ADMIN') ?? '';

/** poczta działa: SMTP z ustawień albo przekaźnik przez sterowniki; bez niej maile trafiają tylko do outbox i dziennika */
export const mailConfigured = () => relayEnabled() || !!setting('SMTP_HOST');

export async function sendMail(mail: OutgoingMail): Promise<void> {
  // MAIL_RELAY=1 (Render na darmowym planie blokuje SMTP): mail wysyła sterownik z domowego łącza
  if (relayEnabled()) {
    await enqueueMail(mail);
    return;
  }
  const smtp = smtpTransport();
  if (!smtp) {
    outbox.push(mail);
    console.log(`[mail] (bez SMTP) do ${mail.to}: ${mail.subject}`);
    return;
  }
  const user = setting('SMTP_USER') ?? '';
  const from = setting('MAIL_FROM') || user;
  try {
    await smtp.sendMail({ from: `Mój Dom <${from}>`, ...mail });
  } catch (error) {
    // brak „Send As” do MAIL_FROM: wysyłka z adresu konta, odpowiedzi na MAIL_FROM
    if (from === user || !/SendAsDenied|5\.2\.252/.test(String((error as { response?: string }).response ?? error))) throw error;
    await smtp.sendMail({ from: `Mój Dom <${user}>`, replyTo: from, ...mail });
  }
}

// Adres klienta dla linków w mailach: Origin żądania, gdy jest na liście CLIENT_URL (po przecinku) albo jest
// lokalny (localhost, 127.0.0.1, sieć 192.168.x.x — środowisko deweloperskie); inaczej pierwszy z CLIENT_URL.
// Obcy Origin nie trafia do linku (link z tokenem logowania prowadziłby na cudzą stronę).
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/;
export function clientBaseUrl(origin?: string): string {
  const allowed = (setting('CLIENT_URL') ?? '').split(',').map((url) => url.trim().replace(/\/$/, '')).filter(Boolean);
  if (origin && (allowed.includes(origin) || LOCAL_ORIGIN.test(origin))) return origin;
  return allowed[0] ?? 'http://localhost:5173';
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// Wspólny wygląd maila: pasek w kolorze aplikacji, akapity, opcjonalny kod i przycisk.
function layout(options: { paragraphs: string[]; code?: string; button?: { label: string; url: string; danger?: boolean }; footer: string; danger?: boolean }) {
  const color = options.danger ? '#b3261e' : '#1481a5';
  const body = options.paragraphs.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p)}</p>`).join('');
  const code = options.code
    ? `<div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;padding:12px;background:#f0f0f0;border-radius:6px;margin:0 0 14px">${escapeHtml(options.code)}</div>`
    : '';
  const button = options.button
    ? `<p style="text-align:center;margin:0 0 14px"><a href="${escapeHtml(options.button.url)}" style="display:inline-block;padding:12px 24px;background:${options.button.danger ? '#b3261e' : '#1481a5'};color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(options.button.label)}</a></p>`
    : '';
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">`
    + `<div style="height:8px;background:${color}"></div><div style="padding:20px">${body}${code}${button}`
    + `<p style="margin:0;font-size:13px;color:#555">${escapeHtml(options.footer)}</p></div></div>`;
}

export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
export const until = (expiresAt: Date, lang: Lang) => expiresAt.toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
const moment = (at: Date, lang: Lang) => at.toLocaleString(locale(lang), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

// Teksty maili w obu językach (wersja językowa 2026-10-21): język odbiorcy = język jego konta, a bez konta język
// żądania (ekranu logowania); mail do administratora zostaje po polsku.
const M = {
  pl: {
    hello: 'Dzień dobry,',
    loginSubject: 'Kod logowania: {code}',
    loginFooter: 'Kod i link są ważne 10 minut (do {until}) i działają tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość.',
    loginCode: 'Twój kod logowania:',
    loginLink: 'Możesz też zalogować się linkiem:',
    loginButton: 'Zaloguj się',
    systemSubject: 'Kod logowania system: {code}',
    systemCode: 'kod logowania konta system:',
    systemIp: 'Kod zamówiono z adresu IP {ip} ({when}).',
    systemFooter: 'Kod jest ważny {minutes} minut (do {until}) i działa tylko raz. Jeśli to nie Ty, nikomu go nie podawaj: po {attempts} błędnych kodach logowanie system blokuje się na {lock} minut.',
    changeSubject: 'Potwierdź nowy adres: {code}',
    changeFooter: 'Kod jest ważny 10 minut (do {until}). Jeśli to nie Ty, zignoruj tę wiadomość.',
    changeCode: 'kod potwierdzenia nowego adresu e-mail:',
    changedSubject: 'Zmiana adresu e-mail konta',
    changedText: 'Adres e-mail konta został zmieniony na {email}. Kolejne logowania — tym adresem.',
    changedFooter: 'Jeśli to nie Ty, skontaktuj się z administratorem.',
    deleteSubject: 'Potwierdź usunięcie konta',
    deleteIntro: 'otrzymaliśmy prośbę o usunięcie konta {email}.',
    deleteWarning: 'Usunięcie konta spowoduje usunięcie wszystkich danych: konta, {devices} sterowników i całej ich historii (pomiary, harmonogramy, ustawienia). Tego nie da się cofnąć.',
    deleteFooter: 'Link jest ważny 10 minut i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość — konto zostanie bez zmian.',
    deleteLink: 'Usuń konto:',
    deleteButton: 'Usuń konto i wszystkie dane',
    shareSubject: '{owner} udostępnia Ci sterownik',
    shareIntro: '{owner} udostępnia Ci sterownik „{device}”.',
    shareAccess: 'Dostęp do zakładek: {tabs}.',
    shareHasAccount: 'Sterownik jest już na ekranie głównym aplikacji.',
    shareNoAccount: 'Zaloguj się adresem {email} — przy pierwszym logowaniu założymy konto.',
    shareFooter: 'Jeśli nie znasz tej osoby, zignoruj tę wiadomość.',
    shareButton: 'Otwórz aplikację',
  },
  en: {
    hello: 'Hello,',
    loginSubject: 'Sign-in code: {code}',
    loginFooter: 'The code and link are valid for 10 minutes (until {until}) and work only once. If this was not you, ignore this message.',
    loginCode: 'Your sign-in code:',
    loginLink: 'You can also sign in with the link:',
    loginButton: 'Sign in',
    systemSubject: 'System sign-in code: {code}',
    systemCode: 'the system account sign-in code:',
    systemIp: 'The code was requested from the IP address {ip} ({when}).',
    systemFooter: 'The code is valid for {minutes} minutes (until {until}) and works only once. If this was not you, do not share it with anyone: after {attempts} wrong codes system sign-in is locked for {lock} minutes.',
    changeSubject: 'Confirm the new address: {code}',
    changeFooter: 'The code is valid for 10 minutes (until {until}). If this was not you, ignore this message.',
    changeCode: 'confirmation code for the new e-mail address:',
    changedSubject: 'Account e-mail address changed',
    changedText: 'The account e-mail address was changed to {email}. Use this address for future sign-ins.',
    changedFooter: 'If this was not you, contact the administrator.',
    deleteSubject: 'Confirm account deletion',
    deleteIntro: 'we received a request to delete the account {email}.',
    deleteWarning: 'Deleting the account removes all data: the account, {devices} controllers and their whole history (readings, schedules, settings). This cannot be undone.',
    deleteFooter: 'The link is valid for 10 minutes and works only once. If this was not you, ignore this message — the account stays unchanged.',
    deleteLink: 'Delete the account:',
    deleteButton: 'Delete the account and all data',
    shareSubject: '{owner} shares a controller with you',
    shareIntro: '{owner} shares the controller “{device}” with you.',
    shareAccess: 'Access to tabs: {tabs}.',
    shareHasAccount: 'The controller is already on the app home screen.',
    shareNoAccount: 'Sign in with the address {email} — the account is created at the first sign-in.',
    shareFooter: 'If you do not know this person, ignore this message.',
    shareButton: 'Open the app',
  },
} as const;
type MailKey = keyof typeof M.pl;
const m = (lang: Lang, key: MailKey, params?: Record<string, string | number>) =>
  M[lang][key].replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match));

export function loginMail(to: string, code: string, url: string, expiresAt: Date, lang: Lang = DEFAULT_LANG): OutgoingMail {
  const footer = m(lang, 'loginFooter', { until: until(expiresAt, lang) });
  return {
    to,
    subject: m(lang, 'loginSubject', { code: formatCode(code) }),
    text: `${m(lang, 'hello')}\n\n${m(lang, 'loginCode')} ${formatCode(code)}\n\n${m(lang, 'loginLink')} ${url}\n\n${footer}`,
    html: layout({
      paragraphs: [m(lang, 'hello'), m(lang, 'loginCode')], code: formatCode(code),
      button: { label: m(lang, 'loginButton'), url }, footer,
    }),
  };
}

// Kod konta system (bez linku): zawsze na stały adres z ustawień (auth.service.ts systemEmail), z adresem IP, z którego
// zamówiono kod; limity podaje auth.service (ważność, liczba prób, czas blokady).
export function systemLoginMail(
  to: string, code: string, expiresAt: Date, ip: string, limits: { minutes: number; attempts: number; lock: number },
  lang: Lang = DEFAULT_LANG, requestedAt = new Date(),
): OutgoingMail {
  const footer = m(lang, 'systemFooter', { ...limits, until: until(expiresAt, lang) });
  const origin = m(lang, 'systemIp', { ip, when: moment(requestedAt, lang) });
  return {
    to,
    subject: m(lang, 'systemSubject', { code: formatCode(code) }),
    text: `${m(lang, 'hello')}\n\n${m(lang, 'systemCode')} ${formatCode(code)}\n\n${origin}\n\n${footer}`,
    // w HTML akapity stoją przed kodem, więc adres IP idzie do stopki pod kodem
    html: layout({ paragraphs: [m(lang, 'hello'), m(lang, 'systemCode')], code: formatCode(code), footer: `${origin} ${footer}` }),
  };
}

export function emailChangeMail(to: string, code: string, expiresAt: Date, lang: Lang = DEFAULT_LANG): OutgoingMail {
  const footer = m(lang, 'changeFooter', { until: until(expiresAt, lang) });
  return {
    to,
    subject: m(lang, 'changeSubject', { code: formatCode(code) }),
    text: `${m(lang, 'hello')}\n\n${m(lang, 'changeCode')} ${formatCode(code)}\n\n${footer}`,
    html: layout({ paragraphs: [m(lang, 'hello'), m(lang, 'changeCode')], code: formatCode(code), footer }),
  };
}

export function emailChangedMail(to: string, newEmail: string, lang: Lang = DEFAULT_LANG): OutgoingMail {
  const text = m(lang, 'changedText', { email: newEmail });
  const footer = m(lang, 'changedFooter');
  return {
    to,
    subject: m(lang, 'changedSubject'),
    text: `${m(lang, 'hello')}\n\n${text}\n\n${footer}`,
    html: layout({ paragraphs: [m(lang, 'hello'), text], footer }),
  };
}

export function deleteAccountMail(to: string, url: string, devices: number, lang: Lang = DEFAULT_LANG): OutgoingMail {
  const warning = m(lang, 'deleteWarning', { devices });
  const footer = m(lang, 'deleteFooter');
  const intro = m(lang, 'deleteIntro', { email: to });
  return {
    to,
    subject: m(lang, 'deleteSubject'),
    text: `${m(lang, 'hello')}\n\n${intro}\n\n${warning}\n\n${m(lang, 'deleteLink')} ${url}\n\n${footer}`,
    html: layout({
      paragraphs: [m(lang, 'hello'), intro, warning],
      button: { label: m(lang, 'deleteButton'), url, danger: true }, footer, danger: true,
    }),
  };
}

export function shareMail(to: string, ownerName: string, deviceName: string, tabs: string, url: string, hasAccount: boolean, lang: Lang = DEFAULT_LANG): OutgoingMail {
  const intro = m(lang, 'shareIntro', { owner: ownerName, device: deviceName });
  const access = m(lang, 'shareAccess', { tabs });
  const login = hasAccount ? m(lang, 'shareHasAccount') : m(lang, 'shareNoAccount', { email: to });
  const footer = m(lang, 'shareFooter');
  return {
    to,
    subject: m(lang, 'shareSubject', { owner: ownerName }),
    text: `${m(lang, 'hello')}\n\n${intro}\n${access}\n\n${login}\n${url}\n\n${footer}`,
    html: layout({ paragraphs: [m(lang, 'hello'), intro, access, login], button: { label: m(lang, 'shareButton'), url }, footer }),
  };
}

export function registrationAdminMail(to: string, email: string): OutgoingMail {
  const text = `Nowe konto: ${email} (${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}).`;
  return { to, subject: `Nowe konto: ${email}`, text, html: layout({ paragraphs: [text], footer: 'Powiadomienie administratora.' }) };
}
