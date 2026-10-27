// Zakładka Wykres fotowoltaiki (/chart), układ „Instrument” z makiety (#s-pv-wykres): pasek filtrów (okres Dzień /
// Miesiąc / Rok / Całość i nawigacja po dacie), trzy kafelki statystyk (produkcja, najlepszy dzień / miesiąc / rok
// albo szczyt mocy, średnia) i karta z wykresem Recharts w kolorach z core/chartColors (cc()). Dzień — krzywa mocy
// (przedziały 5 min), w dniu ze szczegółami paneli także „Moc paneli” (linie wybranych portów, wybór chipami
// pogrupowanymi według mikrofalowników; domyślnie pierwszy mikrofalownik, bo 10 krzywych naraz jest nieczytelne)
// i „Produkcja paneli” (słupki kWh, na czerwono panele ponad 15 % poniżej średniej). Miesiąc — produkcja w dniach,
// Rok — w miesiącach, Całość — w latach. GET /photovoltaic/day i /photovoltaic/summary.
import { useEffect, useState } from 'react';
import { cc, tooltipStyle } from '../../../core/chartColors';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { PhotovoltaicRequests } from '../api';
import { PvDay, PvSummary, PvSummaryPeriod } from '../types';
import {
  monthShort, NumberUnit, formatDay, formatEnergy, formatMonth, formatPower, formatTime, panelName, shortSerial, splitEnergy, splitPower,
  todayWarsaw,
} from '../utils/pv';
import { DateNav, Segmented } from '../components/ui';
import { getLang, locale, t as tr, useLang } from '../../../core/i18n';
import './style.css';

type Period = 'day' | PvSummaryPeriod;
type DayView = 'total' | 'power' | 'energy';

const periodOptions = (): { value: Period; label: string }[] => [
  { value: 'day', label: tr('period.day') },
  { value: 'month', label: tr('period.month') },
  { value: 'year', label: tr('period.year') },
  { value: 'total', label: tr('pv.chart.total') },
];

// panel „słabiej”: produkcja poniżej 85 % średniej paneli
const LOW_RATIO = 0.85;

// kolory linii paneli: serie motywu, potem słońce i woda (do 10 portów u nas)
const COLORS = () => { const c = cc(); return [c.s1, c.s3, c.s4, c.s2, c.sun, c.water, c.heat, c.accent, c.danger, c.ok]; };

const bucketLabel = (period: PvSummaryPeriod, key: string) =>
  period === 'month' ? String(Number(key.slice(8, 10))) : period === 'year' ? monthShort(Number(key.slice(5, 7))) : key;

const bucketName = (period: PvSummaryPeriod, key: string) =>
  period === 'month' ? formatDay(key) : period === 'year' ? formatMonth(key) : key;

const Stat = ({ label, value, extra }: { label: string; value: NumberUnit; extra?: string }) => (
  <div className="stat">
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value[0]}{value[1] && <small>{value[1]}</small>}{extra && <small>· {extra}</small>}</span>
  </div>
);

