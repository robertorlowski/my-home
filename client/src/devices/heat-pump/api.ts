import { Requests } from '../../core/http';
import { CurrentSchedule, HpEntry, OperationEntry, ScheduleEntry, HpCwuLoading } from './types';

// Pompa ciepła (sterownik co): telemetria, podsumowania, operacje i harmonogramy.
// Endpointy /api/hp*, /api/operation*, /api/schedules* z modułu server/src/modules/heat-pump;
// rootId i deviceId dopisuje core/http.ts.
export class HpRequests {
  // bilans energii liczony na serwerze (zużycie, PV.total_power z rekordów hp, koszt G12w);
  // group: 'month' dla widoku Rok, 'day' dla widoku Miesiąc na Wykresie
  static getHpMonthlySummary(
    startDate: string,
    endDate: string,
    group: 'month' | 'day' = 'month',
  ) {
      return Requests.get(
        `/hp/monthly-summary?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&group=${group}`,
      ) as Promise<Array<{
        month?: number;
        day?: number;
        consumptionKWh: number;
        pvGenerationKWh: number;
        gridEnergyKWh: number;
        pvUsedKWh: number;
        totalVariableCostPLN: number;
      }> | null>;
  }

  // ostatnia telemetria z pamięci serwera (także pola spoza schematu Mongo) z bieżącym podsumowaniem PV
  static getCoData() : Promise<HpEntry> {
      return Requests.get("/hp");
  }

  // wszystkie rekordy od początku bieżącego roku (eksport CSV w zakładce Dane)
  static getHpAllData() : Promise<HpEntry[]> {
      return Requests.get("/hp/all");
  }

  static getHpAvailableDates(): Promise<string[] | null> {
      return Requests.get('/hp/dates');
  }

  // dzień albo zakres dni czasu warszawskiego; serwer przyjmuje YYYY.MM.DD i YYYY-MM-DD.
  static getHpData4Day(day?: string, endDay?: string) : Promise<HpEntry[]> {
      if (!day || (endDay && !day)) {
        return Promise.resolve([])
      }

      const query = endDay
        ? `startDate=${encodeURIComponent(day)}&endDate=${encodeURIComponent(endDay)}`
        : `date=${encodeURIComponent(day)}`;

      return Requests.get(`/hp/4day?${query}`);
  }

  // wartości początkowe zakładki Ustawienia zbudowane przez serwer z ostatniej telemetrii
  // (force z HP.F, pompy z HP.CCS/HCS, co_pomp z przekaźników, limity z WWatt/EEVmax/EEVmin/EEV)
  static prepareOperation() : Promise<OperationEntry> {
      return Requests.get("/operation");
  }

  // operacja ręczna (wartości jako napisy); json = false zwraca Response, wywołujący sprawdza status 201.
  // Dotrze do pompy dopiero z odpowiedzią na kolejny POST /hp/add sterownika (10–30 s).
  static setOperation(data: OperationEntry) {
      console.log(JSON.stringify(data));
      return Requests.post("/operation/set", data, false);
  }

  // akcja jednorazowa dla sterownika: 'error_reset' (odblokowanie) albo 'restart'
  static runOperationAction(action: 'error_reset' | 'restart') {
      return Requests.post("/operation/action", { action }, false);
  }

  // najnowszy rekord z error_code z 24 h (przy blokadzie ERRc ≥ 5 bez limitu czasu) albo null
  // ładowanie CWU w kotle (kocioł w trybie pompy ciepła); null przy błędzie
  static getCwuLoading(): Promise<HpCwuLoading | null> {
    return Requests.get('/hp/cwu-loading');
  }

  static getHpLastError() : Promise<HpEntry | null> {
      return Requests.get("/hp/last-error");
  }

  static getSchedules(): Promise<ScheduleEntry[] | null> {
    return Requests.get('/schedules');
  }

  static getCurrentSchedule(): Promise<CurrentSchedule | null> {
    return Requests.get('/schedules/current');
  }

  // rzuca ApiError przy błędzie zapisu (Requests.post połykał błędy i formularz pokazywał sukces)
  static createSchedule(data: Omit<ScheduleEntry, 'enabled'> & { enabled?: boolean }) {
    return Requests.json<ScheduleEntry>('POST', '/schedules', data, true);
  }

  static updateSchedule(id: string, data: Omit<ScheduleEntry, 'enabled'> & { enabled?: boolean }) {
    return Requests.put(`/schedules/${encodeURIComponent(id)}`, data);
  }

  static deleteSchedule(id: string) {
    return Requests.delete(`/schedules/${encodeURIComponent(id)}`);
  }
}
