// Kody błędów sterownika CHPC (HP.ERR, error_code). Źródło: ERRC_* w devices/chpc/src/CHPC_firmware.ino.
// Zmiana kodu wymaga zmiany w obu miejscach. Używane w widoku głównym (dzwonek), Danych (czerwony
// wiersz) i Ustawieniach (błąd, licznik, Odblokuj). Blokada: HP.ERRc ≥ 5, zdejmuje ją akcja error_reset.
export const ERROR_LOCK_LIMIT = 5;

import { getLang, Lang, translate } from '../../../core/i18n';

const ERROR_DESCRIPTIONS_EN: Record<number, string> = {
  1: 'Temperature sensor error',
  2: 'Overload: power above the limit',
  3: 'No flow',
  4: 'Compressor not running: power too low after start',
  5: 'Hot side overheating (Tho)',
  6: 'Compressor overheating (Tsump)',
  7: 'Discharge overheating (Tbc)',
  8: 'Freezing after the evaporator (Tae)',
  9: 'Cold side freezing (Tco)',
  10: 'Damaged (stuck) compressor relay',
  11: 'Maximum number of errors exceeded: control locked',
  12: 'Compressor temperature too low (Tsump)',
  13: 'Evaporator freezing (Tbe below -1 °C for over 60 s)',
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  1: 'Błąd czujnika temperatury',
  2: 'Przeciążenie: moc powyżej limitu',
  3: 'Brak przepływu',
  4: 'Sprężarka nie pracuje: za mała moc po starcie',
  5: 'Przegrzanie obiegu gorącego (Tho)',
  6: 'Przegrzanie sprężarki (Tsump)',
  7: 'Przegrzanie tłoczenia (Tbc)',
  8: 'Zamarzanie za parownikiem (Tae)',
  9: 'Zamarzanie obiegu zimnego (Tco)',
  10: 'Uszkodzony (sklejony) przekaźnik sprężarki',
  11: 'Przekroczono maksymalną liczbę błędów: sterowanie zablokowane',
  12: 'Za niska temperatura sprężarki (Tsump)',
  13: 'Zamarzanie parownika (Tbe poniżej -1 °C dłużej niż 60 s)',
};

export const errorDescription = (code?: number | null, lang: Lang = getLang()) =>
  code ? (lang === 'en' ? ERROR_DESCRIPTIONS_EN[code] : ERROR_DESCRIPTIONS[code]) ?? translate(lang, 'hp.unknownError', { code }) : '';

export const isLocked = (errorCount?: number | null) => (errorCount ?? 0) >= ERROR_LOCK_LIMIT;