export const PhotovoltaicChart: React.FC = () => {
  const { t } = useLang();
  const [period, setPeriod] = useState<Period>('day');
  const [date, setDate] = useState(todayWarsaw());
  const [dayView, setDayView] = useState<DayView>('total');
  // wybrane panele (klucze serial-port) w widoku „Moc paneli”; null = domyślnie pierwszy mikrofalownik
  const [selectedPanels, setSelectedPanels] = useState<Set<string> | null>(null);
  const [day, setDay] = useState<PvDay | null | undefined>(undefined);
  const [summary, setSummary] = useState<PvSummary | null | undefined>(undefined);

  // spóźniona odpowiedź dla poprzedniej daty lub okresu nie nadpisuje bieżącej
  useEffect(() => {
    let active = true;
    if (period === 'day') {
      setDay(undefined);
      PhotovoltaicRequests.getDay(date).then((result) => active && setDay(result));
    } else {
      setSummary(undefined);
      PhotovoltaicRequests.getSummary(period, period === 'month' ? date.slice(0, 7) : date.slice(0, 4))
        .then((result) => active && setSummary(result));
    }
    return () => { active = false; };
  }, [period, date]);

  const dayData = (day?.points ?? []).map((p) => ({ label: formatTime(p.t), moc: p.power }));
  // „Moc paneli”: Recharts chce jednego wiersza na chwilę z kolumną na panel, a serwer daje punkty osobno na panel —
  // obrót tabeli po czasie (klucz = serial-port)
  const panelsData = (() => {
    if (!day?.panels.length) return [];
    const rows = new Map<string, Record<string, number | string>>();
    for (const panel of day.panels) {
      for (const point of panel.points) {
        const row = rows.get(point.t) ?? { label: formatTime(point.t) };
        row[panel.key] = point.power;
        rows.set(point.t, row);
      }
    }
    return [...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([, row]) => row);
  })();
  // „Produkcja paneli”: energyWh z serwera = największe prod_today portu w dobie; kWh do dwóch miejsc
  const panelEnergy = (day?.panels ?? []).map((panel) => ({
    label: `${panel.serial.slice(-2)}/${panel.port}`,
    name: panelName(panel.serial, panel.port),
    kwh: Math.round((panel.energyWh ?? 0) / 10) / 100,
    energyWh: panel.energyWh ?? 0,
  }));
  const averageWh = panelEnergy.length ? panelEnergy.reduce((sum, p) => sum + p.energyWh, 0) / panelEnergy.length : 0;
  const hasPanels = !!day?.panels.length;
  const view: DayView = period === 'day' && hasPanels ? dayView : 'total';

  // panele pogrupowane według mikrofalowników (numer seryjny), z kolorem krzywej stałym niezależnie od wyboru
  const inverters = (() => {
    const groups = new Map<string, { key: string; port: number; color: string }[]>();
    (day?.panels ?? []).forEach((panel, index) => {
      const list = groups.get(panel.serial) ?? [];
      list.push({ key: panel.key, port: panel.port, color: COLORS()[index % COLORS.length] });
      groups.set(panel.serial, list);
    });
    return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([serial, panels]) => ({ serial, panels }));
  })();
  // wybór użytkownika ograniczony do paneli obecnych w tym dniu (inny dzień może mieć inne porty)
  const allKeys = new Set(inverters.flatMap((inverter) => inverter.panels.map((panel) => panel.key)));
  const shown = new Set(
    selectedPanels ? [...selectedPanels].filter((key) => allKeys.has(key)) : (inverters[0]?.panels.map((panel) => panel.key) ?? []),
  );
  const togglePanels = (keys: string[], on: boolean) => {
    const next = new Set(shown);
    keys.forEach((key) => (on ? next.add(key) : next.delete(key)));
    setSelectedPanels(next);
  };

  const buckets = summary?.buckets ?? [];
  const summaryData = buckets.map((b) => ({
    label: bucketLabel(period as PvSummaryPeriod, b.key),
    kwh: Math.round(b.energyWh / 100) / 10,
    energyWh: b.energyWh,
    peakW: b.peakW,
    days: b.days,
    tooltip: bucketName(period as PvSummaryPeriod, b.key),
  }));
  const best = buckets.reduce<PvSummary['buckets'][number] | null>((top, b) => (!top || b.energyWh > top.energyWh ? b : top), null);

  // kafelki statystyk: dzień — produkcja, szczyt mocy, liczba przedziałów; okresy — produkcja, najlepszy kubełek, średnia
  const stats = period === 'day' ? (
    <>
      <Stat label={t('pv.production')} value={splitEnergy(day?.energyWh)} />
      <Stat label={t('pv.chart.peakPower')} value={splitPower(day?.peakW)} extra={day?.peakAt ? formatTime(day.peakAt) : undefined} />
      <Stat label={t('pv.chart.readings')} value={[dayData.length ? String(dayData.length) : '---', dayData.length ? t('pv.chart.every5') : '']} />
    </>
  ) : (
    <>
      <Stat label={t('pv.production')} value={splitEnergy(summary?.energyWh)} />
      <Stat label={period === 'month' ? t('pv.chart.bestDay') : period === 'year' ? t('pv.chart.bestMonth') : t('pv.chart.bestYear')}
        value={splitEnergy(best?.energyWh)}
        extra={best ? (period === 'month' ? `${Number(best.key.slice(8, 10))}.${Number(best.key.slice(5, 7))}` : bucketLabel(period as PvSummaryPeriod, best.key)) : undefined} />
      <Stat label={t('pv.chart.average')} value={buckets.length ? (() => { const [n, u] = splitEnergy(summary!.energyWh / buckets.length); return [n, `${u}/${period === 'month' ? t('common.dayUnit') : period === 'year' ? t('pv.chart.monthAbbr') : t('common.yearUnit')}`] as NumberUnit; })() : ['---', '']} />
    </>
  );

  const title = period === 'month' ? t('pv.chart.dailyProduction') : period === 'year' ? t('pv.chart.monthlyProduction') : period === 'total' ? t('pv.chart.yearlyProduction')
    : view === 'power' ? t('pv.chart.panelPower') : view === 'energy' ? t('pv.chart.panelProduction') : t('pv.home.dayPower');
  const hint = period !== 'day' ? t('pv.chart.kwhHover')
    : view === 'energy' ? t('pv.chart.kwhAverage', { value: formatEnergy(averageWh) }) : `W · ${t('pv.chart.intervals5')} · ${formatDay(date)}`;
  const failed = (period === 'day' ? day : summary) === null;
  const status = period === 'day'
    ? (day === undefined ? t('common.loading') : day === null ? t('pv.loadFailed') : !dayData.length ? t('pv.noneDay') : '')
    : (summary === undefined ? t('common.loading') : summary === null ? t('pv.loadFailed') : !summaryData.length ? t('pv.chart.nonePeriod') : '');

  return (
    <div className="page page-device pv-page">
      <div className="filters">
        <Segmented<Period> name="pv-okres" label={t('period.label')} value={period} options={periodOptions()} onChange={setPeriod} />
        {period !== 'total' && <DateNav unit={period} date={date} onChange={setDate} />}
        {period === 'day' && (
          <Segmented<DayView> name="pv-day-view" label={t('pv.chart.dayView')} value={view} onChange={setDayView} options={[
            { value: 'total', label: t('pv.set.installation') },
            { value: 'power', label: t('pv.chart.panelPower'), disabled: !hasPanels },
            { value: 'energy', label: t('pv.chart.panelProduction'), disabled: !hasPanels },
          ]} />
        )}
      </div>

      <div className="stat-row">{stats}</div>

      <section className="card">
        <header className="card-head"><h2>{title}</h2><span className="card-hint">{hint}</span></header>

        {view === 'power' && hasPanels && (
          <div className="pv-chipsets" role="group" aria-label={t('pv.chart.panelsOnChart')}>
            {inverters.map((inverter) => {
              const keys = inverter.panels.map((panel) => panel.key);
              const count = keys.filter((key) => shown.has(key)).length;
              return (
                <div key={inverter.serial} className="chipset">
                  <label className="chip-check">
                    <input type="checkbox" checked={count === keys.length}
                      ref={(element) => { if (element) element.indeterminate = count > 0 && count < keys.length; }}
                      onChange={(event) => togglePanels(keys, event.currentTarget.checked)} />
                    <span>{t('pv.inverter')} {shortSerial(inverter.serial)}</span>
                  </label>
                  {inverter.panels.map((panel) => (
                    <label key={panel.key} className="chip-check">
                      <input type="checkbox" checked={shown.has(panel.key)} onChange={(event) => togglePanels([panel.key], event.currentTarget.checked)} />
                      <span><i className="pv-swatch" style={{ background: panel.color }} />{t('pv.port')} {panel.port}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {status ? <p className={`help${failed ? ' danger-text' : ''}`}>{status}</p> : (
          <div className="chart chart-lg">
            <ResponsiveContainer width="100%" height="100%">
              {period !== 'day' ? (
                <BarChart data={summaryData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={cc().grid} vertical={false} />
                  <XAxis dataKey="label" stroke={cc().line} tickLine={false} tick={{ fill: cc().axis, fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis stroke={cc().line} axisLine={false} tickLine={false} width={36} tick={{ fill: cc().axis, fontSize: 11 }} tickFormatter={(value: number) => value.toLocaleString(locale(getLang()))} />
                  <Tooltip {...tooltipStyle()} cursor={{ fill: cc().grid }}
                    formatter={(_value, _name, item) => [`${formatEnergy(item.payload.energyWh)}, ${t('pv.chart.peakLower')} ${formatPower(item.payload.peakW)}`
                      + (period === 'month' ? '' : `, ${t('pv.chart.daysWithData')}: ${item.payload.days}`), t('pv.production')]}
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.tooltip ?? label} />
                  <Bar dataKey="kwh" fill={cc().sun} radius={[1.5, 1.5, 0, 0]} maxBarSize={28} isAnimationActive={false} />
                </BarChart>
              ) : view === 'energy' ? (
                <BarChart data={panelEnergy} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={cc().grid} vertical={false} />
                  <XAxis dataKey="label" stroke={cc().line} tickLine={false} interval={0} tick={{ fill: cc().axis, fontSize: 11 }} />
                  <YAxis stroke={cc().line} axisLine={false} tickLine={false} width={36} tick={{ fill: cc().axis, fontSize: 11 }} tickFormatter={(value: number) => value.toLocaleString(locale(getLang()))} />
                  <Tooltip {...tooltipStyle()} cursor={{ fill: cc().grid }} formatter={(_value, _name, item) => [formatEnergy(item.payload.energyWh), t('pv.production')]}
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.name ?? label} />
                  <Bar dataKey="kwh" radius={[1.5, 1.5, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                    {panelEnergy.map((p) => <Cell key={p.label} fill={p.energyWh < averageWh * LOW_RATIO ? cc().danger : cc().sun} />)}
                  </Bar>
                </BarChart>
              ) : view === 'power' ? (
                <LineChart data={panelsData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={cc().grid} vertical={false} />
                  <XAxis dataKey="label" stroke={cc().line} tickLine={false} tick={{ fill: cc().axis, fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                  <YAxis stroke={cc().line} axisLine={false} tickLine={false} width={52} tick={{ fill: cc().axis, fontSize: 11 }} tickFormatter={(value: number) => `${value} W`} />
                  <Tooltip {...tooltipStyle()} formatter={(value, name) => [formatPower(Number(value)), panelName(String(name).split('-')[0], Number(String(name).split('-')[1]))]} />
                  {day!.panels.map((panel, index) => (shown.has(panel.key) ? (
                    <Line key={panel.key} type="monotone" dataKey={panel.key} dot={false} strokeWidth={2} stroke={COLORS()[index % COLORS.length]} isAnimationActive={false} />
                  ) : null))}
                </LineChart>
              ) : (
                <AreaChart data={dayData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={cc().grid} vertical={false} />
                  <XAxis dataKey="label" stroke={cc().line} tickLine={false} tick={{ fill: cc().axis, fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                  <YAxis stroke={cc().line} axisLine={false} tickLine={false} width={52} tick={{ fill: cc().axis, fontSize: 11 }} tickFormatter={(value: number) => `${value} W`} />
                  <Tooltip {...tooltipStyle()} formatter={(value) => [formatPower(Number(value)), t('tile.icon.bolt')]} />
                  <Area type="monotone" dataKey="moc" stroke={cc().sun} strokeWidth={2} fill={cc().sun} fillOpacity={0.28} isAnimationActive={false} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        )}

        {period === 'day' && day && !hasPanels && dayData.length > 0 && (
          <p className="help">{t('pv.chart.noPanelDetails')}</p>
        )}
        {view === 'energy' && (
          <p className="help">{t('pv.chart.energyHelp')}</p>
        )}
        {period !== 'day' && summaryData.length > 0 && (
          <p className="help">{t('pv.chart.periodHelp')}</p>
        )}
      </section>
    </div>
  );
};
