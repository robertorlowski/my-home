# Moduł pellet-boiler-pelux200 — zasada działania

[← Dokumentacja systemu](../../README.md) · [1. Opis biznesowy](1-opis-biznesowy.md) · **2. Zasada działania** · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](../../en/moduly/pellet-boiler-pelux200/2-how-it-works.md)

## Schemat

```mermaid
flowchart LR
    ECO["kocioł Pellux 200<br/>regulator ecoMAX<br/>(moduł A)"] -- "RS-485 115200 baud<br/>ramki SensorData,<br/>tylko odbiór" --> CO["sterownik pieca<br/>(ESP32-C3 + HW-519)"]
    CO -- "POST /devices/register<br/>(przy każdym starcie)" --> SRV["My Home"]
    CO -- "POST /pellet-boiler-pelux200/add<br/>co poll_interval_seconds" --> SRV
    SRV -- "{poll_interval_seconds}" --> CO
    SRV --> DB[("MongoDB:<br/>devices,<br/>pellet_boiler_pelux200")]
    WEB["aplikacja WWW"] <--> SRV
```

Działanie sterownika (podłączenie, parser ramek, piny, protokół) opisują [README sterownika](../../../devices/pellet-boiler-pelux200/README.md) i [piec-pellux200.md](../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md). Ten dokument opisuje stronę chmury i aplikacji. Kocioł jest **tylko źródłem danych**: serwer nie ma dla niego schedulera, operacji ani odpowiedzi ze sterowaniem (jedyna wartość odsyłana sterownikowi to odstęp odpytywania).

## Stan etapów

| Etap | Zakres | Stan |
|---|---|---|
| 1 | sterownik pieca odbiera ramki `SensorData` z magistrali kotła i wysyła odczyty do chmury | zaimplementowany; format ramek z PyPlumIO **niezweryfikowany na kotle** |
| 2 | sterownik pieca odpowiada na pytanie regulatora o obecność urządzenia (`CheckDevice`) i nadaje na magistralę, sterowanie kotłem | **niezaimplementowany** |

## Sterownik pieca

Od 2026-10-03 kocioł odczytuje osobny sterownik pieca (płytka ESP32-C3 SuperMini z modułem RS-485 HW-519, `devices/pellet-boiler-pelux200`). Ma własny SN (MAC płytki), więc w chmurze jest zwykłym urządzeniem rodzaju `pellet-boiler-pelux200`. Do 2026-10-02 tę rolę pełnił sterownik `co`: ten sam SN był wtedy w chmurze dwoma urządzeniami (pompa ciepła i kocioł, różne `rootId`). Serwer nadal obsługuje kilka ról jednego SN (opis w [module core](../core/2-zasada-dzialania.md)): rozróżnia je po **ścieżce endpointu** (`controllerPaths` w `device-context`, szukanie po parze `{deviceId, deviceType}`), a `rootId` innej roli daje **409**.

## Zgłoszenie: przy każdym starcie

```mermaid
sequenceDiagram
    participant K as kocioł (ecoMAX)
    participant C as sterownik pieca
    participant R as POST /devices/register
    participant A as POST /pellet-boiler-pelux200/add
    participant M as MongoDB
    C->>R: po połączeniu z Wi-Fi: {deviceId: SN, deviceType: "pellet-boiler-pelux200", name: "Piec Pellux 200", version, ip}
    R->>M: utwórz urządzenie (properties.poll_interval_seconds = 300) albo zwróć istniejące
    R-->>C: {rootId, ..., settings: {poll_interval_seconds}}
    C->>C: zapis rootId i interwału w NVS (przestrzeń pel)
    K->>C: ramki SensorData (ciągle, do panelu)
    loop co poll_interval_seconds
        C->>A: ostatni poprawny odczyt (młodszy niż 60 s)
        A->>M: zapis odczytu
        A-->>C: 201 {poll_interval_seconds}
        C->>C: zapis nowego interwału w NVS
    end
    Note over C,A: nieudana wysyłka: ponowienie po 60 s;<br/>404 lub 409 → sterownik kasuje Root ID i zgłasza się od nowa
```

- Nieudane zgłoszenie sterownik ponawia co 30 s; do skutku nic nie wysyła. Zgłasza się także bez podłączonego kotła (urządzenie jest wtedy bez odczytów).
- Nazwa „Piec Pellux 200” trafia tylko do **nowego** urządzenia; znane urządzenie zachowuje nazwę.
- Sterownik może też wysłać odczyt z samym `deviceId` (bez `rootId`), jeśli urządzenie o tym SN i rodzaju `pellet-boiler-pelux200` już istnieje.

## Zapis odczytu w chmurze

