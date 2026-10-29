# Moduł switch — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/switch/3-technical-documentation.md)

## Pliki — serwer (`server/src/modules/switch`)

| Plik | Rola |
|---|---|
| `routes.ts` | trasy `/switch/*` |
| `device-type.ts` | wpis do rejestru: `initialProperties` (`default_on_minutes: 30`), `controllerSettings` (`{default_on_minutes}` w odpowiedzi na zgłoszenie), `firmwareUpdates: true` (OTA na zlecenie „Aktualizuj”), `onRegister` (przekaźniki z pola `relays` zgłoszenia) |
| `types.ts` | `RelayMode`, `CommandSource`, `ActivationSource`, `SwitchRelay`, `SwitchSchedule`, `SwitchActivation`, `RelayReport`, `RelayCommand`, `timePattern` |
| `controllers/switch.controller.ts` | obsługa tras; budzenie sterownika (`sendMessage('operation')`) po zmianie trybu i harmonogramu, `update` dla przeglądarek po zmianie stanu; oferta firmware w odpowiedzi na stan (`firmwareOfferForRoot`) |
| `services/switch.service.ts` | przekaźniki (`ensureRelays`), polecenie (`relayCommand`), zgłoszenie stanu (`parseStateReport`, `reportState`), historia (`recordActivation`), tryb (`setRelayMode`), nazwy, lista dla aplikacji (`listRelays`), włączenia (`listActivations`) |
| `services/switch-schedule.service.ts` | okna harmonogramu (`scheduleWindow`, `activeSchedule` z łączeniem okien, `nextScheduleStart`), walidacja wpisu (`parseSchedule`), zapis, podmiana, usunięcie |
| `models/switch-relay.model.ts` | kolekcja `switch_relays` |
| `models/switch-schedule.model.ts` | kolekcja `switch_schedules` |
| `models/switch-activation.model.ts` | kolekcja `switch_activations` |

Zmiany w `core` dla włącznika: `DeviceType.SWITCH`, `WeekDay` przeniesione do `core/types.ts` (moduł heat-pump je re-eksportuje), `scheduleDayMatches` w `core/services/calendar.service.ts` (czy wpis dotyczy danej daty w Warszawie), `onRegister` w `DeviceTypeModule` (wołane przez `POST /devices/register` po zapisie urządzenia), `default_on_minutes` w `DeviceProperties` i schemacie `properties`, ścieżki `/switch/state` i `/switch/mode` w `controllerPaths`.

## Pliki — klient (`client/src/devices/switch`)

| Plik | Rola |
|---|---|
| `device-type.tsx` | wpis do rejestru: ikona przełącznika, menu Włącznik, Harmonogram, Ustawienia, Dane, Operacje (bez wykresu), `firmwareUpdates: true`, `firmwareUpdateHint` |
| `api.ts` | `SwitchRequests` |
| `types.ts` | `RelayMode`, `SwitchRelay`, `SwitchSchedule`, `SwitchActivation` |
| `pages/Home.tsx` | układ „Instrument”: karta na przekaźnik `.card-relay` (przełącznik stanu, opis trybu, pasek Offline, odliczanie albo następny start, Włącz / Wyłącz / Harmonogram, czas włączenia h / min), karta „Dziś”; odświeżanie co 5 s i WebSocket `update` |
| `pages/Data.tsx` | pasek filtrów (dzień strzałkami albo z kalendarza, przyciski przekaźników, CSV) i karta „Włączenia w dniu” (`components/ActivationsTable.tsx`) |
| `pages/Schedules.tsx` | karta na przekaźnik z chipem trybu i listą wpisów `.entries` („działa teraz”, wpisy nieaktywne wyszarzone), okno wpisu `.modal` |
| `pages/Settings.tsx` | dwie kolumny: karty „Przekaźniki” i „Czas włączenia”, po prawej karta „Sterownik” (`ControllerCard` z `core`) i „Udostępnianie” (`DeviceSharing`) |
| `components/ActivationsTable.tsx`, `components/icons.tsx` | tabela włączeń (widok główny i Dane), ikony włącznika |
| `pages/style.css` | style widoków włącznika |
| `utils/format.ts` | czasy w Warszawie, opis trybu (`describeMode`), odliczanie, czas w dniu dla włączeń przez północ (`secondsInDay`), CSV |

## API

