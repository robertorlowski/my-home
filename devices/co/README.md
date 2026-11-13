# co — sterownik pompy ciepła (ESP32)

**Dokumentacja:** [opis biznesowy](docs/1-opis-biznesowy.md) · [zasada działania](docs/2-zasada-dzialania.md) · [dokumentacja techniczna](docs/3-dokumentacja-techniczna.md) · [English](docs/en/1-business-description.md)

Firmware sterownika, który łączy pompę ciepła CHPC z chmurą My Home.
Sterownik odczytuje pompę i instalację fotowoltaiczną po RS-485, wysyła
telemetrię do chmury i wykonuje ustawienia, które z niej otrzymuje.

Od 2026-10-03 odczyt pieca Pellux 200 działa na osobnej płytce —
[devices/pellet-boiler-pelux200](../pellet-boiler-pelux200/README.md). Wcześniej
(2026-10-01–02) był drugą rolą tego sterownika (UART2).

```text
pompa CHPC (0x41) ───┐
                     ├── RS-485 ── co (ESP32) ── Wi-Fi / HTTPS ── My Home ── przeglądarka
DTU Hoymiles (0x69) ─┘                 │
                                       ├── przekaźniki CO / CWU
                                       ├── wyświetlacz ST7735, RTC DS3231
                                       └── przycisk trybu
```

Powiązane repozytoria:

