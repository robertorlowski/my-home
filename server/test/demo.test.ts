// Testy wersji demo (2026-10-21): wejście bez hasła tylko przy DEMO_OWNER_EMAIL, sesja na koncie właściciela
// z profilem „Demo”, sterowniki właściciela z dostępem demo bez SN / IP / imienia, blokada każdego zapisu (także
// /auth/me i zapisów sterownika), wylogowanie dozwolone, współrzędne kafelków z grubsza, dziennik bez imion,
// numer seryjny usunięty z telemetrii, limit wejść z jednego adresu.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  setWeatherReadings: () => undefined,
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}));

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { UserModel } from '../src/core/models/user.model'
import { outbox } from '../src/core/services/mail.service'
import { resetDemoAttempts, SESSION_DEMO_MS } from '../src/core/services/auth.service'
import { logOperation, APP_USER } from '../src/core/services/operation-log.service'
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

describe('Wersja demo', () => {
  let mongoServer: MongoMemoryServer;
  let owner: { token: string; id: string };
  let pumpRootId: string;
  let demoToken: string;

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0';
    process.env.CLIENT_URL = 'https://app.example';
    delete process.env.SMTP_HOST;
    delete process.env.DEMO_OWNER_EMAIL;
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    owner = await login('robert@example.com');
    await UserModel.updateOne({ _id: owner.id }, { $set: { firstName: 'Robert', lastName: 'Właściciel', city: 'Zakopane', location: { lat: 49.3, lng: 19.9 } } });
    pumpRootId = String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'AA0000000001', name: 'Pompa', ownerId: owner.id, ipAddress: '192.168.1.5' }))._id);
    await DeviceModel.create({ deviceType: DeviceType.SWITCH, deviceId: 'AA0000000002', name: 'Cudzy', ownerId: 'ktos-inny' });
    await request(app).post(`/api/hp/add?rootId=${pumpRootId}&deviceId=AA0000000001`).send({ HP: { Ttarget: 40, HPS: false }, time: '2026.10.21 10:00:00' }).expect(201);
    await logOperation(pumpRootId, { actor: { ...APP_USER, name: 'Robert Właściciel' }, source: 'Ustawienia' }, 'Tryb: A → CWU');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('bez DEMO_OWNER_EMAIL wersja demo jest wyłączona', async () => {
    expect((await request(app).get('/api/auth/demo').expect(200)).body).toEqual({ available: false });
    await request(app).post('/api/auth/demo').expect(404);
  });

  it('wejście do demo: profil „Demo”, sesja 2 h, sterowniki właściciela bez danych wrażliwych', async () => {
    process.env.DEMO_OWNER_EMAIL = 'Robert@example.com';
    resetDemoAttempts();
    expect((await request(app).get('/api/auth/demo').expect(200)).body).toEqual({ available: true });
    const res = await request(app).post('/api/auth/demo').expect(200);
    demoToken = res.body.token;
    expect(res.body.user).toMatchObject({ isDemo: true, firstName: 'Demo', email: null, location: null, city: '' });
    const me = await request(app).get('/api/auth/me').set(bearer(demoToken)).expect(200);
    expect(me.body).toMatchObject({ isDemo: true, firstName: 'Demo' });
    expect(me.body.city).toBeUndefined();
    const session = await mongoose.connection.collection('sessions').findOne({ demo: true });
    expect(Math.abs(new Date(session!.expiresAt).getTime() - new Date(session!.createdAt).getTime() - SESSION_DEMO_MS)).toBeLessThan(1000);

    const devices = await request(app).get('/api/devices').set(bearer(demoToken)).expect(200);
    expect(devices.body.map((d: { name: string }) => d.name)).toEqual(['Pompa']);
    expect(devices.body[0]).toMatchObject({ access: 'demo', owner: { name: 'Właściciel' } });
    expect(devices.body[0].deviceId).toBeUndefined();
    expect(devices.body[0].ipAddress).toBeUndefined();
    expect(devices.body[0].owner.email).toBeUndefined();
    // telemetria bez numeru seryjnego
    const hp = await request(app).get(`/api/hp?rootId=${pumpRootId}&deviceId=`).set(bearer(demoToken)).expect(200);
    expect(hp.body.HP.Ttarget).toBe(40);
    expect(hp.body.deviceId).toBeUndefined();
  });

  it('demo nie zmienia niczego, ale może się wylogować', async () => {
    const h = bearer(demoToken);
    expect((await request(app).put(`/api/devices/${pumpRootId}`).set(h).send({ name: 'X' }).expect(403)).body).toMatchObject({ demo: true });
    await request(app).put('/api/auth/me').set(h).send({ firstName: 'Haker' }).expect(403);
    await request(app).post('/api/auth/email-change').set(h).send({ email: 'x@example.com' }).expect(403);
    await request(app).post('/api/auth/delete').set(h).expect(403);
    await request(app).post(`/api/operation/set?rootId=${pumpRootId}`).set(h).send({ work_mode: 'OFF' }).expect(403);
    await request(app).put('/api/devices/order').set(h).send({ cells: [] }).expect(403);
    await request(app).get(`/api/devices/${pumpRootId}/shares`).set(h).expect(403);
    await request(app).get('/api/push/settings').set(h).expect(403);
    expect((await UserModel.findById(owner.id).lean())!.firstName).toBe('Robert');
    expect((await DeviceModel.findById(pumpRootId).lean())!.name).toBe('Pompa');
  });

  it('kafelki pogody z grubsza, dziennik bez imion', async () => {
    const h = bearer(demoToken);
    const created = await request(app).post('/api/weather-tiles').set(bearer(owner.token)).send({ name: 'Dom pod lasem', lat: 49.374298, lon: 20.007237 });
    expect([200, 201]).toContain(created.status);
    const tiles = await request(app).get('/api/weather-tiles').set(h).expect(200);
    const tile = tiles.body.find((t: { name: string }) => t.name === 'Dom pod lasem');
    expect(tile).toMatchObject({ lat: 49.35, lon: 20 });
    const ops = await request(app).get(`/api/operations?rootId=${pumpRootId}&deviceId=`).set(h).expect(200);
    expect(ops.body.done[0].actor).toEqual({ type: 'user', name: 'Użytkownik' });
    const ownerOps = await request(app).get(`/api/operations?rootId=${pumpRootId}&deviceId=AA0000000001`).set(bearer(owner.token)).expect(200);
    expect(ownerOps.body.done[0].actor.name).toBe('Robert Właściciel');
  });

  it('limit wejść z jednego adresu, wylogowanie kończy sesję', async () => {
    resetDemoAttempts();
    for (let i = 0; i < 10; i += 1) await request(app).post('/api/auth/demo').expect(200);
    await request(app).post('/api/auth/demo').expect(429);
    await request(app).post('/api/auth/logout').set(bearer(demoToken)).expect(204);
    await request(app).get('/api/auth/me').set(bearer(demoToken)).expect(401);
  });
});
