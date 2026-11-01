// Strefy taryfy TAURON G12w w czasie warszawskim (ze świętami ustawowymi), niezależnie od strefy komputera.
// Używane przez zakładkę Ogrzewanie strony pogody (tańsza strefa na wykresie 48 h). Bilans energii i koszt pompy
// liczy serwer (server/.../heat-pump/services/energy-balance.service.ts, te same godziny stref i święta); do
// 2026-11-01 był tu też kalkulator kosztu z próbek mocy (energyCostG12w), zastąpiony bilansem godzinowym serwera.
export type G12wZone = "peak" | "offPeak";

const WARSAW_TIME_ZONE = "Europe/Warsaw";

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

type WarsawParts = CalendarDate & {
  hour: number;
  minute: number;
  second: number;
};

const warsawFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: WARSAW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function getWarsawParts(date: Date): WarsawParts {
  const values: Record<string, string> = {};

  for (const part of warsawFormatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function calendarKey(date: CalendarDate): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Algorytm Meeusa/Jonesa/Butchera dla Wielkanocy w kalendarzu gregoriańskim. */
function easterSunday(year: number): CalendarDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return { year, month, day };
}

/** Ustawowo wolne dni w Polsce, istotne dla taryfy G12w. */
function polishPublicHolidayKeys(year: number): Set<string> {
  const easter = easterSunday(year);
  const holidays: CalendarDate[] = [
    { year, month: 1, day: 1 },
    { year, month: 1, day: 6 },
    easter,
    addCalendarDays(easter, 1),
    { year, month: 5, day: 1 },
    { year, month: 5, day: 3 },
    addCalendarDays(easter, 49),
    addCalendarDays(easter, 60),
    { year, month: 8, day: 15 },
    { year, month: 11, day: 1 },
    { year, month: 11, day: 11 },
    { year, month: 12, day: 25 },
    { year, month: 12, day: 26 },
  ];

  // Wigilia jest dniem ustawowo wolnym od pracy od 2025 roku.
  if (year >= 2025) {
    holidays.push({ year, month: 12, day: 24 });
  }

  return new Set(holidays.map(calendarKey));
}

const holidayCache = new Map<number, Set<string>>();

function isPolishPublicHoliday(parts: CalendarDate): boolean {
  let keys = holidayCache.get(parts.year);

  if (!keys) {
    keys = polishPublicHolidayKeys(parts.year);
    holidayCache.set(parts.year, keys);
  }

  return keys.has(calendarKey(parts));
}

/**
 * G12w TAURON:
 * - strefa szczytowa w dni robocze: 06:00-13:00 i 15:00-22:00,
 * - strefa pozaszczytowa w dni robocze: 13:00-15:00 i 22:00-06:00,
 * - soboty, niedziele i święta ustawowe: cała doba poza szczytem.
 */
export function getTauronG12wZone(date: Date): G12wZone {
  const parts = getWarsawParts(date);
  const dayOfWeek = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;

  if (weekend || isPolishPublicHoliday(parts)) {
    return "offPeak";
  }

  const minutes = parts.hour * 60 + parts.minute;
  const peakMorning = minutes >= 6 * 60 && minutes < 13 * 60;
  const peakAfternoon = minutes >= 15 * 60 && minutes < 22 * 60;

  return peakMorning || peakAfternoon ? "peak" : "offPeak";
}
