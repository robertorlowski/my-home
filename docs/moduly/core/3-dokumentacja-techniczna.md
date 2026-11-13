# Moduł core — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/core/3-technical-documentation.md)

## Pliki — serwer (`server/src`)

| Plik | Rola |
|---|---|
| `server.ts` | punkt startowy: MongoDB, scheduler pompy, czyszczenie paneli PV, meteo, nasłuch HTTP i WebSocket |
| `core/app.ts` | aplikacja Express: CORS, kompresja odpowiedzi (`compression`, tylko przy `Accept-Encoding` gzip / br / deflate, sterowniki bez zmian), JSON, `device-context` i trasy pod `/api` |
| `core/routes.ts` | składa trasy: urządzenia i `/temperature` z core oraz `routes.ts` każdego modułu |
| `core/types.ts` | `DeviceType`, `WeekDay` (dni harmonogramu pompy i włącznika), `Device`, `DeviceProperties` (jedno pole ustawień dla wszystkich rodzajów), `DeviceTypeModule` |
| `core/device-types.ts` | rejestr rodzajów sterowników: `DeviceType` → opis modułu (`device-type.ts`) |
| `core/time.ts` | `TIME_ZONE = Europe/Warsaw`, granice doby w Warszawie jako zakres UTC |
| `core/websocket.ts` | serwer WebSocket (`/ws?rootId=`), `sendMessage(typ, rootId)` z opóźnieniem 1 s; od 2026-11-13 (próbnie) gniazda sterownika po powitaniu `ESP32`: `sendToController`, `onControllerMessage`, `controllerRootIds` (polecenia dla QNAP-a) |
| `core/middleware/device-context.ts` | ustala urządzenie z `rootId` albo (dla ścieżek sterownika z mapy `controllerPaths`) z pary `{deviceId, deviceType}`, z pamięci dokumentów urządzeń; 400/404/409 |
| `core/services/device-cache.service.ts`, `device-cache-store.ts` | dokumenty urządzeń w pamięci (`cachedDeviceById`, `cachedDeviceBySn`) dla ścieżek sterowników; każdy zapis do `devices` przez model kasuje pamięć (haczyki w `device.model.ts`), odświeżanie co 5 min (`DEVICE_CACHE_TTL_MS`) |
| `core/models/device.model.ts` | model Mongoose `devices`: schemat urządzenia, `properties`, osadzone harmonogramy i starsze `settings` |
| `core/controllers/device.controller.ts` | obsługa tras urządzeń; odpowiedź zgłoszenia z `settings` z rejestru; zlecenie i odwołanie aktualizacji firmware |
| `core/controllers/meteo.controller.ts` | `GET /temperature` |
| `core/controllers/firmware.controller.ts` | `/firmware/:rodzaj...`: stan, wgranie pliku, oferta, pobranie; tylko rodzaje z `firmwareUpdates` |
| `core/models/firmware.model.ts` | `firmware_images` (plik `.bin`, rozmiar, SHA-256) i `firmware_offers` (oferowana i poprzednia wersja, `enabled`) |
| `core/services/firmware.service.ts` | zapis i walidacja obrazu (nagłówek ESP32, ≤ 1 310 720 B), zlecenie aktualizacji (`requestFirmwareUpdate`, `cancelFirmwareUpdate`), oferta dla sterownika tylko przy zleceniu (`firmwareOfferForDevice`, `firmwareOfferForRoot`), przycinanie do bieżącej i jednej poprzedniej wersji |
| `core/services/device.service.ts` | lista, utworzenie, zgłoszenie, nazwa, domyślny, odczyt i zapis `properties` |
| `core/services/device-info.service.ts` | typ i `deviceId` urządzenia w pamięci (do rekordów danych modułów) |
| `core/services/calendar.service.ts` | polskie święta, dzień tygodnia w Warszawie, `scheduleDayMatches` (czy wpis harmonogramu włącznika dotyczy danej daty) |
| `core/services/weather-fetch.service.ts` | pogoda z Open-Meteo pobierana przez serwer (od 2026-11-07, od 2026-11-13 jedyne źródło): jedno zapytanie na dom i widoczne kafelki (najwyżej 8) co 15 min, po błędzie po 5 min, od razu po zmianie listy; start w `server.ts` (`startServerWeather`) |
| `core/services/meteo.service.ts` | temperatura zewnętrzna z czujnika kotła (bez świeżego odczytu z prognozy); pogoda z serwera (`setWeatherReadings`) w pamięci po id kafelka, odczyt starszy niż 45 min pomijany; temperatura domu z czujnika kotła albo prognozy. Do 2026-11-13 także pogoda ze sterowników (`setWeatherFromController`, `weatherStale`, `WEATHER_BACKUP_AFTER_MS`, klucz domu `home`) |
| `core/services/weather-tile.service.ts`, `models/weather-tile.model.ts`, `controllers/weather-tile.controller.ts` | kafelki pogody `weather_tiles` (`home` z `WEATHER_LOCATION`, najwyżej 8 na konto), `weatherQueries` — miejsca do pobrania przez serwer; `switchWeatherQueries` i `backupWeatherQueries` (miejsca zapasowe dla włącznika i `co`) usunięte 2026-11-13 |
| `core/services/mail.service.ts` | `sendMail`: SMTP z ustawień (`SMTP_*`), bez `SMTP_HOST` skrzynka w pamięci i dziennik (`mailConfigured()` = jest `SMTP_HOST`); treść po polsku albo angielsku (`lang`: język konta odbiorcy, inaczej żądania; `mailLang`). Przekaźnik poczty przez sterowniki (`MAIL_RELAY=1`, `mail-relay.service.ts`, `mail-relay.controller.ts`, `models/mail-outbox.model.ts`, `/mail/*`, `assertMailAvailable`; od 2026-10-17) usunięty 2026-11-13 |
| `core/services/qnap.service.ts`, `controllers/qnap.controller.ts`, `core/cli.ts` (`--qnap`) | próbne polecenia dla QNAP-a przez sterownik `co` (od 2026-11-13): ciało i podpis HMAC-SHA256, wybór połączonego `co`, wiadomość `qnap` i czekanie na `qnap_wynik` (`QNAP_CZEKAJ_MS` 20 s), wpis w dzienniku operacji; `POST /qnap/polecenia` tylko z tokenem wewnętrznym (opis niżej) |
| `core/services/push.service.ts`, `push-watchdog.service.ts`, `models/push-subscription.model.ts`, `controllers/push.controller.ts` | powiadomienia Web Push: katalog zdarzeń `PUSH_EVENTS`, `notify`, cisza nocna, próg 60 s, kasowanie wygasłych subskrypcji, `body` jako `Texts {pl, en}` dobierane do języka odbiorcy; wartownik offline / online z kafelków co minutę; `/push/*` |
| `core/services/auth.service.ts` (`demoLogin`, `demoAvailable`), `core/middleware/session.ts` (`scrubDemo`), `core/services/access.service.ts` (rola `demo`) | wersja demo: sesja tylko do odczytu na koncie z `DEMO_OWNER_EMAIL`, blokada zapisów, usuwanie danych wrażliwych z odpowiedzi |
| `core/services/totp.service.ts`, `core/services/auth.service.ts` (część „kod z aplikacji na telefonie”) | logowanie kodem z aplikacji na telefonie (TOTP, od 2026-11-13): kody RFC 6238, base32, szyfrowanie sekretów AES-256-GCM, wspólna baza kluczy `logowanie` (`totp_klucze`, `totp_uzyte`) przez `useDb`; zasady (krok 1 logowania, limity prób, rejestracja, wyłączenie) w `auth.service.ts` |
| `core/services/tile-layout.service.ts`, `tile.service.ts`, `tile-format.ts` | układ kafelków konta (`users.deviceOrder`, `hiddenTiles`) i dane kafelków `GET /devices/summary` (z `tile.ts` każdego modułu) |
| `core/i18n.ts` | słownik serwera pl / en: `requestLang(req)` (`Accept-Language` → `users.language` → pl), `t(lang, key, params)`, `both(fn)` (tekst w obu językach dla push), `pick`, `tabLabel`, `userLanguage`; z niego teksty kafelków (`tile-format.ts`, `tile.ts` modułów z parametrem `lang`), błędów `AuthError` / `PushError` (`messageFor(lang)`), maili i powiadomień |

