// Testy powiadomień Web Push (2026-10-21): ustawienia konta z katalogiem zdarzeń, subskrypcja przeglądarki,
// reguły (tylko własne sterowniki i zdarzenia rodzaju), start sprężarki → powiadomienie tylko do osoby z regułą,
// cisza nocna (pilne idzie mimo niej), próg powtórzeń, kasowanie wygasłej subskrypcji (410), offline z wartownika.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  setWeatherFromController: () => undefined,
  backupWeatherQueries: () => [],
  serverWeatherActive: () => false,
  weatherStale: () => false,
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}));

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...args: unknown[]) => sendNotification(...args) },
}));

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { PushSubscriptionModel } from '../src/core/models/push-subscription.model'
import { SwitchRelayModel } from '../src/modules/switch/models/switch-relay.model'
import { outbox } from '../src/core/services/mail.service'
import { inQuietHours, resetPushConfig, resetPushThrottle } from '../src/core/services/push.service'
import { resetPushWatchdog, runPushWatchdogOnce } from '../src/core/services/push-watchdog.service'
import { DeviceType } from '../src/core/types'

const lastMail = (to: string) => [...outbox].reverse().find((mail) => mail.to === to);
const codeOf = (to: string) => /(\d{3}) (\d{3})/.exec(lastMail(to)?.text ?? '')?.slice(1).join('') ?? '';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string) {
  await mongoose.connection.collection('auth_codes').deleteMany({ email });
  await request(app).post('/api/auth/start').send({ email }).expect(200);
  const res = await request(app).post('/api/auth/verify').send({ email, code: codeOf(email) }).expect(200);
  return { token: res.body.token as string, id: res.body.user.id as string };
}

const subscription = (n: number) => ({ endpoint: `https://push.example/sub-${n}`, keys: { p256dh: 'p', auth: 'a' }, label: `Przeglądarka ${n}` });
const payloads = () => sendNotification.mock.calls.map((call) => JSON.parse(call[1] as string) as { body: string; event: string });

