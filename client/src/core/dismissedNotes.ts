// Paski błędów zamknięte krzyżykiem na kafelku (DeviceTileCard), pamiętane w tej przeglądarce osobno dla sterownika.
// Klucz to note.id z serwera: stały dla jednego zdarzenia, choć tekst się zmienia. Zdarzenia z czasem (błąd pompy, brak
// odpowiedzi od danej chwili) dostają nowe id, więc następne pokaże się samo. Stany bez czasu (alarm kotła tego samego kodu,
// niski poziom paliwa) mają stałe id: po NOTE_FORGET_MS od ostatniego wystąpienia zamknięcie wygasa.
const KEY = 'chpc.dismissedNotes';
const NOTE_FORGET_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_REFRESH_MS = 60 * 60 * 1000;

type Dismissed = Record<string, Record<string, number>>;

const read = (): Dismissed => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};
const write = (value: Dismissed) => {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* bez pamięci: pasek wróci po odświeżeniu */ }
};

// Pasek nadal zamknięty; przy okazji odświeża czas ostatniego wystąpienia.
export function isNoteDismissed(rootId: string, noteId: string, now = Date.now()) {
  const all = read();
  const seenAt = all[rootId]?.[noteId];
  if (seenAt === undefined) return false;
  if (now - seenAt > NOTE_FORGET_MS) {
    delete all[rootId][noteId];
    write(all);
    return false;
  }
  if (now - seenAt > SEEN_REFRESH_MS) {
    all[rootId][noteId] = now;
    write(all);
  }
  return true;
}

export function dismissNote(rootId: string, noteId: string, now = Date.now()) {
  const all = read();
  all[rootId] = { ...all[rootId], [noteId]: now };
  write(all);
}
