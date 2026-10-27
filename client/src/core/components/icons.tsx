// Ikony menu wspólne dla rodzajów sterowników (Dane, Wykres, Harmonogram, Ustawienia). Kolejność menu we
// wszystkich rodzajach: strona główna, Dane, Wykres, Harmonogram, Ustawienia (zawsze na końcu).

export const DataIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path d="M5 19V5M5 19H20M9 16V12M13 16V8M17 16V10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

export const ChartIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path d="M4 18L9 13L13 16L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		<path d="M16 7H20V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

// zegar: Harmonogram we wszystkich rodzajach; fill="none" jawnie, bo CSS menu ustawia fill: white
export const ScheduleIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
		<path d="M12 7V12L15 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

export const SettingsIcon = () => (
	<svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="25" height="25" viewBox="0 0 50 50">
		<path d="M47.16,21.221l-5.91-0.966c-0.346-1.186-0.819-2.326-1.411-3.405l3.45-4.917c0.279-0.397,0.231-0.938-0.112-1.282 l-3.889-3.887c-0.347-0.346-0.893-0.391-1.291-0.104l-4.843,3.481c-1.089-0.602-2.239-1.08-3.432-1.427l-1.031-5.886 C28.607,2.35,28.192,2,27.706,2h-5.5c-0.49,0-0.908,0.355-0.987,0.839l-0.956,5.854c-1.2,0.345-2.352,0.818-3.437,1.412l-4.83-3.45 c-0.399-0.285-0.942-0.239-1.289,0.106L6.82,10.648c-0.343,0.343-0.391,0.883-0.112,1.28l3.399,4.863 c-0.605,1.095-1.087,2.254-1.438,3.46l-5.831,0.971c-0.482,0.08-0.836,0.498-0.836,0.986v5.5c0,0.485,0.348,0.9,0.825,0.985 l5.831,1.034c0.349,1.203,0.831,2.362,1.438,3.46l-3.441,4.813c-0.284,0.397-0.239,0.942,0.106,1.289l3.888,3.891 c0.343,0.343,0.884,0.391,1.281,0.112l4.87-3.411c1.093,0.601,2.248,1.078,3.445,1.424l0.976,5.861C21.3,47.647,21.717,48,22.206,48 h5.5c0.485,0,0.9-0.348,0.984-0.825l1.045-5.89c1.199-0.353,2.348-0.833,3.43-1.435l4.905,3.441 c0.398,0.281,0.938,0.232,1.282-0.111l3.888-3.891c0.346-0.347,0.391-0.894,0.104-1.292l-3.498-4.857 c0.593-1.08,1.064-2.222,1.407-3.408l5.918-1.039c0.479-0.084,0.827-0.5,0.827-0.985v-5.5C47.999,21.718,47.644,21.3,47.16,21.221z M25,32c-3.866,0-7-3.134-7-7c0-3.866,3.134-7,7-7s7,3.134,7,7C32,28.866,28.866,32,25,32z"></path>
	</svg>
);

// dzwonek: zakładka Alarmy (kocioł)
export const AlarmIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
		<path d="M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
	</svg>
);

// lista z punktami: zakładka Operacje (dziennik operacji sterownika)
export const OperationsIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		<path d="M9 6H20M9 12H20M9 18H20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<path d="M4.5 6H5M4.5 12H5M4.5 18H5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
	</svg>
);

// Ikony akcji w przyciskach-ikonach (components/IconButton.tsx): dodaj, usuń, przywróć, wróć, edytuj: kreska 2, siatka 24, kolor z currentColor.
const action = (path: React.ReactNode) => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
		strokeLinejoin="round" aria-hidden="true">{path}</svg>
);

export const PlusIcon = () => action(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>);
export const TrashIcon = () => action(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const BackIcon = () => action(<path d="M19 12H5M11 6l-6 6 6 6" />);
export const EditIcon = () => action(<><path d="M4 20H8L18.5 9.5C19.3 8.7 19.3 7.3 18.5 6.5L17.5 5.5C16.7 4.7 15.3 4.7 14.5 5.5L4 16V20Z" /><path d="M13 7L17 11" /></>);
