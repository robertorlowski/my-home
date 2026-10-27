// Endpointy hydroforu (/water-pressure-tank/...): wysyłka sterownika co 1 s, czas
// kompresora ze strony sterownika, uruchomienia, podsumowania wody, przepływ i wodomierz.
// Zakresy dat liczone w czasie warszawskim; logika w services/water-pressure-tank.service.ts.
import { Request, Response } from 'express';
import { fromZonedTime } from 'date-fns-tz';
import {
  addWaterMeterReading, addWaterPressureTankReport, deleteWaterMeterReading, getFlowRate, getWaterMeterSummary,
  getWaterPressureTankRuns, getWaterPressureTankSummary, isCompressorSeconds, listWaterMeterReadings, litersFor,
  pumpSeconds, RUN_IN_PROGRESS_MS, setCompressorSeconds, SummaryPeriod, validateRunReport,
} from '../services/water-pressure-tank.service';
import { TIME_ZONE, warsawDayBoundsUTC } from '../../../core/time';
import { getDeviceProperties } from '../../../core/services/device.service';
import { controllerMeta, logPropertiesChange } from '../../../core/services/operation-log.service';
import { waterPressureTankDeviceType } from '../device-type';

const pad = (value: number) => String(value).padStart(2, '0');
// Północ danego dnia w Warszawie jako chwila UTC (granice miesięcy i lat).
const warsawMidnight = (year: number, month: number, day: number) =>
  fromZonedTime(`${year}-${pad(month)}-${pad(day)}T00:00:00`, TIME_ZONE);

// Wiadomość sterownika co 1 s. Odpowiedź nie niesie ustawień: te sterownik
// dostaje raz na start z POST /devices/register.
export async function addWaterPressureTank(req: Request, res: Response) {
  const report = validateRunReport(req.body);
  if (!report) return res.status(400).json({ message: 'Nieprawidłowe dane uruchomienia.' });

  try {
    await addWaterPressureTankReport(req.deviceRootId as string, report);
    return res.status(201).json({});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}

// Czas kompresora zmieniony na stronie sterownika {compressor_seconds}.
// Sterownik trzyma lokalną zmianę, dopóki jej tu nie wyśle, i do tego czasu nie
// nadpisuje jej wartością z odpowiedzi na zgłoszenie. 404, gdy urządzenie nie jest hydroforem.
export async function updateWaterPressureTankSettings(
  req: Request<{}, {}, { compressor_seconds?: unknown }>,
  res: Response,
) {
  const seconds = req.body?.compressor_seconds;
  if (!isCompressorSeconds(seconds)) {
    return res.status(400).json({ message: 'compressor_seconds: pełne sekundy 1–3600.' });
  }
  try {
    const rootId = req.deviceRootId as string;
    const before = await getDeviceProperties(rootId);
    const saved = await setCompressorSeconds(rootId, seconds);
    if (saved === null) return res.status(404).json({ message: 'Urządzenie nie jest hydroforem.' });
    // dziennik operacji: zmiana na stronie sterownika jest już w nim zapisana (wykonana)
    await logPropertiesChange(rootId, waterPressureTankDeviceType.propertyLabels, before, { ...before, compressor_seconds: saved },
      controllerMeta('Strona sterownika', 'Sekcja „Kompresor” na stronie /install sterownika.'));
    return res.status(200).json({ compressor_seconds: saved });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}

// inProgress: sterownik wysłał wiadomość w ciągu RUN_IN_PROGRESS_MS (pompa pracuje).
// compressorRunning tylko w toku: po utracie zasilania ostatni zapisany stan jest nieaktualny.
const withProgress =<T extends { lastSeenAt?: Date; compressorRunning?: boolean }>(run: T, now: number) => {
  const inProgress = run.lastSeenAt ? now - new Date(run.lastSeenAt).getTime() < RUN_IN_PROGRESS_MS : false;
  return { ...run, inProgress, compressorRunning: inProgress && run.compressorRunning === true };
};

// ?from=YYYY-MM-DD&to=YYYY-MM-DD (dni czasu warszawskiego, to włącznie).
// Uruchomienie należy do zakresu według pumpStart. Każde ma pumpSeconds (efektywny czas
// pompy, bez ręcznej pracy kompresora) i waterLiters (null, dopóki nie ma przepływu).
export async function getWaterPressureTankRunList(req: Request, res: Response) {
  const { from, to } = req.query;
  if (typeof from !== 'string' || typeof to !== 'string') return res.status(400).json({ message: 'Podaj from i to.' });
  const start = warsawDayBoundsUTC(from).startUTC;
  const end = warsawDayBoundsUTC(to).endUTC;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ message: 'Nieprawidłowy zakres dat.' });
  }

  try {
    const now = Date.now();
    const [runs, { litersPerSecond }] = await Promise.all([
      getWaterPressureTankRuns(req.deviceRootId as string, start, end),
      getFlowRate(req.deviceRootId as string),
    ]);
    return res.status(200).json(runs.map((run) => {
      const seconds = Math.round(pumpSeconds(run));
      return { ...withProgress(run, now), pumpSeconds: seconds, waterLiters: litersFor(seconds, litersPerSecond) };
    }));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}

