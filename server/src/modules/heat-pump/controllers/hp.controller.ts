// Telemetria pompy (/hp...): POST /hp/add od sterownika co (zapis + zwrot operacji)
// oraz odczyty dla klienta: bieżący stan, dni z danymi, dane dnia, podsumowanie
// energii i kosztów G12w, ostatni błąd. Dane w kolekcji hp (models/hp.model.ts).
import { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { addHpData, getHpContactAt, getHpDiagnostics, getHpDiagRequest, HpDiagRequest, markHpContact, noteHpDiagnostics, setHpDiagRequest, getHpLastData, hpAllDataCursor, jsonArrayChunks, getHpAvailableDates as getCachedHpAvailableDates, getHpLastError } from '../services/hp.service'
import { HpEntry, OperationEntry } from '../types'
import { clearOperation, consumeManualForceOnStart, getOperationData, takeOperationActions } from '../services/operation.service'
import { HpEntryModel } from '../models/hp.model'
import { getFreshPvSummary } from '../services/pv.service'
import { energyBalance } from '../services/energy-balance.service'
import { getTemperature } from '../../../core/services/meteo.service'
import { warsawDateRangeBoundsUTC, warsawDayBoundsUTC } from '../../../core/time'
import { firmwareOfferForRoot } from '../../../core/services/firmware.service'
import { systemMeta } from '../../../core/services/operation-log.service'
import { markOperationsDelivered, noteOperationChange } from '../services/hp-operation-log.service'
import { serverBaseUrl } from '../../../core/controllers/firmware.controller'
import { cachedDeviceById } from '../../../core/services/device-cache.service'
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

// Eksport strumieniem, żeby pamięć serwera nie zależała od liczby rekordów. Odczyt pierwszego rekordu przed
// nagłówkami: błąd bazy daje jeszcze 500, a późniejszy tylko przerywa odpowiedź, więc klient nie dostanie uciętego JSON-u jako poprawnego.
export async function getHpAll(req: Request, res: Response) {
  let cursor: ReturnType<typeof hpAllDataCursor> | undefined
  try {
    cursor = hpAllDataCursor(req.deviceRootId as string)
    const first = await cursor.next()
    console.log("Get HP all data");
    res.status(200).type('application/json')
    await pipeline(Readable.from(jsonArrayChunks(first, cursor)), res)
  } catch (error) {
    console.log(error)
    if (!res.headersSent) return res.status(500).send({ message: String(error) })
    res.destroy()
  } finally {
    await cursor?.close().catch(() => undefined)
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

// GET /hp/monthly-summary?startDate=&endDate=[&group=month|day|hour]: energia pompy, PV i sieci po bilansowaniu
// godzinowym (jak licznik dystrybutora) w miesiącach, dobach (z date) albo godzinach (hour, dla widoku dnia
// i „Energii dziś”) czasu warszawskiego oraz koszt zmienny w taryfie G12w. Opis i źródła: energy-balance.service.ts.
export async function getHpMonthlySummary(req: Request, res: Response) {
  try {
    const { startDate, endDate, group } = req.query;
    if (typeof startDate !== "string" || typeof endDate !== "string") {
      return res.status(400).json({ error: "Musisz podać startDate i endDate" });
    }
    const { startUTC: start } = warsawDayBoundsUTC(startDate);
    const { endUTC: end } = warsawDayBoundsUTC(endDate);
    const balanceGroup = group === "day" || group === "hour" ? group : "month";
    return res.status(200).json(await energyBalance(req.deviceRootId as string, start, end, balanceGroup));
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
// Zapasowa pogoda przez co (1.3.1–1.3.4, weather_queries w odpowiedzi i pole weather w telemetrii) usunięta
// 2026-11-13: pogodę pobiera tylko serwer. Pole weather od starszego co jest pomijane (bez zapisu
// w rekordzie i w pamięci telemetrii); bez weather_queries starszy co zostaje przy swojej liście, w praktyce pustej.
export const addHp = async (req: Request<{}, {}, HpEntry>, res: Response) => {
  const data :HpEntry = req.body;
  console.log("Add HP data");

  try {
    const rootId = req.deviceRootId as string;
    markHpContact(rootId);
    const body = data as unknown as Record<string, unknown> | undefined;
    if (body && body.weather !== undefined) delete body.weather;
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
    // z pamięci dokumentów urządzeń (zapis ustawień i konfiguracji pompy ją kasuje)
    const device = await cachedDeviceById(rootId);
    const controllerOperation = toControllerOperation(operation, {
      firmwareVersion: device?.firmwareVersion,
      pumpMode: pumpWorkMode(device?.properties?.work_mode),
      pumpConfig: device?.pumpConfig,
      boilerCoPump: getBoilerCoPump(rootId),
    });
    // diag: zlecenie diagnostyki magistrali (PUT /hp/diagnostics, co od 1.2.5); brak pola = wyłączona
    const diag = getHpDiagRequest(rootId)?.request;
    return res.status(201).json({
      operation: controllerOperation,
      ...(typeof outdoor === 'number' && Number.isFinite(outdoor) ? { t_out: outdoor } : {}),
      ...(firmware ? { firmware } : {}),
      ...(diag ? { diag } : {}),
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

