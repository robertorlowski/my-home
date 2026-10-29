# Moduł heat-pump — dokumentacja techniczna

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](../../en/moduly/heat-pump/3-technical-documentation.md)

## Pliki — serwer (`server/src/modules/heat-pump`)

| Plik | Rola |
|---|---|
| `routes.ts` | trasy modułu: `/hp`, `/pv`, `/operation`, `/schedules` |
| `device-type.ts` | wpis do rejestru rodzajów (pompa nie ma ustawień w odpowiedzi na zgłoszenie) |
| `types.ts` | `HpEntry`, `HpMetrics`, `PvEntry`, `PvMetrics`, `PvPanel`, `OperationEntry`, `ScheduleEntry`, `ScheduleType`, `WeekDay`, `WorkMode`, `SettingsEntry`, `TimeSlot` |
| `controllers/hp.controller.ts` | `addHp` (telemetria → operacja), odczyty dnia/zakresu/roku, bilans miesięczny, ostatni błąd, czyszczenie |
| `controllers/operation.controller.ts` | operacja do formularza, zapis ręczny, akcje jednorazowe (+ WebSocket `operation`) |
| `controllers/pv.controller.ts` | zapis i odczyt PV |
| `controllers/schedule.controller.ts` | CRUD harmonogramów, harmonogram działający teraz |
| `services/hp.service.ts` | zapis telemetrii, wykrywanie zdarzeń błędów, pamięć podręczna ostatniej telemetrii i dni z danymi |
| `services/operation.service.ts` | mapy operacji w pamięci, scalanie ręcznych pól, akcje, `consumeManualForceOnStart`, M→A |
| `services/scheduler.service.ts` | przebieg co minutę, wybór harmonogramu, operacja domyślna, `getCurrentSchedule` |
| `services/schedule.service.ts` | harmonogramy osadzone w urządzeniu, filtr dla daty |
| `services/pv.service.ts` | ostatni odczyt PV (≤ 3 min), podsumowanie do `GET /hp`, czyszczenie paneli po 90 dniach |
| `models/hp.model.ts` | kolekcja `hp` (ścisły schemat telemetrii) |
| `models/pv.model.ts` | kolekcja `pv` i schemat podsumowania PV osadzany w `hp` |
| `models/schedule.model.ts` | schemat harmonogramu (osadzony w `devices.schedules`) |

## Pliki — klient (`client/src/devices/heat-pump`)

| Plik | Rola |
|---|---|
| `device-type.tsx` | wpis do rejestru: menu HP, Statystyki, Harmonogram, Ustawienia, Dane, Operacje; `/hp` poza menu; pola okna „Dane sterownika” (podłączenie CWU / CO, pojemność zbiornika, PV) |
| `api.ts` | `HpRequests`: telemetria, dni, bilans, operacje, akcje, błąd, harmonogramy |
| `types.ts` | typy telemetrii, PV, operacji i harmonogramów po stronie klienta; `pumpWorkMode` (A / CWU → Automatyczny, OFF → Wyłączony, reszta → Ręczny) |
| `pages/Home/` | widok główny w układzie „Instrument”: paski (Offline, pompa wstrzymana, ładowanie CWU), karta hero (temperatura zbiornika na pasku zakresu, sprężarka, KPI), karty „Pomiary”, „Obieg”, „Energia dziś”; WebSocket `update` |
| `pages/Data/` | pasek filtrów (dni z danymi, „Wszystkie odczyty”, CSV) i karta „Odczyty dnia”; wiersz z błędem podświetlony |
| `pages/Charts/` | pasek filtrów (okres, data, „Cały dzień”), kafelki statystyk, karty „Temperatury” i „Moc i produkcja PV” (dzień) albo „Energia i koszt” (miesiąc, rok) |
| `pages/Settings/` | dwie kolumny: karta „Ustaw” (operacja ręczna), „Błędy sterownika”, karta „Sterownik” i „Udostępnianie” z `core` |
| `pages/Schedules/` | karty „Tryb pracy” (ustawienia domyślne) i „Wpisy” (lista `.entries`, „działa teraz”, „Poza harmonogramem”), okno „Wpis harmonogramu” |
| `components/DateNav.tsx` | nawigacja po dacie (`.date-nav`): strzałki i lista dni z danymi (`useHpDates`), miesięcy albo lat |
| `components/Segmented.tsx`, `components/Switch.tsx` | przełącznik segmentowy (tryb pracy, okres wykresu) i przełącznik `.switch` z makiety |
| `components/PumpConfigFields.tsx`, `pumpConfig.css` | pola okna „Dane sterownika”: podłączenie CWU / CO ze schematem, pojemność zbiornika, PV |
| `components/icons.tsx` | ikony widoków pompy |
| `utils/utils.ts` | pobranie i spłaszczenie danych dnia do tabeli i wykresu |
| `utils/energy-cost-g12w.ts` | koszt energii w taryfie G12w (czas warszawski, format `YYYY.MM.DD`) |
| `utils/errors.ts` | opisy kodów błędów CHPC (zmieniać razem z `ERRC_*` w firmware) |

