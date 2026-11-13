# Propozycja: uwierzytelnienie sterowników (2026-11-13)

**Stan: propozycja, czeka na decyzję właściciela.** Niczego jeszcze nie zmieniono.

## Jak jest dziś

- **Połączenie jest szyfrowane.** Sterownik łączy się z serwerem przez HTTPS i WSS (`CLOUD_HOST`, port 443), więc nikt po drodze nie podejrzy danych. Włącznik może też łączyć się bez TLS, gdy tak go ustawiono.
- **Endpointy HTTP sterownika przyjmują sam numer seryjny.** Sterownik wysyła `?deviceId=<SN>`, bez klucza i hasła. Dotyczy to wszystkich ścieżek z `controllerPaths` (`core/middleware/device-context.ts`):
  - `/hp/add` i `/pv/add`;
  - `/switch/state` i `/switch/mode`;
  - `/water-pressure-tank/add` i `/water-pressure-tank/settings`;
  - `/pellet-boiler-pelux200/add`, `/settings`, `/alerts`, `/commands/next` i `/commands/result`.
- **WebSocket przyjmuje każdego** (`core/websocket.ts`):
  - sterownik przedstawia się tylko Root ID w adresie (`/ws?rootId=…`) i powitaniem `ESP32`;
  - serwer nie sprawdza klucza ani tego, czy taki sterownik istnieje;
  - przeglądarka też łączy się z gniazdem bez sprawdzenia zalogowania.
- **Kto zna te identyfikatory:**
  - numer seryjny widać na stronie ustawień sterownika, a jego końcówkę w nazwie sieci sterownika (`MyHome-HeatPump-XXXX` i podobne);
  - Root ID znają zalogowani użytkownicy i domownicy, bo pada w adresach, które wywołuje aplikacja;
  - w publicznej dokumentacji ich nie ma, bo zrzuty mają zmyślone identyfikatory.

## Co mógłby zrobić ktoś, kto je zna

- Wysłać fałszywe odczyty, np. temperatury, na podstawie których serwer steruje pompą.
- Podać fałszywy stan włącznika.
- Przechwycić albo fałszywie potwierdzić zlecenie zmiany parametrów pieca (`commands/next`, `commands/result`).
- Podsłuchiwać przez gniazdo krótkie powiadomienia (`update`, `operation`). Same w sobie nie niosą danych, tylko rodzaj i Root ID.
- Odebrać podpisane polecenie dla QNAP-a (`qnap`). Nie zmieni go jednak bez klucza, a QNAP odrzuca polecenie stare albo powtórzone.

**Ocena:** ryzyko jest małe, bo trzeba znać numer seryjny albo Root ID, ale to realna luka.

## Propozycja

1. **Własny klucz każdego sterownika.**
   - Serwer losuje 32 bajty przy rejestracji (`POST /devices/register`) i oddaje klucz sterownikowi jeden raz.
   - Sterownik zapisuje klucz w NVS.
   - Serwer trzyma tylko skrót klucza (SHA-256), nie sam klucz.
2. **Klucz w każdym żądaniu sterownika.**
   - Każde żądanie HTTP sterownika i każde połączenie gniazda ze sterownika niesie klucz w nagłówku `Authorization: Bearer <klucz>`.
   - Bez ważnego klucza serwer odpowiada 401, a gniazdo zamyka.
   - Klucz nie trafia do adresu ani do dzienników.
3. **Gniazdo dla przeglądarek tylko dla zalogowanych.** Serwer sprawdza sesję z ciasteczka przy połączeniu i wpuszcza tylko do sterowników, do których dana osoba ma dostęp (właściciel albo domownik).
4. **Okres przejściowy.**
   - **Krok 1, serwer w trybie łagodnym:** przyjmuje sterowniki bez klucza tak jak dziś i każdemu zarejestrowanemu, który się zgłosi, wydaje klucz.
   - **Krok 2, nowy firmware:** zapisuje klucz i wysyła go z każdym żądaniem.
   - **Krok 3, tryb ścisły:** w aplikacji widać, które sterowniki mają już klucz. Gdy mają go wszystkie, serwer przechodzi w tryb ścisły, tylko na polecenie właściciela.
5. **Odnowienie klucza.**
   - Gdy sterownik straci pamięć (reset, wymiana płytki), w ustawieniach sterownika w aplikacji jest przycisk „Odnów klucz”.
   - Przycisk otwiera na 15 minut możliwość ponownej rejestracji tego numeru seryjnego. Stary klucz przestaje wtedy działać.

## Zakres i koszt

- **Serwer:** sprawdzanie klucza w `device-context` i w `websocket.ts`, wydawanie i odnawianie klucza, sesja w gnieździe przeglądarki, testy.
- **Firmware:** wszystkie rodzaje sterowników (pompa `co`, włącznik, piec, hydrofor): zapis klucza, nagłówek w żądaniach i w gnieździe, testy `native`.
- **Klient:** znacznik „ma klucz” i przycisk „Odnów klucz” w ustawieniach sterownika.
- **Kolejność wdrożenia:** serwer przed firmware (patrz „Wdrożenie” w `3-dokumentacja-techniczna.md`).
- **Koszt:** ok. 4–6 godzin pracy.

## Co zrobi właściciel

- Kliknie „Aktualizuj” na każdym sterowniku.
- Powie, kiedy przełączyć serwer w tryb ścisły.

## Na co to nie wpływa

Aplikacja dla użytkowników działa tak samo. Polecenia dla QNAP-a też działają tak samo, bo mają własny podpis.
