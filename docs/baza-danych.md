# Baza danych MongoDB

[English](en/database.md)

Opis bazy danych My Home: gdzie działa, jakie ma kolekcje, co w nich jest, jak długo dane są trzymane i jak bezpiecznie zmieniać model. Liczby dokumentów i rozmiary pochodzą z bazy produkcyjnej z 8.11.2026.

## Gdzie działa

| Element | Wartość |
|---|---|
| Serwer | `vm-prod` (Oracle Cloud), kontener `mongodb-prod`, MongoDB 8.0 |
| Baza produkcyjna | `hpdb`, ok. 84 MB na dysku |
| Baza testowa | `hpdb_test`, kopia produkcji używana przez `my-home-test` i test lokalny |
| Dostęp | tylko z serwera (`127.0.0.1:27017`); z komputera przez tunel SSH (`node test-lokalny.mjs` w repozytorium `oracle-cloud`, port 27117) |
| Użytkownicy | `admin` (administracja i kopie), `myhome` (aplikacja, tylko `hpdb`), `myhome_test` (test, tylko `hpdb_test`) |
| Kopie | codziennie o 01:30 UTC, 7 ostatnich, `/srv/apps/storage/backups` na serwerze |
| Atlas | dawna baza produkcyjna; na żądanie dostaje strukturę i konfigurację, bez danych historycznych |

Szczegóły serwera, hasła (bez wartości) i procedury są w prywatnym repozytorium `oracle-cloud` (`notatki-konfiguracji.md`).

## Zasady wspólne

- **`rootId`** to `_id` dokumentu z `devices` zapisany jako tekst. Każda kolekcja z danymi sterownika ma pole `rootId`, a usunięcie konta kasuje dokumenty z `rootId` jego sterowników we wszystkich takich kolekcjach (`deleteUserAndData` w `server/src/core/services/auth.service.ts`).
- **`deviceId`** to numer seryjny sterownika (MAC ESP32, 12 znaków hex).
- **Czas:** `createdAt` i `updatedAt` dopisuje Mongoose (UTC). Pole `time` w `hp` i `pv` to tekst ze sterownika `YYYY.MM.DD HH:MM:SS` w czasie polskim. Granice dni w raportach serwer liczy w czasie warszawskim.
- **`__v`** to licznik wersji Mongoose, bez znaczenia dla aplikacji.
- **Ścisłe schematy:** w `hp` i `pellet_boiler_pelux200` pole spoza schematu jest po cichu pomijane przy zapisie. Nowe pole telemetrii trzeba dopisać do modelu, typów serwera i klienta.
- **Indeksy** są zdefiniowane w modelach (`server/src/**/models/*.model.ts`) i Mongoose zakłada je przy starcie serwera. Usunięcie indeksu albo kolekcji z kodu nie usuwa ich z bazy, trzeba to zrobić ręcznie.
- **Poza bazą** (tylko w pamięci serwera, znikają przy restarcie): pogoda, ostatnia surowa telemetria pompy, ręczne operacje pompy, diagnostyka sterowników, stan WebSocketów.

## Kolekcje

