// Testy kont użytkowników (2026-10-11): logowanie i rejestracja kodem albo linkiem z maila, limity kodu,
// „Zapamiętaj 90 dni”, dane konta (obowiązkowe imię, nazwisko, kraj), migracja sterowników do pierwszego konta,
// użytkownik systemowy, udostępnianie z zakładkami (zapisy według zakładek), zmiana e-maila, wylogowanie,
// usunięcie konta z danymi, endpointy sterowników i wywołania wewnętrzne bez logowania, układ listy i kafelki
// pogody osobno dla konta, wzór kafelka tylko dla użytkownika systemowego.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}));

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { UserModel } from '../src/core/models/user.model'
import { SessionModel } from '../src/core/models/auth.model'
import { HpEntryModel } from '../src/modules/heat-pump/models/hp.model'
import { outbox } from '../src/core/services/mail.service'
import { migrateOwners, SESSION_REMEMBER_MS } from '../src/core/services/auth.service'
import { INTERNAL_TOKEN } from '../src/core/internal'
import { DeviceType } from '../src/core/types'

const lastMail = (to: string) => [...outbox].reverse().find((mail) => mail.to === to);
const codeOf = (to: string) => /(\d{3}) (\d{3})/.exec(lastMail(to)?.text ?? '')?.slice(1).join('') ?? '';
const tokenOf = (to: string) => /token=([A-Za-z0-9_-]+)/.exec(lastMail(to)?.text ?? '')?.[1] ?? '';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Logowanie kodem; omija limit 60 s między kodami (testy logują to samo konto kilka razy)
async function login(email: string) {
  await mongoose.connection.collection('auth_codes').deleteMany({ email });
  await request(app).post('/api/auth/start').send({ email }).expect(200);
  const res = await request(app).post('/api/auth/verify').send({ email, code: codeOf(email) }).expect(200);
  return res.body.token as string;
}

