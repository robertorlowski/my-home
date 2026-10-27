// Strona /firmware/:deviceType: firmware rodzaju sterownika (trybik na kafelku sterownika na liście /devices),
// wygląd „Instrument” z makiet/ (ekrany #s-firmware-*, 2026-10-17). Karty: „Aktualna wersja” (oferowana wersja, opis,
// data, rozmiar, SHA-256, przełącznik „Aktualizacje”, plus otwiera kartę „Dodaj wersję”), „Sterowniki tego rodzaju”
// (wersja z ostatniego zgłoszenia każdego sterownika, GET /api/devices), „Poprzednie wersje” (przywrócenie, usunięcie)
// i „Dodaj wersję” (plik .bin, wersja, opis; PUT /api/firmware/:rodzaj/:wersja). Oferta i pliki dotyczą wszystkich
// sterowników danego rodzaju, ale sterownik pobiera plik dopiero po „Aktualizuj” w swoich Ustawieniach
// (components/FirmwareStatus). Poza kontekstem urządzenia (bez rootId).
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DeviceRequests, FirmwareRequests } from '../../api';
import { InfoTip } from '../../components/InfoTip';
import { Device, DeviceType, FirmwareImage, FirmwareSummary } from '../../types';
import { getDeviceTypeView } from '../../device-types';
import Notification, { useSaveNotice } from '../../components/Notification';
import { IconButton } from '../../components/IconButton';
import { PlusIcon, TrashIcon } from '../../components/icons';
import { t as tr, useLang } from '../../i18n';
import { dateLabel, dateTimeLabel } from '../../i18n/format';
import './style.css';

// partycja aplikacji OTA ESP32; serwer odrzuca większy plik (core/services/firmware.service.ts)
const MAX_FIRMWARE_BYTES = 1310720;
const MAX_DESCRIPTION_LENGTH = 500;

const formatBytes = (bytes: number, locale: string) => `${bytes.toLocaleString(locale)} B`;
const formatDate = (value?: string) => dateLabel(value);
const formatDateTime = (value?: string) => dateTimeLabel(value);
const shortSha = (sha: string) => `${sha.slice(0, 4)}…${sha.slice(-4)}`;

// Przełącznik jak w makiecie (.switch): span z rolą switch, Enter/spacja przełączają.
const Switch: React.FC<{ on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }> = ({ on, label, disabled, onChange }) => (
  <span className={`switch${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`} role="switch" aria-checked={on} aria-label={label}
    aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0} title={label}
    onClick={() => !disabled && onChange(!on)}
    onKeyDown={(event) => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onChange(!on); } }} />
);

// Stan sterownika względem oferowanej wersji (chip na liście „Sterowniki tego rodzaju”).
function deviceChip(device: Device, offered: string | null, enabled: boolean): { className: string; text: string } {
  if (device.firmwareUpdate) return { className: 'chip-warn', text: tr('fw.chipRequested') };
  if (!device.firmwareVersion) return { className: 'chip-off', text: tr('fw.chipNoVersion') };
  if (offered && enabled && device.firmwareVersion !== offered) return { className: 'chip-warn', text: tr('fw.chipToUpdate') };
  return { className: 'chip-ok', text: tr('fw.chipCurrent') };
}

