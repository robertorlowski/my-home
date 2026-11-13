# Firmware co — opis biznesowy

[← Dokumentacja systemu](../../../docs/README.md) · **1. Opis biznesowy** · [2. Zasada działania](2-zasada-dzialania.md) · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](en/1-business-description.md)

## Po co jest ten sterownik

`co` to mały komputer (ESP32) zamontowany przy pompie ciepła. Jest **tłumaczem między pompą a chmurą**:

- czyta stan pompy ciepła (sterownik CHPC) i instalacji fotowoltaicznej (mikrofalowniki Hoymiles),
- wysyła te dane do aplikacji My Home,
- odbiera z chmury ustawienia (tryb, temperatury, wymuszenie…) i przekazuje je pompie,
- pilnuje, żeby pompa naprawdę miała te ustawienia — CHPC nie potwierdza poleceń, więc `co` sprawdza i w razie potrzeby powtarza.

Bez `co` pompa działa samodzielnie na ostatnich ustawieniach, ale nie da się nią sterować z aplikacji ani zbierać danych.

Sterownik nie pobiera pogody i nie wysyła maili aplikacji: robi to tylko serwer, który na Oracle ma własny adres IP. W wersjach 1.3.0–1.3.4 `co` był w obu sprawach zapasem włącznika; od 1.4.0 (2026-11-13) zapasu nie ma w żadnym sterowniku.

Od 1.4.0 (2026-11-13, próbnie) `co` przewozi też polecenia z serwera do QNAP-a w sieci domowej (stan, restart sieci, restart), gdy QNAP nie jest widoczny z zewnątrz. Ok. 2026-12-13 sprawdzamy, czy było używane; bez użycia funkcja zostanie usunięta.

Od 2026-10-03 odczyt pieca pelletowego Pellux 200 działa na osobnej płytce — [devices/pellet-boiler-pelux200](../../pellet-boiler-pelux200/README.md). W dniach 2026-10-01–02 był drugą rolą `co`.

## Dla kogo

- **Właściciel** — nie musi nic robić; sterownik działa sam. Może zajrzeć na jego stronę w sieci domowej albo na ekran.
- **Instalator** — przy montażu ustawia Wi-Fi (przez punkt dostępowy `MyHome-HeatPump-XXXX` (XXXX = ostatnie 4 znaki SN) i stronę `http://10.10.10.1/install`); sterownik sam zgłasza się do chmury.
- **Serwisant** — przyciskiem na obudowie może odciąć pompę od chmury (tryb lokalny) albo przełączyć ją ręcznie na CO lub CWU.

## Co umożliwia

| Funkcja | Opis |
|---|---|
| Sterowanie z chmury | tryb pracy, temperatury CO i CWU, wymuszenie, pompy obiegowe, zawór EEV, limit mocy, odblokowanie i restart pompy |
| Dane pompy | co 10 s (sprężarka pracuje) albo 30 s (postój) |
| Fotowoltaika | co 60 s: moc, produkcja, temperatury i stan każdego mikrofalownika |
| Szacunek COP | efektywność każdego cyklu grzania zbiornika 300 l |
| Tryb PV | wymuszenie startu pompy, gdy PV produkuje co najmniej 2000 W |
| Praca bez chmury | przycisk: `OFF` (pompa zatrzymana), `MANUAL_CO`, `MANUAL_CWU` |
| Podgląd na miejscu | ekran kolorowy i strona WWW w sieci domowej |
| Polecenia dla QNAP-a (próbnie, od 1.4.0) | `stan`, `restart_sieci`, `restart` z polecenia na serwerze, przekazane do QNAP-a w sieci domowej; sterownik tylko przewozi podpisane polecenie i odsyła odpowiedź |

## Ekran i strony sterownika

Napisy na ekranie i stronach są po angielsku (od wersji 1.3.3); zrzuty poniżej pokazują wcześniejszą wersję po polsku.

![Ekran sterownika](ekran-podglad.png)

*Ekran (emulacja): u góry data, godzina i tryb (`C-A` = chmura, tryb CO Harmonogram), moc i produkcja PV, temperatura falowników. Duże „T” to temperatura w środku zbiornika — żółta, gdy pracuje sprężarka, czerwona przy błędzie pompy. Pod nią temperatura zewnętrzna z chmury, a niżej parametry pompy.*

| Strona `/` (telefon) | Strona `/install` (telefon) |
|---|---|
| ![Strona główna](img/strona-glowna-telefon.png) | ![Instalacja](img/instalacja-telefon.png) |

*Strona `/` odświeża się co 5 s: sterownik, pompa, cykl i COP, diagnostyka, fotowoltaika z tabelą mikrofalowników. Strona `/install` (chroniona hasłem) służy do ustawienia Wi-Fi i pokazuje SN, Root ID i stan rejestracji.*

## Tryby sterownika (przycisk)

| Tryb | Na ekranie | Działanie |
|---|---|---|
| `CLOUD` | `C-…` | wykonuje ustawienia z chmury (tryb domyślny) |
| `OFF` | `L-OFF` | wyłącza pompę (CO, wymuszenie, pompy obiegowe) i przekaźniki; pilnuje, żeby tak zostało |
| `MANUAL_CO` | `M-CO` | przekaźniki CO/CWU włączone, pompa działa na własnych ustawieniach |
| `MANUAL_CWU` | `M-CWU` | przekaźniki wyłączone, pompa grzeje tylko ciepłą wodę |

Pierwsze naciśnięcie tylko pokazuje tryb; kolejne przechodzą dalej: `OFF → CLOUD → MANUAL_CO → MANUAL_CWU → OFF`. Wybrany tryb zaczyna działać 5 s po ostatnim naciśnięciu i przetrwa restart. Dane do chmury idą we wszystkich trybach.

## Ograniczenia

- Polecenia z chmury docierają do pompy przy najbliższej wymianie (10–30 s), szybciej tylko akcje odblokowania i restartu — **i tylko w trybie `CLOUD`**; w innych trybach te akcje przepadają.
- Punkt dostępowy `MyHome-HeatPump-XXXX` jest otwarty (bez hasła) i działa tylko przez pierwsze minuty albo gdy nie ma Wi-Fi lub chmury.
- Login i hasło do `/install` są wpisane w kod; strony `/` i `/telemetry.json` są otwarte dla każdego w sieci domowej.
- Sterownik nie weryfikuje certyfikatu serwera (HTTPS bez sprawdzania).
- Polecenie dla QNAP-a nie pomoże, gdy karta sieciowa QNAP-a nie ma łącza: wtedy żadne żądanie przez sieć do niego nie dotrze.

## Słownik

| Pojęcie | Znaczenie |
|---|---|
| **RS-485** | dwuprzewodowa magistrala, na której są pompa (adres 0x41), DTU (0x69) i `co` (0x10) |
| **DTU** | bramka mikrofalowników Hoymiles (Modbus RTU) |
| **SN** | numer seryjny `co` — adres MAC układu ESP32 |
| **Root ID** | identyfikator sterownika w chmurze, zapisany w pamięci `co` |
| **NVS** | trwała pamięć ESP32 (Wi-Fi, Root ID, tryb) |
| **Operacja** | ustawienia z chmury w odpowiedzi na dane pompy |