## Pliki — klient (`client/src`)

| Plik | Rola |
|---|---|
| `index.tsx` | punkt wejścia: stosuje motyw (`core/theme.ts`), `DeviceProvider` + `App` |
| `theme.css` | tokeny kolorów wyglądu „Instrument”: `--bg`, `--card`, `--fg*`, `--line*`, `--accent`, stany `--ok-*` / `--warn-*` / `--err-*` / `--run-*`, kolory rodzajów `--c-heat`, `--c-water`, `--c-sun`, `--c-switch`, `--c-fire`, `--c-sky`, serie wykresów `--ch-1…4`; motyw jasny pod `:root`, ciemny pod `prefers-color-scheme: dark` (bez jawnego wyboru) i `[data-theme="dark"]` |
| `style.css` | style globalne: pasek `header.app-header`, boczne menu `nav.app-tabs` (od 900 px, `.app-container.has-side`, zmienna `--page-vw`), dolna nawigacja `nav.bottom-nav` i arkusz „Więcej”, karty, przyciski, pola, reguły telefonu |
| `makieta.css` | wspólne komponenty przeniesione z makiety (`makiety/src/makieta.css`): `.card`, `.hero`, `.kpi`, `.filters`, `.date-nav`, `.segmented`, `.switch`, `.chip`, `.entries`, `.kv`, `.timeline`, `.tile*`, `.modal`, `.banner`; ładowany po `style.css` |
| `core/theme.ts` | motyw jasny / ciemny / jak system: wybór w `localStorage` `chpc.theme`, `data-theme` na `<html>`, bez wyboru jasny (od 2026-10-17); `useTheme`, `setTheme` |
| `core/i18n/` | słowniki `pl.ts` / `en.ts` (te same klucze; `en` sprawdzany typem `Record<keyof typeof pl, string>`), `index.ts`: `t`, `tn` (liczba mnoga przez `Intl.PluralRules`, klucze `.one` / `.few` / `.many`), `useLang()` → `{lang, locale, t, tn}` (komponent rysuje się od nowa po zmianie), `getLang` / `setLang` (`localStorage` `chpc.lang`, zdarzenie `chpc-lang-change`, `<html lang>`), `format.ts` (daty i liczby w locale języka); poza komponentem `import { t as tr }`. Nowy tekst zawsze przez słownik, w obu plikach |
| `core/chartColors.ts` | kolory wykresów Recharts z tokenów (`cc()`), bo SVG nie przyjmuje `var()` |
| `core/App.tsx` | routing, `AuthGate` (logowanie, uzupełnienie danych nowego konta, pytanie „Zapamiętać?”), `DeviceGuard` (bez sterownika → `/devices`; nowa sesja przeglądarki zaczyna od listy), `DeviceRoute` (zakładki sterownika udostępnionego), paski stron bez zakładek (`/devices`, `/account`, `/firmware`), `BottomNav` na telefonie; stopki „Aktywne urządzenie” nie ma od 2026-10-16 |
| `core/device-types.tsx` | rejestr: `DeviceType` → `DeviceTypeView` (ikona kafelka, nazwa rodzaju, ekrany menu, dodatkowe trasy, pola okna „Dane sterownika”) |
| `core/types.ts` | `DeviceType`, `WeekDay`, `Device` (z `access`, `tabs`, `owner` udostępnienia), `DeviceProperties`, `DeviceView`, `DeviceTypeView`, `DeviceTile` (dane kafelka) |
| `core/http.ts` | adresy API i WebSocket, zapytania z `rootId` i `deviceId` wybranego sterownika oraz nagłówkami sesji i `Accept-Language` (język odpowiedzi serwera) |
| `core/api.ts` | `DeviceRequests`: lista, podsumowania kafelków (`/devices/summary`), nazwa, ukrycie, układ (`setDevicesOrder` z `null` w pustych polach), `properties`, zlecenie i odwołanie aktualizacji firmware; `WeatherTileRequests`: kafelki pogody; `AuthRequests`: logowanie, sesja, konto, język konta (`setLanguage`) |
| `core/context/DeviceContext.tsx` | wybrany sterownik (stan + `localStorage` `chpc.selectedDevice`), `deviceLabel` |
| `core/context/AuthContext.tsx` | sesja użytkownika (`localStorage` `chpc.session`), logowanie kodem albo linkiem, „Zapamiętaj” (90 dni), wylogowanie |
| `core/components/Header.tsx` | pasek sterownika: strzałka wstecz, nazwa, chip Włączony / Wyłączony (pole `power`; od 2026-10-27) i „pracuje” (z pamięci kafelków `chpc.deviceTiles.<id konta>`), opis rodzaju (`deviceSubText`), zakładki z rejestru (`nav.app-tabs`), `UserMenu`; `BottomNav`: 4 pierwsze widoki + „Więcej” |
| `core/components/UserMenu.tsx`, `ThemeToggle.tsx`, `LangToggle.tsx` | ikona motywu (księżyc / słońce: jasny ↔ ciemny; także na ekranie logowania), przełącznik języka PL / EN (ekran logowania) i awatar konta z menu: imię i e-mail, „Moje dane”, motyw Jasny / Ciemny / Jak system, język Polski / English, „Wyloguj”, „Usuń konto” |
| `core/pages/Login/` | ekran logowania (karta `.auth-card`): e-mail → kod (6 cyfr, 10 min) albo link z maila; „system” (od 2026-11-13 bez hasła) → „Wyślij kod” na adres z ustawień serwera albo „Mam już kod” (kod awaryjny) → kod (5 min) → pytanie o zapamiętanie; adres z telefonem (od 2026-11-13, `POST /auth/methods`) → „Kod z aplikacji” i „Wyślij kod na maila” |
| `core/pages/Account/`, `components/ProfileForm.tsx`, `RememberDialog.tsx`, `account.css` | `/account` „Moje dane”: karty „Moje dane” (e-mail ze zmianą przez kod, imię, nazwisko, adres, kraj, lokalizacja na mapie), „Sesja” i „Usunięcie konta” (`.card-danger`, potwierdzenie linkiem z maila); okno „Zapamiętać?” |
| `core/pages/Operations/` | zakładka `/operations` (pompa, hydrofor, włącznik, piec): dziennik operacji z dnia (`GET /operations?date=`, 5 dni), filtr Wszystkie / Użytkownik / System, karta „Zaplanowane” (dziś) i oś czasu `.timeline` z chipem stanu; dziś odświeżanie co 30 s i po WebSocket `update` |
| `core/components/DeviceEditModal.tsx` | okno „Dane sterownika” (`.modal`): nazwa, rodzaj, SN i Root ID tylko do odczytu, pola rodzaju z rejestru (`DefinitionFields`, np. konfiguracja pompy ciepła), przełącznik „Kafelek prosty” dla rodzajów z `SimpleTile` w rejestrze (`PUT /devices/:rootId {simple}`, tylko konto); z kafelka i z karty „Sterownik” |
| `core/components/ControllerCard.tsx`, `ControllerCardTitle.tsx`, `DeviceAddress.tsx` | karta „Sterownik” w Ustawieniach każdego rodzaju: ołówek (okno „Dane sterownika”), lista `.kv`: Nazwa, SN, Root ID (skrócony, „kopiuj”), Adres IP (odnośnik do stron sterownika), Firmware z chipem stanu, Ostatnie zgłoszenie, przycisk „Aktualizuj firmware”; wiersz „Poczta” (`MailKeyRow`, klucz płytki przekaźnika poczty) był tu od 2026-10-17 do 2026-11-13 |
| `core/components/FirmwareStatus.tsx` | wiersze „Firmware” i „Ostatnie zgłoszenie” oraz przycisk „Aktualizuj firmware” / „Anuluj aktualizację” (z potwierdzeniem) karty „Sterownik”; stan „aktualny” / „dostępna wersja X” / „zlecona, czeka na sterownik”, podpowiedź rodzaju (`firmwareUpdateHint`); przy zleceniu odświeżanie co 15 s; przy aktualnej wersji bez przycisku, przy pracującej sprężarce pompy ciepła albo włączonym przekaźniku włącznika przycisk nieaktywny z komunikatem („Sprężarka pracuje.”, „Przekaźnik włączony.”; stan z `GET /devices/summary`) |
| `core/components/DeviceSharing.tsx` | karta „Udostępnianie” w Ustawieniach: lista osób z zakładkami, okno „Udostępnij sterownik” (e-mail, wybór „Pełna aplikacja” z zakładkami rodzaju albo „Panel prosty” = `tabs: ['simple']`), zmiana zakładek i cofnięcie dostępu; tylko właściciel i użytkownik systemowy |
| `core/components/OfflineBanner.tsx` | czerwony pasek „Offline od …” z przyczyną na górze ekranu sterownika (`.banner.banner-off`) |
| `core/components/Notification.tsx` | krótki komunikat na górze ekranu |
| `core/components/icons.tsx`, `pictograms.tsx`, `WeatherIcon.tsx` | wspólne ikony menu i akcji, piktogramy rodzajów, ikony nieba |
| `core/components/IconButton.tsx`, `iconButton.css` | szablon przycisku-ikony (sama ikona, wariant danger do usuwania, etykieta jako podpowiedź i aria-label) |
| `core/components/InfoTip.tsx` | ikona „i” z podpowiedzią |
| `core/pages/Devices/`, `components/DeviceTileCard.tsx` | lista sterowników `/devices`: pasek pogody domu (`.outdoor-strip`; ikona nieba `WeatherCodeIcon` przed temperaturą; źródło „Open-Meteo · X min temu” tekstem, na telefonie ukryte), szachownica kafelków `.tiles` w stałym układzie makiety (`DeviceTileCard`: nagłówek z ikoną rodzaju, nazwą, chipem i narzędziami, duża wartość, stan pracy, pola faktów, ostrzeżenie, przekaźniki włącznika, stopka „dane sprzed …”; od 2026-10-27 chip Włączony / Wyłączony z pola `power` (pompa, kocioł, hydrofor) zamiast Online / Offline, a brak odpowiedzi to linia `note` z `icon: 'offline'` (ikona `OfflineIcon` z `OfflineBanner`); `WeatherTileCard` dla pogody; sterownik z `device.simple` rysuje `SimpleTile` rodzaju z rejestru — `devices/switch/components/SimpleTile.tsx`, `devices/pellet-boiler-pelux200/components/SimpleTile.tsx`, wspólny `core/components/simpleTile.css` — kafelek nie jest wtedy odnośnikiem, pełne widoki otwiera nazwa), siatka auto-fill ≥ 300 px (1–4 kolumny), tryb „Zmień układ” (ikona siatki w pasku: strzałki, oko, „+ kafelek pogody”, „Gotowe”, pusty wiersz spycha resztę do dołu ekranu), stopka z zajętością bazy (`/devices/db-stats`, użytkownik systemowy); dane kafelków z `GET /devices/summary`, odświeżane po WebSocket `update` i cyklicznie. Pasek błędu na kafelku ma krzyżyk: zamknięcie pamięta przeglądarka (`core/dismissedNotes.ts`) po `note.id` z serwera; nowe zdarzenie pokazuje pasek znowu, a stan bez czasu (alarm kotła tego samego kodu, niskie paliwo) po 7 dniach bez wystąpienia. Stopka pokazuje rozmiar bazy na dysku w MB (`storageSize` + `indexSize`) |
| `core/components/WeatherTileModal.tsx`, `LocationPicker.tsx` | okno „Kafelek pogody” (`.modal`): wyszukiwarka miejscowości (geokoder Open-Meteo z przeglądarki), współrzędne, usuwanie; wybór lokalizacji na mapie (konto) |
| `core/pages/Weather/` (`index.tsx`, `nav.tsx` (pasek i zakładki w bocznym menu / dolnej nawigacji jak widoki sterownika, od 2026-10-19), `NowTab`, `DaysTab`, `SunTab`, `HeatingTab`, `AirTab`, `WindTab`, `forecast.ts`, `style.css`), `core/currentPlace.ts` | strona pogody `/weather/:id` (kliknięcie kafelka pogody; makieta `#pogoda-*`): zakładki w `?tab=` — Teraz, Najbliższe dni, Słońce i PV (prognoza produkcji dopasowana do DTU), Ogrzewanie (okno CWU w G12w), Powietrze, Wiatr i opady; bieżące warunki z `GET /weather-tiles`, prognoza i jakość powietrza wprost z Open-Meteo (`forecast.ts`); kafelek „Moja lokalizacja” (`current`) z położeniem z przeglądarki |
| `core/components/PushSettingsCard.tsx`, `core/push.ts`, `public/sw.js` | karta „Powiadomienia” na `/account` (subskrypcja tej przeglądarki, lista przeglądarek, reguły, cisza nocna, próbne), rejestracja service workera i subskrypcji PushManager, odbiór powiadomień i otwarcie aplikacji po kliknięciu |
| `core/components/PhoneLoginCard.tsx` | karta „Logowanie kodem z telefonu” na `/account` i w „Moje dane” konta system: włączenie (kod QR i klucz tekstem, pierwszy kod z aplikacji), stan (od kiedy, w której aplikacji), wyłączenie kodem z telefonu albo z maila |
| `core/App.tsx` (`DemoBanner`, `DemoToast`), `core/http.ts`, `core/auth.ts`, `core/types.ts` (`canEditDevice`) | wersja demo w kliencie: pasek, zatrzymane zapisy z komunikatem, flaga `chpc.demo`, edycja tylko własnych sterowników |
| `public/manifest.webmanifest`, `public/icon-*.png`, `public/.well-known/assetlinks.json`, `index.tsx` (rejestracja `sw.js`) | PWA: manifest z ikonami PNG, Digital Asset Links dla aplikacji Androida, service worker z powłoką z pamięci (patrz `public/sw.js` wyżej) |
| `android/` (`twa-manifest.json`, `build.ps1`, `README.md`) | pakiet Androida (TWA, Bubblewrap); klucz podpisu i hasła poza gitem |
| `core/pages/Firmware/` | `/firmware/:deviceType` (trybik na kafelku, użytkownik systemowy): karty „Aktualna wersja” (opis, data, rozmiar, SHA-256, przełącznik „Aktualizacje”; plus otwiera kartę „Dodaj wersję”), „Sterowniki tego rodzaju” (wersja z ostatniego zgłoszenia, chip stanu) i „Poprzednie wersje” (przywrócenie, usunięcie); poza kontekstem urządzenia |

