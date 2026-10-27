// Zakładka Dane hydroforu (/data) w układzie makiety „Instrument” (#s-tank-dane): przełącznik
// „Uruchomienia pompy” / „Odczyty wodomierza”, nawigacja po miesiącu i CSV w pasku filtrów; tabela uruchomień
// z miesiąca (z „≈” i chipem „z kolejki” przy czasie przybliżonym) albo karta odczytów wodomierza: formularz
// (data, stan, uwagi) i lista z przyrostem, czasem pompy i przepływem okresu (GET /water-pressure-tank/meter/summary).
// Dane pobierane przy wejściu i zmianie miesiąca, bez odświeżania cyklicznego.
import { FormEvent, useEffect, useState } from 'react';
import { IconButton } from '../../../core/components/IconButton';
import { TrashIcon } from '../../../core/components/icons';
import { WaterPressureTankRequests } from '../api';
import { WaterMeterReading, WaterMeterSummary, WaterPressureTankRun } from '../types';
import {
  compressorSeconds, downloadText, formatDate, formatDuration, formatLiters, formatTime, monthBounds, monthLabel,
  runsToCsv, shiftMonth, sumPumpSeconds, sumWater, todayWarsaw,
} from '../utils/water';
import { DateNav } from '../components/DateNav';
import { DownloadIcon } from '../components/TankIcons';
import { getLang, locale, useLang } from '../../../core/i18n';
import './style.css';

type View = 'runs' | 'meter';

const TABS: { value: View; key: string }[] = [
  { value: 'runs', key: 'wt.data.runsTab' },
  { value: 'meter', key: 'wt.data.meterTab' },
];

// Zakładka Dane hydroforu: uruchomienia pompy z miesiąca i odczyty wodomierza.
// Porównanie wodomierza z szacunkiem jest na Wykresie (Rok).
export const WaterPressureTankData: React.FC = () => {
  const { t } = useLang();
  const [view, setView] = useState<View>('runs');
  const [month, setMonth] = useState(todayWarsaw().slice(0, 7));
  const [runs, setRuns] = useState<WaterPressureTankRun[] | null>(null);
  const currentMonth = todayWarsaw().slice(0, 7);

  useEffect(() => {
    setRuns(null);
    WaterPressureTankRequests.getRuns(monthBounds(month).from, monthBounds(month).to).then((result) => setRuns(result ?? []));
  }, [month]);

  return (
    <main className="page page-device tank-page">
      <div className="filters">
        <div className="segmented seg-inline" role="radiogroup" aria-label={t('wt.data.scope')}>
          {TABS.map((tab) => (
            <label key={tab.value} className="seg">
              <input type="radio" name="tank-data-view" checked={view === tab.value} onChange={() => setView(tab.value)} />
              <span>{t(tab.key)}</span>
            </label>
          ))}
        </div>
        {view === 'runs' && (
          <>
            <DateNav label={monthLabel(month)} unit={t('common.monthUnit')} onPrev={() => setMonth(shiftMonth(month, -1))}
              onNext={() => setMonth(shiftMonth(month, 1))} nextDisabled={month >= currentMonth} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={!runs?.length}
              onClick={() => runs && downloadText(runsToCsv(runs), `hydrofor-${month}.csv`)}>
              <DownloadIcon />CSV
            </button>
          </>
        )}
      </div>
      {view === 'runs' ? <RunsCard runs={runs} /> : <MeterCard />}
    </main>
  );
};

