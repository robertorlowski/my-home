# Moduł water-pressure-tank — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/water-pressure-tank/3-technical-documentation.md)

## Pliki — serwer (`server/src/modules/water-pressure-tank`)

| Plik | Rola |
|---|---|
| `routes.ts` | trasy `/water-pressure-tank/*` |
| `device-type.ts` | wpis do rejestru: ustawienia domyślne nowego hydroforu i pole `settings` w odpowiedzi na zgłoszenie |
| `types.ts` | `WaterPressureTankRun`, `WaterMeterReading` |
| `controllers/water-pressure-tank.controller.ts` | `add`, `settings`, `runs`, `summary`, `flow`, wodomierz i jego podsumowanie; granice okresów w czasie warszawskim |
| `services/water-pressure-tank.service.ts` | walidacja i zapis wiadomości (daty z czasów względnych), `pumpSeconds` (czas pompy bez ręcznej pracy kompresora), przepływ z wodomierza (`loadFlow`, `getFlowRate`), woda (`litersFor`), podsumowania, wodomierz, czas kompresora |
| `models/water-pressure-tank-run.model.ts` | kolekcja `water_pressure_tank` |
| `models/water-meter.model.ts` | kolekcja `water_meter` |

## Pliki — klient (`client/src/devices/water-pressure-tank`)

| Plik | Rola |
|---|---|
| `device-type.tsx` | wpis do rejestru: Hydrofor, Dane, Wykres, Operacje, Ustawienia (bez harmonogramów) |
| `api.ts` | `WaterPressureTankRequests` |
| `types.ts` | uruchomienia, przepływ (`WaterFlow`), podsumowania, wodomierz |
| `pages/Home.tsx` | układ „Instrument”: pasek Offline, hero „Woda dziś” z przełącznikami pompy i kompresora oraz KPI czasu kompresora i przepływu, karta dzisiejszych uruchomień (co 5 s) i słupki zużycia z 7 dni |
| `pages/Data.tsx` | pasek filtrów (przełącznik uruchomienia / odczyty wodomierza, miesiąc, CSV), karta uruchomień („≈”, chip „z kolejki”) albo karta odczytów wodomierza (formularz i lista) |
| `pages/Chart.tsx` | pasek filtrów (Dzień / Miesiąc / Rok, data), kafelki statystyk, słupki wody (bez przepływu czasu pompy), rok z wodomierzem i przepływem |
| `pages/Settings.tsx` | dwie kolumny: karty „Kompresor” i „Przepływ pompy” (`FlowDetails`), po prawej karta „Sterownik” (`ControllerCard` z `core`) i „Udostępnianie” (`DeviceSharing`) |
| `components/FlowDetails.tsx` | przepływ w l/min i z czego go policzono albo instrukcja (dwa odczyty wodomierza); w Ustawieniach |
| `components/DateNav.tsx`, `DurationValue.tsx`, `TankIcons.tsx` | nawigacja po dacie (`.date-nav`), czas pompy jako „4 min 10 s” z jednostkami, ikony hydroforu |
| `pages/style.css` | style widoków hydroforu |
| `utils/water.ts` | formaty (litry, czas pompy jako „4 min 10 s”), daty w Warszawie, sumy, CSV |

## API

| Metoda i ścieżka | Kto | Opis |
|---|---|---|
| `POST /water-pressure-tank/add` | sterownik | `{runId, pumpRunS, compressorStartS?, compressorEndS?, restarts, manualCompressorS?, queued?}`; sam `deviceId` wystarcza; 404/409 jak w core; odpowiedź `{}` (201); złe dane 400 |
| `PUT /water-pressure-tank/settings` | sterownik | `{compressor_seconds}` (pełne sekundy 1–3600, inaczej 400); zmienia tylko to pole; 404 dla innego rodzaju urządzenia |
| `GET /water-pressure-tank/runs?from=YYYY-MM-DD&to=YYYY-MM-DD` | aplikacja | uruchomienia z dni (Warszawa, `to` włącznie), z polami `inProgress`, `compressorRunning`, `pumpSeconds` (czas pompy bez ręcznej pracy kompresora) i `waterLiters` (`null` bez przepływu) |
| `GET /water-pressure-tank/summary?period=day\|month\|year&date=YYYY-MM-DD` | aplikacja | `{period, date, buckets, flow}`; kubełki `{key, pumpSeconds, waterLiters \| null, runs}` w godzinach (24), dniach miesiąca albo miesiącach (12); puste przedziały z zerami |
| `GET /water-pressure-tank/flow` | aplikacja | przepływ pompy `{litersPerMinute \| null, periods, meterLiters, pumpSeconds}`: liczba użytych okresów, suma litrów z wodomierza i czasu pompy |
| `GET /water-pressure-tank/meter` | aplikacja | odczyty od najstarszego |
| `POST /water-pressure-tank/meter` | aplikacja | `{readAt, valueM3, note?}` |
| `DELETE /water-pressure-tank/meter/:id` | aplikacja | usunięcie; 404 dla nieznanego albo cudzego |
| `GET /water-pressure-tank/meter/summary?year=YYYY` | aplikacja | `{year, periods, months, flow}`; okresy `{from, to, meterLiters, pumpSeconds, estimatedLiters \| null}`, miesiące `{month, meterLiters, estimatedLiters}` (`null` poza zakresem odczytów); < 2 odczytów → puste listy |

