# Propozycja: dostęp do QNAP-a przez sterownik `co` (2026-11-13)

[← Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [README](../README.md)

**Stan (2026-11-13): po decyzji właściciela zrobiono tylko część, i to inaczej, niż opisuje ta propozycja.**

- **Decyzja właściciela** („ad 1 zrób”): tylko polecenia; bez stanu QNAP-a w `hp/add` i na razie bez wariantów sprzętowych.
- **Zrobione próbnie** (serwer i `co` 1.4.0, 2026-11-13; wdrożenie na produkcji czeka): trzy polecenia `stan`, `restart_sieci`, `restart`, wysyłane tylko poleceniem `--qnap` na serwerze (bez karty i przycisku w aplikacji). Polecenie jedzie istniejącym WebSocketem `co` (`{"typ":"qnap"}` → `POST` do usługi na QNAP-ie → `{"typ":"qnap_wynik"}`), a nie w odpowiedzi i telemetrii `hp/add` jak w wariancie B niżej. Adres QNAP-a jest ustawieniem serwera (`QNAP_ADRES`), a nie polem na stronie `/install`. Opis: [dokumentacja techniczna `co`](3-dokumentacja-techniczna.md#polecenia-dla-qnap-a-od-140-próbnie) i CLAUDE.md, punkt 13; umowa z usługą na QNAP-ie: prywatne repozytorium `oracle-cloud`, `qnap/polecenia-przez-co.md`. Ok. 2026-12-13 sprawdzamy użycie; bez niego całość usuwamy.
- **Niezrobione:** wariant A (podgląd w `hp/add`, karta „QNAP”, powiadomienie), z wariantu B polecenia `restart-tunelu` i `wylacz` oraz droga przez `hp/add`, Wake-on-LAN, warianty C (SSH), D (przycisk), E (przekaźnik w zasilaniu) i F (łącze szeregowe), zmiany kontraktu z tabeli niżej (poza samym poleceniem `--qnap`) i adres oraz MAC na `/install`.

Reszta dokumentu to propozycja z 2026-11-13, zostawiona jako historia. Pierwotne polecenie właściciela: w zamian za usuniętą pogodę i pocztę (`co` 1.4.0) wymyślić, jak przez sterownik dostać się do QNAP-a w sieci domowej i np. go zrestartować.

## Po co

QNAP (Debian) stoi w sieci domowej za routerem, do którego nie ma dostępu. Z zewnątrz da się do niego wejść tylko tunelem, który QNAP sam zestawia do serwera. 13.11.2026 po zaniku prądu karta sieciowa QNAP-a przez 2,5 h nie złapała łącza z routerem i pomogło dopiero wyłączenie i włączenie przyciskiem na obudowie.

Część przypadków QNAP obsługuje już sam:

- zawieszony system: sprzętowy watchdog robi twardy restart po 60 s;
- brak sieci albo tunelu: strażnik sieci restartuje tunel, sieć i sterownik karty, a po 30 min cały system (najwyżej raz na 6 h);
- nieudany start: system ratunkowy.

Sterownik `co` ma własne, niezależne od tunelu połączenie z serwerem i jest w tej samej sieci domowej. Może więc pomóc tam, gdzie QNAP sam sobie nie poradzi:

| Przypadek | Dziś | Co może dodać `co` |
|---|---|---|
| QNAP i sieć domowa działają, tunel nie | brak wejścia i brak informacji, co się dzieje | stan QNAP-a widziany z sieci domowej, polecenia, SSH przez sterownik |
| QNAP działa, ale nie ma łącza (13.11) | ktoś musi nacisnąć przycisk | zimny restart: przycisk albo odcięcie zasilania sterowane z `co` |
| QNAP wyłączony | ktoś musi go włączyć | Wake-on-LAN, przycisk albo odcięcie i przywrócenie zasilania |

## Co ma `co` do dyspozycji

- Stałe połączenie z serwerem (HTTPS `hp/add` co 10–30 s i WebSocket), niezależne od tunelu QNAP-a. Warunek: `co` i QNAP w tej samej sieci domowej (do sprawdzenia: adres IP `co` w karcie „Sterownik”).
- Wolne wyprowadzenia: GPIO25 i GPIO26 (dawne przekaźniki CO / CWU, wolne od 1.2.0) oraz UART2 (dawna magistrala pieca, wolna od 2026-10-03; piny do ustalenia na płytce).
- Miejsce po 1.4.0: ok. 37 KB pamięci programu i 16 KB stosu po zadaniu przekaźnika poczty.
- Ograniczenie: główną pracą `co` jest pompa ciepła. Wszystko, co blokuje pętlę (połączenie z QNAP-em), działa tylko przy wolnej magistrali RS-485 i z krótkim limitem czasu, jak dawniej pogoda. Dłuższa praca (most SSH) idzie we własnym zadaniu FreeRTOS, jak dawniej poczta.

## Warianty

| | Wariant | Pomaga, gdy | Potrzebne | Nakład |
|---|---|---|---|---|
| A | podgląd QNAP-a z sieci domowej | tunel nie działa (wiadomo, czy QNAP żyje) | kod `co`, serwera i aplikacji | mały |
| B | polecenia przez agenta na QNAP-ie + Wake-on-LAN | tunel nie działa; QNAP wyłączony | jak A + mała usługa na QNAP-ie | średni |
| C | SSH przez `co` | tunel nie działa, a trzeba wejść do systemu | jak A + most w serwerze i skrypt klienta | duży |
| D | przycisk zasilania sterowany z `co` | brak łącza (13.11), QNAP wyłączony | przewód od `co` do QNAP-a, transoptor, otwarcie obudowy | średni |
| E | odcięcie zasilania przekaźnikiem | jak D, także gdy nic nie odpowiada | przekaźnik w przewodzie zasilacza | mały |
| F | łącze szeregowe `co` – QNAP | brak łącza: stan i polecenia bez sieci | przewód, przejściówka USB–UART lub USB–RS-485 | średni |

### A. Podgląd z sieci domowej (niezrobione)

- `co` co 60 s (przy wolnej magistrali) próbuje połączyć się z portem SSH QNAP-a, z limitem 1 s, bez logowania. Wynik idzie w telemetrii `hp/add`: `qnap {ok, ms, since_s}`.
- Serwer trzyma stan w pamięci. Konto `system` widzi kartę „QNAP”, a powiadomienie Web Push przychodzi, gdy QNAP nie odpowiada w sieci domowej od 15 min, a `co` działa, czyli dom ma prąd i internet.
- Razem ze stanem tunelu widać, co się zepsuło:
  - `co` milczy: w domu nie ma prądu albo internetu;
  - `co` jest, QNAP nie odpowiada: QNAP albo jego sieć;
  - QNAP odpowiada w domu, a tunelu nie ma: tunel albo serwer.

### B. Polecenia przez agenta na QNAP-ie (zrobione częściowo i inaczej, „Stan” wyżej)

- **Agent na QNAP-ie:** mała usługa (Python, jak strażnik sieci), słucha tylko w sieci domowej. Zna stałą listę poleceń, bez dowolnych komend powłoki:
  - `stan`: łącze, adresy, tunel, czas pracy, stan puli ZFS;
  - `restart-tunelu`;
  - `restart-sieci`: kroki strażnika;
  - `restart`: najwcześniej 35 min po starcie, najwyżej raz na godzinę;
  - `wylacz`.
- **Droga polecenia:**
  1. Konto `system` w aplikacji wybiera polecenie i je potwierdza; trafia ono do dziennika operacji.
  2. Serwer podpisuje je (HMAC-SHA256: id, polecenie, ważność 2 min) kluczem znanym tylko serwerowi i agentowi.
  3. Polecenie jedzie w najbliższej odpowiedzi `hp/add`; komunikat WebSocket `operation` ją przyspiesza.
  4. `co` przekazuje je do agenta zwykłym POST-em w sieci domowej.
  5. Podpisany wynik wraca w następnym `hp/add`.
- **Klucz i podpis:** `co` klucza nie zna. Jest tylko przewoźnikiem, więc ani przejęty sterownik, ani ktoś w sieci domowej nie podrobi polecenia ani wyniku. Agent odrzuca zły podpis, polecenie przeterminowane i id użyte drugi raz.
- **Wake-on-LAN:** `co` wysyła pakiet budzący na adres MAC QNAP-a i włącza wyłączony system. Do sprawdzenia: opcja w BIOS-ie, `ethtool` (karta musi mieć `Wake-on: g`) i ustawienie `wol` na obu portach łącza.

### C. SSH przez `co` (niezrobione)

- **Zestawienie:** na polecenie konta `system` serwer wysyła do `co` komunikat WebSocket. `co` otwiera połączenie TCP z portem 22 QNAP-a i drugi WebSocket do serwera. Serwer łączy je z gniazdem klienta.
- **Szyfrowanie i logowanie:** SSH szyfruje całą rozmowę od końca do końca, więc `co` i serwer widzą tylko zaszyfrowane bajty. Logowanie jak zwykle, kluczem.
- **Klient:** np. `ssh -o ProxyCommand="node qnap-most.mjs" <konto>@qnap`; przez ten sam most działa też przekierowanie Cockpita (`-L 9090:localhost:9090`).
- **Ograniczenia:** jedno połączenie naraz, zamknięcie po 15 min bez ruchu. Przepustowość ESP32 przez Wi-Fi wystarczy na terminal, nie na kopiowanie plików.

### D. Przycisk zasilania sterowany z `co` (niezrobione)

- **Połączenie:** transoptor (np. PC817) równolegle do styków przycisku zasilania QNAP-a. Jego diodą steruje GPIO25 albo GPIO26 przez rezystor ok. 330 Ω. Transoptor siedzi przy QNAP-ie, a do `co` biegnie dwużyłowy przewód, więc długi przewód nie wisi na wejściu płyty głównej.
- **Ochrona przed przypadkowym naciśnięciem:** rezystor ściągający na GPIO, żeby restart i aktualizacja `co` niczego nie naciskały.
- **Polecenia:**
  - krótkie naciśnięcie (0,5 s): włącza QNAP-a albo zamyka system, bo systemd-logind traktuje przycisk jak polecenie wyłączenia;
  - przytrzymanie 6 s: wymuszone wyłączenie;
  - restart na zimno: przytrzymanie 6 s, przerwa 20 s, krótkie naciśnięcie. To samo pomogło 13.11.
- **Odstępy i tryb:** `co` pilnuje odstępów (np. najwyżej raz na 10 min) i działa niezależnie od trybu pompy.
- **Wymagania:**
  - otwarcie obudowy QNAP-a: przewody do przycisku albo do złącza panelu;
  - przewód od `co` do QNAP-a: `co` jest zamontowany przy pompie ciepła.

### E. Odcięcie zasilania przekaźnikiem (niezrobione)

- **Połączenie:** przekaźnik na styku NC w przewodzie zasilacza QNAP-a. Po 30–60 s bez prądu QNAP startuje sam, bo BIOS ma „Restore on AC Power Loss”. Najpewniej jest to ustawione, bo 13.11 QNAP wstał sam po zaniku prądu; do potwierdzenia.
- **Sterowanie z `co`:** moduł przekaźnika na GPIO25/26, kod jak w D.
- **Sterowanie osobnym włącznikiem my-home, bez zmian w kodzie:**
  - przekaźnik na NC, więc „Włącz na 1 min” w aplikacji daje minutę bez prądu;
  - potem zasilanie wraca samo, bo licznik działa na płytce, także bez internetu;
  - restart płytki zostawia przekaźnik wyłączony, czyli QNAP z prądem.
- **Wady:**
  - twarde wyłączenie w trakcie zapisu; ZFS i RAID1 to zniosą, ale to ostateczność;
  - odwrócone znaczenie „włączony” w aplikacji;
  - na tym przekaźniku nie może być harmonogramu.

### F. Łącze szeregowe (niezrobione)

- **Połączenie:** przejściówka USB–UART w porcie USB QNAP-a, połączona z UART2 `co`. Przy dłuższym przewodzie USB–RS-485 i moduł RS-485 przy `co`, do ok. 1 km.
- **Agent:** ten sam co w B, słucha też na porcie szeregowym. Stan i polecenia działają bez sieci: 13.11 byłoby widać „brak łącza” i dałoby się zrestartować sieć, sterownik karty albo system.
- **Przewód:** jak w D.

## Rekomendacja

*Historia: z etapu 1 zrobiono tylko polecenia, w `co` 1.4.0 (nie 1.5.0) i bez karty w aplikacji; etap 2 i resztę odłożono.*

1. **Etap 1, sam kod:** A + B + Wake-on-LAN.
   - Daje stan QNAP-a i polecenia, gdy nie działa tunel, oraz włączenie wyłączonego QNAP-a.
   - Zmiany: `co` 1.5.0, serwer, aplikacja (karta „QNAP” konta `system`) i agent na QNAP-ie.
2. **Etap 2, sprzęt:** D albo E. Tylko to rozwiązuje przypadek z 13.11, bo przy braku łącza sieć domowa nic nie da.
   - D: czyste wyłączanie, wymaga otwarcia obudowy;
   - E: prostsze, ale twarde.
   - Jeśli jest wolna płytka włącznika, E z włącznikiem działa od razu, bez zmian w kodzie.
3. **Według potrzeby:** C, gdy stałe polecenia nie wystarczą, i F, gdy przewód do QNAP-a i tak powstanie.

## Bezpieczeństwo

- **Kto zleca:** polecenia zleca tylko konto `system`, z potwierdzeniem i wpisem w dzienniku operacji. Limity są w serwerze, w `co` i w agencie.
- **Podpis:** polecenia podpisuje serwer, a sprawdza je agent. `co` nie zna klucza, a klucz nie trafia do `app_settings` ani do bazy, tylko do środowiska serwera (jak `LOGOWANIE_KLUCZ`) i do pliku roota na QNAP-ie.
- **Adres QNAP-a:** adres i MAC wpisuje się lokalnie na stronie `/install` `co`. Puste pole wyłącza funkcję, więc serwer nie może skierować sterownika na inne urządzenia w sieci domowej, a inne instalacje my-home niczego nie robią.
- **Most SSH:** stały cel (port 22 z adresu z `/install`), jednorazowe id, zamknięcie po bezczynności.
- **Przycisk i przekaźnik:** bezpieczny stan przy starcie `co`. Restart na zimno tylko po potwierdzeniu; samoczynny tylko po osobnej decyzji (niżej).

## Zmiany kontraktu (przy wdrożeniu)

*Historia: ta tabela nie obowiązuje. Zrobiony kontrakt (WebSocket `qnap` / `qnap_wynik`, `POST /api/qnap/polecenia` tylko z tokenem wewnętrznym, polecenie `--qnap`) opisuje [dokumentacja techniczna `co`](3-dokumentacja-techniczna.md#polecenia-dla-qnap-a-od-140-próbnie).*

Zgodnie z zasadą „zmiana pola obejmuje serwer, klienta i firmware, wdrożenie od serwera”:

| Część | Zmiana |
|---|---|
| telemetria `hp/add` | `qnap {ok, ms, since_s}` (A), `qnap_wynik {id, kod, dane, podpis}` (B) |
| odpowiedź `hp/add` | `qnap_cmd {id, akcja, waznyDo, podpis}` (B), `qnap_przycisk {id, akcja}` (D/E) |
| WebSocket | `{type:"qnap_most", id}` (C) |
| serwer | `GET /api/qnap`, `POST /api/qnap/polecenie` (konto `system`), most `/api/qnap/most` (C), polecenie serwera `--qnap <polecenie>` (jak `--api`) |
| aplikacja | karta „QNAP” dla konta `system`: stan, polecenia z potwierdzeniem |
| `co` | `/install`: adres i MAC QNAP-a; GPIO25/26 dla przycisku lub przekaźnika; most w osobnym zadaniu |
| QNAP | usługa agenta i plik klucza; skrypty obok strażnika sieci |

## Jak korzystałbym z tego ja (Claude)

*Historia: zrobione są polecenia `--qnap stan`, `--qnap restart_sieci` i `--qnap restart` (`docker exec my-home-prod node dist/server.js …`); `restart-tunelu`, most SSH i zimny restart nie istnieją.*

- **Polecenia:** z laptopa przez `ssh vm-prod` i polecenie serwera `--qnap stan` albo `--qnap restart-tunelu` w kontenerze my-home. vm-prod jest wtedy osiągalny, bo zepsuty jest tylko tunel QNAP-a. Polecenie idzie przez `co` i wraca z wynikiem agenta.
- **Wejście do systemu:** SSH przez most (C).
- **Zimny restart:** przycisk albo przekaźnik (D/E) tym samym poleceniem, zawsze po zgodzie właściciela.

## Testy

- `co`: testy `native` dla odczytu poleceń, kolejności kroków przycisku i limitów.
- Serwer: podpis, ważność, powtórzone id, uprawnienia konta `system`.
- Agent: testy decyzji z opcją `--test`, jak strażnik.
- Na żywo:
  - `stan` i `restart-tunelu`;
  - Wake-on-LAN po `poweroff`;
  - krótkie naciśnięcie (czyste wyłączenie), potem włączenie;
  - restart na zimno.

## Do decyzji właściciela

*Rozstrzygnięte 2026-11-13: tylko stałe polecenia, bez SSH (pytanie 5); warianty sprzętowe na razie odłożone (pytania 1–4).*

1. Gdzie stoi QNAP względem `co` (pompy ciepła): jak długi byłby przewód? Od tego zależy, czy D, E i F robić z `co`, czy z osobną płytką przy QNAP-ie.
2. Przycisk (D, otwarcie obudowy) czy przekaźnik w zasilaniu (E)?
3. Czy jest wolna płytka włącznika do E bez zmian w kodzie?
4. Zimny restart tylko ręcznie, czy także samoczynnie? Np. gdy QNAP jest niewidoczny z sieci domowej od 30 min przy działającym `co`, najwyżej raz na 6 h, jak strażnik.
5. Czy potrzebne jest SSH przez `co` (C), czy wystarczą stałe polecenia (B)?