| Metoda i ścieżka | Kto | Opis |
|---|---|---|
| `POST /switch/state` | sterownik | `{uptimeS?, relays: [{on, changedS}], diag?, weather?}` (`diag` — diagnostyka firmware, `weather` — pogoda z Open-Meteo, punkt 5d CLAUDE.md; 1–16 przekaźników, `changedS` ≥ 0); sam `deviceId` wystarcza, 404/409 jak w core; odpowiedź 200 `{relays: [{on, offAfterS?, mode}], firmware?, weather_query?, weather_queries?}` (miejsca pogody tylko przy pierwszym zgłoszeniu po starcie serwera, zmianie listy, restarcie płytki i co 10 min) (`firmware: {version, url, sha256, request}` tylko przy zleceniu „Aktualizuj”; firmware od 1.1.0 aktualizuje się z niej bez restartu); złe dane 400 |
| `PUT /switch/mode` | aplikacja, sterownik | `{relay, mode, minutes?, source?}`; `mode`: `schedule`, `on`, `timer`, `off`, `pause` (wyłączony do końca bieżącego okna harmonogramu, poza oknem = `schedule`); `minutes` tylko dla `timer`, pełne 1–10080; `source: "controller"` albo żądanie z samym `deviceId` = zmiana ze sterownika; odpowiedź: przekaźnik jak w `GET /switch/relays`; 400 zły tryb, numer, czas albo nieznany przekaźnik |
| `GET /switch/relays` | aplikacja | przekaźniki: `relay`, `name`, `mode` (timer i pause po czasie już jako `schedule`), `modeSource`, `modeChangedAt`, `on`, `changedAt`, `lastSeenAt`, `online`, `desiredOn`, `until`, `scheduleId` (wpis działający teraz), `nextStart` |
| `PUT /switch/relays/:relay` | aplikacja | `{name}` (najwyżej 40 znaków, pusta = „Przekaźnik N”); 404 nieznany przekaźnik |
| `GET /switch/schedules` | aplikacja | wszystkie wpisy (także wyłączone), po przekaźniku i godzinie startu |
| `POST /switch/schedules` | aplikacja | `{relay, dayOfWeek \| date, startTime, endTime, enabled?}`; `relay` 1…liczba przekaźników, godziny `HH:mm`, `dayOfWeek` −3…6 (bez `date`); 201; 400 z opisem błędu |
| `PUT /switch/schedules/:id` | aplikacja | pełna podmiana wpisu (pominięte `date` albo `dayOfWeek` znika); 404; 400 |
| `DELETE /switch/schedules/:id` | aplikacja | 200 `{}`; 404; 400 zły identyfikator |
| `GET /switch/activations?date=YYYY-MM-DD[&relay=N]` | aplikacja | włączenia nachodzące na dzień (Warszawa), także zaczęte dzień wcześniej i trwające, rosnąco po `onAt`, z `durationS` (dla trwających do teraz); aplikacja filtruje przekaźnik u siebie i nie używa `relay` |
| `GET /switch/diagnostics` | aplikacja | ostatnia diagnostyka sterownika z pamięci serwera (do restartu) albo `{}`: `reset`, `resetText`, `boot`, `bootAt`, `uptimeS`, `wifiDrops`, `rssi`, `httpMs`, `at`; od firmware 1.3.2 także `heapFree`, `heapMin`, `heapBlock` (bajty) i `weather {places, ok, fail, code, tls, heapBlock, agoS}` (opis pól: dokumentacja techniczna firmware włącznika) |

Zgłoszenie (`POST /devices/register`, moduł core) z `deviceType: "switch"` przyjmuje dodatkowo `relays` (liczba całkowita 1–16): `onRegister` tworzy przekaźniki od razu. Odpowiedź niesie `settings: {default_on_minutes, firmware?}` (`firmware` tylko przy zleceniu aktualizacji, `POST /devices/:rootId/firmware-update`, moduł core). Ustawienie zapisuje wspólne `PUT /device/properties` (moduł core).

## Model danych

**`switch_relays`** — jeden dokument na `{rootId, relay}` (indeks unikalny):

| Pole | Opis |
|---|---|
| `rootId`, `deviceId`, `relay` | identyfikacja; `relay` od 1 |
| `name` | nazwa (≤ 40 znaków, domyślnie pusta) |
| `mode`, `until` | tryb `schedule` \| `on` \| `timer` \| `off` \| `pause` (domyślnie `schedule`); `until` — koniec trybu `timer` albo `pause` |
| `modeSource`, `modeChangedAt` | kto i kiedy ustawił tryb (`app` \| `controller`) |
| `on`, `changedAt` | stan zgłoszony przez sterownik i chwila jego zmiany (`teraz − changedS`) |
| `lastSeenAt` | ostatnie zgłoszenie stanu (online < 5 min); zapisywane najwyżej raz na minutę, dokładny czas jest w pamięci serwera (od 2026-10-29) |
| `createdAt`, `updatedAt` | znaczniki zapisu |

