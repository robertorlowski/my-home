// Przyczyny startu sterowników ESP32 jako tekst do dziennika operacji. Kody wysyła firmware w polu diag:
// włącznik (switch.cpp, resetReasonName, od 1.1.2; POST /switch/state) i piec (pellet.cpp, resetReasonName, od 1.11.2;
// zgłoszenie POST /devices/register). W core, bo moduły nie importują z siebie nawzajem (do 2026-11-21 lista była
// w modules/switch/services/switch-diagnostics.service.ts).

// nazwy jak esp_reset_reason w firmware, potem restarty programowe z zapisaną przyczyną
const RESET_NAMES: Record<string, string> = {
  power_on: 'włączenie zasilania',
  ext: 'reset z pinu EN (zewnętrzny)',
  software: 'restart programowy (np. po aktualizacji)',
  panic: 'błąd programu (panic)',
  int_wdt: 'watchdog przerwań',
  task_wdt: 'watchdog zadań',
  wdt: 'watchdog',
  deepsleep: 'wybudzenie z uśpienia',
  brownout: 'spadek napięcia zasilania (brownout)',
  sdio: 'reset SDIO',
  no_cloud: 'restart po braku łączności z serwerem (sterownik, od 1.3.7)',
  // sterownik pieca (od 1.11.2): przyczyna restartu programowego zapisana w NVS przed restartem
  no_wifi: 'restart po 30 min bez Wi-Fi (sterownik)',
  ota: 'aktualizacja firmware z aplikacji',
  install: 'wgranie firmware przez stronę sterownika',
  unknown: 'nieznana',
};

export const resetReasonText = (reset: string) => RESET_NAMES[reset] ?? reset;

// Kod przyczyny w zgłoszeniu: małe litery i podkreślenia, najwyżej 20 znaków.
export const isResetCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z_]{1,20}$/.test(value);