## API

Wszystkie adresy mają przedrostek `/api`. Poza ścieżkami publicznymi zapytanie musi mieć `?rootId=` (klient dodaje go sam, razem z `deviceId`). Wyjątek: endpointy sterownika z mapy `controllerPaths` (niżej) przyjmują też sam `?deviceId=`.

### Mapa `controllerPaths` (`core/middleware/device-context.ts`)

Ten sam SN może być zarejestrowany pod kilkoma rodzajami sterownika (role jednego fizycznego sterownika), więc endpoint sterownika musi wiedzieć, jakiego rodzaju urządzenia szuka. Mapa `controllerPaths` przypisuje ścieżce rodzaj:

| Ścieżka (względem `/api`) | Rodzaj |
|---|---|
| `/hp/add`, `/pv/add` | `heat_pump` |
| `/water-pressure-tank/add`, `/water-pressure-tank/settings` | `water-pressure-tank` |
| `/pellet-boiler-pelux200/add` | `pellet-boiler-pelux200` |
| `/switch/state`, `/switch/mode` | `switch` (`/switch/mode` woła też aplikacja, z `rootId`) |

Działanie dla ścieżki z mapy:

- bez `rootId` z samym `deviceId`: `DeviceModel.findOne({deviceId, deviceType})`; nieznane — 404;
- z `rootId` (i ewentualnie `deviceId`): urządzenie po `rootId`; **409**, gdy jego `deviceId` jest inny niż podany albo jego `deviceType` jest inny niż rodzaj ścieżki (np. `rootId` pompy na `/pellet-boiler-pelux200/add`);
- bez `rootId` i bez `deviceId` — 400.

