// Logika hydroforu: zapis wiadomości sterownika jako uruchomień pompy (daty liczone
// z zegara serwera), przepływ pompy z odczytów wodomierza, woda z czasu pracy pompy,
// podsumowania i wodomierz.
//
// Woda nie jest zapisywana w rekordach: liczy się ją przy odczycie jako
// efektywny czas pracy pompy × przepływ. Efektywny czas = pumpEnd − pumpStart minus
// czas ręcznego włączenia kompresora (manualSeconds), bo wtedy pompa nie tłoczy wody
// do odbioru. Przepływ [l/s] = suma litrów z wodomierza / suma efektywnego czasu
// pompy ze wszystkich okresów między kolejnymi odczytami (średnia ważona czasem),
// więc każdy nowy odczyt poprawia też wodę w historii. Przed drugim odczytem
// przepływu nie ma i woda jest null.
import { DeviceType } from '../../../core/types';
import { WaterMeterReading, WaterPressureTankRun } from '../types';
import { DeviceModel } from '../../../core/models/device.model';
import { WaterMeterReadingModel } from '../models/water-meter.model';
import { WaterPressureTankRunModel } from '../models/water-pressure-tank-run.model';
import { getDeviceInfo } from '../../../core/services/device-info.service';
import { TIME_ZONE } from '../../../core/time';
import { notify } from '../../../core/services/push.service';
import { texts } from '../../../core/i18n';

// Uruchomienie jest „w toku”, gdy ostatnia wiadomość sterownika (co 1 s) jest młodsza.
export const RUN_IN_PROGRESS_MS = 5000;

// ten sam limit w schemacie properties (core/models/device.model.ts) i w firmware
export const MAX_COMPRESSOR_SECONDS = 3600;

export const isCompressorSeconds = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_COMPRESSOR_SECONDS;

