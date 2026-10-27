// Telemetria pompy (/hp...): POST /hp/add od sterownika co (zapis + zwrot operacji)
// oraz odczyty dla klienta: bieżący stan, dni z danymi, dane dnia, podsumowanie
// energii i kosztów G12w, ostatni błąd. Dane w kolekcji hp (models/hp.model.ts).
import { Request, Response } from 'express'
import { addHpData, getHpContactAt, getHpDiagnostics, getHpDiagRequest, HpDiagRequest, markHpContact, noteHpDiagnostics, setHpDiagRequest, getHpLastData, getHpAllData, getHpAvailableDates as getCachedHpAvailableDates, getHpLastError } from '../services/hp.service'
import { HpEntry, OperationEntry } from '../types'
import { clearOperation, consumeManualForceOnStart, getOperationData, takeOperationActions } from '../services/operation.service'
import { HpEntryModel } from '../models/hp.model'
import { getFreshPvSummary } from '../services/pv.service'
import { getTemperature, setWeatherFromController } from '../../../core/services/meteo.service'
import { backupWeatherQueries } from '../../../core/services/weather-tile.service'
import { warsawDateRangeBoundsUTC, warsawDayBoundsUTC } from '../../../core/time'
import { firmwareOfferForRoot } from '../../../core/services/firmware.service'
import { systemMeta } from '../../../core/services/operation-log.service'
import { markOperationsDelivered, noteOperationChange } from '../services/hp-operation-log.service'
import { serverBaseUrl } from '../../../core/controllers/firmware.controller'
import { DeviceDocument, DeviceModel } from '../../../core/models/device.model'
import { toControllerOperation } from '../services/controller-contract.service'
import { pumpWorkMode } from '../services/pump-mode.service'
import { getBoilerCoPump } from '../services/cwu-loading.service'
import { sendMessage } from '../../../core/websocket'

// GET /hp: ostatnia telemetria z pamięci podręcznej (surowa, także z polami,
// których schemat nie zapisuje, do restartu serwera) + bieżące PV i pv_power.
export async function getHp(req: Request, res: Response) {
  try {
    console.log("Get HP last data: " + req.deviceRootId as string);
    const rootId = req.deviceRootId as string;
    const result = await getHpLastData(rootId)
    // PV nie przychodzi już z telemetrią HP; bieżący odczyt dołącza serwer.
    const pv = await getFreshPvSummary(rootId);
    // contactAt: ostatnie zgłoszenie co (także bez odczytu z CHPC) — ekran pompy odróżnia brak łączności od wyłączonej pompy
    const contactAt = getHpContactAt(rootId)?.toISOString();
    // diagnostics: liczniki co z ostatniego zgłoszenia (także bez odczytu CHPC), przyrost od ostatniego odczytu CHPC
    const diagnostics = getHpDiagnostics(rootId);
    return res.status(200).send({ ...result, ...(pv ?? {}), ...(contactAt ? { contactAt } : {}), ...(diagnostics ? { diagnostics } : {}) })
  } catch (error) {
    console.log(error)
    return res.status(500).send({ message: error })
  }
}

export async function getHpAll(req: Request, res: Response) {
  try {
    const result = await getHpAllData(req.deviceRootId as string)
    console.log("Get HP all data");
    return res.status(200).send(result)
  } catch (error) {
    console.log(error)
    return res.status(500).send({ message: error })
  }
}

export async function getHpAvailableDates(req: Request, res: Response) {
  try {
    const dates = await getCachedHpAvailableDates(req.deviceRootId as string);
    return res.status(200).json(dates);
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: String(error) });
  }
}

// GET /hp/4day?date= albo ?startDate=&endDate=: rekordy z dni czasu warszawskiego,
// od najnowszego (zakładka Dane, koszty energii w kliencie).
export async function getHp4Day(req: Request, res: Response) {
  try {
    const { date, startDate, endDate } = req.query;
    const isDate = typeof date === "string";
    const isRange = typeof startDate === "string" && typeof endDate === "string";

    if (!isDate && !isRange) {
      return res.status(400).json({ error: "Musisz podać date albo startDate i endDate" });
    }

    const { startUTC: start, endUTC: end } = isRange
      ? warsawDateRangeBoundsUTC(startDate, endDate)
      : warsawDayBoundsUTC(date as string);

    const docs = await HpEntryModel
      .find({ rootId: req.deviceRootId as string, createdAt: { $gte: start, $lt: end } }) // [start, end)
      .sort({ createdAt: -1 })
      .lean<HpEntry>();

    return res.status(200).json(docs);
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: String(error) });
  }
}

