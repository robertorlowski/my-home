# Moduł pellet-boiler-pelux200 — opis biznesowy

[← Dokumentacja systemu](../../README.md) · **1. Opis biznesowy** · [2. Zasada działania](2-zasada-dzialania.md) · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](../../en/moduly/pellet-boiler-pelux200/1-business-description.md)

## Po co jest ten moduł

Moduł obsługuje w aplikacji **kocioł pelletowy Plum Pellux 200 Touch** z regulatorem ecoMAX. Pokazuje w aplikacji to, co kocioł „wie o sobie”: stan pracy, temperatury, poziom paliwa, moc i stany wyjść (wentylator, podajnik, pompy, zapalarka, alarm), a każdy odczyt zapisuje w historii.

Kocioł nie ma własnego modułu internetowego, dlatego dane pobiera osobny **sterownik pieca**: płytka ESP32-C3 SuperMini z modułem RS-485 HW-519 ([devices/pellet-boiler-pelux200](../../../devices/pellet-boiler-pelux200/README.md)). Podsłuchuje on łącze, którym regulator ecoMAX rozmawia ze swoim panelem dotykowym, i wysyła do chmury ostatni odczyt co kilka minut. Do 2026-10-02 robił to sterownik `co` (pompy ciepła) jako swoją drugą rolę; od 2026-10-03 kocioł ma własny sterownik, a moduł w aplikacji się nie zmienił.

Moduł pozwala:

- **zobaczyć bieżący stan kotła** — także z telefonu, bez podchodzenia do panelu;
- **przejrzeć odczyty z wybranego dnia** i pobrać je jako plik CSV;
- **ustawić, jak często sterownik odczytuje kocioł** (od pół minuty do godziny; domyślnie co 5 minut);
- **kafelek prosty** (2026-10-21, dla osoby, która ma tylko włączać i wyłączać piec): na liście sterowników chip „Włączony · Zima / Lato”, „Wyłączony” albo „Offline”, plakietka „Praca” przy paleniu, „Piec włączony / wyłączony” z opisem ogrzewania domu i temperaturą kotła oraz przyciski: „Włącz piec” (włącza regulator, Zimę i CWU, jeśli było wyłączone), „Wyłącz piec”, „Włącz CWU” / „Wyłącz CWU” z linią „CWU teraz X °C, zadana Y °C”; włączany w oknie „Dane sterownika” („Kafelek prosty”) albo udostępniany jako „Panel prosty” — opis mechanizmu w [CLAUDE.md](../../../CLAUDE.md), punkt 5c;
- w aplikacji są też zakładki Wykres (temperatury dnia, spalony pellet), Harmonogram (sezon i CWU w oknach godzin), Alarmy i Operacje oraz zmiana parametrów regulatora z Ustawień — opis w [CLAUDE.md](../../../CLAUDE.md), punkt 5c; niniejsza dokumentacja opisuje etap odczytu i wygląd ekranów.

## Stan wdrożenia

- **Etap 1 — tylko odbiór (zaimplementowany).** Sterownik pieca nasłuchuje magistrali kotła, niczego na niej nie nadaje. Serwer i aplikacja są gotowe.
- **Format ramek niezweryfikowany na kotle.** Sposób kodowania danych na magistrali pochodzi z biblioteki PyPlumIO (inżynieria wsteczna, nie dokumentacja producenta). Nie był sprawdzony na prawdziwym kotle, a punkt wpięcia w kotle nie był sprawdzony przy kotle. Płytkę sterownika sprawdzono 2026-10-03 na biurku, z komputerem udającym kocioł. Dopóki nasłuch nie zostanie sprawdzony, dane mogą się nie pojawić albo być błędnie odczytane.
- **Etap 2 — nadawanie i sterowanie (niezaimplementowany).** Wysyłanie czegokolwiek na magistralę kotła (odpowiedź na pytanie regulatora o obecność urządzenia) i zmiana nastaw kotła z aplikacji nie istnieją.

Sterownik pieca (płytka, strony, wgrywanie): [devices/pellet-boiler-pelux200/README.md](../../../devices/pellet-boiler-pelux200/README.md). Podłączenie, protokół i lista odczytywanych pól: [devices/pellet-boiler-pelux200/docs/piec-pellux200.md](../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md). Dokumentacja producenta kotła: [devices/pellet-boiler-pelux200/docs/pellux200-dokumentacja/](../../../devices/pellet-boiler-pelux200/docs/pellux200-dokumentacja/README.md).

