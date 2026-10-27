// Kafelek na liście sterowników (/devices) w wyglądzie „Instrument” (2026-10-17): stały układ z makiety
// (makiety/src/makieta.html, ekran #s-lista; klasy .tile* z client/src/makieta.css). Rysuje treść kafelka
// (bez obramowania <article>, które daje pages/Devices): .tile-head (ikona rodzaju, nazwa, chip Online / Offline,
// narzędzia), .tile-main (.tile-value: duża liczba + jednostka + opis; .tile-side: stan pracy), .tile-facts (pola
// dt/dd), .warn-line (błąd albo ostrzeżenie), .relays (włącznik) i .tile-foot „dane sprzed …”.
// Dane z GET /api/devices/summary (DeviceTile): wartość główna, wartości boczne i wiersz wartości są tu rozkładane
// na pola makiety osobno dla każdego rodzaju (shapeTile). Kafelek pogody (WeatherTileCard) z GET /api/weather-tiles.
// Ikony rodzajów i narzędzi to ikony makiety (ListIcon, kreska 1.8), żeby animacje .is-running z makieta.css działały.
// Teksty w języku aplikacji (core/i18n): etykiety z serwera przychodzą już w języku żądania (Accept-Language), chipy
// 'Online' / 'Offline' / 'Brak danych' / 'Brak uruchomień' są identyfikatorami i tłumaczy je chipText.
import { ReactNode } from 'react';
import { DeviceTile, DeviceType, TileFact, Weather, WeatherTile } from '../types';
import { precipitationText, weatherDescription, WeatherIcon } from './WeatherIcon';
import { currentPlaceProblem, useCurrentPlace } from '../currentPlace';
import { useLang } from '../i18n';
import { OfflineIcon } from './OfflineBanner';
import { ageLabel, number, number1, warsawTime, whenLabel } from '../i18n/format';

export { ageLabel } from '../i18n/format';

// chip kafelka: identyfikator z serwera → tekst w języku aplikacji
const CHIP_KEYS: Record<string, string> = { Online: 'chip.online', Offline: 'chip.offline', 'Brak danych': 'chip.noData', 'Brak uruchomień': 'chip.noRuns' };
export const chipText = (chip: string, t: (key: string) => string) => (CHIP_KEYS[chip] ? t(CHIP_KEYS[chip]) : chip);

// ---- ikony makiety (jeden zestaw, kreska 1.8; makieta.html, ICONS) ----
const ICON_PATHS: Record<string, string> = {
  hp: 'M6 3c-2 3-2 5 0 8s2 5 0 8M12 3c-2 3-2 5 0 8s2 5 0 8M18 3c-2 3-2 5 0 8s2 5 0 8',
  pv: 'M4 10h16l2 9H2zM8 10l1-4h6l1 4M6 14.5h12M9 10v9M15 10v9',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  drop: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z',
  fire: 'M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-6 1-9z',
  edit: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
  chip: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  move: 'M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z',
  'eye-off': 'M3 3l18 18M10 6a10 10 0 0 1 12 6s-1 2-3 4M6 8c-2 2-4 4-4 4s4 7 10 7c2 0 3-.5 5-1',
  close: 'M6 6l12 12M18 6L6 18',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  pin: 'M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zM12 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z',
  locate: 'M3 11l18-8-8 18-2-8z',
  grid: '',
  'switch': '',
};
export type ListIconName = keyof typeof ICON_PATHS;

// Ikona makiety jako SVG z klasą .ic (rozmiar i animacje z makieta.css).
export function ListIcon({ name }: { name: ListIconName }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'sun' && <circle cx="12" cy="12" r="4" />}
      {name === 'chip' && <rect x="6" y="6" width="12" height="12" rx="2" />}
      {name === 'eye' && <circle cx="12" cy="12" r="3" />}
      {name === 'switch' && <><rect x="2" y="7" width="20" height="10" rx="5" /><circle cx="16" cy="12" r="3" /></>}
      {name === 'grid' && <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>}
      {ICON_PATHS[name] && <path d={ICON_PATHS[name]} />}
    </svg>
  );
}