**`switch_schedules`** — wpisy harmonogramu: `rootId`, `relay`, `enabled`, `dayOfWeek` (`WeekDay`), `date`, `startTime`, `endTime` (`HH:mm`); indeks `{rootId, relay}`. Osobna kolekcja, a nie `devices.schedules`: wpis ma numer przekaźnika i nie ma pól pompy (typ, temperatury, wymuszenie).

**`switch_activations`** — jedno włączenie: `rootId`, `deviceId`, `relay`, `onAt`, `offAt` (`null` = trwa), `source` (`schedule` \| `app` \| `controller`), `approximate`; indeksy `{rootId, onAt}` i `{rootId, relay, offAt}`.

**`devices.properties`** włącznika: `default_on_minutes` — domyślny czas „Włącz” w pełnych minutach 0–10080 (0 = bez limitu), domyślnie 30.

## Stałe

| Stała | Wartość | Gdzie |
|---|---|---|
| `MAX_RELAYS` | 16 | `switch.service.ts` (firmware: 8) |
| `MAX_TIMER_MINUTES` | 10080 (7 dni) | `switch.service.ts`, schemat `properties`, firmware `MAX_ON_MINUTES` |
| `OFFLINE_AFTER_MS` | 5 min | `switch.service.ts` |
| `BOOT_MARGIN_S` | 5 s (zapas przy rozpoznaniu restartu i nowego włączenia) | `switch.service.ts` |
| szukanie `nextStart` | 8 dni | `switch-schedule.service.ts` |
| łączenie okien | najwyżej 16 kroków | `activeSchedule` |
| ustawienia domyślne | `default_on_minutes` = 30 | `device-type.ts` |

## Testy i narzędzia

```bash
npm test -w server -- --run       # server/test/switch.test.ts: 13 testów (serwer razem: 109)
node scripts/simulate-switch.mjs [--relays N] [--history]   # symulator sterownika (npm run local)
```

`server/test/switch.test.ts` sprawdza: łączenie stykających się okien, okno przez północ należące do dnia startu, dni robocze bez świąt i wyłączny koniec okna, najbliższe włączenie, zgłoszenie z utworzeniem przekaźników i domyślnym czasem, polecenia w każdym trybie (także koniec timera), tryb `pause` (koniec okna, `schedule` w poleceniu dla sterownika, dane kafelka prostego), walidację trybu i czasu, zmianę trybu samym `deviceId` (strona sterownika), identyfikację jak w hydroforze (`deviceId`, 404, 409), historię z czasem ze sterownika, koniec włączenia na ostatnim zgłoszeniu po utracie zasilania, walidację, zmianę i usunięcie wpisu, zmianę nazwy przekaźnika.

Symulator (`scripts/simulate-switch.mjs`) zgłasza się z SN `4C0000000E2E` (albo `SIMULATED_SN`), co 5 s wysyła stan, wykonuje polecenia z lokalnym odliczaniem i reaguje na WebSocket `operation`; `--history` dopisuje wprost do bazy lokalnej włączenia z 7 dni.

## Znane problemy

- **`PUT /switch/mode` i `/switch/state` nie mają autoryzacji** (jak cały serwer): kto zna SN sterownika, może zmienić tryb przekaźnika.
- **`PUT /device/properties` podmienia całe `properties`** — aplikacja wysyła komplet pól; włącznik dostaje też `work_mode: CWU` z wartości domyślnej schematu (nieużywane).
- **Koniec trybu „na czas” w trakcie okna harmonogramu** (wynika z kodu, niesprawdzone na płytce): sterownik wyłącza przekaźnik po odliczeniu, a najbliższe zgłoszenie (zaraz po zmianie) dostaje polecenie włączenia z harmonogramu — krótka przerwa i dwa wpisy w historii.
- **`relay` w `GET /switch/activations`** jest nieużywany przez aplikację.
- **Historia nie ma retencji** — `switch_activations` rośnie bez ograniczeń (kilka dokumentów na dzień na przekaźnik).
- **Przyczyna włączenia (`source`)** jest zapisywana, ale aplikacja jej nie pokazuje (kolumnę „Źródło” usunięto z tabel i CSV).
