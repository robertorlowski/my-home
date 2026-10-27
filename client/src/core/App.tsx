// Szkielet aplikacji: router, logowanie (AuthGate: konta użytkowników od 2026-10-11), strażnik wyboru sterownika
// (DeviceGuard), pasek sterownika z zakładkami (Header; na telefonie dolna nawigacja BottomNav) i trasy z rejestru
// rodzajów sterowników (device-types.tsx). Stopka „Aktywne urządzenie” zniknęła 2026-10-16 (nowy wygląd z makiet/):
// do listy prowadzi strzałka w pasku i „Więcej” w dolnej nawigacji.
// Montowany w index.tsx.
// Serwer: GET /api/devices (lista sterowników). Sterownika domyślnego ani automatycznego wyboru nie ma.
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { BottomNav, Header, viewLabel } from './components/Header';
import { DEVICES_HEADER_ACTIONS_ID, Devices } from './pages/Devices';
import Weather from './pages/Weather';
import { WeatherBottomNav, WeatherHeader } from './pages/Weather/nav';
import { Firmware } from './pages/Firmware';
import { useDevice } from './context/DeviceContext';
import { DEMO_BLOCKED_EVENT } from './auth';
import { Navigate, useLocation } from 'react-router-dom';
import { Fragment, useEffect, useState } from 'react';
import { DeviceRequests } from './api';
import { Device } from './types';
import { allDevicePaths, getDeviceTypeView } from './device-types';
import { useAuth } from './context/AuthContext';
import { Login } from './pages/Login';
import { Account, DeleteAccountConfirm } from './pages/Account';
import { ProfileForm } from './components/ProfileForm';
import { RememberDialog } from './components/RememberDialog';
import { UserMenu } from './components/UserMenu';
import { BackIcon } from './components/icons';
import { useLang } from './i18n';
import './components/account.css';

// Klucz sesji przeglądarki: otwarcie aplikacji zawsze zaczyna od listy kafelków (/devices), także gdy w
// localStorage został wybrany sterownik; późniejsze przeładowania w tej samej sesji zostają na bieżącej stronie.
const startedKey = 'chpc.startedOnList';

// porównanie pól pokazywanych w interfejsie; rootId jest już równy (szukany po nim)
// (z kontami także dostęp i zakładki udostępnienia, bo od nich zależy menu)
const sameDevice = (a: Device, b: Device) =>
	a.deviceId === b.deviceId && a.name === b.name && a.deviceType === b.deviceType
	&& a.access === b.access && JSON.stringify(a.tabs ?? null) === JSON.stringify(b.tabs ?? null);

// Bez sesji: ekran logowania (każda ścieżka; link z maila to /login?token=…). Nowe konto: formularz danych
// (imię, nazwisko, kraj obowiązkowe). Po zalogowaniu kodem albo linkiem: pytanie o zapamiętanie na 90 dni.
// /account/delete?token=… (link usunięcia konta z maila) działa także bez zalogowania.
function AuthGate({ children }: { children: React.ReactNode }) {
	const { status, user, askRemember, retry, setUser } = useAuth();
	const { t } = useLang();
	const location = useLocation();
	if (location.pathname === '/account/delete') return <DeleteAccountConfirm />;
	if (status === 'loading') return <p className="app-loading">{t('common.loading')}</p>;
	if (status === 'offline') {
		return (
			<div className="app-loading">
				<p>{t('app.offline')}</p>
				<button type="button" onClick={retry}>{t('common.retry')}</button>
			</div>
		);
	}
	if (status === 'anonymous' || !user) {
		return (
			<>
				<header className="app-header"><span className="brand"><span className="brand-mark" /><span className="brand-name">My Home</span></span><h1 className="app-header-title">{t('app.loginTitle')}</h1><UserMenu /></header>
				<main className="app-main"><Login /></main>
			</>
		);
	}
	if (!user.profileComplete) {
		return (
			<>
				<header className="app-header"><span className="brand"><span className="brand-mark" /><span className="brand-name">My Home</span></span><h1 className="app-header-title">{t('app.newAccount')}</h1><UserMenu /></header>
				<main className="app-main">
					<div className="account-page account-narrow">
						<h1>{t('app.completeProfile')}</h1>
						<p className="account-lead">{t('app.requiredFields')}</p>
						<ProfileForm user={user} onSaved={setUser} />
					</div>
				</main>
			</>
		);
	}
	return <>{children}{askRemember && <RememberDialog />}</>;
}

