import { Requests } from '../../core/http';
import { WaterFlow, WaterMeterReading, WaterMeterSummary, WaterPressureTankRun, WaterSummary, WaterSummaryPeriod } from './types';

// Hydrofor (sterownik water-pressure-tank): uruchomienia pompy, przepływ, podsumowania wody i wodomierz.
// Endpointy /api/water-pressure-tank/* z server/src/modules/water-pressure-tank; rootId i deviceId
// dopisuje core/http.ts. Ustawienia hydroforu idą przez core/api.ts (/device/properties).
export class WaterPressureTankRequests {
  // dni czasu warszawskiego YYYY-MM-DD, "to" włącznie
  static getRuns(from: string, to: string): Promise<WaterPressureTankRun[] | null> {
    return Requests.get(`/water-pressure-tank/runs?from=${from}&to=${to}`);
  }

  static getSummary(period: WaterSummaryPeriod, date: string): Promise<WaterSummary | null> {
    return Requests.get(`/water-pressure-tank/summary?period=${period}&date=${date}`);
  }

  // przepływ pompy [l/min] z wodomierza i czasu pracy pompy
  static getFlow(): Promise<WaterFlow | null> {
    return Requests.get('/water-pressure-tank/flow');
  }

  static getMeterReadings(): Promise<WaterMeterReading[] | null> {
    return Requests.get('/water-pressure-tank/meter');
  }

  // json = false: wynikiem jest Response (sprawdzane ok) albo undefined przy błędzie sieci
  static addMeterReading(reading: { readAt: string; valueM3: number; note?: string }) {
    return Requests.post('/water-pressure-tank/meter', reading, false) as Promise<Response | void>;
  }

  static deleteMeterReading(id: string) {
    return Requests.delete(`/water-pressure-tank/meter/${encodeURIComponent(id)}`);
  }

  // zużycie z wodomierza (interpolacja między odczytami) obok wody z czasu pompy i przepływ
  static getMeterSummary(year: number): Promise<WaterMeterSummary | null> {
    return Requests.get(`/water-pressure-tank/meter/summary?year=${year}`);
  }
}
