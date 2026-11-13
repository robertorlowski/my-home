// Klient i serwer my-home na tej stacji, baza testowa hpdb_test na vm-prod (Oracle) przez tunel SSH.
// Opis: CLAUDE.md, „Test lokalny na bazie testowej z vm-prod”. Produkcji (baza hpdb, my-home-prod) nie dotyka.
// Do 12.11.2026 skrypt leżał w repozytorium oracle-cloud jako test-lokalny.mjs.
//
//   npm run local:oracle                uruchamia tunel, serwer (4001) i klienta (5173); Ctrl+C zatrzymuje wszystko
//   npm run local:oracle -- --odswiez   najpierw pobiera ustawienia z vm-prod na nowo
//
// Potrzebne: działające `ssh vm-prod` (klucz w ~/.ssh/config) i npm install w tym repozytorium.
//
// Dlaczego to działa:
//   przeglądarka → klient Vite :5173 → serwer Node :4001 → tunel SSH :27117 → vm-prod: MongoDB 127.0.0.1:27017
// - MongoDB na serwerze słucha tylko na 127.0.0.1, więc z internetu nie jest osiągalna. Tunel SSH przenosi ten port
//   na stację: dla serwera Node baza wygląda jak lokalna, a ruch idzie zaszyfrowany przez SSH.
// - Baza nie wie, że łączysz się ze stacji: widzi połączenie z 127.0.0.1 i sprawdza tylko użytkownika i hasło.
// - Klient w trybie deweloperskim (Vite) sam szuka serwera na porcie 4001 (client/src/core/http.ts), dlatego
//   serwer musi działać na 4001 i klient nie potrzebuje żadnych ustawień.
// - Użytkownik myhome_test ma dostęp tylko do hpdb_test, więc nawet pomyłka w kodzie nie zmieni danych produkcji.

// Plik .mjs to moduł ES: stąd import zamiast require i await poza funkcją (niżej, przy starcie tunelu).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ścieżki liczone od położenia skryptu (scripts/), nie od bieżącego katalogu, więc skrypt działa uruchomiony z dowolnego miejsca.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
// Poza repozytoriami, bo plik zawiera hasła: nie trafi przypadkiem do gita.
const SETTINGS = join(homedir(), '.my-home', 'test-oracle.env');
// Port na stacji. Inny niż 27017 (ewentualna lokalna baza) i 27027 (baza z npm run local), żeby nie kolidował.
const TUNNEL_PORT = '27117';

// Pobiera ustawienia środowiska testowego z serwera. execFileSync czeka na koniec polecenia i zwraca jego wynik;
// nic nie jest wypisywane na ekran. Działa bez hasła, bo `ssh vm-prod` używa klucza z ~/.ssh/config, a konto na
// serwerze może wykonać sudo bez hasła. Hasła zostają w pliku w katalogu domowym; nie wypisywać ich na ekran.
function downloadSettings() {
  const text = execFileSync('ssh', ['vm-prod', 'sudo cat /etc/apps/my-home-test.env'], { encoding: 'utf8' });
  mkdirSync(dirname(SETTINGS), { recursive: true });
  // 600 = odczyt tylko dla właściciela. Na Windows działa to tylko częściowo, ochroną jest głównie katalog domowy konta.
  writeFileSync(SETTINGS, text, { mode: 0o600 });
  chmodSync(SETTINGS, 0o600);
  console.log(`[test] ustawienia pobrane do ${SETTINGS}`);
}

