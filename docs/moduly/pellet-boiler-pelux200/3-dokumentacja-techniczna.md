# Moduł pellet-boiler-pelux200 — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/pellet-boiler-pelux200/3-technical-documentation.md)

## Pliki — serwer (`server/src/modules/pellet-boiler-pelux200`)

| Plik | Rola |
|---|---|
| `routes.ts` | trasy `/pellet-boiler-pelux200/*` |
| `device-type.ts` | wpis do rejestru: ustawienia domyślne nowego kotła (`poll_interval_seconds: 300`), pole `settings` w odpowiedzi na zgłoszenie i `firmwareUpdates: true` (OTA na zlecenie „Aktualizuj”, od firmware 1.5.0) |
| `types.ts` | `PelletBoilerPelux200Measurements` (pola pomiarowe), `PelletBoilerPelux200Entry` |
| `controllers/pellet-boiler-pelux200.controller.ts` | `add` (odpowiedź z odstępem odpytywania), `last`, `list` (doba warszawska) |
| `services/pellet-boiler-pelux200.service.ts` | `validateReading`, zapis, ostatni odczyt w pamięci (`lastByRoot`), zakres czasu, `getPollIntervalSeconds` |
| `models/pellet-boiler-pelux200.model.ts` | kolekcja `pellet_boiler_pelux200` |

Bez schedulera i bez serwisu operacji. Moduł importuje tylko z `core` (`device-info`, `DeviceModel`, `websocket`, `time`).

## Pliki — klient (`client/src/devices/pellet-boiler-pelux200`)

| Plik | Rola |
|---|---|
| `device-type.tsx` | wpis do rejestru: Kocioł, Statystyki, Harmonogram, Ustawienia, Alarmy, Dane, Operacje (ikona płomienia); `firmwareUpdates: true` (trybik firmware na kafelku, strona `/firmware/pellet-boiler-pelux200`) i `firmwareUpdateHint`; pola okna „Dane sterownika” (`components/BoilerConfigFields.tsx`: powiązana pompa ciepła) |
| `api.ts` | `PelletBoilerRequests` (`getLast`, `getList`, ustawienia regulatora, zlecenia, harmonogram) |
| `types.ts` | `PelletBoilerReading` i typy ustawień, zleceń i harmonogramu |
| `pages/Home.tsx` | układ „Instrument”: pasek Offline, karta hero (temperatura kotła, zadana, stan z płomieniem, chipy sezonu i trybu, KPI), karty CWU i mieszaczy, „Urządzenia kotła”, „Pozostałe”; odświeżanie co 30 s |
| `pages/Data.tsx` | pasek filtrów (dzień, „Wszystkie parametry”, CSV) i karta „Odczyty dnia” (`.table-wrap` z przyklejonym nagłówkiem) |
| `pages/Chart.tsx` | temperatury dnia z chipami serii i pasem palenia albo spalony pellet; kolory z `core/chartColors.ts` |
| `components/SimpleTile.tsx` | kafelek prosty na liście sterowników (`DeviceTile.boiler` z `GET /devices/summary`, akcje `POST /pellet-boiler-pelux200/simple {action: on \| off \| cwu-on \| cwu-off}`, serwer `services/pellet-boiler-pelux200-simple.service.ts`) |
| `pages/Schedules.tsx` | karta „Harmonogram” („Harmonogram działa – tryb”, dymek „i”; przy „CWU – grzanie peletem” stan „Teraz” i „działa teraz” z listy Pellet — `state.pelletCwu` z `GET /schedules/current`) i karty wpisów „Tryb Zima · …” / „CWU · …” (`.entries`, „działa teraz”, „Poza harmonogramem”), okno wpisu `.modal` |
| `pages/Settings.tsx` | dwie kolumny: „Regulator”, „Tryb pracy”, „Główne parametry” (z oknem „Nastawy trybów”: `ModeProfiles` z `formId`, przycisk zapisu w stopce okna `modal-wide`) i „Ostatnie zmiany” (`components/MainParameters.tsx`); karta „Odczyt” (interwał w sekundach 30–3600), „Ustawienia zaawansowane” (`components/AdvancedSettings.tsx`), karta „Sterownik” (`ControllerCard` z `core`) i „Udostępnianie” |
| `components/Alerts.tsx`, `ui.tsx`, `icons.tsx`, `WinterCycleStatus.tsx`, `ModeProfiles.tsx` | zakładka Alarmy, wspólne elementy widoków kotła (`DateNav`, `Segmented`, `CsvButton`, okno), ikony, stan cyklu Zimy, nastawy trybów |
| `pages/style.css` | style widoków kotła |
| `utils/boiler.ts` | nazwy stanów 0–11, formaty liczb i czasu (Warszawa), `isStale`, `readingsToCsv`, `downloadText` |

Ustawienia idą przez wspólne `DeviceRequests` z `core/api.ts` (`/device/properties`), a nie przez `api.ts` modułu.

