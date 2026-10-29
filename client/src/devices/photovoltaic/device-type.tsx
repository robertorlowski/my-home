// Opis rodzaju „photovoltaic” (instalacja PV z DTU Hoymiles, czytana przez sterownik co) dla
// rejestru core/device-types.tsx: ikona słońca na kafelku, menu i widoki.
import { DeviceType, DeviceTypeView } from '../../core/types';
import { ChartIcon, DataIcon, SettingsIcon } from '../../core/components/icons';
import { PhotovoltaicHome } from './pages/Home';
import { PhotovoltaicData } from './pages/Data';
import { PhotovoltaicChart } from './pages/Chart';
import { PhotovoltaicSettings } from './pages/Settings';

const SunShape = () => (
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
  </>
);

const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <SunShape />
  </svg>
);

// Fotowoltaika: podgląd, dane (całość albo panel), wykresy produkcji i ustawienia (podgląd).
export const photovoltaicDeviceType: DeviceTypeView = {
  type: DeviceType.PHOTOVOLTAIC,
  tileIcon: (
    <svg className="device-selection-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <SunShape />
    </svg>
  ),
  views: [
    { path: '/', label: 'Fotowoltaika', icon: <SunIcon />, element: <PhotovoltaicHome /> },
    { path: '/chart', label: 'Statystyki', icon: <ChartIcon />, element: <PhotovoltaicChart /> },
    { path: '/settings', label: 'Ustawienia', icon: <SettingsIcon />, element: <PhotovoltaicSettings /> },
    { path: '/data', label: 'Dane', icon: <DataIcon />, element: <PhotovoltaicData /> },
  ],
};