Ustawienia hydroforu zapisuje wspólne `PUT /device/properties` (moduł core). Zgłoszenie (`POST /devices/register`) zwraca `settings`: `{compressor_seconds}` i, gdy w aplikacji zlecono aktualizację („Aktualizuj” w karcie „Sterownik”, `POST /devices/:rootId/firmware-update`, moduł core), `firmware: {version, url, sha256, request}`. Hydrofor ma zasilanie tylko w czasie pracy pompy, więc aktualizuje się przy najbliższym uruchomieniu pompy, przy wyłączonym kompresorze.

Walidacja wiadomości: `runId` — liczba całkowita ≥ 0; `pumpRunS` — 0 do 24 h; pozostałe czasy (także `manualCompressorS`) ≥ 0.

**Przepływ i woda** (`loadFlow`): odczyty wodomierza od najstarszego wyznaczają okresy; w każdym suma `pumpSeconds` uruchomień z `pumpStart` w okresie. Do przepływu wchodzą okresy z czasem pompy > 0 i przyrostem wodomierza ≥ 0: `l/s = Σ litrów / Σ sekund`. Woda uruchomienia, kubełka albo miesiąca = `pumpSeconds × l/s`, zaokrąglona do 0,1 l. Podsumowania liczą czas pompy w agregacji MongoDB tym samym wyrażeniem (`PUMP_SECONDS_EXPR`).

## Model danych

**`water_pressure_tank`** — jedno uruchomienie pompy:

| Pole | Opis |
|---|---|
| `rootId`, `deviceType`, `deviceId`, `runId` | identyfikacja (`runId` nadaje sterownik: licznik w NVS, losowy start) |
| `pumpStart`, `pumpEnd` | start i koniec pracy pompy |
| `compressorStart`, `compressorEnd` | włączenie i ostatnie wyłączenie kompresora |
| `restarts` | liczba ręcznych włączeń kompresora („Uruchom na N s” i „Włącz”) |
| `manualSeconds` | łączny czas ręcznego włączenia kompresora („Włącz”) [s]; odejmowany od czasu pompy |
| `timeApproximate` | daty z chwili przyjęcia (uruchomienie z kolejki) |
| `lastSeenAt` | ostatnia wiadomość (uruchomienie „w toku” < 5 s) |
| `compressorRunning` | kompresor włączony według ostatniej wiadomości (`compressorStartS` bez `compressorEndS`); potrzebne po „Uruchom na N s”, bo `compressorEnd` zostaje z poprzedniego wyłączenia. `GET …/runs` zwraca je tylko przy `inProgress` |
| `createdAt`, `updatedAt` | znaczniki zapisu |

Indeksy: unikalny `{rootId, runId}` i `{rootId, pumpStart}`. Wody w rekordzie nie ma (do wersji 1.3.0 były tu `waterLiters`, `waterAirBaseLiters` i `waterMembraneLiters`; w starszych dokumentach zostają, ale nie są używane, a `waterLiters` w odpowiedzi `GET …/runs` jest zawsze liczone od nowa).

**`water_meter`** — odczyty wodomierza: `rootId`, `readAt` (aplikacja zapisuje datę jako południe czasu lokalnego), `valueM3`, `note`; indeks `{rootId, readAt}`.

**`devices.properties`** hydroforu: `compressor_seconds` (1–3600). Dawne pola `pressure_low`, `pressure_high` i `tanks[]` (do wersji 1.3.0) nie są już w schemacie.

## Stałe

| Stała | Wartość | Gdzie |
|---|---|---|
| `RUN_IN_PROGRESS_MS` | 5 s | serwis |
| `MAX_COMPRESSOR_SECONDS` | 3600 | serwis, schemat `properties`, firmware |
| ustawienia domyślne | `compressor_seconds` = 30 | `device-type.ts` |

## Testy i narzędzia

```bash
npm test -w server -- --run       # server/test/water-pressure-tank.test.ts: 31 testów (serwer razem: 96)
node scripts/simulate-water-pressure-tank.mjs [--history] [--fast]   # symulator sterownika (npm run local)
node scripts/seed-local.mjs       # dane demo: kilka miesięcy uruchomień i odczyty wodomierza („rzeczywisty” przepływ 1 l/s)
```

`server/test/water-pressure-tank.test.ts` sprawdza: czas pompy bez ręcznej pracy kompresora, przepływ z wodomierza i wodę każdego uruchomienia, średnią ważoną czasem z pominięciem okresów bez pompy, brak wody przed dwoma odczytami, zgłoszenie z ustawieniami, ustawienia i ich walidację, czas kompresora ze sterownika (zmiana jednego pola, 404, 409), daty z czasów względnych, kolejkę i czas przybliżony, „w toku”, pracę kompresora (także po ponownym uruchomieniu), zapis `manualCompressorS`, podsumowania, wodomierz.

## Znane problemy

- **Sterownik wysyła uruchomienia dopiero po udanym zgłoszeniu** (w odróżnieniu od `co`) — bez chmury uruchomienie czeka w NVS i trafia do kolejki przy następnym starcie.
- **Hydrofor dostaje w `properties` `work_mode: CWU`** z wartości domyślnej schematu — pole jest nieużywane.
- **`PUT /device/properties` podmienia całe `properties`** — aplikacja wysyła komplet pól hydroforu; inny klient API musi zrobić to samo.
- **Woda zależy od stałego przepływu pompy.** Przepływ jest jeden dla całej historii; zmiana pompy albo zatkany filtr zmieniają go dopiero w średniej z kolejnych odczytów.
- **Każde zapytanie o wodę czyta wszystkie odczyty wodomierza i uruchomienia między pierwszym a ostatnim** (`loadFlow`), bez pamięci podręcznej.
- **Firmware i strony sterownika nie mają testów na sprzęcie** — sprawdzane są w emulatorze i testach `native`.