// rodzaj sterownika → data-kind makiety (kolor ikony i krawędzi: .tile[data-kind] w makieta.css)
export type TileKind = 'hp' | 'pv' | 'tank' | 'switch' | 'boiler' | 'weather';
export const TILE_KINDS: Record<DeviceType, TileKind> = {
  [DeviceType.HP]: 'hp',
  [DeviceType.PHOTOVOLTAIC]: 'pv',
  [DeviceType.WATER_PRESSURE_TANK]: 'tank',
  [DeviceType.SWITCH]: 'switch',
  [DeviceType.PELLET_BOILER_PELUX200]: 'boiler',
};
const KIND_ICONS: Record<TileKind, ListIconName> = { hp: 'hp', pv: 'pv', tank: 'drop', switch: 'switch', boiler: 'fire', weather: 'sun' };

// Kolor chipu bez pola power („Brak danych”, „Brak uruchomień”): według poziomu; Online / Offline nie są już rysowane
// (od 2026-10-27 stan ON / OFF, a brak odpowiedzi w czerwonej linii), funkcja zostaje dla pozostałych napisów.
function chipClass(tile: DeviceTile, deviceType: DeviceType): string {
  if (tile.chip === 'Online') return 'ok';
  if (tile.chip === 'Offline') return deviceType === DeviceType.WATER_PRESSURE_TANK ? 'off' : 'err';
  return tile.level === 'ok' ? 'off' : tile.level;
}

// „42,5 °C” → duża liczba „42,5” i jednostka „°C”; wartość bez jednostki (np. „---”, „0 / 10”) zostaje w całości
function splitValue(value: string): { big: string; unit?: string } {
  const match = /^(.*\d)\s+([^\d\s]+)$/.exec(value.trim());
  return match ? { big: match[1], unit: match[2] } : { big: value };
}

// podpis pola, gdy serwer nie podał etykiety (np. tryb pracy pompy ma pustą etykietę): klucz słownika tile.icon.<ikona>
const ICON_KEYS: Partial<Record<TileFact['icon'], string>> = {
  sliders: 'tile.icon.sliders', bolt: 'tile.icon.bolt', thermo: 'tile.icon.thermo', pellet: 'tile.icon.pellet', tap: 'tile.icon.tap', battery: 'tile.icon.battery',
  panel: 'tile.icon.panel', timer: 'tile.icon.timer', repeat: 'tile.icon.repeat', bubbles: 'tile.icon.bubbles', target: 'tile.icon.target', drop: 'tile.icon.drop', sun: 'tile.icon.sun',
};
type Fact = { dt: string; dd: string };
type T = (key: string, params?: Record<string, string | number>) => string;

