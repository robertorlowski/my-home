# Dokumentacja systemu My Home

[English](en/README.md)

System steruje domową pompą ciepła (CHPC) z chmury, zbiera dane z instalacji fotowoltaicznej, monitoruje hydrofor, pokazuje dane kotła pelletowego i steruje włącznikiem 230 V. Ten plik jest punktem wejścia: opisuje całość i prowadzi do dokumentacji poszczególnych modułów.

## Co robi system

- **Pompa ciepła.** Użytkownik ustawia w aplikacji WWW tryb pracy (CO, CWU, wyłączona), temperatury i harmonogramy. Serwer co minutę wylicza, co pompa ma robić, a sterownik `co` przekazuje to do sterownika pompy CHPC. Aplikacja pokazuje bieżący stan, historię, wykresy, koszty energii i błędy pompy.
- **Fotowoltaika.** Sterownik `co` co minutę czyta z mikrofalowników (DTU Hoymiles) moc i produkcję. Dane trafiają do osobnej kolekcji i do bilansu energii pompy.
- **Hydrofor.** Sterownik hydroforu przy każdym uruchomieniu pompy wody włącza na chwilę kompresor, a do chmury wysyła czasy pracy. Aplikacja liczy z tego zużycie wody: czas pracy pompy × przepływ pompy wyliczony z ręcznych odczytów wodomierza.
- **Włącznik.** Sterownik ESP32 z przekaźnikiem (pierwszy steruje grzałką bojlera) co 5 s zgłasza stan przekaźników i w odpowiedzi dostaje polecenie: włącz na czas, włącz bez limitu albo wyłącz. Polecenie wynika z trybu wybranego w aplikacji i z harmonogramu (dni jak w pompie ciepła, bez temperatur). Aplikacja pokazuje stan i historię włączeń.
- **Kocioł pelletowy.** Osobny sterownik pieca (ESP32-C3 z modułem RS-485, [devices/pellet-boiler-pelux200](../devices/pellet-boiler-pelux200/README.md)) udaje na magistrali regulatora ecoMAX kotła Plum Pellux 200 moduł ecoNET: odbiera stan, temperatury, paliwo i wyjścia kotła (co kilka minut do chmury), czyta ustawienia regulatora i na zlecenie z aplikacji zmienia parametry (tryb Pompa ciepła / Pellet, sezon, zadane CWU i mieszaczy, włączenie i wyłączenie regulatora). Aplikacja ma też harmonogram CWU i pracy kotła osobno dla obu trybów. Do 2026-10-02 kocioł obsługiwał sterownik `co` (jego druga rola).
- **Pogoda i poczta.** Włącznik pobiera z domowego łącza pogodę Open-Meteo dla domu i kafelków pogody (serwer na Render nie może), a kliknięcie kafelka otwiera stronę z prognozą. Ten sam włącznik (zapasowo `co`) wysyła maile aplikacji — kody logowania i zaproszenia — bo darmowy plan Render blokuje SMTP.

## Schemat systemu

```mermaid
flowchart LR
    CHPC["CHPC<br/>sterownik pompy ciepła<br/>(Arduino Pro Mini)"]
    DTU["DTU Hoymiles<br/>fotowoltaika"]
    CO["co<br/>sterownik (ESP32)"]
    ECO["Kocioł pelletowy Pellux 200<br/>regulator ecoMAX"]
    PEL["Piec<br/>sterownik (ESP32-C3 + RS-485)"]
    HYD["Hydrofor<br/>sterownik (ESP32)"]
    SW["Włącznik<br/>sterownik (ESP32 + przekaźnik)"]
    SRV["My Home — serwer<br/>(Node.js, Render)"]
    DB[("MongoDB Atlas")]
    WEB["My Home — aplikacja WWW<br/>(przeglądarka, telefon)"]
    IMGW["IMGW<br/>temperatura zewnętrzna"]

    CHPC <-- "RS-485<br/>komendy i stan (JSON)" --> CO
    DTU <-- "RS-485<br/>Modbus RTU" --> CO
    ECO -- "RS-485<br/>ramki SensorData, tylko odbiór" --> PEL
    CO <-- "HTTPS: telemetria → operacja<br/>WebSocket: szybka akcja" --> SRV
    PEL -- "HTTPS: odczyt kotła co kilka minut<br/>zgłoszenie → interwał" --> SRV
    HYD -- "HTTPS: uruchomienia co 1 s<br/>zgłoszenie → ustawienia" --> SRV
    SW <-- "HTTPS: stan co 5 s → polecenia<br/>WebSocket: szybka zmiana" --> SRV
    IMGW -- "co 10 min" --> SRV
    SRV <--> DB
    WEB <-- "REST API, WebSocket" --> SRV
```

