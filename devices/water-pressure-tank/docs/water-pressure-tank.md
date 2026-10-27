# Hydrofor — sterownik `water-pressure-tank`

> **Specyfikacja (historia decyzji).** Aktualna dokumentacja: [1. Opis biznesowy](1-opis-biznesowy.md) · [2. Zasada działania](2-zasada-dzialania.md) · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md), a strona serwerowa w [module water-pressure-tank](../../../docs/moduly/water-pressure-tank/1-opis-biznesowy.md). Gdy się różnią, obowiązują tamte dokumenty.
>
> **Zmiana w wersji 1.3.0 (2026-10-02).** Opisane niżej zbiorniki w ustawieniach (`tanks`, rodzaje `air`/`membrane`, `k`, `precharge`/`p0`), progi presostatu (`pressure_low`, `pressure_high`), szacunek wody z prawa Boyle'a, sugerowane `k` i kalkulator w Ustawieniach zostały usunięte. Woda jest teraz liczona przy odczycie jako czas pracy pompy (bez ręcznej pracy kompresora) × przepływ pompy wyliczony z odczytów wodomierza: [moduł water-pressure-tank, zasada działania](../../../docs/moduly/water-pressure-tank/2-zasada-dzialania.md#woda-z-czasu-pracy-pompy-i-wodomierza). Ustawienia hydroforu to tylko `compressor_seconds`. Strona sterownika ma przyciski „Włącz”, „Wyłącz” i „Uruchom na N s” (od wersji 1.3.2 strony sterownika są po angielsku: „Turn on”, „Turn off”, „Run for N s”). Treść poniżej zostaje jako historia decyzji.

Dokumentacja działania sterownika hydroforu i jego obsługi w My Home. Stan: 2026-09-28, wersja 4 (zatwierdzona do implementacji).

## Nazwy

| Co | Nazwa |
|---|---|
| typ urządzenia (kod, definicja urządzenia w bazie) | `water-pressure-tank` |
| katalog firmware | `devices/water-pressure-tank` |
| główny plik firmware | `src/water-pressure-tank.cpp` |
| kolekcja uruchomień | `water_pressure_tank` |
| kolekcja odczytów wodomierza | `water_meter` |
| nazwa wyświetlana | „Hydrofor” |

## 1. Instalacja

```text
presostat (niskie ciśnienie) ──► przekaźnik ──► 230 V: pompa wody + zasilacz 5 V sterownika (ESP32 DevKit)
                                                                            │
                                                                            └─► przekaźnik kompresora (30 s)
```

Zbiorniki Hydro-Vacuum, połączone równolegle:

| Zbiornik | Pojemność | Rodzaj | Uwagi |
|---|---|---|---|
| 1 | 300 l | ocynkowany, poduszka powietrzna dobijana kompresorem | tylko w nim woda jest natleniana |
| 2 | 300 l | przeponowy (worek gumowy) | można go wyłączyć w konfiguracji (planowane odłączenie) |

### Cykl pracy

1. Ciśnienie spada do progu dolnego, więc presostat włącza przekaźnik.
2. Przekaźnik zasila pompę wody i sterownik.
3. Sterownik po 1 s od podania zasilania **raz** włącza kompresor na ustawiony czas (domyślnie 30 s). Kompresor dobija powietrze do zbiornika ocynkowanego i natlenia w nim wodę.
4. Pompa pracuje dłużej niż kompresor, aż do progu górnego. Presostat wyłącza przekaźnik, a sterownik traci zasilanie.

**Sterownik działa więc tylko wtedy, gdy pracuje pompa.** Każde uruchomienie pompy to nowy start sterownika.

## 2. Kompresor przy starcie

Kompresor startuje raz i nie jest przerywany. Zapobiega temu, co działo się w starym szkicu: krótkie włączenie przy podaniu zasilania, 3–5 s przerwy i ponowny start, przy którym kompresor mógł nie ruszyć.

**Firmware:**
- Na samym początku `setup()` sterownik ustawia stan pinu przekaźnika na „wyłączony”, zanim przełączy pin na wyjście. Dzięki temu pin ani przez chwilę nie ma złego stanu.
- Po 1 s (ustabilizowanie zasilania) włącza kompresor.
- Dopiero potem uruchamia Wi-Fi, punkt dostępowy i serwer WWW. Kompresor nie czeka na sieć.
- Po ustawionym czasie kompresor wyłącza się jeden raz.