Ścieżki spoza mapy (aplikacja, `GET`-y, `/device/properties`) wymagają `rootId` i nie sprawdzają rodzaju.

| Metoda i ścieżka | Kontekst | Opis | Odpowiedzi |
|---|---|---|---|
| `GET /devices` | publiczna | lista urządzeń: `rootId`, `deviceType`, `deviceId`, `name` | 200 |
| `POST /devices` | publiczna | ręczne utworzenie (nieużywane przez klienta; używa go test E2E) | 201; 400 gdy SN istnieje |
| `POST /devices/register` | publiczna | zgłoszenie sterownika `{deviceId, deviceType?, name?, version?, ip?}`; `deviceType` domyślnie `heat_pump`; `ip` tylko IPv4 (inne i `0.0.0.0` pomijane) | 201 nowe, 200 znane (+ `settings` dla rodzajów z `controllerSettings`); 400 brak SN / nieznany typ |
| `PUT /devices/:rootId` | publiczna | zmiana nazwy `{name}` (pusta dozwolona) | 200; 400; 404 |
| `POST /devices/:rootId/firmware-update` | publiczna | „Aktualizuj”: zlecenie aktualizacji do oferowanej wersji, zapis `firmwareUpdate {version, requestedAt}`; WebSocket `operation` budzi sterownik | 200 `{version, requestedAt}`; 400 rodzaj bez aktualizacji (pompa); 404; 409 brak oferowanej wersji, aktualizacje wyłączone albo sterownik ma już tę wersję |
| `DELETE /devices/:rootId/firmware-update` | publiczna | „Anuluj aktualizację”: usunięcie zlecenia (pobieranie, które już trwa, dokończy się) | 200; 404 |
| `GET /device/properties` | `rootId` | ustawienia urządzenia | 200; 404 |
| `PUT /device/properties` | `rootId` | zapis całego obiektu ustawień (walidacja schematu Mongoose) | 200; 400 |
| `GET /temperature` | `rootId` | temperatura domu i pogoda domu `{temperature, temperatureSource, weather}` (czujnik kotła, bez świeżego odczytu prognoza) | 200 |
| `GET` / `POST /weather-tiles`, `PUT` / `DELETE /weather-tiles/:id` | publiczna (sesja) | kafelki pogody konta `{name, lat, lon, hidden}` z bieżącą pogodą i `nearHome` (do 3 km od domu: temperatura z czujnika kotła); `home` bez usuwania; najwyżej 8 | 200; 400; 404 |
| `GET /push/settings`, `POST /push/subscriptions`, `DELETE /push/subscriptions/:id`, `PUT /push/rules`, `POST /push/test` | zalogowany, bez `rootId` | ustawienia powiadomień (klucz VAPID, subskrypcje, reguły, katalog zdarzeń, sterowniki), subskrypcja przeglądarki, reguły `{rules: [{rootId, events}], quietFrom, quietTo}`, powiadomienie próbne | 200; 201; 204; 400; 403; 404; 409; 503 |
| `POST /auth/system` | publiczna | kod konta `system` (od 2026-11-13 zamiast hasła) na stały adres z ustawień (`SYSTEM_EMAIL`, bez niego `MAIL_ADMIN`) albo, bez poczty lub adresu, do dziennika serwera; adres z formularza pomijany, w mailu IP zamawiającego; `{password}` (dawny klient) → 400 bez kodu | 200 `{delivery: "mail" \| "log", expiresInSeconds, resendAfterSeconds}`; 400; 429 (raz na minutę, 5 na godzinę, blokada `locked`); 503 poczta |
| `POST /auth/system/verify` | publiczna | `{code}` → sesja konta `system` `{token, created, user}`; 5 błędnych kodów unieważnia kod i blokuje logowanie `system` na 15 min (429 `locked: true`, `Retry-After`) | 200; 400; 429 |
| `POST /auth/methods` | publiczna | krok 1 logowania bez wysyłania maila: `{email}` (albo `system`) → `{email, totp}`; `totp` = adres ma zarejestrowany telefon, który ten serwer umie sprawdzić | 200; 400 |
| `POST /auth/totp/verify` | publiczna | `{email, code}` kod z aplikacji (±30 s, raz w każdej aplikacji dzięki `totp_uzyte`) → sesja jak `POST /auth/verify` (nowy adres zakłada konto); 5 błędnych kodów blokuje kod z telefonu adresu na 15 min (429 `locked`), kod z maila działa | 200; 400; 429; 503 baza kluczy niedostępna |
| `GET /auth/totp`, `POST` / `DELETE /auth/totp/setup`, `POST /auth/totp/confirm`, `POST /auth/totp/disable/code`, `POST /auth/totp/disable` | sesja | stan `{available, enabled, address, app?, since?, reason?}`; rejestracja: klucz (base32), `otpauthUrl`, kod QR (PNG) na 10 min, potem `{code}` zapisuje klucz w `totp_klucze`; wyłączenie `{code}` kodem z telefonu albo z maila (kod z maila zamawia `disable/code`; konto system: zwykły kod konta system) | 200; 204; 400; 409 już włączone; 429; 503 |
| `GET /settings`, `PUT /settings` | użytkownik systemowy | ustawienia aplikacji (`app_settings`) bez dodatkowego hasła (od 2026-11-13); `PUT {values}` zmienia podane klucze; `POST /settings/read` = dawny odczyt, hasło pomijane | 200; 400; 401; 403 |
| `GET /auth/demo`, `POST /auth/demo` | publiczna | wersja demo: dostępność `{available}` / sesja tylko do odczytu (404 bez `DEMO_OWNER_EMAIL`, 429 przy nadmiarze wejść) | 200; 404; 429 |
| `PUT /auth/me/language` | sesja | język konta `{language: "pl" | "en"}`, zapisywany w `users.language` i zwracany w `/auth/me` | 200; 400 |
| `POST /qnap/polecenia` | token wewnętrzny (tylko polecenie `--qnap` na serwerze) | próbne polecenie dla QNAP-a przez połączony sterownik `co`: `{polecenie: "stan" \| "restart_sieci" \| "restart", rootId?}`; czeka do 20 s na `qnap_wynik`; wpis w dzienniku operacji `co` (opis niżej) | 200 `{id, polecenie, rootId, status, cialo, czasMs, brakOdpowiedziSterownika?}` (`status` 0 = sterownik nie połączył się z QNAP-em albo nie odpowiedział); 400 nieznane polecenie albo `rootId` innego rodzaju; 403 bez tokenu wewnętrznego; 404 nieznany `rootId`; 409 brak połączonego `co` albo kilka bez `rootId`; 503 brak klucza albo adresu |