export const Firmware: React.FC = () => {
  const { deviceType } = useParams();
  const type = Object.values(DeviceType).find((value) => value === deviceType);
  const view = type ? getDeviceTypeView(type) : undefined;
  const supported = view?.firmwareUpdates === true;
  const { t, locale } = useLang();
  const bytes = (value: number) => formatBytes(value, locale);

  const [summary, setSummary] = useState<FirmwareSummary | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [version, setVersion] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [sha, setSha] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const addCard = useRef<HTMLFormElement>(null);
  // przyciski zmian nieaktywne, dopóki widać komunikat o poprzedniej zmianie (useSaveNotice)
  const { notice, showNotice, busy: noticeBusy } = useSaveNotice(4000);
  const say = (message: string) => showNotice(message);

  const closeAdd = () => {
    setAdding(false);
    setFile(null);
    setSha('');
    setVersion('');
    setDescription('');
    setError('');
    setFileKey((key) => key + 1);
  };

  useEffect(() => {
    if (!adding) return;
    addCard.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAdd();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [adding]);

  useEffect(() => {
    if (!type || !supported) return;
    FirmwareRequests.get(type).then((result) => {
      if (result) setSummary(result);
      else setError(t('fw.loadFailed'));
    });
    DeviceRequests.getDevices().then((list) => setDevices((list ?? []).filter((device) => device.deviceType === type)));
  }, [type, supported]);

  if (!type || !supported) {
    return (
      <div className="page page-narrow firmware-page">
        <div className="empty">
          <h2>Firmware</h2>
          <p>{t('fw.notSupported')}</p>
          <Link className="link" to="/devices">{t('nav.deviceList')}</Link>
        </div>
      </div>
    );
  }

  // w bazie są najwyżej dwa pliki rodzaju: oferowany (active) i poprzedni (firmware.service.ts kasuje starsze)
  const active = summary?.images.find((image) => image.active);
  const previous = summary?.images.filter((image) => !image.active) ?? [];
  const enabled = summary?.enabled ?? false;

  // Suma SHA-256 policzona w przeglądarce jest tylko podglądem; wiążąca jest ta z serwera.
  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.currentTarget.files?.[0] ?? null;
    setFile(chosen);
    setSha('');
    setError('');
    if (!chosen) return;
    if (chosen.size > MAX_FIRMWARE_BYTES) {
      setError(t('fw.tooBig', { size: bytes(chosen.size), limit: bytes(MAX_FIRMWARE_BYTES) }));
      return;
    }
    // wersja z nazwy pliku (water-pressure-tank-1.0.1.bin), gdy pole jest puste
    const fromName = chosen.name.match(/(\d+(?:\.\d+)+)/)?.[1];
    if (fromName && !version.trim()) setVersion(fromName);
    try {
      const digest = await crypto.subtle.digest('SHA-256', await chosen.arrayBuffer());
      setSha(Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    } catch {
      // brak crypto.subtle (np. http w sieci lokalnej): sumę policzy serwer
    }
  };

  // każda zmiana (wgranie, przełącznik, przywrócenie, usunięcie) zwraca nowe podsumowanie rodzaju — jedno miejsce
  // na podmianę stanu i komunikat
  const run = async (action: () => Promise<FirmwareSummary>, done?: string) => {
    setError('');
    try {
      setSummary(await action());
      if (done) say(done);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.operationFailed'));
      return false;
    }
  };

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !version.trim()) return;
    setBusy(true);
    const ok = await run(
      () => FirmwareRequests.upload(type, version.trim(), file, description.trim()),
      t('fw.uploaded'),
    );
    setBusy(false);
    if (ok) closeAdd();
  };

  const remove = (image: FirmwareImage) => {
    if (!window.confirm(t('fw.removeConfirm', { version: image.version }))) return;
    run(() => FirmwareRequests.remove(type, image.version), t('fw.removed', { version: image.version }));
  };

  return (
    <div className="page page-narrow firmware-page">
      <Notification message={notice} />
      <p className="help firmware-lead">{t(`type.${type}`)} · {t('fw.lead')}</p>

      <section className="card">
        <header className="card-head">
          <h2>{t('fw.currentVersion')}</h2>
          <IconButton label={t('fw.addVersion')} icon={<PlusIcon />} active={adding} onClick={() => (adding ? closeAdd() : setAdding(true))} />
        </header>
        {active ? (
          <>
            <div className="fw-current">
              <span className="fw-ver">{active.version}</span>
              <div className="fw-meta">
                <strong>{enabled ? t('fw.offered') : t('fw.updatesOff')}</strong>
                <small>{t('fw.added', { date: formatDate(active.createdAt) })} · {bytes(active.size)} · sha256 <span title={active.sha256}>{shortSha(active.sha256)}</span></small>
              </div>
              <Switch on={enabled} label={enabled ? t('fw.updatesEnabled') : t('fw.updatesDisabled')} disabled={noticeBusy}
                onChange={(on) => run(() => FirmwareRequests.update(type, { enabled: on }))} />
            </div>
            {active.description && <p className="fw-desc">{active.description}</p>}
            <p className="help">
              {enabled ? t('fw.enabledHint') : t('fw.disabledHint')}
            </p>
          </>
        ) : (
          <p className="help">{summary ? t('fw.noFile') : t('common.loading')}</p>
        )}
        {error && !adding && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
      </section>

      {adding && (
        <form ref={addCard} className="card" onSubmit={upload}>
          <header className="card-head"><h2>{t('fw.addVersion')}</h2></header>
          <label className="field">
            <span>{t('fw.file')}</span>
            <input key={fileKey} type="file" accept=".bin" onChange={chooseFile} />
          </label>
          <label className="field">
            <span>{t('fw.version')}<InfoTip>{t('fw.versionTipBefore')} <code>FW_VERSION</code> {t('fw.versionTipAfter')}</InfoTip></span>
            <input type="text" value={version} placeholder={t('fw.versionPlaceholder')} maxLength={32} autoComplete="off"
              onChange={(event) => setVersion(event.currentTarget.value)} />
          </label>
          <label className="field">
            <span>{t('fw.description')}</span>
            <textarea value={description} rows={3} maxLength={MAX_DESCRIPTION_LENGTH} placeholder={t('fw.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.currentTarget.value)} />
          </label>
          {file && (
            <p className="help">{file.name} · {bytes(file.size)}{sha && <> · SHA-256 <code>{shortSha(sha)}</code></>}</p>
          )}
          <p className="help">{t('fw.serverChecks', { limit: bytes(MAX_FIRMWARE_BYTES) })}</p>
          {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
          <div className="actions firmware-actions">
            <button type="button" className="btn" onClick={closeAdd}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || noticeBusy || !file || !version.trim() || file.size > MAX_FIRMWARE_BYTES}>
              {busy ? t('fw.uploading') : t('fw.upload')}
            </button>
          </div>
        </form>
      )}

      {devices.length > 0 && (
        <section className="card">
          <header className="card-head"><h2>{t('fw.devicesOfType')}</h2><span className="card-hint">{t('fw.devicesHint')}</span></header>
          <ul className="people">
            {devices.map((device) => {
              const chip = deviceChip(device, summary?.version ?? null, enabled);
              return (
                <li key={device.rootId}>
                  <span className="person">
                    <strong>{device.name?.trim() || device.deviceId}</strong>
                    <small>{device.firmwareVersion ?? t('fw.olderNoVersion')}{device.firmwareSeenAt ? ` · ${t('fw.reportedAt', { time: formatDateTime(device.firmwareSeenAt) })}` : ''}</small>
                  </span>
                  <span className={`chip ${chip.className}`}>{chip.text}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card">
        <header className="card-head"><h2>{t('fw.previousVersions')}</h2><span className="card-hint">{t('fw.previousHint')}</span></header>
        {previous.length === 0 && <p className="help">{t('fw.noPrevious')}</p>}
        {previous.length > 0 && (
          <ul className="people">
            {previous.map((image) => (
              <li key={image.version}>
                <span className="fw-ver sm">{image.version}</span>
                <span className="person">
                  <strong>{image.description || t('fw.noDescription')}</strong>
                  <small>{t('fw.added', { date: formatDate(image.createdAt) })} · {bytes(image.size)} · sha256 <span title={image.sha256}>{shortSha(image.sha256)}</span></small>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={noticeBusy}
                  onClick={() => run(() => FirmwareRequests.update(type, { version: image.version }), t('fw.offeredNow', { version: image.version }))}>{t('fw.restore')}</button>
                <IconButton variant="danger" label={t('fw.removeVersion', { version: image.version })} icon={<TrashIcon />} disabled={noticeBusy} onClick={() => remove(image)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
