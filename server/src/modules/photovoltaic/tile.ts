// Kafelek fotowoltaiki na stronie /devices (GET /devices/summary): moc teraz, produkcja dziś i liczba
// pracujących paneli. Błąd (czerwony): alarm panelu (alarm_code ≠ 0) albo brak odczytów DTU dłużej niż 5 min
// w ciągu dnia dłużej niż godzinę, czyli sterownik co odłączony (do godziny uwaga, pomarańczowa; dzień to
// 6:00–20:00 w Warszawie, w nocy brak odczytów nie jest błędem, a rano liczy się od 6:00). Ostrzeżenie (pomarańczowy): panel nie działa (offline). Słabsza produkcja panelu (np. zacienienie)
// niczego nie zgłasza.
import { DEFAULT_LANG, Lang, t } from '../../core/i18n';
import { Device, DeviceTile, TileFact } from '../../core/types';
import { formatAge, formatTemperature, formatUnit, offlineLevel } from '../../core/services/tile-format';
import { TIME_ZONE, warsawDayBoundsUTC } from '../../core/time';
import { getCurrentView } from './services/photovoltaic.service';

export const DAY_START_HOUR = 6;
export const DAY_END_HOUR = 20;

const isDaytime = (now: Date) => {
  const hour = Number(now.toLocaleString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hour12: false }));
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
};

// Od kiedy liczy się brak odczytów: nocą DTU milczy, więc rano wiek liczy się od początku dnia (6:00),
// a nie od ostatniego wieczornego odczytu.
const silenceAge = (readAt: Date, now: Date) => {
  const today = now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
  const dayStart = new Date(warsawDayBoundsUTC(today).startUTC.getTime() + DAY_START_HOUR * 3600 * 1000);
  return now.getTime() - Math.max(readAt.getTime(), dayStart.getTime());
};

export async function photovoltaicTile(rootId: string, _device: Device, now = new Date(), lang: Lang = DEFAULT_LANG): Promise<DeviceTile | null> {
  const view = await getCurrentView(rootId, now);
  if (!view.readAt) return { level: 'off', chip: 'Brak danych' };

  const readAt = new Date(view.readAt);
  const panels = view.panels;
  const producing = panels.filter((panel) => panel.state === 'produces');
  const alarmed = panels.filter((panel) => panel.state === 'alarm');
  const offline = panels.filter((panel) => panel.state === 'offline');

  let level: DeviceTile['level'] = 'ok';
  let note: DeviceTile['note'];
  // chip: Online / Offline (jak na wszystkich kafelkach); w nocy brak odczytu to tylko szary „Offline” bez uwagi
  let chip = view.stale ? 'Offline' : 'Online';
  if (view.stale && isDaytime(now)) {
    const silent = silenceAge(readAt, now);
    level = offlineLevel(silent); // do godziny uwaga, potem błąd
    note = { level: 'err', icon: 'offline', text: t(lang, 'tile.noDtu', { age: formatAge(silent, lang) }) };
  } else if (alarmed.length > 0) {
    level = 'err';
    note = { level: 'err', text: alarmed.length === 1 ? t(lang, 'pv.panelAlarm', { key: alarmed[0].key, code: alarmed[0].alarm_code ?? '' }) : t(lang, 'pv.panelsAlarm', { n: alarmed.length }) };
  } else if (offline.length > 0) {
    level = 'warn';
    note = { level: 'warn', text: offline.length === 1 ? t(lang, 'pv.panelOffline', { key: offline[0].key }) : t(lang, 'pv.panelsOffline', { n: offline.length }) };
  }

  const side: TileFact[] = [
    { icon: 'battery', value: formatUnit(typeof view.todayWh === 'number' ? view.todayWh / 1000 : undefined, 'kWh', 1, lang), label: t(lang, 'pv.today') },
  ];
  if (view.panelsAvailable) side.push({ icon: 'panel', value: `${producing.length} / ${panels.length}`, label: t(lang, 'pv.panels') });

  return {
    level,
    chip,
    running: level !== 'err' && (view.power ?? 0) > 0,
    main: { icon: 'sun', value: formatUnit(view.power, 'W', 0, lang), label: t(lang, 'pv.now') },
    side,
    row: typeof view.temperature === 'number' ? [{ icon: 'thermo', value: formatTemperature(view.temperature, lang), label: t(lang, 'pv.inverters') }] : undefined,
    note,
    updatedAt: readAt.toISOString(),
  };
}