Najważniejsza zasada: **sterowniki inicjują połączenie, serwer tylko odpowiada.** Sterownik `co` wysyła stan pompy co 10–30 s i w odpowiedzi dostaje operację do wykonania. WebSocket służy wyłącznie do przyspieszenia tej wysyłki.

## Moduły

| Moduł | Co robi | Kod | Dokumentacja |
|---|---|---|---|
| **core** | część wspólna aplikacji: urządzenia, zgłoszenie sterownika, lista kafelków i wybór sterownika, konta użytkowników, wspólny wygląd „Instrument” (pasek, zakładki, motyw, język polski / angielski), dziennik operacji, WebSocket, temperatura, kalendarz | `server/src/core`, `client/src/core` | [docs/moduly/core](moduly/core/1-opis-biznesowy.md) |
| **heat-pump** | pompa ciepła w aplikacji: telemetria, PV, operacje, scheduler, harmonogramy, widoki | `server/src/modules/heat-pump`, `client/src/devices/heat-pump` | [docs/moduly/heat-pump](moduly/heat-pump/1-opis-biznesowy.md) |
| **water-pressure-tank** | hydrofor w aplikacji: uruchomienia, woda z czasu pompy i wodomierza, widoki | `server/src/modules/water-pressure-tank`, `client/src/devices/water-pressure-tank` | [docs/moduly/water-pressure-tank](moduly/water-pressure-tank/1-opis-biznesowy.md) |
| **pellet-boiler-pelux200** | kocioł pelletowy w aplikacji: odczyty kotła, interwał odpytywania, widoki (tylko podgląd) | `server/src/modules/pellet-boiler-pelux200`, `client/src/devices/pellet-boiler-pelux200` | [docs/moduly/pellet-boiler-pelux200](moduly/pellet-boiler-pelux200/1-opis-biznesowy.md) |
| **switch** | włącznik w aplikacji: przekaźniki, tryby, harmonogramy, historia włączeń, widoki | `server/src/modules/switch`, `client/src/devices/switch` | [docs/moduly/switch](moduly/switch/1-opis-biznesowy.md) |
| **firmware co** | sterownik ESP32 między pompą, PV i chmurą | `devices/co` | [devices/co/docs](../devices/co/docs/1-opis-biznesowy.md) |
| **firmware CHPC** | sterownik pompy ciepła (sprężarka, pompy obiegowe, EEV, zabezpieczenia) | `devices/chpc` | [devices/chpc/docs](../devices/chpc/docs/1-opis-biznesowy.md) |
| **firmware hydroforu** | sterownik ESP32 kompresora hydroforu | `devices/water-pressure-tank` | [devices/water-pressure-tank/docs](../devices/water-pressure-tank/docs/1-opis-biznesowy.md) |
| **firmware włącznika** | sterownik ESP32 z przekaźnikiem 230 V (płytka „ESP32 Relay AC X1”) | `devices/switch` | [devices/switch/docs](../devices/switch/docs/1-opis-biznesowy.md) |
| **firmware pieca** | sterownik ESP32-C3 z modułem RS-485 HW-519: nasłuch magistrali ecoMAX kotła Pellux 200 | `devices/pellet-boiler-pelux200` | [devices/pellet-boiler-pelux200](../devices/pellet-boiler-pelux200/README.md) |
| **firmware klimatyzatora** (projekt) | ESP32-C3 SuperMini w gnieździe modułu Wi-Fi klimatyzatora Sinclair SIM-12BS3 (UART Gree); na razie schemat podłączenia, bez firmware | `devices/air-conditioner` | [devices/air-conditioner/docs](../devices/air-conditioner/docs/podlaczenie.md) |