// Pasek pod menu sterownika udostępnionego przez inną osobę: kto udostępnił i które zakładki.
function SharedBanner() {
	const { device } = useDevice();
	const { t } = useLang();
	if (device?.access !== 'shared') return null;
	const views = getDeviceTypeView(device.deviceType).views;
	const tabs = (device.tabs ?? []).map((path) => path === '/' ? t('view.overview') : path === 'simple' ? t('view.simple') : views.find((view) => view.path === path) ? viewLabel(path, device.deviceType, t) : path);
	return <div className="shared-banner">{t('app.sharedBy', { name: device.owner?.name ?? t('app.otherUser') })} · {t('app.sharedAccess')}: {tabs.join(', ')}</div>;
}

// Wersja demo (2026-10-21): żółty pasek na każdej stronie i komunikat, gdy próba zapisu została zatrzymana (core/http.ts).
function DemoBanner() {
	const { user, logout } = useAuth();
	const { t } = useLang();
	if (!user?.isDemo) return null;
	return (
		<div className="shared-banner demo-banner">
			{t('app.demoBanner')} <button type="button" className="link-btn" onClick={() => void logout()}>{t('app.demoExit')}</button>
		</div>
	);
}

function DemoToast() {
	const [visible, setVisible] = useState(false);
	const { t } = useLang();
	useEffect(() => {
		let timer: number | undefined;
		const show = () => { setVisible(true); window.clearTimeout(timer); timer = window.setTimeout(() => setVisible(false), 3000); };
		window.addEventListener(DEMO_BLOCKED_EVENT, show);
		return () => { window.removeEventListener(DEMO_BLOCKED_EVENT, show); window.clearTimeout(timer); };
	}, []);
	if (!visible) return null;
	return <div className="demo-toast" role="status">{t('app.demoBlocked')}</div>;
}

// Strażnik: bez wybranego sterownika każda ścieżka poza /devices przekierowuje na listę kafelków (pages/Devices).
function DeviceGuard({ children }: { children: React.ReactNode }) {
	const { device, selectDevice, clearDevice } = useDevice();
	const location = useLocation();
	const [startOnList, setStartOnList] = useState(() => {
		if (sessionStorage.getItem(startedKey)) return false;
		sessionStorage.setItem(startedKey, '1');
		return location.pathname === '/';
	});
	// po przejściu na /devices przekierowanie startowe jest zużyte; bez tego strażnik zwracałby samo <Navigate>
	// zamiast stron i pierwsze wejście dawało pustą aplikację aż do odświeżenia (błąd z 2026-10-08)
	useEffect(() => {
		if (location.pathname !== '/') setStartOnList(false);
	}, [location.pathname]);

	// zapamiętany sterownik może nie istnieć w bazie (np. po przełączeniu z bazy lokalnej na produkcyjną);
	// wtedy każde żądanie kończy się 404, więc wybór jest czyszczony. Błąd sieci (null) niczego nie czyści.
	// Istniejący sterownik jest odświeżany z serwera, żeby w localStorage nie zostały stara nazwa czy deviceId.
	useEffect(() => {
		if (!device) return;
		DeviceRequests.getDevices().then((list) => {
			if (!list) return;
			const current = list.find((item) => item.rootId === device.rootId);
			if (!current) clearDevice();
			else if (!sameDevice(current, device)) selectDevice(current);
		});
	}, [device?.rootId]);

	if (startOnList && location.pathname === '/') return <Navigate to="/devices" replace />;

	// /firmware/:deviceType wskazuje rodzaj w adresie, /weather/:id kafelek pogody, /account to dane konta:
	// bez wyboru sterownika
	if (!device && location.pathname !== '/devices' && !location.pathname.startsWith('/firmware') && !location.pathname.startsWith('/weather/') && !location.pathname.startsWith('/account')) {
		return <Navigate to="/devices" replace />;
	}

	return <>{children}</>;
}

