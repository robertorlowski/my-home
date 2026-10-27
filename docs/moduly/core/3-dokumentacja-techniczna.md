# Moduł core — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/core/3-technical-documentation.md)

## Pliki — serwer (`server/src`)

| Plik | Rola |
|---|---|
| `server.ts` | punkt startowy: MongoDB, scheduler pompy, czyszczenie paneli PV, meteo, nasłuch HTTP i WebSocket |
| `core/app.ts` | aplikacja Express: CORS, JSON, `device-context` i trasy pod `/api` |
| `core/routes.ts` | składa trasy: urządzenia i `/temperature` z core oraz `routes.ts` każdego modułu |
| `core/types.ts` | `DeviceType`, `WeekDay` (dni harmonogramu pompy i włącznika), `Device`, `DeviceProperties` (jedno pole ustawień dla wszystkich rodzajów), `DeviceTypeModule` |
| `core/device-types.ts` | rejestr rodzajów sterowników: `DeviceType` → opis modułu (`device-type.ts`) |
| `core/time.ts` | `TIME_ZONE = Europe/Warsaw`, granice doby w Warszawie jako zakres UTC |
| `core/websocket.ts` | serwer WebSocket (`/ws?rootId=`), `sendMessage(typ, rootId)` z opóźnieniem 1 s |
| `core/middleware/device-context.ts` | ustala urządzenie z `rootId` albo (dla ścieżek sterownika z mapy `controllerPaths`) z pary `{deviceId, deviceType}`; 400/404/409 |
| `core/models/device.model.ts` | model Mongoose `devices`: schemat urządzenia, `properties`, osadzone harmonogramy i starsze `settings` |
| `core/controllers/device.controller.ts` | obsługa tras urządzeń; odpowiedź zgłoszenia z `settings` z rejestru; zlecenie i odwołanie aktualizacji firmware |
| `core/controllers/meteo.controller.ts` | `GET /temperature` |
| `core/controllers/firmware.controller.ts` | `/firmware/:rodzaj...`: stan, wgranie pliku, oferta, pobranie; tylko rodzaje z `firmwareUpdates` |
| `core/models/firmware.model.ts` | `firmware_images` (plik `.bin`, rozmiar, SHA-256) i `firmware_offers` (oferowana i poprzednia wersja, `enabled`) |
| `core/services/firmware.service.ts` | zapis i walidacja obrazu (nagłówek ESP32, ≤ 1 310 720 B), zlecenie aktualizacji (`requestFirmwareUpdate`, `cancelFirmwareUpdate`), oferta dla sterownika tylko przy zleceniu (`firmwareOfferForDevice`, `firmwareOfferForRoot`), przycinanie do bieżącej i jednej poprzedniej wersji |
| `core/services/device.service.ts` | lista, utworzenie, zgłoszenie, nazwa, domyślny, odczyt i zapis `properties` |
| `core/services/device-info.service.ts` | typ i `deviceId` urządzenia w pamięci (do rekordów danych modułów) |
| `core/services/calendar.service.ts` | polskie święta, dzień tygodnia w Warszawie, `scheduleDayMatches` (czy wpis harmonogramu włącznika dotyczy danej daty) |
| `core/services/meteo.service.ts` | temperatura ze stacji IMGW Zakopane; pogoda z włącznika w pamięci po id kafelka (dom też pod `home`), odczyt starszy niż 45 min pomijany; temperatura domu z czujnika kotła albo prognozy |
| `core/services/weather-tile.service.ts`, `models/weather-tile.model.ts`, `controllers/weather-tile.controller.ts` | kafelki pogody `weather_tiles` (`home` z `WEATHER_LOCATION`, najwyżej 8 na konto), `weatherQueries` — miejsca dla włącznika |
| `core/services/mail.service.ts` | `sendMail`: przy `MAIL_RELAY=1` składa MIME (`MailComposer`) i odkłada w `mail_outbox`, inaczej SMTP wprost; `assertMailAvailable` (503 bez sterownika); treść po polsku albo angielsku (`lang`: język konta odbiorcy, inaczej żądania; `mailLang`) |
| `core/services/mail-relay.service.ts`, `models/mail-outbox.model.ts`, `controllers/mail-relay.controller.ts` | przekaźnik poczty: klucze płytek (`mailKey`, `mailKeyPending`, zatwierdzanie), szyfrowanie `encryptFor` (ECDH P-256 + AES-256-GCM), kolejka i dzierżawa maili (`FAILOVER_MS` 20 s, `LEASE_MS` 60 s, 3 próby, 15 min), `GET /mail/config`, `GET /mail/next`, `POST /mail/result` |
| `core/services/push.service.ts`, `push-watchdog.service.ts`, `models/push-subscription.model.ts`, `controllers/push.controller.ts` | powiadomienia Web Push: katalog zdarzeń `PUSH_EVENTS`, `notify`, cisza nocna, próg 60 s, kasowanie wygasłych subskrypcji, `body` jako `Texts {pl, en}` dobierane do języka odbiorcy; wartownik offline / online z kafelków co minutę; `/push/*` |
| `core/services/auth.service.ts` (`demoLogin`, `demoAvailable`), `core/middleware/session.ts` (`scrubDemo`), `core/services/access.service.ts` (rola `demo`) | wersja demo: sesja tylko do odczytu na koncie z `DEMO_OWNER_EMAIL`, blokada zapisów, usuwanie danych wrażliwych z odpowiedzi |
| `core/services/tile-layout.service.ts`, `tile.service.ts`, `tile-format.ts` | układ kafelków konta (`users.deviceOrder`, `hiddenTiles`) i dane kafelków `GET /devices/summary` (z `tile.ts` każdego modułu) |
| `core/i18n.ts` | słownik serwera pl / en: `requestLang(req)` (`Accept-Language` → `users.language` → pl), `t(lang, key, params)`, `both(fn)` (tekst w obu językach dla push), `pick`, `tabLabel`, `userLanguage`; z niego teksty kafelków (`tile-format.ts`, `tile.ts` modułów z parametrem `lang`), błędów `AuthError` / `PushError` / `MailUnavailableError` (`messageFor(lang)`), maili i powiadomień |

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
| `core/pages/Login/` | ekran logowania (karta `.auth-card`): e-mail → kod (6 cyfr, 10 min) albo link z maila; „system” pokazuje pole hasła użytkownika systemowego |
| `core/pages/Account/`, `components/ProfileForm.tsx`, `RememberDialog.tsx`, `account.css` | `/account` „Moje dane”: karty „Moje dane” (e-mail ze zmianą przez kod, imię, nazwisko, adres, kraj, lokalizacja na mapie), „Sesja” i „Usunięcie konta” (`.card-danger`, potwierdzenie linkiem z maila); okno „Zapamiętać?” |
| `core/pages/Operations/` | zakładka `/operations` (pompa, hydrofor, włącznik, piec): dziennik operacji z dnia (`GET /operations?date=`, 5 dni), filtr Wszystkie / Użytkownik / System, karta „Zaplanowane” (dziś) i oś czasu `.timeline` z chipem stanu; dziś odświeżanie co 30 s i po WebSocket `update` |
| `core/components/DeviceEditModal.tsx` | okno „Dane sterownika” (`.modal`): nazwa, rodzaj, SN i Root ID tylko do odczytu, pola rodzaju z rejestru (`DefinitionFields`, np. konfiguracja pompy ciepła), przełącznik „Kafelek prosty” dla rodzajów z `SimpleTile` w rejestrze (`PUT /devices/:rootId {simple}`, tylko konto); z kafelka i z karty „Sterownik” |
| `core/components/ControllerCard.tsx`, `ControllerCardTitle.tsx`, `DeviceAddress.tsx` | karta „Sterownik” w Ustawieniach każdego rodzaju: ołówek (okno „Dane sterownika”), lista `.kv`: Nazwa, SN, Root ID (skrócony, „kopiuj”), Adres IP (odnośnik do stron sterownika), Firmware z chipem stanu, Ostatnie zgłoszenie, przycisk „Aktualizuj firmware” |
| `core/components/FirmwareStatus.tsx` | wiersze „Firmware” i „Ostatnie zgłoszenie” oraz przycisk „Aktualizuj firmware” / „Anuluj aktualizację” (z potwierdzeniem) karty „Sterownik”; stan „aktualny” / „dostępna wersja X” / „zlecona, czeka na sterownik”, podpowiedź rodzaju (`firmwareUpdateHint`); przy zleceniu odświeżanie co 15 s; przy aktualnej wersji bez przycisku, przy pracującej sprężarce pompy ciepła albo włączonym przekaźniku włącznika przycisk nieaktywny z komunikatem („Sprężarka pracuje.”, „Przekaźnik włączony.”; stan z `GET /devices/summary`) |
| `core/components/DeviceSharing.tsx` | karta „Udostępnianie” w Ustawieniach: lista osób z zakładkami, okno „Udostępnij sterownik” (e-mail, wybór „Pełna aplikacja” z zakładkami rodzaju albo „Panel prosty” = `tabs: ['simple']`), zmiana zakładek i cofnięcie dostępu; tylko właściciel i użytkownik systemowy |
| `core/components/OfflineBanner.tsx` | czerwony pasek „Offline od …” z przyczyną na górze ekranu sterownika (`.banner.banner-off`) |
| `core/components/Notification.tsx` | krótki komunikat na górze ekranu |
| `core/components/icons.tsx`, `pictograms.tsx`, `WeatherIcon.tsx` | wspólne ikony menu i akcji, piktogramy rodzajów, ikony nieba |
| `core/components/IconButton.tsx`, `iconButton.css` | szablon przycisku-ikony (sama ikona, wariant danger do usuwania, etykieta jako podpowiedź i aria-label) |
| `core/components/InfoTip.tsx` | ikona „i” z podpowiedzią |
| `core/pages/Devices/`, `components/DeviceTileCard.tsx` | lista sterowników `/devices`: pasek pogody domu (`.outdoor-strip`; ikona nieba `WeatherCodeIcon` przed temperaturą; źródło „Open-Meteo · X min temu” tekstem, na telefonie ukryte), szachownica kafelków `.tiles` w stałym układzie makiety (`DeviceTileCard`: nagłówek z ikoną rodzaju, nazwą, chipem i narzędziami, duża wartość, stan pracy, pola faktów, ostrzeżenie, przekaźniki włącznika, stopka „dane sprzed …”; od 2026-10-27 chip Włączony / Wyłączony z pola `power` (pompa, kocioł, hydrofor) zamiast Online / Offline, a brak odpowiedzi to linia `note` z `icon: 'offline'` (ikona `OfflineIcon` z `OfflineBanner`); `WeatherTileCard` dla pogody; sterownik z `device.simple` rysuje `SimpleTile` rodzaju z rejestru — `devices/switch/components/SimpleTile.tsx`, `devices/pellet-boiler-pelux200/components/SimpleTile.tsx`, wspólny `core/components/simpleTile.css` — kafelek nie jest wtedy odnośnikiem, pełne widoki otwiera nazwa), siatka auto-fill ≥ 300 px (1–4 kolumny), tryb „Zmień układ” (ikona siatki w pasku: strzałki, oko, „+ kafelek pogody”, „Gotowe”, pusty wiersz spycha resztę do dołu ekranu), stopka z zajętością bazy (`/devices/db-stats`, użytkownik systemowy); dane kafelków z `GET /devices/summary`, odświeżane po WebSocket `update` i cyklicznie |
| `core/components/WeatherTileModal.tsx`, `LocationPicker.tsx` | okno „Kafelek pogody” (`.modal`): wyszukiwarka miejscowości (geokoder Open-Meteo z przeglądarki), współrzędne, usuwanie; wybór lokalizacji na mapie (konto) |
| `core/pages/Weather/` (`index.tsx`, `nav.tsx` (pasek i zakładki w bocznym menu / dolnej nawigacji jak widoki sterownika, od 2026-10-19), `NowTab`, `DaysTab`, `SunTab`, `HeatingTab`, `AirTab`, `WindTab`, `forecast.ts`, `style.css`), `core/currentPlace.ts` | strona pogody `/weather/:id` (kliknięcie kafelka pogody; makieta `#pogoda-*`): zakładki w `?tab=` — Teraz, Najbliższe dni, Słońce i PV (prognoza produkcji dopasowana do DTU), Ogrzewanie (okno CWU w G12w), Powietrze, Wiatr i opady; bieżące warunki z `GET /weather-tiles`, prognoza i jakość powietrza wprost z Open-Meteo (`forecast.ts`); kafelek „Moja lokalizacja” (`current`) z położeniem z przeglądarki |
| `core/components/MailKeyRow.tsx` | wiersz „Poczta” karty „Sterownik” (włącznik, pompa ciepła): stan klucza płytki (zatwierdzony / czeka / brak, odcisk), „Zatwierdź” po porównaniu z `/install` i „Usuń” — tylko użytkownik systemowy |
| `core/components/PushSettingsCard.tsx`, `core/push.ts`, `public/sw.js` | karta „Powiadomienia” na `/account` (subskrypcja tej przeglądarki, lista przeglądarek, reguły, cisza nocna, próbne), rejestracja service workera i subskrypcji PushManager, odbiór powiadomień i otwarcie aplikacji po kliknięciu |
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
| `POST` / `DELETE /devices/:rootId/mail-key` | publiczna (użytkownik systemowy) | zatwierdzenie `{fingerprint}` / usunięcie klucza płytki przekaźnika poczty | 200; 403; 404; 409 |
| `GET /push/settings`, `POST /push/subscriptions`, `DELETE /push/subscriptions/:id`, `PUT /push/rules`, `POST /push/test` | zalogowany, bez `rootId` | ustawienia powiadomień (klucz VAPID, subskrypcje, reguły, katalog zdarzeń, sterowniki), subskrypcja przeglądarki, reguły `{rules: [{rootId, events}], quietFrom, quietTo}`, powiadomienie próbne | 200; 201; 204; 400; 403; 404; 409; 503 |
| `GET /auth/demo`, `POST /auth/demo` | publiczna | wersja demo: dostępność `{available}` / sesja tylko do odczytu (404 bez `DEMO_OWNER_EMAIL`, 429 przy nadmiarze wejść) | 200; 404; 429 |
| `PUT /auth/me/language` | sesja | język konta `{language: "pl" | "en"}`, zapisywany w `users.language` i zwracany w `/auth/me` | 200; 400 |
| `GET /mail/config`, `GET /mail/next`, `POST /mail/result` | sterownik (`?rootId=&deviceId=`, bez logowania) | dane SMTP zaszyfrowane kluczem płytki; następny mail (zaszyfrowany, z dzierżawą); wynik `{id, ok, receipt, error?}` | 200; 204 brak maila; 403 klucz niezatwierdzony |

