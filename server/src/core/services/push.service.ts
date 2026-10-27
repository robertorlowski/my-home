// Powiadomienia Web Push (2026-10-21): „pompa się włączyła”, „kocioł rozpala”, „przekaźnik włączony”, błąd, offline…
// na telefon i do przeglądarki, bez osobnej aplikacji. Przeglądarka użytkownika zapisuje subskrypcję (PushManager,
// karta „Powiadomienia” w /account), a serwer wysyła przez usługę push przeglądarki (biblioteka web-push, klucze VAPID
// z VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT; bez nich powiadomienia są wyłączone, a klient to pokazuje).
// Zdarzenia zgłaszają moduły rodzajów (notify) w miejscach, gdzie i tak zapisują stan ze sterownika: start i stop
// sprężarki (hp.service), rozpalanie i wygaszenie kotła (pellet-boiler-pelux200.service), zmiana przekaźnika
// (switch.service), uruchomienie hydroforu (water-pressure-tank.service); offline / online liczy push-watchdog.service
// z kafelków. Kto dostaje: użytkownicy, którzy w regułach konta (users.notifications.rules) zaznaczyli to zdarzenie
// dla tego sterownika i nadal mają do niego dostęp. Cisza nocna (quietFrom–quietTo, czas warszawski) wstrzymuje
// wszystko poza zdarzeniami pilnymi (błąd, alarm). To samo zdarzenie tego samego sterownika nie idzie do jednej
// osoby częściej niż co THROTTLE_MS. Render dopuszcza wychodzące HTTPS, więc wysyłka działa także na darmowym planie.
import webpush from 'web-push';
import { formatInTimeZone } from 'date-fns-tz';
import { DeviceType } from '../types';
import { DeviceModel } from '../models/device.model';
import { PushSubscriptionEntry, PushSubscriptionModel } from '../models/push-subscription.model';
import { UserEntry, UserModel, UserNotifications } from '../models/user.model';
import { accessibleDevices, deviceAccess } from './access.service';
import { forgetUserSessions } from './auth.service';
import { TIME_ZONE } from '../time';
import { Lang, LANG_LIST, pick, t, Texts, texts, userLanguage } from '../i18n';

export interface PushEventDefinition {
  key: string;
  label: string;
  /** zaznaczone przy pierwszym włączeniu powiadomień dla sterownika (klient) */
  default: boolean;
  /** idzie także w ciszy nocnej */
  urgent?: boolean;
}

/** katalog zdarzeń według rodzaju sterownika (klient rysuje z niego listę przełączników) */
export const PUSH_EVENTS: Partial<Record<DeviceType, PushEventDefinition[]>> = {
  [DeviceType.HP]: [
    { key: 'compressor-on', label: 'Sprężarka ruszyła', default: false },
    { key: 'compressor-off', label: 'Sprężarka stanęła', default: false },
    { key: 'error', label: 'Błąd sterownika pompy', default: true, urgent: true },
    { key: 'offline', label: 'Sterownik przestał odpowiadać', default: true },
    { key: 'online', label: 'Sterownik znów odpowiada', default: false },
  ],
  [DeviceType.PELLET_BOILER_PELUX200]: [
    { key: 'burning-on', label: 'Kocioł rozpala', default: true },
    { key: 'burning-off', label: 'Kocioł wygaszony', default: false },
    { key: 'alarm', label: 'Alarm kotła', default: true, urgent: true },
    { key: 'offline', label: 'Sterownik przestał odpowiadać', default: true },
    { key: 'online', label: 'Sterownik znów odpowiada', default: false },
  ],
  [DeviceType.SWITCH]: [
    { key: 'relay-on', label: 'Przekaźnik włączony', default: false },
    { key: 'relay-off', label: 'Przekaźnik wyłączony', default: false },
    { key: 'offline', label: 'Sterownik przestał odpowiadać', default: true },
    { key: 'online', label: 'Sterownik znów odpowiada', default: false },
  ],
  [DeviceType.WATER_PRESSURE_TANK]: [
    { key: 'pump-start', label: 'Pompa hydroforu uruchomiona', default: false },
  ],
};

export const pushEventsFor = (deviceType: DeviceType) => PUSH_EVENTS[deviceType] ?? [];

/** minimalny odstęp między tym samym zdarzeniem tego samego sterownika do tej samej osoby */
export const THROTTLE_MS = 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------------ konfiguracja (VAPID)

let configured: boolean | null = null;

/** klucze VAPID ze środowiska; ustawiane raz, wynik zapamiętany (testy: resetPushConfig) */
export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return (configured = false);
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey, privateKey);
    configured = true;
  } catch (error) {
    console.error('[push] nieprawidłowe klucze VAPID:', error);
    configured = false;
  }
  return configured;
}

export const pushPublicKey = () => (pushConfigured() ? process.env.VAPID_PUBLIC_KEY ?? null : null);
export const resetPushConfig = () => { configured = null; };

