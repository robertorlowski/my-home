// Magazyn pamięci dokumentów urządzeń (device-cache.service.ts), osobno i bez importów, bo kasuje go model
// (core/models/device.model.ts, haczyki przy każdym zapisie), a serwis pamięci importuje model.
export type CacheEntry<T> = { at: number; doc: T | null };

export const byRoot = new Map<string, CacheEntry<unknown>>();
export const bySn = new Map<string, CacheEntry<unknown>>();
let generation = 0;

export const cacheGeneration = () => generation;

// każdy zapis do kolekcji devices kasuje całą pamięć: zapisy są rzadkie (zgłoszenie po starcie, ustawienia z
// aplikacji), a jedno pominięte urządzenie dawałoby nieaktualne ustawienia sterownikowi
export function forgetDevices() {
  byRoot.clear();
  bySn.clear();
  generation++;
}