## API

| Metoda i ścieżka | Kto woła | Opis |
|---|---|---|
| `POST /hp/add` | `co` | telemetria; odpowiedź `{operation, t_out}`; sam `deviceId` wystarcza (404/409 jak w core) |
| `GET /hp` | aplikacja | ostatnia telemetria z pamięci + pełne podsumowanie PV |
| `GET /hp/all` | aplikacja | dane od początku roku (CSV) |
| `GET /hp/dates` | aplikacja | dni z danymi (`YYYY.MM.DD`) |
| `GET /hp/4day?date=` albo `?startDate=&endDate=` | aplikacja | rekordy dnia / zakresu dni (czas warszawski) |
| `GET /hp/monthly-summary?startDate=&endDate=&group=month\|day` | aplikacja | energia, PV, zużycie z sieci, koszt |
| `GET /hp/last-error` | aplikacja | ostatni rekord z `error_code` (24 h, przy blokadzie bez limitu) |
| `POST /pv/add` | `co` | odczyt PV; wymagane `total_power`; odpowiedź `{}` (201) |
| `GET /pv`, `GET /pv/range?date=` / `?startDate=&endDate=` | aplikacja | ostatni odczyt z panelami / odczyty z zakresu |
| `GET /operation` | aplikacja | wartości do formularza Ustawień |
| `POST /operation/set` | aplikacja | zapis operacji ręcznej |
| `POST /operation/action` | aplikacja | `{action: "error_reset" \| "restart"}` |
| `GET /schedules`, `POST /schedules`, `PUT /schedules/:id`, `DELETE /schedules/:id` | aplikacja | harmonogramy |
| `GET /schedules/current` | aplikacja | `{scheduleId, work_mode}`; `scheduleId: null` = ustawienie domyślne |

## Kontrakt operacji (serwer → `co`)

Wszystkie wartości są **napisami**.

| Klucz | Wartości | Komenda RS-485 do CHPC |
|---|---|---|
| `work_mode` | `M`, `A`, `CWU`, `OFF` (`co` przyjmuje też `PV`) | `0x0C` CO on/off + przekaźniki CO/CWU w `co` |
| `force` | `"0"`, `"1"` | `0x03` (CHPC przyjmuje tylko w postoju) |
| `co_min`, `co_max`, `cwu_min`, `cwu_max` | °C | `0x04` T zadana (max), `0x05` delta (max − min) |
| `co_pomp` | `"0"`, `"1"` | przekaźniki CO/CWU w `co` |
| `hot_pomp`, `cold_pomp`, `sump_heater` | `"0"`, `"1"` | `0x09`, `0x0A`, `0x0B` |
| `working_watt` | W | `0x0E` limit mocy (1001–4000 W w CHPC) |
| `eev_max_pulse_open`, `eev_min_pulse_open` | kroki | `0x0D`, potem `0x0F` |
| `eev_setpoint` | °C | `0x08` przegrzanie |
| `error_reset`, `restart` | `"1"` (akcje jednorazowe) | `0x10` odblokowanie, `0x11` restart |

Pusta operacja `{}` niczego nie zmienia; `co` nie wysyła ponownie wartości, która się nie zmieniła.

## Telemetria (`co` → serwer)

- `HP` — JSON z CHPC bez zmian. Klucze, na których polegają `co` i serwer: `HPS` (>0 = sprężarka pracuje), `Tho`, `Ttarget` (czujnik środka zbiornika), `lt_pow` (Wh od startu sprężarki), `lt_hp_on` (s pracy), `F`, `CO`, `Tmin`, `Tmax`, `Tbe`, `Tae`, `Tsump`, `EEV`, `EEV_dt`, `EEV_pos`, `Watts`, `WWatt`, `HCS`, `CCS`, `SHS` (grzałka karteru), `EEVmax`, `EEVmin`, `ERR`, `ERRn`, `ERRc`.
- `time` — `"YYYY.MM.DD HH:MM:SS"` (czas polski).
- `work_mode`, `co_min`, `co_max`, `cwu_min`, `cwu_max`, `co_pomp`, `cwu_pomp`, `controller_mode`.
- COP zbiornika: `cop`, `cop_min`, `cop_max`, `t_min`, `t_max`, `cop_bottom_start`.
- Liczniki diagnostyczne `co` (`serial_*`, `cloud_*`, `*_error`).

**Schemat `hp` jest ścisły**: klucze spoza schematu (m.in. `EEV_pulse`, `cop_min`, `cop_max`, `controller_mode`, liczniki diagnostyczne) nie są zapisywane; widać je tylko w `GET /hp` do restartu serwera. Nowe pole telemetrii trzeba dodać do `models/hp.model.ts`, `types.ts` (serwer i klient) i do widoków.

## Model danych