// GET /hp/monthly-summary?startDate=&endDate=[&group=day]: energia pompy, PV i sieci
// w miesiącach (albo dniach) czasu warszawskiego oraz koszt zmienny w taryfie G12w.
// Energia to całka trapezowa mocy między kolejnymi rekordami hp (HP.Watts, PV.total_power).
// Nie łączyć tu kolekcji pv ($unionWith, $lookup): Atlas na planie współdzielonym sortuje
// w pamięci najwyżej 32 MB bez allowDiskUse, a rok danych mieści się tylko dzięki
// indeksowi createdAt na hp. Dlatego addHp wpisuje PV.total_power do rekordu hp.
export async function getHpMonthlySummary(req: Request, res: Response) {
  try {
    const { startDate, endDate, group } = req.query;
    if (typeof startDate !== "string" || typeof endDate !== "string") {
      return res.status(400).json({ error: "Musisz podać startDate i endDate" });
    }

    const { startUTC: start } = warsawDayBoundsUTC(startDate);
    const { endUTC: end } = warsawDayBoundsUTC(endDate);
    const groupByDay = group === "day";
    const bucket = groupByDay
      ? { $dayOfMonth: { date: "$createdAt", timezone: "Europe/Warsaw" } }
      : { $month: { date: "$createdAt", timezone: "Europe/Warsaw" } };

    const result = await HpEntryModel.aggregate([
      { $match: { rootId: req.deviceRootId as string, createdAt: { $gte: start, $lt: end } } },
      { $sort: { createdAt: 1 } },
      {
        $setWindowFields: {
          sortBy: { createdAt: 1 },
          output: {
            previousCreatedAt: { $shift: { output: "$createdAt", by: -1 } },
            previousWatts: { $shift: { output: "$HP.Watts", by: -1 } },
            previousPv: { $shift: { output: "$PV.total_power", by: -1 } },
          },
        },
      },
      {
        $set: {
          intervalHours: { $divide: [{ $subtract: ["$createdAt", "$previousCreatedAt"] }, 3600000] },
          bucket,
          localHour: { $hour: { date: "$createdAt", timezone: "Europe/Warsaw" } },
          localDayOfWeek: { $dayOfWeek: { date: "$createdAt", timezone: "Europe/Warsaw" } },
        },
      },
      // odstęp dłuższy niż 15 min to przerwa w danych (sterownik offline): pomijany,
      // żeby nie przypisać ostatniej mocy całej przerwie
      { $match: { intervalHours: { $gt: 0, $lte: 0.25 }, previousWatts: { $gte: 0 } } },
      {
        $set: {
          consumptionWh: { $multiply: [{ $avg: ["$previousWatts", { $ifNull: ["$HP.Watts", 0] }] }, "$intervalHours"] },
          pvWh: { $multiply: [{ $avg: ["$previousPv", { $ifNull: ["$PV.total_power", 0] }] }, "$intervalHours"] },
          // pobór z sieci: nadwyżka poboru pompy nad produkcją PV (nadwyżka PV = 0)
          gridWh: {
            $multiply: [
              { $max: [0, { $avg: [
                { $subtract: ["$previousWatts", { $ifNull: ["$previousPv", 0] }] },
                { $subtract: [{ $ifNull: ["$HP.Watts", 0] }, { $ifNull: ["$PV.total_power", 0] }] },
              ] }] },
              "$intervalHours",
            ],
          },
        },
      },
      {
        // G12w, strefa droga: pon.–pt. ($dayOfWeek 2–6) 6–13 i 15–22 czasu polskiego.
        // Święta nie są tu uwzględniane (w G12w są w strefie taniej).
        $set: {
          peakGridWh: {
            $cond: [
              { $and: [
                { $gte: ["$localDayOfWeek", 2] }, { $lte: ["$localDayOfWeek", 6] },
                { $or: [
                  { $and: [{ $gte: ["$localHour", 6] }, { $lt: ["$localHour", 13] }] },
                  { $and: [{ $gte: ["$localHour", 15] }, { $lt: ["$localHour", 22] }] },
                ] },
              ] },
              "$gridWh",
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$bucket",
          consumptionKWh: { $sum: { $divide: ["$consumptionWh", 1000] } },
          pvGenerationKWh: { $sum: { $divide: ["$pvWh", 1000] } },
          gridEnergyKWh: { $sum: { $divide: ["$gridWh", 1000] } },
          peakGridEnergyKWh: { $sum: { $divide: ["$peakGridWh", 1000] } },
          offPeakGridEnergyKWh: { $sum: { $divide: [{ $subtract: ["$gridWh", "$peakGridWh"] }, 1000] } },
        },
      },
      {
        $project: {
          _id: 0,
          ...(groupByDay ? { day: "$_id" } : { month: "$_id" }),
          consumptionKWh: 1,
          pvGenerationKWh: 1,
          gridEnergyKWh: 1,
          pvUsedKWh: {
            $max: [
              0,
              { $subtract: ["$consumptionKWh", "$gridEnergyKWh"] },
            ],
          },
          // stawki zmienne TAURON G12w [zł/kWh] na stałe: 1.2302 szczyt, 0.6305 poza szczytem;
          // te same w kliencie (devices/heat-pump/utils/energy-cost-g12w.ts), zmieniać razem
          totalVariableCostPLN: {
            $max: [
              { $add: [
                { $multiply: ["$peakGridEnergyKWh", 1.2302] },
                { $multiply: ["$offPeakGridEnergyKWh", 0.6305] },
              ] },
              { $multiply: ["$gridEnergyKWh", 0.6305] },
            ],
          },
        },
      },
      { $sort: groupByDay ? { day: 1 } : { month: 1 } },
    ]);

    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: String(error) });
  }
}