Endpointy przekaźnika poczty (`GET /mail/config`, `GET /mail/next`, `POST /mail/result`, `POST` / `DELETE /devices/:rootId/mail-key`) usunięto 2026-11-13; starszy firmware dostaje z nich 404.

WebSocket: `ws(s)://<serwer>/ws?rootId=<rootId>`. Serwer wysyła `{"type":"operation"|"update","rootId":"…"}`; połączenie bez `rootId` jest zamykane kodem 1008. Od 2026-11-13 (próbnie) gniazdo, które po połączeniu wysłało tekst `ESP32` (sterownik `co`), jest gniazdem sterownika: tylko ono dostaje `{"typ":"qnap",…}` i tylko od niego serwer przyjmuje `{"typ":"qnap_wynik",…}` (umowa niżej).

## Model danych — kolekcja `devices`

| Pole | Typ | Opis |
|---|---|---|
| `_id` | ObjectId | Root ID |
| `deviceType` | `heat_pump` \| `water-pressure-tank` \| `pellet-boiler-pelux200` \| `switch` | rodzaj sterownika (rola) |
| `deviceId` | string | SN sterownika (MAC ESP32, 12 znaków hex); ten sam SN mogą mieć urządzenia różnych rodzajów (role jednego sterownika), bez indeksu unikalnego |
| `name` | string | nazwa od użytkownika, domyślnie pusta |
| `firmwareVersion`, `firmwareSeenAt` | string, Date | wersja firmware z pola `version` zgłoszenia i czas zgłoszenia; starsze sterowniki ich nie wysyłają |
| `firmwareUpdate` | `{version, requestedAt}` | zlecenie aktualizacji z aplikacji („Aktualizuj”); tylko przy nim sterownik dostaje ofertę firmware; usuwane, gdy sterownik zgłosi oferowaną wersję, albo „Anuluj aktualizację” |
| `ipAddress`, `ipSeenAt` | string, Date | adres IPv4 sterownika w sieci lokalnej z pola `ip` zgłoszenia i czas zgłoszenia; bez pola zostaje ostatni znany; w kliencie wiersz „Adres IP” w Ustawieniach (`DeviceAddress`) |
| `properties` | obiekt | ustawienia; pompa: `co_min`, `co_max`, `cwu_min`, `cwu_max`, `work_mode` (domyślnie `CWU`); hydrofor: `compressor_seconds` (1–3600); kocioł pelletowy: `poll_interval_seconds` (liczba całkowita 30–3600, domyślnie 300; co ile sekund sterownik wysyła odczyt kotła); włącznik: `default_on_minutes` (pełne minuty 0–10080, 0 = bez limitu, domyślnie 30) |
| `schedules[]` | obiekt | harmonogramy pompy ciepła (moduł heat-pump) |
| `createdAt`, `updatedAt` | Date | znaczniki czasu |

Dokument urządzenia jest wspólny dla wszystkich rodzajów, dlatego `core/models/device.model.ts` importuje schematy części z modułów (harmonogram, starsze ustawienia pompy).

## Rejestr rodzajów sterowników

**Serwer** — `core/types.ts`, `DeviceTypeModule`:

```ts
{
  type: DeviceType;
  initialProperties?: DeviceProperties;                       // ustawienia nowego urządzenia
  controllerSettings?: (properties: DeviceProperties) => unknown; // pole settings w odpowiedzi na zgłoszenie
  firmwareUpdates?: boolean;                                  // OTA na zlecenie „Aktualizuj”: oferta {version, url, sha256, request}
                                                              // w settings.firmware zgłoszenia (włącznik: też /switch/state, piec: /commands/next)
  onRegister?: (rootId, deviceId, body) => Promise<void>;     // dodatkowe pola zgłoszenia (włącznik: relays)
}
```

