// Ikona kotła pelletowego: płomień (menu, kafelek, palenie).
// Kolor bierze się z `currentColor`, więc o stanie (np. palenie) decyduje CSS.

// dwa języki płomienia, żeby ikona nie przypominała kropli hydroforu
export const FLAME_PATH = 'M12 2C12 2 9.5 5.5 9.5 8.5C9.5 10 10.3 11 10.3 11C9.4 10.6 8.3 9.6 8 8C6.2 9.8 5 12.2 5 14.5C5 18.4 8 21.5 12 21.5C16 21.5 19 18.4 19 14.5C19 10.5 15.5 8 14.5 5.5C13.9 6.6 13.6 7.7 13.6 8.6C12.7 7 12 4.5 12 2Z';

export const FlameIcon: React.FC<{ className?: string; filled?: boolean }> = ({ className, filled }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d={FLAME_PATH} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      fill={filled ? 'currentColor' : 'none'} />
  </svg>
);