| Kolekcja | Zawartość | Dokumentów | Dane | Retencja |
|---|---|---|---|---|
| **Konta i dostęp** | | | | |
| `users` | konta użytkowników i konto systemowe | 2 | 1 KB | bez limitu |
| `sessions` | sesje logowania (skrót tokenu) | 21 | 5 KB | TTL `expiresAt` |
| `auth_codes` | kody i linki z maila (skróty) | 0 | — | TTL `expiresAt` |
| `device_shares` | udostępnienia sterowników | 1 | 1 KB | bez limitu |
| `app_settings` | ustawienia aplikacji (poczta, push, zadania w tle) | 1 | 1 KB | jeden dokument |
| **Sterowniki** | | | | |
| `devices` | sterowniki, ich ustawienia i harmonogramy pompy | 5 | 3 KB | bez limitu |
| `operation_log` | dziennik operacji (zakładka „Operacje”) | 110 | 40 KB | TTL 5 dni |
| `firmware_images` | pliki firmware `.bin` | 8 | 8,3 MB | oferowana i poprzednia wersja |
| `firmware_offers` | oferowana wersja na rodzaj sterownika | 4 | 1 KB | jeden na rodzaj |
| **Pompa ciepła i PV** | | | | |
| `hp` | telemetria pompy co kilka sekund | 424 164 | 246 MB | bez limitu |
| `pv` | odczyty fotowoltaiki | 44 730 | 76 MB | `panels` usuwane po 90 dniach |
| `heat_pump_cwu_loading` | trwające ładowanie CWU kotła tą pompą | 1 | — | jeden na pompę |
| **Kocioł pelletowy** | | | | |
| `pellet_boiler_pelux200` | odczyty kotła | 41 671 | 31 MB | bez limitu |
| `pellet_boiler_pelux200_alerts` | alarmy z panelu kotła | 101 | 20 KB | bez limitu |
| `pellet_boiler_pelux200_commands` | zlecenia zmiany parametrów regulatora | 385 | 93 KB | bez limitu |
| `pellet_boiler_pelux200_settings` | ostatni odczyt ustawień regulatora | 1 | 4 KB | jeden na kocioł |
| `pellet_boiler_pelux200_schedules` | wpisy harmonogramu kotła | 5 | 1 KB | bez limitu |
| `pellet_boiler_pelux200_schedule_settings` | stan i ustawienia harmonogramu kotła | 1 | 1 KB | jeden na kocioł |
| **Włącznik** | | | | |
| `switch_relays` | przekaźniki: nazwa, tryb, stan | 1 | — | jeden na przekaźnik |
| `switch_schedules` | wpisy harmonogramu przekaźników | 2 | — | bez limitu |
| `switch_activations` | historia włączeń | 85 | 17 KB | bez limitu |
| **Hydrofor** | | | | |
| `water_pressure_tank` | uruchomienia pompy hydroforu | 65 | 23 KB | bez limitu |
| `water_meter` | ręczne odczyty wodomierza | 5 | 1 KB | bez limitu |
| **Pozostałe** | | | | |
| `weather_tiles` | kafelki pogody | 4 | 1 KB | najwyżej 8 na konto |
| `push_subscriptions` | subskrypcje Web Push | 2 | 1 KB | kasowane po błędzie 404 / 410 |
| `mail_outbox` | kolejka maili dla przekaźnika poczty | 0 | — | TTL doba |

Dane `hp`, `pv` i `pellet_boiler_pelux200` są na dysku skompresowane (razem ok. 50 MB zamiast 350 MB).

## Konta i dostęp

### `users`

Konto: `email` (unikalny wśród kont z e-mailem), `firstName`, `lastName`, adres (`street`, `postalCode`, `city`, `country`), `location {lat, lng}`, `language` (`pl` / `en`), `defaultRootId`, `deviceOrder` (układ listy sterowników i kafelków), `simpleTiles`, `notifications {rules: [{rootId, events}], quietFrom, quietTo}`. Konto systemowe (login `system`, hasło w `SYSTEM_PASSWORD`) ma `isSystem: true` i nie ma e-maila. Indeks: unikalny `{email}` tylko dla dokumentów z e-mailem.

### `sessions` i `auth_codes`

W bazie są tylko skróty SHA-256 tokenu, kodu i linku, nie same wartości. `sessions`: `tokenHash` (unikalny), `userId`, `remember` (90 dni), `demo` (sesja wersji demo, 2 h), `expiresAt`, `lastSeenAt`. `auth_codes`: `purpose` (`login`, `email-change`, `delete-account`), `email`, `tokenHash`, `expiresAt`. Obie kolekcje mają indeks TTL na `expiresAt`, więc wygasłe dokumenty MongoDB usuwa sama.

### `device_shares`

Udostępnienie sterownika: `rootId`, `ownerId`, `email` osoby zaproszonej, `userId` (pusty, dopóki osoba nie założy konta), `tabs` (udostępnione zakładki). Indeksy: unikalny `{rootId, email}`, `{userId}`, `{email}`.

### `app_settings`

Jeden dokument z ustawieniami zmienianymi na ekranie konta systemowego: `values` (`SMTP_*`, `MAIL_FROM`, `MAIL_ADMIN`, `MAIL_RELAY`, `CLIENT_URL`, `DEMO_OWNER_EMAIL`, `VAPID_*`, `BACKGROUND_JOBS`) i `updatedAt`. `_id` to nazwa bazy, więc kopia produkcji odtworzona jako `hpdb_test` ma dokument `hpdb` i środowisko testowe go nie użyje. Wartości sekretów są w bazie jawnie, ekran ich nie pokazuje. Poza bazą zostają tylko `MONGODB_URI` i `SYSTEM_PASSWORD`.