// ?period=day|month|year&date=YYYY-MM-DD: czas pompy i woda w godzinach dnia (24 przedziały),
// dniach miesiąca albo miesiącach roku, zawierających date; flow — przepływ użyty do wody.
export async function getWaterPressureTankSummaryEntry(req: Request, res: Response) {
  const { period, date } = req.query;
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!match || (period !== 'day' && period !== 'month' && period !== 'year')) {
    return res.status(400).json({ message: 'Podaj period=day|month|year i date=YYYY-MM-DD.' });
  }
  const [year, month] = [Number(match[1]), Number(match[2])];

  let from: Date;
  let to: Date;
  let buckets: number;
  if (period === 'day') {
    ({ startUTC: from, endUTC: to } = warsawDayBoundsUTC(date as string));
    // doba zmiany czasu ma 23 lub 25 h; przedziały to godziny zegara (0–23)
    buckets = 24;
  } else if (period === 'month') {
    from = warsawMidnight(year, month, 1);
    to = month === 12 ? warsawMidnight(year + 1, 1, 1) : warsawMidnight(year, month + 1, 1);
    // dzień 0 następnego miesiąca = liczba dni w miesiącu
    buckets = new Date(Date.UTC(year, month, 0)).getUTCDate();
  } else {
    from = warsawMidnight(year, 1, 1);
    to = warsawMidnight(year + 1, 1, 1);
    buckets = 12;
  }

  try {
    const result = await getWaterPressureTankSummary(req.deviceRootId as string, period as SummaryPeriod, from, to, buckets);
    return res.status(200).json({ period, date, ...result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}

// Przepływ pompy [l/min] z odczytów wodomierza i czasu pracy pompy (średnia ważona czasem).
export async function getWaterFlow(req: Request, res: Response) {
  try {
    return res.status(200).json((await getFlowRate(req.deviceRootId as string)).flow);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}

export async function getWaterMeter(req: Request, res: Response) {
  try {
    return res.status(200).json(await listWaterMeterReadings(req.deviceRootId as string));
  } catch (error) {
    return res.status(500).json({ message: String(error) });
  }
}

export async function addWaterMeter(req: Request<{}, {}, { readAt?: string; valueM3?: number; note?: string }>, res: Response) {
  const readAt = new Date(req.body?.readAt ?? '');
  const valueM3 = req.body?.valueM3;
  if (Number.isNaN(readAt.getTime()) || typeof valueM3 !== 'number' || !Number.isFinite(valueM3) || valueM3 < 0) {
    return res.status(400).json({ message: 'Podaj readAt (data) i valueM3 (stan wodomierza w m³).' });
  }
  try {
    const reading = await addWaterMeterReading(req.deviceRootId as string, {
      readAt, valueM3, note: typeof req.body.note === 'string' ? req.body.note : '',
    });
    return res.status(201).json(reading);
  } catch (error) {
    return res.status(400).json({ message: String(error) });
  }
}

export async function deleteWaterMeter(req: Request<{ id: string }>, res: Response) {
  try {
    const deleted = await deleteWaterMeterReading(req.deviceRootId as string, req.params.id);
    return deleted ? res.status(200).json({}) : res.status(404).json({ message: 'Nie znaleziono odczytu.' });
  } catch {
    return res.status(400).json({ message: 'Nieprawidłowy identyfikator odczytu.' });
  }
}

// ?year=YYYY: zużycie z wodomierza w okresach między odczytami i w miesiącach roku,
// z czasem pompy, wodą z przepływu i przepływem. monthStarts: 13 granic (1.01 … 1.01 roku+1).
export async function getWaterMeterSummaryEntry(req: Request, res: Response) {
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'Podaj year=YYYY.' });
  }
  const monthStarts = Array.from({ length: 13 }, (_, index) =>
    index < 12 ? warsawMidnight(year, index + 1, 1) : warsawMidnight(year + 1, 1, 1));
  try {
    return res.status(200).json(await getWaterMeterSummary(req.deviceRootId as string, year, monthStarts));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: String(error) });
  }
}
