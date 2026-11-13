# Firmware co — dokumentacja techniczna

[← Dokumentacja systemu](../../../docs/README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](en/3-technical-documentation.md)

## Sprzęt

| Element | Szczegóły |
|---|---|
| Płytka | ESP32 (PlatformIO `esp32dev`) |
| RS-485 | 9600 8N1, półdupleks; adresy: CHPC `0x41`, DTU `0x69`, `co` `0x10` |
| Ekran | ST7735 128×160, pionowo |
| Zegar | RTC DS3231, synchronizacja NTP (czas polski) |
| Przycisk | GPIO5, aktywny stan wysoki, debounce 50 ms |
| Przekaźniki | CO i CWU (przełączane razem) |

Piny i adresy są w `src/hardware_config.hpp`.

Od 2026-10-03 odczyt pieca Pellux 200 (magistrala ecoMAX, dawniej UART2 tego sterownika) działa na osobnej płytce — [devices/pellet-boiler-pelux200](../../pellet-boiler-pelux200/README.md).

## Pliki (`devices/co/src`)

| Plik | Rola |
|---|---|
| `main.cpp` | pętla główna: odczyty CHPC i PV, przycisk trybu, wymiana z chmurą, odpowiedzi `co` jako urządzenia 0x10 |
| `access_point_policy.*` | kiedy AP `MyHome-HeatPump-XXXX` ma działać (3 min / 1 min / 5 min) |
| `cloud_client.*` | HTTPS do My Home (`hp/add`, `pv/add`, `devices/register`), WebSocket `/ws?rootId=` (od 1.4.0 także `qnap` → jedno polecenie w RAM, `sendQnapResult`), obsługa 409 |
| `command_sink.hpp` | interfejs kolejki komend (na urządzeniu `SerialBus`, w testach `RecordingSink`) |
| `config_portal.*` | serwer WWW na porcie 80 (`/`, `/telemetry.json`, `/pv.json`, `/install`, `/save`) |
| `cop_estimator.*` | szacunek COP zbiornika 300 l dla cyklu sprężarki |
| `device_config.*` | Wi-Fi i Root ID w NVS (przestrzeń `hp`), SN z MAC, dane logowania do `/install`; przy starcie usuwa klucze dawnej roli pieca |
| `device_io.*` | ekran, RTC i NTP, Wi-Fi AP+STA, przekaźniki, zapis odpowiedzi na magistralę |
| `domain_types.hpp` | typy PV, `SERIAL_OPERATION`, `WORK_MODE`, `ControllerMode`, `DeviceSettings` |
| `hardware_config.hpp` | adresy 0x10 i 0x69, mapa rejestrów DTU, piny |
| `heat_pump_data_processor.*` | parsowanie JSON z CHPC, przekazanie danych do estymatora COP |
| `json_converters.hpp` | konwertery ArduinoJson (pola PV, `time` jako `YYYY.MM.DD HH:MM:SS`, tryby) |
| `modbus_frame.*` | ramki komend CHPC (5 B), zapytania Modbus do DTU (8 B), CRC-16/MODBUS |
| `operation_controller.*` | stan z chmury → komendy RS-485 (tylko zmiany), tryby, sekwencja OFF, force z PV, ponawianie po niezgodności, przekaźniki |
| `operation_parser.*` | JSON `operation` → `ServerOperationState`, z zakresami |
| `operation_types.hpp` | `ServerValue`/`ServerOperationState` (flaga `present`), `HeatPumpReport`, scalanie |
| `pv_data_processor.*` | dwie odpowiedzi DTU → sumy instalacji i `panels[]` |
| `pv_telemetry.*` | dokument `POST /api/pv/add` i `/pv.json` |
| `qnap_relay.*` | polecenia dla QNAP-a (od 1.4.0, próbnie): `parseQnapAddress` (tylko prywatny IPv4:port), `parseQnapRequest` (wiadomość `qnap`), `buildQnapResult` (odpowiedź `qnap_wynik`, ciało do 1 KB bez rozcinania znaku UTF-8); bez Arduino, testy `native`. Sam `POST` wysyła `relayQnapRequest` w `main.cpp` |
| `serial_bus.*` | kolejka RS-485 w trzech klasach (bezpieczeństwo, kontynuacja PV, zwykłe); 500 ms, 3 s, 5 ms |
| `telemetry.*` | dokument `POST /api/hp/add` i `/telemetry.json` |
| `secrets.example.h` | wzór `secrets.h` (poza gitem): domyślne Wi-Fi i opcjonalny `CLOUD_ROOT_ID` |

