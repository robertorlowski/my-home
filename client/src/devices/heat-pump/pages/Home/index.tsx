// Widok główny pompy (/ i /hp) w układzie makiety „Instrument” (#s-hp-podglad): karta hero z temperaturą zbiornika
// (HP.Ttarget, czujnik w środku zbiornika, nie zadana) na pasku zakresu Tmin–Tmax, stan sprężarki i cztery KPI
// (moc, PV teraz, tryb, na zewnątrz); karta „Pomiary”, karta „Obieg” (stan przekaźników z telemetrii) i karta
// „Energia dziś” (zużycie, PV zużyte przez pompę i koszt G12w z bilansu serwera GET /hp/monthly-summary, mini wykres
// mocy i PV z GET /hp/4day).
// Dane bieżące z GET /hp (HP z CHPC, PV, t_out, COP zbiornika) i dzwonek błędu z GET /hp/last-error; odświeża je
// komunikat WebSocket „update” (po zapisie telemetrii) i zegar co 30 s. Energia dnia odświeżana co 5 min.
// Na górze paski: „Offline od …” (OfflineBanner), „Pompa ciepła wstrzymana” (kocioł pali albo jest gorący,
// pelletBlock z GET /hp/cwu-loading) i „Ładowanie CWU” w kotle (kocioł w trybie pompy ciepła).
import '../style.css';
import './style.css';
import { HpRequests } from '../../api';
import { wsAddressServer } from '../../../../core/http';
import { getSelectedDevice } from '../../../../core/context/DeviceContext';
import { DeviceRequests } from '../../../../core/api';
import { PumpConnection } from '../../../../core/types';
import { HpCwuLoading, HpEntry, HpMetrics, PvMetrics } from '../../types';
import React, { useEffect, useRef, useState } from 'react';
import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cc } from '../../../../core/chartColors';
import { errorDescription, ERROR_LOCK_LIMIT, isLocked } from '../../utils/errors';
import { fetchData, fetchMonthlySummary, formatDateYMD } from '../../utils/utils';
import { OfflineBanner } from '../../../../core/components/OfflineBanner';
import { Switch } from '../../components/Switch';
import { BellIcon } from '../../components/icons';
import { getLang, locale, t as tr, useLang } from '../../../../core/i18n';

// Telemetria starsza niż to jest nieaktualna (jak „Brak łączności” na kafelku listy): od 5 min uwaga, po godzinie błąd;
// wartości z pompy są wtedy ukryte.
const STALE_AFTER_MS = 5 * 60 * 1000;
const TODAY_REFRESH_MS = 5 * 60 * 1000;

