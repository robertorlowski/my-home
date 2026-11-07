# Włącznik — sterownik `switch`

Sterownik na gotowej płytce „ESP32 Relay AC X1” (ESP32-WROOM-32E, przekaźnik 30 A, zasilacz 230 V na płytce), który włącza i wyłącza odbiornik 230 V według poleceń z My Home: harmonogram, włączenie na czas albo bez limitu, wyłączenie. Zgłasza się do chmury sam, a nowe wersje firmware pobiera przez sieć (OTA).

Dokumentacja: **[1. Opis biznesowy](docs/1-opis-biznesowy.md)** (z listą kontrolną przed wdrożeniem) · [2. Zasada działania](docs/2-zasada-dzialania.md) · [3. Dokumentacja techniczna](docs/3-dokumentacja-techniczna.md) (schematy podłączenia, pierwsze wgranie) · [English](docs/en/1-business-description.md). Strona chmury i aplikacji: [moduł switch](../../docs/moduly/switch/1-opis-biznesowy.md).

## Budowanie i wgrywanie

```sh
cp src/secrets.example.h src/secrets.h   # nazwa i hasło AP, login /install, domyślne Wi-Fi
pio run                                  # build (esp32dev, produkcja: https://dom.mojeturnie.pl/api/)
pio run -e esp32dev-local                # build do testu z lokalnym serwerem (npm run local; adres w platformio.ini)
pio test -e native                       # testy logiki na PC (11)
pio device monitor                       # konsola (UART0, 115200, złącze P1 i przejściówka USB-TTL)
```

Pierwsze wgranie tylko przez złącze P1 i przejściówkę USB-TTL (płytka nie ma USB): [część 3, „Pierwsze wgranie”](docs/3-dokumentacja-techniczna.md#pierwsze-wgranie-przez-złącze-p1). Kolejne wersje przez sieć: strona `/install` sterownika albo oferta OTA z aplikacji.

## Pliki

| Plik | Zawartość |
|---|---|
| `src/switch.cpp` | Wi-Fi i punkt dostępowy, zgłoszenie, wymiana stanu z chmurą co 5 s, WebSocket, OTA, strony `/`, `/state.json`, `/relay`, `/install`, `/install/firmware` |
| `src/firmware.hpp` | typ, wersja (`FW_VERSION`), nazwa, piny i poziom przekaźników, domyślny czas włączenia, adres chmury (`SWITCH_CLOUD_URL`) |
| `src/relays.*` | `RelayBank`: polecenia chmury, odliczanie włączeń na czas, zmiany lokalne czekające na wysłanie (`pending`, `pendingSeq`) |
| `src/protocol.*` | JSON zgłoszenia stanu, odpowiedzi z poleceniami, `PUT switch/mode` i ustawienia z chmury |
| `src/ota.*` | ocena oferty OTA (ta sama logika co w hydroforze) |
| `src/net_recovery.*` | naprawa łączności bez odpowiedzi serwera: nowe połączenie, ponowne Wi-Fi, restart (od 1.3.7) |
| `src/secrets.example.h` | wzór `secrets.h` (poza gitem) |
| `test/test_logic` | testy `native` powyższej logiki |

## Stała konfiguracja w kodzie

- Przekaźnik na `GPIO2`, stan wysoki = włączony (`RELAY_PINS = {2}`, `RELAY_ACTIVE_HIGH = true`). GPIO2 to pin trybu startu ESP32; wyjściem staje się dopiero w `setup()`.
- Punkt dostępowy `MyHome-Switch-XXXX` (XXXX = ostatnie 4 znaki SN; od 2026-10-10, wcześniej `Wlacznik-setup`) pod adresem `10.10.10.1` (ten sam we wszystkich sterownikach), domyślnie otwarty; działa po starcie i po 1 min bez Wi-Fi.
- Złącze P1 ma pin **3V3 (3,3 V, nie 5 V)**. Płytkę zasila się z 230 V albo z osobnego źródła 3,3 V — nie z przejściówki.
