// Testy przekaźnika poczty przez sterowniki (2026-10-17, core/services/mail-relay.service.ts): klucz płytki ze
// zgłoszenia czeka na zatwierdzenie przez użytkownika systemowego, dane SMTP i maile idą zaszyfrowane kluczem
// płytki, wynik tylko z potwierdzeniem, logowanie bez sterownika w sieci dostaje 503, włącznik wysyła pierwszy,
// a sterownik co przejmuje mail po FAILOVER_MS, po błędzie włącznika i po wygaśnięciu dzierżawy.
import crypto from 'crypto'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  weatherQueries: async () => [],
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}));

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { MailOutboxModel } from '../src/core/models/mail-outbox.model'
import { issueEmergencySystemCode } from '../src/core/services/auth.service'
import {
  FAILOVER_MS, LEASE_MS, Sealed, decryptWith, enqueueMail, mailResult, nextMailFor, resetRelaySeen,
} from '../src/core/services/mail-relay.service'
import { DeviceType } from '../src/core/types'

const keyPair = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64'), privateKey: ecdh.getPrivateKey() };
};

const SWITCH_SN = 'B0B0B0B0B001';
const PUMP_SN = 'B0B0B0B0B002';

describe('Przekaźnik poczty przez sterowniki', () => {
  let mongoServer: MongoMemoryServer;
  let systemToken: string;
  const switchKey = keyPair();
  const pumpKey = keyPair();
  let switchRootId: string;
  let pumpRootId: string;

  const register = (deviceType: DeviceType, deviceId: string, mailKey: string) =>
    request(app).post('/api/devices/register').send({ deviceType, deviceId, mailKey });
  const next = (rootId: string, deviceId: string) => request(app).get(`/api/mail/next?rootId=${rootId}&deviceId=${deviceId}`);

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0';
    process.env.SMTP_HOST = 'smtp.example';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'raporty@example.pl';
    process.env.SMTP_PASS = 'h@slo!';
    process.env.MAIL_FROM = 'robert@example.pl';
    process.env.MAIL_RELAY = '1';
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // konto system kodem awaryjnym (jak polecenie --kod-awaryjny): bez przekaźnika poczty, którego tu jeszcze nie ma
    systemToken = (await request(app).post('/api/auth/system/verify').send({ code: (await issueEmergencySystemCode()).code }).expect(200)).body.token;
    switchRootId = (await register(DeviceType.SWITCH, SWITCH_SN, switchKey.publicKey)).body.rootId;
    pumpRootId = (await register(DeviceType.HP, PUMP_SN, pumpKey.publicKey)).body.rootId;
  });

  afterAll(async () => {
    delete process.env.MAIL_RELAY;
    delete process.env.SMTP_HOST;
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    resetRelaySeen();
    await MailOutboxModel.deleteMany({});
  });

  it('nowy klucz czeka na zatwierdzenie: bez danych SMTP i bez maili; zatwierdza tylko systemowy', async () => {
    const res = await register(DeviceType.SWITCH, SWITCH_SN, switchKey.publicKey).expect(200);
    expect(res.body.mail.key).toBe('pending');
    expect(res.body.mail.config).toBeUndefined();
    expect(res.body.mail.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect((await next(switchRootId, SWITCH_SN).expect(200)).body).toEqual({});
    // bez logowania i dla zwykłego żądania aplikacji: brak dostępu
    expect((await request(app).post(`/api/devices/${switchRootId}/mail-key`).send({})).status).toBe(401);
    const list = await request(app).get('/api/devices').set({ Authorization: `Bearer ${systemToken}` }).expect(200);
    expect(list.body.find((d: { rootId: string }) => d.rootId === switchRootId).mailKey.pendingFingerprint).toBe(res.body.mail.fingerprint);
  });

  it('po zatwierdzeniu zgłoszenie niesie dane SMTP zaszyfrowane kluczem płytki; obcy klucz ich nie odczyta', async () => {
    const pending = (await register(DeviceType.SWITCH, SWITCH_SN, switchKey.publicKey)).body.mail.fingerprint;
    await request(app).post(`/api/devices/${switchRootId}/mail-key`).set({ Authorization: `Bearer ${systemToken}` })
      .send({ fingerprint: pending }).expect(200);
    await request(app).post(`/api/devices/${pumpRootId}/mail-key`).set({ Authorization: `Bearer ${systemToken}` }).send({}).expect(200);

    const res = await register(DeviceType.SWITCH, SWITCH_SN, switchKey.publicKey).expect(200);
    expect(res.body.mail.key).toBe('approved');
    const config = decryptWith(switchKey.privateKey, res.body.mail.config as Sealed, `config:${switchRootId}`);
    expect(config).toEqual({ host: 'smtp.example', port: 587, user: 'raporty@example.pl', pass: 'h@slo!' });
    expect(JSON.stringify(res.body)).not.toContain('h@slo!');
    expect(() => decryptWith(pumpKey.privateKey, res.body.mail.config as Sealed, `config:${switchRootId}`)).toThrow();
    // ponowne pobranie (GET /mail/config) i obcy klucz ze zgłoszenia nie zastępuje zatwierdzonego
    const again = await request(app).get(`/api/mail/config?rootId=${switchRootId}&deviceId=${SWITCH_SN}`).expect(200);
    expect(decryptWith(switchKey.privateKey, again.body.config, `config:${switchRootId}`)).toEqual(config);
    const intruder = keyPair();
    const hijack = await register(DeviceType.SWITCH, SWITCH_SN, intruder.publicKey).expect(200);
    expect(hijack.body.mail.key).toBe('approved');
    expect(() => decryptWith(intruder.privateKey, hijack.body.mail.config, `config:${switchRootId}`)).toThrow();
    await DeviceModel.updateOne({ _id: switchRootId }, { $unset: { mailKeyPending: 1 } });
  });

  it('logowanie bez sterownika w sieci: 503 z komunikatem; ze sterownikiem mail idzie zaszyfrowany i z potwierdzeniem', async () => {
    const unavailable = await request(app).post('/api/auth/start').send({ email: 'jan@example.pl' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.message).toMatch(/Poczta jest chwilowo niedostępna/);

    await next(switchRootId, SWITCH_SN).expect(200);
    await request(app).post('/api/auth/start').send({ email: 'jan@example.pl' }).expect(200);
    expect(await MailOutboxModel.countDocuments({ status: 'pending' })).toBe(1);

    const job = (await next(switchRootId, SWITCH_SN).expect(200)).body;
    const mail = decryptWith(switchKey.privateKey, job.mail, `mail:${job.id}`) as { to: string[]; from: string; raw: string; receipt: string };
    expect(mail.to).toEqual(['jan@example.pl']);
    expect(mail.from).toBe('raporty@example.pl');
    expect(mail.raw).toMatch(/^From: =\?UTF-8\?Q\?M=C3=B3j_Dom\?= <raporty@example.pl>/m);
    expect(mail.raw).toMatch(/^Reply-To: robert@example.pl/m);
    expect(mail.raw).toMatch(/^To: jan@example.pl/m);
    expect(JSON.stringify(job)).not.toContain('jan@example.pl');

    const result = (body: object) => request(app).post(`/api/mail/result?rootId=${switchRootId}&deviceId=${SWITCH_SN}`).send(body);
    expect((await result({ id: job.id, ok: true, receipt: 'zle' })).status).toBe(403);
    // inny sterownik nie może zgłosić wyniku cudzego maila
    expect((await request(app).post(`/api/mail/result?rootId=${pumpRootId}&deviceId=${PUMP_SN}`).send({ id: job.id, ok: true, receipt: mail.receipt })).status).toBe(409);
    await result({ id: job.id, ok: true, receipt: mail.receipt }).expect(200);
    expect((await MailOutboxModel.findById(job.id))?.status).toBe('sent');
    // SN niezgodny z rootId
    expect((await next(switchRootId, PUMP_SN)).status).toBe(409);
  });

  it('włącznik pierwszy; co bierze mail po FAILOVER_MS, od razu po błędzie włącznika i po wygaśnięciu dzierżawy', async () => {
    const t0 = Date.now();
    const sw = (await DeviceModel.findById(switchRootId))!;
    const pump = (await DeviceModel.findById(pumpRootId))!;
    await nextMailFor(sw, t0);
    await nextMailFor(pump, t0);
    const mail = { to: 'ola@example.pl', subject: 'Test', text: 'treść', html: '<p>treść</p>' };

    // 1. włącznik w sieci, ale nie pyta: co czeka FAILOVER_MS
    await enqueueMail(mail, t0);
    expect(await nextMailFor(pump, t0 + 1000)).toBeNull();
    expect(await nextMailFor(pump, t0 + FAILOVER_MS + 1000)).not.toBeNull();
    await MailOutboxModel.deleteMany({});

    // 2. błąd włącznika: co dostaje mail od razu
    const t1 = t0 + 2 * FAILOVER_MS;
    await nextMailFor(sw, t1);
    await nextMailFor(pump, t1);
    await enqueueMail(mail, t1);
    const taken = await nextMailFor(sw, t1 + 100);
    const { receipt } = decryptWith(switchKey.privateKey, taken!.mail, `mail:${taken!.id}`) as { receipt: string };
    expect((await mailResult(sw, { id: taken!.id, ok: false, receipt, error: '535 Authentication failed' }, t1 + 200)).status).toBe('pending');
    const retry = await nextMailFor(pump, t1 + 300);
    expect(retry?.id).toBe(taken!.id);
    expect(decryptWith(pumpKey.privateKey, retry!.mail, `mail:${retry!.id}`)).toMatchObject({ to: ['ola@example.pl'] });
    await MailOutboxModel.deleteMany({});

    // 3. włącznik wziął mail i zamilkł: po LEASE_MS mail wraca do kolejki dla co
    const t2 = t1 + 10 * FAILOVER_MS;
    await nextMailFor(sw, t2);
    await nextMailFor(pump, t2);
    await enqueueMail(mail, t2);
    expect(await nextMailFor(sw, t2 + 100)).not.toBeNull();
    expect(await nextMailFor(pump, t2 + 1000)).toBeNull();
    expect(await nextMailFor(pump, t2 + LEASE_MS + 1000)).not.toBeNull();
  });

  it('nieprawidłowy klucz w zgłoszeniu jest pomijany; hydrofor nie jest przekaźnikiem', async () => {
    const res = await register(DeviceType.WATER_PRESSURE_TANK, 'B0B0B0B0B003', switchKey.publicKey).expect(201);
    expect(res.body.mail).toBeUndefined();
    expect((await request(app).get(`/api/mail/next?rootId=${res.body.rootId}&deviceId=B0B0B0B0B003`)).status).toBe(400);
    const bad = await register(DeviceType.SWITCH, 'B0B0B0B0B004', Buffer.alloc(65, 4).toString('base64')).expect(201);
    expect(bad.body.mail.key).toBe('none');
  });
});
