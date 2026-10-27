import { ReactNode, useEffect, useState } from "react";
import { Link, To, useLocation } from "react-router-dom";
import { deviceLabel, useDevice } from "../context/DeviceContext";
import { useAuth } from "../context/AuthContext";
import { getDeviceTypeView } from "../device-types";
import { Device, DeviceTile, DeviceTiles, DeviceType } from "../types";
import { BackIcon, OperationsIcon } from "./icons";
import { UserMenu } from "./UserMenu";
import { useLang } from "../i18n";

// Nazwa zakładki w języku aplikacji (wersja językowa 2026-10-21): rejestr rodzajów podaje label po polsku, a słownik
// ma klucze view.<ścieżka> (wspólne: Dane, Wykres, Harmonogram, Operacje, Ustawienia, Alarmy) i view.home.<rodzaj>
// dla widoku głównego; brak klucza w słowniku = polska nazwa z rejestru.
export function viewLabel(path: string, deviceType: DeviceType | undefined, t: (key: string) => string): string {
	const key = path === "/" || path === "/hp" ? `view.home.${deviceType ?? ""}` : `view.${path.replace(/^\//, "")}`;
	const text = t(key);
	return text === key ? (getDeviceTypeView(deviceType).views.find((view) => view.path === path)?.label ?? path) : text;
}

// Pasek sterownika (App.tsx, strony poza /devices), wygląd „Instrument” z makiet/ (2026-10-16, linia .device-sub jak w
// makiecie 2026-10-17): strzałka powrotu do listy, nazwa sterownika, pod nią chip stanu (Online / Offline z pamięci
// kafelków listy, pulsująca kropka przy pracy), chip „pracuje” (sprężarka pompy, palenie w piecu) i opis zależny od
// rodzaju (DeviceSub), zakładki z rejestru rodzajów sterowników i konto. Zakładki rysuje <nav class="app-tabs">: na
// komputerze (≥ 900 px) boczne menu po lewej, na telefonie ukryte — zamiast nich <BottomNav>: cztery pierwsze widoki
// i „Więcej” (arkusz z resztą widoków i listą sterowników).
// Od 2026-10-19 tak samo rysuje zakładki strona pogody (pages/Weather/nav.tsx): wspólne SideTabs i BottomNavItems
// przyjmują listę pozycji (NavItem), a nie widoki sterownika.
// Stan kafelka: localStorage chpc.deviceTiles.<id konta> (pages/Devices zapisuje odpowiedź GET /api/devices/summary).

function readTile(userId: string | undefined, rootId: string | undefined): DeviceTile | undefined {
	if (!userId || !rootId) return undefined;
	try {
		const raw = localStorage.getItem(`chpc.deviceTiles.${userId}`);
		if (!raw) return undefined;
		return (JSON.parse(raw) as DeviceTiles)[rootId];
	} catch {
		return undefined;
	}
}

export function useDeviceViews() {
	const { device } = useDevice();
	const { views: allViews } = getDeviceTypeView(device?.deviceType);
	// sterownik udostępniony: w menu tylko udostępnione zakładki (konta użytkowników)
	return device?.access === 'shared' ? allViews.filter((view) => device.tabs?.includes(view.path)) : allViews;
}

// Kafelek wybranego sterownika z pamięci listy; odświeżany po zapisie listy (storage) i co 30 s.
function useDeviceTile(): DeviceTile | undefined {
	const { device } = useDevice();
	const { user } = useAuth();
	const [tile, setTile] = useState<DeviceTile | undefined>(() => readTile(user?.id, device?.rootId));
	useEffect(() => {
		setTile(readTile(user?.id, device?.rootId));
		const refresh = () => setTile(readTile(user?.id, device?.rootId));
		window.addEventListener('storage', refresh);
		const timer = window.setInterval(refresh, 30000);
		return () => { window.removeEventListener('storage', refresh); window.clearInterval(timer); };
	}, [user?.id, device?.rootId]);
	return tile;
}


