// Czerwony pasek „Offline od …” na górze ekranu sterownika (pompa, piec, fotowoltaika, włącznik; hydrofor go nie ma,
// bo ma zasilanie tylko w czasie pracy pompy) w wyglądzie „Instrument”: <div class="banner banner-off"> z ikoną,
// tytułem i opisem (CSS w makieta.css). since: czas ostatnich danych od sterownika; bez niego samo „Offline”.
// detail: przyczyna w drugiej linii („brak łączności ze sterownikiem.”).
import { ReactNode } from 'react';
import { useLang } from '../i18n';
import { ageLabel } from '../i18n/format';

// ikona używana też w linii „nie odpowiada od…” na kafelku listy (DeviceTileCard WarnLine)
export const OfflineIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 15.5a6 6 0 0 1 7 0M12 19h.01M3 3l18 18" />
  </svg>
);

export function OfflineBanner({ since, now = Date.now(), detail }: { since?: string | number | Date; now?: number; detail?: ReactNode }) {
  const { t } = useLang();
  const at = since === undefined ? NaN : new Date(since).getTime();
  return (
    <div className="banner banner-off" role="alert">
      <OfflineIcon />
      <div>
        <strong>{Number.isNaN(at) ? t('chip.offline') : t('offline.since', { age: ageLabel(Math.max(0, now - at)) })}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
    </div>
  );
}
