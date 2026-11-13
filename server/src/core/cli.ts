// Polecenia na serwerze (od 2026-11-13), uruchamiane tym samym plikiem co serwer, bez logowania i bez hasła. Na vm-prod
// w kontenerze (katalog roboczy /app/server, zmienne środowiska kontenera):
//   docker exec my-home-prod node dist/server.js --kod-awaryjny
//   docker exec -i my-home-prod node dist/server.js --api PUT '/firmware/switch/1.3.8?description=Opis' --bin < switch-1.3.8.bin
// Lokalnie po npm run build -w server: node dist/server.js … w katalogu server/ (MONGODB_URI i PORT ze środowiska
// albo z server/.env).
//
// --kod-awaryjny: jednorazowy kod konta system ważny 5 minut, wypisany w terminalu, bez poczty (plan „Gdy poczta nie
//   działa”); zdejmuje blokadę po błędnych kodach i limit kodów na godzinę (auth.service.ts issueEmergencySystemCode).
//   Łączy się tylko z bazą (MONGODB_URI), więc działa też przy zatrzymanym serwerze. Na ekranie logowania: „system”
//   w polu e-mail i „Mam już kod”.
// --kod-totp KLUCZ: bieżący kod z aplikacji na telefonie dla klucza (base32, jak pod kodem QR przy rejestracji), bez
//   bazy i bez telefonu; do sprawdzania logowania kodem z telefonu na środowisku testowym.
// --api METODA ŚCIEŻKA [JSON] [--bin]: żądanie do serwera działającego obok (INTERNAL_API_URL albo 127.0.0.1:PORT)
//   z jego wewnętrznym tokenem (core/internal.ts), czyli bez konta i hasła; zastępuje skrypty, które logowały się hasłem
//   systemowym (wgrywanie firmware). JSON = treść application/json, --bin = treść ze standardowego wejścia jako
//   application/octet-stream (plik .bin). W dzienniku operacji sterownika: „system”, źródło „Polecenie na serwerze”.
//   Odpowiedź serwera na standardowe wyjście, status HTTP na standardowe wyjście błędów; kod wyjścia 0 tylko przy 2xx.
// --qnap stan|restart_sieci|restart [ROOT_ID]: polecenie dla QNAP-a przez sterownik co (od 2026-11-13, próbnie;
//   services/qnap.service.ts), np. docker exec my-home-prod node dist/server.js --qnap restart_sieci
//   Żądanie do serwera działającego obok (jak --api, token wewnętrzny), bo tylko on ma połączenie WebSocket ze
//   sterownikiem; czeka na wynik do QNAP_CZEKAJ_MS. Wynik (status HTTP QNAP-a i jego odpowiedź) na standardowe
//   wyjście, kod wyjścia 0 tylko przy statusie 200.
import mongoose from 'mongoose';
import { INTERNAL_TOKEN_HEADER, internalApiUrl, internalTokenFile, readInternalToken } from './internal';
import { issueEmergencySystemCode, SYSTEM_CODE_TTL_MS } from './services/auth.service';
import { QNAP_POLECENIA } from './services/qnap.service';
import { formatCode, until } from './services/mail.service';
import { operationHeaders, systemMeta } from './services/operation-log.service';
import { base32Decode, TOTP_STEP_S, totpCode } from './services/totp.service';

export type CliOptions = {
  /** treść dla --bin (testy); domyślnie standardowe wejście */
  stdin?: AsyncIterable<Buffer | string>;
  print?: (text: string) => void;
  printError?: (text: string) => void;
};

const COMMANDS = ['--kod-awaryjny', '--kod-totp', '--api', '--qnap'];
export const isCliCommand = (args: string[]) => args.some((arg) => COMMANDS.includes(arg));

const USAGE = [
  'Polecenia (na serwerze, obok działającego serwera, np. docker exec my-home-prod node dist/server.js …):',
  '  --kod-awaryjny                                   kod konta system w terminalu (5 min), zdejmuje blokadę',
  '  --kod-totp KLUCZ                                 bieżący kod z aplikacji na telefonie dla klucza base32 (testy)',
  "  --api GET|POST|PUT|DELETE /ścieżka ['{json}']    żądanie do API serwera bez logowania",
  '  --api PUT /firmware/<rodzaj>/<wersja> --bin < plik.bin',
  `  --qnap ${QNAP_POLECENIA.join('|')} [ROOT_ID]       polecenie dla QNAP-a przez sterownik co (czeka do 20 s)`,
].join('\n');

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const print = options.print ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const printError = options.printError ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  if (args.includes('--kod-awaryjny')) return emergencyCode(print, printError);
  const totp = args.indexOf('--kod-totp');
  if (totp >= 0) return phoneCode(args[totp + 1] ?? '', print, printError);
  const at = args.indexOf('--api');
  if (at >= 0) return apiCall(args.slice(at + 1), options, print, printError);
  const qnap = args.indexOf('--qnap');
  if (qnap >= 0) return qnapCall(args.slice(qnap + 1), print, printError);
  printError(USAGE);
  return 2;
}

