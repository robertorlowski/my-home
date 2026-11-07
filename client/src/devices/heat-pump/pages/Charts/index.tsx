// Zakładka Wykres pompy (/chart) w układzie makiety „Instrument” (#s-hp-wykres): pasek filtrów (okres Dzień /
// Miesiąc / Rok, nawigacja po dacie, „Cały dzień”), cztery kafelki statystyk i karty wykresów. Dzień: karta
// „Temperatury” i karta „Moc i produkcja PV” z GET /hp/4day, czas pracy sprężarki z rekordów, zużycie, energia
// z sieci i koszt z bilansu serwera (GET /hp/monthly-summary, group day; do 2026-11-01 w przeglądarce). Miesiąc i Rok: karta „Energia i koszt” (słupki energii,
// PV i koszt) z bilansu serwera (GET /hp/monthly-summary, group day/month). Nad każdym wykresem wyśrodkowany pasek
// .chart-readout (od 2026-11-08 zamiast legendy w nagłówku i dymka na danych): nazwy serii zawsze, kliknięcie chowa
// albo pokazuje serię, a po najechaniu na wykres także czas i wartości punktu. Dane pobierane przy zmianie okresu, daty lub filtra; oś czasu dnia bieżącego przesuwa się co minutę,
// ale nowe dane nie są dociągane. Kolory wykresów z tokenów przez cc() (core/chartColors.ts).
import '../style.css';
import { getLang, locale, t as tr, useLang } from '../../../../core/i18n';
import './style.css';
import { cc } from '../../../../core/chartColors';
import { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  ComposedChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { THPL } from '../../types';
import {
  compressorSeconds,
  fetchData,
  fetchMonthlySummary,
  formatDateYMD,
  formatDuration,
} from '../../utils/utils';
import { ClipLoader } from 'react-spinners';
import { Segmented } from '../../components/Segmented';
import { DateNav, formatDayLabel, isToday, useHpDates } from '../../components/DateNav';

type ChartPeriod = 'day' | 'month' | 'year';

const periodOptions = () => [
  { value: 'day', label: tr('period.day') },
  { value: 'month', label: tr('period.month') },
  { value: 'year', label: tr('period.year') },
] as const;

type ChartPoint = {
  time: string;
  timeValue?: number;
  Watts?: number;
  pv?: number;
  cost?: number;
  Tbe?: number;
  Tae?: number;
  Tho?: number;
  Ttarget?: number;
};

// selectedDate bywa YYYY.MM.DD (dni z danymi, formatDateYMD) albo YYYY-MM-DD (wybór roku i miesiąca).
const parseSelectedDate = (value: string): Date => {
  const iso = value.match(/^(\d{4})[-.](\d{2})[-.](\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return new Date(value);
};

const toDateString = (date: Date): string => {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
};

const getDates = (
  selectedDate: string,
  period: ChartPeriod,
): string[] => {
  const selected = parseSelectedDate(selectedDate);
  const year = selected.getFullYear();

  let start: Date;
  let end: Date;

  if (period === 'year') {
    start = new Date(year, 0, 1);
    end = new Date(year, 11, 31);
  } else if (period === 'month') {
    start = new Date(year, selected.getMonth(), 1);
    end = new Date(year, selected.getMonth() + 1, 0);
  } else {
    start = selected;
    end = selected;
  }

  const dates: string[] = [];

  for (
    const date = new Date(start);
    date <= end;
    date.setDate(date.getDate() + 1)
  ) {
    dates.push(toDateString(date));
  }

  return dates;
};

// HPS może być boolean (rekord z bazy), liczbą albo napisem, dlatego sprawdzenie jest tolerancyjne.
const isCompressorWorking = (row: THPL): boolean => {
  const value = (row as THPL & { HPS?: unknown }).HPS;

  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  return ['true', '1', 'on', 'active', 'working', 'yes'].includes(
    String(value).trim().toLowerCase(),
  );
};

// Minuty od północy: oś X dnia jest liczbowa (0–1440), żeby odstępy odpowiadały czasowi, a luki były widoczne.
const getTimeValue = (time: string): number => {
  const match = time.match(/[ T](\d{2}):(\d{2})/);
  if (!match) return 0;

  return Number(match[1]) * 60 + Number(match[2]);
};

const formatTimeValue = (value: number): string => {
  const minutes = Math.max(0, Math.min(24 * 60, Math.round(value)));
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  return `${String(hours).padStart(2, '0')}:${String(restMinutes).padStart(2, '0')}`;
};

const dayTicks = Array.from({ length: 5 }, (_, index) => index * 360);

const getDayTicks = (endMinutes: number): number[] => {
  const ticks = dayTicks.filter((tick) => tick < endMinutes);

  if (endMinutes > 0 && !ticks.includes(endMinutes)) {
    ticks.push(endMinutes);
  }

  return ticks;
};

const fmt = (value: number, digits = 2) => value.toLocaleString(locale(getLang()), { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Serie wykresów: klucz danych, etykieta legendy, kolor z tokenów (cc()), jednostka w dymku.
type SeriesKey = 'Watts' | 'pv' | 'cost' | 'Tbe' | 'Tae' | 'Tho' | 'Ttarget';
type Series = { key: SeriesKey; label: string; color: string; unit: string; digits: number };

const tempSeries = (colors: ReturnType<typeof cc>): Series[] => [
  { key: 'Ttarget', label: tr('hp.chart.tank'), color: colors.s1, unit: ' °C', digits: 1 },
  { key: 'Tho', label: tr('hp.tOut'), color: colors.s2, unit: ' °C', digits: 1 },
  { key: 'Tbe', label: tr('hp.tBeforeEvap'), color: colors.s3, unit: ' °C', digits: 1 },
  { key: 'Tae', label: tr('hp.tAfterEvap'), color: colors.s4, unit: ' °C', digits: 1 },
];
const powerSeries = (colors: ReturnType<typeof cc>): Series[] => [
  { key: 'Watts', label: tr('hp.chart.compressorDraw'), color: colors.s1, unit: ' W', digits: 0 },
  { key: 'pv', label: tr('hp.chart.pvProduction'), color: colors.sun, unit: ' W', digits: 0 },
];
const energySeries = (colors: ReturnType<typeof cc>): Series[] => [
  { key: 'Watts', label: tr('hp.chart.energyConsumed'), color: colors.s1, unit: ' kWh', digits: 2 },
  { key: 'pv', label: tr('hp.chart.fromPv'), color: colors.sun, unit: ' kWh', digits: 2 },
  { key: 'cost', label: tr('hp.chart.costG12w'), color: colors.s2, unit: ' PLN', digits: 2 },
];

// Punkt pod kursorem: etykieta osi i wartości widocznych serii; null = kursor poza wykresem.
type Readout = { label: string | number | undefined; values: Partial<Record<SeriesKey, number>> } | null;
type ReporterProps = {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: unknown }>;
  label?: string | number;
  onChange: (readout: Readout) => void;
};

// Treść Tooltip bez własnego dymka: przekazuje punkt pod kursorem do paska nad wykresem. Stan zmienia się w efekcie
// (nie w trakcie renderu Recharts) i tylko przy innym punkcie.
const TooltipReporter: React.FC<ReporterProps> = ({ active, payload, label, onChange }) => {
  const key = active && payload?.length ? `${label}|${payload.map((item) => `${item.dataKey}:${item.value}`).join(',')}` : '';
  useEffect(() => {
    if (!key || !payload) { onChange(null); return; }
    const values: Partial<Record<SeriesKey, number>> = {};
    payload.forEach((item) => { if (typeof item.value === 'number') values[String(item.dataKey) as SeriesKey] = item.value; });
    onChange({ label, values });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
};

// Pasek nad wykresem: nazwy serii (kliknięcie chowa albo pokazuje serię), a przy kursorze nad wykresem czas
// i wartości punktu.
const ChartReadout: React.FC<{
  series: Series[]; hidden: Set<SeriesKey>; onToggle: (key: SeriesKey) => void; readout: Readout;
  labelFormat: (label: string | number | undefined) => string;
}> = ({ series, hidden, onToggle, readout, labelFormat }) => (
  <div className="legend chart-readout">
    {readout && <strong className="readout-time">{labelFormat(readout.label)}</strong>}
    {series.map((entry) => {
      const off = hidden.has(entry.key);
      const value = readout?.values[entry.key];
      return (
        <button type="button" key={entry.key} className={`lg${off ? ' is-off' : ''}`} aria-pressed={!off}
          title={off ? tr('chart.showSeries') : tr('chart.hideSeries')} onClick={() => onToggle(entry.key)}>
          <i style={{ background: entry.color }} />{entry.label}
          {!off && value !== undefined && <b>{fmt(value, entry.digits)}{entry.unit}</b>}
        </button>
      );
    })}
  </div>
);

const monthNames = () => Array.from({ length: 12 }, (_, month) =>
  new Date(2026, month, 1).toLocaleDateString(locale(getLang()), { month: 'long' }));

export const HeatPumpChart: React.FC = () => {
  const { t } = useLang();
  const [filteredData, setFilteredData] = useState<ChartPoint[]>([]);
  // punkt pod kursorem dla paska nad każdym wykresem (ChartReadout)
  const [tempPoint, setTempPoint] = useState<Readout>(null);
  const [powerPoint, setPowerPoint] = useState<Readout>(null);
  const [energyPoint, setEnergyPoint] = useState<Readout>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(
    formatDateYMD(new Date()),
  );
  const [period, setPeriod] = useState<ChartPeriod>('day');
  const [allData, setAllData] = useState(true);
  // kwh: całe zużycie pompy; kwhGrid: energia z sieci (zużycie po odjęciu PV)
  const [kwh, setKwh] = useState(0);
  const [kwhGrid, setKwhGrid] = useState(0);
  const [cost, setCost] = useState(0);
  const [workSeconds, setWorkSeconds] = useState(0);
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  // dni z danymi (nawigacja w widoku Dzień); bez danych dziś hook przełącza na najnowszy dzień
  const dates = useHpDates(selectedDate, setSelectedDate);

  const selected = parseSelectedDate(selectedDate);
  const selectedYear = selected.getFullYear();
  const selectedMonth = selected.getMonth();
  const isCurrentDay = selectedDate === formatDateYMD(currentTime);
  const currentDayEnd = currentTime.getHours() * 60 + currentTime.getMinutes();
  const dayEndMinutes = isCurrentDay ? Math.max(currentDayEnd, 1) : 24 * 60;
  const visibleDayTicks = getDayTicks(dayEndMinutes);

  // dla dnia bieżącego oś X kończy się na „teraz”; zegar tylko przesuwa koniec osi
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTime(new Date());
    }, 60 * 1000);

    return () => window.clearInterval(timer);
  }, []);

  // Pozycje nawigacji po dacie: Dzień = dni z danymi, Miesiąc = miesiące ostatnich czterech lat do bieżącego,
  // Rok = cztery ostatnie lata. Wartości Miesiąc / Rok to pierwszy dzień okresu (YYYY-MM-DD).
  const now = new Date();
  const years = Array.from({ length: 4 }, (_, index) => now.getFullYear() - index);
  const navItems = useMemo(() => {
    if (period === 'day') return dates.map((date) => ({ value: date, label: formatDayLabel(date) }));
    if (period === 'year') return years.map((year) => ({ value: toDateString(new Date(year, 0, 1)), label: String(year) }));
    const months: Array<{ value: string; label: string }> = [];
    for (const year of years) {
      for (let month = year === now.getFullYear() ? now.getMonth() : 11; month >= 0; month -= 1) {
        months.push({ value: toDateString(new Date(year, month, 1)), label: `${monthNames()[month]} ${year}` });
      }
    }
    return months;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, dates]);
  const navValue = period === 'day' ? selectedDate
    : period === 'month' ? toDateString(new Date(selectedYear, selectedMonth, 1))
      : toDateString(new Date(selectedYear, 0, 1));

  // powrót do widoku Dzień z daty miesiąca / roku: najnowszy dzień z danymi nie późniejszy niż wybrana data
  const changePeriod = (next: ChartPeriod) => {
    setPeriod(next);
    setHidden(new Set());
    if (next === 'day' && dates.length > 0 && !dates.includes(selectedDate)) {
      const wanted = formatDateYMD(selected);
      setSelectedDate(dates.find((date) => date <= wanted) ?? dates[0]);
    }
  };

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      setLoading(true);

      try {
        const dates = getDates(selectedDate, period);

        // Rok: bilans serwera po miesiącach (GET /hp/monthly-summary); kafelki = sumy, wykres = 12 słupków
        // (miesiąc bez danych = 0). Klucze punktu są te same co w dniu (Watts, pv, cost), ale w kWh / PLN.
        if (period === 'year') {
          const summaries = await fetchMonthlySummary(
            dates[0],
            dates[dates.length - 1],
          );

          if (!active) return;

          const monthlyData = summaries || [];
          const total = monthlyData.reduce(
            (value, item) => ({
              energy: value.energy + Number(item.consumptionKWh || 0),
              grid: value.grid + Number(item.gridEnergyKWh || 0),
              cost: value.cost + Number(
                Number(item.totalVariableCostPLN || 0).toFixed(2),
              ),
            }),
            { energy: 0, grid: 0, cost: 0 },
          );

          setKwh(Number(total.energy.toFixed(2)));
          setKwhGrid(Number(total.grid.toFixed(2)));
          setCost(Number(total.cost.toFixed(2)));
          setWorkSeconds(0);
          setFilteredData(Array.from({ length: 12 }, (_, monthIndex) => {
            const item = monthlyData.find(
              (summary) => summary.month === monthIndex + 1,
            );

            return {
              time: String(monthIndex + 1),
              Watts: Number(Number(item?.consumptionKWh || 0).toFixed(2)),
              pv: Number(Number(item?.pvUsedKWh || 0).toFixed(2)),
              cost: Number(Number(item?.totalVariableCostPLN || 0).toFixed(2)),
            };
          }));
          return;
        }

        // Miesiąc: ten sam bilans po dniach (group = day), słupek na każdy dzień miesiąca
        if (period === 'month') {
          const summaries = await fetchMonthlySummary(
            dates[0],
            dates[dates.length - 1],
            'day',
          );

          if (!active) return;

          const dailyData = summaries || [];
          const total = dailyData.reduce(
            (value, item) => ({
              energy: value.energy + Number(item.consumptionKWh || 0),
              grid: value.grid + Number(item.gridEnergyKWh || 0),
              cost: value.cost + Number(item.totalVariableCostPLN || 0),
            }),
            { energy: 0, grid: 0, cost: 0 },
          );

          setKwh(Number(total.energy.toFixed(2)));
          setKwhGrid(Number(total.grid.toFixed(2)));
          setCost(Number(total.cost.toFixed(2)));
          setWorkSeconds(0);
          setFilteredData(dates.map((date) => {
            const day = Number(date.slice(8, 10));
            const item = dailyData.find((summary) => summary.date === date);

            return {
              time: String(day),
              Watts: Number(Number(item?.consumptionKWh || 0).toFixed(2)),
              pv: Number(Number(item?.pvUsedKWh || 0).toFixed(2)),
              cost: Number(Number(item?.totalVariableCostPLN || 0).toFixed(2)),
            };
          }));
          return;
        }

        // Dzień: rekordy na wykres i czas pracy sprężarki; zużycie, energia z sieci i koszt z bilansu serwera
        // (GET /hp/monthly-summary, group = day: bilans godzinowy jak w eLiczniku, PV z liczników falowników)
        const [data, summaries] = await Promise.all([
          fetchData(true, dates[0], dates[dates.length - 1]),
          fetchMonthlySummary(dates[0], dates[dates.length - 1], 'day'),
        ]);

        if (!active) return;

        const periodTotal = (summaries || []).reduce(
          (total, item) => ({
            energy: total.energy + Number(item.consumptionKWh || 0),
            grid: total.grid + Number(item.gridEnergyKWh || 0),
            cost: total.cost + Number(item.totalVariableCostPLN || 0),
          }),
          { energy: 0, grid: 0, cost: 0 },
        );

        setKwh(Number(periodTotal.energy.toFixed(2)));
        setKwhGrid(Number(periodTotal.grid.toFixed(2)));
        setCost(periodTotal.cost);
        setWorkSeconds(compressorSeconds(data));

        // tylko co piąty rekord (po filtrze) trafia na wykres; „Cały dzień” wyłączony zostawia
        // tylko pracę sprężarki na osi kategorii (bez luk czasowych)
        const points = data
          .filter((row) => row?.time)
          .filter((row) => allData || isCompressorWorking(row))
          .filter((_, index) => index % 5 === 0)
          .sort((a, b) => a.time.localeCompare(b.time))
          .map((row) => ({
            ...row,
            timeValue: getTimeValue(row.time),
            time: row.time.split(' ')[1]?.slice(0, 5) || row.time,
            Tbe: row.Tbe != null ? Number(row.Tbe) : undefined,
            Tae: row.Tae != null ? Number(row.Tae) : undefined,
            Tho: row.Tho != null ? Number(row.Tho) : undefined,
            Ttarget: row.Ttarget != null ? Number(row.Ttarget) : undefined,
            Watts: row.Watts != null ? Number(row.Watts) : undefined,
            pv: row.pv != null ? Number(row.pv) : undefined,
          }));

        setFilteredData(points);
      } catch (error) {
        console.error('Błąd ładowania danych:', error);
      } finally {
        if (active) setLoading(false);
      }
    };

    loadData();

    return () => {
      active = false;
    };
  }, [selectedDate, period, allData]);

  const isDay = period === 'day';
  const colors = cc();
  const temps = tempSeries(colors);
  const powers = powerSeries(colors);
  const energies = energySeries(colors);
  // ukryte serie (legenda); zmiana okresu czyści wybór (changePeriod)
  const toggle = (key: SeriesKey) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const axisTick = { fill: colors.axis, fontSize: 11 };
  // oś dnia: liczbowa (minuty) przy „Cały dzień”, kategorie (godziny pracy sprężarki) bez luk w przeciwnym razie
  const dayAxis = allData
    ? <XAxis tick={axisTick} stroke={colors.line} type="number" dataKey="timeValue" domain={[0, dayEndMinutes]}
        ticks={visibleDayTicks} tickFormatter={formatTimeValue} allowDataOverflow={false} />
    : <XAxis tick={axisTick} stroke={colors.line} dataKey="time" minTickGap={40} />;
  const dayLabel = (label: string | number | undefined) => (allData ? formatTimeValue(Number(label)) : String(label ?? ''));
  const periodLabel = (label: string | number | undefined) => (period === 'month'
    ? `${label} ${monthNames()[selectedMonth]}`
    : `${monthNames()[Number(label) - 1] ?? label} ${selectedYear}`);
  const dateNote = isDay && isToday(selectedDate) ? t('wx.today') : undefined;

  return (
    <div className="page page-device hp-view hp-charts">
      <div className="filters">
        <Segmented inline name="hp-okres" label={t('period.label')} value={period} options={periodOptions()} onChange={changePeriod} />
        <DateNav unit={isDay ? t('common.dayUnit') : period === 'month' ? t('common.monthUnit') : t('common.yearUnit')} items={navItems} value={navValue}
          onChange={setSelectedDate} note={dateNote} />
        {isDay && (
          <label className="check">
            <input type="checkbox" checked={allData} onChange={(event) => setAllData(event.target.checked)} />
            <span>{t('hp.chart.wholeDay')}</span>
          </label>
        )}
      </div>

      <div className="stat-row">
        <div className="stat"><span className="stat-label">{t('hp.consumption')}</span><span className="stat-value">{fmt(kwh)}<small>kWh</small></span></div>
        <div className="stat"><span className="stat-label">{t('hp.chart.fromGrid')}</span><span className="stat-value">{fmt(kwhGrid)}<small>kWh</small></span></div>
        <div className="stat"><span className="stat-label">{t('hp.chart.costG12w')}</span><span className="stat-value">{fmt(cost)}<small>PLN</small></span></div>
        {isDay
          ? <div className="stat"><span className="stat-label">{t('hp.chart.workTime')}</span><span className="stat-value">{formatDuration(workSeconds).replace(/ (h|min)/g, ' $1')}</span></div>
          : <div className="stat"><span className="stat-label">{t('hp.chart.fromPv')}</span><span className="stat-value">{fmt(Math.max(0, kwh - kwhGrid))}<small>kWh</small></span></div>}
      </div>

      {isDay ? (
        <>
          <section className="card">
            <header className="card-head">
              <h2>{t('hp.chart.temperatures')}</h2>
                          </header>
            <ChartReadout series={temps} hidden={hidden} onToggle={toggle} readout={tempPoint} labelFormat={dayLabel} />
            <div className="chart chart-lg">
              {loading && <div className="loading chart-loading"><ClipLoader size={32} color={colors.axis} /></div>}
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={filteredData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} onMouseLeave={() => setTempPoint(null)}>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  {dayAxis}
                  <YAxis tick={axisTick} stroke={colors.line} unit=" °C" width={54} />
                  <Tooltip content={<TooltipReporter onChange={setTempPoint} />} />
                  {temps.map((entry) => (
                    <Line key={entry.key} type="monotone" dataKey={entry.key} stroke={entry.color} strokeWidth={2} dot={false}
                      connectNulls hide={hidden.has(entry.key)} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section className="card">
            <header className="card-head">
              <h2>{t('hp.chart.powerAndPv')}</h2>
                          </header>
            <ChartReadout series={powers} hidden={hidden} onToggle={toggle} readout={powerPoint} labelFormat={dayLabel} />
            <div className="chart chart-md">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={filteredData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} onMouseLeave={() => setPowerPoint(null)}>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  {dayAxis}
                  <YAxis tick={axisTick} stroke={colors.line} unit=" W" width={54} />
                  <Tooltip content={<TooltipReporter onChange={setPowerPoint} />} />
                  <Area type="monotone" dataKey="pv" stroke="none" fill={colors.sun} fillOpacity={0.28} hide={hidden.has('pv')} isAnimationActive={false} />
                  <Bar dataKey="Watts" fill={colors.s1} barSize={allData ? 2 : undefined} hide={hidden.has('Watts')} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="help">{t('hp.chart.dayHelp')}</p>
          </section>
        </>
      ) : (
        <section className="card">
          <header className="card-head">
            <h2>{t('hp.chart.energyAndCost')}</h2>
                      </header>
          <ChartReadout series={energies} hidden={hidden} onToggle={toggle} readout={energyPoint} labelFormat={periodLabel} />
          <div className="chart chart-lg">
            {loading && <div className="loading chart-loading"><ClipLoader size={32} color={colors.axis} /></div>}
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={filteredData} margin={{ top: 8, right: 0, bottom: 0, left: -12 }} onMouseLeave={() => setEnergyPoint(null)}>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis tick={axisTick} stroke={colors.line} dataKey="time" />
                <YAxis yAxisId="left" tick={axisTick} stroke={colors.line} unit=" kWh" width={64} />
                <YAxis yAxisId="right" orientation="right" tick={axisTick} stroke={colors.line} unit=" zł" width={56} hide={hidden.has('cost')} />
                <Tooltip content={<TooltipReporter onChange={setEnergyPoint} />} />
                <Bar yAxisId="left" dataKey="Watts" fill={colors.s1} radius={[2, 2, 0, 0]} hide={hidden.has('Watts')} isAnimationActive={false} />
                <Line yAxisId="left" dataKey="pv" stroke={colors.sun} strokeWidth={2} type="monotone" dot={{ r: 2 }} hide={hidden.has('pv')} isAnimationActive={false} />
                <Line yAxisId="right" dataKey="cost" stroke={colors.s2} strokeWidth={2} type="monotone" dot={{ r: 2 }} hide={hidden.has('cost')} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="help">{period === 'month' ? t('hp.chart.daysOfMonth') : t('hp.chart.monthsOfYear')}: {t('hp.chart.periodHelp')}</p>
        </section>
      )}
    </div>
  );
};