Cały system jest w repozytorium [robertorlowski/my-home](https://github.com/robertorlowski/my-home)
(od 2026-09-27; wcześniej to był osobny projekt heatpomp):

| Katalog w My Home | Rola |
|---|---|
| `devices/co` (ten katalog) | firmware `co` na ESP32 |
| `devices/chpc` | firmware pompy CHPC (Arduino Pro Mini) |
| `server`, `client` | serwer i klient WWW, harmonogramy, historia telemetrii |
| `test/e2e` | testy E2E całego łańcucha |

## Co robi sterownik

- **Odczyty.** Co 10 s, gdy sprężarka pracuje, i co 30 s w spoczynku, odpytuje
  pompę (JSON). Niezależnie od tego co 60 s i zaraz po starcie odpytuje DTU
  Hoymiles (Modbus, dwa zapytania po pięć portów, od 0x1000 i od 0x10C8).
  Szacuje COP zbiornika w każdym cyklu grzania.
- **Chmura.** Wysyła telemetrię pompy przez `POST /api/hp/add` i w odpowiedzi
  dostaje obiekt `operation`. Komunikat WebSocket `operation` przyspiesza tę
  wymianę. Zmienione ustawienia trafiają do pompy jako komendy RS-485. Komenda,
  której efektywna wartość się nie zmieniła, nie jest wysyłana ponownie. Odczyt
  PV (podsumowanie i wszystkie porty: moc, napięcia, prąd, częstotliwość sieci,
  temperatura, alarmy) idzie osobno przez `POST /api/pv/add`.
- **Rejestracja.** Każde żądanie niesie SN (`deviceId`), czyli fabryczny MAC
  układu, a Root ID tylko wtedy, gdy jest zapisany. Przy każdym starcie i po
  każdej zmianie adresu IP sterownik zgłasza się przez
  `POST /api/devices/register` (SN i adres IP, który aplikacja pokazuje w
  Ustawieniach) i zapisuje otrzymany Root ID w NVS, gdy jest inny niż
  zapisany. Znany SN dostaje z powrotem swój dotychczasowy Root ID. Gdy serwer odpowie 409 (Root ID należy do innego SN),
  sterownik kasuje Root ID i rejestruje się ponownie.
- **Bez pogody i poczty** (od 1.4.0, 2026-11-13). W wersjach 1.3.0–1.3.4
  sterownik był zapasem włącznika: pobierał pogodę z Open-Meteo i wysyłał maile
  aplikacji (wspólne biblioteki `devices/common/weather` i
  `devices/common/mail_relay`, usunięte 2026-11-13). Teraz robi to tylko serwer
  na Oracle, który ma własny adres IP; włącznik od 1.4.0 też tego nie robi.
- **Polecenia dla QNAP-a** (od 1.4.0, 2026-11-13, próbnie). Na wiadomość
  WebSocket `{"typ":"qnap"}` z podpisanym poleceniem (`stan`, `restart_sieci`,
  `restart`) sterownik wysyła je bez zmian `POST`-em do usługi na QNAP-ie w sieci
  domowej i odsyła wynik `{"typ":"qnap_wynik"}`. Klucza nie zna, niczego nie
  zapisuje i nie ponawia. Ok. 2026-12-13 sprawdzamy, czy było używane; bez
  użycia funkcja zostanie usunięta. Opis: [dokumentacja techniczna](docs/3-dokumentacja-techniczna.md#polecenia-dla-qnap-a-od-140-próbnie).
- **Punkt dostępowy** `MyHome-HeatPump-XXXX` (XXXX = ostatnie 4 znaki SN, otwarty, adres `10.10.10.1`; od 2026-10-10, wcześniej `HP-CO-setup`) startuje razem ze sterownikiem i jest
  wyłączany po 3 min stabilnego dostępu do chmury; wraca po 1 min bez Wi-Fi
  albo po 5 min bez odpowiedzi chmury.
- **Tryby.** Przycisk na GPIO5 przełącza tryb sterownika
  `OFF → CLOUD → MANUAL_CO → MANUAL_CWU → OFF`. Pierwsze naciśnięcie tylko
  pokazuje bieżący tryb, każde kolejne przechodzi do następnego. Tryb jest
  stosowany 5 s po ostatnim naciśnięciu i przetrwa restart. W trybie `CLOUD` obowiązuje
  `work_mode` z chmury (`M`, `A`, `PV`, `CWU`, `OFF`). Pełna semantyka trybów:
  [docs/server-driven-refactor-2026-09-20.md](docs/server-driven-refactor-2026-09-20.md#6-semantyka-trybów).
- **Strony WWW na porcie 80**, w sieci lokalnej i na własnym, otwartym punkcie
  dostępowym `MyHome-HeatPump-XXXX`, gdy jest włączony:

  | Adres | Dostęp | Zawartość |
  |---|---|---|
  | `/` | otwarty | podgląd telemetrii, odświeżany co 5 s |
  | `/telemetry.json` | otwarty | telemetria pompy |
  | `/pv.json` | otwarty | ostatni odczyt PV z panelami |
  | `/install` | Basic Auth (login `admin`, hasło w `src/device_config.hpp`) | Wi-Fi, SN i Root ID (tylko do odczytu), status rejestracji |
  | `/save` | hasło | zapis Wi-Fi i restart |

  Strony i ekran są po angielsku (od 1.3.3), np. „Heat pump controller”,
  „Save and restart”, na ekranie `T. out:` (temperatura zewnętrzna) i tryb `MANUAL`.

## Sprzęt

| Element | Połączenie |
|---|---|
| ESP32-WROOM (`esp32dev`) | — |
| RS-485 (pompa CHPC `0x41`, DTU `0x69`) | `Serial`, 9600 b/s |
| Wyświetlacz ST7735 | DC 12, CS 13, MOSI 14, CLK 27, RST 0 |
| Dawne przekaźniki CO / CWU | GPIO26 / GPIO25, wolne od 1.2.0 |
| Zasilanie modułów | GPIO18 |
| Przycisk trybu | GPIO5, z zewnętrznym rezystorem |
| RTC DS3231 | I²C, synchronizacja z NTP co 6 h |

Piny i adresy są w [src/hardware_config.hpp](src/hardware_config.hpp) oraz
[src/modbus_frame.cpp](src/modbus_frame.cpp).

## Budowanie i wgrywanie

Wymagane jest PlatformIO (CLI albo rozszerzenie w VS Code; `pio` jest wtedy
w `~/.platformio/penv/Scripts/`).

1. Skopiuj `src/secrets.example.h` do `src/secrets.h` i uzupełnij Wi-Fi.
   `CLOUD_ROOT_ID` jest opcjonalny: bez niego sterownik zarejestruje się sam.
   Wartości z `secrets.h` są tylko domyślne, bo dane zapisane na stronie
   `/install` mają pierwszeństwo.
2. Zbuduj i wgraj:

   ```sh
   pio run                  # build
   pio run -t upload        # wgranie
   pio device monitor       # port szeregowy, 9600 b/s
   ```

Przed wgraniem firmware z nową funkcją chmury najpierw wdróż odpowiednią wersję
My Home, na przykład endpoint rejestracji.

## Testy

**Jednostkowe** (to repo): działają na komputerze, bez płytki. Potrzebny jest
g++ (MinGW) w `PATH`.

```sh
pio test -e native
```

| Zestaw | Co sprawdza |
|---|---|
| [test_operation_controller](test/test_operation_controller/test_main.cpp) | scalanie operacji z chmury, tryby, reguły `OFF` i `AUTO_PV`, brak powtórnych komend |
| [test_pv_data_processor](test/test_pv_data_processor/test_main.cpp) | parser odpowiedzi Modbus z DTU Hoymiles |
| [test_modbus_frame](test/test_modbus_frame/test_main.cpp) | kodowanie ramek RS-485 i CRC |
| [test_access_point_policy](test/test_access_point_policy/test_main.cpp) | kiedy wyłączyć i włączyć punkt dostępowy `MyHome-HeatPump-XXXX` |
| [test_bus_diagnostics](test/test_bus_diagnostics/test_main.cpp) | diagnostyka magistrali na zlecenie z chmury |
| [test_hp_link_watch](test/test_hp_link_watch/test_main.cpp) | kiedy uznać, że CHPC nie odpowiada |
| [test_ota](test/test_ota/test_main.cpp) | oferta aktualizacji firmware z odpowiedzi `hp/add` |
| [test_qnap_relay](test/test_qnap_relay/test_main.cpp) | polecenia dla QNAP-a: adres tylko z sieci prywatnej, ciało do 1 KB, podpis 64 znaki hex, wynik przycięty do 1 KB bez rozcinania znaku UTF-8 |

**E2E całego łańcucha** (chpc ⇄ RS-485 ⇄ co ⇄ My Home ⇄ przeglądarka) są
w `test/e2e/` w katalogu głównym My Home; instrukcja w `devices/chpc/test/README.md`.
Most testowy kompiluje z tego repozytorium pliki `src/operation_parser.cpp`,
`src/operation_controller.cpp`, `src/modbus_frame.cpp` i
`src/cop_estimator.cpp`, a ArduinoJson bierze z `.pio/libdeps/native`, więc
przed pierwszym uruchomieniem E2E wykonaj tu `pio test -e native`. Zmiana nazw
lub interfejsów tych plików wymaga poprawki w `test/e2e/build-bridge.sh`.

## Struktura kodu

| Plik | Odpowiedzialność |
|---|---|
| `main.cpp` | pętla główna: odczyty, przycisk, wymiana z chmurą |
| `cloud_client` | HTTPS i WebSocket do My Home, rejestracja urządzenia |
| `qnap_relay` | polecenia dla QNAP-a z WebSocketu: odczyt i sprawdzenie wiadomości, odpowiedź `qnap_wynik` (od 1.4.0) |
| `operation_parser` | JSON operacji z chmury → struktury domenowe |
| `operation_controller` | stan z chmury, tryby, efektywne komendy i przekaźniki |
| `serial_bus`, `modbus_frame` | kolejka RS-485 z priorytetami, kodowanie ramek, CRC |
| `heat_pump_data_processor`, `cop_estimator` | odczyt pompy i estymacja COP |
| `pv_data_processor` | odczyt DTU Hoymiles, dane dla każdego panelu |
| `telemetry`, `json_converters` | dokument telemetrii wysyłany do chmury i na stronę `/` |
| `config_portal` | strony WWW na porcie 80 |
| `device_config` | Wi-Fi, Root ID i SN; zapis w NVS |
| `device_io` | wyświetlacz, RTC, NTP, start Wi-Fi |

## Dokumentacja

- [my-home/CLAUDE.md](https://github.com/robertorlowski/my-home/blob/main/CLAUDE.md):
  opis całego systemu i kontraktów między repozytoriami; My Home jest projektem
  wiodącym.
- [docs/server-driven-refactor-2026-09-20.md](docs/server-driven-refactor-2026-09-20.md):
  obecna architektura, przepływ operacji, tryby, UART, chmura.
- [docs/propozycja-qnap-2026-11-13.md](docs/propozycja-qnap-2026-11-13.md):
  propozycja dostępu do QNAP-a przez sterownik z wariantami (historia; wdrożono
  z niej tylko polecenia, inną drogą niż tam opisana).

## Licencja

MIT, szczegóły w [LICENSE](LICENSE).