## API

| Metoda i ścieżka | Kto | Opis |
|---|---|---|
| `POST /pellet-boiler-pelux200/add` | sterownik | odczyt kotła (pola niżej); sam `deviceId` wystarcza; 404/409 jak w core; odpowiedź **201** `{poll_interval_seconds}`; 400 „Nieprawidłowy odczyt kotła.” dla złego body |
| `GET /pellet-boiler-pelux200/last` | aplikacja | ostatni odczyt albo `{}`; wymaga `rootId` |
| `GET /pellet-boiler-pelux200/list?date=YYYY-MM-DD` | aplikacja | odczyty z doby warszawskiej, malejąco po `createdAt`; bez `date` — dziś; zły format 400 (`date: YYYY-MM-DD.`) |

Ustawienia kotła zapisuje wspólne `PUT /device/properties` (moduł core). Zgłoszenie (`POST /devices/register`, `deviceType: "pellet-boiler-pelux200"`) zwraca `settings: {poll_interval_seconds, firmware?}` (`firmware` tylko przy zleceniu aktualizacji; sterownik pieca czyta ofertę z `commands/next`, niżej).

### Pola odczytu

Wszystkie opcjonalne; co najmniej jedno wymagane.

| Grupa | Pola | Typ |
|---|---|---|
| stan | `state` — 0–11: OFF, STABILIZATION, KINDLING, WORKING, SUPERVISION, PAUSED, STANDBY, BURNING_OFF, ALERT, MANUAL, UNSEALING, OTHER | liczba |
| temperatury [°C] | `heating_temp`, `feeder_temp`, `water_heater_temp`, `outside_temp`, `return_temp`, `exhaust_temp`, `optical_temp`, `upper_buffer_temp`, `lower_buffer_temp` | liczba |
| zadane i statusy | `heating_target`, `water_heater_target` (°C), `heating_status`, `water_heater_status` (kod) | liczba |
| praca | `fuel_level` [%], `fan_power` [%], `boiler_load` [%], `boiler_power` [kW], `fuel_consumption` [kg/h], `lambda_level` [%] | liczba |
| wyjścia | `fan`, `feeder`, `heating_pump`, `water_heater_pump`, `circulation_pump`, `lighter`, `alarm` | boolean |

Walidacja (`validateReading`): body musi być obiektem (nie tablicą); pole liczbowe musi być skończoną liczbą (nie napisem, `null`, `NaN`), pole logiczne typem `boolean` (nie `1`); pominięte pola są dozwolone; brak jakiegokolwiek pola pomiarowego (np. sam `time`) to 400. Zakresy wartości nie są sprawdzane. Nieznane klucze i `time` są ignorowane, a schemat Mongoose jest ścisły — **nowe pole trzeba dopisać w `types.ts`, w `validateReading` (listy pól), w modelu, w typach klienta i w widokach**.

## Model danych

**`pellet_boiler_pelux200`** — jeden odczyt kotła:

| Pole | Opis |
|---|---|
| `rootId`, `deviceType`, `deviceId` | identyfikacja (dopisywane przez serwer z `device-info`) |
| pola odczytu | jak w tabeli wyżej |
| `createdAt`, `updatedAt` | znaczniki zapisu; `createdAt` to czas odebrania (serwer ignoruje `time` ze sterownika) |

Indeks: `{rootId, createdAt: -1}`. Brak wygasania danych.

**`devices.properties`** kotła: `poll_interval_seconds` — liczba całkowita 30–3600 (domyślnie 300). Schemat (`core/models/device.model.ts`) sprawdza zakres i całkowitość, więc `PUT /device/properties` z wartością poza zakresem albo ułamkową daje 400 i nie zmienia zapisanej.

## Stałe

| Stała | Wartość | Gdzie |
|---|---|---|
| `DEFAULT_POLL_INTERVAL_SECONDS` | 300 | serwis, `device-type.ts` |
| zakres `poll_interval_seconds` | 30–3600 s | schemat `properties`; formularz klienta 0,5–60 min |
| odświeżanie widoku Kocioł | 30 s | `Home.tsx` |
| nieaktualny odczyt | `3 × poll_interval_seconds` | `utils/boiler.ts` (`isStale`), `DEFAULT_POLL_SECONDS` = 300 |
| limit wieku odczytu po stronie sterownika | 60 s | firmware sterownika pieca (`READING_MAX_AGE_MS` w `devices/pellet-boiler-pelux200/src/firmware.hpp`) |

## Kontrakt ze sterownikiem pieca

Sterownik pieca to osobna płytka ESP32-C3 SuperMini z modułem RS-485 HW-519 (`devices/pellet-boiler-pelux200`, od 2026-10-03; wcześniej druga rola sterownika `co`). Kontrakt się przy tym nie zmienił.