// ------------------------------------------------------------------ subskrypcje

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
}

export class PushError extends Error {
  readonly texts: Texts;
  constructor(message: string | Texts, public status = 400) {
    super(typeof message === 'string' ? message : message.pl);
    this.texts = typeof message === 'string' ? { pl: message, en: message } : message;
  }
  messageFor(lang: Lang): string { return this.texts[lang]; }
}

const validSubscription = (input: unknown): input is SubscriptionInput => {
  const sub = input as SubscriptionInput | null;
  return !!sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 2048
    && !!sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
};

/** zapis subskrypcji przeglądarki (ten sam endpoint = ta sama przeglądarka: nadpisanie, także po zmianie konta) */
export async function saveSubscription(user: UserEntry, input: unknown) {
  if (!validSubscription(input)) throw new PushError('Nieprawidłowa subskrypcja.');
  const label = String(input.label ?? '').slice(0, 80);
  const doc = await PushSubscriptionModel.findOneAndUpdate(
    { endpoint: input.endpoint },
    { $set: { userId: String(user._id), keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }, label } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<PushSubscriptionEntry>();
  return publicSubscription(doc!);
}

export async function removeSubscription(user: UserEntry, id: string) {
  const result = await PushSubscriptionModel.deleteOne({ _id: id, userId: String(user._id) }).catch(() => ({ deletedCount: 0 }));
  if (!result.deletedCount) throw new PushError('Nie ma takiej subskrypcji.', 404);
}

export const listSubscriptions = async (user: UserEntry) =>
  (await PushSubscriptionModel.find({ userId: String(user._id) }).sort({ createdAt: 1 }).lean<PushSubscriptionEntry[]>()).map(publicSubscription);

const publicSubscription = (doc: PushSubscriptionEntry) => ({
  id: String(doc._id), endpoint: doc.endpoint, label: doc.label, createdAt: doc.createdAt, lastUsedAt: doc.lastUsedAt ?? null,
});

// ------------------------------------------------------------------ reguły konta

/** zapis reguł: tylko sterowniki dostępne dla konta i zdarzenia z katalogu rodzaju; cisza nocna HH:mm albo brak */
export async function saveRules(user: UserEntry, input: unknown): Promise<UserNotifications> {
  const body = (input ?? {}) as { rules?: unknown; quietFrom?: unknown; quietTo?: unknown };
  const quietFrom = body.quietFrom ? String(body.quietFrom) : null;
  const quietTo = body.quietTo ? String(body.quietTo) : null;
  if ((quietFrom && !TIME_RE.test(quietFrom)) || (quietTo && !TIME_RE.test(quietTo))) throw new PushError('Godziny ciszy nocnej w formacie HH:mm.');
  if (!!quietFrom !== !!quietTo) throw new PushError('Podaj obie godziny ciszy nocnej albo żadnej.');
  if (!Array.isArray(body.rules)) throw new PushError('Brak reguł.');
  const access = await accessibleDevices(user);
  const devices = await DeviceModel.find({ _id: { $in: [...access.keys()] } }).select('deviceType').lean<{ _id: unknown; deviceType: DeviceType }[]>();
  const typeOf = new Map(devices.map((device) => [String(device._id), device.deviceType]));
  const rules = [];
  for (const raw of body.rules as unknown[]) {
    const rule = raw as { rootId?: unknown; events?: unknown };
    const rootId = String(rule.rootId ?? '');
    const deviceType = typeOf.get(rootId);
    if (!deviceType) throw new PushError('Brak dostępu do sterownika z reguły.', 403);
    const allowed = new Set(pushEventsFor(deviceType).map((event) => event.key));
    const events = [...new Set((Array.isArray(rule.events) ? rule.events : []).map(String))].filter((key) => allowed.has(key));
    if (events.length) rules.push({ rootId, events });
  }
  const notifications: UserNotifications = { rules, quietFrom, quietTo };
  await UserModel.updateOne({ _id: user._id }, { $set: { notifications } });
  forgetUserSessions(String(user._id));
  return notifications;
}

export const userNotifications = (user: UserEntry): UserNotifications =>
  user.notifications ?? { rules: [], quietFrom: null, quietTo: null };

/** czy chwila now (Warszawa) mieści się w ciszy nocnej from–to (okno przez północ dozwolone; from = to = bez ciszy) */
export function inQuietHours(settings: { quietFrom?: string | null; quietTo?: string | null }, now: Date): boolean {
  const { quietFrom, quietTo } = settings;
  if (!quietFrom || !quietTo || quietFrom === quietTo) return false;
  const time = formatInTimeZone(now, TIME_ZONE, 'HH:mm');
  return quietFrom < quietTo ? time >= quietFrom && time < quietTo : time >= quietFrom || time < quietTo;
}

// ------------------------------------------------------------------ wysyłka

export interface PushMessage {
  /** nagłówek; bez niego nazwa sterownika */
  title?: string | Texts;
  /** treść; w obu językach (core/i18n texts / both), gdy ma zależeć od języka odbiorcy (users.language) */
  body: string | Texts;
  /** strona po kliknięciu (względem klienta); bez niej lista sterowników */
  url?: string;
}

/** ostatnie wysłanie userId|rootId|event → czas (próg THROTTLE_MS) */
const lastSent = new Map<string, number>();

/** co zostało wysłane (testy i log); ostatnie 200 */
export const pushLog: { at: Date; userId: string; rootId: string; event: string; body: string }[] = [];

/**
 * Zdarzenie sterownika: powiadomienie do każdego, kto je zaznaczył dla tego sterownika. Nie rzuca wyjątków
 * (zapis stanu ze sterownika nie może się wywrócić przez powiadomienia). Zwraca liczbę osób, do których poszło.
 */
export async function notify(rootId: string, event: string, message: PushMessage, now = new Date()): Promise<number> {
  try {
    if (!pushConfigured()) return 0;
    const users = await UserModel.find({ 'notifications.rules': { $elemMatch: { rootId, events: event } } }).lean<UserEntry[]>();
    if (!users.length) return 0;
    const device = await DeviceModel.findById(rootId).select('name deviceId deviceType').lean<{ name?: string; deviceId: string; deviceType: DeviceType }>();
    if (!device) return 0;
    const definition = pushEventsFor(device.deviceType).find((item) => item.key === event);
    if (!definition) return 0;
    // treść w języku odbiorcy (users.language, bez wyboru polski); jeden payload na język
    const payloads = Object.fromEntries(LANG_LIST.map((lang) => [lang, JSON.stringify({
      title: pick(message.title ?? (device.name || device.deviceId), lang), body: pick(message.body, lang), url: message.url ?? '/devices',
      tag: `${rootId}:${event}`, rootId, event, at: now.toISOString(),
    })])) as Record<Lang, string>;
    let recipients = 0;
    for (const user of users) {
      const settings = userNotifications(user);
      if (!definition.urgent && inQuietHours(settings, now)) continue;
      if (!(await deviceAccess(user, rootId))) continue;
      const key = `${String(user._id)}|${rootId}|${event}`;
      const previous = lastSent.get(key);
      if (previous !== undefined && now.getTime() - previous < THROTTLE_MS) continue;
      const subscriptions = await PushSubscriptionModel.find({ userId: String(user._id) }).lean<PushSubscriptionEntry[]>();
      if (!subscriptions.length) continue;
      lastSent.set(key, now.getTime());
      recipients += 1;
      const lang = userLanguage(user);
      pushLog.push({ at: now, userId: String(user._id), rootId, event, body: pick(message.body, lang) });
      if (pushLog.length > 200) pushLog.splice(0, pushLog.length - 200);
      await Promise.all(subscriptions.map((subscription) => send(subscription, payloads[lang], now)));
    }
    return recipients;
  } catch (error) {
    console.error('[push]', event, rootId, error);
    return 0;
  }
}

/** powiadomienie próbne z karty „Powiadomienia” (przycisk „Wyślij próbne”); zwraca liczbę subskrypcji */
export async function sendTest(user: UserEntry, now = new Date()): Promise<number> {
  if (!pushConfigured()) throw new PushError(texts('err.pushOff'), 503);
  const subscriptions = await PushSubscriptionModel.find({ userId: String(user._id) }).lean<PushSubscriptionEntry[]>();
  if (!subscriptions.length) throw new PushError(texts('err.pushNoSubscriptions'), 409);
  const payload = JSON.stringify({
    title: 'My Home', body: t(userLanguage(user), 'push.testBody'), url: '/account', tag: 'test', event: 'test', at: now.toISOString(),
  });
  await Promise.all(subscriptions.map((subscription) => send(subscription, payload, now)));
  return subscriptions.length;
}

// Wysyłka do jednej przeglądarki; 404 / 410 = subskrypcja wygasła (użytkownik cofnął zgodę, przeglądarka odinstalowana)
// i jest kasowana. Inne błędy tylko w logu (usługa push bywa chwilowo niedostępna).
async function send(subscription: PushSubscriptionEntry, payload: string, now: Date) {
  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { TTL: 60 * 60 });
    await PushSubscriptionModel.updateOne({ _id: subscription._id }, { $set: { lastUsedAt: now } });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      await PushSubscriptionModel.deleteOne({ _id: subscription._id });
      console.log(`[push] subskrypcja wygasła (${status}): ${subscription.label || subscription.endpoint.slice(0, 40)}`);
      return;
    }
    console.error('[push] wysyłka:', status ?? error);
  }
}

/** testy: kasuje progi czasowe */
export const resetPushThrottle = () => lastSent.clear();
