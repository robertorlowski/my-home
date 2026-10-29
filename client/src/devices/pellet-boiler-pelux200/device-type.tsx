// Opis rodzaju „pellet-boiler-pelux200” (kocioł pelletowy Plum Pellux 200, regulator ecoMAX) dla
// rejestru core/device-types.tsx: ikona płomienia na kafelku, menu i widoki. Ścieżki spoza listy
// prowadzą na stronę główną.
import { DeviceType, DeviceTypeView } from '../../core/types';
import { AlarmIcon, ChartIcon, DataIcon, OperationsIcon, ScheduleIcon, SettingsIcon } from '../../core/components/icons';
import { OperationsPage } from '../../core/pages/Operations';
import { FLAME_PATH, FlameIcon } from './components/icons';
import { PelletBoilerHome } from './pages/Home';
import { PelletBoilerData } from './pages/Data';
import { PelletBoilerChart } from './pages/Chart';
import { PelletBoilerSchedules } from './pages/Schedules';
import { PelletBoilerSettings } from './pages/Settings';
import { PelletBoilerAlertsPage } from './components/Alerts';
import { BoilerConfigFields } from './components/BoilerConfigFields';
import { PelletBoilerSimpleTile } from './components/SimpleTile';

// Kocioł pelletowy: podgląd, dane z dnia, wykres temperatur, harmonogram (sezon, CWU od–do), alarmy, dziennik
// operacji (wspólna strona core/pages/Operations) i ustawienia.
export const pelletBoilerDeviceType: DeviceTypeView = {
	type: DeviceType.PELLET_BOILER_PELUX200,
	tileIcon: (
		<svg className="device-selection-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<path d={FLAME_PATH} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
		</svg>
	),
	label: 'Piec Pellux 200',
	firmwareUpdates: true,
	// okno „Dane sterownika”: powiązana pompa ciepła (bez niej kocioł tylko na pellecie)
	DefinitionFields: BoilerConfigFields,
	// kafelek prosty (duże przyciski na liście): włącz / wyłącz piec, CWU
	SimpleTile: PelletBoilerSimpleTile,
	views: [
		{ path: '/', label: 'Kocioł', icon: <FlameIcon />, element: <PelletBoilerHome /> },
		{ path: '/chart', label: 'Statystyki', icon: <ChartIcon />, element: <PelletBoilerChart /> },
		{ path: '/schedules', label: 'Harmonogram', icon: <ScheduleIcon />, element: <PelletBoilerSchedules /> },
		{ path: '/settings', label: 'Ustawienia', icon: <SettingsIcon />, element: <PelletBoilerSettings /> },
		{ path: '/alarms', label: 'Alarmy', icon: <AlarmIcon />, element: <PelletBoilerAlertsPage /> },
		{ path: '/data', label: 'Dane', icon: <DataIcon />, element: <PelletBoilerData /> },
		{ path: '/operations', label: 'Operacje', icon: <OperationsIcon />, element: <OperationsPage /> },
	],
};