Rodzaj sterownika (`deviceType`) decyduje, którego modułu używa aplikacja: `heat_pump` (sterownik `co` z pompą CHPC), `water-pressure-tank` (hydrofor), `pellet-boiler-pelux200` (kocioł pelletowy, osobny sterownik pieca) albo `switch` (włącznik). Jeden fizyczny sterownik może mieć kilka ról (tak było 2026-10-01–02, gdy `co` obsługiwał też kocioł): w aplikacji to osobne urządzenia o tym samym `deviceId`, ale innym rodzaju i `rootId` (opis w [module core](moduly/core/2-zasada-dzialania.md)).

## Układ dokumentacji modułu

Każdy moduł ma trzy części, w osobnych plikach:

1. **`1-opis-biznesowy.md`** — po co moduł jest, dla kogo, co pozwala zrobić, ograniczenia i słownik pojęć. Bez szczegółów technicznych.
2. **`2-zasada-dzialania.md`** — jak moduł działa krok po kroku, ze schematami (Mermaid: przepływ danych, sekwencje, stany).
3. **`3-dokumentacja-techniczna.md`** — pliki i ich role, API, modele danych, kontrakty z innymi modułami, konfiguracja, testy, wdrożenie, znane problemy.

Schematy są w [Mermaid](https://mermaid.js.org/): wyświetla je GitHub i podgląd Markdown w VS Code.

Kod ma komentarze na dwóch poziomach: **nagłówek pliku** (do czego służy, kto go używa, z czym jest powiązany) i **komentarz przy logice nieoczywistej** (dlaczego tak, a nie inaczej).

## Zasady pracy nad całym systemem

- **Kontrakt** to pola telemetrii, klucze operacji, adresy API i komendy RS-485. Jego zmiana obejmuje wszystkie części, których dotyczy (serwer, klient, firmware), najlepiej w jednym commicie.
- **Kolejność wdrożenia:** najpierw serwer (gałąź `main`, build na Render uruchamiany ręcznie), potem firmware `co`, hydroforu albo włącznika, na końcu CHPC. Serwer musi znać nowe pole lub adres, zanim wyśle je sterownik.
- **Gałęzie:** praca na `develop`; scalanie do `main` tylko na wyraźne polecenie.
- **Nowy rodzaj sterownika:** katalog w `server/src/modules/` i `client/src/devices/`, wpis w obu rejestrach (`server/src/core/device-types.ts`, `client/src/core/device-types.tsx`) i wartość w `DeviceType`. Szczegóły w [module core](moduly/core/).

## Szybki start

```bash
npm install
npm run local            # lokalna baza MongoDB (port 27027), serwer (4001) i aplikacja (5173)
node scripts/seed-local.mjs   # dane demonstracyjne w bazie lokalnej (czyści ją)
npm test -w server -- --run
npm run build -w client
pio test -d devices/co -e native
pio test -d devices/chpc -e native
pio test -d devices/water-pressure-tank -e native
pio test -d devices/switch -e native
```

Lokalna baza jest w `.local-db/` (poza gitem). Serwer produkcyjny: `https://chpc-web.onrender.com`. Zmienne środowiskowe serwera (`MONGODB_URI`, `PORT` i pozostałe) są opisane w [module core](moduly/core/).

## Inne dokumenty

- [CLAUDE.md](../CLAUDE.md) — przewodnik dla Claude Code i szczegółowe zasady całego łańcucha.
- Historia zmian w firmware `co`: [devices/co/docs](../devices/co/docs/) (opis stanu przed i po przebudowie z 2026-09).
- Analiza pracy pompy z 2026-09-26: [devices/chpc/docs/analiza-pracy](../devices/chpc/docs/analiza-pracy/).
