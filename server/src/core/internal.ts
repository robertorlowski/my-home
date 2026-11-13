// Wywołania serwera do własnego API (moduł kotła → pompa ciepła: GET /hp, POST /operation/set, PUT /hp/cwu-loading,
// /device/properties): nagłówek z losowym tokenem procesu zwalnia je z logowania (core/middleware/session.ts).
// Od 2026-11-13 tak samo polecenie --api na serwerze (core/cli.ts), które zastępuje skrypty logujące się hasłem
// systemowym (np. wgrywanie firmware): serwer po starcie zapisuje token do pliku w katalogu tymczasowym (w kontenerze
// /tmp, tmpfs, prawa tylko dla użytkownika procesu), a polecenie uruchomione obok (docker exec) go czyta. Token zmienia
// się przy każdym starcie serwera i nie wychodzi poza komputer (żądania idą na 127.0.0.1).
import crypto from 'crypto';
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
export const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
export const internalHeaders = (): Record<string, string> => ({ [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN });

/** adres własnego API (moduły kotła mają tę samą zasadę: INTERNAL_API_URL albo 127.0.0.1:PORT) */
export const internalApiUrl = () => process.env.INTERNAL_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}/api`;

/** plik z tokenem serwera słuchającego na porcie port (osobny dla każdego portu, gdy na komputerze działa kilka serwerów) */
export const internalTokenFile = (port: string | number = process.env.PORT ?? 3001) =>
  path.join(os.tmpdir(), `my-home-internal-${port}.token`);

/** server.ts po starcie nasłuchu; błąd zapisu nie zatrzymuje serwera (polecenie --api wtedy nie działa) */
export function saveInternalToken(port: string | number): void {
  const file = internalTokenFile(port);
  try {
    writeFileSync(file, INTERNAL_TOKEN, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[wewnętrzne] nie udało się zapisać ${file} (polecenie --api nie zadziała):`, error);
  }
}

/** token działającego serwera albo null, gdy na tym komputerze (w tym kontenerze) serwer go nie zapisał */
export function readInternalToken(port: string | number = process.env.PORT ?? 3001): string | null {
  try {
    return readFileSync(internalTokenFile(port), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
