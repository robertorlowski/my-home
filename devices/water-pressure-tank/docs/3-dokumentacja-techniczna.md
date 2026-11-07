# Firmware hydroforu — dokumentacja techniczna

[← Dokumentacja systemu](../../../docs/README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · **3. Dokumentacja techniczna** · [English](en/3-technical-documentation.md)

Stronę serwerową (API, kolekcje, woda z czasu pompy, wodomierz) opisuje [moduł water-pressure-tank](../../../docs/moduly/water-pressure-tank/3-dokumentacja-techniczna.md). Pierwotna specyfikacja z historią decyzji: [water-pressure-tank.md](water-pressure-tank.md).

## Sprzęt

| Element | Szczegóły |
|---|---|
| Płytka | **ESP32 DevKit z modułem ESP32-WROOM-32** (38 pinów, USB-C, mostek USB-UART CP2102, przyciski RST i BOOT), PlatformIO `esp32dev`; konsola UART0 115200 |
| Zasilanie | zasilacz 230 V → 5 V (np. HLK-PM01) na przewodzie zasilania pompy (za przekaźnikiem presostatu), na pin **5V** płytki |
| Przekaźnik kompresora | moduł 5 V sterowany stanem niskim (zamontowany: dwukanałowy z transoptorami, używany jeden kanał), `IN` na **GPIO26** (pin „P26”) |
| Zbiorniki | 300 l ocynkowany z poduszką + 300 l przeponowy, równolegle (Hydro-Vacuum) |

## Podłączenie

**Obwód 230 V** (sterownik ma zasilanie tylko wtedy, gdy presostat włącza pompę):

```text
            230 V z przekaźnika presostatu (razem z pompą wody)
              L ──┬─────────────────────────────────────┐
              N ──┼────────────────┐                    │
            ┌─────┴──────┐         │            ┌───────┴───────┐
            │ zasilacz   │         │            │ COM           │
            │ 230V → 5V  │         │            │  przekaźnik   │
            └──┬──────┬──┘         │            │ NO ──┐        │
             +5V     GND           │            └──────┼────────┘
              │       │            │              ┌────┴─────┐
              ▼       ▼            └──────────────┤ kompresor│
         do płytki ESP32 (niżej)                  └──────────┘
```

**Płytka ESP32 DevKit** — rząd pinów z `3V3` i `5V` (podpisy na spodzie płytki; numery od końca z `3V3`):

```text
  1   2   3   4   5   6   7   8   9   10  11  12  13  14  15  16  17  18  19
 3V3  EN SVP SVN P34 P35 P32 P33 P25 P26 P27 P14 P12 GND P13 SD2 SD3 CMD 5V
  │                                   │               │                   │
  │                                   │               │                   ├── +5 V z zasilacza
  │                                   │               │                   └── VCC modułu przekaźnika
  │                                   │               ├── GND (−) z zasilacza
  │                                   │               └── GND modułu przekaźnika
  │                                   └── IN modułu przekaźnika
  └──[ 10 kΩ ]──── IN modułu przekaźnika (rezystor przy module)

  ✗ nie podłączać: P12 (GPIO12), SD2, SD3, CMD (oraz SD0, SD1, CLK w drugim rzędzie)
```

| Połączenie | Pin ESP32 DevKit | Uwagi |
|---|---|---|
| `+5 V` zasilacza | **5V** (19.) | nigdy na `3V3` |
| `GND` zasilacza | **GND** (14.) | nie na `CMD` (sąsiaduje z `5V`) |
| `VCC` modułu przekaźnika | **5V** | razem z zasilaczem |
| `GND` modułu przekaźnika | **GND** | |
| `IN` modułu przekaźnika | **P26** (10.) | `RELAY_PIN` w `firmware.hpp` |
| rezystor 10 kΩ | między `IN` a **3V3** (1.) | blokuje kliknięcie przy starcie |
| serwis: przejściówka USB-TTL | `TX`→**RX** (GPIO3), `RX`←**TX** (GPIO1), `GND` | drugi rząd pinów; tylko do wgrywania i podglądu |

- **Moduł sterowany stanem niskim** (zamontowany; `RELAY_ACTIVE_HIGH = false`): przekaźnik włącza się, gdy `IN` jest ściągnięte do `GND`. Moduł ma 5 V wcześniej, niż ESP32 ma 3,3 V, więc `IN` jest przez chwilę ściągane do masy przez diody pinu i przekaźnik klika niezależnie od programu. Dlatego **10 kΩ z `IN` do `3V3` ESP32**. Nigdy do 5 V, i nie do `GND`: to włączyłoby przekaźnik na stałe.
- **Piny, których nie używać:** **SD0–SD3, CMD, CLK** to linie wewnętrznej pamięci Flash (masa na `CMD` dawała `invalid header: 0xffffffff` i restart w kółko, 2026-10-02), a **GPIO12** w stanie wysokim przy starcie przełącza Flash na 1,8 V (ten sam objaw). `5V` i `CMD` są obok siebie na końcu rzędu: dwużyłowa wtyczka zasilacza łatwo trafia na złą parę.
- **Alternatywa:** moduł sterowany stanem wysokim (zworka H) + 10 kΩ z `IN` do `GND` i `RELAY_ACTIVE_HIGH = true`. Przekaźnik jest wtedy na pewno wyłączony bez napięcia i w czasie startu ESP32.
- **Styki** `COM`–`NO` w przewodzie fazowym kompresora. Prąd rozruchowy ≤ obciążalność przekaźnika (zwykle 10 A / 250 V AC); silnik powyżej ok. 0,5 kW — przez stycznik.
- Montaż tylko przez osobę uprawnioną do prac przy 230 V, w obudowie, z bezpiecznikiem.

## Pliki (`devices/water-pressure-tank`)

| Plik | Rola |
|---|---|
| `src/water-pressure-tank.cpp` | `setup()` (przekaźnik, NVS, kompresor przed Wi-Fi, kolejka, `runId`), `loop()`/`tick()`, zgłoszenie, wysyłka, strony WWW |
| `src/firmware.hpp` | typ i nazwa urządzenia, wersja (`FW_VERSION` 1.3.0), pin i poziom przekaźnika, opóźnienie startu, czasy kompresora (także limit pracy ręcznej), `CLOUD_URL` |
| `src/compressor.*` | automat kompresora: start, ponowne uruchomienie, praca ręczna (`startManual`, `stop`, `manual()`, `manualSeconds()`), wyłączenie po czasie, `firstStartS`/`lastEndS`/`restarts` |
| `src/settings.*` | ustawienia z chmury (JSON ↔ struktura, walidacja; tylko `compressorSeconds`), czas z `/install` |
| `src/run_report.*` | `RunRecord` (z `manualCompressorS`), JSON wysyłki, kolejka 40 uruchomień w NVS (`BlobStore`, blob w wersji 2), `queuePreviousRun` |
| `src/secrets.example.h` | wzór `secrets.h` (poza gitem): `AP_PASSWORD` (nazwę sieci `MyHome-WaterPump-XXXX` firmware składa z SN), `INSTALL_USER`, `INSTALL_PASSWORD`, `WIFI_SSID`, `WIFI_PASSWORD` |
| `test/test_logic/test_main.cpp` | 25 testów `native` |

## Stałe

| Stała | Wartość | Miejsce |
|---|---|---|
| `DEVICE_TYPE` / `DEVICE_NAME` | `water-pressure-tank` / „Hydrofor” | `firmware.hpp` |
| `RELAY_PIN` / `RELAY_ACTIVE_HIGH` | 26 / `false` | `firmware.hpp` |
| `COMPRESSOR_START_DELAY_MS` | 1000 | `firmware.hpp` |
| `DEFAULT_COMPRESSOR_SECONDS` / `MAX_COMPRESSOR_SECONDS` | 30 / 3600 | `firmware.hpp` |
| `MANUAL_COMPRESSOR_MAX_SECONDS` | 1800 (praca po „Turn on” najdłużej 30 min) | `firmware.hpp` |
| `CLOUD_URL` | `https://dom.mojeturnie.pl/api/` (adres `http://` działa bez TLS) | `firmware.hpp` |
| `REGISTER_RETRY_MS`, `COMPRESSOR_SEND_RETRY_MS` | 10 s | `water-pressure-tank.cpp` |
| `AP_ADDRESS` | `10.10.10.1` | `water-pressure-tank.cpp` |
| `RunQueue::CAPACITY` | 40 | `run_report.hpp` |

## NVS (przestrzeń `wp`)

| Klucz | Zawartość |
|---|---|
| `wifi_ssid`, `wifi_pass` | Wi-Fi z `/install` (puste = wartości z `secrets.h`) |
| `root_id` | Root ID z odpowiedzi na zgłoszenie (kasowany przy 409) |
| `settings` | ustawienia z chmury (JSON `{compressor_seconds}`; dawne pola zbiorników i progów są przy odczycie pomijane) |
| `comp_pending` | czas kompresora z `/install` czeka na wysłanie |
| `run_next` | następny `runId` (pierwszy losowy) |
| `run_current` | bieżące uruchomienie (blob `RunRecord`, zapis co 1 s, z flagą `delivered`) |
| `run_queue` | kolejka niedoręczonych uruchomień (blob w wersji 2; inna wersja albo rozmiar = pusta, więc kolejka sprzed 1.3.0 po aktualizacji przepada) |
| `ota_tried` | wersja, po której pobraniu sterownik ostatnio się zrestartował (ochrona przed pętlą aktualizacji) |

## Kontrakt z chmurą

| Żądanie | Treść | Odpowiedź |
|---|---|---|
| `POST devices/register` | `{deviceId: SN, deviceType, name, version, ip}` (`ip` = adres w sieci domowej, pokazywany w Ustawieniach aplikacji) | `{rootId, settings: {compressor_seconds, firmware?: {version, url, sha256}}}` |
| `POST water-pressure-tank/add?deviceId=&rootId=` | `{runId, pumpRunS, compressorStartS?, compressorEndS?, restarts, manualCompressorS?, queued?}` (`manualCompressorS` tylko, gdy > 0) | `{}`; 404 nieznany SN, 409 cudzy Root ID |
| `PUT water-pressure-tank/settings?deviceId=&rootId=` | `{compressor_seconds}` | `{compressor_seconds}`; 400 zła wartość (znacznik i tak kasowany) |

SN = fabryczny MAC z eFuse, 12 znaków hex. Certyfikat serwera nie jest sprawdzany (jak w `co`). Wersja firmware (`FW_VERSION` w `firmware.hpp`) jest wysyłana w zgłoszeniu; serwer jej na razie nie zapisuje.

## Strony WWW (port 80)

| Adres | Dostęp | Zawartość |
|---|---|---|
| `GET /` | otwarty | strona główna (od 1.3.2 po angielsku, jak `/install`); JS co 1 s pobiera `/state.json`; karta „Compressor”: stan („ON”, „ON (MANUAL)” z dużym odliczaniem `mm:ss` przy pracy ręcznej, „OFF”), przyciski „Turn on” (nieaktywny w pracy ręcznej), „Turn off” (czerwony, nieaktywny przy wyłączonym) i „Run for N s”; karta „Wi-Fi” (od 1.1.5): sieć, stan z przyczyną rozłączenia opisaną słowami, sygnał w dBm z oceną („good” ≥ −67, „fair” ≥ −75, „weak” ≥ −85, niżej „too weak”), bez połączenia lista sieci ze skanowania co 30 s |
| `GET /state.json` | otwarty | `running`, `manual`, `manualMaxS`, `remainingS`, `compressorSeconds`, `pumpRunS`, `restarts`, `manualCompressorS`, `wifi`, `registered`, `network` (`ssid`, `status`, `rssi`, `ip`, `reason`, `scanAgeS`, `scan[]`), `lastStatus`, `queued` |
| `POST /restart` | otwarty | „Run for N s”: kompresor na pełny czas z ustawień |
| `POST /compressor/on` | otwarty | „Turn on”: praca ręczna do `/compressor/off`, najdłużej 1800 s |
| `POST /compressor/off` | otwarty | „Turn off”: kończy pracę ręczną albo zwykłą od razu |
| `GET`/`POST /install` | Basic Auth | Wi-Fi (puste hasło = bez zmian; zapis łączy od razu, **bez restartu**, bo restart włączyłby kompresor), SN, Root ID, IP, stan chmury |
| `POST /install/compressor` | Basic Auth | czas kompresora 1–3600 s (pełne sekundy), przycisk „Save time” |
| `POST /install/firmware` | Basic Auth | ręczne wgranie `firmware.bin` (multipart); odrzucane przy pracującym kompresorze; po wgraniu restart |

Nieznany adres pokazuje stronę główną.

Zrzut strony głównej pochodzi sprzed wersji 1.3.0 (karta „Zbiorniki”, jeden przycisk „Uruchom kompresor ponownie”), a oba zrzuty sprzed wersji 1.3.2, gdy strony były po polsku.

| Strona główna | Instalacja |
|---|---|
| ![Strona główna](img/strona-glowna-telefon.png) | ![Instalacja](img/instalacja-telefon.png) |

## Aktualizacja przez sieć (OTA)

Układ flash to domyślna tablica Arduino-ESP32 z dwiema partycjami aplikacji (`app0`/`app1` po 1,28 MB; obraz zajmuje ok. 77%), więc nie wymaga zmian. Pierwsze wgranie jest przez UART (niżej), kolejne idą przez sieć.

1. Plik `.bin` jest w bazie serwera (kolekcje `firmware_images`, `firmware_offers`; oferowana wersja i jedna poprzednia). **Ofertę serwer wysyła tylko na zlecenie z aplikacji:** przycisk „Aktualizuj” w Ustawieniach hydroforu (karta „Sterownik”) zapisuje w urządzeniu `firmwareUpdate {version, requestedAt}` („Anuluj aktualizację” je usuwa). Dopiero wtedy serwer dodaje do `settings` w odpowiedzi na zgłoszenie pole `firmware: {version, url, sha256, request}`, gdzie `url` to `<serwer>/api/firmware/water-pressure-tank/<wersja>.bin`, `sha256` liczy serwer przy wgraniu, a `request` to czas zlecenia w ms (firmware hydroforu go pomija). Bez zlecenia, przy wyłączonych aktualizacjach albo bez pliku pola nie ma. Zlecenie znika samo, gdy sterownik zgłosi się z oferowaną wersją. Hydrofor ma zasilanie tylko w czasie pracy pompy, więc zlecenie czeka na najbliższe uruchomienie pompy.
2. Sterownik (`ota.cpp`) przyjmuje ofertę, gdy adres zaczyna się od `https://`, wersja jest niepusta, a `sha256` ma 64 znaki hex. Oferty bez sumy kontrolnej ignoruje.
3. Pobranie startuje raz na uruchomienie, gdy: zgłoszenie się udało, bieżące uruchomienie zostało doręczone, kolejka jest pusta, **kompresor nie pracuje** (pobieranie blokuje pętlę na kilkanaście sekund i nie pilnowałaby przekaźnika) i wersja z oferty różni się od `FW_VERSION` (także starsza: powrót do poprzedniego wydania).
4. `downloadFirmware()` pobiera obraz (śledzi przekierowania) prosto do nieaktywnej partycji, licząc SHA-256 w locie. Obraz jest aktywowany dopiero po zgodnej sumie (`Update.end`), więc przerwanie pobierania albo zasilania nie psuje działającego firmware. Potem restart; kompresor włącza się jak przy każdym starcie.
5. Po zapisie obrazu wersja trafia do NVS (`ota_tried`). Gdy po restarcie `FW_VERSION` nadal nie zgadza się z ofertą (zapomniana zmiana wersji), kolejna próba jest pomijana. Nieudane pobranie ponawia się przy następnym uruchomieniu pompy.
6. Awaryjnie plik `firmware.bin` można wgrać ręcznie na `/install` (sekcja „Firmware”).

**Wydanie nowej wersji:** podnieść `FW_VERSION` w `firmware.hpp`, `pio run -d devices/water-pressure-tank`, wgrać `.pio/build/esp32dev/firmware.bin` na stronie firmware w aplikacji (lista sterowników → trybik na kafelku hydroforu, ikona plusa na belce „Aktualna wersja” otwiera popup „Dodaj wersję”: wersja taka jak `FW_VERSION` i opis zmian) albo z konsoli: `curl -X PUT -H "Content-Type: application/octet-stream" --data-binary @firmware.bin https://dom.mojeturnie.pl/api/firmware/water-pressure-tank/1.0.1`. Serwer ustawia plik jako oferowany, a poprzednia wersja zostaje w bazie (przywrócenie: `PUT /api/firmware/water-pressure-tank` z `{"version": "1.0.0"}`). Tag w repozytorium (`water-pressure-tank-v<wersja>`) jest tylko znacznikiem źródeł. Potem w Ustawieniach hydroforu „Aktualizuj”; sterownik pobierze obraz przy najbliższej pracy pompy dłuższej niż czas kompresora.

**Uwagi:** pobieranie i serwer WWW nie mają testów na płytce (testy `native` obejmują `ota.cpp`, serwer ma testy w `server/test/firmware.test.ts`); certyfikat nie jest sprawdzany, a integralność obrazu zapewnia SHA-256 z odpowiedzi chmury (ten sam kanał, więc nie chroni przed podszyciem się pod serwer). Endpointy `/api/firmware/...` i `/api/devices/:rootId/firmware-update` nie mają jeszcze autoryzacji: każdy, kto zna adres serwera, może podmienić ofertę i zlecić aktualizację. Restart po aktualizacji kończy bieżący zapis uruchomienia kilkanaście sekund przed faktycznym końcem pracy pompy i zaczyna nowy `runId`.

## Budowanie, testy, wgranie

```bash
cp devices/water-pressure-tank/src/secrets.example.h devices/water-pressure-tank/src/secrets.h   # raz, uzupełnić
pio test -d devices/water-pressure-tank -e native            # 25 testów
pio run  -d devices/water-pressure-tank                     # build (esp32dev)
pio run  -d devices/water-pressure-tank -t upload           # wgranie przez mostek USB płytki
pio device monitor                                         # konsola 115200 (przez mostek płytki otwarcie portu może ją zresetować)
```

**Wgranie przez przejściówkę USB-TTL.** Na komputerze z polityką integralności kodu (HVCI/WDAC) sterownik mostka CP210x płytki jest blokowany (błąd 10, status `0xC000036C` STATUS_DRIVER_BLOCKED). Przejściówka FT232RL (sterownik FTDI z Windows) działa: zworka 3,3 V, `TX`→`RX0` (GPIO3), `RX`←`TX0` (GPIO1), `GND`–`GND`; płytkę zasilić jej kablem USB albo z pinu 5V. Tryb wgrywania ręcznie: przytrzymać BOOT, nacisnąć RST, puścić BOOT (rozpoznać po `boot:0x3 (DOWNLOAD_BOOT…) waiting for download` na konsoli). Wgranie całości przy 115200 bodów (460800 na luźnych przewodach się przerywało): `esptool.py --chip esp32 --port COMx --baud 115200 --before no_reset --after no_reset write_flash --erase-all -z 0x1000 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin` (pliki z `.pio/build/esp32dev/`, `boot_app0.bin` z `framework-arduinoespressif32/tools/partitions/`). Po `--erase-all` sieć Wi-Fi trzeba ustawić na `/install` przez AP „Piwnica”. Kolejne wersje idą już przez sieć (OTA).

**Dziennik na konsoli (od 1.1.1).** Linie `[ms od startu] treść` na konsoli UART0 115200 (piny TX/RX, mostek USB płytki albo przejściówka): start (wersja, SN, rootId, czas kompresora), AP, Wi-Fi (połączenie z IP i RSSI albo status z przyczyną rozłączenia), zgłoszenie z odpowiedzią chmury i ofertą OTA, zmiana statusu HTTP wysyłki, kolejka, kompresor i każdy krok OTA. Co 10 s dwie linie stanu (`stan:` i `sieć:` z nazwą sieci, długością hasła, przyczyną ostatniego rozłączenia, kanałem i stanem AP), więc komputer podłączony później też widzi, co się dzieje. Bez połączenia z siecią domową co 30 s (pierwsze po 15 s) skanowanie w tle wypisuje widoczne sieci z RSSI (także na stronie `/`, karta „Wi-Fi”). Linie idą przez bufor nadawania 2 KB, więc nie opóźniają pętli pilnującej przekaźnika. Do podglądu bez resetu otwierać port z DTR i RTS ustawionymi na 0 przed otwarciem (przez przejściówkę bez podłączonych DTR/RTS reset nie grozi).

Testy `native` obejmują: kompresor (jeden start, koniec po czasie, ponowne uruchomienie, czas 0, zmiana czasu od następnego włączenia, praca ręczna do wyłączenia i do limitu, „Turn off” w zwykłej pracy, czas pracy ręcznej), czas z `/install` (poprawne i złe wpisy, treść `PUT`, niewysłany czas nie jest nadpisywany przez chmurę), ustawienia (odrzucenie złych danych, NVS), JSON wysyłki (także `manualCompressorS`), kolejkę (na atrapie NVS) i ofertę OTA. **Wi-Fi, HTTP i strony nie mają testów automatycznych** — do sprawdzenia bez płytki służy symulator po stronie serwera: `node scripts/simulate-water-pressure-tank.mjs [--fast] [--history]` przy `npm run local`.

## Znane problemy i uwagi

- **Zgłoszenie z limitem 8 s (od 1.2.1).** Pierwsze połączenie TLS z Render po przerwie trwa 2–5 s; przy limicie 2 s zgłoszenie dochodziło dopiero przy 4. próbie (46 s po starcie). Wysyłka co 1 s ma nadal 2 s i bywa `-11` (następna przechodzi).
- **Pierwsza płytka (ESP32-C3 SuperMini, do 1.1.5) wycofana 2026-10-02:** słaba antena (−83…−91 dBm w miejscu, gdzie WROOM-32 ma −66 dBm), w piwnicy nie łączyła się z chmurą.
- **`RELAY_ACTIVE_HIGH = false`** odpowiada obecnemu modułowi; bez rezystora 10 kΩ z `IN` do `3V3` możliwe jest krótkie włączenie przekaźnika w chwili podania zasilania (sprzęt, nie program).
- **Bezpieczeństwo:** sieć sterownika domyślnie otwarta, strony po HTTP, `POST /restart`, `/compressor/on` i `/compressor/off` bez logowania.
- **Aktualizacja do 1.3.0 kasuje kolejkę** (blob w wersji 2): uruchomienia niedoręczone przed aktualizacją nie trafią do chmury.
- Dawny szkic `D:\DevLocal\arduino_src\hydrofor\hydrofor.ino` (poza gitem) miał usterkę podwójnego startu kompresora; nie używać.