## Protokół RS-485 z CHPC

Ramka komendy: `[0x41][cmd][d1][d2][0xFF]`. Liczby dziesiętne: `d1` = część całkowita, `d2` = setne. Waty: `d1 = W/100`, `d2 = W%100`.

| cmd | Znaczenie | Źródło w operacji |
|---|---|---|
| `0x01` | odczyt JSON | cykliczny odczyt |
| `0x03` | force start 0/1 | `force` (w `PV` — z produkcji PV) |
| `0x04` | T zadana (max) | `co_max` albo `cwu_max` |
| `0x05` | delta T | max − min |
| `0x08` | przegrzanie EEV | `eev_setpoint` |
| `0x09` / `0x0A` / `0x0B` | pompa gorąca / zimna / grzałka karteru | `hot_pomp`, `cold_pomp`, `sump_heater` |
| `0x0C` | CO on/off | `work_mode` (+ przekaźniki CO/CWU) |
| `0x0D` | EEV max (26–255) | `eev_max_pulse_open` |
| `0x0F` | EEV min (25–255), wysyłane po `0x0D` | `eev_min_pulse_open` |
| `0x0E` | limit mocy (1001–4000 W) | `working_watt` |
| `0x10` | odblokowanie po 5 błędach | akcja `error_reset` |
| `0x11` | restart programowy CHPC | akcja `restart` (potem cały stan od nowa) |

`co` odpowiada też jako urządzenie `0x10`: `0x01` — telemetria z `PV` i `pv_power` w jednym JSON, `0x02` — ustawienia i `controller_mode`, `0x03` — nic.

DTU: dwa zapytania Modbus po pięć portów — od `0x1000` i od `0x10C8` (porty co `0x28` adresów, choć rekord ma 20 rejestrów).

## Kontrakt z chmurą

| Kierunek | Adres | Treść |
|---|---|---|
| `co` → serwer | `POST /api/hp/add?deviceId=SN&rootId=…` | telemetria (opis w [module heat-pump](../../../docs/moduly/heat-pump/3-dokumentacja-techniczna.md)) |
| serwer → `co` | odpowiedź | `{"operation": {...napisy...}, "t_out": 12.3}` |
| `co` → serwer | `POST /api/pv/add?...` | `time`, `total_power` (wymagane), `total_prod`, `total_prod_today`, `temperature` (najniższa z portów), `pv_power` (≥ 2000 W), `panels[]` |
| `co` → serwer | `POST /api/devices/register` | `{deviceType: "heat_pump", deviceId: SN, ip}` — przy każdym starcie, po zmianie IP i po 409 (`registrationDue()`), także z Root ID; inny `rootId` z odpowiedzi zastępuje zapisany i restartuje WebSocket |
| serwer → `co` | WebSocket `/ws?rootId=` | `{"type":"operation"}` → natychmiastowy `hp/add`; po połączeniu `co` wysyła tekst `ESP32`, po którym serwer rozpoznaje gniazdo sterownika |
| serwer → `co` → serwer | WebSocket (to samo połączenie) | od 1.4.0, próbnie: `{"typ":"qnap",…}` → `POST` do QNAP-a w sieci domowej → `{"typ":"qnap_wynik",…}` (niżej) |

Do 1.3.4 kontrakt miał jeszcze **pogodę zapasowo** (od 1.3.1: `weather_queries [{id, lat, lon}]` w odpowiedzi `hp/add`, pobranie z Open-Meteo przy wolnej magistrali, w następnym `hp/add` pole `weather [{id, temp, code, …}]` i liczniki `weather_ok`, `weather_fail`, `weather_code`) oraz **przekaźnik poczty** (od 1.3.0: `mailKey` w zgłoszeniu, dane SMTP w odpowiedzi, komunikat WebSocket `{"type":"mail"}`, `GET /api/mail/next`). Od 1.4.0 (2026-11-13) nie ma żadnego z nich, a zapasu nie ma w żadnym sterowniku (włącznik 1.4.0 też ich nie obsługuje): pogodę pobiera i maile wysyła tylko serwer na Oracle. Serwer nie wysyła `co` pola `weather_queries` i pomija `weather`, liczniki `weather_*` i `mailKey` od starszego `co`; zadanie przekaźnika poczty starszego `co` dostaje 404 z usuniętych `/api/mail/*` (tylko wpisy w dzienniku płytki).