WebSocket: `ws(s)://<serwer>/ws?rootId=<rootId>`. Serwer wysyła `{"type":"operation"|"update","rootId":"…"}`; połączenie bez `rootId` jest zamykane kodem 1008.

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
| `MAIL_RELAY=1` | maile wysyłają sterowniki (przekaźnik poczty) zamiast serwera; na Render obowiązkowe, bo darmowy plan blokuje SMTP (porty 25, 465, 587) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | powiadomienia Web Push; bez kluczy wyłączone (para: `npx web-push generate-vapid-keys` w `server/`) |
| `DEMO_OWNER_EMAIL` | e-mail konta pokazywanego w wersji demo tylko do odczytu; bez wartości przycisku „Zobacz wersję demo” nie ma |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_ADMIN` | konto pocztowe (przy `MAIL_RELAY=1` przekazywane zaszyfrowane płytkom); nadawca `MyHome <SMTP_USER>`, odpowiedzi na `MAIL_FROM` |
| `CLIENT_URL`, `SYSTEM_PASSWORD`, `INITIAL_OWNER_EMAIL`, `AUTH_DISABLED=1` | adres aplikacji w linkach z maili, hasło konta „system”, pierwszy właściciel, wyłączenie logowania (środowisko lokalne) |
| `WEATHER_LOCATION` | współrzędne domu dla kafelka pogody „Dom” |

Wartości są tylko w zmiennych środowiskowych: na Render w Environment usługi, lokalnie w `server/.env` (poza gitem, wzór `server/.env.example`).

Klient w trybie deweloperskim łączy się z serwerem na porcie 4001 pod tym samym hostem, z którego otwarto stronę; w produkcji z `https://chpc-web.onrender.com`. Adresy są w `client/src/core/http.ts`.

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
- Klient nie ma testów jednostkowych; sprawdzenie to `tsc` i `vite build` oraz test układu `node test/e2e/run-layout.mjs` (Chromium Playwright; wszystkie rodzaje × widoki × 360 / 768 / 1280 px × motyw ciemny / jasny: przewijanie w poziomie, elementy poza oknem, błędy konsoli, pasek, boczne menu / dolna nawigacja).

