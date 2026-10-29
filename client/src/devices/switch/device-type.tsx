// Opis rodzaju „switch” (włącznik: ESP32 z przekaźnikami) dla rejestru core/device-types.tsx:
// ikona włącznika na kafelku, menu i widoki. Ścieżki spoza listy (np. /chart) prowadzą na stronę główną.
import { DeviceType, DeviceTypeView } from '../../core/types';
import { DataIcon, ScheduleIcon, OperationsIcon, SettingsIcon } from '../../core/components/icons';
import { OperationsPage } from '../../core/pages/Operations';
import { SwitchHome } from './pages/Home';
import { SwitchData } from './pages/Data';
import { SwitchSchedules } from './pages/Schedules';
import { SwitchSettings } from './pages/Settings';
import { SwitchSimpleTile } from './components/SimpleTile';

// przełącznik suwakowy: obudowa i suwak. fill="none" na obrysach, bo menu (style.css,
// header nav a svg) ustawia fill: white całej ikonie.
const SwitchIcon = ({ className }: { className?: string }) => (
	<svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<rect x="3" y="7" width="18" height="10" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
		<circle cx="16" cy="12" r="3" fill="currentColor" />
	</svg>
);

// Włącznik: przekaźniki (stan, tryb, sterowanie), włączenia w dniu, harmonogram i ustawienia; kafelek prosty
// (duże przyciski na liście) dla osoby, która ma tylko włączać i wyłączać bojler.
export const switchDeviceType: DeviceTypeView = {
	type: DeviceType.SWITCH,
	tileIcon: <SwitchIcon className="device-selection-icon" />,
	label: 'Włącznik',
	firmwareUpdates: true,
	SimpleTile: SwitchSimpleTile,
	views: [
		{ path: '/', label: 'Włącznik', icon: <SwitchIcon />, element: <SwitchHome /> },
		{ path: '/schedules', label: 'Harmonogram', icon: <ScheduleIcon />, element: <SwitchSchedules /> },
		{ path: '/settings', label: 'Ustawienia', icon: <SettingsIcon />, element: <SwitchSettings /> },
		{ path: '/data', label: 'Dane', icon: <DataIcon />, element: <SwitchData /> },
		{ path: '/operations', label: 'Operacje', icon: <OperationsIcon />, element: <OperationsPage /> },
	],
};
