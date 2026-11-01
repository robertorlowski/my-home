// Bilans energii pompy ciepła (GET /hp/monthly-summary), liczony jak u dystrybutora (TAURON, net-billing):
// w pełnych godzinach czasu warszawskiego. W każdej godzinie pobór pompy i produkcja PV są bilansowane razem:
// pobór z sieci = max(0, pompa − PV), oddane do sieci = max(0, PV − pompa). Do 2026-11-01 PV odejmowano w każdej
// próbce, a nadwyżkę pomijano, więc pobór różnił się od eLicznika, a oddanej energii nie było wcale.
//
// Źródła (porównane z eLicznikiem 24–31.10.2026):
//   - pompa: całka trapezowa HP.Watts z rekordów hp, odstęp > 15 min = przerwa w danych (pomijany);
//   - PV: suma dobowa z liczników energii falowników (total_prod_today z kolekcji pv, bieżące maksimum w dobie),
//     rozłożona na godziny według całki mocy PV.total_power z hp (przeskalowanej do sumy z liczników). Moc chwilowa
//     zaniża sumę: przy utracie łączności DTU z falownikiem (link 0) moc jego portów wynosi 0, a licznik rośnie
//     dalej (27.10: z mocy 11,5 kWh, z liczników 18,0 kWh, eLicznik oddał 15,4 kWh). Sam licznik źle rozkłada
//     godziny: falownik bez łączności dopisuje produkcję skokami po jej powrocie (27.10: 5,3 kWh w jednej godzinie
//     przy szczycie ok. 3,6 w eLiczniku), a pozostałe panele mają ten sam przebieg słońca co on. Doba z licznikiem
//     bez mocy: przyrosty licznika w godzinach; doba bez odczytów pv (przed 2026-09-26 albo bez łączności z DTU):
//     sama całka mocy.
//   - strefa G12w z początku godziny: szczyt pon.–pt. 6–13 i 15–22, soboty, niedziele i święta (calendar.service)
//     poza szczytem; godziny granic stref są pełne, więc godzina nie dzieli się między strefy.
// Dwie kolekcje są czytane osobnymi agregacjami i łączone tutaj: Atlas na planie współdzielonym sortuje w pamięci
// najwyżej 32 MB bez allowDiskUse, a $unionWith hp i pv przekraczał limit już dla miesiąca (2026-09-26).
// Pompa nie jest całym domem: eLicznik pokazuje też resztę odbiorników (ok. 0,1–0,2 kWh/h przy samej pompie).
import { isPolishDayOff } from '../../../core/services/calendar.service';
import { TIME_ZONE } from '../../../core/time';
import { HpEntryModel } from '../models/hp.model';
import { PvEntryModel } from '../models/pv.model';

export type BalanceGroup = 'hour' | 'day' | 'month';

// stawki zmienne TAURON G12w 2026 brutto [zł/kWh] (sprzedaż + dystrybucja: szczyt 0,7712 + 0,4590, poza szczytem
// 0,5141 + 0,1164); godziny stref także w kliencie (client/src/devices/heat-pump/utils/energy-cost-g12w.ts)
export const G12W_RATE_PLN = { peak: 1.2302, offPeak: 0.6305 } as const;

// godzina czasu warszawskiego „YYYY-MM-DD HH”; przy cofnięciu zegara (koniec października) obie godziny 02 są
// jedną, tak jak w eLiczniku
const HOUR_KEY = { $dateToString: { date: '$createdAt', format: '%Y-%m-%d %H', timezone: TIME_ZONE } };

type PumpHour = { pumpWh: number; pvPowerWh: number };

async function pumpHours(rootId: string, start: Date, end: Date): Promise<Map<string, PumpHour>> {
  const rows = await HpEntryModel.aggregate<{ _id: string } & PumpHour>([
    { $match: { rootId, createdAt: { $gte: start, $lt: end } } },
    { $sort: { createdAt: 1 } },
    {
      $setWindowFields: {
        sortBy: { createdAt: 1 },
        output: {
          previousCreatedAt: { $shift: { output: '$createdAt', by: -1 } },
          previousWatts: { $shift: { output: '$HP.Watts', by: -1 } },
          previousPv: { $shift: { output: '$PV.total_power', by: -1 } },
        },
      },
    },
    { $set: { intervalHours: { $divide: [{ $subtract: ['$createdAt', '$previousCreatedAt'] }, 3600000] } } },
    // odstęp dłuższy niż 15 min to przerwa w danych (sterownik offline): pomijany,
    // żeby nie przypisać ostatniej mocy całej przerwie
    { $match: { intervalHours: { $gt: 0, $lte: 0.25 }, previousWatts: { $gte: 0 } } },
    {
      $group: {
        _id: HOUR_KEY,
        pumpWh: { $sum: { $multiply: [{ $avg: ['$previousWatts', { $ifNull: ['$HP.Watts', 0] }] }, '$intervalHours'] } },
        pvPowerWh: { $sum: { $multiply: [{ $avg: [{ $ifNull: ['$previousPv', 0] }, { $ifNull: ['$PV.total_power', 0] }] }, '$intervalHours'] } },
      },
    },
  ]);
  return new Map(rows.map(({ _id, pumpWh, pvPowerWh }) => [_id, { pumpWh, pvPowerWh }]));
}