```bash
npx tsc -p server/tsconfig.tests.json --noEmit
npm test -w server -- --run
npm run build -w client
node test/e2e/run-layout.mjs
```

## Wdrożenie

Serwer i klient wdraża się razem z gałęzi `main` na Render (build uruchamiany ręcznie). Zmiana w core, która zmienia API, wymaga, by serwer był wdrożony przed firmware.

## Znane problemy

- **Endpointy sterownika bez autoryzacji.** Klucza API nie ma (nieaktywny `verifyApiKey` i nagłówek `x-api-key` usunięte 2026-10-27); aplikację chronią sesje kont, a endpointy z `controllerPaths` przyjmują sam SN.
- **Dane w pamięci serwera** (`device-info.service.ts`, ostatnia telemetria, operacje ręczne) giną przy restarcie; po zmianie `deviceId` w bazie trzeba zrestartować serwer.
- **Stacja IMGW** jest wpisana w kod (`meteo.service.ts`, Zakopane).
- **Poczta i pogoda zależą od sterowników w domu.** Bez włącznika (i `co` z zatwierdzonym kluczem) logowanie kodem dostaje 503, a pogoda kafelków nie odświeża się (zostaje prognoza). Endpointy `/mail/*` przyjmują sam SN; bez zatwierdzenia klucza w aplikacji ktoś znający SN mógłby podstawić własny klucz — dlatego nowy klucz czeka na użytkownika systemowego.
- **SN a rodzaj.** Zgłoszenie, `POST /devices` i `device-context` dla ścieżek z `controllerPaths` szukają urządzenia po parze (rodzaj, SN), więc ten sam SN może mieć kilka urządzeń różnych rodzajów (role `co`). Ścieżka sterownika, której brakuje w `controllerPaths`, dla samego `deviceId` dostaje 400, a dla `rootId` nie sprawdza rodzaju; nowy endpoint sterownika trzeba tam dopisać.
- **`PUT /device/properties` podmienia całe `properties`** — pominięte klucze znikają. Klient zawsze wysyła komplet pól swojego rodzaju.
- **Rodzaj urządzenia jest sprawdzany tylko na endpointach sterownika** (`controllerPaths`: niezgodny rodzaj daje 409). Pozostałe endpointy modułów (np. `GET /hp` z `rootId` hydroforu) go nie sprawdzają.
- **Nowa pompa ciepła nie dostaje `properties`** przy zgłoszeniu (`initialProperties` pompy jest puste); tryb `CWU` wynika z wartości zastępczej w schedulerze.
- **WebSocket** przyjmuje połączenie na dowolnej ścieżce i nie sprawdza, czy `rootId` istnieje; komunikat trafia do wszystkich połączeń danego `rootId` (przeglądarki dostają też `operation`, a `co` — `update`).
- **Obsługa błędów w kliencie (`core/http.ts`)**: `get` zwraca `null`, `post` połyka błąd (z `json = false` zwraca `Response`), `put` i `delete` rzucają wyjątek — różne ekrany różnie więc pokazują błędy zapisu.
- **Style stron trafiają do jednego pakietu CSS** — reguły bez prefiksu w `pages/style.css` rodzajów działają w całej aplikacji; wspólne komponenty są w `makieta.css`, a kolory tylko z tokenów `theme.css`.