// Czas kompresora ustawiony na stronie sterownika. Zmienia tylko to jedno pole.
export async function setCompressorSeconds(rootId: string, seconds: number): Promise<number | null> {
  const device = await DeviceModel.findOneAndUpdate(
    { _id: rootId, deviceType: DeviceType.WATER_PRESSURE_TANK },
    { $set: { 'properties.compressor_seconds': seconds } },
    { new: true },
  ).select('properties.compressor_seconds').lean();
  return device?.properties?.compressor_seconds ?? null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

// Efektywny czas pracy pompy [s]: od startu do ostatniej wiadomości, bez ręcznej pracy kompresora.
export const pumpSeconds = (run: Pick<WaterPressureTankRun, 'pumpStart' | 'pumpEnd' | 'manualSeconds'>) =>
  Math.max(0, (new Date(run.pumpEnd).getTime() - new Date(run.pumpStart).getTime()) / 1000 - (run.manualSeconds ?? 0));

// To samo w agregacji MongoDB (podsumowania).
const PUMP_SECONDS_EXPR = {
  $max: [0, {
    $subtract: [
      { $divide: [{ $subtract: ['$pumpEnd', '$pumpStart'] }, 1000] },
      { $ifNull: ['$manualSeconds', 0] },
    ],
  }],
};

// litry z czasu i przepływu; null, gdy przepływu jeszcze nie ma
export const litersFor = (seconds: number, litersPerSecond: number | null) =>
  litersPerSecond === null ? null : round1(seconds * litersPerSecond);

// Treść POST /water-pressure-tank/add: czasy w sekundach od startu sterownika
// (= startu pompy, bo sterownik ma zasilanie tylko w czasie jej pracy). queued —
// uruchomienie z kolejki NVS, z którego wcześniej nie doszła żadna wiadomość.
// manualCompressorS — łączny czas ręcznego włączenia kompresora („Włącz” na stronie
// sterownika) w tym uruchomieniu; odejmowany od czasu pracy pompy.
export interface RunReport {
  runId: number;
  pumpRunS: number;
  compressorStartS?: number;
  compressorEndS?: number;
  restarts?: number;
  manualCompressorS?: number;
  queued?: boolean;
}

const isNonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// null dla danych bez sensu (kontroler odpowiada 400); pumpRunS najwyżej doba.
export function validateRunReport(body: unknown): RunReport | null {
  const data = body as Partial<RunReport> | undefined;
  if (!data || !Number.isInteger(data.runId) || (data.runId as number) < 0) return null;
  if (!isNonNegative(data.pumpRunS) || (data.pumpRunS as number) > 24 * 3600) return null;
  for (const key of ['compressorStartS', 'compressorEndS', 'restarts', 'manualCompressorS'] as const) {
    if (data[key] !== undefined && data[key] !== null && !isNonNegative(data[key])) return null;
  }
  return {
    runId: data.runId as number,
    pumpRunS: data.pumpRunS as number,
    compressorStartS: data.compressorStartS ?? undefined,
    compressorEndS: data.compressorEndS ?? undefined,
    restarts: data.restarts ?? undefined,
    manualCompressorS: data.manualCompressorS ?? undefined,
    queued: data.queued === true,
  };
}

const plusSeconds = (base: Date, seconds: number | undefined) =>
  seconds === undefined ? undefined : new Date(base.getTime() + seconds * 1000);

// Zapis wiadomości sterownika. Sterownik nie ma zegara: czasy są względne
// (sekundy od startu), a daty wylicza serwer z chwili odebrania. Pierwsza
// wiadomość uruchomienia ustala pumpStart; kolejne przesuwają pumpEnd, więc
// ostatnia przed utratą zasilania wyznacza koniec pracy pompy.
export async function addWaterPressureTankReport(rootId: string, report: RunReport, receivedAt = new Date()) {
  const device = await getDeviceInfo(rootId);
  const existing = await WaterPressureTankRunModel.findOne({ rootId, runId: report.runId }).lean<WaterPressureTankRun>();

  // pumpStart ustala tylko pierwsza wiadomość; opóźnienie sieci przesuwa go o ułamek sekundy
  const pumpStart = existing?.pumpStart
    ?? new Date(receivedAt.getTime() - report.pumpRunS * 1000);
  // Z kolejki przychodzi uruchomienie zakończone dawno: koniec z czasu pracy,
  // na żywo — chwila odebrania. Dla nowego rekordu z kolejki obie daty wypadają więc
  // tuż przed chwilą przyjęcia (timeApproximate). Istniejącego rekordu kolejka w praktyce
  // nie dotyczy: firmware nie kolejkuje uruchomień, z których doszła choć jedna wiadomość.
  const pumpEnd = report.queued ? plusSeconds(pumpStart, report.pumpRunS)! : receivedAt;

  const update: Partial<WaterPressureTankRun> = {
    pumpEnd,
    lastSeenAt: receivedAt,
    compressorStart: plusSeconds(pumpStart, report.compressorStartS) ?? existing?.compressorStart,
    compressorEnd: plusSeconds(pumpStart, report.compressorEndS) ?? existing?.compressorEnd,
    // sterownik wysyła compressorEndS dopiero po wyłączeniu (także po ponownym uruchomieniu)
    compressorRunning: !report.queued && report.compressorStartS !== undefined && report.compressorEndS === undefined,
    restarts: report.restarts ?? existing?.restarts ?? 0,
    manualSeconds: report.manualCompressorS ?? existing?.manualSeconds ?? 0,
  };

  if (existing) {
    await WaterPressureTankRunModel.updateOne({ _id: (existing as { _id?: unknown })._id }, { $set: update });
    forgetTankTileData(rootId);
    return { ...existing, ...update };
  }

  const created = await WaterPressureTankRunModel.create({
    rootId,
    deviceType: device.deviceType ?? DeviceType.WATER_PRESSURE_TANK,
    deviceId: device.deviceId,
    runId: report.runId,
    pumpStart,
    ...update,
    timeApproximate: report.queued === true,
  });
  forgetTankTileData(rootId);
  // powiadomienie Web Push (core/services/push.service.ts): nowe uruchomienie na żywo (z kolejki = dawno zakończone)
  if (!report.queued) await notify(rootId, 'pump-start', { body: texts('push.pumpStart'), url: '/' }, receivedAt);
  return created.toObject();
}

// Uruchomienia z pumpStart w [from, to), od najstarszego.
export const getWaterPressureTankRuns = (rootId: string, from: Date, to: Date) =>
  WaterPressureTankRunModel
    .find({ rootId, pumpStart: { $gte: from, $lt: to } })
    .sort({ pumpStart: 1 })
    .lean<WaterPressureTankRun[]>();

// --- wodomierz i przepływ ---

export const listWaterMeterReadings = (rootId: string) =>
  WaterMeterReadingModel.find({ rootId }).sort({ readAt: 1 }).lean<(WaterMeterReading & { _id: unknown })[]>();

export async function addWaterMeterReading(rootId: string, reading: { readAt: Date; valueM3: number; note?: string }) {
  const created = await WaterMeterReadingModel.create({ rootId, ...reading });
  forgetTankTileData(rootId);
  return created.toObject();
}

export async function deleteWaterMeterReading(rootId: string, id: string) {
  const result = await WaterMeterReadingModel.deleteOne({ _id: id, rootId });
  forgetTankTileData(rootId);
  return result.deletedCount > 0;
}

const sumPumpSeconds = (runs: WaterPressureTankRun[], from: Date, to: Date) =>
  runs
    .filter((run) => run.pumpStart >= from && run.pumpStart < to)
    .reduce((total, run) => total + pumpSeconds(run), 0);

export interface MeterPeriod {
  from: Date;
  to: Date;
  meterLiters: number;
  pumpSeconds: number;
  /** woda z czasu pompy i przepływu ze wszystkich okresów; null bez przepływu */
  estimatedLiters: number | null;
}

export interface FlowRate {
  /** przepływ pompy [l/min]; null, gdy brak okresu z wodomierza i pracą pompy */
  litersPerMinute: number | null;
  /** liczba okresów między odczytami, z których policzono przepływ */
  periods: number;
  meterLiters: number;
  pumpSeconds: number;
}

interface FlowData {
  readings: (WaterMeterReading & { _id: unknown })[];
  runs: WaterPressureTankRun[];
  periods: MeterPeriod[];
  flow: FlowRate;
  litersPerSecond: number | null;
}

// Okresy między kolejnymi odczytami i przepływ ważony czasem. Okres bez pracy
// pompy (sama zmiana wodomierza) albo z ujemnym przyrostem (pomyłka w odczycie)
// nie wchodzi do przepływu.
async function loadFlow(rootId: string): Promise<FlowData> {
  const readings = await listWaterMeterReadings(rootId);
  const none: FlowRate = { litersPerMinute: null, periods: 0, meterLiters: 0, pumpSeconds: 0 };
  if (readings.length < 2) return { readings, runs: [], periods: [], flow: none, litersPerSecond: null };

  const runs = await getWaterPressureTankRuns(rootId, readings[0].readAt, readings[readings.length - 1].readAt);
  const raw = readings.slice(1).map((reading, index) => {
    const previous = readings[index];
    return {
      from: previous.readAt,
      to: reading.readAt,
      meterLiters: round1((reading.valueM3 - previous.valueM3) * 1000),
      pumpSeconds: Math.round(sumPumpSeconds(runs, previous.readAt, reading.readAt)),
    };
  });
  const usable = raw.filter((period) => period.pumpSeconds > 0 && period.meterLiters >= 0);
  const liters = usable.reduce((total, period) => total + period.meterLiters, 0);
  const seconds = usable.reduce((total, period) => total + period.pumpSeconds, 0);
  const litersPerSecond = seconds > 0 ? liters / seconds : null;
  return {
    readings,
    runs,
    litersPerSecond,
    periods: raw.map((period) => ({ ...period, estimatedLiters: litersFor(period.pumpSeconds, litersPerSecond) })),
    flow: {
      litersPerMinute: litersPerSecond === null ? null : round1(litersPerSecond * 60),
      periods: usable.length,
      meterLiters: round1(liters),
      pumpSeconds: seconds,
    },
  };
}

export async function getFlowRate(rootId: string): Promise<{ flow: FlowRate; litersPerSecond: number | null }> {
  const { flow, litersPerSecond } = await loadFlow(rootId);
  return { flow, litersPerSecond };
}

// --- dane kafelka listy w pamięci (2026-10-29, limit transferu Render 5 GB) ---
// Kafelki liczy co minutę wartownik powiadomień (push-watchdog.service) i co 30 s lista w przeglądarce, a kafelek
// hydroforu czytał za każdym razem uruchomienia z miesiąca i okresy wodomierza (ok. 35 KB z bazy). Te dane zmieniają
// się tylko przy wiadomości sterownika i zmianie odczytów wodomierza (forgetTankTileData), więc są w pamięci do
// takiej zmiany albo do nowego dnia. generation chroni przed zapamiętaniem danych, które zmieniły się w trakcie odczytu.
export interface TankTileData {
  last: WaterPressureTankRun | null;
  monthRuns: WaterPressureTankRun[];
  flow: FlowRate;
  litersPerSecond: number | null;
}
const tankTileData = new Map<string, { day: string; data: TankTileData }>();
const tankTileGeneration = new Map<string, number>();

export function forgetTankTileData(rootId: string) {
  tankTileData.delete(rootId);
  tankTileGeneration.set(rootId, (tankTileGeneration.get(rootId) ?? 0) + 1);
}

// day: dzień warszawski (YYYY-MM-DD), monthStart i dayEnd jego granice w UTC
export async function getTankTileData(rootId: string, day: string, monthStart: Date, dayEnd: Date): Promise<TankTileData> {
  const cached = tankTileData.get(rootId);
  if (cached && cached.day === day) return cached.data;
  const generation = tankTileGeneration.get(rootId) ?? 0;
  const [last, monthRuns, { flow, litersPerSecond }] = await Promise.all([
    WaterPressureTankRunModel.findOne({ rootId }).sort({ pumpStart: -1 }).lean<WaterPressureTankRun>(),
    getWaterPressureTankRuns(rootId, monthStart, dayEnd),
    getFlowRate(rootId),
  ]);
  const data = { last: last ?? null, monthRuns, flow, litersPerSecond };
  if ((tankTileGeneration.get(rootId) ?? 0) === generation) tankTileData.set(rootId, { day, data });
  return data;
}

export type SummaryPeriod = 'day' | 'month' | 'year';

export interface SummaryBucket {
  key: number;
  pumpSeconds: number;
  waterLiters: number | null;
  runs: number;
}

// Czas pracy pompy i woda z uruchomień w przedziale [from, to), w godzinach (day),
// dniach miesiąca (month) albo miesiącach (year) czasu warszawskiego. Puste
// przedziały są uzupełniane zerami, więc klient rysuje oś bez dziur.
export async function getWaterPressureTankSummary(
  rootId: string, period: SummaryPeriod, from: Date, to: Date, bucketCount: number,
): Promise<{ buckets: SummaryBucket[]; flow: FlowRate }> {
  const bucket = period === 'day'
    ? { $hour: { date: '$pumpStart', timezone: TIME_ZONE } }
    : period === 'month'
      ? { $dayOfMonth: { date: '$pumpStart', timezone: TIME_ZONE } }
      : { $month: { date: '$pumpStart', timezone: TIME_ZONE } };

  const [rows, { flow, litersPerSecond }] = await Promise.all([
    WaterPressureTankRunModel.aggregate<{ _id: number; pumpSeconds: number; runs: number }>([
      { $match: { rootId, pumpStart: { $gte: from, $lt: to } } },
      { $group: { _id: bucket, pumpSeconds: { $sum: PUMP_SECONDS_EXPR }, runs: { $sum: 1 } } },
    ]),
    getFlowRate(rootId),
  ]);
  const byKey = new Map(rows.map((row) => [row._id, row]));
  const first = period === 'day' ? 0 : 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const key = first + index;
    const row = byKey.get(key);
    const seconds = Math.round(row?.pumpSeconds ?? 0);
    return { key, pumpSeconds: seconds, waterLiters: litersFor(seconds, litersPerSecond), runs: row?.runs ?? 0 };
  });
  return { buckets, flow };
}

