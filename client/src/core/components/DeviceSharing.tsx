// Karta „Udostępnianie” w Ustawieniach sterownika (konta użytkowników, 2026-10-11) w wyglądzie „Instrument”
// (makieta #s-hp-ustawienia: .card z .card-head i przyciskiem „Udostępnij”, lista .people z awatarem, e-mailem
// i zakładkami, ikony zmiany zakładek i cofnięcia dostępu). Okno „Udostępnij sterownik” (.modal: e-mail i zakładki
// rodzaju sterownika jako .checks) służy też do zmiany zakładek. Rodzaje z kafelkiem prostym (SimpleTile w rejestrze,
// np. włącznik) mają wybór „Pełna aplikacja” / „Panel prosty” (tabs: ['simple'] — osoba widzi tylko kafelek z dużymi
// przyciskami, bez widoków sterownika). Tylko właściciel i użytkownik systemowy (osoba z udostępnieniem karty nie
// widzi; serwer też odmawia). Do wstawienia w .stack / .grid-settings.
import { FormEvent, useEffect, useState } from 'react';
import { ShareRequests } from '../api';
import { getDeviceTypeView } from '../device-types';
import { ApiError } from '../http';
import { canEditDevice, Device, DeviceShare } from '../types';
import { IconButton } from './IconButton';
import { EditIcon, TrashIcon } from './icons';
import { useLang } from '../i18n';
import { viewLabel } from './Header';
import './account.css';

const formatDate = (iso: string, locale: string) => new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
// udostępnienie „Panel prosty” (serwer: access.service SIMPLE_TAB)
const SIMPLE_TAB = 'simple';
const isSimpleShare = (tabs: string[]) => tabs.includes(SIMPLE_TAB);

// „AK” z imienia i nazwiska albo z e-maila do kółka przy osobie
function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase();
}

function ShareDialog({ device, share, onClose, onSaved }: {
  device: Device; share: DeviceShare | null; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useLang();
  const typeView = getDeviceTypeView(device.deviceType);
  const views = typeView.views;
  const simpleAvailable = !!typeView.SimpleTile;
  const [email, setEmail] = useState(share?.email ?? '');
  // nowe udostępnienie: domyślnie zakładki tylko do oglądania (podgląd, dane, wykres), bez ustawień i harmonogramu
  const [tabs, setTabs] = useState<string[]>(share && !isSimpleShare(share.tabs) ? share.tabs : views.filter((view) => ['/', '/data', '/chart'].includes(view.path)).map((view) => view.path));
  // „Pełna aplikacja” (zakładki) albo „Panel prosty” (sam kafelek z dużymi przyciskami)
  const [simple, setSimple] = useState(!!share && isSimpleShare(share.tabs));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (path: string) => setTabs((current) => (current.includes(path) ? current.filter((tab) => tab !== path) : [...current, path]));
  const chosen = simple ? [SIMPLE_TAB] : tabs;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (share) await ShareRequests.update(device.rootId, share.id, chosen);
      else await ShareRequests.add(device.rootId, email, chosen);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('share.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-layer">
      <div className="scrim" onClick={onClose} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onSubmit={save}>
        <header className="modal-head"><h2 id="share-title">{share ? t('share.tabs') : t('share.shareDevice')}</h2></header>
        <div className="modal-body">
          <p>{device.name || device.deviceId}</p>
          <label className="field">
            <span>{t('share.personEmail')}</span>
            <input type="email" required disabled={!!share} autoFocus={!share} placeholder={t('login.emailPlaceholder')} value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          {simpleAvailable && (
            <fieldset className="checks">
              <legend>{t('share.whatSees')}</legend>
              <label className="check">
                <input type="radio" name="share-kind" checked={!simple} onChange={() => setSimple(false)} />
                <span>{t('share.fullApp')}</span><small>{t('share.fullAppHint')}</small>
              </label>
              <label className="check">
                <input type="radio" name="share-kind" checked={simple} onChange={() => setSimple(true)} />
                <span>{t('view.simple')}</span><small>{t('share.simpleHint')}</small>
              </label>
            </fieldset>
          )}
          {!simple && (
            <fieldset className="checks">
              <legend>{t('share.tabsSees')}</legend>
              {views.map((view) => (
                <label key={view.path} className="check">
                  <input type="checkbox" checked={tabs.includes(view.path)} onChange={() => toggle(view.path)} />
                  <span>{view.path === '/' ? t('view.overview') : viewLabel(view.path, device.deviceType, t)}</span>
                </label>
              ))}
            </fieldset>
          )}
          {!share && <p className="help">{t('share.inviteHint')}</p>}
          {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || chosen.length === 0}>{share ? t('common.save') : t('share.sendInvite')}</button>
        </footer>
      </form>
    </div>
  );
}

export function DeviceSharing({ device }: { device: Device }) {
  const { t, locale } = useLang();
  const [shares, setShares] = useState<DeviceShare[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<DeviceShare | null | undefined>(undefined);
  const views = getDeviceTypeView(device.deviceType);
  // zakładka, której rodzaj już nie ma (zmiana w rejestrze po udostępnieniu), pokazuje się jako surowa ścieżka
  const tabLabel = (path: string) => (path === '/' ? t('view.overview') : views.views.find((view) => view.path === path) ? viewLabel(path, device.deviceType, t) : path);
  const tabsText = (share: DeviceShare) => isSimpleShare(share.tabs) ? t('share.simpleText')
    : share.tabs.length === views.views.length ? t('share.allTabs') : share.tabs.map(tabLabel).join(', ');

  const load = () => ShareRequests.list(device.rootId).then(setShares).catch((caught) => setError(caught instanceof ApiError ? caught.message : t('share.listFailed')));
  // udostępnione i demo: bez listy (serwer odpowiada 403)
  useEffect(() => { if (canEditDevice(device)) void load(); }, [device.rootId]);
  if (!canEditDevice(device)) return null;

  const remove = async (share: DeviceShare) => {
    if (!window.confirm(t('share.revokeConfirm', { who: share.name ?? share.email }))) return;
    try {
      await ShareRequests.remove(device.rootId, share.id);
      void load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('share.revokeFailed'));
    }
  };

  return (
    <section className="card">
      <header className="card-head controller-card-head">
        <h2>{t('share.title')}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>{t('share.share')}</button>
      </header>
      {shares && shares.length > 0 && (
        <ul className="people">
          {shares.map((share) => (
            <li key={share.id}>
              <span className="avatar-sm" aria-hidden="true">{initials(share.name, share.email)}</span>
              <span className="person">
                <strong>{share.registered ? share.name || share.email : share.email}</strong>
                {share.registered && share.name && <small>{share.email}</small>}
                <small className={share.registered ? '' : 'share-pending'}>
                  {share.registered ? tabsText(share) : `${t('share.inviteSent', { date: formatDate(share.createdAt, locale) })} · ${tabsText(share)}`}
                </small>
              </span>
              <IconButton label={`${t('share.changeTabs')}: ${share.email}`} icon={<EditIcon />} onClick={() => setEditing(share)} />
              <IconButton variant="danger" label={`${t('share.revoke')}: ${share.email}`} icon={<TrashIcon />} onClick={() => void remove(share)} />
            </li>
          ))}
        </ul>
      )}
      {shares?.length === 0 && <p className="help">{t('share.nobody')}</p>}
      {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
      {editing !== undefined && (
        <ShareDialog device={device} share={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void load(); }} />
      )}
    </section>
  );
}
