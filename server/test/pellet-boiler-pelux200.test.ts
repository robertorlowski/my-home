// Testy kotła pelletowego Pellux 200 (baza w mongodb-memory-server): zgłoszenie z
// ustawieniami, ten sam SN jako pompa i kocioł (routing po rodzaju), zapis i
// walidacja odczytu, 404/409, /last, /list (granice doby warszawskiej) oraz
// zapis i walidacja poll_interval_seconds przez PUT /device/properties, ustawienia
// regulatora (surowe odpowiedzi od sterownika, rozkodowanie do grup, walidacja).
import { readFileSync } from 'fs'
import { resolve } from 'path'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import app from '../src/core/app'
import { applySchedule, nextSeasonBoundary, scheduleState } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-schedule.service'
import { PelletBoilerPelux200Model } from '../src/modules/pellet-boiler-pelux200/models/pellet-boiler-pelux200.model'
import { PelletBoilerCommandModel } from '../src/modules/pellet-boiler-pelux200/models/pellet-boiler-pelux200-command.model'
import { PelletBoilerScheduleSettingsModel } from '../src/modules/pellet-boiler-pelux200/models/pellet-boiler-pelux200-schedule.model'
import { heatPumpRunningInHeatPumpMode, runWinterCycle, winterFromMax } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-winter-cycle.service'
import { migrateBoilerDefinitions } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-heat-pump-link.service'
import { DeviceModel } from '../src/core/models/device.model'
import { pelletBoilerTile } from '../src/modules/pellet-boiler-pelux200/tile'
import { listActiveAlertCodes } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-alert.service'

const TYPE = 'pellet-boiler-pelux200';
const register = (deviceId: string, deviceType = TYPE) =>
  request(app).post('/api/devices/register').send({ deviceId, deviceType, name: 'Kocioł' });

// Kocioł powiązany z pompą ciepła (definicja kotła, od 2026-10-08): tryb „Pompa ciepła” działa tylko z pompą.
const registerWithHeatPump = async (deviceId: string, pumpId = `${deviceId.slice(0, 10)}EE`) => {
  const res = await register(deviceId);
  const pump = (await register(pumpId, 'heat_pump')).body.rootId as string;
  await request(app).put(`/api/devices/${res.body.rootId}`).send({ boilerConfig: { heatPumpRootId: pump } }).expect(200);
  return res;
};