**Sprzęt:**
- **Zalecany wariant:** moduł przekaźnika sterowany stanem wysokim z rezystorem 10 kΩ z `IN` do masy. Przy braku napięcia i w czasie uruchamiania ESP32 przekaźnik jest wtedy na pewno wyłączony.
- **Moduł sterowany stanem niskim:** moduł dostaje 5 V wcześniej, niż ESP32 ma 3,3 V, więc wejście `IN` jest przez chwilę ściągane do masy przez diody zabezpieczające pinu. Przekaźnik włącza się wtedy na moment niezależnie od programu.
- Poziom aktywny to stała w kodzie `RELAY_ACTIVE_HIGH`, dobierana do zamontowanego modułu.

## 3. Schemat podłączenia

```text
                        230 V z przekaźnika presostatu (razem z pompą)
                          L ──┬──────────────────────────────┐
                          N ──┼──────────────┐               │
                              │              │               │
                        ┌─────┴──────┐       │               │
                        │ zasilacz   │       │               │
                        │ 230V→5V    │       │               │
                        │ (np. HLK-  │       │               │
                        │  PM01)     │       │               │
                        └──┬──────┬──┘       │               │
                         +5V     GND         │               │
                           │      │          │               │
     ┌─────────────────────┼──────┼──┐       │               │
     │ ESP32 DevKit WROOM  │      │  │       │               │
     │                 5V ─┘      │  │       │               │
     │                GND ────────┤  │       │               │
     │             GPIO26 ──┐     │  │       │               │
     └──────────────────────┼─────┼──┘       │               │
                            │     │          │               │
                     ┌──────┴─────┼──────┐   │               │
                     │ IN         │      │   │   ┌───────────┴──┐
      10 kΩ          │ moduł przekaźnika │   │   │  COM         │
  IN ──/\/\/── GND   │ 5 V, 1 kanał,     │   │   │     styk     │
  (przy module       │ sterowany stanem  │   │   │  NO ──┐      │
   sterowanym HIGH)  │ wysokim (zworka H)│   │   └───────┼──────┘
                     │ VCC ── +5V        │   │           │
                     │ GND ── GND        │   │      ┌────┴─────┐
                     └───────────────────┘   └──────┤ kompresor│
                                                    └──────────┘
```