// POST /hp/add: główny punkt wymiany ze sterownikiem co (co 10 s przy pracy
// sprężarki, co 30 s w spoczynku, od razu po komunikacie WebSocket "operation").
// Kolejność ma znaczenie: pobranie operacji -> clearOperation -> consumeManualForceOnStart
// (ustawia operację dla NASTĘPNEJ odpowiedzi) -> zapis telemetrii -> odpowiedź.
// Odpowiedź zawsze niesie operację, także gdy HP jest puste (CHPC nie odpowiada).
// Zapasowa pogoda (co od 1.3.1, core meteo.service): pole weather z telemetrii trafia do pogody kafelków (i nie
// do rekordu ani pamięci telemetrii), a odpowiedź niesie weather_queries z miejscami bez świeżej pogody od włącznika.
export const addHp = async (req: Request<{}, {}, HpEntry>, res: Response) => {
  const data :HpEntry = req.body;
  console.log("Add HP data");

  try {
    const rootId = req.deviceRootId as string;
    markHpContact(rootId);
    const body = data as unknown as Record<string, unknown> | undefined;
    if (body && body.weather !== undefined) {
      setWeatherFromController(body.weather, new Date(), 'co');
      delete body.weather;
    }
    noteHpDiagnostics(rootId, data);
    // akcje jednorazowe (odblokowanie, restart) trafiają do sterownika tylko raz
    const operation: OperationEntry = { ...getOperationData(rootId), ...takeOperationActions(rootId) };
    // Bez ręcznych nadpisań operacja znika do następnego przebiegu schedulera (co 60 s),
    // więc kolejne odpowiedzi niosą {} — co zostaje przy ostatnich wartościach.
    clearOperation(rootId);
    // dziennik operacji: ta odpowiedź niesie operację, więc czekające zmiany są dostarczone
    if (Object.keys(operation).length > 0) await markOperationsDelivered(rootId);
    if (data?.HP) {
      // ręczne force jest jednorazowe: znika po starcie sprężarki (HPS > 0)
      const hps = data.HP.HPS as unknown;
      if (consumeManualForceOnStart(rootId, hps === true || Number(hps) > 0)) {
        await noteOperationChange(rootId, systemMeta('Wymuszenie', 'Sprężarka ruszyła — ręczne wymuszenie startu jest jednorazowe.'));
      }
    }
    console.log("Get HP operation");
    console.log(operation);
    
    // Zapis tylko przy odczycie z CHPC (HP.Ttarget). Uwaga: Ttarget = 0 °C też
    // jest traktowane jak brak odczytu i rekord nie powstaje.
    if (data && data.HP && data.HP.Ttarget) {
      // Sterownik wysyła PV osobno (pv/add). Do rekordu HP trafia tylko moc
      // potrzebna do bilansu energii, z odczytu nie starszego niż 3 min.
      if (!data.PV) {
        const pv = await getFreshPvSummary(rootId);
        if (pv?.PV?.total_power !== undefined) data.PV = { total_power: pv.PV.total_power };
      }
      await addHpData(rootId, data);
    }
    // Temperatura zewnętrzna (czujnik kotła, core meteo.service) na ekran sterownika; poza operacją, bo
    // operacja niesie wyłącznie napisy do zastosowania w pompie.
    const outdoor = getTemperature();
    // oferta OTA {version, url, sha256, request} tylko przy zleceniu „Aktualizuj” (co od 1.1.0)
    const firmware = await firmwareOfferForRoot(rootId, serverBaseUrl(req));
    // co od 1.2.0: work_mode MANUAL / AUTO / OFF, temp_min / temp_max i konfiguracja pompy
    // (controller-contract.service.ts); starsze co dostaje operację bez zmian
    const device = await DeviceModel.findById(rootId).select('firmwareVersion properties pumpConfig').lean<DeviceDocument>();
    const controllerOperation = toControllerOperation(operation, {
      firmwareVersion: device?.firmwareVersion,
      pumpMode: pumpWorkMode(device?.properties?.work_mode),
      pumpConfig: device?.pumpConfig,
      boilerCoPump: getBoilerCoPump(rootId),
    });
    // diag: zlecenie diagnostyki magistrali (PUT /hp/diagnostics, co od 1.2.5); brak pola = wyłączona
    const diag = getHpDiagRequest(rootId)?.request;
    // pogoda jest poboczna: błąd listy miejsc nie może zatrzymać operacji dla pompy (pole wtedy pominięte,
    // co zostawia swoją listę bez zmian)
    const weatherQueries = await backupWeatherQueries().catch(() => null);
    return res.status(201).json({
      operation: controllerOperation,
      ...(typeof outdoor === 'number' && Number.isFinite(outdoor) ? { t_out: outdoor } : {}),
      ...(firmware ? { firmware } : {}),
      ...(diag ? { diag } : {}),
      ...(weatherQueries ? { weather_queries: weatherQueries } : {}),
    });
  } catch (error) {
    return res.status(500).send({ error: error })
  }
}