## Sterowniki

### `devices`

Sterownik:

- `deviceType`: `heat_pump`, `water-pressure-tank` (hydrofor), `pellet-boiler-pelux200` (kocioł) albo `switch` (włącznik).
- `deviceId`: numer seryjny. Najstarszy sterownik miał `hp-1`, w produkcji zmieniony na SN (także w `hp`, 2026-09-26).
- `name`: nazwa nadana przez użytkownika; pusta oznacza, że aplikacja pokazuje `deviceId`.
- `ownerId`: właściciel (konto z `users`); bez właściciela sterownik widzi tylko konto systemowe.
- `firmwareVersion`, `firmwareSeenAt`: wersja firmware i czas zgłoszenia, które ją niosło.
- `firmwareUpdate {version, requestedAt}`: zlecenie aktualizacji z przycisku „Aktualizuj”; znika, gdy sterownik zgłosi tę wersję.
- `ipAddress`, `ipSeenAt`: adres sterownika w sieci lokalnej.
- `sortOrder`, `hidden`: miejsce kafelka na liście (wspólna numeracja z `weather_tiles`) i ukrycie.
- `properties`: ustawienia wszystkich rodzajów w jednym obiekcie. Pompa: `work_mode` (`MANUAL`, `AUTO`, `OFF`; `M`, `A`, `CWU` i pary `co_*`, `cwu_*` to dawne wartości), `temp_min`, `temp_max`. Hydrofor: `compressor_seconds` (1–3600). Kocioł: `poll_interval_seconds` (30–3600), `pellet_price_per_ton`. Włącznik: `default_on_minutes` (0–10080, 0 = bez limitu). Domyślne `work_mode` dopisuje się każdemu rodzajowi.
- `schedules`: osadzone harmonogramy pompy (inne sterowniki mają własne kolekcje harmonogramów).
- `pumpConfig {connection, tankLiters, pvDtu, pvForce}` (pompa), `boilerConfig {heatPumpRootId}` (kocioł połączony z pompą).
- `mailKey {publicKey, fingerprint, approvedAt, seenAt}` i `mailKeyPending`: klucz przekaźnika poczty sterownika.

Indeksy: `{ownerId}`. Stare dokumenty mogą mieć pole `settings` z dawnego modelu ustawień czasowych; schemat je pomija.

### `operation_log`

Wpis dziennika: `rootId`, `at`, `actor {type, name, userId}` (`type`: `user`, `system`, `controller`), `source`, `action` (opis zmiany), `status` (`pending`, `sent`, `delivered`, `done`, `error`, `replaced`), `statusAt`, `error`, `reason`, `conditions`, `refs` (zlecenia sterownika, których status przepisuje dziennik). Indeksy: `{rootId, at}`, `{refs}` i TTL na `at` po 5 dniach.

### `firmware_images` i `firmware_offers`

`firmware_images`: `deviceType`, `version`, `data` (plik `.bin`, ok. 1 MB), `size`, `sha256`, `description`; unikalny `{deviceType, version}`. `firmware_offers`: jeden dokument na rodzaj sterownika: `version` (oferowana), `previousVersion`, `enabled`; unikalny `{deviceType}`. Przy zmianie oferty starsze pliki niż oferowany i poprzedni są kasowane. Sterownik dostaje ofertę tylko przy zleceniu w `devices.firmwareUpdate`.

## Pompa ciepła i PV

### `hp`

Telemetria wysyłana przez sterownik `co` (`POST /api/hp/add`), uzupełniona przez serwer: `rootId`, `deviceType`, `deviceId`, `time`, `work_mode`, `temp_min`, `temp_max`, `t_min` i `t_max` (zakres temperatury zbiornika w cyklu), `t_out` (temperatura zewnętrzna: czujnik kotła albo prognoza), `error_code` (nowy błąd pompy w tym odczycie). Obiekt `HP` to stan sterownika CHPC: temperatury (`Tbe`, `Tae`, `Tco`, `Tho`, `Ttarget`, `Tsump`, `Tmin`, `Tmax`), moc (`Watts`, `WWatt`), zawór EEV (`EEV`, `EEV_dt`, `EEV_pos`, `EEVmin`, `EEVmax`), stany wyjść (`HPS`, `HCS`, `CCS`, `CO`, `SHS`, `F`, `FLW`), błędy (`ERR`, `ERRn`, `ERRc`) i ostatni cykl (`lt_pow`, `lt_hp_on`). `PV.total_power` dopisuje serwer z ostatniego odczytu PV; rekordy sprzed 2026-09-26 mają pełne `PV` z telemetrii.