## Dla kogo

**Właściciel domu** z kotłem pelletowym Pellux 200 i sterownikiem pieca podłączonym do jego regulatora. Kocioł pojawia się w aplikacji sam, gdy sterownik pierwszy raz połączy się z chmurą — nie trzeba go dodawać.

## Ekrany

Zrzuty pochodzą z lokalnej bazy demonstracyjnej z odczytami z 12–13.10.2026 (wygląd „Instrument”, motyw jasny); sterownik był wtedy offline, stąd pasek „Offline od …”. Menu kotła ma siedem zakładek: Kocioł, Dane, Wykres, Harmonogram, Alarmy, Operacje, Ustawienia.

![Widok Kocioł](img/piec-kociol.png)

*Kocioł: karta hero z temperaturą kotła, zadaną i histerezą, stanem pracy (plakietka wielkimi literami, np. „PRACA”, przy paleniu płomień), chipami sezonu (Zima / Lato) i trybu pracy (pompa ciepła / pellet) oraz kafelkami Mieszacz 1 · CO, Mieszacz 2 i CWU (temperatura, wskaźnik „POMPA” — bursztynowy przy pracy, szary przy postoju; zadana, zawór strzałką ↑ otwiera / ↓ zamyka; przy CWU wyłączonym w regulatorze zakres od–do, np. „35–50 °C · wyłączone”) i Zewnętrzna. Niżej karty Moc (z obciążeniem), Spalony dziś (z sumą w miesiącu) i Pelet, karta „Urządzenia kotła” (przełączniki tylko do odczytu, pompy CO i CWU na górze, potem wentylator z mocą, podajnik, pompa cyrkulacji, zapalarka) i „Pozostałe” (spaliny, temperatura pokojowa, termostat, czyszczenie, ostatni odczyt). Widok odświeża się co 30 s; gdy ostatni odczyt jest starszy niż trzy interwały odpytywania, na górze jest pasek „Offline od …”. Brak wartości to `---`. Zrzuty powyżej pochodzą sprzed tego układu (2026-10-19).*

![Widok Kocioł na telefonie](img/piec-kociol-telefon.png)

*Ten sam widok na telefonie (360 px): karty jedna pod drugą, dolna nawigacja Kocioł, Dane, Wykres, Harmonogram i „Więcej” (Alarmy, Operacje, Ustawienia, lista sterowników).*

![Widok Dane](img/piec-dane.png)

*Dane: pasek filtrów (dzień strzałkami ‹ › albo z kalendarza, „Wszystkie parametry” — domyślnie główne kolumny, CSV zawsze pełny) i karta „Odczyty dnia” z liczbą odczytów; wiersze od najnowszego. Tabela przewija się w obu kierunkach we własnym kontenerze z przyklejonym nagłówkiem.*

![Widok Wykres](img/piec-wykres.png)

*Wykres: przełącznik Temperatury / Spalony pellet, nawigacja po dniach, chipy serii (kocioł, CWU, CO = mieszacz 1, mieszacz 2, zewnętrzna) i karta „Temperatury kotła” z legendą; okresy palenia są podświetlone pasem na wykresie.*

![Widok Harmonogram](img/piec-harmonogram.png)

*Harmonogram: karta „Harmonogram” („Harmonogram działa – pompa ciepła / pelet” z dymkiem „i”, temperatura na zewnątrz, stan teraz — przy znaczniku „CWU – grzanie peletem” CWU z listy Pellet z dopiskiem „z peletu” — i ostatni błąd; od 2026-10-20 bez przełącznika „Lista: pompa ciepła / pelet”) i dla każdego trybu karty „Tryb Zima · …” i „CWU · …” z wpisami (dzień, godziny, ustawienie; „działa teraz” przy wpisie albo pozycji „Poza harmonogramem”), ołówkiem, koszem i „+ Dodaj wpis”.*

![Widok Ustawienia](img/piec-ustawienia.png)