// GET /hp/diagnostics: liczniki co z ostatniego zgłoszenia, zrzuty (co 1.2.5) i zlecenie diagnostyki; {} bez danych.
export const getDiagnostics = (req: Request, res: Response) =>
  res.status(200).json(getHpDiagnostics(req.deviceRootId as string) ?? {});

const DIAG_MINUTES_DEFAULT = 60;
const DIAG_MINUTES_MAX = 24 * 60;
const flag = (value: unknown) => value === true || value === 1 || value === '1' ? 1 : value === undefined || value === false || value === 0 || value === '0' ? 0 : null;

// PUT /hp/diagnostics {hp_raw?, bus_sniff?, hp_timeout_s?, minutes?}: zlecenie diagnostyki magistrali dla co
// (bus_diagnostics.hpp): zrzut nieudanej odpowiedzi CHPC, zrzut ramek nieoczekiwanych, dłuższy timeout odczytu
// CHPC (3–15 s, 0 = domyślny). Działa przez minutes (1–1440, domyślnie 60), potem samo wygasa. Wszystko
// wyłączone = odwołanie. WebSocket "operation" budzi co, żeby dostał zlecenie od razu.
export const putDiagnostics = (req: Request<{}, {}, Record<string, unknown>>, res: Response) => {
  const body = req.body ?? {};
  const hpRaw = flag(body.hp_raw);
  const busSniff = flag(body.bus_sniff);
  const timeout = body.hp_timeout_s === undefined ? 0 : Number(body.hp_timeout_s);
  const minutes = body.minutes === undefined ? DIAG_MINUTES_DEFAULT : Number(body.minutes);
  if (hpRaw === null || busSniff === null) return res.status(400).json({ message: 'hp_raw i bus_sniff: 0 albo 1.' });
  if (!Number.isInteger(timeout) || (timeout !== 0 && (timeout < 3 || timeout > 15))) {
    return res.status(400).json({ message: 'hp_timeout_s: 0 albo liczba całkowita 3–15.' });
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > DIAG_MINUTES_MAX) {
    return res.status(400).json({ message: `minutes: liczba całkowita 1–${DIAG_MINUTES_MAX}.` });
  }
  const rootId = req.deviceRootId as string;
  const request: HpDiagRequest = { hp_raw: hpRaw, bus_sniff: busSniff, hp_timeout_s: timeout };
  const active = hpRaw === 1 || busSniff === 1 || timeout !== 0;
  setHpDiagRequest(rootId, active ? request : null, active ? new Date(Date.now() + minutes * 60_000) : undefined);
  sendMessage('operation', rootId);
  return res.status(200).json(getHpDiagnostics(rootId) ?? { request: null });
}

// GET /hp/last-error: rekord z error_code z 24 h albo bez limitu przy blokadzie
// (ERRc >= 5); {} gdy brak. Szczegóły w getHpLastError.
export const getLastError = async (req: Request, res: Response) => {
  try {
    const doc = await getHpLastError(req.deviceRootId as string);
    return res.status(200).json(doc);
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: String(error) });
  }
}