**Klient** — `core/types.ts`, `DeviceTypeView`:

```ts
{
  type: DeviceType;
  tileIcon: ReactNode;                                    // ikona kafelka na liście
  label?: string;                                         // nazwa rodzaju w nagłówkach (np. strona firmware)
  views: { path, label, icon, element }[];                // ekrany w kolejności menu; '/' = strona główna
  extraRoutes?: { path, element }[];                      // trasy poza menu (np. /hp pompy)
  DefinitionFields?: ComponentType;                       // dodatkowe pola okna „Dane sterownika” (np. konfiguracja pompy)
  firmwareUpdates?: boolean;                              // trybik firmware na kafelku, karta „Sterownik” z „Aktualizuj”
  firmwareUpdateHint?: string;                            // kiedy sterownik pobierze firmware (podpowiedź w karcie „Sterownik”)
}
```

### Jak dodać nowy rodzaj sterownika

1. Wartość w `DeviceType` — w `server/src/core/types.ts` i `client/src/core/types.ts` (ta sama).
2. Serwer: katalog `server/src/modules/<rodzaj>/` z `controllers/`, `services/`, `models/`, `types.ts`, `routes.ts`, `device-type.ts`; wpis w `server/src/core/device-types.ts`; `routes.ts` dołączone w `server/src/core/routes.ts`; ścieżki wysyłane przez sterownik z samym SN — w `controllerPaths` w `device-context.ts`, razem z rodzajem (bez wpisu ścieżka wymaga `rootId`, a rodzaj nie jest sprawdzany).
3. Klient: katalog `client/src/devices/<rodzaj>/` z `pages/`, `api.ts`, `types.ts`, `device-type.tsx`; wpis w `client/src/core/device-types.tsx`.
4. Jeśli rodzaj ma własne ustawienia w `properties`: pola w `DeviceProperties` (oba `types.ts`) i w schemacie w `device.model.ts`.
5. Firmware: zgłoszenie z nowym `deviceType`.
6. Dokumentacja: `docs/moduly/<rodzaj>/` (trzy części) i wpis w `docs/README.md`.

## Konfiguracja

| Zmienna (serwer) | Znaczenie |
|---|---|
| `MONGODB_URI` | połączenie z MongoDB; wymagane, bez niego serwer kończy start błędem |
| `PORT` | port HTTP i WebSocket (domyślnie 3001) |
| ustawienia w bazie | od 2026-11-07 wiersze `SMTP_*`, `MAIL_*`, `CLIENT_URL`, `DEMO_OWNER_EMAIL`, `VAPID_*` i `BACKGROUND_JOBS` (domyślnie wyłączone, zmiana po restarcie) są w kolekcji `app_settings` i na ekranie konta systemowego (`GET` / `PUT /api/settings`, od 2026-11-13 bez hasła ustawień); `SYSTEM_EMAIL` to adres kodów konta `system` (pusty = `MAIL_ADMIN`); od 2026-11-13 także ukryte `QNAP_ADRES` (bez pola na ekranie, `GET /settings` go nie pokazuje); zmienna środowiskowa działa tylko bez wartości w bazie (praca lokalna, testy) |
| `MAIL_RELAY` | usunięte 2026-11-13 razem z przekaźnikiem poczty przez sterowniki (od 2026-11-07 było wyłączone); wartość w `app_settings` do usunięcia po wdrożeniu ([baza danych](../../baza-danych.md)), do tego czasu pomijana |
| `QNAP_POLECENIA_KLUCZ` | próbne polecenia dla QNAP-a (od 2026-11-13): klucz HMAC, 32 losowe bajty zapisane jako 64 znaki hex, tylko w środowisku serwera (nigdy w bazie ani w repozytorium); kluczem HMAC są te 32 bajty po odczytaniu z hex. Bez niego `--qnap` dostaje 503 |
| `QNAP_ADRES` | `<adres>:<port>` QNAP-a w sieci prywatnej (10/8, 172.16/12, 192.168/16); ukryte ustawienie w `app_settings` (`--api PUT /settings '{"values":{"QNAP_ADRES":"<adres>:<port>"}}'`) albo zmienna środowiska; bez poprawnego adresu `--qnap` dostaje 503 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | powiadomienia Web Push; bez kluczy wyłączone (para: `npx web-push generate-vapid-keys` w `server/`) |
| `DEMO_OWNER_EMAIL` | e-mail konta pokazywanego w wersji demo tylko do odczytu; bez wartości przycisku „Zobacz wersję demo” nie ma |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_ADMIN` | konto pocztowe serwera; nadawca `Mój Dom <SMTP_USER>`, odpowiedzi na `MAIL_FROM`; bez `SMTP_HOST` maile trafiają do skrzynki w pamięci i do dziennika |
| `CLIENT_URL`, `AUTH_DISABLED=1` | adres aplikacji w linkach z maili, wyłączenie logowania (środowisko lokalne) |
| `SYSTEM_EMAIL` | adres kodów logowania konta „system” (w bazie, ekran Ustawienia → Poczta); puste = `MAIL_ADMIN`, bez obu albo bez poczty kod jest w dzienniku serwera. Adresu nie ma w kodzie: kod aplikacji jest publiczny, a cudza instalacja wysyłałaby kody właścicielowi |
| `SYSTEM_PASSWORD` | od 2026-11-13 pomijane (konto „system” loguje się kodem); zmienna obecna w środowisku daje jedno ostrzeżenie przy starcie |
| `LOGOWANIE_KLUCZ`, `LOGIN_KEYS_DB` | logowanie kodem z telefonu (od 2026-11-13), tylko w środowisku serwera: klucz szyfrujący sekrety telefonów (32 bajty w zwykłym base64, ten sam w Moim domu i w Archiwum na jednym serwerze, nigdy w bazie ani w repozytorium) i nazwa wspólnej bazy kluczy (domyślnie `logowanie`, test `logowanie_test`; konto bazy z `MONGODB_URI` potrzebuje do niej roli `readWrite`). Bez klucza albo bez dostępu do bazy kod z telefonu jest wyłączony, a kod z maila działa |
| `INTERNAL_API_URL` | adres własnego API dla wywołań wewnętrznych i polecenia `--api` (domyślnie `http://127.0.0.1:PORT/api`) |
| `WEATHER_LOCATION` | współrzędne domu dla kafelka pogody „Dom” |
| `CLIENT_DIR` | katalog z buildem klienta podawanym przez serwer (`core/client-static.ts`); ustawia go tylko obraz Dockera |

Na serwerze w zmiennych środowiskowych są tylko `MONGODB_URI`, dla kodu z telefonu `LOGOWANIE_KLUCZ` i `LOGIN_KEYS_DB`, a od 2026-11-13 (próbnie) `QNAP_POLECENIA_KLUCZ`; reszta jest w kolekcji `app_settings`. Lokalnie wartości są w `server/.env` (poza gitem, wzór `server/.env.example`).

