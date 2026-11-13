// Karta „Sterownik” w Ustawieniach wszystkich rodzajów (makieta #s-hp-ustawienia, 2026-10-17): nagłówek z ikoną
// edycji (ControllerCardTitle → popup DeviceEditModal), lista .kv: Nazwa, SN, Root ID (skrócony, „kopiuj”), Adres IP
// (DeviceAddressRow), Firmware z chipem stanu i Ostatnie zgłoszenie (FirmwareRows) oraz .actions z „Aktualizuj firmware”
// (FirmwareActions). Strona Ustawienia wstawia <ControllerCard device={device} onEdit={…} /> w .stack / .grid-settings
// zamiast składać wiersze samodzielnie. Dane IP i firmware z GET /api/devices (useCurrentDevice). Wiersz „Poczta”
// (klucz płytki przekaźnika poczty) był tu od 2026-10-17 do 2026-11-13, do usunięcia przekaźnika.
import { ReactNode, useState } from 'react';
import { canEditDevice, Device } from '../types';
import { useAuth } from '../context/AuthContext';
import { ControllerCardTitle } from './ControllerCardTitle';
import { DeviceAddressRow, useCurrentDevice } from './DeviceAddress';
import { FirmwareActions, FirmwareRows, useFirmwareStatus } from './FirmwareStatus';
import { useLang } from '../i18n';
import './firmwareStatus.css';

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export const ControllerCard: React.FC<{
  device: Device | null;
  onEdit: () => void;
  /** dodatkowe wiersze <div><dt/><dd/></div> rodzaju (np. liczba przekaźników) przed adresem IP */
  children?: ReactNode;
}> = ({ device, onEdit, children }) => {
  const { user } = useAuth();
  const { t } = useLang();
  const isDemo = !!user?.isDemo;
  const { current } = useCurrentDevice(device);
  const firmware = useFirmwareStatus(device);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!device) return;
    navigator.clipboard?.writeText(device.rootId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  };

  return (
    <section className="card">
      <ControllerCardTitle disabled={!canEditDevice(device)} onEdit={onEdit} />
      <dl className="kv">
        <div><dt>{t('deviceEdit.name')}</dt><dd>{device?.name?.trim() || '—'}</dd></div>
        {!isDemo && <div><dt>SN</dt><dd><code>{device?.deviceId ?? '---'}</code></dd></div>}
        {!isDemo && <div>
          <dt>Root ID</dt>
          <dd>
            <code title={device?.rootId}>{device ? shortId(device.rootId) : '---'}</code>
            {device && <button type="button" className="link-btn" onClick={copy}>{copied ? t('common.copied') : t('common.copy')}</button>}
          </dd>
        </div>}
        {children}
        <DeviceAddressRow current={current} />
        <FirmwareRows state={firmware} />
      </dl>
      <FirmwareActions state={firmware} />
    </section>
  );
};
