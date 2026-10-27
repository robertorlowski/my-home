// Wspólne elementy stron kotła w wyglądzie „Instrument” (makiety/src/makieta.html, klasy z client/src/makieta.css):
// ikony makiety (kreska 1.8), okno modalne (.modal-layer: nagłówek, treść, stopka), nawigacja po dacie
// (.date-nav: poprzedni / następny dzień i pole daty), przycisk CSV i przełącznik segmentowy (.segmented).
// Komponenty tylko dla client/src/devices/pellet-boiler-pelux200/.
import { ReactNode, useEffect } from 'react';
import { getLang, locale, useLang } from '../../../core/i18n';

type IconName = 'prev' | 'next' | 'download' | 'close' | 'bell' | 'fire' | 'up' | 'down' | 'edit' | 'trash' | 'plus';

const ICON_PATHS: Record<IconName, string> = {
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  close: 'M6 6l12 12M18 6L6 18',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  fire: 'M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-6 1-9z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  edit: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
};

// Ikona makiety: jeden zestaw, kreska 1.8, kolor z currentColor; className domyślnie .ic (22 px).
export const Icon: React.FC<{ name: IconName; className?: string }> = ({ name, className = 'ic' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name]} />
  </svg>
);

// Okrągły przycisk-ikona makiety (.icon-btn.sm; danger = czerwony po najechaniu: usuwanie).
export const IconBtn: React.FC<{
  name: IconName; label: string; onClick?: () => void; disabled?: boolean; danger?: boolean; type?: 'button' | 'submit';
}> = ({ name, label, onClick, disabled, danger, type = 'button' }) => (
  <button type={type} className={`icon-btn sm${danger ? ' danger' : ''}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <Icon name={name} />
  </button>
);

// Okno modalne jak w makiecie: przyciemnienie, nagłówek z zamknięciem, treść i stopka z przyciskami.
// Zamyka Esc i kliknięcie w przyciemnienie. as="form": całe okno jest formularzem (onSubmit).
export const Modal: React.FC<{
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; onSubmit?: (event: React.FormEvent) => void;
  labelledBy?: string; small?: boolean; wide?: boolean;
}> = ({ title, onClose, children, footer, onSubmit, labelledBy = 'boiler-modal-title', small, wide }) => {
  const { t } = useLang();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  const Tag = onSubmit ? 'form' : 'div';
  return (
    <div className="modal-layer">
      <div className="scrim" onClick={onClose} />
      <Tag className={`modal${small ? ' modal-sm' : ''}${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} onSubmit={onSubmit}>
        <header className="modal-head">
          <h2 id={labelledBy}>{title}</h2>
          <IconBtn name="close" label={t('common.close')} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </Tag>
    </div>
  );
};

const DAY_MS = 24 * 3600 * 1000;
const shiftDay = (date: string, days: number) => {
  const next = new Date(`${date}T12:00:00Z`);
  next.setTime(next.getTime() + days * DAY_MS);
  return next.toISOString().slice(0, 10);
};
const formatDay = (date: string) => {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
};

// Nawigacja po dniach (.date-nav): strzałki, data w środku jako pole daty (kliknięcie otwiera kalendarz),
// „dziś” przy dzisiejszej dacie, następny dzień nieaktywny po dzisiejszym. today: YYYY-MM-DD w Warszawie.
export const DateNav: React.FC<{ date: string; today: string; onChange: (date: string) => void }> = ({ date, today, onChange }) => {
  const { t } = useLang();
  return (
  <div className="date-nav">
    <IconBtn name="prev" label={t('common.prevDay')} onClick={() => onChange(shiftDay(date, -1))} />
    <label className="date-cur">
      <span className="date-cur-text">{formatDay(date)}</span>
      {date === today && <small>{t('wx.today')}</small>}
      <input type="date" value={date} max={today} aria-label={t('common.day')}
        onChange={(event) => event.currentTarget.value && onChange(event.currentTarget.value)} />
    </label>
    <IconBtn name="next" label={t('common.nextDay')} disabled={date >= today} onClick={() => onChange(shiftDay(date, 1))} />
  </div>
  );
};

export const CsvButton: React.FC<{ onClick: () => void; disabled?: boolean }> = ({ onClick, disabled }) => (
  <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={onClick}>
    <Icon name="download" className="ic" />CSV
  </button>
);

// Przełącznik segmentowy (.segmented): opcje jako radio; disabled blokuje cały przełącznik.
export function Segmented<T extends string>({ name, value, options, onChange, inline, disabled, label }: {
  name: string; value: T | null; options: { value: T; label: string; disabled?: boolean }[]; onChange: (value: T) => void;
  inline?: boolean; disabled?: boolean; label: string;
}) {
  return (
    <div className={`segmented${inline ? ' seg-inline' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className="seg">
          <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

// Komunikat w karcie: ostrzeżenie (alert-warn) albo błąd (alert-err) z ikoną dzwonka.
export const Alert: React.FC<{ kind: 'warn' | 'err'; title: ReactNode; children?: ReactNode }> = ({ kind, title, children }) => (
  <div className={`alert alert-${kind}`} role="alert">
    <Icon name="bell" />
    <div><strong>{title}</strong>{children && <span>{children}</span>}</div>
  </div>
);

// Godzina HH:MM w Warszawie.
export const hourMinute = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(locale(getLang()), { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }) : '';