function RunsCard({ runs }: { runs: WaterPressureTankRun[] | null }) {
  const { t, tn } = useLang();
  const water = runs ? sumWater(runs) : null;
  return (
    <section className="card card-table">
      <header className="card-head">
        <h2>{t('wt.data.monthRuns')}</h2>
        {runs && runs.length > 0 && (
          <span className="card-hint">
            {water !== null && <>{t('wt.total')} {formatLiters(Math.round(water))} l · </>}
            {t('tank.pump')} {formatDuration(sumPumpSeconds(runs))} · {tn('wt.runs', runs.length)}
          </span>
        )}
      </header>
      {runs === null && <p className="help">{t('common.loading')}</p>}
      {runs?.length === 0 && <p className="help">{t('wt.data.noneMonth')}</p>}
      {runs && runs.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>{t('wt.csv.date')}</th><th>{t('wt.col.time')}</th><th className="num">{t('tile.icon.bubbles')}</th><th className="num">{t('tile.icon.timer')}</th><th className="num">{t('tile.icon.drop')}</th><th>{t('wt.col.notes')}</th></tr>
              </thead>
              <tbody>
                {/* serwer zwraca od najstarszego; tabela od najnowszego. waterLiters null = brak przepływu z wodomierza */}
                {[...runs].reverse().map((run) => (
                  <tr key={run._id}>
                    <td>{formatDate(run.pumpStart)}</td>
                    <td title={run.timeApproximate ? t('wt.approximateTip') : undefined}>
                      {run.timeApproximate ? '≈ ' : ''}{formatTime(run.pumpStart)}
                    </td>
                    <td className="num">{compressorSeconds(run) !== undefined ? `${compressorSeconds(run)} s` : '—'}</td>
                    <td className="num" title={run.manualSeconds ? t('wt.manualTip', { n: run.manualSeconds }) : undefined}>
                      {run.inProgress ? <em>{formatDuration(run.pumpSeconds)} …</em> : formatDuration(run.pumpSeconds)}
                    </td>
                    <td className="num">{run.waterLiters === null ? '—' : `${formatLiters(Math.round(run.waterLiters))} l`}</td>
                    <td>
                      {run.timeApproximate && <span className="chip chip-off">{t('wt.data.queued')}</span>}
                      {run.inProgress && <span className="chip chip-ok">{t('sw.table.ongoing')}</span>}
                      {!!run.manualSeconds && <span className="chip chip-warn">{t('wt.data.manualCompressor', { n: run.manualSeconds })}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="table-foot">{t('wt.data.foot')}</footer>
        </>
      )}
    </section>
  );
}

// Odczyt wodomierza ma samą datę; zapisywany jest jako południe czasu lokalnego,
// żeby w każdej strefie wypadał tego samego dnia.
const readingDate = (date: string) => new Date(`${date}T12:00:00`).toISOString();

const formatM3 = (value: number) => value.toLocaleString(locale(getLang()), { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// Odczyty wodomierza: formularz i lista od najnowszego; przy każdym odczycie przyrost od poprzedniego, a gdy
// serwer policzył ten okres (meter/summary) — czas pompy i przepływ okresu.
function MeterCard() {
  const { t, locale: loc } = useLang();
  const [readings, setReadings] = useState<WaterMeterReading[] | null>(null);
  const [summary, setSummary] = useState<WaterMeterSummary | null>(null);
  const [readAt, setReadAt] = useState(todayWarsaw());
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    WaterPressureTankRequests.getMeterReadings().then((list) => setReadings(list ?? []));
    // okresy między odczytami nie zależą od roku (serwer zwraca wszystkie)
    WaterPressureTankRequests.getMeterSummary(Number(todayWarsaw().slice(0, 4))).then((result) => result && setSummary(result));
  };
  useEffect(() => { load(); }, []);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const valueM3 = Number(value.replace(',', '.'));
    if (!readAt) {
      setError(t('wt.meter.dateRequired'));
      return;
    }
    if (!value.trim() || !Number.isFinite(valueM3) || valueM3 < 0) {
      setError(t('wt.meter.valueRequired'));
      return;
    }
    setError('');
    const response = await WaterPressureTankRequests.addMeterReading({ readAt: readingDate(readAt), valueM3, note });
    if (!response || !response.ok) {
      setError(t('wt.meter.saveFailed'));
      return;
    }
    setValue('');
    setNote('');
    load();
  };

  const remove = async (reading: WaterMeterReading) => {
    if (!window.confirm(t('wt.meter.deleteConfirm', { date: formatDate(reading.readAt), value: reading.valueM3 }))) return;
    try {
      await WaterPressureTankRequests.deleteMeterReading(reading._id);
      load();
    } catch {
      setError(t('wt.meter.deleteFailed'));
    }
  };

  // okres z meter/summary kończy się dokładnie w chwili odczytu (period.to = readAt), stąd dopasowanie po czasie
  const periodFor = (reading: WaterMeterReading) =>
    summary?.periods.find((period) => new Date(period.to).getTime() === new Date(reading.readAt).getTime());

  return (
    <section className="card">
      <header className="card-head"><h2>{t('wt.data.meterTab')}</h2><span className="card-hint">{t('wt.meter.hint')}</span></header>
      <form className="form-row" onSubmit={add}>
        <div className="range-inputs tank-meter-inputs">
          <input type="date" value={readAt} aria-label={t('wt.meter.readDate')} onChange={(event) => setReadAt(event.currentTarget.value)} />
          <input type="text" inputMode="decimal" className="w-wide" placeholder={t('wt.meter.valuePlaceholder')} aria-label={t('wt.meter.valueLabel')}
            value={value} onChange={(event) => setValue(event.currentTarget.value)} />
          <span className="unit-txt">m³</span>
          <input type="text" className="w-text" placeholder={t('wt.meter.notePlaceholder')} aria-label={t('wt.col.notes')}
            value={note} onChange={(event) => setNote(event.currentTarget.value)} />
        </div>
        <button type="submit" className="btn btn-primary btn-sm">{t('wt.meter.add')}</button>
      </form>
      {error && <p className="help danger-text">{error}</p>}
      {readings === null && <p className="help">{t('common.loading')}</p>}
      {readings?.length === 0 && <p className="help">{t('wt.meter.none')}</p>}
      {readings && readings.length > 0 && (
        <ul className="people">
          {[...readings].reverse().map((reading, index, list) => {
            const previous = list[index + 1];
            const period = periodFor(reading);
            return (
              <li key={reading._id}>
                <span className="person">
                  <strong>{formatDate(reading.readAt)} · {formatM3(reading.valueM3)} m³</strong>
                  <small>
                    {previous
                      ? <>+ {((reading.valueM3 - previous.valueM3)).toLocaleString(loc, { maximumFractionDigits: 2 })} m³ {t('wt.meter.sincePrevious')}</>
                      : t('wt.meter.first')}
                    {period && period.pumpSeconds > 0 && (
                      <> · {t('tank.pump')} {formatDuration(period.pumpSeconds)} · {(period.meterLiters / (period.pumpSeconds / 60)).toLocaleString(loc, { maximumFractionDigits: 1 })} l/min</>
                    )}
                    {reading.note && <> · {reading.note}</>}
                  </small>
                </span>
                <IconButton label={t('wt.meter.delete')} variant="danger" icon={<TrashIcon />} onClick={() => remove(reading)} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
