# Firmware włącznika — zasada działania

[← Dokumentacja systemu](../../../docs/README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · **2. Zasada działania** · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](en/2-how-it-works.md)

## Start sterownika

```mermaid
sequenceDiagram
    participant E as ESP32
    participant S as My Home
    E->>E: piny przekaźników = „wyłączony”, dopiero potem OUTPUT
    E->>E: NVS „sw”: Wi-Fi, Root ID, domyślny czas włączenia
    E->>E: AP MyHome-Switch-XXXX (10.10.10.1) + Wi-Fi STA, strony WWW
    Note over E: przekaźniki wyłączone, tryb „nieznany”
    E->>S: POST /devices/register {deviceId, deviceType: switch, name, version, ip, relays}
    S-->>E: {rootId, settings: {default_on_minutes, firmware?}}
    E->>S: WebSocket /ws?rootId=
    loop co 5 s (albo od razu po zmianie)
        E->>S: POST /switch/state {uptimeS, relays: [{on, changedS}]}
        S-->>E: {relays: [{on, offAfterS?, mode}], firmware?}
        E->>E: przekaźniki według poleceń
    end
```

- **Przekaźnik po starcie jest wyłączony.** Pin dostaje stan „wyłączony” przed przełączeniem na wyjście; włączy go dopiero polecenie chmury.
- **Bez zgłoszenia nie ma wymiany stanu.** Nieudane zgłoszenie jest ponawiane co 30 s; do tego czasu działa tylko strona sterownika.
- **Zgłoszenie jest raz na start** (i ponownie po 404/409). Domyślny czas włączenia dociera więc przy starcie. Oferta OTA (tylko na zlecenie „Aktualizuj” z aplikacji) jest w odpowiedzi na zgłoszenie i, od wersji 1.1.0, na każdą wymianę stanu.

## Polecenia z chmury

Odpowiedź na każde zgłoszenie stanu niesie dla każdego przekaźnika `on`, ewentualnie `offAfterS` i `mode`:

| Polecenie | Co robi sterownik |
|---|---|
| `{on: true, offAfterS: N}` | włącza (jeśli był wyłączony) i ustawia wyłączenie za N s; każde kolejne polecenie przelicza ten czas od nowa |
| `{on: true}` | włącza bez limitu |
| `{on: false}` | wyłącza |
| `mode` | tylko do wyświetlenia na stronie sterownika |

**Odliczanie** jest sprawdzane w każdym obiegu pętli, niezależnie od sieci. Po jego końcu sterownik wyłącza przekaźnik, tryb na stronie zmienia się z „On for a set time” na „Schedule” i od razu wysyła nowy stan do chmury.

Komunikat WebSocket `{"type":"operation"}` (zmiana trybu albo harmonogramu w aplikacji) powoduje zgłoszenie stanu od razu, więc zmiana z aplikacji działa w ciągu sekundy. Biblioteka WebSocket sama łączy się ponownie co 10 s po zerwaniu.

## Zmiana ze strony sterownika

```mermaid
sequenceDiagram
    participant P as strona / (telefon)
    participant E as ESP32
    participant S as My Home
    P->>E: POST /relay?n=1&mode=timer&minutes=30
    E->>E: przekaźnik od razu; pending (numer zmiany)
    E->>S: PUT /switch/mode {relay, mode, minutes, source: controller}
    alt 2xx albo 400
        S-->>E: OK → pending skasowane
    else błąd sieci / 5xx
        E->>E: ponowienie co 5 s
    end
    E->>S: POST /switch/state
    S-->>E: polecenie zgodne z nowym trybem
```