```mermaid
flowchart TD
    B["POST /pellet-boiler-pelux200/add<br/>{state, heating_temp, ..., fan, alarm}"] --> V{"body jest obiektem,<br/>pola liczbowe są liczbami skończonymi,<br/>pola logiczne są boolean,<br/>jest co najmniej jedno pole pomiarowe?"}
    V -- nie --> E400["400: Nieprawidłowy odczyt kotła."]
    V -- tak --> S["zapis do pellet_boiler_pelux200<br/>(rootId, deviceType, deviceId + pola);<br/>czas z zegara serwera"]
    S --> C["ostatni odczyt w pamięci serwera (per rootId)"]
    S --> W["WebSocket: update → przeglądarki"]
    S --> R["odpowiedź 201:<br/>{poll_interval_seconds}"]
```

- Wszystkie pola pomiarowe są opcjonalne: sterownik wysyła to, co udało się odczytać. Jedno pole niewłaściwego typu odrzuca cały odczyt (400).
- Pole `time` i nieznane klucze są **ignorowane**: czas rekordu (`createdAt`) ustawia serwer w chwili przyjęcia.
- Odpowiedź niesie aktualny `poll_interval_seconds`, więc zmiana w aplikacji dociera do sterownika przy następnej wysyłce, bez ponownego zgłoszenia.

## Odstęp odpytywania: aplikacja ↔ sterownik

```mermaid
sequenceDiagram
    participant U as aplikacja (Ustawienia)
    participant S as serwer
    participant C as sterownik
    U->>S: PUT /device/properties {poll_interval_seconds: minuty × 60}
    S->>S: walidacja: pełne sekundy 30–3600 (inaczej 400)
    Note over C: następna wysyłka odczytu
    C->>S: POST /pellet-boiler-pelux200/add
    S-->>C: 201 {poll_interval_seconds: nowa wartość}
    C->>C: zapis w NVS, stosowanie nowego interwału
```

Formularz w aplikacji (karta „Odczyt” w Ustawieniach) przyjmuje pełne sekundy (30–3600; do 2026-10-13 minuty 0,5–60). `PUT /device/properties` podmienia całe `properties`, więc aplikacja wysyła wczytany obiekt z nową wartością pola.

## Ekrany aplikacji

| Ekran | Dane | Odświeżanie |
|---|---|---|
| **Kocioł** (`/`) | `GET /pellet-boiler-pelux200/last`, `GET /device/properties` (interwał do oceny aktualności), ostatni odczyt ustawień (sezon, tryb pracy) | ostatni odczyt co 30 s |
| **Dane** (`/data`) | `GET /pellet-boiler-pelux200/list?date=YYYY-MM-DD`, CSV w przeglądarce | przy wejściu i zmianie daty |
| **Statystyki** (`/chart`) | temperatury dnia z `GET /pellet-boiler-pelux200/list`, spalony pellet | przy zmianie dnia i widoku |
| **Harmonogram** (`/schedules`), **Alarmy** (`/alarms`), **Operacje** (`/operations`) | harmonogram kotła i nastawy trybów, alarmy regulatora, dziennik operacji (strona wspólna `core/pages/Operations`) — opis w CLAUDE.md, punkt 5c | Harmonogram: stan co minutę; Operacje: dziś co 30 s |
| **Ustawienia** (`/settings`) | `GET/PUT /device/properties` (karta „Odczyt”); tryb pracy, główne parametry i ostatnie zmiany (zlecenia parametrów); karty „Sterownik” i „Udostępnianie” z `core` ze stanem firmware: `GET /devices`, `GET /firmware/pellet-boiler-pelux200`, `POST`/`DELETE /devices/:rootId/firmware-update` („Aktualizuj firmware” / „Anuluj aktualizację”; sterownik od 1.5.0 dostaje ofertę w odpowiedzi `commands/next` w ciągu ok. 15 s) | przy wejściu; karta „Sterownik” co 15 s, gdy czeka zlecenie aktualizacji |

- **Aktualność danych.** Odczyt jest nieaktualny, gdy jest starszy niż `3 × poll_interval_seconds` (albo nie ma czasu): wtedy na górze widoku jest czerwony pasek „Offline od …” (`OfflineBanner` z `core`). Domyślny interwał do oceny to 300 s, dopóki właściwości nie zostaną wczytane.
- **Stan alarmu.** Chip stanu w karcie hero i karta „Urządzenia kotła” pokazują alarm regulatora, gdy `alarm` jest `true` albo `state` = 8 (Alarm); zakładka Alarmy ma listę aktywnych i historię.
- **Brak danych.** Odpowiedź `{}` z `/last` daje komunikat „Brak danych od sterownika”.
- Ścieżki spoza menu kotła (np. `/hp`) przekierowują na `/`.
