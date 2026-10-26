// Ładowanie CWU w kotle w trybie pompy ciepła (baza w mongodb-memory-server): pompa ciepła dostaje
// CO i CWU 47–49 °C na czas ładowania (PUT /hp/cwu-loading), wraca do harmonogramu po ładowaniu
// i po wygaśnięciu bez odświeżenia; kocioł wykrywa ładowanie z pompy CWU i trybu, zgłasza je przez API
// (tu: serwer nasłuchuje na losowym porcie, INTERNAL_API_URL); CWU w trybie pompy ciepła najwyżej 45 °C,
// zmiana z panelu wraca do harmonogramu.
import { readFileSync } from 'fs'
import { AddressInfo } from 'net'
import { Server } from 'http'
import { resolve } from 'path'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import app from '../src/core/app'
import { CWU_LOADING_TTL_MS, syncCwuLoading } from '../src/modules/heat-pump/services/cwu-loading.service'
import { getOperationData, replaceOperationData } from '../src/modules/heat-pump/services/operation.service'
import { evaluateCwuLoading } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-cwu-loading.service'
import { applySchedule } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-schedule.service'
import { checkAutoPellet } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-auto-pellet.service'
import { runPelletCwu } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-pellet-cwu.service'
import { runPendingTurnOn } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-turn-on.service'
import { DEFAULT_SCHEDULE_SETTINGS } from '../src/modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-schedule.service'
import { PelletBoilerCommandModel } from '../src/modules/pellet-boiler-pelux200/models/pellet-boiler-pelux200-command.model'

const archiveHeatPump = JSON.parse(readFileSync(resolve(__dirname,
  '../../devices/pellet-boiler-pelux200/docs/ustawienia-kotla-2026-10-04.json'), 'utf-8'));
// warunki z kotła 2026-10-10 (odczyt i ustawienia regulatora z płytki, tryb Pellet)
const today = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/kociol-2026-10-10.json'), 'utf-8'));
const archivePellet = JSON.parse(readFileSync(resolve(__dirname,
  '../../devices/pellet-boiler-pelux200/docs/ustawienia-kotla-2026-10-03.json'), 'utf-8'));

const register = (deviceId: string, deviceType: string) =>
  request(app).post('/api/devices/register').send({ deviceId, deviceType });

