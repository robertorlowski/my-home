// Karta „Powiadomienia” na stronie konta (/account, 2026-10-21): powiadomienia Web Push na telefon i do przeglądarki.
// Góra: „Włącz / Wyłącz na tym urządzeniu” (zgoda przeglądarki → subskrypcja PushManager → POST /push/subscriptions,
// core/push.ts) i lista przeglądarek konta z usuwaniem oraz „Wyślij próbne”. Dół: reguły — dla każdego sterownika
// konta lista zdarzeń z katalogu serwera (GET /push/settings: events według rodzaju; pierwsze zaznaczenie sterownika
// wstawia zdarzenia domyślne) i cisza nocna (pilne zdarzenia idą mimo niej); „Zapisz” → PUT /push/rules.
// Stany bez przycisku: brak wsparcia w przeglądarce, iPhone bez dodania do ekranu początkowego, zgoda cofnięta
// w przeglądarce, serwer bez kluczy VAPID.
import { useEffect, useMemo, useState } from 'react';
import { PushRequests } from '../api';
import { getDeviceTypeView } from '../device-types';
import { ApiError } from '../http';
import { browserLabel, currentSubscription, permissionState, PushDenied, pushSupport, subscribe, unsubscribe } from '../push';
import { t as tr, useLang } from '../i18n';
import { DeviceType, PushRule, PushSettings } from '../types';
import Notification, { useSaveNotice } from './Notification';

const message = (error: unknown) => (error instanceof ApiError ? error.message : error instanceof Error ? error.message : tr('common.somethingWrong'));
const when = (iso: string, locale: string) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