// Opis pod nazwą zależny od rodzaju („tryb automatyczny”, „4 panele · DTU Hoymiles”, „2 przekaźniki · firmware 1.2.0”,
// „ecoMAX 860P2 · odczyt co 5 min”, „ostatnie uruchomienie 13:56”) z danych, które pasek ma: wybrany sterownik (firmware,
// ustawienia) i kafelek listy (tryb, panele, przekaźniki, stopka). Bez numeru seryjnego (od 2026-10-19; SN jest w karcie
// „Sterownik” w Ustawieniach); pusty napis, gdy nie ma czego pokazać.
function deviceSubText(device: Device, tile: DeviceTile | undefined, { t, tn }: ReturnType<typeof useLang>): string {
	const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
	switch (device.deviceType) {
		case DeviceType.HP: {
			const mode = tile?.row?.[0]?.value;
			return mode ? t('header.mode', { mode }) : '';
		}
		case DeviceType.PHOTOVOLTAIC: {
			const panels = tile?.side?.find((fact) => fact.icon === 'panel')?.value.split('/').pop()?.trim();
			const count = panels ? Number(panels) : NaN;
			return join(Number.isFinite(count) ? tn('header.panels', count) : undefined, 'DTU Hoymiles');
		}
		case DeviceType.WATER_PRESSURE_TANK:
			return tile?.foot ?? '';
		case DeviceType.SWITCH: {
			const relays = tile?.relays?.length;
			return join(relays ? tn('header.relays', relays) : undefined,
				device.firmwareVersion ? `firmware ${device.firmwareVersion}` : undefined);
		}
		case DeviceType.PELLET_BOILER_PELUX200: {
			const seconds = device.properties?.poll_interval_seconds;
			return join('ecoMAX 860P2', seconds ? t('header.pollEvery', { every: seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s` }) : undefined);
		}
		default:
			return '';
	}
}

// Linia pod nazwą (makieta .device-sub): chip stanu ON / OFF jak na kafelku (od 2026-10-27 zamiast Online / Offline;
// włącznik i PV bez chipu, brak odpowiedzi pokazuje OfflineBanner na stronie), przy pracy sprężarki albo paleniu
// w piecu chip „pracuje” (.state.sub-run; czasu pracy kafelek nie podaje) i opis rodzaju po kropce.
function DeviceSub({ device }: { device: Device }) {
	const tile = useDeviceTile();
	const lang = useLang();
	const { t } = lang;
	const runs = !!tile?.running && (device.deviceType === DeviceType.HP || device.deviceType === DeviceType.PELLET_BOILER_PELUX200);
	const text = deviceSubText(device, tile, lang);
	return (
		<span className="device-sub">
			{tile && (
				<>
					{tile.power && (
						<span className={`chip ${tile.power === 'on' ? 'chip-ok' : 'chip-off'}${tile.running ? ' is-running' : ''}`} title={tile.running ? t('header.running') : undefined}>
							{tile.running && <i className="dot" />}{t(tile.power === 'on' ? 'chip.on' : 'chip.off')}
						</span>
					)}
					{runs && <span className="state state-on sub-run" title={device.deviceType === DeviceType.HP ? t('header.compressorRuns') : t('header.burning')}><i className="dot" />{t('header.runningShort')}</span>}
					{text && (tile.power || runs) && <span className="sep">·</span>}
				</>
			)}
			{text && <span className="device-sub-text">{text}</span>}
		</span>
	);
}

// Pozycja menu: adres (ścieżka albo ścieżka z ?tab=), opis, ikona, czy wybrana; state i replace przekazuje Link
// (pogoda: kafelek w stanie nawigacji, zmiana zakładki bez wpisu w historii).
export type NavItem = { key: string; to: To; label: string; icon: ReactNode; active: boolean; state?: unknown; replace?: boolean };

// Zakładki w pasku: na komputerze (≥ 900 px) boczne menu po lewej, na telefonie ukryte (CSS).
export function SideTabs({ items, label }: { items: NavItem[]; label: string }) {
	return (
		<nav className="app-tabs" aria-label={label}>
			{items.map((item) => (
				<Link key={item.key} to={item.to} state={item.state} replace={item.replace} title={item.label} aria-label={item.label}
					className={item.active ? 'active' : ''}>
					{item.icon}
					<span className="nav-label">{item.label}</span>
				</Link>
			))}
		</nav>
	);
}

const viewItems = (views: ReturnType<typeof useDeviceViews>, pathname: string, deviceType: DeviceType | undefined, t: (key: string) => string): NavItem[] =>
	views.map((view) => ({ key: view.path, to: view.path, label: viewLabel(view.path, deviceType, t), icon: view.icon, active: pathname === view.path }));

export function Header() {
	const location = useLocation();
	const { device } = useDevice();
	const views = useDeviceViews();
	const { t } = useLang();
	return (
		<>
			<Link to="/devices" className="nav-back" title={t('nav.deviceList')} aria-label={t('nav.backToList')}>
				<BackIcon />
			</Link>
			<div className="device-title">
				<h1>{device ? deviceLabel(device) : t('nav.device')}</h1>
				{device && <DeviceSub device={device} />}
			</div>
			<SideTabs items={viewItems(views, location.pathname, device?.deviceType, t)} label={t('nav.deviceViews')} />
			{/* konto zalogowanego: po prawej stronie paska */}
			<UserMenu />
		</>
	);
}

// Dolna nawigacja telefonu sterownika: 4 pierwsze widoki + „Więcej” (CSS ukrywa ją od 900 px).
export function BottomNav() {
	const location = useLocation();
	const { device } = useDevice();
	const views = useDeviceViews();
	const { t } = useLang();
	return <BottomNavItems items={viewItems(views, location.pathname, device?.deviceType, t)} label={t('nav.deviceViewsPhone')} />;
}

// Dolna nawigacja telefonu: 4 pierwsze pozycje + „Więcej” (arkusz z resztą i listą sterowników).
export function BottomNavItems({ items, label }: { items: NavItem[]; label: string }) {
	const location = useLocation();
	const { t } = useLang();
	const [open, setOpen] = useState(false);
	useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
		document.addEventListener('keydown', close);
		return () => document.removeEventListener('keydown', close);
	}, [open]);
	const first = items.slice(0, 4);
	const rest = items.slice(4);
	const restActive = rest.some((item) => item.active);
	return (
		<>
			<nav className="bottom-nav" aria-label={label}>
				{first.map((item) => (
					<Link key={item.key} to={item.to} state={item.state} replace={item.replace} className={item.active ? 'active' : ''} aria-label={item.label}>
						{item.icon}
						<span>{item.label}</span>
					</Link>
				))}
				<button type="button" className={restActive ? 'active' : ''} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
					<span>{t('nav.more')}</span>
				</button>
			</nav>
			{open && (
				<>
					<div className="more-sheet-scrim" onClick={() => setOpen(false)} />
					<div className="more-sheet" role="menu">
						<div className="more-sheet-grip" />
						{rest.map((item) => (
							<Link key={item.key} to={item.to} state={item.state} replace={item.replace} role="menuitem" className={item.active ? 'active' : ''}>
								{item.icon}{item.label}
							</Link>
						))}
						{rest.length > 0 && <div className="more-sheet-sep" />}
						<Link to="/devices" role="menuitem"><OperationsIcon />{t('nav.deviceList')}</Link>
					</div>
				</>
			)}
		</>
	);
}