*Ustawienia (dwie kolumny): po lewej karty „Regulator” (od 2026-10-27: chip Włączony / Wyłączony, stan, duże przyciski „Włącz regulator” / „Wyłącz regulator”), „Tryb pracy” (Pompa ciepła / Pellet, Zima / Lato; okno przełączenia bez listy nastaw), „Główne parametry” (parametry kotła, CWU i mieszaczy z ołówkiem; odnośnik „Nastawy trybów” otwiera tabelę nastaw obu trybów do edycji) i „Ostatnie zmiany” ze statusem; po prawej karta „Odczyt” („Interwał odpytywania pieca” w sekundach, 30–3600), zwinięta karta „Ustawienia zaawansowane”, karta „Sterownik” (nazwa, SN, Root ID, adres IP, firmware ze stanem, „Aktualizuj firmware”) i „Udostępnianie”.*

## Pierwsze uruchomienie

1. Podłączyć sterownik pieca do regulatora kotła według [opisu podłączenia](../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md) i ustawić mu Wi-Fi (punkt dostępowy `MyHome-PelletBoiler-XXXX` (XXXX = ostatnie 4 znaki SN), strona `http://10.10.10.1/install`; [README sterownika](../../../devices/pellet-boiler-pelux200/README.md)).
2. Po połączeniu z Wi-Fi sterownik sam zgłasza się do chmury jako „Piec Pellux 200”. Kocioł pojawia się na liście urządzeń; dane pojawią się, gdy sterownik odbierze z kotła poprawne ramki.
3. Wybrać kocioł na liście, opcjonalnie zmienić mu nazwę (ołówek na kafelku).
4. W Ustawieniach zmienić odstęp odpytywania, jeśli 5 minut nie odpowiada.

Sterownik zgłasza się także bez podłączonego kotła (wtedy kocioł jest na liście, ale bez odczytów). Diagnostykę magistrali (bajty, ramki, polaryzacja) pokazuje strona `/` sterownika.

## Ograniczenia

- **Dane niepotwierdzone na kotle** (punkt „Stan wdrożenia”).
- **Odczyt co kilka minut**, nie na żywo: sterownik wysyła ostatni odebrany odczyt co ustawiony interwał (domyślnie 300 s). Zmiana interwału w aplikacji działa od następnej wysyłki.
- **Sterownik wysyła dane tylko, gdy ostatnia ramka z kotła ma mniej niż 60 s.** Przy braku ramek kocioł w aplikacji zostaje z ostatnim odczytem i po trzech interwałach dostaje znacznik „Dane nieaktualne”.
- **Niektóre pola kontraktu nie są jeszcze wypełniane.** Poziom tlenu w spalinach (`lambda_level`) jest w kontrakcie i w widoku, ale sterownik go nie odczytuje — w aplikacji pokazuje `---`. Widok Kocioł pokazuje też wartości „Status CO” i „Status CWU”, których znaczenie nie jest udokumentowane.
- Restart serwera czyści tylko pamięć podręczną ostatniego odczytu; historia jest w bazie.

## Słownik

| Pojęcie | Znaczenie |
|---|---|
| **Kocioł pelletowy** | kocioł na pellet drzewny; tu Plum Pellux 200 Touch |
| **ecoMAX** | rodzina regulatorów kotłów Plum; regulator kotła, z osobnym panelem dotykowym na łączu RS-485 |
| **Odczyt** | zestaw pomiarów i stanów kotła zapisany jako jeden rekord (`SensorData`) |
| **Odstęp odpytywania** (`poll_interval_seconds`) | co ile sekund sterownik wysyła odczyt do chmury (30–3600, domyślnie 300) |
| **Sterownik pieca** | płytka ESP32-C3 SuperMini z modułem RS-485 HW-519 (`devices/pellet-boiler-pelux200`); do 2026-10-02 tę rolę pełnił sterownik `co` (ten sam SN co pompa, osobny Root ID) |
| **Stan kotła** | 0 Wyłączony, 1 Stabilizacja, 2 Rozpalanie, 3 Praca, 4 Nadzór, 5 Pauza, 6 Czuwanie, 7 Wygaszanie, 8 Alarm, 9 Ręczny, 10 Rozszczelnianie, 11 Inny |
| **Etap 1 / etap 2** | etap 1: sam odbiór ramek; etap 2: nadawanie na magistralę kotła (niezaimplementowane) |