describe('Powiadomienia Web Push', () => {
  let mongoServer: MongoMemoryServer;
  let anna: { token: string; id: string };
  let bartek: { token: string; id: string };
  let pumpRootId: string;
  let switchRootId: string;

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0';
    process.env.CLIENT_URL = 'https://app.example';
    process.env.VAPID_PUBLIC_KEY = 'public';
    process.env.VAPID_PRIVATE_KEY = 'private';
    delete process.env.SMTP_HOST;
    resetPushConfig();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    anna = await login('anna@example.com');
    bartek = await login('bartek@example.com');
    pumpRootId = String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'AA0000000001', name: 'Pompa', ownerId: anna.id }))._id);
    const registered = await request(app).post('/api/devices/register').send({ deviceId: 'AA0000000002', deviceType: 'switch', name: 'Włącznik', relays: 1 }).expect(201);
    switchRootId = registered.body.rootId;
    await DeviceModel.updateOne({ _id: switchRootId }, { $set: { ownerId: anna.id } });
    await SwitchRelayModel.updateOne({ rootId: switchRootId, relay: 1 }, { $set: { name: 'Bojler' } });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({});
    resetPushThrottle();
  });

  it('ustawienia: klucz publiczny, katalog zdarzeń i tylko dostępne sterowniki', async () => {
    const res = await request(app).get('/api/push/settings').set(bearer(anna.token)).expect(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.publicKey).toBe('public');
    expect(res.body.devices.map((d: { name: string }) => d.name).sort()).toEqual(['Pompa', 'Włącznik']);
    expect(res.body.events.heat_pump.map((e: { key: string }) => e.key)).toContain('compressor-on');
    const other = await request(app).get('/api/push/settings').set(bearer(bartek.token)).expect(200);
    expect(other.body.devices).toEqual([]);
    await request(app).get('/api/push/settings').expect(401);
  });

  it('subskrypcja i reguły: obce sterowniki 403, obce zdarzenia pomijane', async () => {
    const created = await request(app).post('/api/push/subscriptions').set(bearer(anna.token)).send(subscription(1)).expect(201);
    expect(created.body.label).toBe('Przeglądarka 1');
    // ten sam endpoint raz (ta sama przeglądarka)
    await request(app).post('/api/push/subscriptions').set(bearer(anna.token)).send(subscription(1)).expect(201);
    expect(await PushSubscriptionModel.countDocuments({ userId: anna.id })).toBe(1);
    await request(app).post('/api/push/subscriptions').set(bearer(anna.token)).send({ endpoint: 'http://x' }).expect(400);

    await request(app).put('/api/push/rules').set(bearer(bartek.token)).send({ rules: [{ rootId: pumpRootId, events: ['error'] }] }).expect(403);
    const saved = await request(app).put('/api/push/rules').set(bearer(anna.token)).send({
      rules: [{ rootId: pumpRootId, events: ['compressor-on', 'error', 'relay-on', 'x'] }, { rootId: switchRootId, events: ['relay-on', 'offline'] }],
      quietFrom: null, quietTo: null,
    }).expect(200);
    expect(saved.body.rules).toEqual([{ rootId: pumpRootId, events: ['compressor-on', 'error'] }, { rootId: switchRootId, events: ['relay-on', 'offline'] }]);
    await request(app).put('/api/push/rules').set(bearer(anna.token)).send({ rules: [], quietFrom: '22:00' }).expect(400);
    await request(app).put('/api/push/rules').set(bearer(anna.token)).send({ rules: [], quietFrom: '25:00', quietTo: '06:00' }).expect(400);
    // reguły zostają z poprzedniego zapisu
    const settings = await request(app).get('/api/push/settings').set(bearer(anna.token)).expect(200);
    expect(settings.body.rules).toHaveLength(2);
  });

  it('start sprężarki: powiadomienie tylko do osoby z regułą, stop bez reguły nie idzie', async () => {
    await request(app).post('/api/push/subscriptions').set(bearer(bartek.token)).send(subscription(2)).expect(201);
    const post = (hps: boolean) => request(app).post(`/api/hp/add?rootId=${pumpRootId}&deviceId=AA0000000001`)
      .send({ HP: { Ttarget: 40.5, HPS: hps, ERR: 0, ERRn: 0 }, time: '2026.10.21 10:00:00' }).expect(201);
    await post(false);
    expect(sendNotification).not.toHaveBeenCalled();
    await post(true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ endpoint: 'https://push.example/sub-1' });
    expect(payloads()[0]).toMatchObject({ event: 'compressor-on', body: 'Sprężarka ruszyła · zbiornik 40.5 °C' });
    await post(false);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('treść powiadomienia w języku konta odbiorcy (users.language = en)', async () => {
    await request(app).put('/api/auth/me/language').set(bearer(anna.token)).send({ language: 'en' }).expect(200);
    const post = (hps: boolean) => request(app).post(`/api/hp/add?rootId=${pumpRootId}&deviceId=AA0000000001`)
      .send({ HP: { Ttarget: 40.5, HPS: hps, ERR: 0, ERRn: 0 }, time: '2026.10.21 10:00:00' }).expect(201);
    await post(false);
    await post(true);
    expect(payloads()[0]).toMatchObject({ event: 'compressor-on', body: 'Compressor started · tank 40.5 °C' });
    await request(app).put('/api/auth/me/language').set(bearer(anna.token)).send({ language: 'pl' }).expect(200);
  });

  it('cisza nocna wstrzymuje przekaźnik, ale nie błąd pompy; powtórka w minucie pomijana', async () => {
    expect(inQuietHours({ quietFrom: '22:00', quietTo: '06:00' }, new Date('2026-10-21T22:30:00Z'))).toBe(true);
    expect(inQuietHours({ quietFrom: '22:00', quietTo: '06:00' }, new Date('2026-10-21T10:00:00Z'))).toBe(false);
    expect(inQuietHours({ quietFrom: '08:00', quietTo: '09:00' }, new Date('2026-10-21T06:30:00Z'))).toBe(true); // 08:30 w Warszawie
    // cisza przez całą dobę poza jedną minutą: teraz na pewno cisza
    await request(app).put('/api/push/rules').set(bearer(anna.token)).send({
      rules: [{ rootId: pumpRootId, events: ['error'] }, { rootId: switchRootId, events: ['relay-on'] }], quietFrom: '00:01', quietTo: '00:00',
    }).expect(200);
    const state = (on: boolean) => request(app).post('/api/switch/state?deviceId=AA0000000002').send({ uptimeS: 100, relays: [{ on, changedS: 1 }] }).expect(200);
    await state(true);
    expect(sendNotification).not.toHaveBeenCalled();
    await request(app).post(`/api/hp/add?rootId=${pumpRootId}&deviceId=AA0000000001`)
      .send({ HP: { Ttarget: 41, HPS: false, ERR: 3, ERRn: 1 }, time: '2026.10.21 10:01:00' }).expect(201);
    expect(payloads()).toEqual([expect.objectContaining({ event: 'error', body: 'Błąd 3: brak przepływu · zbiornik 41.0 °C' })]);

    await request(app).put('/api/push/rules').set(bearer(anna.token)).send({ rules: [{ rootId: switchRootId, events: ['relay-on', 'offline'] }] }).expect(200);
    sendNotification.mockClear();
    await state(false);
    await state(true);
    await state(false);
    await state(true);
    expect(payloads().map((p) => p.body)).toEqual(['Bojler: włączony.']);
  });

  it('wygasła subskrypcja (410) jest kasowana; próbne powiadomienie', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await request(app).post('/api/push/test').set(bearer(anna.token)).expect(200);
    expect(await PushSubscriptionModel.countDocuments({ userId: anna.id })).toBe(0);
    await request(app).post('/api/push/test').set(bearer(anna.token)).expect(409);
    const sub = await request(app).post('/api/push/subscriptions').set(bearer(anna.token)).send(subscription(3)).expect(201);
    await request(app).delete(`/api/push/subscriptions/${sub.body.id}`).set(bearer(bartek.token)).expect(404);
    await request(app).delete(`/api/push/subscriptions/${sub.body.id}`).set(bearer(anna.token)).expect(204);
  });

  it('wartownik: sterownik offline po 5 min bez zgłoszenia, pierwszy przebieg tylko zapamiętuje', async () => {
    await request(app).post('/api/push/subscriptions').set(bearer(anna.token)).send(subscription(4)).expect(201);
    resetPushWatchdog();
    await request(app).post('/api/switch/state?deviceId=AA0000000002').send({ uptimeS: 200, relays: [{ on: false, changedS: 1 }] }).expect(200);
    await runPushWatchdogOnce();
    await SwitchRelayModel.updateMany({ rootId: switchRootId }, { $set: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) } });
    await runPushWatchdogOnce();
    expect(payloads().map((p) => p.event)).toEqual(['offline']);
    await runPushWatchdogOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