describe('Konta użytkowników', () => {
  let mongoServer: MongoMemoryServer;
  let pumpRootId: string;
  let boilerRootId: string;

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0';
    process.env.SYSTEM_PASSWORD = 'tajne-haslo';
    process.env.CLIENT_URL = 'https://app.example';
    delete process.env.SMTP_HOST;
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // sterowniki sprzed kont, kolejność kafelków: kocioł, pompa
    pumpRootId = String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'AA0000000001', name: 'Pompa', sortOrder: 1 }))._id);
    boilerRootId = String((await DeviceModel.create({ deviceType: DeviceType.PELLET_BOILER_PELUX200, deviceId: 'AA0000000002', name: 'Kocioł', sortOrder: 0 }))._id);
    await HpEntryModel.create({ rootId: pumpRootId, deviceType: DeviceType.HP, deviceId: 'AA0000000001', HP: { Ttarget: 40 } });
    await migrateOwners();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('bez logowania: 401 dla aplikacji, endpointy sterowników i wywołania wewnętrzne działają', async () => {
    expect((await request(app).get('/api/devices')).status).toBe(401);
    expect((await request(app).get(`/api/hp?rootId=${pumpRootId}`)).status).toBe(401);
    expect((await request(app).post('/api/hp/add?deviceId=AA0000000001').send({ HP: { Ttarget: 41 } })).status).toBe(201);
    await request(app).get(`/api/hp?rootId=${pumpRootId}`).set('x-internal-token', INTERNAL_TOKEN).expect(200);
    // nowy sterownik zgłasza się sam i zostaje bez właściciela
    await request(app).post('/api/devices/register').send({ deviceId: 'AA0000000009', deviceType: DeviceType.SWITCH }).expect(201);
    expect((await DeviceModel.findOne({ deviceId: 'AA0000000009' }).lean())?.ownerId ?? null).toBeNull();
  });

  it('migracja: sterowniki sprzed kont należą do robert@infotower.pl z kolejnością kafelków; raz', async () => {
    const robert = await UserModel.findOne({ email: 'robert@infotower.pl' }).lean();
    expect(robert?.deviceOrder).toEqual([boilerRootId, pumpRootId]);
    expect(await DeviceModel.countDocuments({ ownerId: String(robert?._id) })).toBe(2);
    expect(await migrateOwners()).toBe(0);
    expect(await UserModel.countDocuments({ isSystem: true })).toBe(1);
  });

  it('logowanie kodem: mail z kodem i linkiem do klienta, limit 60 s, 5 prób, dane konta przy pierwszym logowaniu', async () => {
    const email = 'robert@infotower.pl';
    await request(app).post('/api/auth/start').send({ email: 'zly-adres' }).expect(400);
    await request(app).post('/api/auth/start').set('Origin', 'https://obca.example').send({ email: ' Robert@Infotower.pl ' }).expect(200);
    const mail = lastMail(email);
    expect(mail?.subject).toMatch(/^Kod logowania: \d{3} \d{3}$/);
    // link zawsze do klienta z CLIENT_URL (obcy Origin nie trafia do maila)
    expect(mail?.text).toContain('https://app.example/login?token=');
    const again = await request(app).post('/api/auth/start').send({ email }).expect(429);
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0);

    const code = codeOf(email);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await request(app).post('/api/auth/verify').send({ email, code: wrong }).expect(400);
    expect(bad.body.message).toContain('Zostało prób: 4');
    const ok = await request(app).post('/api/auth/verify').send({ email, code }).expect(200);
    expect(ok.body.created).toBe(false);
    expect(ok.body.user).toMatchObject({ email, profileComplete: false });
    // kod jednorazowy
    await request(app).post('/api/auth/verify').send({ email, code }).expect(400);

    const token = ok.body.token as string;
    await request(app).put('/api/auth/me').set(bearer(token)).send({ firstName: 'Robert', lastName: 'Orłowski' }).expect(400);
    const me = await request(app).put('/api/auth/me').set(bearer(token))
      .send({ firstName: 'Robert', lastName: 'Orłowski', country: 'Polska', location: { lat: 49.3, lng: 19.95 } }).expect(200);
    expect(me.body).toMatchObject({ profileComplete: true, city: '', country: 'Polska', location: { lat: 49.3, lng: 19.95 } });
  });

  it('język konta (wersja językowa): pusty na starcie, PUT /auth/me/language przyjmuje pl albo en i wraca w /auth/me', async () => {
    const token = await login('robert@infotower.pl');
    expect((await request(app).get('/api/auth/me').set(bearer(token)).expect(200)).body.language).toBe('');
    await request(app).put('/api/auth/me/language').set(bearer(token)).send({ language: 'de' }).expect(400);
    const set = await request(app).put('/api/auth/me/language').set(bearer(token)).send({ language: 'en' }).expect(200);
    expect(set.body.language).toBe('en');
    expect((await request(app).get('/api/auth/me').set(bearer(token)).expect(200)).body.language).toBe('en');
    await request(app).put('/api/auth/me/language').send({ language: 'pl' }).expect(401);
  });

  it('wersja językowa: mail logowania, mail udostępnienia i komunikaty błędów w języku żądania (Accept-Language)', async () => {
    await request(app).post('/api/auth/start').set('Accept-Language', 'en-US,en;q=0.9').send({ email: 'ewa@example.com' }).expect(200);
    expect(lastMail('ewa@example.com')?.subject).toMatch(/^Sign-in code: /);
    expect(lastMail('ewa@example.com')?.text).toContain('Your sign-in code');
    const again = await request(app).post('/api/auth/start').set('Accept-Language', 'en').send({ email: 'ewa@example.com' }).expect(429);
    expect(again.body.message).toMatch(/^A code was sent a moment ago/);
    const polish = await request(app).post('/api/auth/start').send({ email: 'ewa@example.com' }).expect(429);
    expect(polish.body.message).toMatch(/^Kod został wysłany przed chwilą/);
    // konto z wybranym językiem: mail po angielsku także bez nagłówka
    const token = await login('robert@infotower.pl');
    await request(app).put('/api/auth/me/language').set(bearer(token)).send({ language: 'en' }).expect(200);
    await request(app).post('/api/auth/email-change').set(bearer(token)).send({ email: 'nowy@example.com' }).expect(200);
    expect(lastMail('nowy@example.com')?.subject).toMatch(/^Confirm the new address: /);
    const unauthorized = await request(app).get('/api/devices').set('Accept-Language', 'en').expect(401);
    expect(unauthorized.body.message).toBe('Please sign in.');
    await request(app).put('/api/auth/me/language').set(bearer(token)).send({ language: 'pl' }).expect(200);
  });

  it('rejestracja linkiem: nowe konto, powiadomienie administratora, „Zapamiętaj 90 dni”, wylogowanie', async () => {
    process.env.MAIL_ADMIN = 'admin@example.pl';
    const email = 'nowy@example.pl';
    await request(app).post('/api/auth/start').send({ email }).expect(200);
    const res = await request(app).post('/api/auth/verify').send({ token: tokenOf(email) }).expect(200);
    expect(res.body.created).toBe(true);
    await request(app).post('/api/auth/verify').send({ token: tokenOf(email) }).expect(400);
    await vi.waitFor(() => expect(lastMail('admin@example.pl')?.subject).toBe(`Nowe konto: ${email}`));
    const token = res.body.token as string;
    // nowe konto nie widzi cudzych sterowników
    expect((await request(app).get('/api/devices').set(bearer(token)).expect(200)).body).toEqual([]);
    expect((await request(app).get(`/api/hp?rootId=${pumpRootId}`).set(bearer(token))).status).toBe(403);

    const remember = await request(app).post('/api/auth/remember').set(bearer(token)).send({ remember: true }).expect(200);
    const session = await SessionModel.findOne({ userId: res.body.user.id }).lean();
    expect(new Date(remember.body.expiresAt).getTime()).toBe(new Date(session!.createdAt).getTime() + SESSION_REMEMBER_MS);
    await request(app).post('/api/auth/logout').set(bearer(token)).expect(204);
    await request(app).get('/api/auth/me').set(bearer(token)).expect(401);
  });

  it('lista według właściciela: kolejność z konta; użytkownik systemowy widzi wszystkich i pliki firmware', async () => {
    const robert = await login('robert@infotower.pl');
    const list = (await request(app).get('/api/devices').set(bearer(robert)).expect(200)).body;
    expect(list.map((d: { rootId: string }) => d.rootId)).toEqual([boilerRootId, pumpRootId]);
    expect(list[1]).toMatchObject({ access: 'owner', owner: { name: 'Robert Orłowski', email: 'robert@infotower.pl' } });
    await request(app).put('/api/devices/order').set(bearer(robert)).send({ rootIds: [pumpRootId, boilerRootId] }).expect(200);
    const after = (await request(app).get('/api/devices').set(bearer(robert))).body;
    expect(after.map((d: { rootId: string }) => d.rootId)).toEqual([pumpRootId, boilerRootId]);
    expect((await request(app).put('/api/firmware/switch').set(bearer(robert)).send({ enabled: true })).status).toBe(403);

    await request(app).post('/api/auth/system').send({ password: 'zle' }).expect(401);
    const system = (await request(app).post('/api/auth/system').send({ password: 'tajne-haslo' }).expect(200)).body.token;
    const all = (await request(app).get('/api/devices').set(bearer(system)).expect(200)).body;
    expect(all).toHaveLength(3);
    expect(all.find((d: { deviceId: string }) => d.deviceId === 'AA0000000009').owner).toBeNull();
    expect(all.every((d: { access: string }) => d.access === 'system')).toBe(true);
    await request(app).get(`/api/hp?rootId=${pumpRootId}`).set(bearer(system)).expect(200);
  });

  it('układ listy osobno dla konta: pola szachownicy, ukrycie, własne kafelki pogody; wzór kafelka tylko systemowy', async () => {
    const robert = await login('robert@infotower.pl');
    const system = (await request(app).post('/api/auth/system').send({ password: 'tajne-haslo' }).expect(200)).body.token;
    type Tile = { id: string; name: string; sortOrder?: number; hidden: boolean; home: boolean };
    type Listed = { rootId: string; sortOrder?: number; hidden: boolean };

    // własny kafelek pogody konta; „Dom” (bez właściciela) widzi tylko użytkownik systemowy
    const krakow: Tile = (await request(app).post('/api/weather-tiles').set(bearer(robert)).send({ name: 'Kraków', lat: 50.06, lon: 19.94 }).expect(201)).body;
    expect(krakow.sortOrder).toBe(2);
    expect((await request(app).get('/api/weather-tiles').set(bearer(robert))).body.map((t: Tile) => t.name)).toEqual(['Kraków']);
    const systemTiles: Tile[] = (await request(app).get('/api/weather-tiles').set(bearer(system))).body;
    expect(systemTiles.map((t) => t.name)).toEqual(['Dom']);
    const home = systemTiles[0];
    await request(app).put(`/api/weather-tiles/${home.id}`).set(bearer(robert)).send({ name: 'X' }).expect(404);
    await request(app).delete(`/api/weather-tiles/${home.id}`).set(bearer(robert)).expect(404);
    await request(app).put('/api/devices/order').set(bearer(robert)).send({ rootIds: [pumpRootId, null, home.id] }).expect(400);

    // szachownica z pustym polem tylko na koncie Roberta; systemowy ma układ wspólny sprzed kont
    await request(app).put('/api/devices/order').set(bearer(robert)).send({ rootIds: [pumpRootId, null, krakow.id, boilerRootId] }).expect(200);
    const mine: Listed[] = (await request(app).get('/api/devices').set(bearer(robert))).body;
    expect(mine.map((d) => [d.rootId, d.sortOrder])).toEqual([[pumpRootId, 0], [boilerRootId, 3]]);
    expect((await request(app).get('/api/weather-tiles').set(bearer(robert))).body[0].sortOrder).toBe(2);
    const all: Listed[] = (await request(app).get('/api/devices').set(bearer(system))).body;
    expect(all.find((d) => d.rootId === boilerRootId)?.sortOrder).toBe(0);

    // ukrycie tylko na koncie, dokument sterownika bez zmian
    expect((await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(robert)).send({ hidden: true }).expect(200)).body.hidden).toBe(true);
    expect((await request(app).get('/api/devices').set(bearer(system))).body.find((d: Listed) => d.rootId === pumpRootId).hidden).toBe(false);
    expect((await DeviceModel.findById(pumpRootId).lean())?.hidden ?? false).toBe(false);
    await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(robert)).send({ hidden: false }).expect(200);
    // kafelek prosty tylko na koncie (users.simpleTiles)
    expect((await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(robert)).send({ simple: true }).expect(200)).body.simple).toBe(true);
    expect((await request(app).get('/api/devices').set(bearer(robert))).body.find((d: Listed) => d.rootId === pumpRootId).simple).toBe(true);
    expect((await request(app).get('/api/devices').set(bearer(system))).body.find((d: Listed) => d.rootId === pumpRootId).simple).toBe(false);
    await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(robert)).send({ simple: 'tak' }).expect(400);
    await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(robert)).send({ simple: false }).expect(200);
    await request(app).put('/api/devices/order').set(bearer(robert)).send({ rootIds: [pumpRootId, boilerRootId] }).expect(200);
    await request(app).delete(`/api/weather-tiles/${krakow.id}`).set(bearer(robert)).expect(204);

  });

  it('udostępnianie: zaproszenie, zakładki pilnują zapisów, tylko właściciel zmienia nazwę i udostępnia', async () => {
    const robert = await login('robert@infotower.pl');
    const anna = 'anna@example.pl';
    await request(app).post(`/api/devices/${pumpRootId}/shares`).set(bearer(robert)).send({ email: anna, tabs: [] }).expect(400);
    const share = (await request(app).post(`/api/devices/${pumpRootId}/shares`).set(bearer(robert))
      .send({ email: anna, tabs: ['/data', '/'] }).expect(201)).body;
    expect(share).toMatchObject({ email: anna, registered: false, tabs: ['/', '/data'] });
    await vi.waitFor(() => expect(lastMail(anna)?.text).toContain('Dostęp do zakładek: Podgląd, Dane.'));
    expect(lastMail(anna)?.text).toContain('przy pierwszym logowaniu założymy konto');
    await request(app).post(`/api/devices/${pumpRootId}/shares`).set(bearer(robert)).send({ email: anna, tabs: ['/'] }).expect(409);

    const annaToken = await login(anna);
    const list = (await request(app).get('/api/devices').set(bearer(annaToken))).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rootId: pumpRootId, access: 'shared', tabs: ['/', '/data'], owner: { name: 'Robert Orłowski' } });
    await request(app).get(`/api/hp?rootId=${pumpRootId}`).set(bearer(annaToken)).expect(200);
    // Podgląd: przełączniki operacji; bez Harmonogramu: harmonogramy i ustawienia domyślne nie
    expect((await request(app).post(`/api/operation/set?rootId=${pumpRootId}`).set(bearer(annaToken)).send({ co_pomp: '1' })).status).not.toBe(403);
    expect((await request(app).post(`/api/schedules?rootId=${pumpRootId}`).set(bearer(annaToken)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/hp/clear?rootId=${pumpRootId}`).set(bearer(annaToken))).status).toBe(403);
    expect((await request(app).put(`/api/devices/${pumpRootId}`).set(bearer(annaToken)).send({ name: 'X' })).status).toBe(403);
    expect((await request(app).get(`/api/devices/${pumpRootId}/shares`).set(bearer(annaToken))).status).toBe(403);
    expect((await request(app).get(`/api/hp?rootId=${boilerRootId}`).set(bearer(annaToken))).status).toBe(403);

    await request(app).put(`/api/devices/${pumpRootId}/shares/${share.id}`).set(bearer(robert)).send({ tabs: ['/', '/schedules'] }).expect(200);
    await vi.waitFor(async () => {
      expect((await request(app).post(`/api/schedules?rootId=${pumpRootId}`).set(bearer(annaToken)).send({})).status).not.toBe(403);
    });
    const shares = (await request(app).get(`/api/devices/${pumpRootId}/shares`).set(bearer(robert)).expect(200)).body;
    expect(shares[0]).toMatchObject({ registered: true, tabs: ['/', '/schedules'] });

    // „Panel prosty”: sterownik na liście jako kafelek prosty (simple), bez zakładek; zapis trybu włącznika dozwolony
    await request(app).put(`/api/devices/${pumpRootId}/shares/${share.id}`).set(bearer(robert)).send({ tabs: ['simple'] }).expect(200);
    await vi.waitFor(async () => {
      const simple = (await request(app).get('/api/devices').set(bearer(annaToken))).body[0];
      expect(simple).toMatchObject({ tabs: ['simple'], simple: true });
    });
    expect((await request(app).put(`/api/switch/mode?rootId=${pumpRootId}`).set(bearer(annaToken)).send({ relay: 1, mode: 'off' })).status).not.toBe(403);
    expect((await request(app).post(`/api/schedules?rootId=${pumpRootId}`).set(bearer(annaToken)).send({})).status).toBe(403);

    await request(app).delete(`/api/devices/${pumpRootId}/shares/${share.id}`).set(bearer(robert)).expect(204);
    expect((await request(app).get(`/api/hp?rootId=${pumpRootId}`).set(bearer(annaToken))).status).toBe(403);
  });

  it('zmiana e-maila: kod na nowy adres, powiadomienie na stary, zajęty adres = 409', async () => {
    const token = await login('anna@example.pl');
    await request(app).post('/api/auth/email-change').set(bearer(token)).send({ email: 'robert@infotower.pl' }).expect(409);
    await request(app).post('/api/auth/email-change').set(bearer(token)).send({ email: 'anna.nowa@example.pl' }).expect(200);
    const changed = await request(app).post('/api/auth/email-change/verify').set(bearer(token)).send({ code: codeOf('anna.nowa@example.pl') }).expect(200);
    expect(changed.body.email).toBe('anna.nowa@example.pl');
    await vi.waitFor(() => expect(lastMail('anna@example.pl')?.subject).toBe('Zmiana adresu e-mail konta'));
  });

  it('usunięcie konta: link w mailu, usuwa konto, sterowniki z historią i udostępnienia', async () => {
    const robert = await login('robert@infotower.pl');
    await request(app).post(`/api/devices/${pumpRootId}/shares`).set(bearer(robert)).send({ email: 'anna.nowa@example.pl', tabs: ['/'] }).expect(201);
    const start = await request(app).post('/api/auth/delete').set(bearer(robert)).expect(200);
    expect(start.body.devices).toBe(2);
    const mail = lastMail('robert@infotower.pl');
    expect(mail?.subject).toBe('Potwierdź usunięcie konta');
    expect(mail?.text).toContain('2 sterowników');
    expect(mail?.text).toContain('https://app.example/account/delete?token=');
    await request(app).post('/api/auth/delete/confirm').send({ token: tokenOf('robert@infotower.pl') }).expect(200);

    expect(await UserModel.exists({ email: 'robert@infotower.pl' })).toBeNull();
    expect(await DeviceModel.countDocuments({ _id: { $in: [pumpRootId, boilerRootId] } })).toBe(0);
    expect(await HpEntryModel.countDocuments({ rootId: pumpRootId })).toBe(0);
    expect(await mongoose.connection.collection('device_shares').countDocuments()).toBe(0);
    await request(app).get('/api/auth/me').set(bearer(robert)).expect(401);
    // sterownik bez właściciela zostaje
    expect(await DeviceModel.exists({ deviceId: 'AA0000000009' })).not.toBeNull();
  });
});
