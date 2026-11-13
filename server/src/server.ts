// Punkt startowy serwera (npm start, obraz Dockera na vm-prod): HTTP + WebSocket na jednym porcie,
// połączenie z MongoDB (MONGODB_URI), scheduler pompy ciepła, czyszczenie
// szczegółów paneli PV i temperatura zewnętrzna z czujnika kotła. Aplikacja Express
// jest w core/app.ts (osobno, żeby testy mogły jej użyć bez nasłuchu i bazy).
// Ten sam plik uruchamia polecenia na serwerze (od 2026-11-13, core/cli.ts): --kod-awaryjny (kod konta system bez
// poczty) i --api (wywołanie API bez hasła, np. wgrywanie firmware); wtedy serwer nie startuje.
import 'dotenv/config';
import http from 'http';
import app from './core/app'
import { isCliCommand, runCli } from './core/cli';
import { saveInternalToken } from './core/internal';
import { createWsServer } from './core/websocket';
import mongoose from 'mongoose';
import { restoreOutdoorTemperature } from './modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200.service';
import { startScheduler } from './modules/heat-pump/services/scheduler.service';
import { ensureHomeWeatherTile } from './core/services/weather-tile.service';
import { startServerWeather } from './core/services/weather-fetch.service';
import { startPelletBoilerScheduler } from './modules/pellet-boiler-pelux200/services/pellet-boiler-pelux200-schedule.service';
import { removeExpiredPanelDetails } from './modules/heat-pump/services/pv.service';
import { assignDefaultPumpConfigs } from './core/services/device.service';
import { ensureSystemUser, systemEmail } from './core/services/auth.service';
import { loadSettings, setting } from './core/services/settings.service';
import { pushConfigured } from './core/services/push.service';
import { startPushWatchdog } from './core/services/push-watchdog.service';
import { loginKeysDbName, totpProblem } from './core/services/totp.service';

const PANEL_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const cleanPanelDetails = async () => {
  try {
    const cleaned = await removeExpiredPanelDetails();
    if (cleaned > 0) console.log(`Usunięto szczegóły paneli z ${cleaned} odczytów PV`);
  } catch (error) {
    console.error(error);
  }
};


const PORT = Number(process.env.PORT ?? 3001);

// Sprawdzanie serwerów bazy raz na minutę, jednym zapytaniem (poll). Domyślnie sterownik MongoDB co 10 s
// sprawdza każdy z 3 serwerów Atlas dwoma połączeniami (strumień i pomiar czasu), co samo dawało ok. 1,8 GB
// ruchu na 30 dni przy limicie transferu Render 5 GB; poll co 60 s to ok. 0,17 GB (pomiar 2026-10-29).
// Błąd zapytania i tak od razu oznacza serwer jako niedostępny i wymusza sprawdzenie, więc zmiana
// serwera głównego jest wykrywana przy pierwszym nieudanym zapytaniu, nie po minucie.
const MONGO_OPTIONS = { heartbeatFrequencyMS: 60_000, serverMonitoringMode: 'poll' } as const;