| Kolekcja | Zawartość | Indeksy / retencja |
|---|---|---|
| `hp` | telemetria + `rootId`, `deviceType`, `deviceId`, `t_out`, `error_code`, `PV.total_power`, `createdAt` | `rootId`, `deviceId` |
| `pv` | odczyt DTU: podsumowanie + `panels[]` (port mikrofalownika: moc, napięcia, prąd, temperatura, status, alarm) | `{rootId, createdAt}`, `{createdAt}`; `panels` usuwane po 90 dniach |
| `devices.schedules[]` | `type` (`co`/`cwu`/`off`), `enabled`, `dayOfWeek` (-1 każdy, -2 robocze, -3 wolne, 0–6), `date?`, `startTime`, `endTime` (`HH:mm`), `forceStart`, `minTemperature?`, `maxTemperature?` | osadzone w urządzeniu |
| `devices.properties` | `co_min`, `co_max`, `cwu_min`, `cwu_max`, `work_mode` | — |

## Stałe

| Stała | Wartość | Plik |
|---|---|---|
| `SCHEDULER_INTERVAL_MS` | 60 000 | `services/scheduler.service.ts` |
| `PV_MAX_AGE_MS` | 3 min | `services/pv.service.ts` |
| `PANEL_DETAILS_RETENTION_DAYS` | 90 | `services/pv.service.ts` |
| okno ostatniego błędu | 24 h | `services/hp.service.ts` |
| blokada CHPC | `ERRc` ≥ 5 | `services/hp.service.ts`, `utils/errors.ts` |

## Testy

```bash
npm test -w server -- --run      # server/test/: app.test.ts, pv.test.ts, scheduler.test.ts (+ hydrofor, kocioł); razem 81 testów
```

- `app.test.ts` — zapis i odczyt telemetrii, `EEVmin`, zdarzenia błędów (także przy blokadzie), akcje, `co_pomp` przy zmianie trybu, force przy starcie.
- `pv.test.ts` — zapis PV z samym `deviceId`, 404/409, `PV.total_power` w `hp` (limit 3 min, starsze PV z firmware bez zmian), pełne PV w `GET /hp`, bilans, usuwanie paneli.
- `scheduler.test.ts` — rodzaje harmonogramów wg trybu, przerwy, ręczne nadpisanie i jego czyszczenie, temperatury domyślne, `CWU` poza harmonogramem w trybie `A`, M→A po północy, harmonogram działający teraz, weekendy i święta, brak `co_pomp` w operacji.

Test całego łańcucha (`test/e2e`, most z prawdziwym kodem `co` i symulowanym CHPC) jest nieaktualny: czeka na formularz dodawania sterownika, którego aplikacja już nie ma.

## Znane problemy

- **Brak walidacji** w `/operation/set` i w interfejsie; zakresy sprawdzają dopiero `co` (np. temperatury 1–50, `working_watt` 0–25599) i CHPC (np. limit mocy 1001–4000, zadana ≤ 50, delta ≤ 30) — po cichu.
- **Akcje jednorazowe giną, gdy `co` nie jest w trybie CLOUD** (`applyServerOperation` w `devices/co/src/main.cpp` odrzuca wtedy całą operację, a serwer wysyła akcję tylko raz).
- **Operacje ręczne i ostatnia telemetria tylko w pamięci** — restart serwera je kasuje.
- **Harmonogram na konkretny dzień tygodnia przez północ** (np. poniedziałek 22:00–06:00) działa w poniedziałek 00:00–06:00 i 22:00–24:00, a nie we wtorek rano — dzień jest sprawdzany dla bieżącej chwili. Wpisy „każdy dzień” działają zgodnie z oczekiwaniem.
- **Koszt G12w liczony dwa razy, inaczej**: klient (wykres dnia) traktuje święta jako strefę tańszą i dzieli przedziały na granicach stref, serwer (`monthly-summary`) nie zna świąt i przypisuje strefę po godzinie próbki. W święta dzień i miesiąc mogą pokazać inny koszt. Stawki i godziny stref są wpisane w kod w obu miejscach.
- **Rekord `hp` powstaje tylko przy niezerowym `HP.Ttarget`** — celowo: zbiornik nigdy nie jest chłodzony do 0 °C, więc 0 oznacza brak odczytu z CHPC.
- **Nie łączyć `hp` z `pv` w agregacji** (limit 32 MB sortowania w Atlasie, brak `allowDiskUse`).
- Porządki 2026-10-21: `GET /hp/all` liczy początek roku w czasie warszawskim; nowy harmonogram pokazuje błąd zapisu (`Requests.json`); klient woła `/hp/4day`; usunięte nieużywane `getSchedulesForDate`, `getHpDataForDay`, `assignLegacyHpData`, `/operation/getAndClear`, `utils/energy.ts`, `components/ResourceBlock.tsx` oraz starszy model ustawień czasowych (kolekcja `settings`, `GET /settings`, `POST /settings/set`, pole `devices.settings`; stare dokumenty zachowują to pole, schemat je pomija). `setOperationData` zostaje (używa go `onPropertiesSaved`).