- **Do potwierdzenia zmiany polecenia chmury dla tego przekaźnika są pomijane** (`pending`), żeby odpowiedź wyliczona ze starego trybu nie cofnęła zmiany. Każda zmiana ma numer (`pendingSeq`): potwierdzenie starszej wysyłki nie kasuje nowszej zmiany.
- **„Turn on” na czas** wysyła do chmury minuty, które zostały (zaokrąglone w górę, co najmniej 1), więc ponowiona wysyłka nie wydłuża włączenia.
- **„Schedule”** z chmurą zostawia stan do najbliższej odpowiedzi (chmura zna okna). **Bez chmury** (brak udanej wymiany od 30 s) wyłącza przekaźnik, bo sterownik nie wie, czy okno trwa.
- **400** z chmury oznacza, że zmiana nie zostanie przyjęta; sterownik przestaje ją ponawiać.
- **404/409** (nieznany SN, Root ID innego urządzenia): sterownik kasuje Root ID, rozłącza WebSocket i zgłasza się ponownie.

## Pętla

W każdym obiegu `loop()`: strony WWW, WebSocket i odliczanie przekaźników. Co 1 s (albo od razu, gdy jest coś do wysłania) `tick()`:

1. Punkt dostępowy: wyłączenie po 1 min połączenia z Wi-Fi, włączenie po 1 min bez Wi-Fi.
2. Co 30 s linia stanu na konsoli.
3. Naprawa łączności, gdy serwer nie odpowiada od 2 min (sekcja niżej).
4. Bez Wi-Fi — koniec.
5. Brak zgłoszenia w tym starcie → `POST devices/register` (co 30 s do skutku); bez zgłoszenia — koniec.
6. Niewysłane zmiany lokalne → `PUT switch/mode` (co 5 s albo od razu).
7. Wymiana stanu co 5 s albo od razu po zmianie.
8. OTA: gdy jest oferta (zlecenie z aplikacji), chmura odpowiada, wszystkie przekaźniki są wyłączone i nie ma niewysłanych zmian; jedna próba na zlecenie.

Połączenie HTTPS jest jedno i stałe (keep-alive), limit zapytania 4 s, zgłoszenia 8 s. Nieudana wymiana stanu nie jest ponawiana — za 5 s idzie nowa.

## Czasy w zgłoszeniu stanu