// Widok ścieżki dla rodzaju wybranego sterownika (rejestr w device-types.tsx); ścieżka, której
// ten rodzaj nie ma (np. /schedules hydroforu), prowadzi na stronę główną. key daje stronie
// nowy stan po zmianie sterownika.
function DeviceRoute({ path }: { path: string }) {
	const { device } = useDevice();
	const { t } = useLang();
	const view = getDeviceTypeView(device?.deviceType);
	const element = view.views.find((item) => item.path === path)?.element
		?? view.extraRoutes?.find((route) => route.path === path)?.element;
	if (!element) return <Navigate to="/" replace />;
	// sterownik udostępniony: tylko wybrane zakładki (/hp to widok główny pompy, jak /)
	if (device?.access === 'shared') {
		const tabs = device.tabs ?? [];
		if (!tabs.includes(path === '/hp' ? '/' : path)) {
			const first = view.views.find((item) => tabs.includes(item.path));
			return first && first.path !== path ? <Navigate to={first.path} replace /> : <p className="app-loading">{t('app.noTabAccess')}</p>;
		}
	}
	return <Fragment key={device?.rootId}>{element}</Fragment>;
}

// Na liście sterowników (/devices) nie ma menu: bez wybranego sterownika nie wiadomo, jakie widoki pokazać.
// Trasy powstają dla sumy ścieżek wszystkich rodzajów; który widok się pokaże, decyduje DeviceRoute.
function AppContent() {
	const location = useLocation();
	const { t } = useLang();
	// bez menu: /devices (lista sterowników), /firmware/:deviceType (firmware rodzaju sterownika) i /account;
	// /weather/:id (pogoda kafelka) ma od 2026-10-19 własne zakładki w menu jak sterownik (pages/Weather/nav.tsx)
	const isWeather = location.pathname.startsWith('/weather/');
	const isDeviceSelection = location.pathname === '/devices' || location.pathname.startsWith('/firmware') || location.pathname.startsWith('/account');
	const isDevice = !isDeviceSelection && !isWeather;

	return (
		<DeviceGuard>
			<div className={`app-container${isDeviceSelection ? '' : ' has-side'}`}>
				{isDevice && <header className="app-header">
					<Header />
				</header>}
				{isWeather && <header className="app-header">
					<WeatherHeader />
				</header>}
				{/* /devices: pasek z nazwą aplikacji (bez zakładek, bo nie wybrano sterownika) */}
				{location.pathname === '/devices' && <header className="app-header">
					<span className="brand"><span className="brand-mark" /><span className="brand-name">My Home</span></span>
					<h1 className="app-header-title">{t('app.devices')}</h1>
					{/* miejsce na przyciski strony (trybik „Zmień układ” wstawia tu pages/Devices) */}
					<span id={DEVICES_HEADER_ACTIONS_ID} className="app-header-actions" />
					<UserMenu />
				</header>}
				{(location.pathname.startsWith('/account') || location.pathname.startsWith('/firmware')) && <header className="app-header">
					<Link to="/devices" className="nav-back" title={t('nav.deviceList')} aria-label={t('nav.backToList')}><BackIcon /></Link>
					<h1 className="app-header-title">{location.pathname.startsWith('/account') ? t('menu.myData') : 'Firmware'}</h1>
					<UserMenu />
				</header>}

				<main className="app-main">
				{/* w treści strony, nie pod stałym nagłówkiem */}
				<DemoBanner />
				<DemoToast />
				{isDevice && <SharedBanner />}
				<Routes>
					<Route path="/devices" element={<Devices />} />
					<Route path="/account" element={<Account />} />
					{/* link z maila po zalogowaniu (adres zostaje /login): lista sterowników */}
					<Route path="/login" element={<Navigate to="/devices" replace />} />
					<Route path="/firmware/:deviceType" element={<Firmware />} />
					<Route path="/weather/:id" element={<Weather />} />
					{allDevicePaths().map((path) => (
						<Route key={path} path={path} element={<DeviceRoute path={path} />} />
					))}
				</Routes>
				</main>
				{/* telefon: dolna nawigacja na stronach sterownika i pogody (CSS ukrywa ją od 900 px) */}
				{isDevice && <BottomNav />}
				{isWeather && <WeatherBottomNav />}
			</div>
		</DeviceGuard>
);
}

export function App() {
	return (
		<BrowserRouter>
			<AuthGate>
				<AppContent />
			</AuthGate>
		</BrowserRouter>
	);
  }
