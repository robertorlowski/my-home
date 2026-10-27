// Testy hydroforu (baza w mongodb-memory-server): przepływ z wodomierza i woda z czasu
// pracy pompy (bez ręcznej pracy kompresora), zgłoszenie z ustawieniami, uruchomienia
// (daty z czasów względnych, kolejka, 404/409, w toku), podsumowania, wodomierz,
// czas kompresora ze sterownika, sterownik domyślny.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../src/core/app'
import { WaterPressureTankRunModel } from '../src/modules/water-pressure-tank/models/water-pressure-tank-run.model'
import { addWaterPressureTankReport, pumpSeconds } from '../src/modules/water-pressure-tank/services/water-pressure-tank.service'

const register = (deviceId: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/api/devices/register').send({
    deviceId, deviceType: 'water-pressure-tank', name: 'Hydrofor', ...extra,
  });

describe('Hydrofor (water-pressure-tank)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await WaterPressureTankRunModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe('przepływ i woda', () => {
    const meter = (rootId: string, readAt: string, valueM3: number) =>
      request(app).post(`/api/water-pressure-tank/meter?rootId=${rootId}`).send({ readAt, valueM3 }).expect(201);

    it('czas pracy pompy nie obejmuje ręcznej pracy kompresora', () => {
      const run = { pumpStart: new Date('2026-09-28T08:00:00Z'), pumpEnd: new Date('2026-09-28T08:10:00Z') };
      expect(pumpSeconds({ ...run, manualSeconds: 0 })).toBe(600);
      expect(pumpSeconds({ ...run, manualSeconds: 240 })).toBe(360);
      // ręczna praca dłuższa niż zapis (np. zaokrąglenia) nie daje ujemnego czasu
      expect(pumpSeconds({ ...run, manualSeconds: 900 })).toBe(0);
    });

    it('liczy przepływ z wodomierza i wodę każdego uruchomienia', async () => {
      const { body } = await register('C3A1B2C3D450');
      const rootId = body.rootId;
      await meter(rootId, '2026-09-01T00:00:00Z', 100);
      // 3 uruchomienia po 200 s, w jednym 100 s ręcznej pracy kompresora: pompa 500 s
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 200 }, new Date('2026-09-02T10:00:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 2, pumpRunS: 200 }, new Date('2026-09-03T10:00:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 3, pumpRunS: 200, manualCompressorS: 100 }, new Date('2026-09-04T10:00:00Z'));
      // 0,5 m³ = 500 l w 500 s pompy → 1 l/s = 60 l/min
      await meter(rootId, '2026-09-05T00:00:00Z', 100.5);

      const flow = await request(app).get(`/api/water-pressure-tank/flow?rootId=${rootId}`);
      expect(flow.body).toMatchObject({ litersPerMinute: 60, periods: 1, meterLiters: 500, pumpSeconds: 500 });

      const runs = await request(app).get(`/api/water-pressure-tank/runs?rootId=${rootId}&from=2026-09-02&to=2026-09-04`);
      expect(runs.body.map((run: { pumpSeconds: number }) => run.pumpSeconds)).toEqual([200, 200, 100]);
      expect(runs.body.map((run: { waterLiters: number }) => run.waterLiters)).toEqual([200, 200, 100]);

      const month = await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=month&date=2026-09-01`);
      expect(month.body.buckets[3]).toMatchObject({ pumpSeconds: 100, waterLiters: 100, runs: 1 });
      expect(month.body.flow.litersPerMinute).toBe(60);
    });

    it('uśrednia przepływ ze wszystkich okresów ważąc czasem i pomija okresy bez pompy', async () => {
      const { body } = await register('C3A1B2C3D451');
      const rootId = body.rootId;
      await meter(rootId, '2026-08-01T00:00:00Z', 10);
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 100 }, new Date('2026-08-02T10:00:00Z'));
      await meter(rootId, '2026-08-03T00:00:00Z', 10.1); // 100 l / 100 s
      await addWaterPressureTankReport(rootId, { runId: 2, pumpRunS: 300 }, new Date('2026-08-04T10:00:00Z'));
      await meter(rootId, '2026-08-05T00:00:00Z', 10.7); // 600 l / 300 s
      await meter(rootId, '2026-08-06T00:00:00Z', 10.75); // 50 l bez pracy pompy: pomijany

      const flow = await request(app).get(`/api/water-pressure-tank/flow?rootId=${rootId}`);
      // (100 + 600) l / (100 + 300) s = 1,75 l/s = 105 l/min
      expect(flow.body).toMatchObject({ litersPerMinute: 105, periods: 2, meterLiters: 700, pumpSeconds: 400 });

      const summary = await request(app).get(`/api/water-pressure-tank/meter/summary?rootId=${rootId}&year=2026`);
      expect(summary.body.periods).toHaveLength(3);
      expect(summary.body.periods[0]).toMatchObject({ meterLiters: 100, pumpSeconds: 100, estimatedLiters: 175 });
      expect(summary.body.periods[2]).toMatchObject({ meterLiters: 50, pumpSeconds: 0, estimatedLiters: 0 });
      expect(summary.body.flow.litersPerMinute).toBe(105);
    });

    it('bez dwóch odczytów wodomierza woda jest nieznana, czas pompy jest', async () => {
      const { body } = await register('C3A1B2C3D452');
      const rootId = body.rootId;
      await meter(rootId, '2026-09-01T00:00:00Z', 5);
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 90 }, new Date('2026-09-02T10:00:00Z'));

      const flow = await request(app).get(`/api/water-pressure-tank/flow?rootId=${rootId}`);
      expect(flow.body.litersPerMinute).toBeNull();
      const runs = await request(app).get(`/api/water-pressure-tank/runs?rootId=${rootId}&from=2026-09-02&to=2026-09-02`);
      expect(runs.body[0]).toMatchObject({ pumpSeconds: 90, waterLiters: null });
    });
  });

  describe('zgłoszenie sterownika', () => {
    it('tworzy hydrofor z domyślnymi ustawieniami, zwraca ustawienia', async () => {
      const response = await register('C3A1B2C3D401');
      expect(response.status).toBe(201);
      expect(response.body.deviceType).toBe('water-pressure-tank');
      expect(response.body.name).toBe('Hydrofor');
      expect(response.body.settings).toEqual({ compressor_seconds: 30 });
    });

    it('przy kolejnym zgłoszeniu zwraca ten sam rootId bez zmiany nazwy', async () => {
      const first = await register('C3A1B2C3D402');
      const second = await register('C3A1B2C3D402', { name: 'Inna nazwa' });
      expect(second.status).toBe(200);
      expect(second.body.rootId).toBe(first.body.rootId);
      expect(second.body.name).toBe('Hydrofor');
    });

    it('pompa ciepła nie dostaje ustawień hydroforu', async () => {
      const response = await request(app).post('/api/devices/register').send({
        deviceId: 'A4CF0000AA01', deviceType: 'heat_pump',
      });
      expect(response.status).toBe(201);
      expect(response.body.settings).toBeUndefined();
    });

    it('odrzuca nieznany typ urządzenia', async () => {
      const response = await register('C3A1B2C3D403', { deviceType: 'toaster' });
      expect(response.status).toBe(400);
    });
  });

  describe('uruchomienia', () => {
    it('wylicza daty z czasów względnych i przesuwa pumpEnd z każdą wiadomością', async () => {
      const { body } = await register('C3A1B2C3D410');
      const rootId = body.rootId;
      const t0 = new Date('2026-09-28T08:00:00.000Z');

      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 2, compressorStartS: 1 }, t0);
      await addWaterPressureTankReport(rootId,
        { runId: 1, pumpRunS: 40, compressorStartS: 1, compressorEndS: 31 },
        new Date(t0.getTime() + 38_000));

      const run = await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean();
      expect(run?.pumpStart.toISOString()).toBe('2026-09-28T07:59:58.000Z');
      expect(run?.compressorStart?.toISOString()).toBe('2026-09-28T07:59:59.000Z');
      expect(run?.compressorEnd?.toISOString()).toBe('2026-09-28T08:00:29.000Z');
      expect(run?.pumpEnd.toISOString()).toBe('2026-09-28T08:00:38.000Z');
      expect(run?.timeApproximate).toBe(false);
      expect(run?.manualSeconds).toBe(0);
    });

    it('przyjmuje dane z samym deviceId, a uruchomienie z kolejki oznacza jako przybliżone', async () => {
      const { body } = await register('C3A1B2C3D411');
      const posted = await request(app)
        .post('/api/water-pressure-tank/add?deviceId=C3A1B2C3D411')
        .send({ runId: 7, pumpRunS: 90, compressorStartS: 1, compressorEndS: 31, queued: true });
      expect(posted.status).toBe(201);

      const run = await WaterPressureTankRunModel.findOne({ rootId: body.rootId, runId: 7 }).lean();
      expect(run?.timeApproximate).toBe(true);
      expect((run!.pumpEnd.getTime() - run!.pumpStart.getTime()) / 1000).toBe(90);
    });

    it('odpowiada 404 dla nieznanego sterownika i 409 dla cudzego rootId', async () => {
      const unknown = await request(app)
        .post('/api/water-pressure-tank/add?deviceId=FFFFFFFFFFFF')
        .send({ runId: 1, pumpRunS: 1 });
      expect(unknown.status).toBe(404);

      const other = await register('C3A1B2C3D412');
      const conflict = await request(app)
        .post(`/api/water-pressure-tank/add?deviceId=C3A1B2C3D413&rootId=${other.body.rootId}`)
        .send({ runId: 1, pumpRunS: 1 });
      expect(conflict.status).toBe(409);
    });

    it('uruchomienie znane z wiadomości na żywo, dosłane z kolejki, dostaje koniec z czasu pracy', async () => {
      const { body } = await register('C3A1B2C3D417');
      const rootId = body.rootId;
      const t0 = new Date('2026-09-28T11:00:00.000Z');
      // na żywo doszły tylko 3 s, potem zanik sieci; pełny czas przychodzi z kolejki następnego startu
      await addWaterPressureTankReport(rootId, { runId: 5, pumpRunS: 3, compressorStartS: 1 }, t0);
      await addWaterPressureTankReport(rootId,
        { runId: 5, pumpRunS: 120, compressorStartS: 1, compressorEndS: 31, restarts: 1, queued: true },
        new Date('2026-09-28T15:00:00.000Z'));

      const run = await WaterPressureTankRunModel.findOne({ rootId, runId: 5 }).lean();
      expect(run?.pumpStart.toISOString()).toBe('2026-09-28T10:59:57.000Z');
      expect(run?.pumpEnd.toISOString()).toBe('2026-09-28T11:01:57.000Z');
      expect(run?.compressorEnd?.toISOString()).toBe('2026-09-28T11:00:28.000Z');
      expect(run?.restarts).toBe(1);
      expect(run?.timeApproximate).toBe(false);
    });

    it('zachowuje początek kompresora, gdy kolejna wiadomość go nie ma', async () => {
      const { body } = await register('C3A1B2C3D418');
      const rootId = body.rootId;
      const t0 = new Date('2026-09-28T12:00:00.000Z');
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 2, compressorStartS: 1 }, t0);
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 3 }, new Date(t0.getTime() + 1000));
      const run = await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean();
      expect(run?.compressorStart?.toISOString()).toBe('2026-09-28T11:59:59.000Z');
    });

    it('oznacza uruchomienie w toku, gdy ostatnia wiadomość jest świeża', async () => {
      const { body } = await register('C3A1B2C3D419');
      await request(app).post('/api/water-pressure-tank/add?deviceId=C3A1B2C3D419')
        .send({ runId: 1, pumpRunS: 5, compressorStartS: 1 }).expect(201);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
      const runs = await request(app).get(`/api/water-pressure-tank/runs?rootId=${body.rootId}&from=${today}&to=${today}`);
      expect(runs.body).toHaveLength(1);
      expect(runs.body[0].inProgress).toBe(true);
      expect(runs.body[0].compressorRunning).toBe(true);
    });

    it('śledzi pracę kompresora także po ponownym uruchomieniu', async () => {
      const { body } = await register('C3A1B2C3D41C');
      const rootId = body.rootId;
      const t0 = new Date('2026-09-28T13:00:00.000Z');
      const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
      const running = async () => (await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean())?.compressorRunning;

      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 2, compressorStartS: 1 }, at(0));
      expect(await running()).toBe(true);
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 32, compressorStartS: 1, compressorEndS: 31 }, at(30));
      expect(await running()).toBe(false);
      // „Uruchom ponownie”: sterownik przestaje wysyłać compressorEndS, w bazie zostaje poprzedni koniec
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 40, compressorStartS: 1, restarts: 1 }, at(38));
      const restarted = await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean();
      expect(restarted?.compressorRunning).toBe(true);
      expect(restarted?.compressorEnd).toBeDefined();
    });

    it('nie pokazuje pracy kompresora, gdy uruchomienie nie jest w toku', async () => {
      const { body } = await register('C3A1B2C3D41D');
      await addWaterPressureTankReport(body.rootId, { runId: 1, pumpRunS: 2, compressorStartS: 1 }, new Date('2026-09-28T04:31:00Z'));
      const runs = await request(app).get(`/api/water-pressure-tank/runs?rootId=${body.rootId}&from=2026-09-28&to=2026-09-28`);
      expect(runs.body[0].inProgress).toBe(false);
      expect(runs.body[0].compressorRunning).toBe(false);
    });

    it('zwraca uruchomienia z okresu podanego czasami ISO i odrzuca złe zakresy', async () => {
      const { body } = await register('C3A1B2C3D41A');
      const rootId = body.rootId;
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 10 }, new Date('2026-08-10T10:00:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 2, pumpRunS: 10 }, new Date('2026-08-20T10:00:00Z'));

      const period = await request(app)
        .get(`/api/water-pressure-tank/runs?rootId=${rootId}&fromTime=2026-08-09T00:00:00Z&toTime=2026-08-15T00:00:00Z`);
      expect(period.status).toBe(200);
      expect(period.body.map((run: { runId: number }) => run.runId)).toEqual([1]);

      expect((await request(app).get(`/api/water-pressure-tank/runs?rootId=${rootId}`)).status).toBe(400);
      expect((await request(app).get(`/api/water-pressure-tank/runs?rootId=${rootId}&fromTime=zle&toTime=zle`)).status).toBe(400);
      expect((await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=week&date=2026-08-10`)).status).toBe(400);
      expect((await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=day&date=10.08.2026`)).status).toBe(400);
    });

    it('odrzuca ujemne czasy i zbyt długą pracę pompy', async () => {
      await register('C3A1B2C3D41B');
      const post = (payload: Record<string, unknown>) =>
        request(app).post('/api/water-pressure-tank/add?deviceId=C3A1B2C3D41B').send(payload);
      expect((await post({ runId: 1, pumpRunS: -1 })).status).toBe(400);
      expect((await post({ runId: 1, pumpRunS: 90000 })).status).toBe(400);
      expect((await post({ runId: 1.5, pumpRunS: 5 })).status).toBe(400);
      expect((await post({ runId: 1, pumpRunS: 5, compressorEndS: -3 })).status).toBe(400);
    });

    it('odrzuca wiadomość bez runId albo pumpRunS', async () => {
      await register('C3A1B2C3D414');
      const response = await request(app)
        .post('/api/water-pressure-tank/add?deviceId=C3A1B2C3D414')
        .send({ pumpRunS: 5 });
      expect(response.status).toBe(400);
    });

    it('zapisuje czas ręcznej pracy kompresora i odrzuca ujemny', async () => {
      const { body } = await register('C3A1B2C3D415');
      const rootId = body.rootId;
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 5 }, new Date('2026-09-28T09:00:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 400, manualCompressorS: 300 }, new Date('2026-09-28T09:06:35Z'));
      const run = await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean();
      expect(run?.manualSeconds).toBe(300);
      // następna wiadomość bez pola nie kasuje zapisanej wartości
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 401 }, new Date('2026-09-28T09:06:36Z'));
      expect((await WaterPressureTankRunModel.findOne({ rootId, runId: 1 }).lean())?.manualSeconds).toBe(300);

      const bad = await request(app).post('/api/water-pressure-tank/add?deviceId=C3A1B2C3D415')
        .send({ runId: 2, pumpRunS: 5, manualCompressorS: -1 });
      expect(bad.status).toBe(400);
    });

    it('zwraca uruchomienia z zakresu i podsumowania dnia, miesiąca i roku', async () => {
      const { body } = await register('C3A1B2C3D416');
      const rootId = body.rootId;
      // 06:30 czasu warszawskiego (UTC+2) = 04:30Z
      await addWaterPressureTankReport(rootId, { runId: 1, pumpRunS: 60 }, new Date('2026-09-28T04:31:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 2, pumpRunS: 60 }, new Date('2026-09-28T04:45:00Z'));
      await addWaterPressureTankReport(rootId, { runId: 3, pumpRunS: 60 }, new Date('2026-09-02T18:00:00Z'));

      const runs = await request(app).get(`/api/water-pressure-tank/runs?rootId=${rootId}&from=2026-09-28&to=2026-09-28`);
      expect(runs.status).toBe(200);
      expect(runs.body).toHaveLength(2);
      expect(runs.body[0].inProgress).toBe(false);

      const day = await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=day&date=2026-09-28`);
      expect(day.body.buckets).toHaveLength(24);
      expect(day.body.buckets[6].runs).toBe(2);
      expect(day.body.buckets[6].pumpSeconds).toBe(120);
      // bez odczytów wodomierza nie ma przepływu, więc ani wody
      expect(day.body.buckets[6].waterLiters).toBeNull();

      const month = await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=month&date=2026-09-01`);
      expect(month.body.buckets).toHaveLength(30);
      expect(month.body.buckets[27].runs).toBe(2);
      expect(month.body.buckets[1].runs).toBe(1);

      const year = await request(app).get(`/api/water-pressure-tank/summary?rootId=${rootId}&period=year&date=2026-01-01`);
      expect(year.body.buckets).toHaveLength(12);
      expect(year.body.buckets[8].runs).toBe(3);
    });
  });

  describe('wodomierz', () => {
    it('zapisuje odczyty, liczy zużycie okresów i miesięcy, usuwa odczyt', async () => {
      const { body } = await register('C3A1B2C3D420');
      const rootId = body.rootId;
      for (let runId = 1; runId <= 10; runId++) {
        await addWaterPressureTankReport(rootId, { runId, pumpRunS: 60 }, new Date(`2026-09-${10 + runId}T10:00:00Z`));
      }
      await request(app).post(`/api/water-pressure-tank/meter?rootId=${rootId}`)
        .send({ readAt: '2026-09-10T12:00:00Z', valueM3: 100 }).expect(201);
      const second = await request(app).post(`/api/water-pressure-tank/meter?rootId=${rootId}`)
        .send({ readAt: '2026-09-21T12:00:00Z', valueM3: 101.2 });
      expect(second.status).toBe(201);

      const list = await request(app).get(`/api/water-pressure-tank/meter?rootId=${rootId}`);
      expect(list.body).toHaveLength(2);

      const summary = await request(app).get(`/api/water-pressure-tank/meter/summary?rootId=${rootId}&year=2026`);
      expect(summary.body.periods).toHaveLength(1);
      // 1200 l w 600 s pompy → 2 l/s = 120 l/min; szacunek z czasu zgadza się z wodomierzem
      expect(summary.body.periods[0]).toMatchObject({ meterLiters: 1200, pumpSeconds: 600, estimatedLiters: 1200 });
      expect(summary.body.flow.litersPerMinute).toBe(120);
      expect(summary.body.months[8]).toMatchObject({ meterLiters: 1200, estimatedLiters: 1200 });
      expect(summary.body.months[0].meterLiters).toBeNull();

      const removed = await request(app).delete(`/api/water-pressure-tank/meter/${list.body[0]._id}?rootId=${rootId}`);
      expect(removed.status).toBe(200);
    });

    it('bez dwóch odczytów nie liczy zużycia ani przepływu; zły rok i nieznany odczyt', async () => {
      const { body } = await register('C3A1B2C3D422');
      const rootId = body.rootId;
      await request(app).post(`/api/water-pressure-tank/meter?rootId=${rootId}`)
        .send({ readAt: '2026-09-01T08:00:00Z', valueM3: 10 }).expect(201);
      const summary = await request(app).get(`/api/water-pressure-tank/meter/summary?rootId=${rootId}&year=2026`);
      expect(summary.body.periods).toEqual([]);
      expect(summary.body.flow.litersPerMinute).toBeNull();

      expect((await request(app).get(`/api/water-pressure-tank/meter/summary?rootId=${rootId}&year=26`)).status).toBe(400);
      const missing = await request(app).delete(`/api/water-pressure-tank/meter/${new mongoose.Types.ObjectId()}?rootId=${rootId}`);
      expect(missing.status).toBe(404);
      expect((await request(app).delete(`/api/water-pressure-tank/meter/zle-id?rootId=${rootId}`)).status).toBe(400);
    });

    it('nie usuwa odczytu innego urządzenia', async () => {
      const owner = await register('C3A1B2C3D423');
      const other = await register('C3A1B2C3D424');
      const created = await request(app).post(`/api/water-pressure-tank/meter?rootId=${owner.body.rootId}`)
        .send({ readAt: '2026-09-01T08:00:00Z', valueM3: 1 });
      const response = await request(app).delete(`/api/water-pressure-tank/meter/${created.body._id}?rootId=${other.body.rootId}`);
      expect(response.status).toBe(404);
    });

    it('odrzuca odczyt bez daty albo stanu', async () => {
      const { body } = await register('C3A1B2C3D421');
      const response = await request(app).post(`/api/water-pressure-tank/meter?rootId=${body.rootId}`).send({ valueM3: 5 });
      expect(response.status).toBe(400);
    });
  });

  describe('ustawienia hydroforu', () => {
    it('zapisuje czas kompresora i zwraca go sterownikowi przy zgłoszeniu', async () => {
      const { body } = await register('C3A1B2C3D440');
      const saved = await request(app).put(`/api/device/properties?rootId=${body.rootId}`).send({ compressor_seconds: 45 });
      expect(saved.status).toBe(200);
      const again = await register('C3A1B2C3D440');
      expect(again.body.settings).toEqual({ compressor_seconds: 45 });
    });

    it('odrzuca czas kompresora poza 1–3600 s', async () => {
      const { body } = await register('C3A1B2C3D441');
      const put = (properties: Record<string, unknown>) =>
        request(app).put(`/api/device/properties?rootId=${body.rootId}`).send(properties);
      expect((await put({ compressor_seconds: 5000 })).status).toBe(400);
      expect((await put({ compressor_seconds: 0 })).status).toBe(400);
    });

    it('sterownik zmienia czas kompresora', async () => {
      const { body } = await register('C3A1B2C3D442');
      const response = await request(app)
        .put('/api/water-pressure-tank/settings?deviceId=C3A1B2C3D442').send({ compressor_seconds: 55 });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ compressor_seconds: 55 });

      const again = await register('C3A1B2C3D442');
      expect(again.body.rootId).toBe(body.rootId);
      expect(again.body.settings).toEqual({ compressor_seconds: 55 });
    });

    it('czas kompresora ze sterownika: walidacja, 404, 409 i odmowa dla pompy ciepła', async () => {
      const { body } = await register('C3A1B2C3D443');
      const put = (query: string, seconds: unknown) =>
        request(app).put(`/api/water-pressure-tank/settings?${query}`).send({ compressor_seconds: seconds });
      const own = `deviceId=C3A1B2C3D443&rootId=${body.rootId}`;
      expect((await put(own, 0)).status).toBe(400);
      expect((await put(own, 3601)).status).toBe(400);
      expect((await put(own, 12.5)).status).toBe(400);
      expect((await put(own, '30')).status).toBe(400);
      expect((await put('deviceId=C3FFFFFFFFFF', 30)).status).toBe(404);
      expect((await put(`deviceId=C3A1B2C3D444&rootId=${body.rootId}`, 30)).status).toBe(409);

      await request(app).post('/api/devices/register').send({ deviceId: 'A4CF0000AA02', deviceType: 'heat_pump' });
      expect((await put('deviceId=A4CF0000AA02', 30)).status).toBe(404);
    });
  });
});
