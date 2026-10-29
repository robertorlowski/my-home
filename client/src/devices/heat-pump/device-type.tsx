// Opis rodzaju „heat_pump” dla rejestru core/device-types.tsx: ikona kafelka, menu i trasy
// widoków pompy ciepła. Kolejność w views to kolejność pozycji w menu.
import { DeviceType, DeviceTypeView } from '../../core/types';
import { ChartIcon, DataIcon, ScheduleIcon, OperationsIcon, SettingsIcon } from '../../core/components/icons';
import { OperationsPage } from '../../core/pages/Operations';
import HP from './pages/Home';
import { HeatPumpTable } from './pages/Data';
import { HeatPumpChart } from './pages/Charts';
import { Settings } from './pages/Settings';
import { Schedules } from './pages/Schedules';
import { PumpConfigFields } from './components/PumpConfigFields';

const HeatPumpIcon = () => (
	<svg x="0px" y="0px" width="25" height="25" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor">
		<path d="M11.0007 3C11.0007 3 9.86264 7.5 11.9313 12C14 16.5 13.5 21 13.5 21M18.9313 21C18.9313 21 19.6008 16.5 17.5007 13C15.4007 9.5 16.0007 6 16.0007 6M7.92989 21C7.92989 21 8.5993 16.5 6.49927 13C4.39924 9.5 4.99927 6 4.99927 6"
			stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

// Pompa ciepła (sterownik co): widok główny, dane, wykresy, ustawienia i harmonogramy.
export const heatPumpDeviceType: DeviceTypeView = {
	type: DeviceType.HP,
	tileIcon: (
		<svg className="device-selection-icon" viewBox="0 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<path d="M11.0007 3C11.0007 3 9.86264 7.5 11.9313 12C14 16.5 13.5 21 13.5 21M18.9313 21C18.9313 21 19.6008 16.5 17.5007 13C15.4007 9.5 16.0007 6 16.0007 6M7.92989 21C7.92989 21 8.5993 16.5 6.49927 13C4.39924 9.5 4.99927 6 4.99927 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	),
	// OTA od firmware co 1.1.0 (oferta w odpowiedzi /hp/add)
	firmwareUpdates: true,
	// okno „Dane sterownika”: podłączenie CWU / CO, zbiornik, fotowoltaika
	DefinitionFields: PumpConfigFields,
	views: [
		{ path: '/', label: 'HP', icon: <HeatPumpIcon />, element: <HP /> },
		{ path: '/chart', label: 'Statystyki', icon: <ChartIcon />, element: <HeatPumpChart /> },
		{ path: '/schedules', label: 'Harmonogram', icon: <ScheduleIcon />, element: <Schedules /> },
		{ path: '/settings', label: 'Ustawienia', icon: <SettingsIcon />, element: <Settings /> },
		{ path: '/data', label: 'Dane', icon: <DataIcon />, element: <HeatPumpTable /> },
		{ path: '/operations', label: 'Operacje', icon: <OperationsIcon />, element: <OperationsPage /> },
	],
	// /hp: drugi adres widoku głównego, poza menu (starsze linki); hydrofor go nie ma, więc tam prowadzi na /
	extraRoutes: [{ path: '/hp', element: <HP /> }],
};