// Zamienia wiersze KLUCZ=wartość na obiekt. Dzieli na pierwszym znaku =, bo sama wartość też może go zawierać
// (np. adres bazy z ?authSource=...). Pomija komentarze i puste wiersze.
function readSettings() {
  const values = {};
  for (const line of readFileSync(SETTINGS, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && !line.startsWith('#')) values[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return values;
}

// Adres z vm-prod wskazuje usługę mongodb w sieci Dockera; ta nazwa działa tylko wewnątrz kontenerów. Tu idzie przez
// tunel, do jednego serwera. Użytkownik, hasło i nazwa bazy zostają bez zmian, podmieniany jest tylko host i port.
function localUri(uri) {
  const url = new URL(uri);
  // Zabezpieczenie: gdyby ustawienia wskazywały inną bazę, np. produkcyjną, skrypt nie wystartuje.
  if (url.pathname !== '/hpdb_test') throw new Error('Ustawienia nie wskazują bazy hpdb_test, przerywam.');
  url.host = `127.0.0.1:${TUNNEL_PORT}`;
  // Bez tego sterownik próbowałby odnaleźć pozostałe serwery bazy pod adresami, których stacja nie zna.
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

// Pobranie przy pierwszym uruchomieniu albo na żądanie. Zmiana hasła na serwerze dotrze tu dopiero po --odswiez.
if (process.argv.includes('--odswiez') || !existsSync(SETTINGS)) downloadSettings();
const settings = readSettings();

// Zmienne środowiskowe serwera. Kolejność ma znaczenie: późniejsze wartości zastępują wcześniejsze, więc
// środowisko Windows < ustawienia testu < wartości poniżej.
// Puste wartości mają pierwszeństwo przed server/.env (dotenv nie nadpisuje istniejących zmiennych), więc test
// nie wyśle poczty ani powiadomień, a BACKGROUND_JOBS=off nie uruchamia schedulerów.
const serverEnv = {
  ...process.env,
  ...settings,
  MONGODB_URI: localUri(settings.MONGODB_URI),
  // Plik z serwera ma PORT kontenera (3001). Klient w trybie deweloperskim oczekuje 4001.
  PORT: '4001',
  CLIENT_URL: 'http://localhost:5173',
  // Bez tego stacja dublowałaby zadania w tle; na tej bazie są wyłączone także na serwerze testowym.
  BACKGROUND_JOBS: 'off',
  // Kod z telefonu (TOTP): klucze środowiska testowego są w bazie logowanie_test (konto myhome_test nie ma dostępu do
  // produkcyjnej bazy logowanie); LOGOWANIE_KLUCZ przychodzi z pliku testu.
  LOGIN_KEYS_DB: settings.LOGIN_KEYS_DB || 'logowanie_test',
  SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '', MAIL_ADMIN: '', SYSTEM_EMAIL: '',
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
  // polecenia dla QNAP-a (próbnie od 2026-11-13) tylko z serwera produkcyjnego
  QNAP_POLECENIA_KLUCZ: '', QNAP_ADRES: '',
};

// Wszystkie uruchomione procesy, żeby dało się je razem zamknąć.
const children = [];
// stdio: 'inherit': logi procesów pokazują się w tym samym oknie. spawn nie czeka na koniec procesu, procesy działają obok siebie.
const start = (command, args, options = {}) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.push(child);
  return child;
};

// Zamyka wszystkie procesy. Zdefiniowane przed startem tunelu, bo tunel może paść od razu (np. zajęty port).
// child.kill() na Windows nie zamyka procesów potomnych npm, stąd taskkill /T (cały proces z potomkami), /F (bez pytania).
let stopping = false;
function stop() {
  // Tunel i Ctrl+C mogą wywołać zamykanie jednocześnie, a wystarczy raz.
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // exitCode różny od null: proces już się zakończył.
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* już zakończony */ }
    } else {
      child.kill();
    }
  }
  process.exit(0);
}
// Ctrl+C w oknie i prośba systemu o zakończenie.
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Tunel: -L port_na_stacji:adres_widziany_z_serwera:port_na_serwerze, czyli 127.0.0.1:27017 z punktu widzenia vm-prod.
// -N: bez poleceń na serwerze, sam tunel. ExitOnForwardFailure: gdy port jest zajęty, ssh kończy się błędem,
// zamiast działać bez tunelu.
const tunnel = start('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${TUNNEL_PORT}:127.0.0.1:27017`, 'vm-prod']);
// Bez tunelu serwer nie ma bazy, więc nie ma sensu, żeby działał dalej.
tunnel.on('exit', (code) => {
  console.error(`[test] tunel SSH zakończony (kod ${code}), zatrzymuję wszystko.`);
  stop();
});
// Czas na zestawienie tunelu, zanim serwer spróbuje połączyć się z bazą. Nie sprawdza, czy tunel już działa.
await new Promise((resolve) => setTimeout(resolve, 3000));

// shell: true, bo npm na Windows to plik npm.cmd, którego nie da się uruchomić bezpośrednio.
// Serwer: nodemon, restart po zmianie kodu. Dostaje serverEnv; `import 'dotenv/config'` w server.ts dopełnia tylko brakujące zmienne.
start('npm', ['run', 'dev', '-w', 'server'], { cwd: REPO, shell: true, env: serverEnv });
// Klient: Vite, odświeża stronę po zmianie kodu. --strictPort: przy zajętym porcie błąd zamiast cichej zmiany na inny.
start('npm', ['run', 'dev', '-w', 'client', '--', '--port', '5173', '--strictPort'], { cwd: REPO, shell: true });
console.log('[test] serwer: http://localhost:4001  klient: http://localhost:5173  baza: hpdb_test na vm-prod');
