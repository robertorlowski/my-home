// Stan cyklu Zimy w trybie pompy ciepła (serwer: pellet-boiler-pelux200-winter-cycle.service.ts), w Ustawieniach
// przy przełączniku Lato / Zima i w Harmonogramie (akapit pomocniczy .help). Tylko faza oczekiwania (kocioł
// wychłodzony, na Lecie, czeka na nagrzanie przez pompę ciepła); na Zimie nic (decyzja użytkownika 2026-10-27).
import { PelletBoilerWinterCycle } from '../types';
import { formatDateTime, formatNumber } from '../utils/boiler';
import { useLang } from '../../../core/i18n';

export function WinterCycleStatus({ cycle }: { cycle?: PelletBoilerWinterCycle | null }) {
  const { t, locale } = useLang();
  if (!cycle || cycle.phase !== 'waiting') return null;
  const time = (value?: string | null) => (value ? new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '');
  const temperature = cycle.temperature === null ? t('pb.wc.noFresh') : t('pb.wc.now', { value: formatNumber(cycle.temperature) });
  const pump = typeof cycle.pumpTemperature === 'number' ? t('pb.wc.pump', { value: formatNumber(cycle.pumpTemperature) }) : '';
  return (
    <p className="help boiler-winter-cycle">
      {t('pb.wc.waiting', { from: formatNumber(cycle.winterFrom ?? 45), temperature, pump, since: formatDateTime(cycle.since) })}
      {cycle.forcedAt ? t('pb.wc.forced', { time: time(cycle.forcedAt) }) : ''}.
    </p>
  );
}