async function emergencyCode(print: (text: string) => void, printError: (text: string) => void): Promise<number> {
  // testy: połączenie już otwarte; polecenie na serwerze łączy się samo i rozłącza na końcu
  const connected = mongoose.connection.readyState === 1;
  if (!connected) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      printError('Brak MONGODB_URI: uruchom polecenie tam, gdzie działa serwer (np. docker exec my-home-prod node dist/server.js --kod-awaryjny).');
      return 1;
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  }
  try {
    const { code, expiresAt } = await issueEmergencySystemCode();
    print(`Kod awaryjny konta system: ${formatCode(code)}`);
    print(`Ważny do ${until(expiresAt, 'pl')} (${Math.round(SYSTEM_CODE_TTL_MS / 60_000)} minut), działa raz. Blokada po błędnych kodach i limit kodów zdjęte.`);
    print('Logowanie: „system” w polu e-mail, potem „Mam już kod” (nie „Wyślij kod”: nowy kod zastąpiłby ten).');
    return 0;
  } finally {
    if (!connected) await mongoose.disconnect();
  }
}

function phoneCode(key: string, print: (text: string) => void, printError: (text: string) => void): number {
  let secret: Buffer;
  try {
    secret = base32Decode(key);
  } catch {
    secret = Buffer.alloc(0);
  }
  if (secret.length < 10) {
    printError('--kod-totp KLUCZ: klucz base32 spod kodu QR (rejestracja telefonu), np. --kod-totp JBSW Y3DP EHPK 3PXP');
    return 2;
  }
  const now = Date.now();
  const left = TOTP_STEP_S - Math.floor(now / 1000) % TOTP_STEP_S;
  print(`Kod z aplikacji: ${formatCode(totpCode(secret, now))} (jeszcze ${left} s), następny: ${formatCode(totpCode(secret, now + TOTP_STEP_S * 1000))}`);
  return 0;
}

// --qnap: POST /qnap/polecenia na serwerze działającym obok; serwer wysyła polecenie przez WebSocket sterownika co
async function qnapCall(args: string[], print: (text: string) => void, printError: (text: string) => void): Promise<number> {
  const [polecenie, rootId] = args;
  if (!polecenie || !(QNAP_POLECENIA as readonly string[]).includes(polecenie)) {
    printError(USAGE);
    return 2;
  }
  const token = readInternalToken();
  if (!token) {
    printError(`Brak ${internalTokenFile()}: serwer nie działa na tym komputerze (w tym kontenerze) albo nie zapisał klucza.`);
    return 1;
  }
  let response: Response;
  try {
    response = await fetch(`${internalApiUrl()}/qnap/polecenia`, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: token, 'Content-Type': 'application/json', ...operationHeaders(systemMeta('Polecenie na serwerze (--qnap)')) },
      body: JSON.stringify({ polecenie, ...(rootId ? { rootId } : {}) }),
    });
  } catch (error) {
    printError(`Serwer nie odpowiada (${internalApiUrl()}): ${String(error)}`);
    return 1;
  }
  const text = await response.text();
  if (text) print(text);
  printError(`HTTP ${response.status}`);
  if (!response.ok) return 1;
  try {
    return (JSON.parse(text) as { status?: number }).status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}

async function readAll(stdin: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function apiCall(args: string[], options: CliOptions, print: (text: string) => void, printError: (text: string) => void): Promise<number> {
  const [methodArg, pathArg, ...rest] = args;
  const method = (methodArg ?? '').toUpperCase();
  if (!METHODS.has(method) || !pathArg?.startsWith('/')) {
    printError(USAGE);
    return 2;
  }
  // ścieżka względem /api; „/api/…” też przechodzi
  const path = pathArg.replace(/^\/api(?=\/)/, '');
  const bin = rest.includes('--bin');
  const json = rest.find((arg) => arg !== '--bin');
  const token = readInternalToken();
  if (!token) {
    printError(`Brak ${internalTokenFile()}: serwer nie działa na tym komputerze (w tym kontenerze) albo nie zapisał klucza.`);
    return 1;
  }
  const headers: Record<string, string> = { [INTERNAL_TOKEN_HEADER]: token, ...operationHeaders(systemMeta('Polecenie na serwerze')) };
  let body: ArrayBuffer | string | undefined;
  if (bin) {
    const stdin = options.stdin ?? process.stdin;
    if (stdin === process.stdin && process.stdin.isTTY) {
      printError('--bin: plik podaje się na standardowe wejście, np. docker exec -i my-home-prod node dist/server.js --api PUT … --bin < plik.bin');
      return 2;
    }
    const data = await readAll(stdin);
    body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (json !== undefined) {
    try {
      JSON.parse(json);
    } catch {
      printError('Treść żądania nie jest poprawnym JSON-em.');
      return 2;
    }
    body = json;
    headers['Content-Type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(`${internalApiUrl()}${path}`, { method, headers, body });
  } catch (error) {
    printError(`Serwer nie odpowiada (${internalApiUrl()}): ${String(error)}`);
    return 1;
  }
  const text = await response.text();
  if (text) print(text);
  printError(`HTTP ${response.status}`);
  return response.ok ? 0 : 1;
}
