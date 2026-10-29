# Fotowoltaika: wzorce widoków i parametry DTU/mikrofalowników

Dokument roboczy przed budową modułu „Fotowoltaika” (gałąź `feature/fotowoltaika`). Część A zbiera, jak inni pokazują dane PV, i kończy się rekomendacją dla naszych czterech zakładek. Część B wymienia parametry DTU Hoymiles i mikrofalowników: co da się odczytać, co ustawić i z jakim ryzykiem.

Stan wiedzy: 2026-10-03. Fakty mają źródło (link). Wnioski własne są oznaczone jako „wniosek”. Adresy, których nie potwierdził producent ani działający kod, są oznaczone jako **niepotwierdzone**.

## 0. Punkt wyjścia: co dziś czytamy

Sterownik `co` co 60 s wysyła do DTU (adres Modbus `0x69`) dwa zapytania `0x03` po 100 rejestrów: od `0x1000` i od `0x10C8` (`devices/co/src/modbus_frame.cpp`, `hardware_config.hpp`). Port zajmuje 0x28 adresów, a rekord ma 20 rejestrów (40 bajtów). Wynika to z mapy producenta: tabela w nocie technicznej numeruje **bajty**, nie rejestry (np. `0x1001–0x1006` to 6 bajtów numeru seryjnego) ([Hoymiles, Technical Note: Modbus implementation using 3Gen DTU-Pro, v1.2, rozdz. 4.3.2](https://wiki.niziak.spox.org/_media/hw:hoymiles:technical-note-modbus-implementation-using-3gen-dtu-pro-v1.2.pdf)). Tak samo czyta biblioteka `hoymiles_modbus`: `0x1000 + i * 40` ([wasilukm/hoymiles_modbus, client.py](https://github.com/wasilukm/hoymiles_modbus)).

Rekord portu (40 bajtów) i jego użycie w `pv_data_processor.cpp`:

| Bajt w rekordzie | Adres w nocie (port 1) | Pole producenta | Skala | U nas |
|---|---|---|---|---|
| 0 | 0x1000 | Data Type (stałe `0x3C`) | – | nie czytamy |
| 1–6 | 0x1001–0x1006 | Microinverter SN (BCD, 12 cyfr) | – | `serial` |
| 7 | 0x1007 | Port Number | – | `port` |
| 8–9 | 0x1008 | PV Voltage | 0,1 V | `pv_voltage` |
| 10–11 | 0x100A | PV Current | 0,1 A (MI) / 0,01 A (HM) | `pv_current` (/100) |
| 12–13 | 0x100C | Grid Voltage | 0,1 V | `grid_voltage` |
| 14–15 | 0x100E | Grid frequency | 0,01 Hz | `grid_frequency` |
| 16–17 | 0x1010 | PV Power | 0,1 W | `power` |
| 18–19 | 0x1012 | Today Production | Wh | `prod_today` |
| 20–23 | 0x1014 | Total Production | Wh | `prod_total` |
| 24–25 | 0x1018 | Temperature (wewnątrz mikrofalownika) | 0,1 °C | `temperature` |
| 26–27 | 0x101A | Operating Status | – | `status` |
| 28–29 | 0x101C | Alarm Code | – | `alarm_code` |
| 30–31 | 0x101E | Alarm Count | – | `alarm_count` |
| 32 | 0x1020 | Link Status („Communication status with DTU”) | – | `link` |
| 33 | 0x1021 | stałe `0x07` | – | nie czytamy |
| 34–39 | 0x1022–0x1027 | Reserved | – | nie czytamy |

Ważne dla interfejsu:

- **„PV Power” to moc po stronie DC portu, nie moc oddana do sieci.** Tak opisuje to nota (pole „PV”), a użytkownicy evcc zauważyli, że suma tych pól jest wyższa od mocy AC o straty przetwarzania ([evcc, dyskusja #30609](https://github.com/evcc-io/evcc/discussions/30609)). Nasze `total_power` jest więc sumą DC. Mapa Hoymiles nie ma mocy AC na mikrofalownik.
- `prod_today` i `prod_total` są per port. Dzienna i całkowita energia instalacji to sumy portów.
- `hoymiles_modbus` sumuje tylko porty z `link_status` ≠ 0 i ustawia flagę alarmu, gdy którykolwiek port ma `alarm_code` ≠ 0 ([client.py, `plant_data`](https://github.com/wasilukm/hoymiles_modbus)). Nasz firmware sumuje wszystkie porty (wniosek: port bez łącza może podawać stare wartości).

### Uwaga o typach mikrofalowników

Prefiks numeru seryjnego `1144` OpenDTU przypisuje do serii **HMS 2-portowej** (HMS-600/700/800/900/1000-2T), a `1164` do **HMS 4-portowej** (HMS-1600/1800/2000-4T). Seria HM ma prefiksy `1141` (2 porty) i `1161` (4 porty) ([OpenDTU, `HMS_2CH.cpp`, `HMS_4CH.cpp`, `HM_2CH.cpp`, `HM_4CH.cpp`, `DevInfoParser.cpp`](https://github.com/tbnobody/OpenDTU/tree/master/lib/Hoymiles/src/inverters)). Wniosek: nasze mikrofalowniki to najpewniej HMS, a nie HM-600/800 i HM-1200/1500. HMS komunikują się w paśmie sub-1 GHz, które obsługuje DTU-Pro-S ([instrukcja DTU-Pro-S, dane techniczne: „Sub-1G”](https://aurinkosahkotukku.fi/wp-content/uploads/2024/03/Kayttoohje-2.pdf)). Do potwierdzenia na tabliczkach znamionowych.

---

## Część A. Jak inni pokazują dane PV

### A1. Hoymiles S-Miles Cloud (aplikacja i www)

| Element | Co pokazuje | Źródło |
|---|---|---|
| Bieżąca moc i przepływ energii | moc PV, magazyn, zużycie „w czasie rzeczywistym” | [hoymiles.com/smiles-cloud](https://www.hoymiles.com/smiles-cloud.html) |
| Energia dzień / miesiąc / rok / całość | „daily, monthly, annual, and total energy display” | [S-Miles Enduser (opis aplikacji)](https://mwm.ai/apps/s-miles-enduser/1544760866) |
| Dane modułu | napięcie, prąd, moc i temperatura każdego panelu | [hoymiles.com/smiles-cloud](https://www.hoymiles.com/smiles-cloud.html) |
| Układ paneli | układ fizyczny paneli przeciągany myszą (drag and drop) | [hoymiles.com/smiles-cloud](https://www.hoymiles.com/smiles-cloud.html), [S-Miles Installer (App Store)](https://apps.apple.com/app/id1544207772) |
| Wersja dla instalatora (Plant O&M) | Setting, Networking, Sunspec Modbus Setting, „Power limit setting (active power control)”, Generate Report, Plant transfer | [nota Modbus v1.2, s. 28 (zrzut ekranu)](https://wiki.niziak.spox.org/_media/hw:hoymiles:technical-note-modbus-implementation-using-3gen-dtu-pro-v1.2.pdf) |
| Zdalne O&M | zmiana limitu mocy, profilu sieci, aktualizacja firmware | [hoymiles.com/smiles-cloud](https://www.hoymiles.com/smiles-cloud.html) |
| Częstotliwość danych w chmurze | DTU-Pro-S wysyła dane co 15 min („Sample rate: Per 15 minutes”) | [instrukcja DTU-Pro-S, dane techniczne](https://aurinkosahkotukku.fi/wp-content/uploads/2024/03/Kayttoohje-2.pdf) |

Z ogólnie znanych zrzutów ekranu (niepotwierdzone w źródle tekstowym): kolorowanie paneli w układzie według mocy albo energii dnia, krzywa mocy dnia, słupki energii, lista alarmów z opisem.

### A2. Hoymiles DTU lokalnie (S-Miles Toolkit)

Aplikacja instalatora łączy się z siecią Wi-Fi DTU (nazwa `DTUP…`) i w „Micro Toolkit” pokazuje ([instrukcja DTU-Pro-S, rozdz. 7](https://aurinkosahkotukku.fi/wp-content/uploads/2024/03/Kayttoohje-2.pdf)):

- „Power generation”: listę mikrofalowników z mocą PV każdego;
- po wybraniu numeru seryjnego: dane wejścia i wyjścia mikrofalownika;
- „Connection Status”: siłę sygnału DTU ↔ każdy mikrofalownik, odświeżaną na bieżąco.

Diody DTU sygnalizują m.in. alarm DTU, alarm mikrofalownika, brak listy mikrofalowników i brak połączenia z serwerem (tamże, rozdz. 10).

### A3. OpenDTU i AhoyDTU (open source)

Oba projekty to własne bramki (ESP32 + moduł radiowy), które rozmawiają z mikrofalownikami bezpośrednio, bez DTU Hoymiles.

**OpenDTU** udostępnia na mikrofalownik ([MQTT topics](https://www.opendtu.solar/firmware/mqtt_topics/)):

- stan: `reachable`, `producing`, `last_update`, `limit_relative`, `limit_absolute`;
- AC: prąd, napięcie, częstotliwość, moc, moc bierna, współczynnik mocy, sprawność, temperatura, energia dnia i całkowita;
- DC na port: prąd, napięcie, moc, **irradiation** (moc DC / wpisana moc panelu × 100 %, [`StatisticsParser.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/parser/StatisticsParser.cpp)), nazwa, energia dnia i całkowita;
- informacje o urządzeniu: wersja firmware i data kompilacji, bootloader, numer części sprzętu (z niego model i moc maksymalna), wersja sprzętu;
- dziennik zdarzeń (alarmy z opisem, lista w [`AlarmLogParser.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/parser/AlarmLogParser.cpp)) i profil sieci (tylko odczyt).

**AhoyDTU** ([lumapu/ahoy, `src/web/lang.json`](https://github.com/lumapu/ahoy)):

- „Visualization”: karta na mikrofalownik: moc AC, Yield Day, Yield Total, Max Power, limit (APC), karty portów (moc, napięcie, prąd DC, Irradiation), Efficiency, Power Factor, okno „Alarms”, okno „Grid Profile”, statystyki radia (TX count, RX success, RX fail);
- „History”: wykres „Total Power” (krzywa mocy dnia), „Total Power Today” z wartością „Maximum” i „Last value”, słupki „Total Yield per day”.

### A4. Inne: SolarEdge i Home Assistant

**SolarEdge Monitoring** ([Sun Valley Solar, przewodnik](https://www.sunvalleysolar.com/blog/solaredge-monitoring-guide), [Monitoring Portal User Guide](https://ressupply.com/documents/solaredge/Monitoring_Portal_User_Guide.pdf)):

- Dashboard: przegląd, przepływ mocy, „Power & Energy” (krzywa mocy dziś i energia z 7 dni), porównanie energii rok do roku;
- Layout: fizyczny układ paneli kolorowany energią (jaśniejszy = więcej), drzewo urządzeń falownik → string → panel;
- Playback: odtworzenie dnia na układzie paneli (mapa ciepła w czasie).

**Home Assistant, panel Energia** ([karty energii](https://www.home-assistant.io/dashboards/energy/)): wybór okresu z porównaniem (`energy-date-selection`, `energy-compare-card`), słupki produkcji PV z prognozą (`energy-solar-graph`), przepływ energii (`energy-distribution`, `energy-sankey`), tabela źródeł, wskaźnik autokonsumpcji (`energy-solar-consumed-gauge`), bieżąca moc (`power-total`, `power-sources-graph`).

### A5. Zestawienie

| Funkcja | S-Miles | DTU lokalnie | OpenDTU / Ahoy | SolarEdge | HA |
|---|---|---|---|---|---|
| Bieżąca moc | tak | tak | tak (AC i DC) | tak | tak |
| Energia dzień / miesiąc / rok / całość | tak | – | dzień, całość | tak | tak (okres dowolny) |
| Krzywa mocy dnia | tak | – | Ahoy: tak | tak | tak |
| Słupki produkcji | tak | – | Ahoy: dzienne | 7 dni, rok do roku | tak |
| Układ paneli / mapa ciepła | tak | – | – | tak + playback | – |
| Porównanie paneli | dane per panel | per mikrofalownik | per port (irradiation %) | kolor w układzie | – |
| Alarmy z opisem | tak | dioda | tak | tak | – |
| Stan łącza | tak | siła sygnału | reachable, statystyki radia | tak | – |
| Zmiana limitu mocy | instalator | – | tak | instalator | – |

### A6. Rekomendacja dla modułu „Fotowoltaika”

Założenia: odczyt co 60 s (moc i liczniki), szczegóły paneli od niedawna (w `pv`, `panels` usuwane po 90 dniach), starsza historia tylko jako sumy (`PV.total_power` w rekordach `hp`, a w rekordach sprzed 2026-09-26 także produkcja dnia, licznik całkowity i temperatura).

1. **Podgląd, kafelek główny:** duża bieżąca moc z dopiskiem „DC” (lub przeliczoną szacunkowo na AC), energia dziś, licznik całkowity, najniższa temperatura i wiek odczytu („dane sprzed 2 min”; po 3 min szary znacznik „nieaktualne”, jak `PV_MAX_AGE_MS`).
2. **Podgląd, mini krzywa mocy dziś** (z `pv`, punkt co 60 s) pod kafelkiem. Wystarczy jedna seria; szczegóły w zakładce Statystyki.
3. **Podgląd, układ paneli:** 10 kafelków pogrupowanych po mikrofalownikach (1 × 2 porty, 2 × 4 porty), kolor według `power / moc panelu` (jak irradiation w OpenDTU) albo względem najlepszego panelu. Dotknięcie pokazuje V, A, W, energię dziś, temperaturę. Kolejność i nazwy paneli z Ustawień.
4. **Podgląd, stan:** ikona ostrzeżenia przy mikrofalowniku z `link` = 0, `alarm_code` ≠ 0 albo wzrostem `alarm_count` od ostatniego odczytu. Kod pokazywać surowo, z opisem tylko jako „prawdopodobnie: …” (punkt B4).
5. **Dane:** tabela odczytów dnia (czas, moc, energia dziś, temperatura) z CSV, jak w innych modułach. Przełącznik „Panele”: tabela 10 portów dla wybranego odczytu (tylko dni z `panels`).
6. **Dane, zdarzenia:** lista zmian `alarm_code`, `alarm_count`, `link` i `status` per mikrofalownik (wyliczana z kolejnych odczytów). Zastępuje dziennik alarmów, którego Modbus nie daje.
7. **Statystyki, dzień:** krzywa mocy z `pv`; dla dni sprzed `pv` z `hp.PV.total_power` (gęstsze, ale bez szczegółów). Opcjonalnie nakładka mocy pompy ciepła (bilans, przyszły widok energii).
8. **Statystyki, słupki:** energia dzienna w miesiącu, miesięczna w roku, roczna. Liczyć z maksimum `total_prod_today` w dniu albo z przyrostu `total_prod` (odporne na brak odczytów pod koniec dnia). Wybór okresu kropkami jak w hydroforze.
9. **Statystyki, porównanie paneli:** słupki energii dnia na port (z `prod_today`) i odchylenie od średniej. Wniosek: żeby porównanie przetrwało 90-dniową retencję `panels`, zapisywać raz dziennie małe podsumowanie per port (energia dnia, maksimum mocy).
10. **Ustawienia, instalacja:** moc znamionowa każdego panelu (Wp), nazwa i pozycja panelu w układzie, model i moc mikrofalownika wpisywane ręcznie (Modbus ich nie podaje, punkt B5), cena energii do wyceny produkcji.
11. **Ustawienia, sterownik:** numer seryjny DTU (do dodania odczytu `0x2000`), adres Modbus `0x69`, lista mikrofalowników z prefiksem i serią, wersja firmware `co`. Bez przycisków zapisu do DTU w pierwszym etapie.
12. **Sterowanie mocą (limit, wyłączenie) odłożyć.** Modbus to umożliwia, ale adresy i kody funkcji są sprzeczne między źródłami (punkt B1). Najpierw próba odczytu i jeden test ręczny, potem ewentualnie „Ogranicz moc do X %” z potwierdzeniem i limitem częstotliwości.

---

## Część B. Parametry DTU i mikrofalowników

Oceny: **bezpieczny** (do zmiany z aplikacji), **ostrożnie** (tylko po teście, z potwierdzeniem, rzadko), **nie ruszać**.

### B1. Rejestry Modbus RTU DTU-Pro / DTU-Pro-S (protokół Hoymiles)

Źródło główne: [nota techniczna Hoymiles v1.2 (grudzień 2020)](https://wiki.niziak.spox.org/_media/hw:hoymiles:technical-note-modbus-implementation-using-3gen-dtu-pro-v1.2.pdf), rozdz. 4. Port RS-485: 9600 bps, adres 101–254 (u nas `0x69` = 105), DTU jest slave'em. Obsługiwane funkcje: `0x01`, `0x02` (odczyt „status”), `0x03` (odczyt danych), `0x05` (zapis pojedynczy), `0x0F` (zapis wielokrotny).

**Zapis (rejestry „status”):**

| Adres | Nazwa | Co zmienia | Wartości | Osiągalne u nas | Ryzyko | Ocena |
|---|---|---|---|---|---|---|
| `0xC000` | Turn ON/OFF (All Microinverters) | wyłącza / włącza produkcję wszystkich mikrofalowników | 0 = OFF, 1 = ON; nota: W, funkcja `0x05` | tak, ta sama magistrala; w praktyce niesprawdzone | instalacja zostaje wyłączona, dopóki nie wyślemy ON; nie wiadomo, czy stan jest trwały | ostrożnie |
| `0xC001` | Limit Active Power (All Microinverters) | ogranicza moc wszystkich mikrofalowników | 2–100 % (HM), 10–100 % (MI); nota: W, funkcja `0x05` | tak; kod funkcji **niepotwierdzony** (niżej) | nieznana trwałość zapisu (EEPROM mikrofalownika); zbyt częste zmiany | ostrożnie |
| `0xC006` / `0xC007` | Turn ON/OFF / Limit Active Power (Port 1) | jak wyżej, dla portu 1 | jak wyżej; R/W, funkcje `0x01 0x02 0x05 0x0F` | tak, niesprawdzone | nota: porty jednego mikrofalownika muszą mieć to samo ustawienie | ostrożnie |
| `0xC00C` / `0xC00D` | ON/OFF / Limit (Port 2) | jak wyżej | jak wyżej | tak, niesprawdzone | jak wyżej | ostrożnie |
| `0xC000 + 6·n` / `0xC001 + 6·n` | ON/OFF / Limit (Port n) | jak wyżej | krok 6 wynika z portów 1–2; w nocie port 3 ma błędny adres `0xC002` | **niepotwierdzone** | jak wyżej | ostrożnie |
| `0xC002–0xC005`, `0xC008–0xC00B`, … | Reserved | nieopisane | – | – | nieznany skutek | nie ruszać |
| `0x9D9C` / `0x9D9D` | ON/OFF / Limit (All Microinverters), drugi raz | w nocie po „Maximum 99 ports”; znaczenie niejasne | – | **niepotwierdzone** | nieznany skutek | nie ruszać |
| `0x2056–0x205B`, `0x205C–…` | Microinverter SN (lista w DTU) | lista mikrofalowników skonfigurowanych w DTU | R/W, `0x03` / `0x0F` | tak | zapis zmienia listę urządzeń DTU, możliwa utrata odczytu | nie ruszać (tylko odczyt) |
| `0x2503` | RS485 Function | tryb portu RS-485 | 0 = Export Management, 1 = Hoymiles Modbus | tak | zmiana odcina nasz odczyt | nie ruszać |
| `0x2504` | RS485 Port Address | adres Modbus DTU | 101–254, potem restart DTU | tak | zmiana odcina odczyt do zmiany adresu w `co` | nie ruszać |
| `0x2501–0x2502` | Ethernet Port Number | port Modbus TCP (domyślnie 502) | tylko TCP | nie dotyczy | – | nie ruszać |

**Sprzeczne doniesienia o zapisie limitu (dlatego „niepotwierdzone”):**

- nota: funkcja `0x05` z wartością procentową (niestandardowo; w Modbus `0x05` zapisuje jeden bit);
- forum Symcon: działała dopiero funkcja `0x06` (Write Register), a adresy trzeba było zwiększyć o 1 względem tabeli; inny uczestnik twierdzi, że adresy są dobre ([Symcon, s. 1](https://community.symcon.de/t/hoymiles-wechselrichter-limit-active-power-per-modbus/129820), [s. 2](https://community.symcon.de/t/hoymiles-wechselrichter-limit-active-power-per-modbus/129820?page=2));
- integracja HA `ha-hoymiles-modbus-tcp` (testowana z DTU-Pro-S po TCP): zapis 8 bitów procentu funkcją `0x0F` (write coils) od `0xC001`, odczyt `0x01` (read coils), zakres 5–100 %, nie częściej niż co 30 s ([wil-lem/ha-hoymiles-modbus-tcp, `hoymiles_dtu_client.py`, `number.py`](https://github.com/wil-lem/ha-hoymiles-modbus-tcp));
- ioBroker: `0xC001` ogranicza moc HMS-2000 (TCP) ([forum ioBroker](https://forum.iobroker.net/topic/55115/gel%C3%B6st-ben%C3%B6tige-hilfe-modbus-tcp-hoymiles-hm-1500-dtu-pro/40)).

**Sunspec (rozdz. 6 noty):** Model 123 ma `WMaxLimPct` (40189) i `WMaxLim_Ena` (40193), Model 1 ma model (`Md`, 40020) i wersję (`Vr`, 40044) mikrofalownika. Wymaga przełączenia portu RS-485 w tryb Sunspec i nadania adresów mikrofalownikom w S-Miles (ekran ma dopisek „Only supported on DTU-Pro”). U nas: nieosiągalne bez utraty obecnego odczytu. Ocena: nie ruszać.

**Czego Modbus DTU nie ma:** restartu mikrofalownika, zmiany profilu sieci, odczytu modelu, mocy znamionowej i wersji firmware (poza trybem Sunspec), mocy AC.

**Ograniczenie eksportu (zero export):** Hoymiles realizuje je funkcją „Export Management”: DTU-Pro-S jest wtedy masterem RS-485 i czyta licznik energii ([instrukcja DTU-Pro-S, rozdz. 4.1](https://aurinkosahkotukku.fi/wp-content/uploads/2024/03/Kayttoohje-2.pdf)). To ten sam port, co nasz odczyt, i inny tryb (`0x2503` = 0). U nas nieosiągalne bez rezygnacji z Modbus. Ewentualne własne „zero export” to cykliczny zapis `0xC001` z naszego licznika (ostrożnie, punkt B2 o trwałości).

### B2. Parametry przez OpenDTU / AhoyDTU

Wymaga osobnej bramki ESP32 z radiem (dla HMS moduł CMT2300A, nie nRF24). **Nie przez naszą magistralę RS-485.** Wypisane dla porównania i na wypadek zmiany architektury.

| Parametr | Opis | Źródło | Ryzyko | Ocena (gdyby był dostępny) |
|---|---|---|---|---|
| Limit względny / bezwzględny, nietrwały | % albo W; „resets at night” | [OpenDTU MQTT: `limit_nonpersistent_*`](https://www.opendtu.solar/firmware/mqtt_topics/) | brak zapisu do pamięci; nie częściej niż co 30–60 s ([Symcon](https://community.symcon.de/t/hoymiles-wechselrichter-limit-active-power-per-modbus/129820)) | bezpieczny |
| Limit względny / bezwzględny, trwały | „survives power loss” | [OpenDTU MQTT: `limit_persistent_*`](https://www.opendtu.solar/firmware/mqtt_topics/); kody typów HM/HMS w [`ActivePowerControlCommand.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/commands/ActivePowerControlCommand.cpp) | zapis do pamięci mikrofalownika; EEPROM typowo 100 000 cykli, HA ostrzega przed częstym zapisem ([akkudoktor](https://akkudoktor.net/t/eeprom-lebensdauer-bei-nulleinspeisung/38097)) | ostrożnie (tylko ręcznie, rzadko) |
| Włącz / wyłącz | `cmd/power` 1/0 | [OpenDTU MQTT](https://www.opendtu.solar/firmware/mqtt_topics/) | instalacja stoi do ponownego włączenia | ostrożnie |
| Restart mikrofalownika | `cmd/restart`; „also resets daily yield” | [OpenDTU MQTT](https://www.opendtu.solar/firmware/mqtt_topics/) | zeruje energię dnia | ostrożnie |
| Profil sieci | tylko odczyt (komenda pobiera profil) | [`GridOnProFilePara.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/commands/GridOnProFilePara.cpp), Ahoy „Grid Profile” | zmiana tylko przez S-Miles (instalator) | nie ruszać |
| Wersja firmware, bootloader, data kompilacji | odczyt | [OpenDTU MQTT `device/*`](https://www.opendtu.solar/firmware/mqtt_topics/) | – | odczyt |
| Model i moc maksymalna | z numeru części sprzętu (tabela `devInfo`) | [`DevInfoParser.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/parser/DevInfoParser.cpp) | – | odczyt |
| Bieżący limit (% i W) | `status/limit_relative`, `limit_absolute` | [OpenDTU MQTT](https://www.opendtu.solar/firmware/mqtt_topics/) | – | odczyt |
| Moc bierna, cos φ, sprawność, moc AC | odczyt | tamże | – | odczyt |
| Dziennik alarmów z czasem | odczyt | [`AlarmLogParser.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/parser/AlarmLogParser.cpp) | – | odczyt |
| Statystyki radia | TX/RX, `reset_rf_stats` | OpenDTU MQTT, Ahoy | – | bezpieczny |

### B3. Konfiguracja DTU w S-Miles (Installer / Toolkit)

Zmieniana tylko w aplikacji Hoymiles. Z naszej aplikacji: nieosiągalne.

| Parametr | Opis | Źródło | Ocena |
|---|---|---|---|
| Network Config | Wi-Fi (SSID, hasło), Ethernet albo 4G | [instrukcja DTU-Pro-S, rozdz. 6.2](https://aurinkosahkotukku.fi/wp-content/uploads/2024/03/Kayttoohje-2.pdf) | nie ruszać z naszej aplikacji |
| RS485 port setting | Export Management albo Remote Control / Modbus Protocol, adres 101–254 | [nota Modbus, rozdz. 4.1.1](https://wiki.niziak.spox.org/_media/hw:hoymiles:technical-note-modbus-implementation-using-3gen-dtu-pro-v1.2.pdf) | nie ruszać (musi zostać Modbus, adres 105) |
| Power limit setting (active power control) | limit mocy instalacji z chmury | nota, s. 28 (zrzut Plant O&M) | ostrożnie; konflikt z ewentualnym limitem z Modbus (niepotwierdzone, który wygrywa) |
| Profil sieci (grid profile) | parametry przyłączenia (napięcia, częstotliwości, czasy) | [hoymiles.com/smiles-cloud](https://www.hoymiles.com/smiles-cloud.html) | nie ruszać (zgodność z wymaganiami OSD) |
| Aktualizacja firmware DTU i mikrofalowników | zdalnie z chmury | tamże | nie ruszać z naszej aplikacji |
| Sunspec Modbus Setting | adresy RS-485 mikrofalowników | nota, rozdz. 6.1.1 | nie ruszać |
| Interwał wysyłki do chmury | 15 min, w specyfikacji jako stała („Sample rate”) | instrukcja DTU-Pro-S, dane techniczne | brak ustawienia (niepotwierdzone, czy da się zmienić) |
| Strefa czasowa | prawdopodobnie z lokalizacji elektrowni w S-Miles | **niepotwierdzone** | nie ruszać |

### B4. Kody `status`, `alarm_code`, `link`

**Producent nie opisuje wartości** „Operating Status”, „Alarm Code” ani „Link Status” w nocie Modbus; podaje tylko, że Link Status to „Communication status with DTU” ([nota, rozdz. 4.3.2](https://wiki.niziak.spox.org/_media/hw:hoymiles:technical-note-modbus-implementation-using-3gen-dtu-pro-v1.2.pdf)). Nie znalazłem innego opisu.

Co wiadomo i co jest hipotezą:

| Pole | Nasza wartość | Co wiadomo | Hipoteza (niepotwierdzone) |
|---|---|---|---|
| `link` | 1 | `hoymiles_modbus` traktuje ≠ 0 jako mikrofalownik aktywny ([client.py](https://github.com/wasilukm/hoymiles_modbus)) | 0 = brak łącza z DTU |
| `status` | 3 | brak opisu | 3 = praca normalna; inna wartość przy wyłączeniu, ograniczeniu albo braku słońca |
| `alarm_code` | 0 | `hoymiles_modbus` ≠ 0 traktuje jako alarm | kod zdarzenia z tej samej listy, co dziennik zdarzeń mikrofalownika (niżej) |
| `alarm_count` | 0 | brak opisu | licznik zdarzeń od startu mikrofalownika (rano od nowa) |

Lista zdarzeń mikrofalowników Hoymiles z OpenDTU ([`AlarmLogParser.cpp`](https://github.com/tbnobody/OpenDTU/blob/master/lib/Hoymiles/src/parser/AlarmLogParser.cpp)), wybór. Czy `alarm_code` z Modbus używa tych numerów: **niepotwierdzone**.

| Kod | Opis (OpenDTU) | Kod | Opis (OpenDTU) |
|---|---|---|---|
| 1 | Inverter start | 141 | Grid overvoltage |
| 2 | Time calibration | 142 | 10 min value grid overvoltage |
| 3 | EEPROM read/write error | 143 | Grid undervoltage |
| 4, 130 | Offline | 144 / 145 | Grid over-/underfrequency |
| 11–15 | wahania sieci (surge, drop, frequency, phase, transient) | 147 / 148 | Power grid outage / disconnection |
| 71 / 72 / 73 | redukcja mocy: przepięcie (VW), częstotliwość (FW), temperatura (TW) | 149 | Island detected |
| 95–98 | PV-1…4: podejrzenie zacienienia | 205–208 | MPPT-A/B: przepięcie / za niskie napięcie wejścia |
| 121 | Over temperature protection | 209–212 | PV-1…4: No input |
| 123 / 124 | Locked / Shut down by remote control | 215–222 | PV-1…4: przepięcie / za niskie napięcie |
| 125 | Grid configuration parameter error | 223 | Grid connection attempt failed |
| 127 | Firmware error | 2000–2004 | Standby |
| 129 | Abnormal bias | 3001–3004 | Reset |

Wniosek: w interfejsie pokazywać kod liczbowy, a opis z tej tabeli jako podpowiedź „możliwe znaczenie”. Potwierdzić przy pierwszym niezerowym kodzie, porównując z alarmem w S-Miles.

### B5. Do odczytu: czego dziś nie czytamy

| Parametr | Skąd | Funkcja | Osiągalne | Po co |
|---|---|---|---|---|
| Numer seryjny DTU | `0x2000`, 3 rejestry (6 bajtów BCD) | `0x03` | tak; tak czyta `hoymiles_modbus` | Ustawienia, identyfikacja bramki |
| Data Type (`0x3C`) i bajt `0x07` w rekordzie | bajt 0 i 33 rekordu (już przychodzą) | – | tak, bez nowego zapytania | kontrola poprawności rekordu |
| Lista mikrofalowników w DTU | `0x2056…`, 3 rejestry na wpis | `0x03` | tak | porównanie z portami w odczycie, wykrycie brakującego |
| Tryb i adres portu RS-485 | `0x2503`, `0x2504` | `0x03` | tak | diagnostyka |
| Bieżący stan ON/OFF i limit portu | `0xC006…` | `0x01` / `0x02` | **niepotwierdzone** | pokazanie, czy ktoś ograniczył moc w S-Miles |
| Model, moc znamionowa, wersja firmware mikrofalownika | tylko Sunspec Model 1 albo OpenDTU | – | nie (inny tryb portu) | zastąpić wpisem ręcznym w Ustawieniach; serię wyprowadzić z prefiksu SN |
| Moc AC, sprawność, cos φ | brak w mapie Hoymiles | – | nie | – |
| Opis kodów status / alarm | brak w dokumentacji | – | – | hipoteza w B4 |
| Wskaźnik „nasłonecznienia” portu | wyliczany: `power / Wp panelu` | – | tak, po wpisaniu Wp | mapa ciepła, porównanie paneli |

---

## Wątpliwości i rzeczy do sprawdzenia

1. **Typ mikrofalowników.** Prefiksy 1144 i 1164 to według OpenDTU seria HMS, nie HM. Sprawdzić tabliczki; od tego zależy skala prądu (nota rozróżnia tylko HM i MI) i zakres limitu.
2. **Model DTU.** Przy HMS bramka to najpewniej DTU-Pro-S. Nota v1.2 opisuje DTU-Pro; integracja HA z zapisem limitu była testowana na DTU-Pro-S po TCP, nie RTU.
3. **Częstotliwość odświeżania danych w DTU.** Chmura dostaje dane co 15 min; jak często DTU odpytuje mikrofalowniki, nie wiadomo. Użytkownik evcc podał cykl 69 s przy 7 mikrofalownikach. Sprawdzić w `pv`, czy kolejne odczyty co 60 s się zmieniają, czy powtarzają.
4. **Zapis limitu i włącz/wyłącz.** Trzy źródła podają trzy sposoby (`0x05`, `0x06`, `0x0F` z bitami) i możliwe przesunięcie adresu o 1. Nie wiadomo też, czy zapis przez DTU jest trwały w mikrofalowniku ani co wygrywa przy limicie ustawionym w S-Miles. Przed jakąkolwiek funkcją w aplikacji: odczyt `0xC006` funkcją `0x01`, potem jeden ręczny zapis w dzień z obserwacją mocy.
5. **Adresy portów 3–10 w rejestrach sterujących** (krok 6) są wnioskiem z portów 1–2; w nocie jest literówka.
6. **Kody `status`, `alarm_code`, `link`:** brak opisu producenta; tabela w B4 to hipoteza.
7. **Moc DC a AC.** `total_power` to suma mocy DC portów. Do bilansu z pompą ciepła i licznikiem energii trzeba to opisać w interfejsie albo przeliczać przez sprawność.
8. **Retencja paneli 90 dni** ogranicza porównanie paneli w dłuższym okresie; potrzebne dzienne podsumowanie per port (rekomendacja 9).