const fmt = (value: unknown, digits = 1): string => {
  const number = Number(value);
  return value === undefined || value === null || value === '' || Number.isNaN(number)
    ? '---'
    : number.toLocaleString(locale(getLang()), { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const fmtInt = (value: unknown): string => fmt(value, 0);
const minutes = (seconds?: number) => (seconds ? `${Math.floor(seconds / 60)} min` : '---');
const timeOfDay = (time?: string) => time?.split(' ')[1]?.slice(0, 5) ?? '';
// chwila błędu z co ("YYYY.MM.DD HH:MM:SS", czas polski) jako "07.11.2026 12:03"
const errorWhen = (time?: string) => {
  const match = time?.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}` : time ?? '';
};

// co od 1.2.0: MANUAL / AUTO / OFF; starsze co: M, A, PV, CWU
const modeLabel = (mode?: string): string => (
  mode === 'OFF' ? tr('hp.mode.offLabel')
    : mode === 'A' || mode === 'AUTO' ? tr('hp.mode.AUTO')
    : mode === 'PV' ? tr('hp.mode.autoPv')
    : mode === 'CWU' ? tr('tile.cwu')
    : mode === 'M' || mode === 'MANUAL' ? tr('hp.mode.MANUAL')
    : '---'
);

const minutesOfDay = (time: string): number => {
  const match = time.match(/[ T](\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
};
const hhmm = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

type TodayEnergy = { kwh: number; pvUsedKwh: number; costPln: number; points: Array<{ t: number; w: number; pv: number }> };

// Stany _data, _hp i _pv to cała odpowiedź GET /hp oraz jej pola HP i PV; _lastError z /hp/last-error.
const HP: React.FC = () => {
  const { t, locale: loc } = useLang();
  const [_pv, setPV] = useState<PvMetrics | null >(null);
  // ostatni odczyt HP z serwera; _hp (niżej) to to samo albo null, gdy odczyt jest nieaktualny
  const [_hpLast, setHP] = useState<HpMetrics | null >(null);
  const [_data, setData] = useState<HpEntry | null>(null);
  const [_lastError, setLastError] = useState<HpEntry | null>(null);
  const [cwuLoading, setCwuLoading] = useState<HpCwuLoading | null>(null);
  const [today, setToday] = useState<TodayEnergy | null>(null);
  const ws = useRef<WebSocket | null>(null);

  // Wiek ostatniego zapisanego odczytu i kontakt z co: co 30 s zegar i ponowne pobranie GET /hp, bo bez odczytów
  // z pompy WebSocket „update” nie przychodzi.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      HpRequests.getCoData().then((resp) => { setData(resp); setHP(resp?.HP); setPV(resp?.PV); }).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const readAt = _data?.createdAt ? new Date(_data.createdAt).getTime() : undefined;
  const dataAge = readAt === undefined || Number.isNaN(readAt) ? undefined : Math.max(0, now - readAt);
  const stale = dataAge !== undefined && dataAge > STALE_AFTER_MS;
  // Nieaktualny odczyt nie jest pokazywany jako stan pompy: temperatury, moc i przekaźniki to „---”, a nad kartami
  // jest pasek „Offline od …”. PV i temperatura zewnętrzna idą z innych źródeł i zostają.
  const _hp = stale ? null : _hpLast;
  // co zgłasza się co 10–30 s także przy wyłączonej pompie (HP puste): świeży kontakt = pompa (CHPC) nie odpowiada
  const contactAt = _data?.contactAt ? new Date(_data.contactAt).getTime() : NaN;
  const coResponding = !Number.isNaN(contactAt) && now - contactAt <= STALE_AFTER_MS;

  // Podłączenie pompy z okna „Dane sterownika” (pumpConfig.connection): „CWU” albo „CO”; bez zapisanej definicji
  // „CWU” (domyślne podłączenie, PumpConfigFields). Najpierw z zapisanego wyboru, potem ze świeżej listy urządzeń.
  const [connection, setConnection] = useState<PumpConnection | undefined>(getSelectedDevice()?.pumpConfig?.connection);
  useEffect(() => {
    const rootId = getSelectedDevice()?.rootId;
    DeviceRequests.getDevices().then((list) => {
      const current = list?.find((item) => item.rootId === rootId);
      if (current) setConnection(current.pumpConfig?.connection);
    });
  }, []);

  const loadCwuLoading = () => {
    HpRequests.getCwuLoading().then(setCwuLoading).catch(() => setCwuLoading(null));
  };
  useEffect(() => {
    loadCwuLoading();
    const timer = window.setInterval(loadCwuLoading, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadLastError = () => {
    HpRequests.getHpLastError()
      .then(resp => setLastError(resp))
      .catch(err => console.log(err));
  };

  // Energia dziś: bilans dnia z serwera (godzinowy jak w eLiczniku, PV z liczników falowników) i co piąty rekord
  // dnia na mini wykres. Pobierane osobno od telemetrii bieżącej, co 5 min.
  const loadToday = () => {
    const today = formatDateYMD(new Date());
    Promise.all([fetchData(true, today), fetchMonthlySummary(today, today, 'day')]).then(([rows, summaries]) => {
      const result = summaries?.[0] ?? { consumptionKWh: 0, pvUsedKWh: 0, totalVariableCostPLN: 0 };
      const points = rows
        .filter((row) => row?.time)
        .sort((a, b) => a.time.localeCompare(b.time))
        .filter((_, index) => index % 5 === 0)
        .map((row) => ({ t: minutesOfDay(row.time), w: Number(row.Watts) || 0, pv: Number(row.pv) || 0 }));
      setToday({ kwh: result.consumptionKWh, pvUsedKwh: result.pvUsedKWh, costPln: result.totalVariableCostPLN, points });
    }).catch(() => setToday(null));
  };
  useEffect(() => {
    loadToday();
    const timer = window.setInterval(loadToday, TODAY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
   HpRequests.getCoData()
        .then(resp => {
          setData(resp);
          setHP(resp.HP);
          setPV(resp.PV);
        })
        .catch(err => {
          console.log(err);
        });
      loadLastError();
    },
    []
  );

  // Połączenie na czas otwarcia widoku; bez ponawiania po zerwaniu (wtedy dane stoją do przeładowania).
  // Serwer wysyła komunikaty tylko połączeniom z tym rootId; to samo połączenie dostaje też
  // „operation” przeznaczone dla co, dlatego liczy się tylko „update” (po zapisie telemetrii z HP.Ttarget).
  // Nowe połączenie po zmianie sterownika zapewnia key={rootId} w DeviceRoute (App.tsx).
  useEffect(() => {
    const device = getSelectedDevice();
    const wsUrl = new URL(wsAddressServer());
    if (device) wsUrl.searchParams.set('rootId', device.rootId);
    ws.current = new WebSocket(wsUrl.toString());
    ws.current.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; rootId?: string };
        if (message.type !== 'update' || message.rootId !== device?.rootId) return;

        // pobierz aktualne dane z REST API
        HpRequests.getCoData()
          .then(resp => {
            setData(resp);
            setHP(resp?.HP);
            setPV(resp?.PV);
          })
          .catch(err => console.error('Błąd przy pobieraniu danych:', err));
        loadLastError();
        loadCwuLoading();
      } catch (error) {
        console.error('Nieprawidłowy komunikat WebSocket:', error);
      }
    };
    return () => {
      ws.current?.close();
    };
  }, []);

  // Pasek zakresu: położenie Ttarget między Tmin i Tmax (granice, na których pompa pracuje teraz; w trybie CWU
  // to granice CWU), przycięte do 0–100 %.
  const tMin = Number(_hp?.Tmin);
  const tMax = Number(_hp?.Tmax);
  const tNow = Number(_hp?.Ttarget);
  const hasRange = Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin;
  const position = hasRange && Number.isFinite(tNow) ? Math.max(0, Math.min(100, ((tNow - tMin) / (tMax - tMin)) * 100)) : 0;

  const running = Number(_hp?.HPS) > 0;
  const locked = isLocked(_hp?.ERRc);
  const errorText = _lastError?.error_code ? errorDescription(_lastError.error_code) : '';
  const colors = cc();

  return (
    <div className="page page-device hp-view hp-home">
      {stale && dataAge !== undefined && (
        <OfflineBanner since={readAt} now={now} detail={coResponding ? t('hp.offlineChpc') : t('hp.offlineNoLink')} />
      )}
      {cwuLoading?.pelletBlock && (
        <div className="banner banner-off" role="alert">
          <div>
            <strong>{t('hp.pausedTitle')}</strong>
            <span>{t('hp.pausedText', { value: cwuLoading.resumeBelow ?? 50 })}</span>
          </div>
        </div>
      )}
      {cwuLoading?.active && (
        <div className="alert alert-warn hp-cwu-loading">
          <div>
            <strong>{t('hp.cwuLoadingTitle')}</strong>
            <span>
              {cwuLoading.since && t('hp.since', { time: new Date(cwuLoading.since).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }) })}
              {cwuLoading.pumpOff && ` · ${t('hp.pumpOff')}`}
            </span>
          </div>
        </div>
      )}

      <section className={`hero card card-hero${stale ? ' is-stale' : ''}`}>
        <div className="hero-main">
          <span className="hero-label">{t('hp.tankTemperature')} {connection === 'co' ? t('hp.co') : t('tile.cwu')}</span>
          <div className="hero-value">
            <span className="hero-num">{fmt(_hp?.Ttarget)}</span>
            <span className="hero-unit">°C</span>
          </div>
          <div className="range" aria-label={hasRange ? t('hp.rangeLabel', { min: fmt(tMin), max: fmt(tMax), now: fmt(tNow) }) : t('hp.rangeUnknown')}>
            <span className="range-min">{fmtInt(_hp?.Tmin)}</span>
            <span className="range-bar">
              <span className="range-fill" style={{ '--p': `${position}%` } as React.CSSProperties} />
              <span className="range-pin" style={{ '--p': `${position}%` } as React.CSSProperties} />
            </span>
            <span className="range-max">{fmtInt(_hp?.Tmax)}</span>
          </div>
          <span className="hero-note">
            {t('tile.target')} {fmtInt(_hp?.Tmin)}–{fmtInt(_hp?.Tmax)} °C
            {_data?.time && <> · {t('hp.reading')} {timeOfDay(_data.time)}</>}
          </span>
        </div>
        <div className="hero-side">
          <div className={`state-pill ${running ? 'state-on is-running' : 'is-idle'}`}>
            {/* kropka przed napisem w jednej linii (pod nimi czas i energia cyklu) */}
            <span className="state-pill-title"><i className="dot" />{_hp ? (running ? t('header.compressorRuns') : t('hp.compressorIdle')) : t('hp.noPumpData')}</span>
            {_hp && <small>{minutes(_hp.lt_hp_on)} · {fmt(Number(_hp.lt_pow) / 1000, 2)} kWh {running ? t('hp.inCycle') : t('hp.inLastCycle')}</small>}
          </div>
          <div className="hero-kpis">
            <div className="kpi"><span className="kpi-label">{t('tile.icon.bolt')}</span><span className="kpi-value">{fmtInt(_hp?.Watts)}<small>W</small></span></div>
            <div className="kpi"><span className="kpi-label">{t('hp.pvNow')}</span><span className="kpi-value">{fmtInt(_pv?.total_power)}<small>W</small></span></div>
            <div className="kpi"><span className="kpi-label">{t('tile.icon.sliders')}</span><span className="kpi-value hp-mode-value">{modeLabel(_data?.work_mode)}</span></div>
            {/* 0,0 °C to też odczyt (dawniej warunek na prawdziwość pokazywał wtedy „---”) */}
            <div className="kpi"><span className="kpi-label">{t('hp.outside')}</span><span className="kpi-value">{typeof _data?.t_out === 'number' ? fmt(_data.t_out) : '---'}<small>°C</small></span></div>
          </div>
        </div>
      </section>

      <section className="card">
        <header className="card-head"><h2>{t('hp.measurements')}</h2><span className="card-hint">{_data?.time ? `${t('hp.reading')} ${_data.time.split(' ')[1] ?? ''}` : ''}</span></header>
        <dl className="measures">
          <div><dt>{t('hp.tBeforeEvap')}</dt><dd className={Number(_hp?.Tbe) < 0 ? 'is-bad' : ''}>{fmt(_hp?.Tbe)} °C</dd></div>
          <div><dt>{t('hp.tAfterEvap')}</dt><dd className={Number(_hp?.Tae) < 0 ? 'is-bad' : ''}>{fmt(_hp?.Tae)} °C</dd></div>
          <div><dt>{t('hp.tOut')}</dt><dd>{fmt(_hp?.Tho)} °C</dd></div>
          <div><dt>{t('hp.tCompressor')}</dt><dd>{fmt(_hp?.Tsump)} °C</dd></div>
          <div><dt>{t('hp.eevPosition')}</dt><dd>{fmtInt(_hp?.EEV_pos)} <small>/ {fmtInt(_hp?.EEVmin)}–{fmtInt(_hp?.EEVmax)}</small></dd></div>
          <div><dt>{t('hp.eevSuperheat')}</dt><dd>{fmt(_hp?.EEV_dt)} K <small>{t('hp.sensor')} {fmt(_hp?.EEV)} °C</small></dd></div>
          <div><dt title={t('hp.powerLimitTip')}>{t('hp.powerLimit')}</dt><dd>{fmtInt(_hp?.WWatt)} W</dd></div>
          <div><dt title={t('hp.cycleEnergyTip')}>{t('hp.cycleEnergy')}</dt><dd>{fmtInt(_hp?.lt_pow)} Wh</dd></div>
          <div><dt>{t('hp.cycleTime')}</dt><dd>{_hp ? minutes(_hp.lt_hp_on) : '---'}</dd></div>
          <div><dt title={t('hp.copTip')}>{t('hp.cop')}</dt><dd>{fmt(_data?.cop)} <small>{fmt(_data?.t_min)}–{fmt(_data?.t_max)} °C</small></dd></div>
          <div>
            <dt>{t('hp.errors')}</dt>
            <dd className="hp-errors">
              {errorText || locked
                ? <span className="chip chip-err"><BellIcon /> {locked ? t('hp.controlLockedLower') : `${t('hp.errorLower')} ${_lastError?.error_code}`}</span>
                : <span className="ok-text">{t('wx.none')}</span>}
              <small>{t('hp.counter')} {_hp?.ERRc ?? '---'}/{ERROR_LOCK_LIMIT}</small>
            </dd>
          </div>
        </dl>
        {/* ostatni błąd z ostatniej doby: opis i chwila w ramce jak w Ustawieniach pompy */}
        {errorText && (
          <div className="alert alert-err hp-error-alert">
            <BellIcon />
            <div>
              <strong>{t('hp.set.errorWord')} {_lastError?.error_code} · {errorText}</strong>
              <span>{errorWhen(_lastError?.time)}</span>
            </div>
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <header className="card-head"><h2>{t('hp.circuit')}</h2><span className="card-hint">{t('hp.relayState')}</span></header>
          <ul className="toggle-list">
            <li><span className="t-name">{t('type.heat_pump')}</span><Switch on={Boolean(_hp?.CO)} label={t('type.heat_pump')} /></li>
            <li><span className="t-name">{t('hp.hotCircuit')}</span><Switch on={Boolean(_hp?.HCS)} label={t('hp.hotCircuit')} /></li>
            <li><span className="t-name">{t('hp.coldCircuit')}</span><Switch on={Boolean(_hp?.CCS)} label={t('hp.coldCircuit')} /></li>
            <li><span className="t-name">{t('hp.sumpHeater')}</span><Switch on={Boolean(_hp?.SHS)} label={t('hp.sumpHeater')} /></li>
            {/* FLW: CHPC od 2026-10-11; starszy firmware go nie wysyła */}
            <li><span className="t-name">{t('hp.evapFlow')}{_hp && _hp.FLW === undefined && <small> ({t('hp.noSensor')})</small>}</span><Switch on={Boolean(Number(_hp?.FLW))} label={t('hp.flow')} /></li>
            <li><span className="t-name">{t('hp.forcedWork')} <small>(t. min = t. max)</small></span><Switch on={Boolean(_hp?.F)} label={t('hp.forcedWork')} /></li>
          </ul>
        </section>
        <section className="card">
          <header className="card-head"><h2>{t('hp.energyToday')}</h2></header>
          <div className="energy">
            <div className="energy-num"><span>{today ? fmt(today.kwh, 2) : '---'}</span><small>{t('hp.kwhConsumed')}</small></div>
            <div className="energy-num"><span>{today ? fmt(today.pvUsedKwh, 2) : '---'}</span><small>{t('hp.kwhFromPv')}</small></div>
            <div className="energy-num"><span>{_pv?.total_prod_today !== undefined ? fmt(_pv.total_prod_today / 1000, 2) : '---'}</span><small>{t('hp.kwhPvToday')}</small></div>
            {/* koszt zmienny dnia w taryfie G12w (serwer: energy-balance.service.ts), dawniej w nagłówku karty */}
            <div className="energy-num"><span>{today ? fmt(today.costPln, 2) : '---'}</span><small>{t('hp.plnTariff')}</small></div>
          </div>
          <div className="chart chart-sm" aria-label={t('hp.miniChartLabel')}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={today?.points ?? []} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <XAxis type="number" dataKey="t" domain={[0, 1440]} ticks={[0, 360, 720, 1080, 1440]} tickFormatter={hhmm}
                  tick={{ fill: colors.axis, fontSize: 11 }} stroke={colors.line} />
                <YAxis tick={{ fill: colors.axis, fontSize: 11 }} stroke={colors.line} width={48} />
                <Tooltip content={<MiniTooltip />} />
                <Area type="monotone" dataKey="pv" name="PV" stroke="none" fill={colors.sun} fillOpacity={0.28} isAnimationActive={false} />
                <Bar dataKey="w" name={t('hp.consumption')} fill={colors.s1} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </div>
  );
}

// Dymek mini wykresu: godzina, pobór i PV.
const MiniTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload?: { t: number; w: number; pv: number } }> }> = ({ active, payload }) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <strong>{hhmm(point.t)}</strong>
      <span><i style={{ background: cc().s1 }} />{tr('hp.consumptionLower')} <b>{fmtInt(point.w)} W</b></span>
      <span><i style={{ background: cc().sun }} />PV <b>{fmtInt(point.pv)} W</b></span>
    </div>
  );
};

export default HP;
