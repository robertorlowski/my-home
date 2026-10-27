// Widok główny włącznika (/), układ z makiety „Instrument” (makiety/src/makieta.html, #s-switch-podglad):
// karta na przekaźnik (.card-relay: nazwa, przełącznik stanu ze sterownika, opis trybu, duże odliczanie do wyłączenia
// albo następny start, przyciski Włącz / Wyłącz / Harmonogram i „Czas włączenia” h/min; „Włącz” na ten czas,
// 0 h 0 min = bez limitu; PUT /switch/mode) oraz karta „Dziś” z włączeniami (GET /switch/activations).
// Dane odświeża WebSocket „update” (zmiana stanu zgłoszona przez sterownik) i odpytywanie co 5 s
// (tryb timer i harmonogram zmieniają się z czasem).
import { useEffect, useState } from 'react';
import { DeviceRequests } from '../../../core/api';
import { wsAddressServer } from '../../../core/http';
import { getSelectedDevice } from '../../../core/context/DeviceContext';
import { OfflineBanner } from '../../../core/components/OfflineBanner';
import { SwitchRequests } from '../api';
import { RelayMode, SwitchActivation, SwitchRelay } from '../types';
import {
  describeMode, formatCountdown, formatDuration, formatMoment, formatTime,
  relayLabel, secondsInDay, todayWarsaw, warsawDayBounds,
} from '../utils/format';
import { ActivationsTable } from '../components/ActivationsTable';
import { useLang } from '../../../core/i18n';
import './style.css';

const REFRESH_MS = 5_000;

// Karta jednego przekaźnika z przyciskami trybu.
const RelayCard: React.FC<{
  relay: SwitchRelay;
  now: number;
  defaultMinutes: number;
  busy: boolean;
  onMode: (mode: RelayMode, minutes?: number) => void;
}> = ({ relay, now, defaultMinutes, busy, onMode }) => {
  const { t } = useLang();
  // pola h / min startują z default_on_minutes (ustawienie sterownika) i podążają za jego zmianą w Ustawieniach
  const [hours, setHours] = useState(String(Math.floor(defaultMinutes / 60)));
  const [minutes, setMinutes] = useState(String(defaultMinutes % 60));
  useEffect(() => {
    setHours(String(Math.floor(defaultMinutes / 60)));
    setMinutes(String(defaultMinutes % 60));
  }, [defaultMinutes]);

  const label = relayLabel(relay);
  const mode = describeMode(relay);
  // „Włącz” na czas z pól pod przyciskami; 0 h 0 min = bez limitu
  const timerMinutes = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  const timeValid = timerMinutes >= 0 && timerMinutes <= 10080;
  const turnOn = () => (timerMinutes > 0 ? onMode('timer', timerMinutes) : onMode('on'));
  const title = relay.on ? t('sw.home.relayOnTitle') : t('sw.home.relayOffTitle');
  const manualOn = relay.mode === 'on' || relay.mode === 'timer';

  // odliczanie: do końca włączenia (timer albo okno harmonogramu); bez niego następny start z harmonogramu
  // desiredOn / until / nextStart liczy serwer (relayCommand w switch.service) z trybu i harmonogramu — tu tylko
  // prezentacja; relay.on to stan faktyczny zgłoszony przez sterownik (może różnić się do następnego zgłoszenia)
  const counting = relay.desiredOn && relay.until;
  const idleLabel = relay.mode === 'on'
    ? t('sw.home.onUnlimited')
    : relay.mode === 'pause'
      ? `${t('sw.home.pausedUntil', { until: formatMoment(relay.until) })}${relay.nextStart ? `: ${formatMoment(relay.nextStart)}` : ''}`
    : relay.nextStart
      ? `${t('sw.home.nextStart', { when: formatMoment(relay.nextStart) })}${relay.mode === 'off' ? ` ${t('sw.home.afterUnlock')}` : ''}`
      : relay.mode === 'off' ? t('sw.home.scheduleBlocked') : t('sw.home.noStarts');

  return (
    <section className={`card card-relay${relay.desiredOn ? ' is-on' : ''}${relay.mode === 'off' ? ' is-blocked' : ''}`}>
      <header className="card-head">
        <h2>{label}</h2>
        <span className={`switch${relay.on ? ' is-on' : ''}${relay.online ? '' : ' is-disabled'}`} role="switch"
          aria-checked={relay.on} aria-label={label} title={title} />
      </header>
      <div className={`relay-state${mode.danger ? ' danger-text' : ''}`}><i className="dot" />{mode.text}</div>
      {!relay.online && (
        <OfflineBanner since={relay.lastSeenAt ?? undefined} now={now} detail={relay.lastSeenAt ? undefined : t('sw.home.notReported')} />
      )}
      {counting ? (
        <div className="countdown" title={t('sw.home.offAt', { time: formatTime(relay.until) })}>
          <span className="countdown-num">{formatCountdown(relay.until!, now)}</span>
          <span className="countdown-label">{t('sw.home.untilOff')}</span>
        </div>
      ) : (
        <div className="countdown is-idle">
          <span className="countdown-num">{relay.mode === 'on' ? '∞' : '—'}</span>
          <span className="countdown-label">{idleLabel}</span>
        </div>
      )}
      {relay.on !== relay.desiredOn && relay.online && <p className="help">{t('sw.waiting')}</p>}
      <div className="actions actions-3">
        <button type="button" className={`btn btn-primary${manualOn ? ' is-active' : ''}`} disabled={busy || !timeValid}
          onClick={turnOn}>{t('sw.simple.turnOn')}</button>
        <button type="button" className={`btn${relay.mode === 'off' ? ' is-active' : ''}`} disabled={busy}
          onClick={() => onMode('off')}>{t('sw.simple.turnOff')}</button>
        <button type="button" className={`btn btn-ghost${relay.mode === 'schedule' ? ' is-active' : ''}`} disabled={busy}
          onClick={() => onMode('schedule')}>{t('view.schedules')}</button>
      </div>
      <div className="form-row">
        <label htmlFor={`sw${relay.relay}-h`}>{t('sw.home.onTime')}</label>
        <div className="range-inputs">
          <input type="number" id={`sw${relay.relay}-h`} min={0} max={168} value={hours} aria-label={t('sw.home.hours')}
            onChange={(event) => setHours(event.currentTarget.value)} />
          <span className="unit-txt">h</span>
          <input type="number" id={`sw${relay.relay}-m`} min={0} max={59} value={minutes} aria-label={t('sw.home.minutes')}
            onChange={(event) => setMinutes(event.currentTarget.value)} />
          <span className="unit-txt">min</span>
        </div>
      </div>
      <p className={`help${timeValid ? '' : ' danger-text'}`}>
        {!timeValid ? t('sw.home.maxWeek') : t('sw.home.onTimeHelp')}
      </p>
    </section>
  );
};

