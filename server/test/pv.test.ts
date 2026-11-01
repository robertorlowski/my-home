// Testy PV (baza w mongodb-memory-server): zapis /pv/add z samym deviceId, 400/404/409,
// wpisanie samego PV.total_power do rekordu hp (limit 3 min, PV od starszego firmware
// bez zmian), bilans monthly-summary i usuwanie panels po 90 dniach.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { HpEntryModel } from '../src/modules/heat-pump/models/hp.model'
import { PvEntryModel } from '../src/modules/heat-pump/models/pv.model'
import { DeviceType } from '../src/core/types'
import { removeExpiredPanelDetails } from '../src/modules/heat-pump/services/pv.service'

const panel = {
  serial: '116491036767', port: 1, power: 325.2, prod_today: 740,
  prod_total: 1053484, temperature: 33.4, pv_voltage: 36, pv_current: 9.02,
  grid_voltage: 238, grid_frequency: 50.02, status: 3, alarm_code: 0,
  alarm_count: 0, link: 1,
};

const reading = (total_power: number) => ({
  time: '2026.09.26 12:41:00', total_power, total_prod: 3150000,
  total_prod_today: 8400, temperature: 22.9, pv_power: total_power >= 2000,
  panels: [panel],
});

describe('PV telemetry', () => {
  let mongoServer: MongoMemoryServer;

  const createDevice = async (deviceId: string) =>
    String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId, schedules: [] }))._id);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('stores a reading sent with deviceId only and returns it as the latest one', async () => {
    const rootId = await createDevice('A4CF00000101');

    const posted = await request(app)
      .post('/api/pv/add?deviceId=A4CF00000101')
      .send(reading(3080));
    expect(posted.status).toBe(201);

    const stored = await PvEntryModel.findOne({ rootId }).lean();
    expect(stored?.deviceId).toBe('A4CF00000101');
    expect(stored?.panels?.[0]?.pv_current).toBe(9.02);
    expect(stored?.panels?.[0]?.grid_frequency).toBe(50.02);

    const last = await request(app).get(`/api/pv?rootId=${rootId}`);
    expect(last.status).toBe(200);
    expect(last.body.total_power).toBe(3080);
    expect(last.body.panels).toHaveLength(1);
  });

  it('rejects a reading without total_power', async () => {
    await createDevice('A4CF00000102');
    const posted = await request(app)
      .post('/api/pv/add?deviceId=A4CF00000102')
      .send({ panels: [] });
    expect(posted.status).toBe(400);
  });

  it('identifies the controller by rootId or deviceId', async () => {
    const rootId = await createDevice('A4CF00000103');

    const byDeviceId = await request(app)
      .post('/api/hp/add?deviceId=A4CF00000103')
      .send({ HP: { Ttarget: 40 } });
    expect(byDeviceId.status).toBe(201);
    expect(await HpEntryModel.countDocuments({ rootId })).toBe(1);

    const unknown = await request(app)
      .post('/api/pv/add?deviceId=A4CF0000FFFF')
      .send(reading(100));
    expect(unknown.status).toBe(404);

    const mismatch = await request(app)
      .post(`/api/hp/add?rootId=${rootId}&deviceId=A4CF00000999`)
      .send({ HP: { Ttarget: 40 } });
    expect(mismatch.status).toBe(409);

    // pozostałe endpointy nadal wymagają rootId
    const clientRead = await request(app).get('/api/hp?deviceId=A4CF00000103');
    expect(clientRead.status).toBe(400);
  });

  it('stores only the PV power needed for the energy balance in the HP record', async () => {
    const rootId = await createDevice('A4CF00000104');
    await request(app).post(`/api/pv/add?rootId=${rootId}`).send(reading(2500));
    await request(app).post(`/api/hp/add?rootId=${rootId}`).send({ HP: { Ttarget: 40, Watts: 900 } });

    const stored = await HpEntryModel.findOne({ rootId }).lean();
    expect(stored?.PV).toEqual({ total_power: 2500 });
    expect(stored?.pv_power).toBeUndefined();

    // bieżąca telemetria pokazuje pełne podsumowanie ostatniego odczytu
    const response = await request(app).get(`/api/hp?rootId=${rootId}`);
    expect(response.body.PV.total_power).toBe(2500);
    expect(response.body.PV.temperature).toBe(22.9);
    expect(response.body.PV.total_prod_today).toBe(8400);
    expect(response.body.pv_power).toBe(true);
    expect(response.body.PV.panels).toBeUndefined();
  });

  it('does not use a PV reading older than three minutes', async () => {
    const rootId = await createDevice('A4CF00000105');
    const old = new Date(Date.now() - 4 * 60 * 1000);
    await PvEntryModel.collection.insertOne({
      rootId, deviceType: DeviceType.HP, deviceId: 'A4CF00000105',
      total_power: 1800, createdAt: old, updatedAt: old,
    });
    await request(app).post(`/api/hp/add?rootId=${rootId}`).send({ HP: { Ttarget: 40 } });

    const stored = await HpEntryModel.findOne({ rootId }).lean();
    expect(stored?.PV).toBeUndefined();
    const response = await request(app).get(`/api/hp?rootId=${rootId}`);
    expect(response.body.HP.Ttarget).toBe(40);
    expect(response.body.PV).toBeUndefined();
  });

  it('keeps PV sent with the HP telemetry by an older controller', async () => {
    const rootId = await createDevice('A4CF00000106');
    await request(app).post(`/api/pv/add?rootId=${rootId}`).send(reading(2500));
    await request(app).post(`/api/hp/add?rootId=${rootId}`)
      .send({ HP: { Ttarget: 40 }, PV: { total_power: 777, temperature: 50 } });

    const stored = await HpEntryModel.findOne({ rootId }).lean();
    expect(stored?.PV?.total_power).toBe(777);
    expect(stored?.PV?.temperature).toBe(50);
  });

  it('computes the energy balance from the PV power stored in HP records', async () => {
    const rootId = await createDevice('A4CF00000108');
    await request(app).post(`/api/pv/add?rootId=${rootId}`).send(reading(400));
    await request(app).post(`/api/hp/add?rootId=${rootId}`).send({ HP: { Ttarget: 40, Watts: 1000 } });
    await request(app).post(`/api/pv/add?rootId=${rootId}`).send(reading(600));
    await request(app).post(`/api/hp/add?rootId=${rootId}`).send({ HP: { Ttarget: 40, Watts: 1000 } });

    // drugi pomiar minutę po pierwszym
    const [first, second] = await HpEntryModel.find({ rootId }).sort({ createdAt: 1 }).lean();
    const base = new Date('2026-06-10T10:00:00Z');
    await HpEntryModel.collection.updateOne({ _id: first._id }, { $set: { createdAt: base } });
    await HpEntryModel.collection.updateOne({ _id: second._id }, { $set: { createdAt: new Date(base.getTime() + 60 * 1000) } });

    const summary = await request(app)
      .get(`/api/hp/monthly-summary?rootId=${rootId}&startDate=2026.06.10&endDate=2026.06.10&group=day`);
    expect(summary.status).toBe(200);
    const [day] = summary.body;
    // 1000 W pompy i średnio 500 W PV przez minutę
    expect(day.consumptionKWh).toBeCloseTo(1000 / 60 / 1000, 9);
    expect(day.pvGenerationKWh).toBeCloseTo(500 / 60 / 1000, 9);
    expect(day.gridEnergyKWh).toBeCloseTo(500 / 60 / 1000, 9);
  });

  it('bilans godzinowy: PV z liczników falowników (moc 0 przy utracie łączności), oddanie do sieci, święto poza szczytem', async () => {
    const rootId = await createDevice('A4CF00000109');
    // 11.11 (święto, środa) i 12.11 (czwartek); 09:00–11:00 UTC = 10:00–12:00 w Warszawie
    for (const date of ['2026-11-11', '2026-11-12']) {
      const at = (time: string) => new Date(`${date}T${time}:00Z`);
      // pompa 1200 W co 5 min od 09:00 do 10:55: godzina 10 = 11 odstępów (1100 Wh), godzina 11 = 12 odstępów (1200 Wh);
      // moc PV w rekordach 0, jak przy falowniku bez łączności z DTU
      await HpEntryModel.collection.insertMany(Array.from({ length: 24 }, (_, i) => {
        const createdAt = new Date(at('09:00').getTime() + i * 5 * 60_000);
        return { rootId, deviceType: DeviceType.HP, HP: { Ttarget: 40, Watts: 1200 }, PV: { total_power: 0 }, createdAt, updatedAt: createdAt };
      }));
      // liczniki: godzina 10 do 1600 Wh, godzina 11 do 2000 Wh; chwilowe zero nie cofa sumy
      await PvEntryModel.collection.insertMany([['09:10', 0], ['09:50', 1600], ['10:30', 2000], ['10:40', 0]].map(([time, wh]) => ({
        rootId, deviceType: DeviceType.HP, total_power: 0, total_prod_today: wh, createdAt: at(time as string), updatedAt: at(time as string),
      })));
    }
    const summary = (group: string, startDate: string, endDate = startDate) =>
      request(app).get(`/api/hp/monthly-summary?rootId=${rootId}&startDate=${startDate}&endDate=${endDate}&group=${group}`);

    const hours = (await summary('hour', '2026-11-12')).body;
    expect(hours.map((h: { hour: number }) => h.hour)).toEqual([10, 11]);
    // 10:00: pompa 1,1 kWh, PV 1,6 kWh — bez poboru, 0,5 kWh oddane; 11:00: pompa 1,2, PV 0,4 — pobór 0,8 kWh
    expect(hours[0]).toMatchObject({ date: '2026-11-12', consumptionKWh: 1.1, pvGenerationKWh: 1.6, gridEnergyKWh: 0, pvUsedKWh: 1.1 });
    expect(hours[0].exportKWh).toBeCloseTo(0.5, 9);
    expect(hours[1].pvGenerationKWh).toBeCloseTo(0.4, 9);
    expect(hours[1].gridEnergyKWh).toBeCloseTo(0.8, 9);
    expect(hours[1].peakGridEnergyKWh).toBeCloseTo(0.8, 9);

    // czwartek w szczycie, święto 11.11 poza szczytem
    const days = (await summary('day', '2026-11-11', '2026-11-12')).body;
    expect(days.map((d: { date: string }) => d.date)).toEqual(['2026-11-11', '2026-11-12']);
    expect(days[0].offPeakGridEnergyKWh).toBeCloseTo(0.8, 9);
    expect(days[0].totalVariableCostPLN).toBeCloseTo(0.8 * 0.6305, 9);
    expect(days[1].totalVariableCostPLN).toBeCloseTo(0.8 * 1.2302, 9);
    expect(days[1].exportKWh).toBeCloseTo(0.5, 9);

    // 13.11: moc PV w rekordach 600 W (połowa paneli bez łączności), liczniki 2300 Wh: godziny według mocy
    // (550 i 600 Wh) przeskalowane do licznika — 1100 i 1200 Wh, czyli tyle, ile zużyła pompa
    const at13 = (time: string) => new Date(`2026-11-13T${time}:00Z`);
    await HpEntryModel.collection.insertMany(Array.from({ length: 24 }, (_, i) => {
      const createdAt = new Date(at13('09:00').getTime() + i * 5 * 60_000);
      return { rootId, deviceType: DeviceType.HP, HP: { Ttarget: 40, Watts: 1200 }, PV: { total_power: 600 }, createdAt, updatedAt: createdAt };
    }));
    await PvEntryModel.collection.insertMany([['09:10', 0], ['09:50', 2000], ['10:30', 2300]].map(([time, wh]) => ({
      rootId, deviceType: DeviceType.HP, total_power: 600, total_prod_today: wh, createdAt: at13(time as string), updatedAt: at13(time as string),
    })));
    const scaled = (await summary('hour', '2026-11-13')).body;
    expect(scaled[0].pvGenerationKWh).toBeCloseTo(1.1, 9);
    expect(scaled[1].pvGenerationKWh).toBeCloseTo(1.2, 9);
    expect(scaled.map((h: { gridEnergyKWh: number }) => h.gridEnergyKWh)).toEqual([0, 0]);
  });

  it('removes panel details after 90 days and keeps the summary', async () => {
    const rootId = await createDevice('A4CF00000107');
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    await PvEntryModel.collection.insertMany([
      { rootId, deviceType: DeviceType.HP, deviceId: 'A4CF00000107', total_power: 1, panels: [panel], createdAt: old, updatedAt: old },
      { rootId, deviceType: DeviceType.HP, deviceId: 'A4CF00000107', total_power: 2, panels: [panel], createdAt: recent, updatedAt: recent },
    ]);

    await removeExpiredPanelDetails();

    const oldDoc = await PvEntryModel.findOne({ rootId, total_power: 1 }).lean();
    const recentDoc = await PvEntryModel.findOne({ rootId, total_power: 2 }).lean();
    expect(oldDoc?.panels).toBeUndefined();
    expect(oldDoc?.total_power).toBe(1);
    expect(recentDoc?.panels).toHaveLength(1);
  });
});
