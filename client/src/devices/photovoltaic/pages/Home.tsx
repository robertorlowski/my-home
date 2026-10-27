// Widok główny fotowoltaiki (/), układ „Instrument” z makiety (makiety/src/makieta.html, #s-pv-podglad): karta hero
// „Moc teraz” z KPI dziś / miesiąc / łącznie / falownik (temperatura), karta „Moc w ciągu dnia” (krzywa z dnia
// ostatniego odczytu) i karta „Panele”: porty mikrofalowników z paskiem mocy względem szczytu dnia, produkcją dziś
// i chipem stanu (produkuje, słabiej = ponad 15 % poniżej średniej produkcji dnia, bez produkcji, brak łączności,
// alarm). GET /photovoltaic/current i /day, odświeżanie co 60 s; przy nieaktualnym odczycie pasek OfflineBanner.
import { useEffect, useState } from 'react';
import { cc, tooltipStyle } from '../../../core/chartColors';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { OfflineBanner } from '../../../core/components/OfflineBanner';
import { PhotovoltaicRequests } from '../api';
import { PvCurrent, PvDay, PvPanel } from '../types';
import {
  stateLabel, formatDateTime, formatDay, formatEnergy, formatPower, formatTime, plural, shortSerial, splitEnergy, splitPower,
  splitTemp, todayWarsaw, warsawDay,
} from '../utils/pv';
import { t as tr, useLang } from '../../../core/i18n';
import './style.css';

const REFRESH_MS = 60_000;
// panel „słabiej”: produkcja dziś poniżej 85 % średniej paneli (zacienienie, zabrudzenie, usterka)
const LOW_RATIO = 0.85;

type PanelRow = { panel: PvPanel; low: boolean; belowPct: number };

const Kpi = ({ label, value }: { label: string; value: [string, string] }) => (
  <div className="kpi">
    <span className="kpi-label">{label}</span>
    <span className="kpi-value">{value[0]}{value[1] && <small>{value[1]}</small>}</span>
  </div>
);

const chipFor = ({ panel, low }: PanelRow) => {
  if (panel.state === 'offline' || panel.state === 'alarm') return <span className="chip chip-err">{stateLabel(panel.state)}</span>;
  if (low) return <span className="chip chip-warn">{tr('pv.weaker')}</span>;
  if (panel.state === 'produces') return <span className="chip chip-ok">{stateLabel('produces')}</span>;
  return <span className="chip chip-off">{stateLabel('idle')}</span>;
};

