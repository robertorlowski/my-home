// Dziennik alarmów kotła (od firmware pieca 1.7.0): walidacja przesłania sterownika, przeliczenie czasu ecoMAX
// i zapis bez powtórzeń; odczyt dla aplikacji (karta „Alarmy” w Ustawieniach, strona /alarms, pasek na stronie
// głównej). Nazwy kodów są w kliencie (utils/alerts.ts, za PyPlumIO const.py AlertType).
//
// Czas w dzienniku to sekundy od 2000-01-01 w kalendarzu ecoMAX: rok = 12 × 31 dni, miesiąc = 31 dni (PyPlumIO
// structures/alerts.py, seconds_to_datetime), w czasie lokalnym regulatora (Polska). Rok < 2020 = zegar regulatora
// jeszcze nieustawiony (na nagraniu 2026-10-03 wpisy z 2018 po zanikach zasilania) — „data niepewna”.
import { fromZonedTime } from 'date-fns-tz';
import { TIME_ZONE } from '../../../core/time';
import { PelletBoilerAlertEntry, PelletBoilerAlertModel } from '../models/pellet-boiler-pelux200-alert.model';

const MAX_ENTRIES = 100;
const UNCERTAIN_BEFORE_YEAR = 2020;

export class AlertsError extends Error {}

export type AlertsUpload = { total: number; alerts: { i: number; code: number; from: number; to: number | null }[] };

const isUInt = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

export function validateAlertsUpload(body: unknown): AlertsUpload {
  const source = body as Partial<AlertsUpload> | undefined;
  if (!source || !isUInt(source.total, 255) || !Array.isArray(source.alerts) || source.alerts.length > MAX_ENTRIES) {
    throw new AlertsError('total: 0–255, alerts: najwyżej 100 wpisów');
  }
  for (const alert of source.alerts) {
    if (!isUInt(alert?.i, MAX_ENTRIES - 1) || !isUInt(alert.code, 255) || !isUInt(alert.from, 0xFFFFFFFE)
      || !(alert.to === null || isUInt(alert.to, 0xFFFFFFFE))) {
      throw new AlertsError('alert: {i, code 0–255, from, to | null}');
    }
  }
  return source as AlertsUpload;
}

// Sekundy ecoMAX → składowe daty (rok, miesiąc 1–12, dzień 1–31, godzina, minuta, sekunda).
export function ecomaxTimeParts(seconds: number) {
  const units: [number, number][] = [[372 * 86400, 2000], [31 * 86400, 1], [86400, 1], [3600, 0], [60, 0], [1, 0]];
  let rest = seconds;
  return units.map(([size, offset]) => {
    const value = Math.floor(rest / size);
    rest -= value * size;
    return value + offset;
  });
}

// Sekundy ecoMAX → chwila (UTC) z czasu lokalnego regulatora; dzień spoza miesiąca (np. 31 listopada) przechodzi
// na następny, jak w kalendarzu Date.
export function ecomaxTimeToDate(seconds: number): Date {
  const [year, month, day, hour, minute, second] = ecomaxTimeParts(seconds);
  return fromZonedTime(new Date(year, month - 1, day, hour, minute, second), TIME_ZONE);
}

// Zapis przesłania: nowy alarm (rootId + kod + początek) albo uzupełnienie końca. Pierwsze przesłanie dla rootId
// oznacza wpisy jako initial.
export async function saveAlerts(rootId: string, upload: AlertsUpload, now = new Date()) {
  const initial = (await PelletBoilerAlertModel.countDocuments({ rootId })) === 0;
  for (const alert of upload.alerts) {
    const from = ecomaxTimeToDate(alert.from);
    await PelletBoilerAlertModel.updateOne(
      { rootId, code: alert.code, fromRaw: alert.from },
      {
        $set: {
          toRaw: alert.to,
          to: alert.to === null ? null : ecomaxTimeToDate(alert.to),
          seenAt: now,
        },
        $setOnInsert: {
          from,
          uncertain: ecomaxTimeParts(alert.from)[0] < UNCERTAIN_BEFORE_YEAR,
          initial,
        },
      },
      { upsert: true },
    );
  }
  return { saved: upload.alerts.length, initial };
}

// Lista dla aplikacji: najpierw trwające, potem od najnowszego. Trwający = bez końca w ostatnim przesłaniu
// (wpis, który zniknął z dziennika panelu, nie jest już „trwający”).
// Aktywne alarmy (bez końca i w ostatnim odczycie dziennika, jak active w listAlerts), od najnowszego, same kody.
// Dla kafelka listy (tile.ts), liczonego co minutę: dwa małe zapytania zamiast całego dziennika (do 100 wpisów,
// ok. 21 KB z bazy; 2026-10-29, limit transferu Render).
export async function listActiveAlertCodes(rootId: string): Promise<number[]> {
  const latest = await PelletBoilerAlertModel.findOne({ rootId }).sort({ seenAt: -1 }).select({ seenAt: 1 }).lean<{ seenAt: Date }>();
  if (!latest) return [];
  const active = await PelletBoilerAlertModel.find({ rootId, toRaw: null, seenAt: latest.seenAt })
    .sort({ from: -1 }).select({ code: 1 }).lean<{ code: number }[]>();
  return active.map((alert) => alert.code);
}

export async function listAlerts(rootId: string) {
  const all = await PelletBoilerAlertModel.find({ rootId }).sort({ from: -1 }).lean<(PelletBoilerAlertEntry & { _id: unknown })[]>();
  const readAt = all.reduce<Date | null>((latest, a) => (!latest || a.seenAt > latest ? a.seenAt : latest), null);
  const alerts = all.map((a) => ({
    code: a.code,
    from: a.from,
    to: a.to,
    active: a.toRaw === null && !!readAt && a.seenAt.getTime() === readAt.getTime(),
    uncertain: a.uncertain,
    initial: a.initial,
  }));
  alerts.sort((x, y) => Number(y.active) - Number(x.active));
  return { readAt, alerts };
}