Indeksy: `{rootId, createdAt}`, `{createdAt}`, `{deviceId}`. Ok. 7 100 dokumentów dziennie (ok. 4,3 MB przed kompresją). Liczniki diagnostyczne `co` nie są zapisywane (schemat ścisły); ostatnia surowa telemetria jest w `GET /api/hp` z pamięci serwera.

### `pv`

Odczyt DTU (`POST /api/pv/add`), jeden dokument na odczyt: `rootId`, `deviceType`, `deviceId`, `time`, `total_power`, `total_prod`, `total_prod_today`, `temperature`, `pv_power` i `panels[]`. `panels` jest usuwane z dokumentów starszych niż 90 dni (`PANEL_DETAILS_RETENTION_DAYS`), podsumowanie zostaje. Indeksy: `{rootId, createdAt}`, `{createdAt}`. Ok. 720 dokumentów dziennie.

### `heat_pump_cwu_loading`

Jeden dokument na pompę (unikalny `{rootId}`): `active`, `refreshedAt`, `pelletBlock`. Ustawia go kocioł (`PUT /hp/cwu-loading`, co minutę), żeby restart serwera nie przerwał trwającego ładowania CWU ani nie zostawił pompy na podwyższonych temperaturach.

## Kocioł pelletowy

### `pellet_boiler_pelux200`

Odczyt kotła co kilka minut: stan (`state`, `alarm`, `alerts_active`), temperatury i nastawy (`heating_temp`, `heating_target`, `water_heater_temp`, `water_heater_target`, `outside_temp`, `optical_temp`, mieszacze `mixer1_*`, `mixer2_*`), paliwo i moc (`fuel_level`, `fuel_consumption`, `fuel_burned_kg`, `boiler_load`, `boiler_power`, `fan_power`), wyjścia (`fan`, `feeder`, pompy, `lighter`, `output_flags`) i `heat_pump_running`. Schemat ścisły. Indeks: `{rootId, createdAt}`. Ok. 2 650 dokumentów dziennie.

### `pellet_boiler_pelux200_alerts`

Alarm z panelu kotła: `code`, `from` i `fromRaw` (początek; `fromRaw` w sekundach ecoMAX), `to` i `toRaw` (koniec, uzupełniany później), `initial` (wpis z pierwszego przesłania), `uncertain`, `seenAt`. Indeksy: unikalny `{rootId, code, fromRaw}`, `{rootId, from}`.

### `pellet_boiler_pelux200_commands`

Zlecenie zmiany parametru regulatora z aplikacji: `kind` (`ecomax`, `mixer`), `mixer` (od 1), `index`, `value` (surowa), `previous`, `label`, `status` (`pending`, `sent`, `done`, `error`, `replaced`), `waitOff`, `error`, `sentAt`, `doneAt`. Indeksy: `{rootId, createdAt}`, `{rootId, status, createdAt}`.

### `pellet_boiler_pelux200_settings`

Ostatni odczyt ustawień regulatora, jeden dokument na kocioł (unikalny `{rootId}`): `readAt`, `deviceId`, surowe odpowiedzi regulatora jako hex (`ecomax_parameters`, `mixer_parameters`, `thermostat_parameters`, `schedules`, `regulator_data_schema`). Serwer rozkodowuje je przy odczycie.

### `pellet_boiler_pelux200_schedules` i `pellet_boiler_pelux200_schedule_settings`

Wpis harmonogramu: `mode` (`heat-pump` albo `pellet`), `type` (`cwu` albo `season`), `enabled`, `dayOfWeek` albo data, `startTime`, `endTime`, dla CWU `cwuFrom` i `cwuTo`, dla sezonu `season` (`winter`, `summer`), `winterBelow`, `summerAbove`, `coldBelow`; indeks `{rootId, mode}`. Ustawienia (jeden dokument na kocioł, unikalny `{rootId}`): `enabled`, `defaults` i `profiles` dla obu trybów, `lastApplied`, `lastAppliedAt` oraz stan automatów: `cwuLoading`, `pelletCwu`, `pendingTurnOn`, `autoPellet`, `manualSeason`, `winterCycle`, `winterMixer`.