// Zużycie między kolejnymi odczytami i w miesiącach roku. Stan wodomierza
// między odczytami jest interpolowany liniowo, więc okres rozciągnięty na
// dwa miesiące dzieli się proporcjonalnie do czasu. Miesiące poza zakresem
// odczytów mają null; czas pompy liczony tylko w części miesiąca pokrytej odczytami.
export async function getWaterMeterSummary(rootId: string, year: number, monthStarts: Date[]) {
  const { readings, runs, periods, flow, litersPerSecond } = await loadFlow(rootId);
  if (readings.length < 2) return { year, periods: [] as MeterPeriod[], months: [], flow };

  const first = readings[0].readAt;
  const last = readings[readings.length - 1].readAt;
  const meterAt = (time: Date) => {
    for (let index = 1; index < readings.length; index++) {
      const previous = readings[index - 1];
      const next = readings[index];
      if (time <= next.readAt) {
        const span = next.readAt.getTime() - previous.readAt.getTime();
        const ratio = span > 0 ? (time.getTime() - previous.readAt.getTime()) / span : 1;
        return previous.valueM3 + (next.valueM3 - previous.valueM3) * ratio;
      }
    }
    return readings[readings.length - 1].valueM3;
  };

  const months = monthStarts.slice(0, -1).map((monthStart, index) => {
    const monthEnd = monthStarts[index + 1];
    const from = monthStart > first ? monthStart : first;
    const to = monthEnd < last ? monthEnd : last;
    if (to <= from) return { month: index + 1, meterLiters: null, estimatedLiters: null };
    return {
      month: index + 1,
      meterLiters: round1((meterAt(to) - meterAt(from)) * 1000),
      estimatedLiters: litersFor(sumPumpSeconds(runs, from, to), litersPerSecond),
    };
  });

  return { year, periods, months, flow };
}
