// Testy API wspólnego i telemetrii pompy (supertest na core/app, baza w
// mongodb-memory-server, meteo zamockowane): ostatnia telemetria, zapis EEVmin,
// zdarzenia błędów CHPC (okno 24 h, blokada ERRc >= 5), akcje jednorazowe,
// zgłoszenie i zmiana nazwy sterownika, t_out w odpowiedzi /hp/add.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// temperatura zewnętrzna bez kotła; null = brak świeżego pomiaru z czujnika kotła
const meteo = vi.hoisted(() => ({ temperature: null as number | null }));
vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => meteo.temperature,
  setOutdoorTemperature: () => undefined,
}));

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { assignDefaultPumpConfigs } from '../src/core/services/device.service'
import { heatPumpTile } from '../src/modules/heat-pump/tile'
import { HpEntryModel } from '../src/modules/heat-pump/models/hp.model'
import { DeviceType } from '../src/core/types'

describe('API with MongoDB', () => {
  let mongoServer: MongoMemoryServer;
  let rootId: string;
  const deviceId = 'test-hp';

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const device = await DeviceModel.create({
      deviceType: DeviceType.HP,
      deviceId,
      name: 'Testowa pompa',
      schedules: [],
    });
    rootId = String(device._id);

    await HpEntryModel.create({
      rootId,
      deviceType: DeviceType.HP,
      deviceId,
      work_mode: 'CWU',
      co_min: '30',
      co_max: '40',
      cwu_min: '45',
      cwu_max: '50',
      HP: { Ttarget: 45 },
    });

  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('returns database usage for the /devices footer without rootId', async () => {
    const response = await request(app).get('/api/devices/db-stats')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.limitBytes).toBeUndefined()
    expect(response.body.usedBytes).toBe(response.body.dataBytes + response.body.indexBytes)
    expect(response.body.usedBytes).toBeGreaterThan(0)
  })

  it('stores identical idle telemetry as a start and a moving end record (plateau writer)', async () => {
    const device = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'test-hp-plateau', schedules: [] })
    const id = String(device._id)
    const telemetry = (time: string, Ttarget: number) => ({
      time, work_mode: 'MANUAL', HP: { Ttarget, Tbe: 10.1, HPS: 0, Watts: 20, lt_hp_on: 120, lt_pow: 50 },
    })
    const add = (body: object) => request(app).post(`/api/hp/add?rootId=${id}&deviceId=test-hp-plateau`).send(body).expect(201)
    await add(telemetry('2026.10.07 10:00:00', 40.5))
    await add(telemetry('2026.10.07 10:00:30', 40.5))
    await add(telemetry('2026.10.07 10:01:00', 40.5))
    let records = await HpEntryModel.find({ rootId: id }).sort({ createdAt: 1 }).lean()
    expect(records).toHaveLength(2)
    // rekord końcowy niesie czas ostatniego odczytu ze sterownika
    expect(records[1].time).toBe('2026.10.07 10:01:00')
    // zmiana temperatury: nowy rekord
    await add(telemetry('2026.10.07 10:01:30', 40.6))
    records = await HpEntryModel.find({ rootId: id }).lean()
    expect(records).toHaveLength(3)
  })

  it('keeps co diagnostic counters also from telemetry without a CHPC reading (GET /hp diagnostics)', async () => {
    const device = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'test-hp-diag', schedules: [] })
    const id = String(device._id)
    const add = (body: object) => request(app).post(`/api/hp/add?rootId=${id}&deviceId=test-hp-diag`).send(body).expect(201)
    await add({ time: '2026.10.14 12:35:00', HP: { Ttarget: 37.9, HPS: 0 }, serial_read_timeout: 4, hp_json_error: 1, cloud_http_status: 201 })
    // CHPC milczy: puste HP nie jest zapisywane, ale liczniki tak
    await add({ time: '2026.10.14 12:35:30', HP: {}, serial_read_timeout: 5, hp_json_error: 1, cloud_http_status: 201 })
    await add({ time: '2026.10.14 12:36:00', HP: {}, serial_read_timeout: 6, hp_json_error: 1, cloud_http_status: 201 })
    expect(await HpEntryModel.countDocuments({ rootId: id })).toBe(1)
    const { diagnostics } = (await request(app).get(`/api/hp?rootId=${id}&deviceId=test-hp-diag`).expect(200)).body
    expect(diagnostics).toMatchObject({
      hp: false,
      counters: { serial_read_timeout: 6, hp_json_error: 1, cloud_http_status: 201 },
      sincePrevious: { serial_read_timeout: 1, hp_json_error: 0 },
      sinceLastHp: { serial_read_timeout: 2, hp_json_error: 0 },
    })
    expect(diagnostics.lastHpAt).toEqual(expect.any(String))
    expect(diagnostics.sinceLastHp.cloud_http_status).toBeUndefined()

    // zlecenie diagnostyki (co 1.2.5): walidacja, pole diag w odpowiedzi /hp/add, echo i zrzuty z co, odwołanie
    const diagApi = `/api/hp/diagnostics?rootId=${id}`
    expect((await request(app).put(diagApi).send({ hp_raw: 2 })).status).toBe(400)
    expect((await request(app).put(diagApi).send({ hp_timeout_s: 20 })).status).toBe(400)
    expect((await request(app).put(diagApi).send({ hp_raw: 1, minutes: 0 })).status).toBe(400)
    const put = await request(app).put(diagApi).send({ hp_raw: 1, bus_sniff: true, hp_timeout_s: 8, minutes: 30 }).expect(200)
    expect(put.body.request).toMatchObject({ hp_raw: 1, bus_sniff: 1, hp_timeout_s: 8, until: expect.any(String) })
    const answer = await add({
      HP: {}, serial_read_timeout: 7, serial_unexpected_frame: 3, hp_late_frame: 2, hp_last_ok_s: 95,
      diag: { hp_raw: 1, bus_sniff: 1, hp_timeout_s: 8 }, diag_bus: { len: 412, age_s: 4, hex: '7b22546265', since_write_ms: 3150, op: 0 },
    })
    expect(answer.body.diag).toEqual({ hp_raw: 1, bus_sniff: 1, hp_timeout_s: 8 })
    const after = (await request(app).get(diagApi).expect(200)).body
    expect(after).toMatchObject({
      counters: { serial_unexpected_frame: 3, hp_late_frame: 2, hp_last_ok_s: 95 },
      sincePrevious: { serial_read_timeout: 1 },
      diag: { hp_timeout_s: 8 }, diag_bus: { hex: '7b22546265', since_write_ms: 3150 },
    })
    expect(after.sinceLastHp.hp_last_ok_s).toBeUndefined()
    // wszystko wyłączone = odwołanie: odpowiedź bez diag
    expect((await request(app).put(diagApi).send({}).expect(200)).body.request).toBeNull()
    expect((await add({ HP: {} })).body.diag).toBeUndefined()
  })

  it('returns the latest HP data for the selected device', async () => {
    const response = await request(app)
      .get(`/api/hp?rootId=${rootId}&deviceId=${deviceId}`);

    expect(response.status).toBe(200);
    expect(response.body.rootId).toBe(rootId);
    expect(response.body.work_mode).toBe('CWU');
  });

  it('stores EEVmin from telemetry and offers it as eev_min_pulse_open', async () => {
    const posted = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ work_mode: 'A', HP: { Ttarget: 40, EEVmax: 61, EEVmin: 45 } });

    expect(posted.status).toBe(201);
    expect(posted.body).toHaveProperty('operation');

    const stored = await HpEntryModel.findOne({ rootId }).sort({ createdAt: -1 }).lean();
    expect(stored?.HP?.EEVmin).toBe(45);

    const operation = await request(app)
      .get(`/api/operation?rootId=${rootId}&deviceId=${deviceId}`);

    expect(operation.status).toBe(200);
    expect(operation.body.eev_max_pulse_open).toBe('61');
    expect(operation.body.eev_min_pulse_open).toBe('45');
  });

  it('does not return an error older than 24 hours as the last error', async () => {
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await HpEntryModel.collection.insertOne({
      rootId, deviceType: DeviceType.HP, deviceId,
      time: 'wczoraj', error_code: 3, HP: { Ttarget: 40, ERR: 3, ERRn: 9, ERRc: 1 },
      createdAt: yesterday, updatedAt: yesterday,
    });

    const lastError = await request(app)
      .get(`/api/hp/last-error?rootId=${rootId}&deviceId=${deviceId}`);
    expect(lastError.status).toBe(200);
    expect(lastError.body.error_code).toBeUndefined();
  });

  it('records a CHPC error once per event and returns the latest one', async () => {
    const post = (HP: Record<string, number>) => request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ time: '2026.09.24 10:00:00', HP: { Ttarget: 40, ...HP } });
    const latest = () => HpEntryModel.findOne({ rootId }).sort({ createdAt: -1 }).lean();

    await post({ ERR: 0, ERRn: 0, ERRc: 0 });
    expect((await latest())?.error_code).toBeUndefined();

    await post({ ERR: 2, ERRn: 1, ERRc: 1 });
    expect((await latest())?.error_code).toBe(2);

    // the same event reported again by the next poll is not a new error
    await post({ ERR: 2, ERRn: 1, ERRc: 1 });
    expect((await latest())?.error_code).toBeUndefined();

    // a repeated code with a new sequence number is a new event
    await post({ ERR: 2, ERRn: 2, ERRc: 2 });
    expect((await latest())?.error_code).toBe(2);

    await post({ ERR: 11, ERRn: 4, ERRc: 5 });
    const lastError = await request(app)
      .get(`/api/hp/last-error?rootId=${rootId}&deviceId=${deviceId}`);
    expect(lastError.status).toBe(200);
    expect(lastError.body.error_code).toBe(11);
    expect(lastError.body.HP.ERRc).toBe(5);
    expect(lastError.body.time).toBe('2026.09.24 10:00:00');
  });

  it('keeps an error older than 24 hours while the controller is locked', async () => {
    // poprzedni test zostawił sterownik zablokowany (ERRc 5); błędy przesuwamy o 26 h wstecz
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const older = new Date(old.getTime() - 60 * 60 * 1000);
    await HpEntryModel.collection.updateMany({ rootId, error_code: { $gt: 0 } }, { $set: { createdAt: older } });
    await HpEntryModel.collection.updateMany({ rootId, error_code: 11 }, { $set: { createdAt: old } });

    const locked = await request(app)
      .get(`/api/hp/last-error?rootId=${rootId}&deviceId=${deviceId}`);
    expect(locked.body.error_code).toBe(11);

    // po odblokowaniu (ERRc 0, ten sam ERRn) stary błąd znika zgodnie z oknem 24 h
    await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ time: '2026.09.24 10:05:00', HP: { Ttarget: 40, ERR: 11, ERRn: 4, ERRc: 0 } });
    const unlocked = await request(app)
      .get(`/api/hp/last-error?rootId=${rootId}&deviceId=${deviceId}`);
    expect(unlocked.body.error_code).toBeUndefined();
  });

  it('sends a maintenance action to the controller exactly once', async () => {
    const invalid = await request(app)
      .post(`/api/operation/action?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ action: 'format_disk' });
    expect(invalid.status).toBe(400);

    const queued = await request(app)
      .post(`/api/operation/action?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ action: 'error_reset' });
    expect(queued.status).toBe(201);

    const first = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: 40 } });
    expect(first.body.operation.error_reset).toBe('1');

    const second = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: 40 } });
    expect(second.body.operation.error_reset).toBeUndefined();
  });

  it('registers a new controller and returns its rootId', async () => {
    const response = await request(app)
      .post('/api/devices/register')
      .send({ deviceId: 'A4CF12345678' });

    expect(response.status).toBe(201);
    expect(response.body.deviceId).toBe('A4CF12345678');
    const device = await DeviceModel.findById(response.body.rootId).lean();
    expect(device?.deviceType).toBe(DeviceType.HP);
  });

  it('returns the existing rootId when a known controller registers again', async () => {
    const response = await request(app)
      .post('/api/devices/register')
      .send({ deviceId });

    expect(response.status).toBe(200);
    expect(response.body.rootId).toBe(rootId);
    expect(await DeviceModel.countDocuments({ deviceId })).toBe(1);
  });

  it('stores the controller IP address from each registration', async () => {
    const register = (ip?: string) =>
      request(app).post('/api/devices/register').send({ deviceId: 'A4CF00000002', ip });
    const listed = async () =>
      (await request(app).get('/api/devices')).body.find((device: { deviceId: string }) => device.deviceId === 'A4CF00000002');

    expect((await register('192.168.1.20')).body.ipAddress).toBe('192.168.1.20');
    expect((await listed()).ipSeenAt).toBeTruthy();

    // nowy adres po zmianie z DHCP
    expect((await register('192.168.1.31')).status).toBe(200);
    expect((await listed()).ipAddress).toBe('192.168.1.31');

    // brak adresu, 0.0.0.0 albo zły format: zostaje ostatni znany
    await register();
    await register('0.0.0.0');
    await register('192.168.1.300');
    await register('abc');
    expect((await listed()).ipAddress).toBe('192.168.1.31');
  });

  it('leaves the name of a self-registered controller empty', async () => {
    const response = await request(app)
      .post('/api/devices/register')
      .send({ deviceId: 'A4CF00000001' });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('');
  });

  it('renames a device without changing deviceId', async () => {
    const response = await request(app)
      .put(`/api/devices/${rootId}`)
      .send({ name: '  Pompa - dom  ', deviceId: 'zmieniony' });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Pompa - dom');
    expect(response.body.deviceId).toBe(deviceId);
    const device = await DeviceModel.findById(rootId).lean();
    expect(device?.deviceId).toBe(deviceId);
  });

  it('allows clearing the device name', async () => {
    const response = await request(app)
      .put(`/api/devices/${rootId}`)
      .send({ name: '' });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('');
  });

  it('rejects renaming an unknown device', async () => {
    const response = await request(app)
      .put('/api/devices/000000000000000000000000')
      .send({ name: 'x' });

    expect(response.status).toBe(404);
  });

  it('saves the heat pump definition (connection, tank, PV) without touching properties', async () => {
    const before = await DeviceModel.findById(rootId).lean();
    const response = await request(app)
      .put(`/api/devices/${rootId}`)
      .send({ name: 'Pompa', pumpConfig: { connection: 'co', tankLiters: 200, pvDtu: false, pvForce: true } });

    expect(response.status).toBe(200);
    // wymuszenie PV tylko z DTU
    expect(response.body.pumpConfig).toEqual({ connection: 'co', tankLiters: 200, pvDtu: false, pvForce: false });
    const listed = (await request(app).get('/api/devices')).body.find((item: { rootId: string }) => item.rootId === rootId);
    expect(listed.pumpConfig.connection).toBe('co');
    const after = await DeviceModel.findById(rootId).lean();
    expect(after?.properties).toEqual(before?.properties);

    // sama nazwa zostawia definicję
    await request(app).put(`/api/devices/${rootId}`).send({ name: 'Pompa 2' });
    expect((await DeviceModel.findById(rootId).lean())?.pumpConfig?.tankLiters).toBe(200);
  });

  it('assigns the CWU connection to a newly registered heat pump, with the tank liters left empty', async () => {
    const first = await request(app).post('/api/devices/register').send({ deviceId: 'A4CF0000AA01', deviceType: DeviceType.HP });
    expect(first.status).toBe(201);
    const created = await DeviceModel.findById(first.body.rootId).lean();
    // pvDtu = true: jak bez definicji (controller-contract: pv_dtu = 1), żeby nie wyłączyć odczytu falownika
    expect(created?.pumpConfig).toEqual({ connection: 'cwu', pvDtu: true, pvForce: false });
    expect(created?.pumpConfig?.tankLiters).toBeUndefined();

    // ponowne zgłoszenie nie rusza zmienionej definicji
    await request(app).put(`/api/devices/${first.body.rootId}`).send({ pumpConfig: { connection: 'co', tankLiters: 250, pvDtu: false, pvForce: false } });
    await request(app).post('/api/devices/register').send({ deviceId: 'A4CF0000AA01', deviceType: DeviceType.HP });
    expect((await DeviceModel.findById(first.body.rootId).lean())?.pumpConfig).toEqual({ connection: 'co', tankLiters: 250, pvDtu: false, pvForce: false });

    // pompa zgłoszona wcześniej bez definicji dostaje ją przy kolejnym zgłoszeniu i przy starcie serwera
    const old = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'A4CF0000AA02', name: 'Stara', schedules: [] });
    expect((await DeviceModel.findById(old._id).lean())?.pumpConfig).toBeUndefined();
    await request(app).post('/api/devices/register').send({ deviceId: 'A4CF0000AA02', deviceType: DeviceType.HP });
    expect((await DeviceModel.findById(old._id).lean())?.pumpConfig?.connection).toBe('cwu');

    const old2 = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'A4CF0000AA03', name: 'Stara 2', schedules: [] });
    expect(await assignDefaultPumpConfigs()).toBeGreaterThanOrEqual(1);
    expect((await DeviceModel.findById(old2._id).lean())?.pumpConfig?.connection).toBe('cwu');
    // istniejącej definicji nie nadpisuje
    expect((await DeviceModel.findById(first.body.rootId).lean())?.pumpConfig?.connection).toBe('co');

    await DeviceModel.deleteMany({ _id: { $in: [first.body.rootId, old._id, old2._id] } });
  });

  it('accepts a heat pump definition without the tank liters and rejects an out-of-range value', async () => {
    const empty = await request(app).put(`/api/devices/${rootId}`).send({ pumpConfig: { connection: 'cwu', pvDtu: true, pvForce: false } });
    expect(empty.status).toBe(200);
    expect(empty.body.pumpConfig.tankLiters).toBeUndefined();
    const nulled = await request(app).put(`/api/devices/${rootId}`).send({ pumpConfig: { connection: 'co', tankLiters: null, pvDtu: true, pvForce: false } });
    expect(nulled.status).toBe(200);
    expect((await DeviceModel.findById(rootId).lean())?.pumpConfig?.tankLiters).toBeUndefined();
    expect((await request(app).put(`/api/devices/${rootId}`).send({ pumpConfig: { connection: 'cwu', tankLiters: 5000, pvDtu: true, pvForce: false } })).status).toBe(400);
  });

  it('rejects an invalid heat pump definition and a definition for other device types', async () => {
    const bad = [
      { connection: 'pv', tankLiters: 200, pvDtu: false, pvForce: false },
      { connection: 'cwu', tankLiters: 10, pvDtu: false, pvForce: false },
      { connection: 'cwu', tankLiters: 200.5, pvDtu: false, pvForce: false },
      { connection: 'cwu', tankLiters: 200, pvDtu: 'tak', pvForce: false },
    ];
    for (const pumpConfig of bad) {
      expect((await request(app).put(`/api/devices/${rootId}`).send({ pumpConfig })).status).toBe(400);
    }
    expect((await request(app).put(`/api/devices/${rootId}`).send({})).status).toBe(400);

    const tank = await request(app)
      .post('/api/devices/register')
      .send({ deviceId: 'A4CF000000F1', deviceType: DeviceType.WATER_PRESSURE_TANK });
    const response = await request(app)
      .put(`/api/devices/${tank.body.rootId}`)
      .send({ pumpConfig: { connection: 'cwu', tankLiters: 300, pvDtu: false, pvForce: false } });
    expect(response.status).toBe(400);
  });

  it('rejects a registration without deviceId', async () => {
    const response = await request(app)
      .post('/api/devices/register')
      .send({ deviceId: '  ' });

    expect(response.status).toBe(400);
  });

  it('sends the outdoor temperature to the controller next to the operation', async () => {
    meteo.temperature = null;
    const unknown = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: 40 } });
    expect(unknown.status).toBe(201);
    expect(unknown.body).not.toHaveProperty('t_out');

    meteo.temperature = 12.3;
    const known = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: 40 } });
    expect(known.body.t_out).toBe(12.3);
    expect(known.body.operation).not.toHaveProperty('t_out');
    meteo.temperature = null;
  });

  it('saves the order of devices and lists them in that order (new ones at the end)', async () => {
    const second = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'order-b', name: 'Bbb', schedules: [] });
    const third = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'order-c', name: 'Aaa', schedules: [] });
    const ids = [String(second._id), String(rootId), String(third._id)];

    const saved = await request(app).put('/api/devices/order').send({ rootIds: ids });
    expect(saved.status).toBe(200);
    expect(saved.body.map((item: { rootId: string }) => item.rootId).slice(0, 3)).toEqual(ids);

    const added = await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'order-d', name: '', schedules: [] });
    const list = await request(app).get('/api/devices');
    const listed = list.body.map((item: { rootId: string }) => item.rootId);
    expect(listed.slice(0, 3)).toEqual(ids);
    expect(listed[listed.length - 1]).toBe(String(added._id));

    expect((await request(app).put('/api/devices/order').send({ rootIds: [ids[0], ids[0]] })).status).toBe(400);
    expect((await request(app).put('/api/devices/order').send({ rootIds: ['000000000000000000000000'] })).status).toBe(404);
    expect((await request(app).put('/api/devices/order').send({ rootIds: 'x' })).status).toBe(400);

    await DeviceModel.deleteMany({ _id: { $in: [second._id, third._id, added._id] } });
  });

  it('shows the heat pump tile with data right after telemetry (cache keeps the record time)', async () => {
    const posted = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: 41.5, Tmin: 38, Tmax: 45, HPS: false }, work_mode: 'AUTO', time: '2026.10.08 12:00:00' });
    expect(posted.status).toBe(201);

    const summary = await request(app).get('/api/devices/summary');
    expect(summary.status).toBe(200);
    const tile = summary.body[rootId];
    expect(tile.level).not.toBe('off');
    expect(tile.main.value).toContain('41,5');
    expect(tile.updatedAt).toBeTruthy();
  });

  it('shows the heat pump tile when CHPC numbers arrive as strings (raw cache)', async () => {
    const posted = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: '47.3', Tmin: '38.0', Tmax: '45.0', Watts: '1500', Tsump: '62.5', Tho: '0', HPS: 1 }, work_mode: 'AUTO', time: '2026.10.08 12:30:00' });
    expect(posted.status).toBe(201);

    const tile = (await request(app).get('/api/devices/summary')).body[rootId];
    expect(tile.main.value).toBe('47,3 °C');
    expect(tile.side[0].value).toBe('38–45 °C');
    expect(tile.side[1].value).toContain('1500');
    expect(tile.side[2]).toEqual({ icon: 'thermo', value: '62,5 °C', label: 'T. sprężarki' });
    expect(tile.side[3]).toEqual({ icon: 'thermo', value: '0 °C', label: 'T. wody wyj.' });
    expect(tile.running).toBe(true);
  });

  it('does not show old heat pump values on the tile once the link is lost (> 5 min)', async () => {
    await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: '50.8', Tmin: '40.0', Tmax: '47.0', Watts: '20', Tsump: '35.2', HPS: 0 }, work_mode: 'OFF', time: '2026.10.08 12:40:00' });

    const fresh = await heatPumpTile(rootId, {} as never, new Date(Date.now() + 60 * 1000));
    expect(fresh?.main?.value).toBe('50,8 °C');
    expect(fresh?.level).toBe('ok');
    expect(fresh?.side).toEqual([
      { icon: 'target', value: '40–47 °C', label: 'min–max' },
      { icon: 'bolt', value: '20 W', label: 'moc' },
      { icon: 'thermo', value: '35,2 °C', label: 'T. sprężarki' },
      { icon: 'thermo', value: '---', label: 'T. wody wyj.' },
    ]);

    const device = { properties: { temp_min: '40', temp_max: '45' } } as never;
    const lostFor10min = await heatPumpTile(rootId, device, new Date(Date.now() + 10 * 60 * 1000));
    expect(lostFor10min?.level).toBe('warn');
    expect(lostFor10min?.chip).toBe('Offline');
    expect(lostFor10min?.main?.value).toBe('---');
    // bez łączności: od–do z ustawień zamiast telemetrii (40–47), moc nieznana
    expect(lostFor10min?.side).toEqual([
      { icon: 'target', value: '40–45 °C', label: 'od–do' },
      { icon: 'bolt', value: '---', label: 'moc' },
      { icon: 'thermo', value: '---', label: 'T. sprężarki' },
      { icon: 'thermo', value: '---', label: 'T. wody wyj.' },
    ]);

    const lostFor2h = await heatPumpTile(rootId, {} as never, new Date(Date.now() + 2 * 3600 * 1000));
    expect(lostFor2h?.level).toBe('err');
  });

  it('tile texts in the language of the request (Accept-Language: en), chips stay as identifiers', async () => {
    await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=${deviceId}`)
      .send({ HP: { Ttarget: '50.8', Tmin: '40.0', Tmax: '47.0', Watts: '20', Tsump: '35.2', HPS: 1 }, work_mode: 'A', time: '2026.10.08 12:40:00' });
    const english = await heatPumpTile(rootId, {} as never, new Date(Date.now() + 60 * 1000), 'en');
    expect(english?.chip).toBe('Online');
    expect(english?.main).toEqual({ icon: 'thermo', value: '50.8 °C', label: 'tank' });
    expect(english?.side?.map((item) => item.label)).toEqual(['min–max', 'power', 'Compressor T.', 'Outlet water T.']);
    expect(english?.row?.[0]?.value).toBe('automatic');
    const polish = await heatPumpTile(rootId, {} as never, new Date(Date.now() + 60 * 1000));
    expect(polish?.main).toEqual({ icon: 'thermo', value: '50,8 °C', label: 'zbiornik' });

    const summaryEn = await request(app).get('/api/devices/summary').set('Accept-Language', 'en-GB,en;q=0.9').expect(200);
    expect(summaryEn.body[rootId]?.main?.label).toBe('tank');
    const summaryPl = await request(app).get('/api/devices/summary').expect(200);
    expect(summaryPl.body[rootId]?.main?.label).toBe('zbiornik');
  });
});