export const PhotovoltaicHome: React.FC = () => {
  const { t } = useLang();
  const [current, setCurrent] = useState<PvCurrent | null | undefined>(undefined);
  const [day, setDay] = useState<PvDay | null>(null);

  // krzywa mocy z dnia ostatniego odczytu (dziś albo — przy braku odczytów — ostatni dzień z danymi)
  useEffect(() => {
    const load = () => PhotovoltaicRequests.getCurrent().then((result) => {
      setCurrent(result);
      const day = result?.readAt ? warsawDay(result.readAt) : todayWarsaw();
      PhotovoltaicRequests.getDay(day).then(setDay);
    });
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // mikrofalowniki = różne numery seryjne z listy portów (serial + port = panel)
  const panels = current?.panels ?? [];
  const inverters = [...new Set(panels.map((panel) => panel.serial))];
  // skala pasków: szczyt paneli w tym dniu (wieczorne 5 W daje wąski pasek, nie pełny)
  const maxPanelPower = Math.max(1, ...panels.map((p) => p.power ?? 0),
    ...(day?.panels ?? []).flatMap((p) => p.points.map((point) => point.power)));
  // „słabiej”: porównanie produkcji dziś z średnią portów (nie mocy chwilowej, którą zmienia przelotna chmura);
  // tylko dla paneli pracujących (offline i alarm mają własny chip)
  const withToday = panels.filter((panel) => panel.prod_today !== undefined);
  const averageToday = withToday.length ? withToday.reduce((sum, panel) => sum + (panel.prod_today ?? 0), 0) / withToday.length : 0;
  const rows: PanelRow[] = panels.map((panel) => {
    const today = panel.prod_today ?? 0;
    const low = averageToday > 0 && (panel.state === 'produces' || panel.state === 'idle') && today < averageToday * LOW_RATIO;
    return { panel, low, belowPct: Math.round(100 * (1 - today / (averageToday || 1))) };
  });
  const chartData = (day?.points ?? []).map((p) => ({ label: formatTime(p.t), moc: p.power }));
  const [powerNum, powerUnit] = splitPower(current?.power);
  const note = [
    day?.peakW !== undefined ? t('pv.home.dayPeak', { power: formatPower(day.peakW), time: formatTime(day.peakAt) }) : '',
    panels.length ? plural(panels.length, 'pv.n.panels') : '',
    inverters.length ? `${plural(inverters.length, 'pv.n.inverters')} HMS` : '',
    current?.readAt ? `${t('hp.reading')} ${formatDateTime(current.readAt)}` : '',
  ].filter(Boolean).join(' · ');
  const panelsHint = inverters.length === 1
    ? `${t('pv.inverterLower')} ${shortSerial(inverters[0])} · ${t('pv.home.barHint')}`
    : `${plural(inverters.length, 'pv.n.inverters')} · ${t('pv.home.barHint')}`;

  return (
    <div className="page page-device pv-page">
      {current === undefined && <section className="card"><p className="help">{t('common.loading')}</p></section>}
      {current === null && <section className="card"><p className="help danger-text">{t('pv.loadFailed')}</p></section>}
      {current && !current.readAt && <section className="card"><p className="help">{t('pv.home.noReadings')}</p></section>}
      {current?.readAt && (
        <>
          {current.stale && <OfflineBanner since={current.readAt} detail={t('pv.home.stale')} />}
          <section className="hero card card-hero">
            <div className="hero-main">
              <span className="hero-label">{t('pv.home.powerNow')}</span>
              <div className="hero-value"><span className="hero-num">{powerNum}</span>{powerUnit && <span className="hero-unit">{powerUnit}</span>}</div>
              <span className="hero-note">{note}</span>
            </div>
            <div className="hero-side">
              <div className="hero-kpis">
                <Kpi label={t('tile.icon.battery')} value={splitEnergy(current.todayWh)} />
                <Kpi label={t('period.month')} value={splitEnergy(current.monthWh)} />
                <Kpi label={t('pv.home.total')} value={splitEnergy(current.totalWh)} />
                <Kpi label={t('tile.inverter')} value={splitTemp(current.temperature)} />
              </div>
            </div>
          </section>

          <section className="card">
            <header className="card-head">
              <h2>{t('pv.home.dayPower')}</h2>
              {day && <span className="card-hint">{t('pv.home.every5min')} · {formatDay(day.date)}</span>}
            </header>
            {chartData.length ? (
              <div className="chart chart-md">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={cc().grid} vertical={false} />
                    <XAxis dataKey="label" stroke={cc().line} tick={{ fill: cc().axis, fontSize: 11 }} tickLine={false} interval="preserveStartEnd" minTickGap={40} />
                    <YAxis stroke={cc().line} axisLine={false} tickLine={false} width={52} tick={{ fill: cc().axis, fontSize: 11 }} tickFormatter={(value: number) => `${value} W`} />
                    <Tooltip {...tooltipStyle()} formatter={(value) => [formatPower(Number(value)), t('tile.icon.bolt')]} />
                    <Area type="monotone" dataKey="moc" stroke={cc().sun} strokeWidth={2} fill={cc().sun} fillOpacity={0.28} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <p className="help">{t('pv.noneDay')}</p>}
          </section>

          <section className="card">
            <header className="card-head">
              <h2>{t('tile.icon.panel')}</h2>
              {current.panelsAvailable && <span className="card-hint">{panelsHint}</span>}
            </header>
            {!current.panelsAvailable && <p className="help">{t('pv.home.noPanelDetails')}</p>}
            {current.panelsAvailable && (
              <ul className="panels">
                {rows.map((row) => (
                  <li key={row.panel.key} className={row.low ? 'is-low' : undefined}>
                    <span className="panel-name">{t('pv.portCap')} {row.panel.port}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ '--p': `${Math.round(100 * (row.panel.power ?? 0) / maxPanelPower)}%` } as React.CSSProperties} />
                    </span>
                    <span className="panel-val">{formatPower(row.panel.power)}</span>
                    <span className="panel-sub">
                      {[
                        inverters.length > 1 ? shortSerial(row.panel.serial) : '',
                        row.panel.prod_today !== undefined ? `${formatEnergy(row.panel.prod_today)} ${t('wx.today')}` : '',
                        row.low ? t('pv.home.belowAverage', { pct: row.belowPct }) : '',
                      ].filter(Boolean).join(' · ')}
                    </span>
                    {chipFor(row)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
};