// Produkcja PV w godzinach z liczników falowników: w każdej dobie bieżące maksimum total_prod_today (licznik
// dzienny DTU; chwilowe zera i spadki nie cofają sumy), produkcja godziny = jego przyrost. days: suma doby
// (doby z odczytami).
async function pvCounterHours(rootId: string, start: Date, end: Date) {
  const rows = await PvEntryModel.aggregate<{ _id: string; max: number }>([
    { $match: { rootId, createdAt: { $gte: start, $lt: end }, total_prod_today: { $gte: 0 } } },
    { $group: { _id: HOUR_KEY, max: { $max: '$total_prod_today' } } },
  ]);
  const hours = new Map<string, number>();
  const days = new Map<string, number>();
  let day = '';
  let reached = 0;
  for (const { _id, max } of rows.sort((a, b) => a._id.localeCompare(b._id))) {
    if (_id.slice(0, 10) !== day) {
      day = _id.slice(0, 10);
      reached = 0;
    }
    hours.set(_id, Math.max(0, max - reached));
    reached = Math.max(reached, max);
    days.set(day, reached);
  }
  return { hours, days };
}

const isPeakHour = (hourKey: string) => {
  const hour = Number(hourKey.slice(11, 13));
  // południe zamiast północy: ta sama data w Warszawie także w dniu zmiany czasu
  if (isPolishDayOff(new Date(`${hourKey.slice(0, 10)}T10:00:00Z`))) return false;
  return (hour >= 6 && hour < 13) || (hour >= 15 && hour < 22);
};

export interface BalanceBucket {
  date?: string;
  hour?: number;
  day?: number;
  month?: number;
  consumptionKWh: number;
  pvGenerationKWh: number;
  gridEnergyKWh: number;
  exportKWh: number;
  pvUsedKWh: number;
  peakGridEnergyKWh: number;
  offPeakGridEnergyKWh: number;
  totalVariableCostPLN: number;
}

const bucketOf = (hourKey: string, group: BalanceGroup): Pick<BalanceBucket, 'date' | 'hour' | 'day' | 'month'> => {
  const date = hourKey.slice(0, 10);
  if (group === 'hour') return { date, hour: Number(hourKey.slice(11, 13)) };
  if (group === 'day') return { date, day: Number(date.slice(8, 10)) };
  return { month: Number(date.slice(5, 7)) };
};

// Bilans w godzinach (group hour), dobach (day; date i dzień miesiąca) albo miesiącach (month) w [start, end).
export async function energyBalance(rootId: string, start: Date, end: Date, group: BalanceGroup): Promise<BalanceBucket[]> {
  const [pump, pv] = await Promise.all([pumpHours(rootId, start, end), pvCounterHours(rootId, start, end)]);
  const buckets = new Map<string, BalanceBucket>();
  const hourKeys = [...new Set([...pump.keys(), ...pv.hours.keys()])].sort();
  // całka mocy PV w dobach: podstawa skalowania do licznika
  const powerDays = new Map<string, number>();
  for (const [hourKey, { pvPowerWh }] of pump) {
    powerDays.set(hourKey.slice(0, 10), (powerDays.get(hourKey.slice(0, 10)) ?? 0) + pvPowerWh);
  }
  const pvWhOf = (hourKey: string) => {
    const powerWh = pump.get(hourKey)?.pvPowerWh ?? 0;
    const counterDayWh = pv.days.get(hourKey.slice(0, 10));
    if (counterDayWh === undefined) return powerWh;
    const powerDayWh = powerDays.get(hourKey.slice(0, 10)) ?? 0;
    return powerDayWh > 0 ? powerWh * counterDayWh / powerDayWh : (pv.hours.get(hourKey) ?? 0);
  };
  for (const hourKey of hourKeys) {
    const pumpWh = pump.get(hourKey)?.pumpWh ?? 0;
    const pvWh = pvWhOf(hourKey);
    const gridKWh = Math.max(0, pumpWh - pvWh) / 1000;
    const keyParts = bucketOf(hourKey, group);
    const key = JSON.stringify(keyParts);
    const bucket = buckets.get(key) ?? {
      ...keyParts, consumptionKWh: 0, pvGenerationKWh: 0, gridEnergyKWh: 0, exportKWh: 0, pvUsedKWh: 0,
      peakGridEnergyKWh: 0, offPeakGridEnergyKWh: 0, totalVariableCostPLN: 0,
    };
    bucket.consumptionKWh += pumpWh / 1000;
    bucket.pvGenerationKWh += pvWh / 1000;
    bucket.gridEnergyKWh += gridKWh;
    bucket.exportKWh += Math.max(0, pvWh - pumpWh) / 1000;
    bucket.pvUsedKWh += Math.min(pumpWh, pvWh) / 1000;
    if (isPeakHour(hourKey)) {
      bucket.peakGridEnergyKWh += gridKWh;
      bucket.totalVariableCostPLN += gridKWh * G12W_RATE_PLN.peak;
    } else {
      bucket.offPeakGridEnergyKWh += gridKWh;
      bucket.totalVariableCostPLN += gridKWh * G12W_RATE_PLN.offPeak;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}