Sterownik nie ma zegara. Podaje `uptimeS` (sekundy od startu) i przy każdym przekaźniku `changedS` (od ilu sekund jest w obecnym stanie). Serwer liczy z tego chwilę włączenia i wyłączenia (`teraz − changedS`), także po przerwie w łączności, a po `uptimeS` rozpoznaje restart: włączenie przerwane utratą zasilania kończy na ostatnim zgłoszeniu przed nią ([moduł switch](../../../docs/moduly/switch/2-zasada-dzialania.md#historia-włączeń)).

## Punkt dostępowy

```mermaid
stateDiagram-v2
    [*] --> Włączony: start (AP + STA)
    Włączony --> Wyłączony: Wi-Fi połączone od 1 min
    Wyłączony --> Włączony: Wi-Fi rozłączone od 1 min
```

AP `MyHome-Switch-XXXX` jest domyślnie otwarty (hasło krótsze niż 8 znaków albo puste). Nie działa stale, bo strona `/` pozwala przełączać przekaźnik bez logowania. Minuta po połączeniu wystarcza, żeby telefon zobaczył wynik zapisu Wi-Fi na `/install`. Przy wyłączonym AP strony są pod adresem IP sterownika w sieci domowej.

## Naprawa łączności

Od 1.3.7 (`net_recovery.hpp`). Czas braku łączności liczy się od ostatniej odpowiedzi HTTP serwera, dowolnej, także z błędem, bo odpowiedź oznacza, że sieć działa. Przed pierwszą odpowiedzią liczy się od startu płytki. Kroki są wykonywane kolejno:

| Brak odpowiedzi | Krok |
|---|---|
| 2 min | zamknięcie stałego połączenia z serwerem; następne zapytanie otwiera nowe |
| 5 min, potem co 5 min | rozłączenie z routerem i ponowne łączenie z Wi-Fi (nowy adres z DHCP) |
| 15 min | restart płytki, tylko gdy wszystkie przekaźniki są wyłączone i nie ma niewysłanych zmian |

- Restart wyłącza przekaźniki, a bez chmury nikt nie przywróci ich stanu. Przy włączonym przekaźniku płytka nie restartuje się, tylko dalej co 5 min łączy się z routerem od nowa.
- Przed restartem płytka zapisuje w NVS `net_rst`. Po takim starcie wysyła przyczynę `no_cloud`, a kolejny restart następuje dopiero po 60 min bez łączności. Pierwsza odpowiedź serwera kasuje `net_rst`.
- Bez zapisanej sieci Wi-Fi i wtedy, gdy ktoś jest połączony z AP płytki (konfiguracja na `/install`), kroki nie są wykonywane.
- W zgłoszeniu stanu `diag.net` podaje liczbę nowych połączeń (`http`) i ponownych łączeń z Wi-Fi (`wifi`) od startu. Serwer dopisuje je do wpisu „Restart sterownika” w dzienniku operacji.
- Zablokowanego routera sterownik nie odblokuje. Kroki pomagają, gdy zawiesiło się połączenie po stronie płytki.

## Aktualizacja przez sieć (OTA)

```mermaid
flowchart TD
    A["„Aktualizuj” w aplikacji<br/>(zlecenie firmwareUpdate)"] --> R["zgłoszenie albo wymiana stanu:<br/>firmware {version, url, sha256, request}"]
    R --> C{"chmura odpowiada,<br/>przekaźniki wyłączone,<br/>brak zmian lokalnych?"}
    C -- nie --> W["czeka (sprawdza co 1 s)"] --> C
    C -- tak --> V{"wersja ≠ FW_VERSION,<br/>klucz wersja#request ≠ ota_tried<br/>i nie próbowany w tym starcie?"}
    V -- nie --> X["koniec do nowego zlecenia"]
    V -- tak --> D["pobranie do nieaktywnej partycji,<br/>SHA-256 w locie"]
    D -- "suma zgodna" --> B["ota_tried = wersja#request, restart"]
    D -- "błąd" --> X
```

- **Oferta przychodzi tylko na zlecenie.** Chmura wysyła `firmware` wyłącznie wtedy, gdy w aplikacji kliknięto „Aktualizuj” (Ustawienia, karta „Sterownik”) i zlecenie nie zostało anulowane. Zlecenie znika samo, gdy sterownik zgłosi się z oferowaną wersją.
- **Od 1.1.0 bez restartu:** oferta jest też w każdej odpowiedzi na `POST /switch/state`, więc aktualizacja startuje w ciągu kilku sekund od kliknięcia (przy wyłączonych przekaźnikach). Wersja 1.0.3 czyta ofertę tylko przy zgłoszeniu, więc potrzebuje restartu płytki.
- Pobieranie blokuje pętlę na kilkanaście sekund, a restart wyłącza przekaźniki, dlatego sterownik czeka, aż wszystkie przekaźniki będą wyłączone. Po restarcie stan przywraca chmura.
- **Jedna próba na zlecenie.** Klucz `wersja#request` (`otaKey()`) jest pamiętany w RAM po próbie i w NVS (`ota_tried`) po pobraniu. Nieudane pobranie czeka na ponowne „Aktualizuj” (nowe zlecenie = nowa próba). `ota_tried` chroni też przed pętlą, gdy ktoś wgra obraz bez podniesienia `FW_VERSION`.

## Ustawienia

| Źródło | Kiedy | Co |
|---|---|---|
| chmura (odpowiedź na zgłoszenie) | start | `default_on_minutes` (0–10080) → NVS `def_min`; wartość domyślna pól „On time” na stronie |
| `/install` | od razu | Wi-Fi → NVS (zapis łączy od razu, bez restartu) |

Złe `default_on_minutes` (spoza 0–10080) jest pomijane i zostaje poprzednia wartość.