Nieprzyjęty odczyt PV sterownik ponawia co 60 s, aż zastąpi go nowszy.

### Polecenia dla QNAP-a (od 1.4.0, próbnie)

Od 2026-11-13. Gdy QNAP w domu nie jest widoczny z zewnątrz, a w sieci domowej działa, serwer może przez `co` wysłać mu jedno z poleceń `stan`, `restart_sieci`, `restart` (polecenie `--qnap` na serwerze, opis w [module core](../../../docs/moduly/core/3-dokumentacja-techniczna.md#polecenia-dla-qnap-a-przez-sterownik-co-próbnie)). Ok. 2026-12-13 sprawdzamy, czy było używane; bez użycia obsługa `qnap` zniknie z firmware. Wiążąca umowa z usługą na QNAP-ie: prywatne repozytorium `oracle-cloud`, `qnap/polecenia-przez-co.md`.

| Kierunek | Wiadomość |
|---|---|
| serwer → `co` (WebSocket) | `{"typ":"qnap","id":"<id żądania>","adres":"<adres>:<port>","cialo":"<JSON jako tekst>","podpis":"<64 znaki hex>"}` |
| `co` → QNAP (sieć domowa) | `POST http://<adres>:<port>/polecenie`, `Content-Type: application/json`, nagłówek `X-Podpis: <podpis>`, ciało bez zmian |
| `co` → serwer (WebSocket) | `{"typ":"qnap_wynik","id":"…","status":<kod HTTP albo 0>,"cialo":"<odpowiedź QNAP-a, najwyżej 1 KB>"}` |

- **Sprawdzenie** (`parseQnapRequest`): `id` niepusty, do 64 znaków (inaczej wiadomość jest pomijana); adres tylko prywatny IPv4 z portem (10/8, 172.16/12, 192.168/16, port 1–65535); ciało niepuste, najwyżej 1 KB; podpis 64 znaki hex małymi literami. Złe pole daje od razu `qnap_wynik` ze statusem 0 i krótkim opisem.
- **Kolejka:** najwyżej jedno polecenie w RAM. Drugie w trakcie pierwszego dostaje od razu `qnap_wynik` ze statusem 0 („sterownik wykonuje poprzednie polecenie”).
- **Wysyłka** (`relayQnapRequest` w `main.cpp`): dopiero przy wolnej magistrali RS-485 i połączonym Wi-Fi, blokujący `POST` z limitem 10 s (połączenie 4 s, odpowiedź 6 s). Każdy kod HTTP wraca do serwera z odpowiedzią QNAP-a przyciętą do 1 KB bez rozcinania znaku UTF-8; brak połączenia to status 0 z opisem.
- **Bez klucza i bez pamięci:** sterownik klucza HMAC nie zna (podpis sprawdza usługa na QNAP-ie), niczego nie zapisuje, nie ponawia i nic nie wysyła do QNAP-a sam z siebie. Nic z QNAP-a nie trafia do `hp/add`.
- **Testy:** `test/test_qnap_relay` (4): adres tylko z sieci prywatnej, odczyt bez zmiany ciała, inne wiadomości i złe pola, odpowiedź z limitem 1 KB.

## Strony WWW (port 80)

| Adres | Dostęp | Zawartość |
|---|---|---|
| `GET /` | otwarty | podgląd (HTML `TELEMETRY_PAGE` w `config_portal.cpp`; JS co 5 s pobiera oba JSON-y) |
| `GET /telemetry.json` | otwarty | dokument telemetrii |
| `GET /pv.json` | otwarty | odczyt PV z panelami (`{}` przed pierwszym odczytem) |
| `GET /install` | Basic Auth | Wi-Fi, SN i Root ID tylko do odczytu, stan rejestracji (szablon `PAGE_TEMPLATE`) |
| `POST /save` | Basic Auth | `ssid`, `password` (puste = bez zmian); zapis w NVS, restart po 500 ms |

Nieznany adres przekierowuje (302) na `/`. Login i hasło do `/install` są w `src/device_config.hpp`. Teksty stron są po angielsku (od 1.3.3: tytuł „Heat pump controller”, przyciski „Save and restart” / „Register and restart”, stan „Registered in the cloud” / „Not registered…”). W 1.3.0–1.3.4 strona `/install` miała też pole „Mail (board key)” z odciskiem klucza i stanem przekaźnika poczty (po polsku, z `devices/common/mail_relay`); od 1.4.0 go nie ma.

![Strona główna (szeroka)](img/strona-glowna.png)

## Konfiguracja

| Klucz NVS (`hp`) | Znaczenie |
|---|---|
| `wifi_ssid`, `wifi_pass` | Wi-Fi (pusty = wartość z `secrets.h`) |
| `root_id` | Root ID z rejestracji (pusty = `CLOUD_ROOT_ID` z `secrets.h`, jeśli podany) |
| `mode` | tryb sterownika (`ControllerMode`), domyślnie `CLOUD` |
| `pellet_root`, `pellet_poll` | dawna rola pieca (firmware 2026-10-01–02); `loadDeviceConfig()` usuwa je przy starcie |

Ustawienia z chmury (`DeviceSettings`: tryb pracy, temperatury) są tylko w pamięci RAM; po starcie domyślnie `OFF`, 35/45, 40/47, aż do pierwszej operacji.

## Budowanie, testy, wgrywanie

```bash
cp devices/co/src/secrets.example.h devices/co/src/secrets.h   # raz, uzupełnić
pio test -d devices/co -e native     # 89 testów (2026-11-13): kontroler operacji, parser, COP, ramki Modbus, PV, polityka AP, diagnostyka, OTA, polecenia dla QNAP-a
pio run -d devices/co                # build esp32dev
pio run -d devices/co -t upload      # wgranie przez USB
```

Testy `native` nie wymagają sprzętu (`test/test_access_point_policy`, `test/test_bus_diagnostics`, `test/test_hp_link_watch`, `test/test_modbus_frame`, `test/test_operation_controller`, `test/test_ota`, `test/test_pv_data_processor`, `test/test_qnap_relay`; `test_weather_backup` usunięty w 1.4.0 razem z pogodą). Build `esp32dev` 1.4.0 (2026-11-13): RAM statyczny 17,3 % (56 800 B; 1.3.4: 57 000 B), Flash 57,3 % z partycji 1,9 MB (1 126 697 B z kodem poleceń dla QNAP-a; 1.3.4: 1 145 873 B z przekaźnikiem poczty i pogodą); bez zadania przekaźnika poczty zostaje też 16 KB jego stosu. Kod RS-485 `co` jest też używany w teście całego łańcucha (`test/e2e`, most `bridge.exe`), obecnie nieaktualnym.

Kolejność wdrożenia: najpierw serwer, potem `co`, na końcu CHPC.

## Historia

- [Opis stanu przed przebudową (2026-09-10)](baseline-before-server-driven-refactor.md)
- [Przebudowa na sterowanie z serwera (2026-09-20)](server-driven-refactor-2026-09-20.md) — część opisów jest już nieaktualna (liczba stron WWW, stały AP, wysyłka przed rejestracją); obowiązuje ten dokument.
- [Propozycja: dostęp do QNAP-a przez `co` (2026-11-13)](propozycja-qnap-2026-11-13.md) — warianty do decyzji; wdrożono z nich tylko polecenia, inną drogą (WebSocket zamiast `hp/add`, wyżej „Polecenia dla QNAP-a”).

## Znane problemy

- **Akcje `error_reset` i `restart` giną poza trybem `CLOUD`**: `applyServerOperation` (`main.cpp`) odrzuca wtedy całą operację, a serwer wysyła akcję tylko raz. Komentarz w `operation_controller.cpp` („Maintenance actions run in every controller mode”) opisuje zamiar, który nie jest spełniony.
- **Nieaktualny TODO** w `main.cpp` („Scheduler must perform the MANUAL -> AUTO transition”) — serwer już to robi.
- **`DeviceSettings.controllerMode`** jest nieużywane; tryb trzyma `OperationController::localMode`.
- **Bezpieczeństwo**: otwarty AP, login i hasło `/install` w kodzie, HTTPS bez sprawdzania certyfikatu.
- **Walidacja zakresów po cichu**: wartość spoza zakresu nie jest stosowana, a aplikacja tego nie pokazuje.
- **Polecenie dla QNAP-a blokuje pętlę** do 10 s (jak dawniej pobieranie pogody), ale tylko przy wolnej magistrali. Gdy magistrala nie zwolni się przed upływem 20 s, serwer kończy czekanie („brak odpowiedzi sterownika”) i pomija późniejszy wynik, a polecenie może mimo to dojść do QNAP-a później.
