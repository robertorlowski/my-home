// Pobieranie i spłaszczanie telemetrii dla zakładek Dane i Wykres, czas pracy sprężarki z rekordów i pomocnicze formaty dat.
import { HpRequests } from "../api";
import { THPL } from "../types";

// Data w formacie YYYY.MM.DD (jak time z co i lista GET /hp/dates), w strefie przeglądarki.
export const formatDateYMD = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
};

// Rekordy z GET /hp/4day (dzień albo zakres) jako wiersze THPL, od najnowszego. allData = false
// zostawia tylko pracę sprężarki (HPS === true) i rekordy z błędem. Porównanie ścisłe działa, bo
// schemat Mongo zapisuje HPS jako Boolean (0/1 z CHPC zamienia na false/true).
export const fetchData = async (
  allData: boolean,
  selectedDate: string,
  endDate?: string,
): Promise<THPL[]> => {
  const json = await HpRequests.getHpData4Day(selectedDate, endDate);
  return (json ?? [])
    // rekord z błędem sterownika zostaje także przy filtrze pracy sprężarki
    .filter(row => allData || row?.HP?.HPS === true || (row?.error_code ?? 0) > 0)
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .map<THPL>(row => ({
      ...(row.HP as THPL),
      time: row.time,
      work_mode: row.work_mode,
      pv: row.PV?.total_power,
      t_out: row.t_out,
      error_code: row.error_code
    }));
}

export const fetchMonthlySummary = (
  startDate: string,
  endDate: string,
  group: 'month' | 'day' = 'month',
) => HpRequests.getHpMonthlySummary(startDate, endDate, group);

// Czas pracy sprężarki z rekordów dnia: suma odstępów między kolejnymi rekordami z HPS (co 10 s w czasie pracy),
// odstęp dłuższy niż minuta liczony jako minuta (przerwa między cyklami albo luka w danych). Przybliżenie 10–30 s.
export const compressorSeconds = (rows: THPL[]): number => {
  const working = rows
    .filter((row) => row?.time && (row.HPS === true || Number(row.HPS) > 0))
    .map((row) => row.time)
    .sort();
  let seconds = 0;
  for (let index = 1; index < working.length; index += 1) {
    const gap = (toMillis(working[index]) - toMillis(working[index - 1])) / 1000;
    if (gap > 0) seconds += Math.min(gap, 60);
  }
  return Math.round(seconds);
};

// "YYYY.MM.DD HH:MM:SS" (czas polski z co) jako milisekundy; strefa przeglądarki wystarcza do różnic czasu.
const toMillis = (time: string): number => {
  const match = time.match(/^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)).getTime();
};

// „4 h 12 min”, „12 min”, „0 min”
export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
};