// czas pracy w plakietce stanu: „49 min”, „2 h 08 min” (jak w makiecie); withSeconds: poniżej minuty „40 s” (pompa hydroforu)
function workTime(ms: number, withSeconds = false): string {
  if (withSeconds && ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))} s`;
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
const fact = (t: T, item: TileFact, dt?: string): Fact => ({ dt: dt ?? (item.label || (ICON_KEYS[item.icon] ? t(ICON_KEYS[item.icon]!) : '')), dd: item.value });

type Shape = {
  big?: string;
  unit?: string;
  label?: string;
  /** stan pracy w .tile-side (sprężarka, palenie, pompa hydroforu) */
  state?: { text: string; title: string };
  /** wskaźniki pomp obiegu pod stanem (kocioł: CO, CWU) */
  pumps?: { label: string; on: boolean }[];
  facts: Fact[];
  foot?: string;
};

// Rozkład danych kafelka (DeviceTile) na pola makiety: wartość główna z opisem, stan pracy po prawej, pola dt/dd.
// Każdy rodzaj inaczej składa opis pod dużą liczbą (jak w makiecie: „zbiornik · cel 38–45”, „dziś · 7 507 l
// w miesiącu”, „moc teraz · 4 panele”, „kocioł · zadana 67”).
function shapeTile(kind: TileKind, tile: DeviceTile, now: number, t: T): Shape {
  const side = tile.side ?? [];
  const row = tile.row ?? [];
  const shape: Shape = { facts: [] };
  if (tile.main) Object.assign(shape, splitValue(tile.main.value));
  const label = tile.main?.label ?? '';
  switch (kind) {
    case 'hp': {
      const target = side.find((item) => item.icon === 'target');
      shape.label = target ? `${label} · ${t('tile.target')} ${target.value}` : label;
      shape.facts = [...side.filter((item) => item !== target), ...row.filter((item) => item.icon !== 'sliders')].map((item) => fact(t, item));
      if (tile.running) shape.state = { text: t('tile.running'), title: t('header.compressorRuns') };
      break;
    }
    case 'pv': {
      const panels = side.find((item) => item.icon === 'panel');
      shape.label = `${t('tile.powerNow')}${panels ? ` · ${panels.value} ${panels.label ?? t('tile.icon.panel')}` : ''}`;
      shape.facts = [...side.filter((item) => item !== panels).map((item) => fact(t, item)), ...row.map((item) => fact(t, item, item.icon === 'thermo' ? t('tile.inverter') : undefined))];
      break;
    }
    case 'tank': {
      shape.label = tile.main2 ? `${label} · ${t('tile.inMonth', { value: tile.main2.value })}` : label;
      shape.facts = row.map((item) => fact(t, item));
      // praca pompy (since) → stan pracy z czasem; postój (lastRunAt) → pole Ostatnie z chwilą startu
      if (tile.running && tile.since) {
        const time = workTime(now - new Date(tile.since).getTime(), true);
        shape.state = { text: time, title: t('tile.pumpRunningFor', { time }) };
      } else if (tile.lastRunAt) shape.facts.push({ dt: t('tile.lastRun'), dd: whenLabel(tile.lastRunAt, now) });
      else if (tile.foot) shape.foot = tile.foot;
      break;
    }
    case 'boiler': {
      // „kocioł · zadana 67”, pola CWU / Mieszacz 1 / Mieszacz 2, przy paleniu czas palenia i pompy CO / CWU
      shape.label = label.replace(' → ', ` · ${t('tile.setpoint')} `);
      shape.facts = [...side.map((item) => fact(t, item, item.icon === 'tap' ? t('tile.cwu') : undefined)), ...row.map((item) => fact(t, item))];
      if (tile.running) {
        shape.state = tile.since
          ? { text: workTime(now - new Date(tile.since).getTime()), title: t('tile.burningSince', { time: warsawTime(tile.since) }) }
          : { text: t('tile.burning'), title: t('tile.boilerBurning') };
      }
      shape.pumps = tile.pumps;
      break;
    }
    default:
      shape.label = label;
      shape.facts = [...side.map((item) => fact(t, item)), ...row.map((item) => fact(t, item))];
  }
  if (kind !== 'tank' && tile.foot) shape.foot = tile.foot;
  return shape;
}

// Pasek błędu albo ostrzeżenia (.warn-line z makiety; błąd w kolorach błędu, Devices/style.css)
// icon 'offline' = brak odpowiedzi sterownika: mała ikona przekreślonego sygnału jak w pasku „Offline od…” (2026-10-27)
const WarnLine = ({ note }: { note: NonNullable<DeviceTile['note']> }) => (
  <div className="tile-row"><span className={`warn-line${note.level === 'err' ? ' is-err' : ''}`}>{note.icon === 'offline' && <OfflineIcon />}{note.text}</span></div>
);

const Facts = ({ facts }: { facts: Fact[] }) => (
  <dl className="tile-facts">
    {facts.map((item, index) => <div key={index}><dt>{item.dt}</dt><dd title={item.dd}>{item.dd}</dd></div>)}
  </dl>
);

// Duszek: szare, pulsujące bloki w miejscu wartości (kafelek ma wysokość zwykłego kafelka, więc nic nie skacze).
function Skeleton() {
  return (
    <>
      <span className="skeleton skeleton-main" />
      <span className="skeleton skeleton-row" />
      <span className="skeleton skeleton-foot" />
    </>
  );
}


export function DeviceTileCard({ deviceType, name, tile, now, loading, hidden, tools }: {
  deviceType: DeviceType; name: string; tile?: DeviceTile; now: number;
  /** dane kafelka jeszcze się ładują: zamiast wartości duszek */
  loading?: boolean;
  /** kafelek ukryty (chip „Ukryty”, stopka o ukryciu) */
  hidden?: boolean;
  /** ołówek i trybik firmware w nagłówku (.tile-tools) */
  tools?: ReactNode;
}) {
  const kind = TILE_KINDS[deviceType] ?? 'hp';
  const { t } = useLang();
  const HIDDEN_FOOT = t('tile.hiddenFoot');
  const head = (
    <div className="tile-head">
      <span className="tile-icon"><ListIcon name={KIND_ICONS[kind]} /></span>
      <h2 className="tile-name">{name}</h2>
      {/* chip stanu ON / OFF zamiast Online / Offline (makieta 2026-10-27; pompa, kocioł, hydrofor; włącznik i PV bez chipu);
          brak odpowiedzi to czerwona linia note; „Brak danych” / „Brak uruchomień” zostają jako szary chip */}
      {hidden ? <span className="chip chip-off">{t('tile.hidden')}</span> : tile && (tile.power ? (
        <span className={`chip ${tile.power === 'on' ? 'chip-ok' : 'chip-off'}${tile.running ? ' is-running' : ''}`}
          title={tile.running ? t('header.running') : undefined}>
          {tile.running && <i className="dot" />}{t(tile.power === 'on' ? 'chip.on' : 'chip.off')}
        </span>
      ) : tile.chip !== 'Online' && tile.chip !== 'Offline' ? (
        <span className={`chip chip-${chipClass(tile, deviceType)}`}>{chipText(tile.chip, t)}</span>
      ) : null)}
      {tools && <span className="tile-tools">{tools}</span>}
    </div>
  );
  if (loading && !tile) return <>{head}<Skeleton /></>;
  if (!tile) return <>{head}{hidden && <footer className="tile-foot">{HIDDEN_FOOT}</footer>}</>;

  const shape = shapeTile(kind, tile, now, t);
  const age = tile.updatedAt ? t('tile.dataAge', { age: ageLabel(now - new Date(tile.updatedAt).getTime()) }) : '';
  const foot = hidden ? HIDDEN_FOOT : [shape.foot, age].filter(Boolean).join(' · ');
  return (
    <>
      {head}
      {tile.relays?.length ? (
        <div className="relays">
          {tile.relays.map((relay) => (
            <div key={relay.name} className="relay">
              <span className="relay-name">{relay.name}</span>
              {/* tryb „Wyłączony” blokuje harmonogram: opis na czerwono jak w makiecie */}
              <span className={`relay-desc${relay.mode === 'off' ? ' danger-text' : ''}`}>{relay.text}</span>
              <span className={`switch${relay.on ? ' is-on' : ''}`} role="switch" aria-checked={relay.on} aria-label={relay.name} />
            </div>
          ))}
        </div>
      ) : null}
      {shape.big !== undefined && (
        <div className="tile-main">
          <div className="tile-value">
            <span className="big">{shape.big}</span>
            {shape.unit && <span className="unit">{shape.unit}</span>}
            {shape.label && <span className="big-label">{shape.label}</span>}
          </div>
          {(shape.state || shape.pumps?.length) && (
            <div className="tile-side">
              {shape.state && <span className="state state-on" title={shape.state.title}><i className="dot" />{shape.state.text}</span>}
              {shape.pumps?.length ? (
                <span className="pumps" aria-label={t('tile.pumps')}>
                  {shape.pumps.map((pump) => (
                    <span key={pump.label} className={`pump${pump.on ? ' is-on' : ''}`} title={pump.on ? t('tile.pumpRuns', { name: pump.label }) : t('tile.pumpIdle', { name: pump.label })}>
                      <i className="dot" />{pump.label}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          )}
        </div>
      )}
      {shape.facts.length > 0 && <Facts facts={shape.facts} />}
      {tile.note && <WarnLine note={tile.note} />}
      {foot && <footer className="tile-foot">{foot}</footer>}
    </>
  );
}

const number01 = (value: number) => number(value, 1);

// Kafelek pogody: ikona nieba, nazwa, temperatura z opisem nieba, pola Wiatr / Chmury / Opad i stopka: przy pogodzie
// ikona „i” ze źródłem i wiekiem („Open-Meteo · X min temu”, od 2026-10-19 w dymku zamiast tekstu), bez pogody
// ostrzeżenie tekstem. „Dom” i kafelek konta przy domu (nearHome; od 2026-10-21, jak pasek nad listą) pokazuje temperaturę z czujnika zewnętrznego kotła
// (sensor: świeży pomiar z GET /temperature, do 15 min; model ICON z siatką 2 km mylił się o kilka stopni przy nocnej
// inwersji w dolinie), a niebo, wiatr i opad z Open-Meteo; bez świeżego pomiaru (piec wyłączony) temperatura z modelu.
// Kafelek bieżącej lokalizacji (current): nazwa miejscowości i pogoda z przeglądarki (CurrentWeatherTileCard).
export function WeatherTileCard({ tile, now, hidden, tools, sensor }: {
  tile: WeatherTile; now: number; hidden?: boolean; tools?: ReactNode; sensor?: number | null;
}) {
  const { t } = useLang();
  if (tile.current) return <CurrentWeatherTileCard tile={tile} now={now} hidden={hidden} tools={tools} />;
  const weather = tile.weather;
  const fromSensor = (tile.home || tile.nearHome) && typeof sensor === 'number';
  const foot = hidden ? t('tile.hiddenFoot') : weather
    ? <SourceTip text={`${fromSensor ? `${t('weather.boilerSensor')} · ` : ''}Open-Meteo · ${t('weather.ago', { age: ageLabel(now - new Date(weather.at).getTime()) })}`}
        detail={fromSensor
          ? t('weather.sensorDetail', { temperature: number1(weather.temperature) })
          : t('weather.switchDetail')} />
    : tile.home ? t('weather.homeNoReport') : t('weather.waitingSwitch');
  return <WeatherTileBody name={tile.name} weather={weather} foot={foot} hidden={hidden} tools={tools} emptyLabel={t('weather.noneFromSwitch')}
    temperature={fromSensor ? sensor as number : undefined} />;
}

function CurrentWeatherTileCard({ tile, now, hidden, tools }: {
  tile: WeatherTile; now: number; hidden?: boolean; tools?: ReactNode;
}) {
  const { t } = useLang();
  const { status, place } = useCurrentPlace(!hidden);
  const problem = currentPlaceProblem(status, t);
  const weather = place?.weather ?? null;
  const foot = hidden ? t('tile.hiddenFoot') : problem && !weather ? problem
    : weather ? <SourceTip text={`${t('weather.yourLocation')} · Open-Meteo · ${t('weather.ago', { age: ageLabel(now - new Date(weather.at).getTime()) })}`} detail={t('weather.browserDetail')} />
      : t('weather.locating');
  const chip = <span className="chip chip-loc" title={t('weather.currentLocationTitle')}><ListIcon name="locate" />{t('weather.youAreHere')}</span>;
  return <WeatherTileBody name={place?.name ?? tile.name} weather={weather} foot={foot} hidden={hidden} tools={tools} chip={chip}
    emptyLabel={problem ? t('weather.noLocation') : t('weather.locating')} />;
}

// Źródło i wiek pogody jako tekst (stopka kafelka pogody, pasek pogody nad listą), np. „Open-Meteo · 10 min temu”;
// opis w podpowiedzi. Na telefonie ukryty (core/pages/Devices/style.css). Do 2026-10-19 był to dymek ikony „i”.
export function SourceTip({ text, detail }: { text: string; detail?: string }) {
  return <span className="source-text" title={detail}>{text}</span>;
}

function WeatherTileBody({ name, weather, foot, hidden, tools, chip, emptyLabel, temperature: override }: {
  name: string; weather: Weather | null; foot: ReactNode; hidden?: boolean; tools?: ReactNode; chip?: ReactNode; emptyLabel: string;
  /** temperatura spoza pogody (czujnik kotła na kafelku „Dom”) */
  temperature?: number;
}) {
  const { t } = useLang();
  const temperature = override ?? weather?.temperature;
  const facts: Fact[] = weather ? [
    { dt: t('weather.wind'), dd: `${Math.round(weather.windSpeed)} km/h` },
    { dt: t('weather.clouds'), dd: `${Math.round(weather.cloudCover)} %` },
    { dt: t('weather.precip'), dd: weather.snowfall > 0 ? `${number01(weather.snowfall)} cm` : `${number01(weather.precipitation)} mm` },
  ] : [];
  return (
    <>
      <div className="tile-head">
        <span className="tile-icon">{weather ? <WeatherIcon weather={weather} /> : <ListIcon name="sun" />}</span>
        <h2 className="tile-name">{name}</h2>
        {hidden ? <span className="chip chip-off">{t('tile.hidden')}</span> : chip}
        {tools && <span className="tile-tools">{tools}</span>}
      </div>
      <div className="tile-main">
        <div className="tile-value" title={weather ? precipitationText(weather) : undefined}>
          <span className="big">{typeof temperature === 'number' ? number1(temperature) : '---'}</span>
          <span className="unit">°C</span>
          <span className="big-label">{weather ? weatherDescription(weather.code) : emptyLabel}</span>
        </div>
      </div>
      {facts.length > 0 && <Facts facts={facts} />}
      <footer className="tile-foot">{foot}</footer>
    </>
  );
}
