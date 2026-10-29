// Kafelek hydroforu na stronie /devices (GET /devices/summary): chip Online (sterownik zgłasza się, czyli pompa pracuje)
// albo Offline (zwykły stan: sterownik ma zasilanie tylko przy pracy pompy; od 2026-10-13 zamiast „Pompa pracuje …” /
// „Nie pracuje”, czas pracy w stopce), woda, czas pompy i
// liczba uruchomień z dzisiejszego dnia oraz woda z całego bieżącego miesiąca (dziś / miesiąc). Błąd (czerwony): pompa pracuje bez przerwy dłużej niż 30 min
// (wyciek albo praca na sucho). Ostrzeżenie (pomarańczowy): brak przepływu (za mało odczytów wodomierza)
// albo dzisiejsze uruchomienie z czasem przybliżonym (z kolejki po braku sieci). Brak łączności NIE jest
// błędem: sterownik ma zasilanie tylko w czasie pracy pompy, więc zwykle milczy.
import { DEFAULT_LANG, Lang, t } from '../../core/i18n';
import { Device, DeviceTile } from '../../core/types';
import { formatDuration, formatUnit } from '../../core/services/tile-format';
import { warsawDayBoundsUTC } from '../../core/time';
import {
  RUN_IN_PROGRESS_MS, getTankTileData, litersFor, pumpSeconds,
} from './services/water-pressure-tank.service';

export const LONG_RUN_MS = 30 * 60 * 1000;

export async function waterPressureTankTile(rootId: string, _device: Device, now = new Date(), lang: Lang = DEFAULT_LANG): Promise<DeviceTile | null> {
  const todayDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  const today = warsawDayBoundsUTC(todayDate);
  const monthStart = warsawDayBoundsUTC(`${todayDate.slice(0, 8)}01`).startUTC;
  // z pamięci do nowej wiadomości sterownika, zmiany wodomierza albo nowego dnia (getTankTileData)
  const { last, monthRuns, flow, litersPerSecond } = await getTankTileData(rootId, todayDate, monthStart, today.endUTC);
  const runs = monthRuns.filter((run) => new Date(run.pumpStart) >= today.startUTC);
  if (!last) return { level: 'off', chip: 'Brak uruchomień' };

  const running = now.getTime() - new Date(last.lastSeenAt ?? last.pumpEnd).getTime() < RUN_IN_PROGRESS_MS;
  const runningMs = now.getTime() - new Date(last.pumpStart).getTime();
  const seconds = runs.reduce((total, run) => total + pumpSeconds(run), 0);
  const liters = litersFor(seconds, litersPerSecond);
  const monthLiters = litersFor(monthRuns.reduce((total, run) => total + pumpSeconds(run), 0), litersPerSecond);

  let level: DeviceTile['level'] = 'ok';
  let note: DeviceTile['note'];
  if (running && runningMs > LONG_RUN_MS) {
    level = 'err';
    note = { level: 'err', text: t(lang, 'tank.longRun') };
  } else if (flow.litersPerMinute === null) {
    level = 'warn';
    note = { level: 'warn', text: t(lang, 'tank.noFlow') };
  } else if (runs.some((run) => run.timeApproximate)) {
    level = 'warn';
    note = { level: 'warn', text: t(lang, 'tank.approximate') };
  }

  return {
    level,
    chip: running ? 'Online' : 'Offline',
    // ON = pompa pracuje (sterownik ma zasilanie tylko wtedy), OFF = postój
    power: running ? 'on' : 'off',
    running: running && level !== 'err',
    main: { icon: 'drop', value: liters === null ? '---' : formatUnit(liters, 'l', 0, lang), label: t(lang, 'tank.today') },
    main2: { icon: 'drop', value: monthLiters === null ? '---' : formatUnit(monthLiters, 'l', 0, lang), label: t(lang, 'tank.month') },
    // dwie liczby obok siebie (dziś / miesiąc) zajmują prawie całą szerokość kafelka, więc czas pompy i
    // uruchomienia idą do osobnego wiersza pod nimi (pierwsza wartość po lewej, ostatnia po prawej)
    row: [
      { icon: 'timer', value: formatDuration(seconds), label: t(lang, 'tank.pump') },
      { icon: 'repeat', value: String(runs.length), label: t(lang, 'tank.runs') },
      ...(running && last.compressorRunning ? [{ icon: 'bubbles' as const, value: t(lang, 'tank.on'), label: t(lang, 'tank.compressor') }] : []),
    ],
    note,
    // praca pompy: since = start bieżącego uruchomienia (klient liczy czas „pompa pracuje …”); postój: lastRunAt —
    // klient pisze „ostatnie uruchomienie dziś 14:32” w swoim języku (do 2026-10-21 gotowy tekst w foot)
    ...(running ? { since: new Date(last.pumpStart).toISOString() } : { lastRunAt: new Date(last.pumpStart).toISOString() }),
    // ostatnie zgłoszenie sterownika: klient pisze pod „ostatnie uruchomienie” także „dane sprzed …”
    updatedAt: new Date(last.lastSeenAt ?? last.pumpEnd).toISOString(),
  };
}