**Polecenia na serwerze (od 2026-11-13, `core/cli.ts`)** uruchamia ten sam plik co serwer; serwer wtedy nie startuje. W kontenerze na vm-prod (katalog `/app/server`, zmienne kontenera), lokalnie `npm run kod-awaryjny -w server` albo `node dist/server.js …` w `server/` po buildzie:

- `docker exec my-home-prod node dist/server.js --kod-awaryjny` — jednorazowy kod konta `system` w terminalu, ważny 5 minut, bez poczty; zdejmuje blokadę po błędnych kodach i limit kodów na godzinę, unieważnia wysłany kod. Łączy się tylko z bazą (`MONGODB_URI`), więc działa też przy zatrzymanym serwerze. Na ekranie logowania: „system”, „Mam już kod”.
- `docker exec my-home-test node dist/server.js --kod-totp <KLUCZ>` — bieżący i następny kod z aplikacji dla klucza base32 spod kodu QR (rejestracja telefonu), bez bazy: sprawdzanie logowania kodem z telefonu bez telefonu; lokalnie `npm run kod-totp -w server -- <KLUCZ>`.
- `docker exec -i my-home-prod node dist/server.js --api METODA /ścieżka ['{json}'] [--bin < plik]` — żądanie do serwera działającego w tym samym kontenerze z jego tokenem wywołań wewnętrznych (`core/internal.ts`: losowy przy każdym starcie, zapisany przez serwer w `/tmp/my-home-internal-<PORT>.token`), bez konta i hasła; zastępuje skrypty logujące się dawnym hasłem systemowym. Odpowiedź na standardowe wyjście, status na wyjście błędów, kod wyjścia 0 tylko przy 2xx; w dzienniku operacji źródło „Polecenie na serwerze”. Wgranie firmware: `--api PUT '/firmware/switch/1.3.8?description=…' --bin < switch-1.3.8.bin`, zlecenie aktualizacji: `--api POST /devices/<Root ID>/firmware-update`.
- `docker exec my-home-prod node dist/server.js --qnap stan|restart_sieci|restart [ROOT_ID]` (od 2026-11-13, próbnie) — polecenie dla QNAP-a przez połączony sterownik `co`. Woła serwer działający w tym samym kontenerze (`POST /qnap/polecenia`, token wewnętrzny jak w `--api`), bo tylko on ma połączenie WebSocket ze sterownikiem, i czeka na wynik do 20 s. Wypisuje wynik (JSON: status HTTP QNAP-a i jego odpowiedź) na standardowe wyjście, status żądania na wyjście błędów; kod wyjścia 0 tylko przy statusie 200, 2 przy złym poleceniu, 1 w innych przypadkach. ROOT_ID trzeba podać tylko wtedy, gdy połączonych jest kilka sterowników `co`.

Klient w trybie deweloperskim łączy się z serwerem na porcie 4001 pod tym samym hostem, z którego otwarto stronę; w produkcji z adresem z `VITE_SERVER_URL`, a bez tej zmiennej z `https://dom.mojeturnie.pl`. Wartość `same-origin` oznacza adres, z którego otwarto stronę. Adresy są w `client/src/core/http.ts`.

## Polecenia dla QNAP-a przez sterownik `co` (próbnie)

Od 2026-11-13, polecenie właściciela („ad 1 zrób”). Gdy QNAP w domu nie jest widoczny z zewnątrz (np. zawiesił się jego tunel do serwera w chmurze), a w sieci domowej działa, Claude może wysłać mu przez `co` jedno z trzech poleceń: `stan`, `restart_sieci`, `restart`. Gdy karta sieciowa QNAP-a nie ma łącza, żadne żądanie przez sieć do niego nie dotrze. Ok. 2026-12-13 sprawdzamy, czy było używane; bez użycia usuwamy całość: usługę na QNAP-ie, obsługę `qnap` w firmware `co`, polecenie `--qnap` (`qnap.service.ts`, `qnap.controller.ts`, część `websocket.ts`) i klucz. Wiążąca umowa z usługą na QNAP-ie jest w prywatnym repozytorium `oracle-cloud` (`qnap/polecenia-przez-co.md`); to repozytorium jest publiczne, więc nie ma tu adresów ani kluczy.

1. `--qnap <polecenie> [ROOT_ID]` (`core/cli.ts`) woła `POST /api/qnap/polecenia {polecenie, rootId?}` z tokenem wewnętrznym. Kontroler przyjmuje tylko ten token (inaczej 403); w aplikacji nie ma przycisku.
2. Serwer (`qnap.service.ts`) sprawdza polecenie (400), klucz i adres (503) i wybiera połączony sterownik `co`: 409, gdy żadnego nie ma albo jest kilka bez `rootId`; 404 nieznany `rootId`; 400 `rootId` innego rodzaju.
3. **Ciało:** `{"wersja":1,"polecenie":"…","czas":<ms od 1970>,"nonce":"<32 znaki hex>"}` w UTF-8, najwyżej 1 KB; `nonce` z `crypto.randomBytes(16)`. **Podpis:** HMAC-SHA256 dokładnie tych bajtów; kluczem są 32 bajty odczytane z hex `QNAP_POLECENIA_KLUCZ`, wynik szesnastkowo małymi literami.
4. Wiadomość `{"typ":"qnap","id":"…","adres":"<QNAP_ADRES>","cialo":"<ciało jako tekst>","podpis":"<hex>"}` idzie istniejącym WebSocketem tylko do gniazda sterownika tego `co` (`sendToController`); przeglądarki z tym samym `rootId` jej nie dostają.
5. Sterownik wysyła ciało bez zmian `POST http://<adres>/polecenie` z nagłówkiem `X-Podpis` i odsyła `{"typ":"qnap_wynik","id":"…","status":<kod HTTP, 0 = brak połączenia>,"cialo":"<odpowiedź QNAP-a, ≤ 1 KB>"}`. Serwer przyjmuje wynik tylko z gniazda tego sterownika i czeka na niego do 20 s (`QNAP_CZEKAJ_MS`); potem zwraca status 0 i `brakOdpowiedziSterownika`.
6. **Dziennik operacji `co`:** `QNAP: <polecenie> — HTTP <status>` (albo `— sterownik nie połączył się z QNAP-em`, `— brak odpowiedzi sterownika w 20 s`), status `done` przy HTTP 200, inaczej `error`, aktor system, źródło „Polecenie na serwerze (--qnap)”. Nic więcej nie trafia do bazy ani do `hp/add`; odpowiedź QNAP-a jest tylko w wyniku polecenia, a konsola serwera notuje samo id i status.