## Włącznik

- **`switch_relays`**: jeden dokument na przekaźnik (unikalny `{rootId, relay}`, `relay` od 1): `name`, `mode` (`schedule`, `on`, `timer`, `off`, `pause`), `until`, `modeSource` (`app` albo `controller`), `modeChangedAt`, stan ze sterownika `on`, `changedAt`, `lastSeenAt`.
- **`switch_schedules`**: `relay`, `enabled`, `dayOfWeek` albo `date`, `startTime`, `endTime`; indeks `{rootId, relay}`.
- **`switch_activations`**: `relay`, `onAt`, `offAt` (`null` = trwa), `source` (`schedule`, `app`, `controller`), `approximate`; indeksy `{rootId, onAt}`, `{rootId, relay, offAt}`.

## Hydrofor

- **`water_pressure_tank`**: jedno uruchomienie pompy na `runId` sterownika: `pumpStart`, `pumpEnd`, `compressorStart`, `compressorEnd`, `compressorRunning`, `restarts`, `manualSeconds`, `timeApproximate`, `lastSeenAt`. Indeksy: unikalny `{rootId, runId}`, `{rootId, pumpStart}`. Wody nie zapisuje: serwer liczy ją przy odczycie z czasu pompy i wodomierza. Starsze dokumenty mogą mieć nieużywane `waterLiters`, `waterAirBaseLiters`, `waterMembraneLiters`.
- **`water_meter`**: ręczne odczyty wodomierza: `readAt`, `valueM3`, `note`; indeks `{rootId, readAt}`.

## Pozostałe

- **`weather_tiles`**: `name`, `lat`, `lon`, `ownerId`, `sortOrder`, `hidden`, `home` (kafelek „Dom”, tworzony przy starcie serwera), `current` (bieżąca lokalizacja przeglądarki, bez współrzędnych); indeks `{ownerId}`. Pogody nie zapisuje.
- **`push_subscriptions`**: subskrypcja Web Push przeglądarki lub telefonu: `userId`, `endpoint` (unikalny), `keys {p256dh, auth}`, `label`, `lastUsedAt`; indeks `{userId}`.
- **`mail_outbox`**: kolejka maili dla wysyłki przez sterowniki (opcja w Ustawieniach, od 2026-11-07 domyślnie wyłączona): `to`, `subject`, `raw` (wiadomość MIME), `status`, `attempts`, `leasedBy`, `leaseUntil`, `receipt`, `sentBy`, `sentAt`, `error`, `expiresAt`. Indeksy: `{status, createdAt}` i TTL dobę po utworzeniu.

## Zmiany w modelu danych

- **Nowe pole:** model w `server/src/**/models/`, typy serwera i klienta, widoki. W `hp` i `pellet_boiler_pelux200` bez wpisu w schemacie pole się nie zapisze.
- **Nowa kolekcja z danymi sterownika:** pole `rootId`, żeby usunięcie konta ją objęło. Kolekcja konfiguracji: dopisać ją do kopii do Atlasa (`vm-prod/sync-atlas.js` w `oracle-cloud`).
- **Usunięcie kolekcji, pola albo indeksu z kodu:** usunąć je też w bazie produkcyjnej i testowej, po kopii zapasowej. Mongoose sam tego nie robi.
- **Odczyt danych z komputera:** tunel SSH i konto `myhome_test` dla bazy testowej. Produkcji nie zmieniać ręcznie bez kopii.

## Porządki 2026-11-08

Usunięte 8.11.2026 z `hpdb` i `hpdb_test` pozostałości po usuniętym kodzie, nieużywane przez aplikację. Kopia przed usunięciem: `/srv/apps/storage/backups/pozostalosci-20261108.tar.gz` na serwerze.

| Element | Pochodzenie |
|---|---|
| kolekcja `settings` (1 dokument: `night_hour`, `settings`, `cwu_settings`) | dawny model ustawień czasowych pompy, usunięty z kodu 2026-10-21 |
| kolekcja `tile_template` (pusta) | projektant kafelków, usunięty z kodu |
| kolekcja `migrations` (1 dokument) | jednorazowa migracja właścicieli (`INITIAL_OWNER_EMAIL`), usunięta z kodu 2026-11-07 |
| indeksy `devices` `{settings.rootId}` i `{hp.rootId}` | pola dawnego modelu urządzenia |