describe('Ładowanie CWU (kocioł w trybie pompy ciepła)', () => {
  let mongoServer: MongoMemoryServer;
  let server: Server;
  let pumpRoot: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    server = app.listen(0);
    process.env.INTERNAL_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    pumpRoot = (await register('AABBCC0000A1', 'heat_pump')).body.rootId;
    // operacja z harmonogramu pompy: CO 30–35, CWU 40–45
    replaceOperationData(pumpRoot, { work_mode: 'A', co_min: '30', co_max: '35', cwu_min: '40', cwu_max: '45' });
  });

  afterAll(async () => {
    delete process.env.INTERNAL_API_URL;
    server.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const hp = (path: string) => `/api/hp/${path}?rootId=${pumpRoot}`;
  const operation = () => getOperationData(pumpRoot);

  it('pompa: na czas ładowania CO i CWU 47–49 °C, po ładowaniu wraca harmonogram', async () => {
    expect((await request(app).put(hp('cwu-loading')).send({ active: 'tak' })).status).toBe(400);

    const on = await request(app).put(hp('cwu-loading')).send({ active: true, since: '2026-10-04T12:00:00Z' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ active: true, since: '2026-10-04T12:00:00.000Z', pumpOff: false });
    expect(operation()).toMatchObject({ work_mode: 'A', co_min: '47', co_max: '49', cwu_min: '47', cwu_max: '49' });
    // ponowne zgłoszenie nie przesuwa początku
    await request(app).put(hp('cwu-loading')).send({ active: true, since: '2026-10-04T12:05:00Z' }).expect(200);
    expect((await request(app).get(hp('cwu-loading'))).body.since).toBe('2026-10-04T12:00:00.000Z');

    const off = await request(app).put(hp('cwu-loading')).send({ active: false });
    expect(off.body).toMatchObject({ active: false, since: null });
    expect(operation()).toMatchObject({ co_min: '30', co_max: '35', cwu_min: '40', cwu_max: '45' });
  });

  it('pompa: ładowanie bez odświeżenia wygasa, pompa w trybie OFF jest zgłaszana', async () => {
    await request(app).put(hp('cwu-loading')).send({ active: true }).expect(200);
    expect(await syncCwuLoading(pumpRoot, new Date(Date.now() + CWU_LOADING_TTL_MS + 1000))).toBe(false);
    expect(operation().co_max).toBe('35');

    replaceOperationData(pumpRoot, { work_mode: 'OFF', co_min: '30', co_max: '35', cwu_min: '40', cwu_max: '45' });
    expect((await request(app).put(hp('cwu-loading')).send({ active: true })).body.pumpOff).toBe(true);
    await request(app).put(hp('cwu-loading')).send({ active: false }).expect(200);
    replaceOperationData(pumpRoot, { work_mode: 'A', co_min: '30', co_max: '35', cwu_min: '40', cwu_max: '45' });
  });

  it('kocioł: ładowanie = tryb pompy ciepła i pompa CWU, zgłaszane pompie przez API', async () => {
    const sn = 'AABBCC0000B1';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const reading = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
    const boiler = () => request(app).get(`/api/pellet-boiler-pelux200/cwu-loading?rootId=${boilerRoot}`);

    // tryb pompy ciepła (minimum kotła 30): pompa CWU pracuje → ładowanie
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    await reading({ state: 5, water_heater_pump: true, water_heater_temp: 38 });
    const loading = await evaluateCwuLoading(boilerRoot);
    expect(loading).toMatchObject({ active: true, heatPumpOff: false });
    expect(operation().cwu_max).toBe('49');
    expect((await boiler()).body.active).toBe(true);

    // pompa CWU staje → koniec ładowania, pompa ciepła wraca do harmonogramu
    await reading({ state: 5, water_heater_pump: false, water_heater_temp: 44 });
    expect((await evaluateCwuLoading(boilerRoot)).active).toBe(false);
    expect(operation().cwu_max).toBe('45');

    // tryb Pellet (minimum 65): pompa CWU to zwykłe ładowanie z kotła, pompa ciepła bez zmian
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archivePellet.raw_hex).expect(201);
    await reading({ state: 3, water_heater_pump: true });
    expect((await evaluateCwuLoading(boilerRoot)).active).toBe(false);
    expect(operation().cwu_max).toBe('45');
  });

  it('rozpalanie w trybie pompy ciepła: nastawy Pellet bez wyłączania, komunikat do „OK”', async () => {
    const sn = 'AABBCC0000B3';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const reading = (state: number) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state }).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);

    const commands = async () => ((await request(app).get(api('commands'))).body as
      { kind: string; mixer?: number; index: number; value: number }[]).reverse();
    const settle = () => new Promise((done) => setTimeout(done, 300));

    // postój w trybie pompy ciepła: nic (sprawdzenie idzie samo po każdym odczycie)
    await reading(5);
    await settle();
    expect(await commands()).toEqual([]);

    // rozpalanie: zadana przed minimum (kotła i mieszacza), bez „wyłącz”
    await reading(2);
    await settle();
    const changes = await commands();
    const keys = changes.map((c) => `${c.kind}${c.mixer ?? ''}:${c.index}=${c.value}`);
    expect(keys.indexOf('ecomax:98=67')).toBeLessThan(keys.indexOf('ecomax:99=65'));
    expect(keys.indexOf('mixer1:0=40')).toBeLessThan(keys.indexOf('mixer1:1=40'));
    expect(keys).toContain('ecomax:17=12');
    expect(changes.some((c) => c.kind === 'control')).toBe(false);
    const pellet = (await request(app).get(api('auto-pellet'))).body;
    expect(pellet).toMatchObject({ acknowledged: false, changes: changes.length });

    // do „OK” nie powtarza; po „OK” komunikat znika
    expect(await checkAutoPellet(boilerRoot)).toBeNull();
    await request(app).post(api('auto-pellet/ack')).expect(200);
    expect((await request(app).get(api('auto-pellet'))).body).toBeNull();
  });

  it('tryb pompy ciepła: CWU najwyżej 45 °C, zmiana z panelu wraca do harmonogramu', async () => {
    const sn = 'AABBCC0000B2';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const base = { dayOfWeek: -1, startTime: '05:00', endTime: '06:00' };
    expect((await request(app).post(api('schedules')).send({ ...base, mode: 'heat-pump', cwuFrom: 40, cwuTo: 46 })).status).toBe(400);
    await request(app).post(api('schedules')).send({ ...base, mode: 'heat-pump', cwuFrom: 40, cwuTo: 45 }).expect(201);
    await request(app).post(api('schedules')).send({ ...base, mode: 'pellet', cwuFrom: 40, cwuTo: 60 }).expect(201);
    const settings = (await request(app).get(api('schedule-settings'))).body;
    const defaults = { ...settings.defaults, 'heat-pump': { cwuFrom: 40, cwuTo: 50 } };
    expect((await request(app).put(api('schedule-settings')).send({ ...settings, defaults })).status).toBe(400);

    // harmonogram działa, tryb pompy ciepła; poza oknem CWU 35–40 = 40 / 5, jak w kopii ustawień — nic
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: true }).expect(200);
    await applySchedule(boilerRoot, new Date('2026-10-05T10:00:00Z'));
    const commands = async () => (await request(app).get(api('commands'))).body as { index: number; value: number }[];
    expect(await commands()).toEqual([]);

    // ktoś ustawił na panelu CWU 50 (odczyt kotła): harmonogram przywraca 40
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, water_heater_target: 50 }).expect(201);
    await applySchedule(boilerRoot, new Date('2026-10-05T10:01:00Z'));
    expect((await commands()).map((c) => [c.index, c.value])).toEqual([[119, 40]]);
  });

  it('CWU „bez zmiany” poza harmonogramem: bez nr 119/123 i bez przywracania, wpis działa, ostrzeżenie o zadanej wyższej niż pompa ciepła', async () => {
    const sn = 'AABBCC0000B7';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    // własna pompa ciepła (telemetria nie miesza się z innymi testami)
    const pump = (await register('AABBCC0000A7', 'heat_pump')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pump } }).expect(200);
    const pumpTelemetry = (workMode: string, tempMax: string) => request(app).post(`/api/hp/add?rootId=${pump}&deviceId=AABBCC0000A7`)
      .send({ work_mode: workMode, temp_min: '40', temp_max: tempMax, HP: { Ttarget: 40, Tmax: Number(tempMax), HPS: 0 } }).expect(201);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const commands = async () => ((await request(app).get(api('commands'))).body as { index: number; value: number }[])
      .map((c) => `${c.index}=${c.value}`).sort();
    await request(app).post(api('schedules')).send({ mode: 'heat-pump', dayOfWeek: -1, startTime: '05:00', endTime: '06:00', cwuFrom: 40, cwuTo: 43 }).expect(201);
    const settings = (await request(app).get(api('schedule-settings'))).body;
    const unchanged = (value: unknown) => ({ ...settings, enabled: true, defaults: { ...settings.defaults, 'heat-pump': { cwuFrom: 35, cwuTo: 40, cwuUnchanged: value } } });
    expect((await request(app).put(api('schedule-settings')).send(unchanged('tak'))).status).toBe(400);

    // tryb pompy ciepła (kopia 4.10: CWU 40 / 5), na panelu CWU 50: poza wpisem nic nie wraca
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send({ state: 5, water_heater_target: 50 }).expect(201);
    const saved = await request(app).put(api('schedule-settings')).send(unchanged(true)).expect(200);
    expect(saved.body.defaults['heat-pump']).toEqual({ cwuFrom: 35, cwuTo: 40, cwuUnchanged: true });
    await applySchedule(boilerRoot, new Date('2026-10-05T10:00:00Z'));
    await applySchedule(boilerRoot, new Date('2026-10-05T10:10:00Z'));
    expect(await commands()).toEqual([]);
    const current = (await request(app).get(api('schedules/current'))).body;
    // bez telemetrii pompy: nie wiadomo, do ilu grzeje — bez ostrzeżenia
    expect(current).toMatchObject({ mode: 'heat-pump', scheduleId: null, cwuTooHigh: false, heatPumpCwuMax: null, boilerCwu: { cwuFrom: 45, cwuTo: 50 } });
    expect(current.state.cwuUnchanged).toBe(true);
    const tooHigh = async () => {
      const body = (await request(app).get(api('schedules/current'))).body;
      return [body.cwuTooHigh, body.heatPumpCwuMax];
    };
    // pompa włączona, grzeje do 45 °C: zadana 50 jest za wysoka; do 50 °C: nie
    await pumpTelemetry('AUTO', '45');
    expect(await tooHigh()).toEqual([true, 45]);
    await pumpTelemetry('AUTO', '50');
    expect(await tooHigh()).toEqual([false, 50]);
    // pompa wyłączona (OFF) albo offline (telemetria starsza niż 5 min): bez ostrzeżenia
    await pumpTelemetry('OFF', '45');
    expect(await tooHigh()).toEqual([false, null]);
    await pumpTelemetry('AUTO', '45');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    try {
      expect(await tooHigh()).toEqual([false, null]);
    } finally {
      vi.useRealTimers();
    }
    expect(await tooHigh()).toEqual([true, 45]);

    // wpis 05:00–06:00 działa jak dotąd (CWU 43 / 3); po nim zostaje, nic nie wraca
    await applySchedule(boilerRoot, new Date('2026-10-06T03:30:00Z'));
    expect(await commands()).toEqual(['119=43', '123=3']);
    await applySchedule(boilerRoot, new Date('2026-10-06T04:30:00Z'));
    expect(await commands()).toEqual(['119=43', '123=3']);

    // „CWU - grzanie peletem” przy Pellet „bez zmiany”: progi z kotła (do = zadana 50, od = 50 − histereza 5)
    const now = (await request(app).get(api('schedule-settings'))).body;
    await request(app).put(api('schedule-settings')).send({ ...now, defaults: { ...now.defaults, pellet: { cwuFrom: 40, cwuTo: 55, cwuUnchanged: true } } }).expect(200);
    const on = await request(app).put(api('pellet-cwu')).send({ enabled: true });
    expect(on.body.pelletCwu).toMatchObject({ enabled: true, cwuFrom: 45, cwuTo: 50 });
    // z „grzaniem peletem” wysoka zadana jest zamierzona: bez ostrzeżenia
    expect((await request(app).get(api('schedules/current'))).body.cwuTooHigh).toBe(false);
  });

  it('CWU z peletu w trybie pompy ciepła: zadana kotła trybu Pellet do nagrzania CWU, pompa ciepła wstrzymana do kotła < 50 °C (próg 52 °C)', async () => {
    const sn = 'AABBCC0000B4';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const reading = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
    const pending = async () => ((await request(app).get(api('commands'))).body as { index: number; value: number; status: string }[])
      .filter((c) => c.status === 'pending').map((c) => `${c.index}=${c.value}`).sort();
    const step = async (now = new Date()) => {
      await runPelletCwu(boilerRoot, now);
      await evaluateCwuLoading(boilerRoot, now);
      return (await request(app).get(api('schedules/current'))).body.pelletCwu;
    };
    const finishAll = () => PelletBoilerCommandModel.updateMany({ rootId: boilerRoot, status: 'pending' }, { $set: { status: 'done' } });
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);

    // znacznik: walidacja; harmonogram zleca CWU z trybu Pellet (40–55 = 55 / 15), a nie pompy ciepła (35–40)
    expect((await request(app).put(api('pellet-cwu')).send({ enabled: 'tak' })).status).toBe(400);
    const settings = (await request(app).get(api('schedule-settings'))).body;
    await request(app).put(api('schedule-settings')).send({ ...settings, enabled: true }).expect(200);
    await reading({ state: 5, water_heater_temp: 45, heating_temp: 32 });
    const on = await request(app).put(api('pellet-cwu')).send({ enabled: true });
    expect(on.body.pelletCwu).toMatchObject({ enabled: true, phase: 'idle', cwuFrom: 40, cwuTo: 55 });
    expect(await pending()).toEqual(['119=55', '123=15']);
    await finishAll();
    // zakładka Harmonogram: „Teraz” i działający wpis CWU z listy Pellet, tak jak zleca scheduler (do 2026-10-20 lista pompy)
    expect((await request(app).get(api('schedules/current'))).body).toMatchObject({
      mode: 'heat-pump', state: { mode: 'heat-pump', cwuFrom: 40, cwuTo: 55, pelletCwu: true },
    });

    // CWU 38 < 40: kocioł dostaje nastawy trybu Pellet 98, 99, 17, 101 (67 / 65 / 12 / 50), dalej tryb pompy ciepła
    await reading({ state: 5, water_heater_temp: 38, heating_temp: 32 });
    expect(await step()).toMatchObject({ phase: 'heating', error: null });
    expect(await pending()).toEqual(['101=50', '17=12', '98=67', '99=65']);
    await finishAll();
    // pompa ciepła wstrzymana, nie ładuje CWU; rozpalanie nie przełącza kotła na Pellet
    expect(operation()).toMatchObject({ work_mode: 'OFF', force: '0' });
    expect((await request(app).get(hp('cwu-loading'))).body).toMatchObject({ active: false, pelletBlock: true });
    await reading({ state: 2, water_heater_temp: 39, heating_temp: 40, water_heater_pump: true });
    await new Promise((done) => setTimeout(done, 300));
    expect(await checkAutoPellet(boilerRoot)).toBeNull();
    expect(await pending()).toEqual([]);

    // zadana CWU w kotle 52 °C (niższa niż „do” 55): koniec grzania na zadanej, nie na „do”
    await reading({ state: 3, water_heater_temp: 51, water_heater_target: 52, heating_temp: 64 });
    expect(await step()).toMatchObject({ phase: 'heating', cwuTo: 55, cwuEnd: 52 });
    // CWU 52: nastawy pompy ciepła wracają, pompa ciepła czeka na kocioł < 50 °C
    await reading({ state: 3, water_heater_temp: 52, water_heater_target: 52, heating_temp: 66 });
    expect(await step()).toMatchObject({ phase: 'cooling', error: null });
    expect(await pending()).toEqual(['101=30', '17=20', '98=30', '99=30']);
    await finishAll();
    await reading({ state: 7, water_heater_temp: 54, heating_temp: 52 });
    expect((await step()).phase).toBe('cooling');
    expect(operation().work_mode).toBe('OFF');
    // cykl kończy się poniżej 52 °C, a ogólna zasada (kocioł gorący) zwalnia pompę dopiero poniżej 50 °C
    await reading({ state: 5, water_heater_temp: 54, heating_temp: 51 });
    expect((await step()).phase).toBe('idle');
    expect(operation().work_mode).toBe('OFF');
    await reading({ state: 5, water_heater_temp: 54, heating_temp: 49 });
    await step();
    expect(operation()).toMatchObject({ work_mode: 'A' });
    expect((await request(app).get(hp('cwu-loading'))).body.pelletBlock).toBe(false);

    // kocioł nie rozpala się przez 30 min: koniec z błędem i powrót nastaw
    await reading({ state: 5, water_heater_temp: 38, heating_temp: 45 });
    await step();
    await finishAll();
    const late = await step(new Date(Date.now() + 31 * 60_000));
    expect(late).toMatchObject({ phase: 'cooling' });
    expect(late.error).toMatch(/nie rozpalił się/);
    expect(await pending()).toEqual(['101=30', '17=20', '98=30', '99=30']);
    await finishAll();

    // odznaczenie: bez nowego grzania; pompa ciepła wraca po ostygnięciu kotła
    await request(app).put(api('pellet-cwu')).send({ enabled: false }).expect(200);
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 40 });
    expect(await step()).toMatchObject({ enabled: false, phase: 'idle' });
    expect(operation().work_mode).toBe('A');

    // zasada bezpieczeństwa bez znacznika: rozpalanie albo kocioł ≥ 52 °C wstrzymuje pompę, rusza poniżej 50 °C
    await reading({ state: 2, water_heater_temp: 30, heating_temp: 35 });
    await evaluateCwuLoading(boilerRoot);
    expect(operation().work_mode).toBe('OFF');
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 51 });
    expect((await evaluateCwuLoading(boilerRoot)).pumpBlocked).toBe(true);
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 47.5 });
    expect((await evaluateCwuLoading(boilerRoot)).pumpBlocked).toBe(false);
    expect(operation().work_mode).toBe('A');

    // próg stały (od 2026-10-13): 52 °C, start poniżej 50 °C; pompa podaje go kotłu w odpowiedzi na zgłoszenie
    expect((await request(app).get(hp('cwu-loading'))).body).toMatchObject({ blockFrom: 52, resumeBelow: 50 });
    await request(app).put(hp('boiler-block')).send({ temperature: 55 }).expect(404);
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 51 });
    expect(await evaluateCwuLoading(boilerRoot)).toMatchObject({ pumpBlocked: false, hotBoilerFrom: 52 });
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 52 });
    expect((await evaluateCwuLoading(boilerRoot)).pumpBlocked).toBe(true);
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 50.5 });
    expect((await evaluateCwuLoading(boilerRoot)).pumpBlocked).toBe(true);
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 49.5 });
    expect((await evaluateCwuLoading(boilerRoot)).pumpBlocked).toBe(false);
    expect(operation().work_mode).toBe('A');
    // harmonogram wraca do CWU pompy ciepła (35–40; odczyt ustawień w teście ma już 40 / 5, więc bez zleceń)
    expect((await request(app).get(api('schedule-settings'))).body.lastApplied).toMatchObject({ cwuFrom: 35, cwuTo: 40 });
  });

  it('CWU z peletu po nocy 12/13.10: bez startu przy CWU wyłączonym (nr 122), nastawy 98/99/17/101 w kolejności, tryb Pompa ciepła mimo 99 = 65', async () => {
    const sn = 'AABBCC0000B8';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const reading = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
    // odczyt ustawień z 4.10 (tryb pompy ciepła) z podmienionymi parametrami kotła (bajt 3 + 3 × nr)
    const boilerSettings = (values: Record<number, number>) => {
      const ecomax = Buffer.from(archiveHeatPump.raw_hex.ecomax_parameters, 'hex');
      for (const [index, value] of Object.entries(values)) ecomax[3 + 3 * Number(index)] = value;
      return request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`)
        .send({ ...archiveHeatPump.raw_hex, ecomax_parameters: ecomax.toString('hex') }).expect(201);
    };
    // zlecenia nastaw kotła w kolejności utworzenia (od ostatniego wywołania)
    let seen = 0;
    const boilerCommands = async () => {
      const all = await PelletBoilerCommandModel.find({ rootId: boilerRoot, index: { $in: [98, 99, 17, 101] } }).sort({ createdAt: 1, _id: 1 }).lean();
      const fresh = all.slice(seen).map((c) => `${c.index}=${c.value}`);
      seen = all.length;
      return fresh;
    };
    const finishAll = () => PelletBoilerCommandModel.updateMany({ rootId: boilerRoot, status: 'pending' }, { $set: { status: 'done' } });
    const mode = async () => (await request(app).get(api('schedules/current'))).body.mode;

    // CWU wyłączone w kotle (nr 122 = 0): cykl nie startuje przy zimnej CWU i nie włącza CWU sam
    await boilerSettings({ 99: 30, 122: 0 });
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 32 });
    await request(app).put(api('pellet-cwu')).send({ enabled: true }).expect(200);
    expect((await runPelletCwu(boilerRoot)).phase).toBe('idle');
    expect(await boilerCommands()).toEqual([]);
    expect(await PelletBoilerCommandModel.exists({ rootId: boilerRoot, index: 122 })).toBeNull();

    // CWU włączone: start z nastawami Pellet w kolejności 98 → 99 → 17 → 101
    await boilerSettings({ 99: 30, 122: 1 });
    expect((await runPelletCwu(boilerRoot)).phase).toBe('heating');
    expect(await boilerCommands()).toEqual(['98=67', '99=65', '17=12', '101=50']);
    await finishAll();
    // kocioł z nastawami Pellet (99 = 65) w trakcie cyklu nadal jest w trybie Pompa ciepła
    await boilerSettings({ 99: 65, 122: 1 });
    expect(await mode()).toBe('heat-pump');

    // CWU wyłączone w trakcie: koniec bez błędu, powrót nastaw Pompy ciepła w kolejności 99 → 98 → 17 → 101
    await boilerSettings({ 99: 65, 122: 0 });
    expect(await runPelletCwu(boilerRoot)).toMatchObject({ phase: 'cooling', error: null });
    expect(await boilerCommands()).toEqual(['99=30', '98=30', '17=20', '101=30']);
    await finishAll();

    // nowy cykl (kocioł ostygł), w jego trakcie użytkownik wybiera Pellet (nr 99 z aplikacji): koniec bez przywracania
    await boilerSettings({ 99: 30, 122: 1 });
    await reading({ state: 5, water_heater_temp: 30, heating_temp: 40 });
    expect((await runPelletCwu(boilerRoot)).phase).toBe('idle');
    expect((await runPelletCwu(boilerRoot)).phase).toBe('heating');
    await boilerCommands();
    await finishAll();
    await boilerSettings({ 99: 65, 122: 1 });
    expect(await mode()).toBe('heat-pump');
    await request(app).post(api('commands')).send({ changes: [{ kind: 'ecomax', index: 99, value: 65 }], reason: 'Przycisk „Pellet” w Trybie pracy' }).expect(201);
    expect((await request(app).get(api('schedules/current'))).body.pelletCwu.phase).toBe('idle');
    expect(await mode()).toBe('pellet');
    await runPelletCwu(boilerRoot);
    expect(await boilerCommands()).toEqual(['99=65']);
  });

  // Produkcja 2026-10-21: CWU spadła dokładnie do „od” (50 − 20 = 30,0 °C), regulator sam zaczął ładowanie (pompa CWU)
  // i rozpalił kocioł, zanim cykl CWU z peletu wystartował (warunek „< od”); automatyczne przejście przełączyło kocioł
  // na stałe na Pellet. Teraz: start cyklu przy CWU = „od” albo przy pracującej pompie CWU, rozpalenie zostaje w trybie
  // pompy ciepła, a po nagrzaniu wracają nastawy pompy ciepła.
  it('CWU z peletu: regulator sam ładuje CWU na progu „od” — cykl zamiast przejścia na Pellet, potem nastawy pompy ciepła', async () => {
    const setup = async (sn: string) => {
      const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
      await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
      const ecomax = Buffer.from(archiveHeatPump.raw_hex.ecomax_parameters, 'hex');
      ecomax[3 + 3 * 99] = 30;
      ecomax[3 + 3 * 122] = 1;
      await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`)
        .send({ ...archiveHeatPump.raw_hex, ecomax_parameters: ecomax.toString('hex') }).expect(201);
      const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
      const reading = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
      // ciepła woda: cykl stoi, odczyt progów „od” / „do” trybu Pellet
      await reading({ state: 5, water_heater_temp: 60, heating_temp: 38, water_heater_pump: false });
      await request(app).put(api('pellet-cwu')).send({ enabled: true }).expect(200);
      const idle = await runPelletCwu(boilerRoot);
      expect(idle.phase).toBe('idle');
      return { boilerRoot, api, reading, from: idle.cwuFrom as number, to: idle.cwuEnd as number };
    };
    const settle = () => new Promise((done) => setTimeout(done, 300));
    const commands = (rootId: string) => PelletBoilerCommandModel.find({ rootId }).sort({ createdAt: 1, _id: 1 }).lean();

    // 1. CWU równa „od”, pompa CWU jeszcze stoi: cykl startuje (dawniej dopiero poniżej „od”)
    const a = await setup('AABBCC0000C1');
    await a.reading({ state: 5, water_heater_temp: a.from, heating_temp: 38, water_heater_pump: false });
    expect((await runPelletCwu(a.boilerRoot)).phase).toBe('heating');

    // 2. poranek 21.10: pompa CWU pracuje (regulator ładuje), potem rozpalenie przed krokiem schedulera
    const b = await setup('AABBCC0000C2');
    await b.reading({ state: 5, water_heater_temp: b.from + 0.5, heating_temp: 37, water_heater_pump: true });
    await settle();
    await b.reading({ state: 2, water_heater_temp: b.from + 0.5, heating_temp: 35, water_heater_pump: true });
    await settle();
    // bez przejścia na Pellet: brak komunikatu, cykl CWU z peletu trwa, tryb nadal Pompa ciepła
    expect((await request(app).get(b.api('auto-pellet'))).body).toBeNull();
    const current = (await request(app).get(b.api('schedules/current'))).body;
    expect(current.pelletCwu.phase).toBe('heating');
    expect(current.mode).toBe('heat-pump');
    // zlecenia: nastawy kotła cyklu (98, 99, 17, 101), bez mieszacza i bez nr 122 z pełnego profilu Pellet
    // (119 / 123 to CWU trybu Pellet z harmonogramu po zaznaczeniu znacznika)
    const started = await commands(b.boilerRoot);
    const keys = started.map((c) => `${c.kind}:${c.index}=${c.value}`);
    expect(keys.filter((k) => /^ecomax:(98|99|17|101)=/.test(k))).toEqual(['ecomax:98=67', 'ecomax:99=65', 'ecomax:17=12', 'ecomax:101=50']);
    expect(keys.some((k) => k.startsWith('mixer') || k.startsWith('ecomax:122='))).toBe(false);
    await PelletBoilerCommandModel.updateMany({ rootId: b.boilerRoot, status: 'pending' }, { $set: { status: 'done' } });

    // woda nagrzana do celu: wracają nastawy pompy ciepła, faza stygnięcia
    await b.reading({ state: 3, water_heater_temp: b.to, heating_temp: 60, water_heater_pump: true });
    expect((await runPelletCwu(b.boilerRoot)).phase).toBe('cooling');
    const back = (await commands(b.boilerRoot)).slice(started.length).map((c) => `${c.index}=${c.value}`);
    expect(back).toEqual(['99=30', '98=30', '17=20', '101=30']);
    expect((await request(app).get(b.api('auto-pellet'))).body).toBeNull();
  });

  it('„Włącz regulator” w trybie pompy ciepła: blokada, gdy kocioł rozpaliłby się na pellecie; włączenie po nagrzaniu', async () => {
    const sn = 'AABBCC0000B5';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const reading = (body: object) => request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(body).expect(201);
    const controls = async () => ((await request(app).get(api('commands'))).body as { kind: string; value: number }[]).filter((c) => c.kind === 'control');
    // warunki z kotła 2026-10-10 (fixture): tryb Pellet, kocioł 16,8 °C, CWU 21,3 °C, CWU 50 / 15, podwyższenie 5
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(today.raw_hex).expect(201);
    await reading(today.odczyt);
    // w trybie Pellet włączenie jest dozwolone
    expect((await request(app).get(api('turn-on'))).body).toMatchObject({ mode: 'pellet', blocked: false });
    // przełączenie na Pompę ciepła z włączeniem na końcu: zadana 30 → CWU podnosi do 55, histereza 20 → rozpali się
    // poniżej 35 °C — odrzucone w całości (nastawy też nie idą)
    const heatPumpProfile = Object.entries(DEFAULT_SCHEDULE_SETTINGS.profiles['heat-pump']).map(([key, value]) => {
      const [kind, index] = key.split(':');
      return kind === 'ecomax' ? { kind, index: Number(index), value } : { kind: 'mixer', mixer: Number(kind.slice(5)), index: Number(index), value };
    });
    const switchOn = await request(app).post(api('commands')).send({ changes: [...heatPumpProfile, { kind: 'control', index: 0, value: 1 }] });
    expect(switchOn.status).toBe(409);
    expect(switchOn.body.turnOn).toMatchObject({ mode: 'heat-pump', ignites: true, cause: 'cwu', target: 55, startBelow: 35, cwuStartBelow: 35 });
    expect(switchOn.body.message).toMatch(/Zbyt niska temperatura kotła/);
    expect((await request(app).get(api('commands'))).body).toEqual([]);

    // kopia z 4.10 (tryb pompy ciepła: zadana 30, histereza 30, CWU 40 / 5): CWU czeka → zadana 45, rozpalenie poniżej 15 °C
    await request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(archiveHeatPump.raw_hex).expect(201);
    await reading({ state: 0, heating_temp: 10, water_heater_temp: 21 });
    const check = (await request(app).get(api('turn-on'))).body;
    expect(check).toMatchObject({ mode: 'heat-pump', ignites: true, cause: 'cwu', blocked: true, target: 45, startBelow: 15 });
    const refused = await request(app).post(api('commands')).send({ changes: [{ kind: 'control', index: 0, value: 1 }] });
    expect(refused.status).toBe(409);
    expect(await controls()).toEqual([]);

    // „Uruchom pompę ciepła”: pompa z OFF na ręczny, kocioł czeka na nagrzanie
    const pumpProps = `/api/device/properties?rootId=${pumpRoot}`;
    const props = (await request(app).get(pumpProps)).body;
    await request(app).put(pumpProps).send({ ...props, work_mode: 'OFF' }).expect(200);
    const pending = await request(app).post(api('turn-on')).send({ action: 'start-heat-pump' });
    expect(pending.body).toMatchObject({ startBelow: 47, heatPumpStarted: true });
    expect((await request(app).get(pumpProps)).body.work_mode).toBe('MANUAL');
    expect((await runPendingTurnOn(boilerRoot))?.startBelow).toBe(47);
    expect(await controls()).toEqual([]);
    // czekanie: pompa ciepła grzeje 47–49 °C
    await evaluateCwuLoading(boilerRoot);
    expect(operation()).toMatchObject({ co_max: '49', cwu_max: '49' });
    // kocioł ponad progiem rozpalenia, ale poniżej 47 °C: nadal czeka (ładowanie CWU wychłodziłoby wodę)
    await reading({ state: 0, heating_temp: 30, water_heater_temp: 21 });
    expect((await runPendingTurnOn(boilerRoot))?.startBelow).toBe(47);
    expect(await controls()).toEqual([]);

    // kocioł nagrzany przez pompę ciepła do 47 °C: włączenie idzie samo, czekanie znika
    await reading({ state: 0, heating_temp: 47, water_heater_temp: 21 });
    expect(await runPendingTurnOn(boilerRoot)).toBeNull();
    expect((await controls()).map((c) => c.value)).toEqual([1]);
    expect((await request(app).get(api('schedules/current'))).body.pendingTurnOn).toBeNull();

    // CWU z peletu: rozpalenie na CWU jest zamierzone — bez blokady
    await reading({ state: 0, heating_temp: 17, water_heater_temp: 21 });
    await request(app).put(api('pellet-cwu')).send({ enabled: true }).expect(200);
    expect((await request(app).get(api('turn-on'))).body.blocked).toBe(false);
    expect((await request(app).post(api('turn-on')).send({ action: 'nie' })).status).toBe(400);
  });

  it('harmonogram zatrzymany: zmiana trybu i znacznika „Grzej CWU peletem” od razu ustawia CWU bieżącego harmonogramu', async () => {
    const sn = 'AABBCC0000B6';
    const boilerRoot = (await register(sn, 'pellet-boiler-pelux200')).body.rootId;
    await request(app).put(`/api/devices/${boilerRoot}`).send({ boilerConfig: { heatPumpRootId: pumpRoot } }).expect(200);
    const api = (path: string) => `/api/pellet-boiler-pelux200/${path}?rootId=${boilerRoot}`;
    const settingsFrom = (hex: Record<string, string>) =>
      request(app).post(`/api/pellet-boiler-pelux200/settings?deviceId=${sn}`).send(hex).expect(201);
    const pending = async () => ((await request(app).get(api('commands'))).body as { index: number; value: number; status: string }[])
      .filter((c) => c.status === 'pending').map((c) => `${c.index}=${c.value}`).sort();
    const finishAll = () => PelletBoilerCommandModel.updateMany({ rootId: boilerRoot, status: 'pending' }, { $set: { status: 'done' } });
    // kocioł z 2026-10-10 (Pellet, CWU 50 / 15), harmonogram zatrzymany, regulator wyłączony
    await request(app).post(`/api/pellet-boiler-pelux200/add?deviceId=${sn}`).send(today.odczyt).expect(201);
    await settingsFrom(today.raw_hex);
    expect((await request(app).get(api('schedule-settings'))).body.enabled).toBe(false);
    // pierwszy przebieg: CWU trybu Pellet (poza harmonogramem 40–55 = 55 / 15; histereza 15 już jest)
    await applySchedule(boilerRoot);
    expect(await pending()).toEqual(['119=55']);
    await finishAll();
    // bez zmiany trybu: nic więcej
    await applySchedule(boilerRoot);
    expect(await pending()).toEqual([]);

    // przełączenie na Pompę ciepła (minimum kotła 30 w odczycie ustawień): CWU trybu pompy ciepła 35–40 = 40 / 5
    // i Lato, bo Zima z trybu Pellet bez cyklu Zimy wychładzałaby wodę z pompy ciepła (2026-10-24)
    const ecomax = Buffer.from(today.raw_hex.ecomax_parameters, 'hex');
    ecomax[3 + 3 * 99] = 30;
    ecomax[3 + 3 * 125] = 0;
    await settingsFrom({ ...today.raw_hex, ecomax_parameters: ecomax.toString('hex') });
    await applySchedule(boilerRoot);
    expect(await pending()).toEqual(['119=40', '123=5', '125=1']);
    await finishAll();

    // „Grzej CWU peletem” przy zatrzymanym harmonogramie: CWU z trybu Pellet od razu; regulator wyłączony — cykl nie rusza
    const on = (await request(app).put(api('pellet-cwu')).send({ enabled: true })).body;
    expect(on.pelletCwu).toMatchObject({ enabled: true, phase: 'idle' });
    // odczyt ustawień w teście ma nadal CWU 50 / 15
    expect(await pending()).toEqual(['119=55']);
    await finishAll();
    await request(app).put(api('pellet-cwu')).send({ enabled: false }).expect(200);
    expect(await pending()).toEqual(['119=40', '123=5']);
  });
});