async function startServer() {
  // adres z hasłem tylko w zmiennej środowiskowej (lokalnie server/.env, Oracle: /etc/apps/my-home.env)
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error("Brak MONGODB_URI: ustaw zmienną środowiskową albo server/.env (wzór w server/.env.example)");
    process.exit(1);
  }
  const server = http.createServer(app);
  createWsServer(server);

  await mongoose.connect(MONGODB_URI, MONGO_OPTIONS);
  console.log("Mongo connected");

  // ustawienia aplikacji z bazy, przed wszystkim, co z nich korzysta
  await loadSettings().catch((error) => console.error('[ustawienia] odczyt:', error));

  // konta użytkowników: użytkownik systemowy
  await ensureSystemUser().catch((error) => console.error('[konta] konto system:', error));
  if (process.env.AUTH_DISABLED === '1') console.warn('[konta] AUTH_DISABLED=1: API bez logowania (tylko do testów)');
  // hasło systemowe zniknęło 2026-11-13 (konto system loguje się kodem z maila): stara zmienna nie przeszkadza
  if (process.env.SYSTEM_PASSWORD !== undefined) {
    console.warn('[konta] SYSTEM_PASSWORD jest pomijane: konto system loguje się kodem z maila; usuń tę zmienną ze środowiska serwera');
  }
  if (!setting('SMTP_HOST')) console.warn('[konta] brak SMTP_HOST: maile tylko w logu');
  console.log(`[konta] kody konta system: ${systemEmail() ? `na adres ${systemEmail()} (${setting('SYSTEM_EMAIL') ? 'SYSTEM_EMAIL' : 'MAIL_ADMIN'})` : 'tylko w dzienniku serwera (brak SYSTEM_EMAIL i MAIL_ADMIN)'}`);
  // kod z aplikacji na telefonie (TOTP, od 2026-11-13): klucz LOGOWANIE_KLUCZ i dostęp do wspólnej bazy kluczy;
  // bez nich logowanie działa kodem z maila (core/services/totp.service.ts)
  void totpProblem().then((problem) => console.log(problem
    ? `[totp] kod z telefonu wyłączony: ${problem}`
    : `[totp] kod z telefonu włączony (baza ${loginKeysDbName()})`));
  if (!pushConfigured()) console.warn('[push] brak VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: powiadomienia Web Push wyłączone');

  // Zadania w tle tylko przy BACKGROUND_JOBS=on w ustawieniach: domyślnie wyłączone, bo drugi serwer zlecałby
  // zmiany kotłu i kasował dane obok produkcji. Zmiana działa po restarcie serwera.
  if (setting('BACKGROUND_JOBS') !== 'on') {
    console.log('BACKGROUND_JOBS wyłączone: schedulery i czyszczenie PV nie działają');
  } else {
    // scheduler działa w procesie serwera: operacje ręczne i wyliczone są tylko w pamięci,
    // więc restart serwera je kasuje (pierwszy przebieg od razu po starcie)
    // pompy bez zapisanej definicji dostają podłączenie CWU (jak nowo zgłoszone), bez pojemności zbiornika
    void assignDefaultPumpConfigs()
      .then((count) => { if (count > 0) console.log(`[pompa] podłączenie CWU nadane ${count} pompom bez definicji`); })
      .catch((error) => console.error('[pompa] nadawanie definicji:', error));
    startScheduler();
    // harmonogram kotła pelletowego: sezon i CWU od–do, zlecenia zmian parametrów co minutę
    startPelletBoilerScheduler();
    // powiadomienia Web Push offline / online z kafelków co minutę (core/services/push-watchdog.service.ts)
    startPushWatchdog();

    // także przy starcie: serwer na Render bywa restartowany częściej niż raz na dobę
    void cleanPanelDetails();
    setInterval(() => void cleanPanelDetails(), PANEL_CLEANUP_INTERVAL_MS);
  }

  // przed nasłuchem, żeby pierwsze /hp/add miało już t_out: temperatura zewnętrzna z ostatniego odczytu
  // czujnika kotła (od 2026-10-04 zamiast IMGW Zakopane); dalej ustawia ją każdy odczyt kotła
  await restoreOutdoorTemperature().catch((error) => console.error('[meteo] error:', error));
  // kafelek pogody „Dom” (core/services/weather-tile.service.ts): powstaje przy pierwszym starcie po wdrożeniu
  await ensureHomeWeatherTile().catch((error) => console.error('[weather-tiles] error:', error));
  // pogoda z Open-Meteo pobierana przez serwer (od 2026-11-07, core/services/weather-fetch.service.ts), niezależnie od
  // BACKGROUND_JOBS: nic nie zapisuje w bazie, tylko w pamięci tej instancji; sterowniki pobierają już tylko zapasowo
  startServerWeather();

  server.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
    // token wywołań wewnętrznych dla polecenia --api uruchamianego obok (core/internal.ts)
    saveInternalToken(PORT);
  });
}

const args = process.argv.slice(2);
if (isCliCommand(args)) {
  runCli(args).then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  void startServer();
}