export const SwitchHome: React.FC = () => {
  const { t } = useLang();
  const [relays, setRelays] = useState<SwitchRelay[] | null>(null);
  const [activations, setActivations] = useState<SwitchActivation[] | null>(null);
  const [defaultMinutes, setDefaultMinutes] = useState(30);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    SwitchRequests.getRelays().then((result) => result && setRelays(result));
    SwitchRequests.getActivations(todayWarsaw()).then((result) => result && setActivations(result));
  };

  useEffect(() => {
    load();
    DeviceRequests.getDeviceProperties().then((result) => {
      if (typeof result?.default_on_minutes === 'number') setDefaultMinutes(result.default_on_minutes);
    });
    const refresh = window.setInterval(load, REFRESH_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);

    // „update” wysyła serwer, gdy sterownik zgłosi zmianę stanu przekaźnika
    const device = getSelectedDevice();
    const wsUrl = new URL(wsAddressServer());
    if (device) wsUrl.searchParams.set('rootId', device.rootId);
    const ws = new WebSocket(wsUrl.toString());
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string };
        if (message.type === 'update') load();
      } catch { /* inne komunikaty */ }
    };
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
      ws.close();
    };
  }, []);

  const changeMode = async (relay: number, mode: RelayMode, minutes?: number) => {
    setBusy(relay);
    setError('');
    try {
      // odpowiedź to przekaźnik już z nowym trybem; podmiana w stanie bez czekania na odświeżenie (sterownik dostaje
      // polecenie po WebSocket „operation” w ciągu kilku sekund)
      const updated = await SwitchRequests.setMode(relay, mode, minutes);
      setRelays((current) => current?.map((item) => item.relay === relay ? updated : item) ?? null);
    } catch {
      setError(t('sw.home.modeFailed'));
    } finally {
      setBusy(null);
    }
  };

  const names = new Map((relays ?? []).map((relay) => [relay.relay, relayLabel(relay)]));
  const { start, end } = warsawDayBounds(todayWarsaw());
  // suma „Dziś” liczy tylko część włączenia w dobie warszawskiej (włączenie przez północ) i do teraz, gdy trwa
  const total = (activations ?? []).reduce((sum, activation) => sum + secondsInDay(activation, start, end, now), 0);
  // serwer zwraca od najstarszego; tabela pokazuje najnowsze na górze
  const sorted = [...(activations ?? [])].reverse();

  return (
    <div className="page page-device switch-page">
      {relays === null && <section className="card"><p className="help">{t('common.loading')}</p></section>}
      {relays?.length === 0 && <section className="card"><p className="help">{t('sw.noRelays')}</p></section>}
      {error && <section className="card card-danger"><p className="danger-text">{error}</p></section>}
      {relays && relays.length > 0 && (
        <div className="grid-2">
          {relays.map((relay) => (
            <RelayCard key={relay.relay} relay={relay} now={now} defaultMinutes={defaultMinutes}
              busy={busy === relay.relay} onMode={(mode, minutes) => changeMode(relay.relay, mode, minutes)} />
          ))}
        </div>
      )}

      <section className="card card-table">
        <header className="card-head">
          <h2>{t('wx.todayCap')}</h2>
          {sorted.length > 0 && <span className="card-hint">{t('sw.home.total', { time: formatDuration(total) })}</span>}
        </header>
        {activations === null && <p className="help">{t('common.loading')}</p>}
        {activations?.length === 0 && <p className="help">{t('sw.home.noneToday')}</p>}
        {sorted.length > 0 && (
          <ActivationsTable activations={sorted} names={names} showRelay={(relays?.length ?? 0) > 1} moment={formatMoment} />
        )}
      </section>
    </div>
  );
};