export function PushSettingsCard() {
  const { t, tn, locale } = useLang();
  const [settings, setSettings] = useState<PushSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState(permissionState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rules, setRules] = useState<PushRule[]>([]);
  const [quietFrom, setQuietFrom] = useState('');
  const [quietTo, setQuietTo] = useState('');
  const { notice, showNotice, run, busy: saving } = useSaveNotice();
  const support = useMemo(pushSupport, []);

  const load = async () => {
    try {
      const loaded = await PushRequests.settings();
      setSettings(loaded);
      setRules(loaded.rules);
      setQuietFrom(loaded.quietFrom ?? '');
      setQuietTo(loaded.quietTo ?? '');
    } catch (caught) {
      setLoadError(message(caught));
    }
  };

  useEffect(() => {
    void load();
    void currentSubscription().then((subscription) => setEndpoint(subscription?.endpoint ?? null));
  }, []);

  // „to urządzenie” = subskrypcja z listy konta o tym samym endpoincie, jaki ma PushManager tej przeglądarki;
  // brak dopasowania (np. subskrypcja usunięta z innego urządzenia) pokazuje przycisk „Włącz” mimo zgody przeglądarki
  const thisDevice = settings?.subscriptions.find((subscription) => subscription.endpoint === endpoint) ?? null;

  const enable = async () => {
    if (!settings?.publicKey) return;
    setBusy(true);
    setError('');
    try {
      const subscription = await subscribe(settings.publicKey);
      setPermission(permissionState());
      await PushRequests.subscribe(subscription, browserLabel());
      setEndpoint(subscription.endpoint ?? null);
      // pierwsze włączenie: zdarzenia domyślne dla każdego sterownika, żeby nie zaczynać od pustych reguł
      if (!rules.length) setRules(settings.devices.map((device) => ({ rootId: device.rootId, events: defaults(settings, device.deviceType) })));
      await load();
    } catch (caught) {
      setPermission(permissionState());
      setError(caught instanceof PushDenied ? t('push.denied') : message(caught));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError('');
    try {
      // najpierw serwer (żeby nie został martwy wpis), potem PushManager przeglądarki
      if (thisDevice) await PushRequests.unsubscribe(thisDevice.id);
      await unsubscribe();
      setEndpoint(null);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError('');
    try {
      await PushRequests.unsubscribe(id);
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError('');
    try {
      const { sent } = await PushRequests.test();
      showNotice(sent === 1 ? t('push.testSent') : t('push.testSentMany', { n: sent }));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  // reguły w stanie: jeden wpis na sterownik; sterownik bez zaznaczeń nie ma wpisu (tak samo zapisuje serwer)
  const eventsOf = (rootId: string) => rules.find((rule) => rule.rootId === rootId)?.events ?? [];
  const toggle = (rootId: string, key: string) => setRules((current) => {
    const events = eventsOf(rootId);
    const next = events.includes(key) ? events.filter((event) => event !== key) : [...events, key];
    const rest = current.filter((rule) => rule.rootId !== rootId);
    return next.length ? [...rest, { rootId, events: next }] : rest;
  });
  const setAll = (rootId: string, events: string[]) => setRules((current) => {
    const rest = current.filter((rule) => rule.rootId !== rootId);
    return events.length ? [...rest, { rootId, events }] : rest;
  });

  const save = () => run(async () => {
    setError('');
    try {
      const saved = await PushRequests.saveRules(rules, quietFrom || null, quietTo || null);
      setRules(saved.rules);
      showNotice(t('common.saved'));
    } catch (caught) {
      setError(message(caught));
    }
  });

  // powód braku przycisku „Włącz” w kolejności od najpoważniejszego (serwer → przeglądarka → zgoda)
  const status = (() => {
    if (!settings) return null;
    if (!settings.configured) return t('push.notConfigured');
    if (support === 'insecure') return t('push.insecure');
    if (support === 'needs-home-screen') return t('push.needsHomeScreen');
    if (support === 'unsupported') return t('push.unsupported');
    if (permission === 'denied') return t('push.blocked');
    return null;
  })();
  const canToggle = settings?.configured && support === 'ok' && permission !== 'denied';

  return (
    <section className="card push-card">
      <header className="card-head">
        <h2>{t('push.title')}</h2>
        {settings && settings.subscriptions.length > 0 && <span className="card-hint">{tn('push.devices', settings.subscriptions.length)}</span>}
      </header>
      <p className="help">{t('push.intro')}</p>
      {loadError && <div className="alert alert-err" role="alert"><div><strong>{loadError}</strong></div></div>}
      {status && <p className="help push-status">{status}</p>}

      {settings && (
        <>
          <div className="actions actions-gap push-actions">
            {settings.subscriptions.length > 0 && <button type="button" className="btn btn-ghost" onClick={sendTest} disabled={busy}>{t('push.sendTest')}</button>}
            {canToggle && (thisDevice
              ? <button type="button" className="btn" onClick={disable} disabled={busy}>{t('push.disableHere')}</button>
              : <button type="button" className="btn btn-primary" onClick={enable} disabled={busy}>{t('push.enableHere')}</button>)}
          </div>
          {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}

          {settings.subscriptions.length > 0 && (
            <ul className="toggle-list push-subscriptions">
              {settings.subscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <div>
                    <div className="push-sub-label">{subscription.label || t('push.browser')}{subscription.id === thisDevice?.id && <span className="chip chip-ok">{t('push.thisDevice')}</span>}</div>
                    <small>{t('push.enabledOn', { date: when(subscription.createdAt, locale) })}{subscription.lastUsedAt ? ` · ${t('push.lastOn', { date: when(subscription.lastUsedAt, locale) })}` : ''}</small>
                  </div>
                  <button type="button" className="link-btn" onClick={() => void remove(subscription.id)}>{t('common.remove')}</button>
                </li>
              ))}
            </ul>
          )}

          {settings.devices.length > 0 ? (
            <div className="push-rules">
              {settings.devices.map((device) => {
                const events = settings.events[device.deviceType] ?? [];
                const chosen = eventsOf(device.rootId);
                return (
                  <fieldset key={device.rootId} className="checks push-device">
                    <legend>
                      {device.name}{typeLabel(device.deviceType, t) !== device.name && <span className="push-type">{typeLabel(device.deviceType, t)}</span>}
                      <span className="push-legend-links">
                        <button type="button" className="link-btn" onClick={() => setAll(device.rootId, defaults(settings, device.deviceType))}>{t('push.defaults')}</button>
                        {chosen.length > 0 && <button type="button" className="link-btn" onClick={() => setAll(device.rootId, [])}>{t('push.none')}</button>}
                      </span>
                    </legend>
                    {events.map((event) => (
                      <label key={event.key} className="check">
                        <input type="checkbox" checked={chosen.includes(event.key)} onChange={() => toggle(device.rootId, event.key)} />
                        <span>{eventLabel(device.deviceType, event.key, event.label, t)}</span>
                        {event.urgent && <small>{t('push.alsoQuiet')}</small>}
                      </label>
                    ))}
                  </fieldset>
                );
              })}

              <div className="push-quiet">
                <div className="push-quiet-head">{t('push.quiet')}</div>
                <div className="push-quiet-fields">
                  <label className="field"><span>{t('common.from')}</span><input type="time" value={quietFrom} onChange={(event) => setQuietFrom(event.target.value)} /></label>
                  <label className="field"><span>{t('common.to')}</span><input type="time" value={quietTo} onChange={(event) => setQuietTo(event.target.value)} /></label>
                  {(quietFrom || quietTo) && <button type="button" className="link-btn" onClick={() => { setQuietFrom(''); setQuietTo(''); }}>{t('push.quietOff')}</button>}
                </div>
                <p className="help">{t('push.quietHint')}</p>
              </div>

              <div className="actions">
                <Notification message={notice} />
                <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{t('common.save')}</button>
              </div>
            </div>
          ) : (
            <p className="help">{t('push.noDevices')}</p>
          )}
        </>
      )}
    </section>
  );
}

// rodzaj pod nazwą sterownika (pomijany, gdy nazwa to to samo słowo): słownik type.<rodzaj> (core/i18n), bez klucza etykieta z rejestru
const typeLabel = (deviceType: DeviceType, t: (key: string) => string) => {
  const text = t(`type.${deviceType}`);
  return text !== `type.${deviceType}` ? text : getDeviceTypeView(deviceType).label ?? deviceType;
};
// nazwa zdarzenia: słownik push.event.<rodzaj>.<klucz>, bez klucza polska etykieta z katalogu serwera
const eventLabel = (deviceType: DeviceType, key: string, label: string, t: (key: string) => string) => {
  const text = t(`push.event.${deviceType}.${key}`);
  return text !== `push.event.${deviceType}.${key}` ? text : label;
};

const defaults = (settings: PushSettings, deviceType: PushSettings['devices'][number]['deviceType']) =>
  (settings.events[deviceType] ?? []).filter((event) => event.default).map((event) => event.key);