- Zgłoszenie przy każdym starcie: `POST /devices/register` `{deviceId: SN, deviceType: "pellet-boiler-pelux200", name: "Piec Pellux 200", version, ip}`; odpowiedź 201/200 z `rootId` i `settings.poll_interval_seconds`; Root ID i interwał w NVS (przestrzeń `pel`, klucze `root_id`, `poll_s`). Nieudane zgłoszenie jest ponawiane co 30 s.
- Wysyłka: `POST /api/pellet-boiler-pelux200/add?deviceId=SN&rootId=…` co `poll_interval_seconds` (bez `time`). Nieudana wysyłka jest ponawiana po 60 s; 404/409 kasują Root ID i uruchamiają zgłoszenie od nowa.
- Aktualizacja firmware (OTA, od firmware 1.5.0): tylko na zlecenie „Aktualizuj” w Ustawieniach (`POST /devices/:rootId/firmware-update`, moduł core). Sterownik co 15 s pyta `GET /pellet-boiler-pelux200/commands/next`; przy zleceniu odpowiedź to `{firmware: {version, url, sha256, request}}` **zamiast** zlecenia parametru (zlecenia parametrów czekają do końca aktualizacji). Sterownik pobiera obraz, gdy nie trwa zlecenie parametru ani odczyt ustawień, sprawdza SHA-256 i się restartuje; zgłoszenie z nową wersją kasuje zlecenie. Firmware 1.4.0 nie ma OTA, więc 1.5.0 wgrywa się raz przez USB albo `/install` sterownika.
- Kontekst: `controllerPaths` w `core/middleware/device-context.ts` zawiera `/pellet-boiler-pelux200/add` → `pellet-boiler-pelux200`. Szczegóły w [module core](../core/3-dokumentacja-techniczna.md).
- Kod po stronie firmware: `devices/pellet-boiler-pelux200/src/pellet.cpp` (zgłoszenie, wysyłka, strony, pobieranie OTA), `ota.*`, `ecomax_frame.*`, `pellet_telemetry.*`, `bus_polarity.*`; opis: [README sterownika](../../../devices/pellet-boiler-pelux200/README.md) i [piec-pellux200.md](../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md).

## Testy

```bash
npm test -w server -- --run       # pellet-boiler-pelux200.test.ts: 8 testów (serwer razem: 81)
npx tsc -p server/tsconfig.tests.json --noEmit
npm run build -w client
```

`server/test/pellet-boiler-pelux200.test.ts` sprawdza: zgłoszenie z ustawieniem 300 s w `settings`, dwie role tego samego SN (dwa `rootId`, routing po rodzaju endpointu, 409 dla `rootId` innej roli), zapis odczytu z pominięciem nieznanych pól i `time` oraz odpowiedź z interwałem, 400 (puste body, sam `time`, pola złego typu), 404 dla nieznanego `deviceId` i 409 dla `rootId` innego urządzenia, `last` (`{}`, potem najnowszy, 400 bez `rootId`), `list` (granice doby warszawskiej, malejąco, 400 dla złej daty), zapis i walidację `poll_interval_seconds` przez `PUT /device/properties` oraz jego zwrot w odpowiedzi na odczyt.

Klient nie ma testów jednostkowych; sprawdzenie to `tsc` i `vite build`.

## Znane problemy

- **Format ramek niezweryfikowany na kotle.** Dekoder `SensorData` i założenia (nadawca `0x45`, licznik alertów, odejmowanie 101 od poziomu paliwa) pochodzą z PyPlumIO; prędkość 115200 baud i punkt wpięcia (G2 modułu A) nie były sprawdzone na kotle; płytkę sterownika pieca (odbiór na GPIO21) sprawdzono tylko na biurku. Nasłuch trzeba zweryfikować przed jakimkolwiek nadawaniem.
- **Etap 2 nie istnieje.** Brak nadawania na magistralę kotła, odpowiedzi na `CheckDevice` i sterowania; serwer nie ma operacji ani schedulera kotła.
- **`lambda_level`** jest w kontrakcie, schemacie i typach, ale firmware sterownika pieca go nie wypełnia (widok pokazuje `---`).
- **`heating_status` i `water_heater_status`** to surowe liczby o nieudokumentowanym znaczeniu.
- **Wysyłka HTTP blokuje pętlę sterownika pieca** na kilka sekund; bufor UART (4 KB) gubi nadmiar, a parser się resynchronizuje.
- **`PUT /device/properties` podmienia całe `properties`** — klient musi wysłać komplet pól (Ustawienia kotła rozszerzają wczytany obiekt).
- **Brak wykresów, agregatów i wygasania danych.** Historia rośnie bez limitu (odczyt co 5 minut to ok. 288 rekordów dziennie).
- **Ostatni odczyt w pamięci serwera** (`lastByRoot`) jest odtwarzany z bazy po restarcie; nie ma innego stanu w pamięci.
- **Zakresy wartości** (np. `state` 0–11, procenty 0–100) nie są sprawdzane na serwerze; widok pokazuje `Stan N` dla stanu spoza listy.
