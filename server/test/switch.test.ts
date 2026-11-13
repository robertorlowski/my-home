// Testy włącznika (baza w mongodb-memory-server): zgłoszenie z liczbą przekaźników,
// okna harmonogramu (łączenie, przez północ, dni robocze), polecenia dla sterownika
// w każdym trybie, powrót z timera do harmonogramu, historia włączeń (także po utracie
// zasilania), identyfikacja sterownika (404/409), harmonogramy i nazwy przez API.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { SwitchRelayModel } from '../src/modules/switch/models/switch-relay.model'
import { SwitchActivationModel } from '../src/modules/switch/models/switch-activation.model'
import { activeSchedule, nextScheduleStart } from '../src/modules/switch/services/switch-schedule.service'
import { listRelays, reportState, setRelayMode } from '../src/modules/switch/services/switch.service'
import { switchTile } from '../src/modules/switch/tile'

const register = (deviceId: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/api/devices/register').send({ deviceId, deviceType: 'switch', relays: 1, ...extra });

// 2026-10-05 to poniedziałek; w październiku (do 25.10) Warszawa = UTC+2
const at = (warsaw: string) => new Date(`${warsaw}:00+02:00`);
const entry = (startTime: string, endTime: string, extra: Record<string, unknown> = {}) =>
  ({ enabled: true, dayOfWeek: -1, startTime, endTime, ...extra });

describe('Włącznik (switch)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await SwitchRelayModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe('okna harmonogramu', () => {
    it('łączy stykające się okna w jedno włączenie', () => {
      const active = activeSchedule([entry('06:00', '07:00'), entry('07:00', '08:00')], at('2026-10-05T06:30'));
      expect(active?.until).toEqual(at('2026-10-05T08:00'));
    });

    it('okno przez północ należy do dnia, w którym się zaczyna', () => {
      // poniedziałek 22:00–06:00: działa we wtorek o 03:00, ale nie w poniedziałek o 03:00
      const monday = [entry('22:00', '06:00', { dayOfWeek: 1 })];
      expect(activeSchedule(monday, at('2026-10-06T03:00'))?.until).toEqual(at('2026-10-06T06:00'));
      expect(activeSchedule(monday, at('2026-10-05T03:00'))).toBeNull();
    });

    it('dni robocze pomijają święta, koniec okna jest wyłączny', () => {
      const workdays = [entry('08:00', '09:00', { dayOfWeek: -2 })];
      // 11.11.2026 (środa) to święto; w listopadzie Warszawa = UTC+1
      const winter = (warsaw: string) => new Date(`${warsaw}:00+01:00`);
      expect(activeSchedule(workdays, winter('2026-11-11T08:30'))).toBeNull();
      expect(activeSchedule(workdays, winter('2026-11-12T08:30'))).not.toBeNull();
      expect(activeSchedule(workdays, winter('2026-11-12T09:00'))).toBeNull();
    });

    it('podaje najbliższe włączenie', () => {
      const next = nextScheduleStart([entry('06:00', '07:00', { dayOfWeek: 3 })], at('2026-10-05T12:00'));
      expect(next).toEqual(at('2026-10-07T06:00'));
    });
  });

  describe('zgłoszenie i polecenia', () => {
    it('zgłoszenie tworzy przekaźniki i odsyła domyślny czas', async () => {
      const response = await register('4CC382C520F0', { relays: 2 }).expect(201);
      expect(response.body.settings).toMatchObject({ default_on_minutes: 30 });
      const relays = await request(app).get(`/api/switch/relays?rootId=${response.body.rootId}`).expect(200);
      expect(relays.body.map((relay: { relay: number; mode: string }) => [relay.relay, relay.mode]))
        .toEqual([[1, 'schedule'], [2, 'schedule']]);
    });

    it('w każdym trybie odsyła właściwe polecenie', async () => {
      const { body } = await register('4CC382C520F1');
      const rootId = body.rootId;
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, dayOfWeek: -1, startTime: '17:00', endTime: '18:00' }).expect(201);
      const off = { relays: [{ on: false, changedS: 10 }] };

      // harmonogram: o 17:40 włącz na 20 min, o 18:10 wyłącz
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T17:40'))).relays)
        .toEqual([{ on: true, offAfterS: 1200, mode: 'schedule' }]);
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T18:10'))).relays).toEqual([{ on: false, mode: 'schedule' }]);

      // wyłączony: harmonogram go nie włącza
      await setRelayMode(rootId, { relay: 1, mode: 'off' }, 'app');
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T17:40'))).relays).toEqual([{ on: false, mode: 'off' }]);

      // włączony bez limitu
      await setRelayMode(rootId, { relay: 1, mode: 'on' }, 'app');
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T12:00'))).relays).toEqual([{ on: true, mode: 'on' }]);

      // na czas: po końcu wraca do harmonogramu
      await setRelayMode(rootId, { relay: 1, mode: 'timer', minutes: 90 }, 'app', at('2026-10-05T12:00'));
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T13:00'))).relays)
        .toEqual([{ on: true, offAfterS: 1800, mode: 'timer' }]);
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T17:30'))).relays)
        .toEqual([{ on: true, offAfterS: 1800, mode: 'schedule' }]);
      expect((await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean())?.mode).toBe('schedule');
    });

    it('pause (kafelek prosty „Wyłącz bojler”): wyłącza do końca okna, potem harmonogram; sterownik dostaje schedule', async () => {
      const { body } = await register('4CC382C520F9');
      const rootId = body.rootId;
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, dayOfWeek: -1, startTime: '17:00', endTime: '18:00' }).expect(201);
      const off = { relays: [{ on: false, changedS: 10 }] };

      // w oknie 17:00–18:00: wyłączony do 18:00, najbliższe włączenie jutro 17:00
      await setRelayMode(rootId, { relay: 1, mode: 'pause' }, 'app', at('2026-10-05T17:20'));
      expect(await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean()).toMatchObject({ mode: 'pause', until: at('2026-10-05T18:00') });
      expect((await listRelays(rootId, at('2026-10-05T17:30')))[0])
        .toMatchObject({ mode: 'pause', desiredOn: false, until: at('2026-10-05T18:00'), nextStart: at('2026-10-06T17:00') });
      // firmware nie zna pause: w poleceniu schedule
      expect((await reportState(rootId, 'SN', off, at('2026-10-05T17:40'))).relays).toEqual([{ on: false, mode: 'schedule' }]);
      // następne okno działa normalnie, tryb w bazie wraca na schedule
      expect((await reportState(rootId, 'SN', off, at('2026-10-06T17:10'))).relays)
        .toEqual([{ on: true, offAfterS: 3000, mode: 'schedule' }]);
      expect((await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean())?.mode).toBe('schedule');

      // poza oknem (np. włączony na czas) pause = harmonogram
      await setRelayMode(rootId, { relay: 1, mode: 'timer', minutes: 30 }, 'app', at('2026-10-05T12:00'));
      await setRelayMode(rootId, { relay: 1, mode: 'pause' }, 'app', at('2026-10-05T12:10'));
      expect((await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean())?.mode).toBe('schedule');

      // kafelek: pola kafelka prostego — przy włączonym z harmonogramu najbliższe włączenie po końcu okna
      const device = (await DeviceModel.findById(rootId))!;
      const tile = await switchTile(rootId, device, at('2026-10-05T17:30'));
      expect(tile).toMatchObject({ onMinutes: 30 });
      expect(tile?.relays?.[0]).toMatchObject({
        relay: 1, mode: 'schedule', desiredOn: true, until: at('2026-10-05T18:00').toISOString(), nextStart: at('2026-10-06T17:00').toISOString(),
      });
    });

    it('sprawdza tryb i czas', async () => {
      const { body } = await register('4CC382C520F2');
      await request(app).put(`/api/switch/mode?rootId=${body.rootId}`).send({ relay: 1, mode: 'boost' }).expect(400);
      await request(app).put(`/api/switch/mode?rootId=${body.rootId}`).send({ relay: 1, mode: 'timer', minutes: 0 }).expect(400);
      await request(app).put(`/api/switch/mode?rootId=${body.rootId}`).send({ relay: 3, mode: 'on' }).expect(400);
      const ok = await request(app).put(`/api/switch/mode?rootId=${body.rootId}`)
        .send({ relay: 1, mode: 'timer', minutes: 240 }).expect(200);
      expect(ok.body).toMatchObject({ relay: 1, mode: 'timer', modeSource: 'app', desiredOn: true });
    });

    it('strona sterownika zmienia tryb samym deviceId', async () => {
      await register('4CC382C520F3');
      const response = await request(app).put('/api/switch/mode?deviceId=4CC382C520F3')
        .send({ relay: 1, mode: 'off' }).expect(200);
      expect(response.body).toMatchObject({ mode: 'off', modeSource: 'controller' });
    });

    it('identyfikuje sterownik jak hydrofor: deviceId, 404, 409', async () => {
      const { body } = await register('4CC382C520F4');
      const state = { uptimeS: 100, relays: [{ on: false, changedS: 100 }] };
      await request(app).post('/api/switch/state?deviceId=4CC382C520F4').send(state).expect(200);
      await request(app).post('/api/switch/state?deviceId=FFFFFFFFFFFF').send(state).expect(404);
      await request(app).post(`/api/switch/state?deviceId=4CC382C520F0&rootId=${body.rootId}`).send(state).expect(409);
      await request(app).post('/api/switch/state?deviceId=4CC382C520F4').send({ relays: [{ on: 'tak' }] }).expect(400);
    });
  });

  describe('historia włączeń', () => {
    it('zapisuje włączenie i wyłączenie z czasem ze sterownika', async () => {
      const { body } = await register('4CC382C520F5');
      const rootId = body.rootId;
      await setRelayMode(rootId, { relay: 1, mode: 'on' }, 'controller');
      // włączony 5 s przed zgłoszeniem, wyłączony 20 s przed kolejnym
      await reportState(rootId, 'SN', { uptimeS: 600, relays: [{ on: true, changedS: 5 }] }, at('2026-10-05T10:00'));
      await reportState(rootId, 'SN', { uptimeS: 660, relays: [{ on: true, changedS: 65 }] }, at('2026-10-05T10:01'));
      await reportState(rootId, 'SN', { uptimeS: 1800, relays: [{ on: false, changedS: 20 }] }, at('2026-10-05T10:20'));

      const day = await request(app).get(`/api/switch/activations?rootId=${rootId}&date=2026-10-05`).expect(200);
      expect(day.body).toHaveLength(1);
      expect(day.body[0]).toMatchObject({
        relay: 1, source: 'controller', approximate: false,
        onAt: new Date(at('2026-10-05T10:00').getTime() - 5000).toISOString(),
        offAt: new Date(at('2026-10-05T10:20').getTime() - 20000).toISOString(),
      });
      expect(day.body[0].durationS).toBe(19 * 60 + 45);
    });

    it('po utracie zasilania kończy włączenie na ostatnim zgłoszeniu', async () => {
      const { body } = await register('4CC382C520F6');
      const rootId = body.rootId;
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, dayOfWeek: -1, startTime: '06:00', endTime: '08:00' }).expect(201);
      await reportState(rootId, 'SN', { uptimeS: 900, relays: [{ on: true, changedS: 600 }] }, at('2026-10-05T06:10'));
      await reportState(rootId, 'SN', { uptimeS: 960, relays: [{ on: true, changedS: 660 }] }, at('2026-10-05T06:11'));
      // sterownik bez zasilania do 07:00, po starcie przekaźnik wyłączony od 30 s
      await reportState(rootId, 'SN', { uptimeS: 30, relays: [{ on: false, changedS: 30 }] }, at('2026-10-05T07:00'));

      const day = await request(app).get(`/api/switch/activations?rootId=${rootId}&date=2026-10-05`).expect(200);
      expect(day.body[0]).toMatchObject({
        source: 'schedule', approximate: true,
        offAt: at('2026-10-05T06:11').toISOString(),
      });
    });

    it('zgłoszenia co 5 s: lastSeenAt w bazie raz na minutę, koniec włączenia z ostatniego zgłoszenia w pamięci', async () => {
      const { body } = await register('4CC382C520E1');
      const rootId = body.rootId;
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, dayOfWeek: -1, startTime: '06:00', endTime: '08:00' }).expect(201);
      const on = (seconds: number) => reportState(rootId, 'SN',
        { uptimeS: 900 + seconds, relays: [{ on: true, changedS: 600 + seconds }] }, new Date(at('2026-10-05T06:10').getTime() + seconds * 1000));
      await on(0);
      await on(5);
      await on(30);
      // baza ma czas pierwszego zgłoszenia (do minuty bez zapisu), historia jedno włączenie
      const relay = await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean();
      expect(relay?.lastSeenAt?.toISOString()).toBe(at('2026-10-05T06:10').toISOString());
      expect(await SwitchActivationModel.countDocuments({ rootId })).toBe(1);

      await reportState(rootId, 'SN', { uptimeS: 30, relays: [{ on: false, changedS: 30 }] }, at('2026-10-05T07:00'));
      const day = await request(app).get(`/api/switch/activations?rootId=${rootId}&date=2026-10-05`).expect(200);
      expect(day.body[0]).toMatchObject({ approximate: true, offAt: new Date(at('2026-10-05T06:10').getTime() + 30_000).toISOString() });
      // zmiana stanu zapisuje się od razu
      expect((await SwitchRelayModel.findOne({ rootId, relay: 1 }).lean())?.lastSeenAt?.toISOString()).toBe(at('2026-10-05T07:00').toISOString());
    });
  });

  describe('diagnostyka sterownika (firmware 1.1.2)', () => {
    it('zapisuje restart z przyczyną i włączeniem przekaźnika tuż przed nim', async () => {
      const { body } = await register('4CC382C520F9');
      const api = (path: string) => `/api/${path}?rootId=${body.rootId}`;
      // start sprzed 10 min (pierwsze zgłoszenie po starcie serwera): punkt odniesienia, bez wpisu
      await request(app).post(api('switch/state')).send({
        uptimeS: 600, relays: [{ on: true, changedS: 10 }], diag: { reset: 'power_on', boot: 5, wifiDrops: 1, rssi: -60, httpMs: 700 },
      }).expect(200);
      // restart 3 s temu przez spadek napięcia; przekaźnik wyłączony od startu
      await request(app).post(api('switch/state')).send({
        uptimeS: 3, relays: [{ on: false, changedS: 3 }], diag: { reset: 'brownout', boot: 6, wifiDrops: 0, rssi: -61, httpMs: 900 },
      }).expect(200);
      // błędne diag nie psuje zgłoszenia
      await request(app).post(api('switch/state')).send({ uptimeS: 8, relays: [{ on: false, changedS: 8 }], diag: { reset: 5 } }).expect(200);

      const day = (await request(app).get(api('operations')).expect(200)).body;
      const restarts = day.done.filter((entry: { action: string }) => entry.action === 'Restart sterownika');
      expect(restarts).toHaveLength(1);
      expect(restarts[0].reason).toContain('spadek napięcia zasilania (brownout)');
      expect(restarts[0].conditions).toMatch(/^start nr 6; \d+ s po włączeniu: Przekaźnik 1; przed restartem zerwań Wi-Fi: 1$/);
      const diag = (await request(app).get(api('switch/diagnostics')).expect(200)).body;
      expect(diag).toMatchObject({ reset: 'brownout', boot: 6, httpMs: 900, resetText: 'spadek napięcia zasilania (brownout)' });
    });

    it('przyjmuje pamięć sterty (firmware 1.3.2); wynik pobierania pogody (do 1.3.7) jest pomijany', async () => {
      const { body } = await register('4CC382C520FB');
      const api = (path: string) => `/api/${path}?rootId=${body.rootId}`;
      const weather = { places: 2, ok: 3, fail: 5, code: -1, tls: -32512, heapBlock: 12000, agoS: 40 };
      await request(app).post(api('switch/state')).send({
        uptimeS: 600, relays: [{ on: false, changedS: 600 }],
        diag: { reset: 'software', boot: 9, wifiDrops: 0, rssi: -45, httpMs: 800, heapFree: 61000, heapMin: 30500, heapBlock: 40000, weather },
      }).expect(200);
      const diag = (await request(app).get(api('switch/diagnostics')).expect(200)).body;
      expect(diag).toMatchObject({ heapFree: 61000, heapMin: 30500, heapBlock: 40000 });
      expect(diag.weather).toBeUndefined();
    });

    it('zapisuje naprawę łączności bez restartu i restart z braku łączności (firmware 1.3.7)', async () => {
      const { body } = await register('4CC382C52107');
      const api = (path: string) => `/api/${path}?rootId=${body.rootId}`;
      const state = (uptimeS: number, diag: object) => request(app).post(api('switch/state'))
        .send({ uptimeS, relays: [{ on: false, changedS: uptimeS }], diag }).expect(200);
      await state(600, { reset: 'power_on', boot: 3, net: { http: 0, wifi: 0 } });
      // ta sama płytka, liczniki wzrosły: łączność wróciła bez restartu
      await state(1200, { reset: 'power_on', boot: 3, net: { http: 1, wifi: 2 } });
      let diag = (await request(app).get(api('switch/diagnostics')).expect(200)).body;
      expect(diag.net).toEqual({ http: 1, wifi: 2 });
      // bez zmiany liczników bez wpisu
      await state(1205, { reset: 'power_on', boot: 3, net: { http: 1, wifi: 2 } });
      await state(5, { reset: 'no_cloud', boot: 4, net: { http: 0, wifi: -1 } });
      const day = (await request(app).get(api('operations')).expect(200)).body;
      const fixes = day.done.filter((entry: { action: string }) => entry.action === 'Naprawa łączności');
      expect(fixes).toHaveLength(1);
      expect(fixes[0].conditions).toBe('przerwa w zgłoszeniach: 0 min; nowe połączenie z serwerem: 1, ponowne łączenie z Wi-Fi: 2');
      const restarts = day.done.filter((entry: { action: string }) => entry.action === 'Restart sterownika');
      expect(restarts).toHaveLength(1);
      expect(restarts[0].reason).toContain('restart po braku łączności z serwerem');
      expect(restarts[0].conditions).toBe('start nr 4');
      // błędne net jest pomijane
      diag = (await request(app).get(api('switch/diagnostics')).expect(200)).body;
      expect(diag.net).toBeUndefined();
    });
  });

  describe('bez pogody (firmware do 1.3.7 pobierał ją z Open-Meteo, od 2026-11-13 tylko serwer)', () => {
    it('pole weather ze zgłoszenia jest pomijane, odpowiedź bez miejsc pogody', async () => {
      const { body } = await register('4CC382C520FA');
      const answer = await request(app).post(`/api/switch/state?rootId=${body.rootId}`).send({
        uptimeS: 60, relays: [{ on: false, changedS: 60 }],
        weather: { temp: 6.1, code: 61, cloud: 90, precip: 1.2, rain: 1.2, snow: 0, wind: 12.5, day: 0, age_s: 30 },
      }).expect(200);
      expect(answer.body.weather_query).toBeUndefined();
      expect(answer.body.weather_queries).toBeUndefined();
      expect(answer.body.relays).toHaveLength(1);
      // pogody nie ma, bo w testach serwer jej nie pobiera
      expect((await request(app).get('/api/temperature').expect(200)).body.weather).toBeNull();
    });
  });

  describe('harmonogramy i nazwy', () => {
    it('sprawdza wpis i pozwala go zmienić i usunąć', async () => {
      const { body } = await register('4CC382C520F7');
      const rootId = body.rootId;
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 2, dayOfWeek: -1, startTime: '06:00', endTime: '07:00' }).expect(400);
      await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, startTime: '06:00', endTime: '07:00' }).expect(400);
      const created = await request(app).post(`/api/switch/schedules?rootId=${rootId}`)
        .send({ relay: 1, dayOfWeek: -2, startTime: '06:00', endTime: '07:00' }).expect(201);

      await request(app).put(`/api/switch/schedules/${created.body._id}?rootId=${rootId}`)
        .send({ relay: 1, date: '2026-10-10', startTime: '10:00', endTime: '12:00', enabled: false }).expect(200);
      const list = await request(app).get(`/api/switch/schedules?rootId=${rootId}`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ startTime: '10:00', enabled: false });
      expect(list.body[0].dayOfWeek).toBeUndefined();

      await request(app).delete(`/api/switch/schedules/${created.body._id}?rootId=${rootId}`).expect(200);
      await request(app).delete(`/api/switch/schedules/${created.body._id}?rootId=${rootId}`).expect(404);
    });

    it('zmienia nazwę przekaźnika', async () => {
      const { body } = await register('4CC382C520F8');
      await request(app).put(`/api/switch/relays/1?rootId=${body.rootId}`).send({ name: 'Pompa ogrodowa' }).expect(200);
      await request(app).put(`/api/switch/relays/5?rootId=${body.rootId}`).send({ name: 'X' }).expect(404);
      const relays = await request(app).get(`/api/switch/relays?rootId=${body.rootId}`);
      expect(relays.body[0].name).toBe('Pompa ogrodowa');
    });
  });
});