- **ESP32 DevKit:** zasilanie przez pin `5V` (albo USB-C) z zasilacza 5 V; dokładny układ pinów w [części 3](3-dokumentacja-techniczna.md#podłączenie). Masa jest wspólna z modułem przekaźnika.
- **Moduł przekaźnika:** `VCC` do +5 V, `GND` do masy, `IN` do `GPIO26` (pin „P26”).
- **Rezystor 10 kΩ:** przy module sterowanym stanem wysokim z `IN` do `GND`. Przy module sterowanym stanem niskim z `IN` do `3V3` płytki, nigdy do 5 V, bo ESP32 nie toleruje 5 V na pinie.
- **Styki:** `COM` i `NO` w przewodzie fazowym kompresora. Prąd rozruchowy kompresora nie może przekraczać obciążalności przekaźnika (zwykle 10 A / 250 V AC). Przy silniku powyżej ok. 0,5 kW przekaźnik powinien sterować stycznikiem.
- **Montaż:** tylko osoba uprawniona do prac przy 230 V, w obudowie, z bezpiecznikiem.

## 4. Sterownik

**Płytka:** ESP32 DevKit z modułem WROOM-32, środowisko PlatformIO `esp32dev`, konsola UART0. Przekaźnik na `GPIO26`. (Pierwotnie ESP32-C3 SuperMini na `GPIO10`, wycofana 2026-10-02 przez słabą antenę.) Pin i poziom to stałe w kodzie.

**Stałe w `src/firmware.hpp`:** `RELAY_PIN = 10`, `RELAY_ACTIVE_HIGH` (obecnie `false`), `COMPRESSOR_START_DELAY_MS = 1000`, `DEFAULT_COMPRESSOR_SECONDS = 30`, `MAX_COMPRESSOR_SECONDS = 3600`, `CLOUD_URL = https://chpc-web.onrender.com/api/` (stały adres chmury, bez pola na stronie `/install`).

**Pliki:** `src/water-pressure-tank.cpp` (start, sieć, strony, wysyłka), `src/compressor.*` (czas pracy kompresora), `src/settings.*` (ustawienia i szacunek wody), `src/run_report.*` (JSON wysyłki i kolejka w NVS).

### 4.1 Sieć i dostęp

- Wi-Fi, Root ID, ustawienia z chmury, licznik uruchomień, bieżące uruchomienie i kolejka są zapisane w pamięci NVS (trwała pamięć ESP32 na ustawienia, przestrzeń `wp`). Wartości domyślne Wi-Fi dają `src/secrets.h`; zapis z `/install` ma pierwszeństwo.
- **Punkt dostępowy** działa przez cały czas pracy sterownika pod adresem `10.10.10.1` jako sieć `MyHome-WaterPump-XXXX` (od 2026-10-10; wcześniej `10.11.16.1`). Nie ma go tylko wtedy, gdy nie da się uruchomić modułu radiowego (komunikat w konsoli). Nazwa i hasło są w `src/secrets.h` (poza gitem, wzór w `secrets.example.h`). Hasło krótsze niż 8 znaków (np. puste) daje sieć otwartą, bo WPA2 wymaga co najmniej 8 znaków.
- W sieci domowej strony są też dostępne pod adresem IP sterownika (widocznym na `/install`).
- Strona `/install` jest chroniona tym samym loginem i hasłem co w sterowniku `co` (`INSTALL_USER`, `INSTALL_PASSWORD` w `secrets.h`).

### 4.2 Zgłoszenie w chmurze

Po połączeniu z internetem, raz na każdy start, sterownik wywołuje `POST /api/devices/register` z danymi:
- `deviceId`: MAC, 12 znaków hex,
- `deviceType: "water-pressure-tank"`,
- `name: "Hydrofor"`.

Serwer odpowiada tak:
- **nowe urządzenie:** tworzy je i zwraca `rootId`,
- **znane urządzenie:** zwraca istniejący `rootId`.

W obu przypadkach odpowiedź zawiera też **ustawienia urządzenia** (`settings`): czas pracy kompresora, progi presostatu i zbiorniki. Sterownik zapisuje `rootId` i ustawienia w NVS. Bez sieci używa ostatnich zapisanych ustawień. Ustawienia bez sensu (np. czas kompresora spoza 1–3600 s) są odrzucane i zostają poprzednie. Sterownik obsługuje najwyżej 4 zbiorniki.

Nowe urządzenie dostaje od serwera ustawienia domyślne: 30 s, progi 2 i 4 bar, zbiornik „Ocynkowany” 300 l z poduszką (`k` = 1) i „Przeponowy” 300 l (`p0` = 1,8 bar).

Nieudane zgłoszenie sterownik ponawia co 10 s. Dopóki się nie zgłosi, nie wysyła danych uruchomienia (zostają w pamięci, punkt 4.3).

Zmiana ustawień w aplikacji WWW dociera do sterownika przy jego następnym starcie. Nowy czas kompresora działa od następnego włączenia kompresora (także „Uruchom ponownie”); bieżąca praca kończy się po starym czasie.

**Czas kompresora ustawiony na sterowniku** (sekcja „Kompresor” na `/install`, punkt 4.4) jest zapisywany w NVS od razu, razem ze znacznikiem „do wysłania” (`comp_pending`). Dopóki znacznik jest ustawiony:
- sterownik wysyła `PUT /api/water-pressure-tank/settings?deviceId=<SN>&rootId=<id>` z `{compressor_seconds}`, przed zgłoszeniem, żeby odpowiedź na zgłoszenie niosła już nowy czas. Nieudaną wysyłkę ponawia co 10 s, a po utracie zasilania przy następnym starcie. Znacznik znika po odpowiedzi 2xx albo 400 (chmura tej wartości nie przyjmie); 409 kasuje Root ID jak przy wysyłce danych,
- zgłoszenie nie nadpisuje czasu kompresora wartością z chmury (pozostałe ustawienia przyjmuje), żeby niewysłana zmiana nie zginęła.

**Konflikt Root ID.** Gdy serwer odpowie 409 (zapisany `rootId` należy do innego urządzenia, np. po wyczyszczeniu bazy), sterownik kasuje swój Root ID i zgłasza się ponownie.

### 4.3 Wysyłka danych

Dopóki jest sieć, sterownik **co 1 s** wysyła `POST /api/water-pressure-tank/add?deviceId=<SN>&rootId=<id>` przez jedno stałe połączenie HTTPS (keep-alive, limit czasu 2 s). Nieudane zapytanie jest pomijane, bo następne przychodzi za sekundę. Adres `http://…` w `CLOUD_URL` (np. serwer lokalny, tylko w osobnej kompilacji) działa bez TLS. Certyfikat serwera nie jest sprawdzany, tak jak w `co`.

| Pole | Znaczenie |
|---|---|
| `runId` | numer uruchomienia (licznik w NVS). Pierwszy numer jest losowy, więc po wyczyszczeniu pamięci numeracja nie wraca do 1 i nie trafia do starych rekordów |
| `compressorStartS`, `compressorEndS` | sekundy od startu sterownika; koniec pusty, dopóki kompresor pracuje |
| `pumpRunS` | czas pracy pompy do tej chwili |
| `restarts` | liczba ręcznych ponownych uruchomień kompresora |
| `queued` | `true` dla uruchomienia wysyłanego z kolejki |

**Czas.** Sterownik nie ma zegara i go nie potrzebuje. Serwer wylicza daty z czasów względnych i swojego zegara w chwili odebrania wiadomości.

**Uruchomienie bez sieci.** Bieżące uruchomienie (czasy względne, czas pracy pompy) jest zapisywane w NVS co 1 s. Przy następnym starcie:
- jeśli z poprzedniego uruchomienia nie doszła do chmury **żadna** wiadomość, trafia ono do kolejki. Gdy doszła choć jedna, serwer ma to uruchomienie i sam wyznacza koniec pracy pompy, więc kolejka nie jest potrzebna,
- kolejka jest wysyłana z `queued: true`, jedno uruchomienie na sekundę, najstarsze pierwsze,
- serwer oznacza nowe uruchomienie z kolejki `timeApproximate: true`, bo jego daty to czas przyjęcia,
- uruchomienie z kolejki, które serwer już zna, dostaje tylko koniec pracy pompy liczony z czasu pracy (`pumpStart + pumpRunS`),
- kolejka mieści 40 uruchomień, a przy braku miejsca wypadają najstarsze. Uszkodzony zapis kolejki (np. po zmianie formatu) daje pustą kolejkę.

### 4.4 Strony sterownika

**`/` — strona główna** (odświeżana na żywo, bez przeładowania):
- stan kompresora **włączony/wyłączony**,
- czas do wyłączenia kompresora,
- ustawiony czas pracy kompresora,
- czas pracy pompy w bieżącym uruchomieniu,
- zbiorniki jako lista punktowana (nazwa, pojemność, szacunek wody) i „Ilość wody” na jedno uruchomienie,
- przycisk **„Uruchom kompresor ponownie”**: włącza kompresor na pełny ustawiony czas, liczony od chwili naciśnięcia. W raporcie zostaje pierwsze włączenie i ostatnie wyłączenie oraz liczba ponownych uruchomień.

Strona pobiera stan co 1 s z **`/state.json`** (stan i czas do wyłączenia kompresora, czas pracy pompy, zbiorniki z szacunkiem, Wi-Fi, zgłoszenie, ostatni kod HTTP, długość kolejki). Przycisk wysyła **`POST /restart`**.

**`/install` — instalacja** (Basic Auth):
- sekcja **„Wi-Fi”**: SSID i hasło (puste pole hasła zostawia zapisane, żeby strona nie odsyłała go jawnym HTTP); adresu chmury nie ma, bo jest stały (`CLOUD_URL`),
- sekcja **„Kompresor”**: czas pracy kompresora (pełne sekundy 1–3600) i przycisk „Zapisz czas” (`POST /install/compressor`), stan „Chmura: aktualna” albo „czeka na wysyłkę”. Zła wartość zostawia poprzedni czas i pokazuje komunikat. Nowy czas działa od następnego włączenia kompresora (punkt 4.2),
- dane sterownika: SN i Root ID (tylko do odczytu), adres IP w sieci domowej, status zgłoszenia i ostatniej wysyłki.

Nagłówki sekcji są wyróżnione kolorem i linią pod spodem.

Zapis Wi-Fi łączy sterownik z nową siecią od razu, bez restartu, bo restart włączyłby kompresor ponownie. Zapis czasu kompresora jest osobnym formularzem i nie łączy ponownie z Wi-Fi.

### 4.5 Testy (`pio test -e native`, 23 testy)

- kompresor: jeden start i koniec po czasie, brak ponownego włączenia, ponowne uruchomienie po wyłączeniu i w trakcie pracy, czas 0 s, zmiana czasu działa od następnego uruchomienia, czas ustawiony w trakcie pracy obowiązuje przy ponownym uruchomieniu,
- czas kompresora z `/install`: poprawne i złe wpisy (0, 3601, ułamek, znak, spacja), treść `PUT`, niewysłany czas lokalny nie jest nadpisywany przez chmurę (pozostałe ustawienia są),
- szacunek wody: oba rodzaje zbiorników, zbiornik wyłączony, `k`, `p0` powyżej progu dolnego i powyżej górnego, złe progi,
- ustawienia: odrzucenie złych danych z zachowaniem poprzednich, zapis i odczyt z NVS, brak zbiorników w wiadomości, wartości domyślne `k` i `p0`, obcięcie do 4 zbiorników,
- JSON wysyłki: brak końca kompresora, `queued`, liczba ponownych uruchomień,
- kolejka (na atrapie NVS): poprzednie uruchomienie trafia do niej raz, doręczone nie trafia, pierwszy start, przetrwanie restartu, wypadanie najstarszych, uszkodzony zapis.

Nie są testowane automatycznie: obsługa Wi-Fi, HTTP i stron, bo zależą od sprzętu. Sprawdza się je na płytce albo symulatorem po stronie serwera (punkt 6).

## 5. Serwer

### 5.1 Urządzenie (`devices`)

- `deviceType: 'water-pressure-tank'` (`DeviceType.WATER_PRESSURE_TANK`). Scheduler pompy ciepła pomija ten typ.
- `properties` hydroforu, edytowane w aplikacji WWW:
  - `compressor_seconds`: czas pracy kompresora,
  - `pressure_low`, `pressure_high`: progi presostatu [bar na manometrze],
  - `tanks[]`: `{name, kind: 'air' | 'membrane', volumeLiters, enabled, precharge, k}`.

### 5.2 Uruchomienia (`water_pressure_tank`)

Jeden dokument to jedno uruchomienie pompy:

| Pole | Znaczenie |
|---|---|
| `rootId`, `deviceType`, `deviceId`, `runId` | identyfikacja |
| `pumpStart`, `pumpEnd` | start i koniec pracy pompy |
| `compressorStart`, `compressorEnd` | włączenie i wyłączenie kompresora |
| `restarts` | liczba ręcznych ponownych uruchomień kompresora |
| `waterLiters` | szacunek wody z ustawień zbiorników w chwili utworzenia rekordu; późniejsza zmiana ustawień nie zmienia historii |
| `waterAirBaseLiters`, `waterMembraneLiters` | części szacunku: zbiorniki z poduszką przy `k` = 1 i zbiorniki przeponowe (do podpowiedzi `k`) |
| `timeApproximate` | daty przybliżone (uruchomienie z kolejki) |
| `lastSeenAt` | chwila ostatniej wiadomości |
| `createdAt`, `updatedAt` | znaczniki zapisu |

Serwer przyjmuje `runId` jako liczbę całkowitą ≥ 0, `pumpRunS` od 0 do 24 h, pozostałe czasy ≥ 0. Inne dane dają 400.

**Koniec pracy pompy.** Każda wiadomość (co 1 s) ustawia `pumpEnd` na czas jej odebrania. Gdy sterownik gaśnie, ostatnia wiadomość wyznacza koniec pracy pompy z dokładnością do 1 s. Serwer nie potrzebuje do tego osobnego zadania ani nie czeka na kolejny start sterownika. Uruchomienie jest „w toku”, jeśli ostatnia wiadomość przyszła mniej niż 5 s temu.

Indeksy: unikalny `{rootId, runId}` oraz `{rootId, pumpStart}`.

### 5.3 Wodomierz (`water_meter`)

Odczyty wpisywane ręcznie: `rootId`, `readAt` (data odczytu), `valueM3` (stan wodomierza), `note`.

### 5.4 Endpointy

Kontroler `water-pressure-tank.controller.ts`, serwis `water-pressure-tank.service.ts`.

| Endpoint | Znaczenie |
|---|---|
| `POST /api/devices/register` | zgłoszenie sterownika (wspólne dla wszystkich typów); zwraca `rootId` i `settings`; nieznany typ daje 400 |
| `GET` / `PUT /api/device/properties` | ustawienia hydroforu; czas kompresora spoza 1–3600 s albo nieznany rodzaj zbiornika daje 400 |
| `POST /api/water-pressure-tank/add` | wysyłka ze sterownika, zapis albo aktualizacja po `runId`; sam `deviceId` wystarcza, 404 i 409 jak w `/hp/add`; odpowiedź `{}` |
| `PUT /api/water-pressure-tank/settings` | czas kompresora ustawiony na stronie sterownika, `{compressor_seconds}` (pełne sekundy 1–3600, inaczej 400). Zmienia tylko `properties.compressor_seconds`, progi i zbiorniki zostają. Sam `deviceId` wystarcza, 404 dla nieznanego urządzenia i dla pompy ciepła, 409 jak w `/hp/add`; odpowiedź `{compressor_seconds}` |
| `GET /api/water-pressure-tank/runs?from=YYYY-MM-DD&to=YYYY-MM-DD` | uruchomienia z dni czasu warszawskiego (`to` włącznie), z polem `inProgress` |
| `GET /api/water-pressure-tank/summary?period=day\|month\|year&date=YYYY-MM-DD` | woda w godzinach dnia (24), dniach miesiąca albo miesiącach roku (12); puste przedziały z zerami |
| `GET` / `POST /api/water-pressure-tank/meter` | lista odczytów (od najstarszego) / nowy odczyt `{readAt, valueM3, note?}` |
| `DELETE /api/water-pressure-tank/meter/:id` | usunięcie odczytu; 404 dla nieznanego albo cudzego |
| `GET /api/water-pressure-tank/meter/summary?year=YYYY` | zużycie z wodomierza w okresach między odczytami i w miesiącach (interpolacja liniowa), porównanie z szacunkiem, sugerowane `k`; przy mniej niż dwóch odczytach puste |

### 5.5 Testy (vitest, `server/test/water-pressure-tank.test.ts`, 30 testów)

- wzór wody: przepona z `p0`, poduszka z `k`, zbiornik wyłączony, `p0` powyżej progu dolnego, złe progi; **ten sam wynik we wzorze klienta** (`client/src/devices/water-pressure-tank/utils/water.ts`) i kalkulator pojemności,
- zgłoszenie: nowe urządzenie z ustawieniami domyślnymi, znane urządzenie (ten sam `rootId`, nazwa bez zmian), pompa ciepła bez ustawień hydroforu, nieznany typ,
- uruchomienia: daty z czasów względnych, `pumpEnd` z ostatniej wiadomości, zachowanie początku kompresora, sam `deviceId`, kolejka i czas przybliżony, dosłanie z kolejki znanego uruchomienia, „w toku”, 404 i 409, złe dane,
- woda liczona z ustawień w chwili utworzenia (bez zmiany historii),
- zakresy: dni, okres ISO, złe parametry; podsumowania dnia, miesiąca i roku,
- wodomierz: zużycie okresu i miesiąca, sugerowane `k`, za mało odczytów, zły rok, usuwanie (nieznany, cudzy, zły identyfikator), brak daty lub stanu,
- ustawienia: zapis i przekazanie sterownikowi przy zgłoszeniu, odrzucenie złych wartości,
- czas kompresora ze sterownika: zmiana tylko tego pola (progi i zbiorniki bez zmian), wartości spoza 1–3600 s, ułamek i napis, 404 (nieznany sterownik, pompa ciepła), 409,
- sterownik domyślny: tylko jeden, wyłączenie, nieznane urządzenie.

## 6. Aplikacja WWW

- **Lista sterowników (`/devices`):**
  - kafelek hydroforu z ikoną kropli,
  - na każdym kafelku gwiazdka „domyślny”.
- **Sterownik domyślny:** po otwarciu aplikacji (raz na sesję przeglądarki) aplikacja przechodzi od razu do domyślnego sterownika z bazy, także gdy wcześniej był wybrany inny. Zmiana sterownika w stopce obowiązuje do końca sesji. Gdy nie ma domyślnego, a sterownik jest tylko jeden, wybierany jest on.
- **Menu zależy od typu wybranego sterownika.** Dla hydroforu: Hydrofor (ikona kropli), Dane, Wykres, Ustawienia, bez Harmonogramu (`/schedules` przekierowuje na główne okno). Widoki są w `client/src/devices/water-pressure-tank/pages/`, a menu w `client/src/devices/water-pressure-tank/device-type.tsx` (rejestr rodzajów sterowników w `client/src/core/device-types.tsx`).

**Główne okno (podgląd, odświeżanie co 10 s):**
- czas pracy kompresora, progi presostatu i szacowana woda na uruchomienie,
- zbiorniki z pojemnością, rodzajem, szacunkiem albo stanem „wyłączony”,
- lista dzisiejszych uruchomień, od najnowszego: godzina, kompresor [s], pompa [s], woda [l]. Znak „≈” oznacza czas przybliżony, a uruchomienie w toku jest wyróżnione kolorem („pracuje”, „…”),
- suma wody z dnia i liczba uruchomień.

**Dane** (zakładki *Uruchomienia pompy* / *Odczyty wodomierza*):
- **Uruchomienia pompy:** „Dane na miesiąc:” i tabela z wybranego miesiąca, z eksportem CSV.
- **Odczyty wodomierza:** nowy odczyt (sama data, bez godziny; zapis jako południe tego dnia, stan w m³, uwagi) i lista odczytów z zużyciem między nimi.

**Wykres „Zużycie wody w okresie”:** przełącznik **dzień / miesiąc / rok**:
- dzień: słupki godzinowe,
- miesiąc: dzienne,
- rok: miesięczne; znacznik **„Pokaż odczyty z wodomierza”** (pod wykresem) zamienia wykres na porównanie wodomierza z szacunkiem w miesiącach (podpowiedź z pełną nazwą miesiąca) i pokazuje sugerowane `k`. Bez co najmniej dwóch odczytów w roku zostaje zwykły wykres zużycia, a pod znacznikiem jest komunikat o braku odczytów.

Oś Y ma jedną jednostkę: litry, a od 10 000 l największej wartości m³. Wartości liczbowe w Ustawieniach są wyrównane do prawej, a wszystkie pola mają tę samą szerokość.

**Ustawienia:**
- czas pracy kompresora (pełne sekundy 1–3600),
- progi presostatu (dolny ≥ 0, górny większy od dolnego),
- zbiorniki: dodawanie (ikona ⊕ w tytule sekcji „Zbiorniki”), usuwanie (ikona kosza w prawym górnym rogu zbiornika, z potwierdzeniem) i edycja: nazwa, rodzaj, pojemność (z tabliczki znamionowej), `p0` (przepona) albo `k` (poduszka), przełącznik włączony/wyłączony. Przy każdym zbiorniku widać bieżący szacunek, a pod listą sumę,
- **kalkulator wody na cykl** (ikona kalkulatora za szacunkiem, tylko zbiornik z poduszką, bo tylko w nim widać poziom wody): obwód zbiornika i różnica słupa wody między startem a zatrzymaniem pompy [cm], wynik w litrach; „Wstaw” dobiera `k` tak, żeby szacunek zbiornika był równy zmierzonej ilości (punkt 7),
- dane sterownika: nazwa, identyfikator, Root ID i przycisk „Zmień” (popup z nazwą).

Zapis sprawdza wartości przed wysłaniem i pokazuje komunikat, że sterownik pobierze ustawienia przy następnym uruchomieniu pompy.

**Pompa ciepła** działa bez zmian.

**Symulator** do sprawdzania bez płytki: przy uruchomionym `npm run local` polecenie `node scripts/simulate-water-pressure-tank.mjs` zgłasza sterownik, wysyła uruchomienie z kolejki i jedno na żywo (co 1 s). `--fast` skraca uruchomienie na żywo do kilku wiadomości, a `--history` dopisuje do bazy lokalnej uruchomienia z 60 dni.

## 7. Szacowanie wody

Zbiorniki pracują przy tym samym ciśnieniu, więc woda z jednego uruchomienia to suma z **włączonych** zbiorników. Ciśnienia we wzorach są bezwzględne (manometr + 1,013 bar). `p_d` to próg dolny, a `p_g` to próg górny presostatu.

**Zbiornik przeponowy (worek).** Ilość powietrza wyznacza ciśnienie wstępne `p0`:

```text
ΔV = V · p0_abs · (1/p_d_abs − 1/p_g_abs)      (dla p0 ≤ p_d)
ΔV = V · (1 − p0_abs/p_g_abs)                   (dla p_d < p0 < p_g: worek oddaje wodę dopiero od p0)
ΔV = 0                                          (dla p0 ≥ p_g)
```

**Zbiornik z poduszką powietrzną.** Pełna poduszka ze współczynnikiem korekty `k`:

```text
ΔV = k · V · 1,013 · (1/p_d_abs − 1/p_g_abs)
```

**Dane w Ustawieniach:**

| Pole | Zbiornik 1 (poduszka) | Zbiornik 2 (worek) | Skąd wziąć |
|---|---|---|---|
| nazwa | np. „Ocynkowany” | np. „Przeponowy” | dowolna |
| rodzaj | poduszka powietrzna | przeponowy | — |
| pojemność [l] | 300 | 300 | tabliczka znamionowa |
| włączony | tak | tak | wyłączasz po odłączeniu zbiornika |
| ciśnienie wstępne `p0` [bar] | — | np. 1,8 | manometr na zaworze powietrza przy spuszczonej wodzie |
| współczynnik `k` | 1,0 na start | — | kalkulator wody na cykl albo sugestia z wodomierza |

Do tego wspólne progi: **dolny** i **górny** [bar], odczytane z manometru przy starcie i przy zatrzymaniu pompy.

**Kalkulator wody na cykl** (w Ustawieniach, przy zbiorniku z poduszką): z obwodu `C` i różnicy słupa wody `Δh` między startem a zatrzymaniem pompy liczy wodę na cykl `ΔV = C² · Δh / (4π)`. „Wstaw” ustawia `k = ΔV / ΔV(k = 1)` (trzy miejsca po przecinku), więc wzór wyżej daje zmierzoną ilość, a serwer, klient i sterownik liczą dalej tym samym wzorem.

**Przykład** (progi 2 i 4 bar, `p0` = 1,8 bar):
- worek ≈ **112 l**,
- poduszka ≈ **40 l** (`k` = 1),
- razem ≈ **152 l na uruchomienie**.

Przy złych progach (górny nie większy od dolnego) szacunek wynosi 0.

**Kalibracja `k`:**
1. Wpisujesz odczyty wodomierza w *Dane → Wodomierz*.
2. Aplikacja porównuje zużycie z wodomierza (od pierwszego do ostatniego odczytu) z sumą szacunków z tego samego okresu i podpowiada `k = (wodomierz − część przeponowa) / część z poduszki przy k = 1`.
3. `k` dotyczy tylko zbiornika z poduszką, bo worek liczy się z `p0`. Wpisujesz je w Ustawieniach; działa dla nowych uruchomień.

**Ten sam wzór jest w trzech miejscach** i trzeba go zmieniać razem:
- serwer: `estimateWater` w `server/src/modules/water-pressure-tank/services/water-pressure-tank.service.ts` (wartość zapisywana w rekordach),
- aplikacja WWW: `client/src/devices/water-pressure-tank/utils/water.ts` (podgląd w Ustawieniach i na głównym oknie),
- sterownik: `src/settings.cpp` (podgląd na stronie sterownika).

Zgodność serwera z aplikacją sprawdza test serwera, a zgodność sterownika — jego testy `native` z tymi samymi przykładami.

## 8. Historia

- **Szkic `D:\DevLocal\arduino_src\hydrofor\hydrofor.ino`** (do 2026-09): otwarty punkt dostępowy „Piwnica”, impuls kompresora po starcie, czas w EEPROM, strona z polem czasu. Miał usterkę startu opisaną w punkcie 2. Leży nadal w tamtym katalogu (poza gitem).
- **Od 2026-09-28** sterownik to `src/water-pressure-tank.cpp` z logiką w osobnych plikach (punkt 4). Kopia szkicu została usunięta z `devices/water-pressure-tank`.