describe('Kocioł pelletowy Pellux 200', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await PelletBoilerPelux200Model.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('zgłoszenie tworzy urządzenie z ustawieniem 60 s i odsyła je w settings', async () => {
    const res = await register('AABBCC000001');
    expect(res.status).toBe(201);
    expect(res.body.deviceType).toBe(TYPE);
    expect(res.body.settings).toEqual({ poll_interval_seconds: 60 });

    const again = await register('AABBCC000001');
    expect(again.status).toBe(200);
    expect(again.body.rootId).toBe(res.body.rootId);
  });

  it('ten sam deviceId jako pompa i kocioł daje dwa rootId i osobny routing', async () => {
    const sn = 'AABBCC000002';
    const boiler = (await register(sn)).body;
    const hp = (await register(sn, 'heat_pump')).body;
    expect(boiler.rootId).not.toBe(hp.rootId);

    // sam deviceId: każdy endpoint trafia w swój rodzaj
    const add = await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 3 });
    expect(add.status).toBe(201);
    const hpAdd = await request(app).post(`/api/hp/add?deviceId=${sn}`)
      .send({ HP: { Ttarget: 40 }, work_mode: 'CWU' });
    expect(hpAdd.status).toBe(201);

    const last = await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${boiler.rootId}`);
    expect(last.body.rootId).toBe(boiler.rootId);
    expect(last.body.state).toBe(3);

    // rootId pompy na endpoincie kotła i odwrotnie: 409
    expect((await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}&rootId=${hp.rootId}`)
      .send({ state: 1 })).status).toBe(409);
    expect((await request(app).post(`/api/hp/add?deviceId=${sn}&rootId=${boiler.rootId}`)
      .send({ HP: { Ttarget: 40 } })).status).toBe(409);
  });

  it('zapisuje odczyt, pomija nieznane pola i time, odpowiada odstępem odpytywania', async () => {
    const { rootId } = (await register('AABBCC000003')).body;
    const res = await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=AABBCC000003&rootId=${rootId}`)
      .send({
        time: '2026.10.01 12:00:00', state: 3, heating_temp: 63.5, fuel_level: 80,
        boiler_power: 12.4, fan: true, alarm: false, nieznane: 1,
        mixer1_temp: 31.5, mixer1_target: 35, mixer1_pump: true, mixer1_opening: false,
        mixer1_closing: true, mixer3_temp: 20,
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ poll_interval_seconds: 60 });

    const doc = await PelletBoilerPelux200Model.findOne({ rootId }).lean() as Record<string, unknown>;
    expect(doc.heating_temp).toBe(63.5);
    expect(doc.fan).toBe(true);
    expect(doc.alarm).toBe(false);
    expect(doc.deviceType).toBe(TYPE);
    expect(doc.deviceId).toBe('AABBCC000003');
    expect(doc).not.toHaveProperty('nieznane');
    expect(doc).not.toHaveProperty('time');
    // mieszacze 1 i 2 (firmware 1.2.0); mieszacza 3 kontrakt nie ma
    expect(doc.mixer1_temp).toBe(31.5);
    expect(doc.mixer1_target).toBe(35);
    expect(doc.mixer1_pump).toBe(true);
    expect(doc.mixer1_closing).toBe(true);
    expect(doc).not.toHaveProperty('mixer3_temp');
  });

  it('400 dla pustego body, samego time i pól złego typu', async () => {
    const { rootId } = (await register('AABBCC000004')).body;
    const url = `/api/pellet-boiler-pelux200/add?rootId=${rootId}`;
    expect((await request(app).post(url).send({})).status).toBe(400);
    expect((await request(app).post(url).send({ time: '2026.10.01 12:00:00' })).status).toBe(400);
    expect((await request(app).post(url).send({ state: '3' })).status).toBe(400);
    expect((await request(app).post(url).send({ fan: 1 })).status).toBe(400);
    expect((await request(app).post(url).send({ heating_temp: null })).status).toBe(400);
    expect((await request(app).post(url).send({ mixer1_pump: 1 })).status).toBe(400);
  });

  it('404 dla nieznanego deviceId, 409 dla rootId innego urządzenia', async () => {
    expect((await request(app).post('/api/pellet-boiler-pelux200/add?deviceId=NIEMA').send({ state: 1 })).status).toBe(404);
    const { rootId } = (await register('AABBCC000005')).body;
    expect((await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=INNY&rootId=${rootId}`)
      .send({ state: 1 })).status).toBe(409);
  });

  it('/last: {} bez odczytów, potem najnowszy', async () => {
    const { rootId } = (await register('AABBCC000006')).body;
    expect((await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`)).body).toEqual({});
    await request(app).post(`/api/pellet-boiler-pelux200/add?rootId=${rootId}`).send({ heating_temp: 50 });
    await request(app).post(`/api/pellet-boiler-pelux200/add?rootId=${rootId}`).send({ heating_temp: 55 });
    const last = await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`);
    expect(last.body.heating_temp).toBe(55);
    // wymaga rootId
    expect((await request(app).get('/api/pellet-boiler-pelux200/last')).status).toBe(400);
  });

  it('/list: odczyty jednej doby warszawskiej, malejąco; 400 dla złej daty', async () => {
    const { rootId } = (await register('AABBCC000007')).body;
    const make = (createdAt: string, heating_temp: number) => PelletBoilerPelux200Model.create({
      rootId, deviceType: TYPE, deviceId: 'AABBCC000007', heating_temp, createdAt: new Date(createdAt),
    });
    // zima, Warszawa = UTC+1: doba 2026-01-15 to 2026-01-14T23:00Z .. 2026-01-15T23:00Z
    await make('2026-01-14T22:59:59Z', 1);
    await make('2026-01-14T23:00:00Z', 2);
    await make('2026-01-15T12:00:00Z', 3);
    await make('2026-01-15T22:59:59Z', 4);
    await make('2026-01-15T23:00:00Z', 5);

    const res = await request(app).get(`/api/pellet-boiler-pelux200/list?rootId=${rootId}&date=2026-01-15`);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { heating_temp: number }) => r.heating_temp)).toEqual([4, 3, 2]);

    expect((await request(app).get(`/api/pellet-boiler-pelux200/list?rootId=${rootId}&date=jutro`)).status).toBe(400);
    // bez date: dzisiaj, a wpisy ze stycznia 2026 nie wchodzą
    const today = await request(app).get(`/api/pellet-boiler-pelux200/list?rootId=${rootId}`);
    expect(today.status).toBe(200);
    expect(today.body).toEqual([]);
  });

  it('PUT /device/properties zapisuje i waliduje poll_interval_seconds', async () => {
    const { rootId } = (await register('AABBCC000008')).body;
    const put = (body: unknown) => request(app).put(`/api/device/properties?rootId=${rootId}`).send(body as object);

    const ok = await put({ poll_interval_seconds: 60 });
    expect(ok.status).toBe(200);
    expect(ok.body.poll_interval_seconds).toBe(60);
    expect((await request(app).get(`/api/device/properties?rootId=${rootId}`)).body.poll_interval_seconds).toBe(60);

    expect((await put({ poll_interval_seconds: 29 })).status).toBe(400);
    expect((await put({ poll_interval_seconds: 3601 })).status).toBe(400);
    expect((await put({ poll_interval_seconds: 45.5 })).status).toBe(400);
    // odrzucony zapis nie zmienia wartości
    expect((await request(app).get(`/api/device/properties?rootId=${rootId}`)).body.poll_interval_seconds).toBe(60);

    // nowe ustawienie dociera do sterownika w odpowiedzi na odczyt
    const add = await request(app).post(`/api/pellet-boiler-pelux200/add?rootId=${rootId}`).send({ state: 0 });
    expect(add.body).toEqual({ poll_interval_seconds: 60 });
  });

  // Prawdziwe odpowiedzi regulatora z kopii ustawień kotła (2026-10-03).
  const archive = JSON.parse(readFileSync(resolve(__dirname,
    '../../devices/pellet-boiler-pelux200/docs/ustawienia-kotla-2026-10-03.json'), 'utf-8'));

  it('ustawienia: sterownik wysyła hex samym deviceId, aplikacja dostaje parametry w grupach', async () => {
    const sn = 'AABBCC000009';
    const { rootId } = (await register(sn)).body;
    const empty = await request(app).get(`/api/pellet-boiler-pelux200/settings?rootId=${rootId}`);
    expect(empty.body).toEqual({});

    const post = await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`)
      .send(archive.raw_hex);
    expect(post.status).toBe(201);

    const res = await request(app).get(`/api/pellet-boiler-pelux200/settings?rootId=${rootId}`);
    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe(sn);
    type Item = { index: number; name: string; value: number; min: number; max: number; unit?: string };
    const all: Item[] = res.body.groups.flatMap((group: { parameters: Item[] }) => group.parameters);
    expect(all).toHaveLength(60);  // tyle parametrów ma wartość w tym kotle
    const byName = (name: string) => all.find((p) => p.name === name);
    expect(byName('heating_target_temp')).toMatchObject({ index: 98, value: 67, min: 65, max: 80, unit: '°C' });
    expect(byName('water_heater_target_temp')).toMatchObject({ index: 119, value: 55 });
    expect(byName('heating_curve_shift')).toMatchObject({ value: 0, min: -20, max: 20 });  // przesunięcie 20
    expect(byName('max_fuel_flow')).toMatchObject({ value: 9.6 });  // krok 0,2
    expect(all.find((p) => p.index === 139)).toMatchObject({ name: null, raw: [50, 0, 100] });
    const boiler = res.body.groups.find((group: { key: string }) => group.key === 'boiler');
    expect(boiler.label).toBe('Kocioł: temperatury i histerezy');

    // mieszacz 1 z odczytu; mieszacz 2 (regulator podaje same FF) zakładany: zadana 20–40 °C, reszta z zakresów mieszacza 1
    expect(res.body.mixers).toHaveLength(2);
    expect(res.body.mixers[0].mixer).toBe(1);
    expect(res.body.mixers[0].parameters[0]).toMatchObject({ name: 'mixer_target_temp', value: 40 });
    const assumed = res.body.mixers[1];
    expect(assumed).toMatchObject({ mixer: 2, assumed: true });
    expect(assumed.parameters.map((p: { index: number }) => p.index)).toEqual([0, 4, 5, 6]);
    expect(assumed.parameters[0]).toMatchObject({ name: 'mixer_target_temp', min: 20, max: 40, unknown: true });
    expect(assumed.parameters[1]).toMatchObject({ name: 'weather_control', min: 0, max: 1, unknown: true });
    expect(assumed.parameters[3]).toMatchObject({ name: 'heating_curve_shift', min: -20, max: 20, unknown: true });

    // zlecenie dla mieszacza 2: zakres 20–40, bez poprzedniej wartości
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0 }).expect(201);
    const commands = `/api/pellet-boiler-pelux200/commands?rootId=${rootId}`;
    expect((await request(app).post(commands).send({ changes: [{ kind: 'mixer', mixer: 2, index: 0, value: 45 }] })).status).toBe(400);
    const created = await request(app).post(commands).send({ changes: [{ kind: 'mixer', mixer: 2, index: 0, value: 30 }, { kind: 'mixer', mixer: 2, index: 4, value: 1 }] });
    expect(created.status).toBe(201);
    expect(created.body[0]).toMatchObject({ kind: 'mixer', mixer: 2, index: 0, value: 30, label: 'Temperatura zadana mieszacza' });
    expect(created.body[0].previous).toBeUndefined();
  });

  it('ustawienia: 400 bez parametrów kotła, dla złego hex i nie-napisu', async () => {
    const sn = 'AABBCC00000A';
    await register(sn);
    const post = (body: unknown) =>
      request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(body as object);
    expect((await post({})).status).toBe(400);
    expect((await post({ mixer_parameters: archive.raw_hex.mixer_parameters })).status).toBe(400);
    expect((await post({ ecomax_parameters: 'zz00' })).status).toBe(400);
    expect((await post({ ecomax_parameters: '000' })).status).toBe(400);
    expect((await post({ ecomax_parameters: 12 })).status).toBe(400);
  });

  it('zmiana parametrów: aplikacja zleca, sterownik odbiera po kolei i potwierdza', async () => {
    const sn = 'AABBCC000011';
    const { rootId } = (await register(sn)).body;
    const commands = `/api/pellet-boiler-pelux200/commands?rootId=${rootId}`;
    const next = () => request(app).get(`/api/pellet-boiler-pelux200/commands/next?deviceId=${sn}`);
    const result = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/commands/result?deviceId=${sn}`).send(body);

    // kocioł nie przesyła danych (brak odczytu): 409, także włącz/wyłącz
    const noReading = await request(app).post(commands).send({ changes: [{ kind: 'control', index: 0, value: 1 }] });
    expect(noReading.status).toBe(409);
    expect(noReading.body.message).toMatch(/nie przesyła danych/);
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0 }).expect(201);
    expect((await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`)).body.responding).toBe(true);
    // bez odczytu ustawień nie ma zakresów: 400
    expect((await request(app).post(commands).send({ changes: [{ kind: 'ecomax', index: 119, value: 50 }] })).status).toBe(400);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);

    // walidacja: zakres regulatora (CWU 20–70), parametr nieużywany, typy, mieszacz bez numeru
    const bad = async (change: object) =>
      expect((await request(app).post(commands).send({ changes: [change] })).status).toBe(400);
    await bad({ kind: 'ecomax', index: 119, value: 75 });
    await bad({ kind: 'ecomax', index: 3, value: 1 });
    await bad({ kind: 'ecomax', index: 119, value: '50' });
    await bad({ kind: 'mixer', index: 0, value: 45 });
    expect((await request(app).post(commands).send({ changes: [] })).status).toBe(400);

    // dwie zmiany w kolejności; trzecia zastępuje oczekującą zmianę CWU
    const created = await request(app).post(commands).send({ changes: [
      { kind: 'ecomax', index: 119, value: 45 },
      { kind: 'mixer', mixer: 1, index: 0, value: 45 },
    ] });
    expect(created.status).toBe(201);
    expect(created.body[0]).toMatchObject({ kind: 'ecomax', index: 119, value: 45, previous: 55, status: 'pending' });
    await request(app).post(commands).send({ changes: [{ kind: 'ecomax', index: 119, value: 48 }] }).expect(201);

    // sterownik: najpierw mieszacz (zmiana CWU 45 zastąpiona), potem CWU 48, potem nic
    const first = (await next()).body;
    expect(first).toMatchObject({ kind: 'mixer', mixer: 1, index: 0, value: 45 });
    expect((await result({ id: first.id, ok: true })).status).toBe(201);
    expect((await result({ id: first.id, ok: true })).status).toBe(404);
    const second = (await next()).body;
    expect(second).toMatchObject({ kind: 'ecomax', mixer: 0, index: 119, value: 48 });
    await result({ id: second.id, ok: false, error: 'brak potwierdzenia 0xB3' }).expect(201);
    expect((await next()).body).toEqual({});

    // zależny zakres: zadana kotła 30 przy minimum 65 tylko razem z obniżeniem minimum (wcześniej w zleceniu)
    expect((await request(app).post(commands).send({ changes: [{ kind: 'ecomax', index: 98, value: 30 }] })).status).toBe(400);
    const pump = await request(app).post(commands).send({ changes: [
      { kind: 'ecomax', index: 99, value: 30 }, { kind: 'ecomax', index: 98, value: 30 },
    ] });
    expect(pump.status).toBe(201);
    await request(app).post(commands).send({ changes: [
      { kind: 'ecomax', index: 98, value: 30 }, { kind: 'ecomax', index: 99, value: 30 },
    ] }).expect(400);
    for (const command of pump.body) {
      const taken = (await next()).body;
      expect(taken.id).toBe(String(command._id));
      await result({ id: taken.id, ok: true }).expect(201);
    }

    const history = (await request(app).get(commands)).body.slice(2);
    expect(history.map((c: { status: string }) => c.status)).toEqual(['error', 'done', 'replaced']);
    expect(history[0].error).toBe('brak potwierdzenia 0xB3');

    // odczyt starszy niż 3 odstępy odpytywania (60 s, najmniej 3 min): kocioł milczy, 409 i responding: false
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3 * 60_000 + 1000));
    expect((await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`)).body.responding).toBe(false);
    expect((await request(app).post(commands).send({ changes: [{ kind: 'ecomax', index: 119, value: 50 }] })).status).toBe(409);
    vi.useRealTimers();
  });

  it('kafelek prosty: włącz piec (regulator, harmonogram, CWU, Zima), CWU osobno, wyłącz; stan w kafelku', async () => {
    const sn = 'AABBCC000021';
    const { rootId } = (await register(sn)).body;
    const simple = (action: string) => request(app).post(`/api/pellet-boiler-pelux200/simple?rootId=${rootId}`).send({ action });
    const next = () => request(app).get(`/api/pellet-boiler-pelux200/commands/next?deviceId=${sn}`);
    const result = (id: string) => request(app).post(`/api/pellet-boiler-pelux200/commands/result?deviceId=${sn}`).send({ id, ok: true });
    const drain = async () => {
      const taken: { kind: string; index: number; value: number }[] = [];
      for (;;) {
        const command = (await next()).body;
        if (!command.id) return taken;
        taken.push({ kind: command.kind, index: command.index, value: command.value });
        await result(command.id).expect(201);
      }
    };
    expect((await simple('boost')).status).toBe(400);
    // kocioł wyłączony (stan 0), tryb Pellet (bez pompy ciepła), ustawienia z kopii kotła
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0, heating_temp: 38, water_heater_temp: 44, water_heater_target: 55 }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);
    const settings = `/api/pellet-boiler-pelux200/schedule-settings?rootId=${rootId}`;
    const saved = (await request(app).get(settings)).body;
    await request(app).put(settings).send({ ...saved, enabled: false }).expect(200);

    // kafelek przed: wyłączony, CWU i temperatury z odczytu, bez zlecenia w toku
    const device = (await DeviceModel.findById(rootId))!;
    expect((await pelletBoilerTile(rootId, device))?.boiler).toMatchObject({
      online: true, regulatorOn: false, burning: false, season: 'winter', cwuOn: true, boilerTemp: 38, cwuTemp: 44, cwuTarget: 55, heatPumpMode: false, pending: null,
    });

    // „Włącz piec”: harmonogram włączony, zlecenie włącz regulator (Zima i CWU już ustawione w kopii kotła: bez zleceń)
    const on = await simple('on').expect(200);
    expect(on.body).toMatchObject({ pending: 'control' });
    expect((await request(app).get(settings)).body.enabled).toBe(true);
    expect(await drain()).toEqual([{ kind: 'control', index: 0, value: 1 }]);
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 3, heating_temp: 60 }).expect(201);
    expect((await pelletBoilerTile(rootId, device))?.boiler).toMatchObject({ regulatorOn: true, burning: true, pending: null });

    // „Wyłącz CWU” / „Włącz CWU”: nr 122
    expect((await simple('cwu-off').expect(200)).body.pending).toBe('cwu');
    expect(await drain()).toEqual([{ kind: 'ecomax', index: 122, value: 0 }]);
    expect((await simple('cwu-on').expect(200)).body.pending).toBe('cwu');
    expect(await drain()).toEqual([{ kind: 'ecomax', index: 122, value: 1 }]);

    // „Wyłącz piec”: harmonogram stoi, zlecenie wyłącz regulator
    await simple('off').expect(200);
    expect((await request(app).get(settings)).body.enabled).toBe(false);
    expect(await drain()).toEqual([{ kind: 'control', index: 0, value: 0 }]);
  });

  it('harmonogram czyszczenia: przełącznik z odczytu 0xB6, zlecenie schedule do sterownika, walidacja', async () => {
    const sn = 'AABBCC000019';
    const { rootId } = (await register(sn)).body;
    const commands = `/api/pellet-boiler-pelux200/commands?rootId=${rootId}`;
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0 }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);

    // kopia z 2026-10-03: włączony tylko harmonogram czyszczenia (nr 4)
    const view = (await request(app).get(`/api/pellet-boiler-pelux200/settings?rootId=${rootId}`)).body;
    expect(view.schedules).toEqual([
      { index: 0, name: 'heating', label: 'Harmonogram CO', enabled: false },
      { index: 1, name: 'water_heater', label: 'Harmonogram CWU', enabled: false },
      { index: 4, name: 'boiler_clean', label: 'Harmonogram czyszczenia', enabled: true },
      { index: 6, name: 'mixer_1', label: 'Harmonogram mieszacza 1', enabled: false },
      { index: 7, name: 'mixer_2', label: 'Harmonogram mieszacza 2', enabled: false },
    ]);

    const bad = async (change: object) =>
      expect((await request(app).post(commands).send({ changes: [change] })).status).toBe(400);
    await bad({ kind: 'schedule', index: 4, value: 2 });
    await bad({ kind: 'schedule', index: 3, value: 0 });  // praca kotła: nie ma w odczycie

    const created = await request(app).post(commands).send({ changes: [{ kind: 'schedule', index: 4, value: 0 }] });
    expect(created.status).toBe(201);
    expect(created.body[0]).toMatchObject({ kind: 'schedule', index: 4, value: 0, previous: 1, label: 'Harmonogram czyszczenia' });
    const taken = (await request(app).get(`/api/pellet-boiler-pelux200/commands/next?deviceId=${sn}`)).body;
    expect(taken).toMatchObject({ kind: 'schedule', mixer: 0, index: 4, value: 0 });
  });

  it('zmiana trybu przy wyłączonym kotle: wyłącz, nastawy czekają na stan 0, na końcu włącz', async () => {
    const sn = 'AABBCC000013';
    const { rootId } = (await register(sn)).body;
    const commands = `/api/pellet-boiler-pelux200/commands?rootId=${rootId}`;
    const next = () => request(app).get(`/api/pellet-boiler-pelux200/commands/next?deviceId=${sn}`);
    const result = (id: string) => request(app).post(`/api/pellet-boiler-pelux200/commands/result?deviceId=${sn}`).send({ id, ok: true });
    const reading = (state: number) =>
      request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state, heating_temp: 40 }).expect(201);
    const pause = () => new Promise((done) => setTimeout(done, 5));
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);
    await reading(3);
    await pause();

    expect((await request(app).post(commands).send({ changes: [{ kind: 'ecomax', index: 119, value: 45, waitOff: 'tak' }] })).status).toBe(400);
    const created = await request(app).post(commands).send({ changes: [
      { kind: 'control', index: 0, value: 0 },
      { kind: 'ecomax', index: 119, value: 45, waitOff: true },
      { kind: 'control', index: 0, value: 1, waitOff: true },
    ] });
    expect(created.status).toBe(201);
    // „włącz” w tym samym zleceniu nie zastępuje „wyłącz”
    expect(created.body.map((c: { status: string }) => c.status)).toEqual(['pending', 'pending', 'pending']);

    const off = (await next()).body;
    expect(off).toMatchObject({ kind: 'control', value: 0 });
    await result(off.id).expect(201);
    // kocioł jeszcze pracuje (albo wygasza): nastawy czekają
    expect((await next()).body).toEqual({});
    await pause();
    await reading(7);
    expect((await next()).body).toEqual({});
    await pause();
    await reading(0);
    const cwu = (await next()).body;
    expect(cwu).toMatchObject({ kind: 'ecomax', index: 119, value: 45 });
    await result(cwu.id).expect(201);
    const on = (await next()).body;
    expect(on).toMatchObject({ kind: 'control', value: 1 });
    await result(on.id).expect(201);
    expect((await next()).body).toEqual({});
  });

  // Kopia ustawień z 2026-10-04: minimalna temperatura kotła 30 °C (tryb pompy ciepła), CWU 40 / histereza 5.
  const archiveHeatPump = JSON.parse(readFileSync(resolve(__dirname,
    '../../devices/pellet-boiler-pelux200/docs/ustawienia-kotla-2026-10-04.json'), 'utf-8'));
  // Odczyty kotła z produkcji 2026-10-04 wieczorem (przełączenie na Zimę 22:27) do testu cyklu Zimy.
  const winterReplay = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/kociol-cykl-zimy-2026-10-04.json'), 'utf-8'));

  it('harmonogram: CWU od–do osobno dla trybu, tryb z odczytu ustawień, zlecenia tylko przy zmianie', async () => {
    const sn = 'AABBCC000012';
    const { rootId } = (await registerWithHeatPump(sn)).body;
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${rootId}`;
    const commands = async () => (await request(app).get(api('commands'))).body as { kind: string; index: number; value: number; status: string }[];
    // kocioł w postoju (stan 5) — włączony, więc „włącz” nie jest zlecane
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5 }).expect(201);

    // wartości startowe: wyłączony, pompa ciepła 35–40, pellet 40–55, nastawy trybów
    const start = (await request(app).get(api('schedule-settings'))).body;
    expect(start).toMatchObject({ enabled: false, defaults: { 'heat-pump': { cwuFrom: 35, cwuTo: 40 }, pellet: { cwuFrom: 40, cwuTo: 55 } } });
    expect(start.profiles['heat-pump']['ecomax:99']).toBe(30);

    // walidacja
    expect((await request(app).post(api('schedules')).send({ mode: 'gas', dayOfWeek: -1, startTime: '05:00', endTime: '06:00', cwuFrom: 40, cwuTo: 43 })).status).toBe(400);
    expect((await request(app).post(api('schedules')).send({ mode: 'heat-pump', dayOfWeek: -1, startTime: '05:00', endTime: '06:00', cwuFrom: 43, cwuTo: 40 })).status).toBe(400);
    expect((await request(app).put(api('schedule-settings')).send({ ...start, profiles: { pellet: { 'ecomax:98': 300 } } })).status).toBe(400);

    // wpisy tylko dla pompy ciepła
    await request(app).post(api('schedules')).send({ mode: 'heat-pump', dayOfWeek: -1, startTime: '05:00', endTime: '06:00', cwuFrom: 40, cwuTo: 43 }).expect(201);
    await request(app).post(api('schedules')).send({ mode: 'heat-pump', dayOfWeek: -1, startTime: '13:00', endTime: '15:00', cwuFrom: 40, cwuTo: 43 }).expect(201);

    // bez odczytu ustawień nie wiadomo, który tryb działa: błąd, bez zleceń
    await request(app).put(api('schedule-settings')).send({ ...start, enabled: true }).expect(200);
    expect((await request(app).get(api('schedules/current'))).body.lastError).toMatch(/Brak odczytu/);

    // pellet (kopia z 3.10: minimum 65): domyślne 40–55 = CWU 55 / histereza 15, już takie — nic do zlecenia
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);
    await applySchedule(rootId, new Date('2026-10-05T03:30:00Z'));  // 05:30 w Warszawie, ale wpisy są pompy ciepła
    expect((await commands()).map((c) => `${c.kind}:${c.index}=${c.value}`)).toEqual([]);

    // pompa ciepła (kopia z 4.10: minimum 30, CWU 40 / 5): w oknie 05:00–06:00 CWU 43 / 3
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    await applySchedule(rootId, new Date('2026-10-05T03:30:00Z'));
    expect((await commands()).map((c) => [c.kind, c.index, c.value]).sort()).toEqual([['ecomax', 119, 43], ['ecomax', 123, 3]]);
    const current = (await request(app).get(api('schedules/current'))).body;
    expect(current).toMatchObject({ enabled: true, mode: 'heat-pump', lastError: null });

    // ten sam stan: nic nowego; po oknie domyślne 35–40 (CWU 40 / 5 jak w odczycie, więc zastępuje oczekujące)
    const count = (await commands()).length;
    await applySchedule(rootId, new Date('2026-10-05T03:50:00Z'));
    expect((await commands()).length).toBe(count);
    await applySchedule(rootId, new Date('2026-10-05T06:00:00Z'));

    // włączania i wyłączania kotła w harmonogramie już nie ma: wpis pracy kotła jest odrzucany
    await request(app).post(api('schedules')).send({ type: 'work', mode: 'heat-pump', on: false, dayOfWeek: -1, startTime: '22:00', endTime: '05:00' }).expect(400);

    // harmonogram nie działa („Wyłącz regulator”): kolejne przebiegi nic nie zlecają, także w oknie CWU;
    // harmonogram nigdy nie zleca włącz/wyłącz regulatora (robią to przyciski)
    const settings = (await request(app).get(api('schedule-settings'))).body;
    expect(settings.defaults['heat-pump']).toEqual({ cwuFrom: 35, cwuTo: 40 });
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: false }).expect(200);
    const stopped = (await commands()).length;
    await applySchedule(rootId, new Date('2026-10-06T03:30:00Z'));
    expect((await commands()).length).toBe(stopped);

    // znów działa: w oknie 05:00–06:00 od razu CWU 43 / 3
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: true }).expect(200);
    await applySchedule(rootId, new Date('2026-10-06T03:30:00Z'));
    expect((await commands()).length).toBeGreaterThan(stopped);
    expect((await commands()).some((c) => c.kind === 'control')).toBe(false);
  });

  it('harmonogram sezonu: Lato/Zima (nr 125) w oknie razem z CWU jednym zleceniem, próg temperatury z histerezą', async () => {
    const sn = 'AABBCC000013';
    const { rootId } = (await registerWithHeatPump(sn)).body;
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${rootId}`;
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5 }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const view = (await request(app).get(api('settings'))).body;
    const raw125 = view.groups.flatMap((g: { parameters: { index: number; raw: number[] }[] }) => g.parameters)
      .find((p: { index: number }) => p.index === 125).raw[0];
    // sezon w oknie: przeciwny do tego, co jest w kotle, żeby było co zlecić
    const night = raw125 === 0 ? 'summer' : 'winter';
    const nightValue = raw125 === 0 ? 1 : 0;

    // walidacja wpisu sezonu
    const post = (body: object) => request(app).post(api('schedules')).send({ mode: 'heat-pump', dayOfWeek: -1, startTime: '22:00', endTime: '06:00', ...body });
    expect((await post({ type: 'season', season: 'spring' })).status).toBe(400);
    // „Tryb Zima” (2026-10-15): oba progi albo żaden, co 0,5 °C, Lato powyżej Zimy; bez season = zima
    expect((await post({ type: 'season', winterBelow: 5 })).status).toBe(400);
    expect((await post({ type: 'season', winterBelow: 5.2, summerAbove: 7 })).status).toBe(400);
    expect((await post({ type: 'season', winterBelow: 7, summerAbove: 7 })).status).toBe(400);
    expect((await post({ type: 'season', winterBelow: 5, summerAbove: 99 })).status).toBe(400);
    // wpis trybu Pellet, żeby nie wpływał na dalszą część testu (tryb pompy ciepła)
    expect((await post({ type: 'season', mode: 'pellet', winterBelow: 5, summerAbove: 6.5 }).expect(201)).body)
      .toMatchObject({ season: 'winter', winterBelow: 5, summerAbove: 6.5, coldBelow: null });
    const created = (await post({ type: 'season', season: night }).expect(201)).body;
    expect(created).toMatchObject({ type: 'season', season: night, winterBelow: null, summerAbove: null });
    // CWU w tym samym oknie
    await post({ cwuFrom: 40, cwuTo: 43 }).expect(201);

    const settings = (await request(app).get(api('schedule-settings'))).body;
    expect((await request(app).put(api('schedule-settings')).send({ ...settings, defaults: { ...settings.defaults, pellet: { ...settings.defaults.pellet, season: 'jesień' } } })).status).toBe(400);
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: true }).expect(200);

    // 23:00 w Warszawie: sezon i CWU razem (jedno zlecenie = jedna partia, kolejność: sezon, CWU)
    await applySchedule(rootId, new Date('2026-10-05T21:00:00Z'));
    const list = (await request(app).get(api('commands'))).body as { index: number; value: number; status: string }[];
    const pending = list.filter((c) => c.status === 'pending').map((c) => [c.index, c.value]);
    expect(pending).toContainEqual([125, nightValue]);
    expect(pending).toContainEqual([119, 43]);
    // odczyt stanu też o 23:00 (endpoint liczy okno z bieżącego zegara; bez tego test przechodził tylko w nocy)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T21:00:30Z'));
    const current = (await request(app).get(api('schedules/current'))).body;
    vi.useRealTimers();
    expect(current.seasonScheduleId).toBe(created._id);
    expect(current.state.season).toBe(night);
    // temperatura zewnętrzna z czujnika kotła (ostatni odczyt), bez czujnika null
    expect(current.outdoorTemperature).toBeNull();
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, outside_temp: 4.5 }).expect(201);
    expect((await request(app).get(api('schedules/current'))).body.outdoorTemperature).toBe(4.5);
    // ten sam czujnik to temperatura zewnętrzna serwera (t_out pompy ciepła, GET /temperature)
    expect((await request(app).get(`/api/temperature?rootId=${rootId}`)).body.temperature).toBe(4.5);
  });

  it('cykl Zimy w trybie pompy ciepła: Zima przy kotle ≥ 45 °C, Lato przy < 30 °C i stojącej pompie CO, wymuszanie startu pompy', async () => {
    const sn = 'AABBCC000014';
    const { rootId } = (await registerWithHeatPump(sn, 'AABBCC0000F4')).body;
    await register('AABBCC0000F4', 'heat_pump');
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const reading = (heating_temp: number, heating_pump: boolean) =>
      request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, heating_temp, heating_pump }).expect(201);
    const seasonCommands = async () => ((await request(app).get(`/api/pellet-boiler-pelux200/commands?rootId=${rootId}`)).body as
      { _id: string; index: number; value: number; status: string }[]).filter((c) => c.index === 125);
    const forced: string[] = [];
    const pump = { running: async () => false, force: async (id: string) => { forced.push(id); } };
    const t0 = new Date();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    // Lato, kocioł 35 °C: czekanie i wymuszenie startu pompy ciepła, najwyżej co 10 min
    await reading(35, false);
    expect((await runWinterCycle(rootId, 'summer', at(0), pump)).phase).toBe('waiting');
    await runWinterCycle(rootId, 'summer', at(5), pump);
    expect(forced).toHaveLength(1);
    await runWinterCycle(rootId, 'summer', at(10), pump);
    expect(forced).toHaveLength(2);
    // sprężarka pracuje: bez wymuszenia
    await runWinterCycle(rootId, 'summer', at(25), { ...pump, running: async () => true });
    expect(forced).toHaveLength(2);
    expect(await seasonCommands()).toEqual([]);

    // kocioł 45 °C: Zima (jedno zlecenie, kolejne kroki czekają na jego wynik)
    await reading(45, true);
    await runWinterCycle(rootId, 'summer', new Date(), pump);
    await runWinterCycle(rootId, 'summer', new Date(), pump);
    const winter = await seasonCommands();
    expect(winter.map((c) => [c.value, c.status])).toEqual([[0, 'pending']]);
    await PelletBoilerCommandModel.updateOne({ _id: winter[0]._id }, { $set: { status: 'done' } });

    // Zima: woda stygnie, pompa CO pracuje — zostaje; poniżej 30 °C i pompa CO stoi — Lato
    await reading(28, true);
    expect((await runWinterCycle(rootId, 'winter', new Date(), pump)).phase).toBe('winter');
    expect(await seasonCommands()).toHaveLength(1);
    await reading(28, false);
    await runWinterCycle(rootId, 'winter', new Date(), pump);
    expect((await seasonCommands()).map((c) => c.value)).toContain(1);
  });

  it('cykl Zimy: próg = max pompy ciepła (HP.Tmax) − 3 °C (31–49, bez danych pompy 45 °C), na kotle albo HP.Ttarget pompy', async () => {
    const sn = 'AABBCC000019';
    const { rootId } = (await registerWithHeatPump(sn, 'AABBCC0000F9')).body;
    await register('AABBCC0000F9', 'heat_pump');
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const seasonCommands = async () => ((await request(app).get(`/api/pellet-boiler-pelux200/commands?rootId=${rootId}`)).body as
      { index: number }[]).filter((c) => c.index === 125);
    const pump = (max: number | null, water: number | null = 40) =>
      ({ running: async () => true, force: async () => undefined, temperatures: async () => ({ max, water }) });
    const boiler = (heating_temp: number) =>
      request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, heating_temp, heating_pump: false }).expect(201);

    expect([47, 60, 30, null].map(winterFromMax)).toEqual([44, 49, 31, 45]);

    // pompa grzeje do 47 °C, kocioł opóźniony (40 °C): Zima, gdy próg osiągnie woda w pompie (HP.Ttarget)
    await boiler(40);
    expect(await runWinterCycle(rootId, 'summer', new Date(), pump(47, 43.9))).toMatchObject({ phase: 'waiting', winterFrom: 44, pumpTemperature: 43.9 });
    expect(await seasonCommands()).toEqual([]);
    await runWinterCycle(rootId, 'summer', new Date(), pump(47, 44));
    expect(await seasonCommands()).toHaveLength(1);
    await PelletBoilerCommandModel.deleteMany({ rootId });

    // pompa grzeje do 47 °C: kocioł 43,9 °C czeka, 44 °C — Zima
    await boiler(43.9);
    expect(await runWinterCycle(rootId, 'summer', new Date(), pump(47))).toMatchObject({ phase: 'waiting', winterFrom: 44 });
    expect(await seasonCommands()).toEqual([]);
    await boiler(44);
    await runWinterCycle(rootId, 'summer', new Date(), pump(47));
    expect(await seasonCommands()).toHaveLength(1);
  });

  it('cykl Zimy na prawdziwych odczytach kotła z 2026-10-04 (Lato do 22:27, potem Zima)', async () => {
    // fixture: test/fixtures/kociol-cykl-zimy-2026-10-04.json (czas, temperatura kotła, pompa CO; bez identyfikatorów)
    const sn = 'AABBCC000016';
    const { rootId } = (await registerWithHeatPump(sn)).body;
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const forced: Date[] = [];
    const decisions: { t: string; temp: number; pump: boolean; season: string; action: string }[] = [];
    const winterFrom = new Date(winterReplay.zimaOd);
    vi.useFakeTimers({ toFake: ['Date'] });

    for (const reading of winterReplay.odczyty as { t: string; heating_temp: number; heating_pump: boolean }[]) {
      const at = new Date(reading.t);
      // odczyt przez API z zegarem ustawionym na czas z nagrania (serwer trzyma ostatni odczyt w pamięci)
      vi.setSystemTime(at);
      await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`)
        .send({ state: 5, heating_temp: reading.heating_temp, heating_pump: reading.heating_pump }).expect(201);
      const season = at < winterFrom ? 'summer' : 'winter';
      const now = new Date(at.getTime() + 30_000);
      const before = await PelletBoilerCommandModel.countDocuments({ rootId });
      const forcedBefore = forced.length;
      await runWinterCycle(rootId, season, now, { running: async () => false, force: async () => { forced.push(now); } });
      const created = await PelletBoilerCommandModel.find({ rootId }).sort({ _id: 1 }).skip(before).lean();
      // kocioł potwierdza zlecenie (sezon w odczycie zostaje jak w nagraniu)
      await PelletBoilerCommandModel.updateMany({ rootId, status: 'pending' }, { $set: { status: 'done' } });
      const action = created.length ? (created[0].value === 0 ? 'Zima' : 'Lato') : forced.length > forcedBefore ? 'start pompy' : '';
      // serwer zapisuje temperatury z dokładnością 0,1 °C (roundTemperatures), więc reguły sprawdzamy na nich
      decisions.push({ t: reading.t, temp: Math.round(reading.heating_temp * 10) / 10, pump: reading.heating_pump, season, action });
    }
    vi.useRealTimers();

    // zasada na każdym odczycie: Lato ≥ 45 °C → Zima; Zima < 30 °C przy stojącej pompie CO → Lato
    for (const d of decisions) {
      if (d.season === 'summer' && d.temp >= 45) expect(d.action, d.t).toBe('Zima');
      else if (d.season === 'winter' && d.temp < 30 && !d.pump) expect(d.action, d.t).toBe('Lato');
      else expect(['', 'start pompy'], d.t).toContain(d.action);
    }
    // Lato poniżej 45 °C (od 21:01): wymuszenie startu pompy ciepła, najwyżej co 10 min
    expect(forced.length).toBeGreaterThan(0);
    forced.slice(1).forEach((time, i) => expect(time.getTime() - forced[i].getTime()).toBeGreaterThanOrEqual(10 * 60_000));
    expect(decisions.find((d) => d.action === 'start pompy')?.t).toBe('2026-10-04T19:01:12.897Z');
    // Zima: przy pracującej pompie CO kocioł stygnie 39 → 31 °C bez zmiany; pierwsze Lato o 22:44 (28,3 °C, pompa CO stoi).
    // Do 2026-10-07 o 22:39 (29,997 °C); po zaokrągleniu do 0,1 °C to 30,0 °C, czyli jeszcze nie „poniżej 30”.
    expect(decisions.filter((d) => d.season === 'winter' && d.pump).every((d) => d.action === '')).toBe(true);
    expect(decisions.find((d) => d.action === 'Lato')?.t).toBe('2026-10-04T20:44:02.337Z');
  }, 60_000);  // całe nagranie przez API: kilkaset odczytów, dłużej niż domyślne 5 s

  it('zapis bez identycznych odczytów: temperatury 0,1 °C, porównanie 0,5 °C, rekord końcowy przesuwany, okno 10 min', async () => {
    const sn = 'AABBCC000018';
    const { rootId } = (await register(sn)).body;
    const add = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
    const docs = () => PelletBoilerPelux200Model.find({ rootId }).sort({ createdAt: 1 }).lean<Record<string, unknown>[]>();
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-07T10:00:00Z').getTime();
    vi.setSystemTime(t0);

    // zapis z dokładnością 0,1 °C
    await add({ state: 0, heating_temp: 50.90883, water_heater_temp: 40.04 });
    expect((await docs())[0]).toMatchObject({ heating_temp: 50.9, water_heater_temp: 40 });

    // ten sam stan (różnica < 0,5 °C): drugi odczyt to rekord końcowy, trzeci go przesuwa
    vi.setSystemTime(t0 + 60_000);
    await add({ state: 0, heating_temp: 50.93, water_heater_temp: 40.1 });
    vi.setSystemTime(t0 + 120_000);
    await add({ state: 0, heating_temp: 50.95, water_heater_temp: 40.12 });
    let list = await docs();
    expect(list).toHaveLength(2);
    expect(new Date(list[1].createdAt as Date).getTime()).toBe(t0 + 120_000);
    expect(list[1]).toMatchObject({ heating_temp: 51, water_heater_temp: 40.1 });
    // ostatni odczyt ma aktualny czas: kocioł „odpowiada”, aplikacja dostaje najnowsze wartości
    const last = (await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`)).body;
    expect(new Date(last.createdAt).getTime()).toBe(t0 + 120_000);
    expect(last.responding).toBe(true);

    // po 10 min od początku okna rekord końcowy zostaje, a następny identyczny odczyt zakłada nowy
    vi.setSystemTime(t0 + 10 * 60_000 + 1000);
    await add({ state: 0, heating_temp: 50.9, water_heater_temp: 40.1 });
    list = await docs();
    expect(list).toHaveLength(3);
    expect(new Date(list[1].createdAt as Date).getTime()).toBe(t0 + 120_000);

    // zmiana stanu: zawsze nowy rekord
    vi.setSystemTime(t0 + 11 * 60_000);
    await add({ state: 2, heating_temp: 50.9, water_heater_temp: 40.1 });
    expect(await docs()).toHaveLength(4);
    vi.useRealTimers();
  });

  it('dziennik alarmów: czas ecoMAX, pierwsze przesłanie jako historia, alarm trwający i jego koniec', async () => {
    const sn = 'AABBCC000019';
    const { rootId } = (await register(sn)).body;
    const post = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/alerts?deviceId=${sn}`).send(body);
    const list = async () => (await request(app).get(`/api/pellet-boiler-pelux200/alerts?rootId=${rootId}`)).body;
    // sekundy ecoMAX od 2000-01-01, miesiąc 31 dni, rok 12 × 31 dni
    const ecomax = (y: number, m: number, d: number, h: number, mi: number) =>
      ((((y - 2000) * 372 + (m - 1) * 31 + (d - 1)) * 24 + h) * 60 + mi) * 60;
    const stb = { i: 1, code: 19, from: ecomax(2025, 12, 16, 20, 37), to: ecomax(2025, 12, 16, 20, 39) };
    const oldPower = { i: 2, code: 0, from: ecomax(2018, 1, 1, 12, 3), to: ecomax(2018, 1, 1, 12, 48) };

    expect((await post({ total: 2, alerts: [{ i: 0, code: 300, from: 1, to: null }] })).status).toBe(400);
    expect((await post({ total: 2, alerts: [stb, oldPower] })).body).toEqual({ saved: 2, initial: true });
    let view = await list();
    expect(view.alerts).toHaveLength(2);
    // 16.12.2025 20:37 czasu polskiego (zima, UTC+1) = 19:37 UTC
    expect(view.alerts[0]).toMatchObject({ code: 19, from: '2025-12-16T19:37:00.000Z', to: '2025-12-16T19:39:00.000Z',
      active: false, uncertain: false, initial: true });
    expect(view.alerts[1]).toMatchObject({ code: 0, uncertain: true });

    // nowy alarm trwa (brak paliwa, to = null): na górze listy, nie jest historią
    const fuel = { i: 0, code: 8, from: ecomax(2026, 10, 7, 6, 12), to: null };
    expect((await post({ total: 3, alerts: [fuel, stb, oldPower] })).body.initial).toBe(false);
    view = await list();
    expect(view.alerts[0]).toMatchObject({ code: 8, active: true, initial: false, to: null });
    // kafelek listy: same kody aktywnych alarmów, bez całego dziennika
    expect(await listActiveAlertCodes(rootId)).toEqual([8]);
    // koniec alarmu w kolejnym przesłaniu: ten sam wpis (kod + początek), uzupełniony koniec
    await post({ total: 3, alerts: [{ ...fuel, to: ecomax(2026, 10, 7, 7, 0) }, stb, oldPower] }).expect(201);
    view = await list();
    expect(view.alerts).toHaveLength(3);
    expect(view.alerts.find((a: { code: number }) => a.code === 8)).toMatchObject({ active: false, to: '2026-10-07T05:00:00.000Z' });
    expect(await listActiveAlertCodes(rootId)).toEqual([]);
    // liczba aktywnych alarmów w odczycie
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0, alerts_active: 1 }).expect(201);
    expect((await request(app).get(`/api/pellet-boiler-pelux200/last?rootId=${rootId}`)).body.alerts_active).toBe(1);
  });

  it('spalony pellet: przyrosty licznika w godzinach i dniach, stan sprzed okresu, nowy licznik po spadku', async () => {
    const sn = 'AABBCC00001A';
    const { rootId } = (await register(sn)).body;
    const at = (iso: string, fuel_burned_kg: number) => PelletBoilerPelux200Model.create({
      rootId, deviceType: TYPE, deviceId: sn, state: 3, fuel_burned_kg, createdAt: new Date(iso),
    });
    await at('2026-10-06T21:50:00Z', 100);     // 6.10 23:50 w Warszawie: stan sprzed dnia 7.10
    await at('2026-10-06T22:10:00Z', 101.5);   // 7.10 00:10 → +1,5 kg w godzinie 0
    await at('2026-10-07T05:30:00Z', 103);     // 07:30 → +1,5 kg w godzinie 7
    await at('2026-10-07T06:00:00Z', 0.4);     // nowy licznik (spadek) → +0,4 kg w godzinie 8
    await at('2026-10-07T06:30:00Z', 1.2);     // 08:30 → +0,8 kg
    const day = (await request(app).get(`/api/pellet-boiler-pelux200/fuel?rootId=${rootId}&period=day&date=2026-10-07`)).body;
    expect(day.buckets).toHaveLength(24);
    expect(day.buckets[0]).toEqual({ key: 0, kg: 1.5 });
    expect(day.buckets[7].kg).toBe(1.5);
    expect(day.buckets[8].kg).toBe(1.2);
    expect(day.totalKg).toBe(4.2);
    expect(day.counterKg).toBe(1.2);
    const month = (await request(app).get(`/api/pellet-boiler-pelux200/fuel?rootId=${rootId}&period=month&date=2026-10-07`)).body;
    expect(month.buckets).toHaveLength(31);
    expect(month.buckets[6]).toEqual({ key: 7, kg: 4.2 });
    expect(month.buckets[5].kg).toBe(0);  // 6.10: pierwszy odczyt w miesiącu nie ma poprzedniego
    expect((await request(app).get(`/api/pellet-boiler-pelux200/fuel?rootId=${rootId}&period=week&date=2026-10-07`)).status).toBe(400);
  });

  it('powiązanie z pompą ciepła: nowy kocioł bez pompy, walidacja, blokada w trybie pompy, bez pompy tryb Pellet', async () => {
    const sn = 'AABBCC0000F9';
    const { rootId } = (await register(sn)).body;
    const devices = async () => (await request(app).get('/api/devices')).body as { rootId: string; boilerConfig?: { heatPumpRootId: string | null } }[];
    const boiler = async () => (await devices()).find((d) => d.rootId === rootId);
    // nowy kocioł: bez pompy ciepła
    expect((await boiler())?.boilerConfig).toMatchObject({ heatPumpRootId: null });
    const put = (body: object, id = rootId) => request(app).put(`/api/devices/${id}`).send(body);
    const pump = (await register('AABBCC0000FA', 'heat_pump')).body.rootId as string;
    // walidacja: tylko Root ID pompy ciepła, tylko dla kotła
    expect((await put({ boilerConfig: { heatPumpRootId: rootId } })).status).toBe(400);
    expect((await put({ boilerConfig: { heatPumpRootId: 'xyz' } })).status).toBe(400);
    expect((await put({ boilerConfig: { heatPumpRootId: null } }, pump)).status).toBe(400);
    expect((await put({ boilerConfig: { heatPumpRootId: pump } })).status).toBe(200);
    expect((await boiler())?.boilerConfig).toMatchObject({ heatPumpRootId: pump });

    // kocioł w trybie „Pompa ciepła” (nr 99 < 50 °C): odłączenie pompy zablokowane (409)
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0 }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const current = async () => (await request(app).get(`/api/pellet-boiler-pelux200/schedules/current?rootId=${rootId}`)).body;
    expect((await current()).mode).toBe('heat-pump');
    const blocked = await put({ boilerConfig: { heatPumpRootId: null } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/zmień tryb pracy na Pellet/);
    expect((await boiler())?.boilerConfig).toMatchObject({ heatPumpRootId: pump });

    // w trybie Pellet odłączenie przechodzi; gdyby potem ustawiono nr 99 < 50 °C na panelu, kocioł i tak działa jak Pellet
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);
    expect((await put({ boilerConfig: { heatPumpRootId: null } })).status).toBe(200);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    expect((await current()).mode).toBe('pellet');
    expect(await heatPumpRunningInHeatPumpMode(rootId, { running: async () => true, force: async () => {} })).toBeUndefined();

    // kocioł sprzed powiązania (bez boilerConfig) dostaje przy starcie serwera pierwszą pompę ciepła na koncie
    await DeviceModel.updateOne({ _id: rootId }, { $unset: { boilerConfig: 1 } });
    await migrateBoilerDefinitions();
    const first = await DeviceModel.findOne({ deviceType: 'heat_pump' }).sort({ createdAt: 1 }).select('_id').lean();
    expect((await boiler())?.boilerConfig).toMatchObject({ heatPumpRootId: String(first?._id) });
  });

  it('definicja kotła bez połączenia ecoNET300 (wycofane 2026-10-10): dawne pola są pomijane, sterownik ich nie dostaje', async () => {
    const sn = 'AABBCC0000FB';
    const { rootId } = (await register(sn)).body;
    const saved = await request(app).put(`/api/devices/${rootId}`)
      .send({ boilerConfig: { heatPumpRootId: null, connection: 'econet300', econetIp: '192.168.55.20' } });
    expect(saved.status).toBe(200);
    expect(saved.body.boilerConfig).toEqual({ heatPumpRootId: null });
    const reply = { poll_interval_seconds: 60 };
    expect((await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 0 })).body).toEqual(reply);
    expect((await register(sn)).body.settings).toEqual(reply);
  });

  it('praca sprężarki pompy ciepła tylko w trybie pompy ciepła (stan „Praca” w aplikacji)', async () => {
    const sn = 'AABBCC000017';
    const { rootId } = (await registerWithHeatPump(sn, 'AABBCC0000F7')).body;
    await register('AABBCC0000F7', 'heat_pump');
    const pump = (running: boolean | null) => ({ running: async () => running, force: async () => undefined });

    // bez odczytu ustawień nie wiadomo, który tryb: brak
    expect(await heatPumpRunningInHeatPumpMode(rootId, pump(true))).toBeUndefined();
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    expect(await heatPumpRunningInHeatPumpMode(rootId, pump(true))).toBe(true);
    expect(await heatPumpRunningInHeatPumpMode(rootId, pump(false))).toBe(false);
    // pompa bez świeżych danych
    expect(await heatPumpRunningInHeatPumpMode(rootId, pump(null))).toBeUndefined();
    // tryb Pellet (kopia z 3.10)
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archive.raw_hex).expect(201);
    expect(await heatPumpRunningInHeatPumpMode(rootId, pump(true))).toBeUndefined();
  });

  it('przycisk Lato / Zima w trybie pompy ciepła: Zima przez cykl, walidacja', async () => {
    const sn = 'AABBCC000015';
    const { rootId } = (await registerWithHeatPump(sn)).body;
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${rootId}`;
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, heating_temp: 35, heating_pump: false }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const settings = (await request(app).get(api('schedule-settings'))).body;
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: true }).expect(200);

    expect((await request(app).put(api('season')).send({ season: 'jesień' })).status).toBe(400);
    const current = (await request(app).put(api('season')).send({ season: 'winter' }).expect(200)).body;
    expect(current.manualSeason).toBe('winter');
    // kocioł 35 °C: cykl czeka (sezon w kotle z odczytu ustawień; przy Zimie w kotle faza „winter”)
    expect(current.winterCycle).toMatchObject({ temperature: 35 });

    const summer = (await request(app).put(api('season')).send({ season: 'summer' }).expect(200)).body;
    expect(summer.manualSeason).toBe('summer');
    expect(summer.winterCycle).toBeNull();
  });

  it('przycisk Lato / Zima do najbliższej granicy okien sezonu (noc 10–11.10: Zima przy 11,7 °C do 06:00), sezon z harmonogramu wraca do niego', async () => {
    const sn = 'AABBCC00001B';
    const { rootId } = (await registerWithHeatPump(sn)).body;
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${rootId}`;
    const pump = { running: async () => true, force: async () => undefined };
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    const settings = (await request(app).get(api('schedule-settings'))).body;
    await request(app).put(api('schedule-settings')).send({
      ...settings, enabled: true, defaults: { ...settings.defaults, 'heat-pump': { ...settings.defaults['heat-pump'], season: 'summer' } },
    }).expect(200);
    // jak na produkcji: Zima 22:00–06:00 tylko poniżej 10 °C
    await request(app).post(api('schedules')).send({
      type: 'season', mode: 'heat-pump', dayOfWeek: -1, startTime: '22:00', endTime: '06:00', season: 'winter', winterBelow: 10, summerAbove: 10.5,
    }).expect(201);
    const entries = (await request(app).get(api('schedules'))).body;
    expect(nextSeasonBoundary(entries, 'heat-pump', new Date('2026-10-11T10:00:00Z'))?.toISOString()).toBe('2026-10-11T20:00:00.000Z');
    expect(nextSeasonBoundary(entries, 'pellet', new Date('2026-10-11T10:00:00Z'))).toBeNull();

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = async (iso: string) => {
        vi.setSystemTime(new Date(iso));
        await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`)
          .send({ state: 5, heating_temp: 35, heating_pump: true, outside_temp: 11.7 }).expect(201);
      };
      // 22:15: Zima z przycisku (harmonogram: Lato, bo 11,7 °C ≥ 10) — do 06:00
      await at('2026-10-10T20:15:00Z');
      const winter = (await request(app).put(api('season')).send({ season: 'winter' }).expect(200)).body;
      expect(winter).toMatchObject({ manualSeason: 'winter', manualSeasonUntil: '2026-10-11T04:00:00.000Z' });
      await at('2026-10-11T03:59:00Z');
      await applySchedule(rootId, new Date(), pump);
      expect((await request(app).get(api('schedules/current'))).body).toMatchObject({ manualSeason: 'winter', state: { season: 'summer' } });  // state: sezon z samego harmonogramu
      // 06:00: harmonogram przejmuje sezon (Lato poza oknem)
      await at('2026-10-11T04:00:30Z');
      await applySchedule(rootId, new Date(), pump);
      expect((await request(app).get(api('schedules/current'))).body).toMatchObject({ manualSeason: null, manualSeasonUntil: null, state: { season: 'summer' } });

      // Zima o 12:00 (poza oknem) działa do 22:00; Lato (sezon z harmonogramu) wraca do harmonogramu od razu
      await at('2026-10-11T10:00:00Z');
      expect((await request(app).put(api('season')).send({ season: 'winter' }).expect(200)).body.manualSeasonUntil).toBe('2026-10-11T20:00:00.000Z');
      const back = (await request(app).put(api('season')).send({ season: 'summer' }).expect(200)).body;
      expect(back).toMatchObject({ manualSeason: null, state: { season: 'summer' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('„Tryb Zima” z dwoma progami: Zima poniżej, Lato powyżej, między progami bez zmiany', () => {
    const settings = {
      enabled: true, profiles: { 'heat-pump': {}, pellet: {} },
      defaults: { 'heat-pump': { cwuFrom: 35, cwuTo: 40, season: 'summer' as const }, pellet: { cwuFrom: 40, cwuTo: 55 } },
    };
    const entry = {
      _id: 'z1', rootId: 'r', type: 'season' as const, mode: 'heat-pump' as const, enabled: true,
      dayOfWeek: -1, startTime: '00:00', endTime: '23:59', season: 'winter' as const, winterBelow: 5, summerAbove: 7,
    };
    const noon = new Date('2026-10-15T10:00:00Z');
    const at = (outdoor: number | null, last?: string | null) =>
      scheduleState(settings, [entry as never], 'heat-pump', noon, outdoor, last).state.season;
    // wpis jeszcze nie działał: Zima dopiero poniżej 5 °C, przy 6 °C zostaje Lato spoza harmonogramu
    expect(at(4.5)).toBe('winter');
    expect(at(6)).toBe('summer');
    // wpis działał: Zima zostaje do 7 °C włącznie, powyżej wraca Lato
    expect(at(6, 'z1')).toBe('winter');
    expect(at(7, 'z1')).toBe('winter');
    expect(at(7.5, 'z1')).toBe('summer');
    // bez temperatur: Zima przez całe okno
    const plain = { ...entry, winterBelow: null, summerAbove: null };
    expect(scheduleState(settings, [plain as never], 'heat-pump', noon, 20).state.season).toBe('winter');
  });

  it('dawny jeden próg coldBelow: Zima poniżej progu, Lato powyżej progu + 0,5 °C', () => {
    const settings = {
      enabled: true, profiles: { 'heat-pump': {}, pellet: {} },
      defaults: { 'heat-pump': { cwuFrom: 35, cwuTo: 40, season: 'summer' as const }, pellet: { cwuFrom: 40, cwuTo: 55 } },
    };
    const entry = {
      _id: 'w1', rootId: 'r', type: 'season' as const, mode: 'heat-pump' as const, enabled: true,
      dayOfWeek: -1, startTime: '22:00', endTime: '06:00', season: 'winter' as const, coldBelow: 6,
    };
    const night = new Date('2026-10-05T21:00:00Z');  // 23:00 w Warszawie
    const day = new Date('2026-10-05T10:00:00Z');
    const at = (outdoor: number | null, last?: string | null, now = night) =>
      scheduleState(settings, [entry as never], 'heat-pump', now, outdoor, last).state.season;
    expect(at(5)).toBe('winter');
    expect(at(6)).toBe('summer');
    // działający wpis zostaje do 6,5 °C włącznie, powyżej wraca sezon spoza harmonogramu
    expect(at(6.5, 'w1')).toBe('winter');
    expect(at(6.6, 'w1')).toBe('summer');
    // bez temperatury z serwera wpis z progiem nie działa
    expect(at(null)).toBe('summer');
    // poza oknem: sezon spoza harmonogramu
    expect(at(0, null, day)).toBe('summer');
    // bez sezonu w ustawieniach poza harmonogramem: harmonogram sezonem nie steruje
    expect(scheduleState(settings, [], 'pellet', day).state.season).toBeUndefined();
  });

  it('kafelek: przy paleniu początek palenia z pierwszego odczytu z płomieniem, pompy CO / CWU i temperatury mieszaczy', async () => {
    const rootId = (await register('B1C2D3E4F5TL')).body.rootId as string;
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    // postój, potem rozpalanie (2) i praca (3) od 128 min
    await PelletBoilerPelux200Model.collection.insertMany([
      { rootId, state: 5, heating_temp: 40, createdAt: at(200), updatedAt: at(200) },
      { rootId, state: 2, heating_temp: 45, createdAt: at(128), updatedAt: at(128) },
      { rootId, state: 3, heating_temp: 60, createdAt: at(60), updatedAt: at(60) },
      { rootId, state: 3, heating_temp: 67, heating_target: 67, water_heater_temp: 52, fuel_level: 64, boiler_power: 14,
        mixer1_temp: 38.5, mixer2_temp: 41,
        heating_pump: true, water_heater_pump: false, createdAt: at(0.5), updatedAt: at(0.5) },
    ]);
    const tile = await pelletBoilerTile(rootId, {} as never, new Date(now));
    expect(tile?.running).toBe(true);
    expect(new Date(tile!.since!).getTime()).toBe(at(128).getTime());
    expect(tile?.pumps).toEqual([{ label: 'CO', on: true }, { label: 'CWU', on: false }]);
    expect(tile?.main?.label).toBe('kocioł → 67');
    expect(tile?.row).toEqual([
      { icon: 'thermo', value: '38,5 °C', label: 'Mieszacz 1' },
      { icon: 'thermo', value: '41 °C', label: 'Mieszacz 2' },
    ]);
    // postój (inny kocioł): bez czasu palenia
    const idle = (await register('B1C2D3E4F5TM')).body.rootId as string;
    await PelletBoilerPelux200Model.collection.insertOne({ rootId: idle, state: 5, heating_temp: 66, createdAt: at(1), updatedAt: at(1) });
    const idleTile = await pelletBoilerTile(idle, {} as never, new Date(now));
    expect(idleTile?.running).toBe(false);
    expect(idleTile?.since).toBeUndefined();
  });
});