Stronę sterownika opisuje [dokumentacja techniczna `co`](../../../devices/co/docs/3-dokumentacja-techniczna.md#polecenia-dla-qnap-a-od-140-próbnie).

## Obraz Docker (Oracle)

Na `vm-prod` serwer i klient działają w jednym obrazie (`deploy/oracle/Dockerfile`). Praca lokalna nie używa Dockera.

| Gałąź | Kanał | Obraz na `vm-prod` |
|---|---|---|
| `main` | produkcja | `my-home:prod-<commit>` |
| `develop` | test | `my-home:test-<commit>` |

Od 2026-11-08 obraz buduje sam serwer: `oracle-cloud/vm-prod/.deploy-my-home/deploy-my-home.sh prod|test [commit]` wysyła `git archive` wybranego commitu (domyślnie `origin/main` albo `origin/develop`) przez ssh do `docker build` na `vm-prod` i instaluje go. Do repozytorium trafiają więc tylko pliki z gita. W każdym kanale zostaje aktualna wersja i 2 poprzednie. Wcześniej obraz budował GitHub Actions i publikował w `ghcr.io`. Sekrety są tylko w plikach środowiskowych na serwerze, nie w obrazie.

## Środowisko lokalne i dane demonstracyjne

```bash
npm run local                    # baza (27027, .local-db/), serwer (4001), aplikacja (5173)
node scripts/seed-local.mjs      # czyści bazę lokalną i wczytuje dane demo
```

`scripts/seed-local.mjs` pisze tylko do bazy lokalnej. Z produkcji czyta (publiczne GET) telemetrię pompy i PV z ostatnich dni i zmienia w niej identyfikatory na zmyślone; dane hydroforu generuje (kilka miesięcy uruchomień i odczyty wodomierza). Po wczytaniu trzeba zrestartować serwer lokalny, bo trzyma dane w pamięci.

## Testy

- `server/test/app.test.ts` — urządzenia (zgłoszenie, nazwa, domyślny, nieznany rootId) i API pompy; baza `mongodb-memory-server`.
- `server/test/water-pressure-tank.test.ts` — m.in. zgłoszenie hydroforu z ustawieniami, 404/409 kontekstu.
- `server/test/pellet-boiler-pelux200.test.ts` — m.in. dwie role tego samego SN (dwa `rootId`, routing po rodzaju endpointu, 409 dla `rootId` innej roli), zgłoszenie kotła z `settings`, walidacja `poll_interval_seconds` w `PUT /device/properties`.
- Pliki `pv.test.ts` i `scheduler.test.ts` (pompa) leżą w tym samym katalogu `server/test/`; razem serwer ma 218 testów (przebieg 2026-10-21, 17 plików, wszystkie przeszły; w tym język konta, mail i błąd po angielsku z `Accept-Language`, treść push i kafelki po angielsku).
- `server/test/qnap.test.ts` (od 2026-11-13) — polecenia dla QNAP-a: podpis HMAC-SHA256 (stały wektor testowy, klucz z hex, nie z tekstu) i ciało z losowym `nonce`, czytelne błędy (tylko token wewnętrzny, nieznane polecenie, brak klucza, adresu i połączonego `co`), wiadomość tylko do gniazda sterownika, wynik `qnap_wynik` i wpis w dzienniku operacji, polecenie `--qnap` z kodem wyjścia.
- Klient nie ma testów jednostkowych; sprawdzenie to `tsc` i `vite build` oraz test układu `node test/e2e/run-layout.mjs` (Chromium Playwright; wszystkie rodzaje × widoki × 360 / 768 / 1280 px × motyw ciemny / jasny: przewijanie w poziomie, elementy poza oknem, błędy konsoli, pasek, boczne menu / dolna nawigacja).

```bash
npx tsc -p server/tsconfig.tests.json --noEmit
npm test -w server -- --run
npm run build -w client
node test/e2e/run-layout.mjs
```

## Wdrożenie

Serwer i klient wdraża się razem z gałęzi `main`: GitHub buduje obraz, a instalację uruchamia `oracle-cloud/vm-prod/.deploy-my-home/deploy-my-home.sh prod`. Zmiana w core, która zmienia API, wymaga, by serwer był wdrożony przed firmware.

## Znane problemy

- **Endpointy sterownika bez autoryzacji.** Klucza API nie ma (nieaktywny `verifyApiKey` i nagłówek `x-api-key` usunięte 2026-10-27); aplikację chronią sesje kont, a endpointy z `controllerPaths` przyjmują sam SN.
- **Dane w pamięci serwera** (`device-info.service.ts`, ostatnia telemetria, operacje ręczne) giną przy restarcie; po zmianie `deviceId` w bazie trzeba zrestartować serwer.
- **Położenie domu** do pogody jest wpisane w kod (`WEATHER_LOCATION` w `meteo.service.ts`).
- **Pogodę i pocztę obsługuje tylko serwer** (od 2026-11-13, bez zapasu w sterownikach). Gdy serwer nie dostanie pogody z Open-Meteo, kafelki pokazują ostatni odczyt (do 45 min), potem prognozę; bez `SMTP_HOST` maile trafiają tylko do skrzynki w pamięci i do dziennika serwera.
- **Gniazdo sterownika rozpoznaje tylko powitanie `ESP32`** (polecenia dla QNAP-a). WebSocket nie ma uwierzytelnienia, więc ktoś znający Root ID `co` mógłby odebrać podpisane polecenie albo odesłać fałszywy wynik. Polecenia nie zmieni bez klucza, a usługa na QNAP-ie odrzuca polecenie stare albo powtórzone.
- **SN a rodzaj.** Zgłoszenie, `POST /devices` i `device-context` dla ścieżek z `controllerPaths` szukają urządzenia po parze (rodzaj, SN), więc ten sam SN może mieć kilka urządzeń różnych rodzajów (role `co`). Ścieżka sterownika, której brakuje w `controllerPaths`, dla samego `deviceId` dostaje 400, a dla `rootId` nie sprawdza rodzaju; nowy endpoint sterownika trzeba tam dopisać.
- **`PUT /device/properties` podmienia całe `properties`** — pominięte klucze znikają. Klient zawsze wysyła komplet pól swojego rodzaju.
- **Rodzaj urządzenia jest sprawdzany tylko na endpointach sterownika** (`controllerPaths`: niezgodny rodzaj daje 409). Pozostałe endpointy modułów (np. `GET /hp` z `rootId` hydroforu) go nie sprawdzają.
- **Nowa pompa ciepła nie dostaje `properties`** przy zgłoszeniu (`initialProperties` pompy jest puste); tryb `CWU` wynika z wartości zastępczej w schedulerze.
- **WebSocket** przyjmuje połączenie na dowolnej ścieżce i nie sprawdza, czy `rootId` istnieje; komunikat trafia do wszystkich połączeń danego `rootId` (przeglądarki dostają też `operation`, a `co` — `update`); wyjątek to `qnap`, który idzie tylko do gniazda sterownika.
- **Obsługa błędów w kliencie (`core/http.ts`)**: `get` zwraca `null`, `post` połyka błąd (z `json = false` zwraca `Response`), `put` i `delete` rzucają wyjątek — różne ekrany różnie więc pokazują błędy zapisu.
- **Style stron trafiają do jednego pakietu CSS** — reguły bez prefiksu w `pages/style.css` rodzajów działają w całej aplikacji; wspólne komponenty są w `makieta.css`, a kolory tylko z tokenów `theme.css`.
