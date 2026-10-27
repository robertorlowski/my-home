// Kafelek pompy ciepła na stronie /devices (GET /devices/summary): stan sprężarki, temperatura zbiornika,
// zakres temperatur, moc, temperatury sprężarki i wody wyjściowej oraz tryb pracy dla nagłówka.
// Błąd (czerwony): blokada po 5 błędach, aktywny błąd albo brak
// telemetrii dłużej niż godzinę (od 5 min do godziny to uwaga, pomarańczowa; co wysyła co 10–30 s, a po utracie
// odpowiedzi CHPC przestaje wysyłać pole HP, więc telemetria przestaje być zapisywana). Ostrzeżenie (pomarańczowy): błąd z ostatnich 24 h,
// który już ustąpił.
import { DEFAULT_LANG, Lang, t } from '../../core/i18n';
import { Device, DeviceTile } from '../../core/types';
import {
  formatAge, formatNumber, formatTemperature, formatUnit, formatWhen, offlineLevel, toNumber,
} from '../../core/services/tile-format';
import { errorDescription } from './error-codes';
import { ERROR_LOCK_LIMIT, getHpContactAt, getHpLastData, getHpLastError } from './services/hp.service';
import { HpEntry } from './types';
import { pumpTemperatures } from './services/pump-mode.service';

export const OFFLINE_AFTER_MS = 5 * 60 * 1000;

// jak „Tryb pracy” w widoku głównym pompy (co od 1.2.0: MANUAL / AUTO / OFF; starsze: M, A, PV, CWU)
export function modeLabel(workMode?: string, lang: Lang = DEFAULT_LANG): string {
  switch (workMode) {
    case 'OFF': return 'OFF';
    case 'A': case 'AUTO': return t(lang, 'hp.mode.auto');
    case 'PV': return t(lang, 'hp.mode.autoPv');
    case 'CWU': return t(lang, 'boiler.cwu');
    case 'M': case 'MANUAL': return t(lang, 'hp.mode.manual');
    default: return '---';
  }
}

export async function heatPumpTile(rootId: string, device: Device, now = new Date(), lang: Lang = DEFAULT_LANG): Promise<DeviceTile | null> {
  const last = await getHpLastData(rootId) as HpEntry & { createdAt?: Date };
  if (!last?.createdAt) return { level: 'off', chip: 'Brak danych' };

  const hp = last.HP ?? {};
  const at = new Date(last.createdAt);
  const age = now.getTime() - at.getTime();
  const running = Number(hp.HPS ?? 0) > 0;
  const errorCount = Number(hp.ERRc ?? 0);
  const locked = errorCount >= ERROR_LOCK_LIMIT;
  const error = await getHpLastError(rootId, now) as { error_code?: number; createdAt?: Date };
  const code = error.error_code ?? Number(hp.ERR ?? 0);

  let level: DeviceTile['level'] = 'ok';
  let note: DeviceTile['note'];
  // chip: Online / Offline (jak na wszystkich kafelkach); praca sprężarki = niebieski chip (running)
  let chip = 'Online';
  if (age > OFFLINE_AFTER_MS) {
    level = offlineLevel(age); // do godziny uwaga, potem błąd
    chip = 'Offline';
    // czerwona linia jak pasek „Offline od…” na ekranie pompy: gdy co dalej się zgłasza (ostatni POST /hp/add
    // w ciągu 5 min), nie odpowiada sama pompa (CHPC); inaczej brak łączności ze sterownikiem
    const contact = getHpContactAt(rootId);
    const chpcOnly = !!contact && now.getTime() - contact.getTime() <= OFFLINE_AFTER_MS;
    note = { level: 'err', icon: 'offline', text: t(lang, chpcOnly ? 'tile.chpcNotResponding' : 'tile.notResponding', { age: formatAge(age, lang) }) };
  } else if (locked) {
    level = 'err';
    note = { level: 'err', text: `${t(lang, 'hp.locked', { n: ERROR_LOCK_LIMIT })}${code ? t(lang, 'hp.lockedLast', { code, text: errorDescription(code) }) : ''}` };
  } else if (errorCount > 0 && code) {
    level = 'err';
    note = { level: 'err', text: t(lang, 'hp.error', { code, text: errorDescription(code) }) };
  } else if (error.error_code && error.createdAt) {
    level = 'warn';
    note = { level: 'warn', text: t(lang, 'hp.errorPast', { code: error.error_code, text: errorDescription(error.error_code), when: formatWhen(new Date(error.createdAt), now, lang) }) };
  }

  const side = [];
  // bez łączności stare wartości z pompy nie są pokazywane: zbiornik „---”, brak zakresu temperatur i mocy
  const live = !(age > OFFLINE_AFTER_MS);
  // pamięć podręczna trzyma surową telemetrię (liczby jako napisy), baza liczby: oba warianty przez toNumber
  const tmin = toNumber(hp.Tmin);
  const tmax = toNumber(hp.Tmax);
  if (live && tmin !== undefined && tmax !== undefined) {
    side.push({ icon: 'target' as const, value: `${formatNumber(tmin, 1, lang)}–${formatNumber(tmax, 1, lang)} °C`, label: t(lang, 'hp.minMax') });
  } else if (!live) {
    // bez łączności zakres od–do z ustawień (to, co serwer każe pompie utrzymywać), a nie ze starej telemetrii
    const set = pumpTemperatures(device?.properties ?? {}, device?.pumpConfig?.connection ?? 'cwu', last);
    const min = toNumber(set.min);
    const max = toNumber(set.max);
    if (min !== undefined && max !== undefined) side.push({ icon: 'target' as const, value: `${formatNumber(min, 0, lang)}–${formatNumber(max, 0, lang)} °C`, label: t(lang, 'hp.fromTo') });
  }
  const watts = toNumber(hp.Watts);
  // moc, którą pompa pobiera teraz (w postoju zwykle kilka W); bez łączności „---”
  side.push({ icon: 'bolt' as const, value: live && watts !== undefined ? formatUnit(watts, 'W', 0, lang) : '---', label: t(lang, 'hp.power') });
  side.push({ icon: 'thermo' as const, value: live ? formatTemperature(toNumber(hp.Tsump), lang) : '---', label: t(lang, 'hp.tCompressor') });
  side.push({ icon: 'thermo' as const, value: live ? formatTemperature(toNumber(hp.Tho), lang) : '---', label: t(lang, 'hp.tOut') });

  // ON = tryb inny niż OFF (work_mode z telemetrii, czyli tryb, który sterownik stosuje) i zgoda na start sprężarki
  // na pompie (HP.CO; 0 = CO wyłączone na samym CHPC); bez pola CO liczy się sam tryb
  const co = toNumber(hp.CO);
  const power: DeviceTile['power'] = last.work_mode && last.work_mode !== 'OFF' && co !== 0 ? 'on' : 'off';
  return {
    level,
    chip,
    power,
    running: running && level !== 'err',
    main: { icon: 'thermo', value: live ? formatTemperature(toNumber(hp.Ttarget), lang) : '---', label: t(lang, 'hp.tank') },
    side,
    row: [{ icon: 'sliders', value: modeLabel(last.work_mode as string | undefined, lang), label: '' }],
    note,
    updatedAt: at.toISOString(),
  };
}
