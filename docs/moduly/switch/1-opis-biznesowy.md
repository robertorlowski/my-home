# Moduł switch — opis biznesowy

[← Dokumentacja systemu](../../README.md) · **1. Opis biznesowy** · [2. Zasada działania](2-zasada-dzialania.md) · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](../../en/moduly/switch/1-business-description.md)

## Po co jest ten moduł

Moduł obsługuje w aplikacji **włącznik**: sterownik ESP32 z przekaźnikiem (albo kilkoma), który włącza i wyłącza odbiornik 230 V, np. grzałkę bojlera, pompę w ogrodzie albo oświetlenie. Działa jak harmonogram pompy ciepła, ale bez temperatur: przekaźnik jest włączony w oknach czasowych albo na polecenie użytkownika.

Moduł pozwala:

- **włączyć przekaźnik od razu**: na czas (np. 30 min) albo bez limitu;
- **wyłączyć go i zablokować harmonogram**, dopóki użytkownik nie wróci do harmonogramu;
- **ustawić harmonogram** każdego przekaźnika: dni (każdy dzień, robocze, wolne z polskimi świętami, dzień tygodnia albo jedna data) i godziny, także przez północ;
- **widzieć historię włączeń**: kiedy i jak długo przekaźnik był włączony, z sumą w dniu i eksportem CSV;
- **nadać przekaźnikom nazwy** („Bojler”, „Oświetlenie”).

Pierwszy włącznik działa od 2026-10-03 i steruje grzałką bojlera (przekaźnik „Bojler”).

## Dla kogo

**Właściciel domu**, który chce sterować odbiornikiem 230 V z telefonu i według harmonogramu. Sterownik zgłasza się do chmury sam; po montażu wystarczy nazwać przekaźnik i dodać harmonogram.

## Ekrany

Zrzuty pochodzą z lokalnej bazy demonstracyjnej (jeden przekaźnik „Bojler”, dane z 13.10.2026; wygląd „Instrument”, motyw jasny); sterownik był wtedy offline.

![Widok główny](img/glowny.png)

*Widok główny: karta na przekaźnik — nazwa, przełącznik stanu po prawej (stan zgłoszony przez sterownik), opis trybu (tu „Harmonogram · wyłączony, następne włączenie 22:00”; tryb „Wyłączony · harmonogram zablokowany” jest na czerwono), pasek „Offline od …”, gdy sterownik nie zgłasza się dłużej niż 5 min, ciemne pole z dużym odliczaniem do wyłączenia albo następnym startem z harmonogramu, przyciski „Włącz”, „Wyłącz” i „Harmonogram” (wybrany tryb ma obwódkę) i pole „Czas włączenia” (h, min). Pod kartami karta „Dziś” z dzisiejszymi włączeniami i sumą. Widok odświeża się co 5 s.*

| Telefon | Opis |
|---|---|
| ![Widok główny na telefonie](img/glowny-telefon.png) | Na telefonie (360 px) karty idą jedna pod drugą, a dolna nawigacja pokazuje Włącznik, Harmonogram, Ustawienia, Dane i „Więcej” (Operacje, lista sterowników). Gdy stan przekaźnika jeszcze nie odpowiada poleceniu, karta pokazuje „Czeka na sterownik…”. |

![Dane](img/dane.png)

*Dane: pasek filtrów (dzień strzałkami ‹ › albo z kalendarza po kliknięciu daty, przyciski przekaźników przy więcej niż jednym, CSV) i karta „Włączenia w dniu” (od, do, czas, źródło) z sumą „razem w dniu” w nagłówku. Włączenie zaczęte dzień wcześniej ma przy godzinie datę. „≈” przed godziną wyłączenia oznacza czas przybliżony: sterownik stracił zasilanie albo łączność.*

![Harmonogram](img/harmonogram.png)

*Harmonogram: karta na przekaźnik z chipem trybu (harmonogram albo tryb ręczny, który blokuje harmonogram) i listą wpisów: dzień, godziny, „(+1 dzień)” przy oknie przez północ, ołówek i kosz; wpis działający teraz jest podświetlony ze znacznikiem „działa teraz”. „+ Dodaj wpis” otwiera okno wpisu (przekaźnik, dzień albo data jednorazowa, od–do, aktywny). Pod kartami uwaga o przekaźnikach w trybie ręcznym.*

![Ustawienia](img/ustawienia.png)

*Ustawienia (dwie kolumny): po lewej karty „Przekaźniki” (nazwy) i „Czas włączenia” (domyślny czas w minutach, 0 = bez limitu); po prawej karta „Sterownik” z nazwą, SN, Root ID, liczbą przekaźników, adresem IP, wersją firmware ze stanem i przyciskiem „Aktualizuj firmware” (ołówek otwiera okno „Dane sterownika”) oraz karta „Udostępnianie”.*

## Tryby przekaźnika

| Tryb | Przycisk | Co robi |
|---|---|---|
| **Harmonogram** | „Harmonogram” | przekaźnik jest włączony w oknach harmonogramu, poza nimi wyłączony; tryb domyślny |
| **Włączony na czas** | „Włącz” z czasem > 0 | włączony do końca czasu, potem wraca do harmonogramu |
| **Włączony bez limitu** | „Włącz” z czasem 0 h 0 min | włączony, dopóki użytkownik nie zmieni trybu |
| **Wyłączony** | „Wyłącz” | wyłączony; **harmonogram go nie włączy**, dopóki użytkownik nie wybierze „Harmonogram” |
| **Wyłączony do końca okna** | „Wyłącz” na kafelku prostym | wyłączony do końca okna harmonogramu działającego teraz, potem harmonogram (następne włączenie zostaje); poza oknem to zwykły „Harmonogram” |

**Kafelek prosty** (2026-10-20, dla osoby, która ma tylko włączać i wyłączać bojler): na liście sterowników zamiast zwykłego kafelka — zdanie o stanie („Bojler jest włączony · zgodnie z harmonogramem · wyłączy się dziś o 06:00”) i dwa duże przyciski z opisem, co się stanie: przy wyłączonym ręcznie „Włącz” (na domyślny czas z Ustawień) i „Włączaj zgodnie z harmonogramem”; przy włączonym „Wyłącz” (do końca okna) i „Wyłącz harmonogram uruchamiania”; przy wyłączonym z harmonogramu „Włącz” i „Wyłącz harmonogram uruchamiania”. Włącza się go w oknie „Dane sterownika” („Kafelek prosty”, tylko własne konto) albo udostępnia jako „Panel prosty”.

Ten sam wybór jest na stronie samego sterownika (sieć lokalna), więc włącznik da się obsłużyć także bez internetu.

## Pierwsze uruchomienie

1. Montaż sterownika i wpisanie sieci Wi-Fi na jego stronie `/install` ([firmware włącznika](../../../devices/switch/docs/1-opis-biznesowy.md)).
2. Sterownik sam zgłasza się do chmury; na liście sterowników pojawia się kafelek z ikoną przełącznika i nazwą „Włącznik”.
3. W Ustawieniach nadać przekaźnikom nazwy i ewentualnie zmienić domyślny czas włączenia (30 min).
4. W zakładce Harmonogram dodać okna włączeń.
5. Opcjonalnie udostępnić włącznik domownikom (Ustawienia → „Udostępnianie”).

## Ograniczenia

- **Harmonogram liczy chmura.** Bez internetu sterownik dokończy bieżące włączenie (zna czas wyłączenia) i się wyłączy, ale kolejnego okna nie włączy.
- **Po restarcie sterownika** (np. zanik zasilania) przekaźniki są wyłączone, dopóki sterownik nie połączy się z chmurą.
- **Stan jest odświeżany co 5 s.** Zmiana w aplikacji dociera do sterownika od razu (WebSocket), a gdy WebSocket nie działa — w ciągu 5 s.
- **Czas włączenia i wyłączenia w historii** pochodzi ze sterownika (z dokładnością do sekund); przy utracie zasilania koniec włączenia to ostatnie zgłoszenie przed nią (czas przybliżony, „≈”).
- **Domyślny czas włączenia** zmieniony w aplikacji trafia na stronę sterownika dopiero po jego restarcie (aplikacja używa nowej wartości od razu).
- **Strona sterownika nie wymaga logowania**: w sieci domowej (i w otwartej sieci sterownika po starcie) każdy może przełączyć przekaźnik.
- Najdłuższe włączenie na czas: 7 dni.

## Słownik

| Pojęcie | Znaczenie |
|---|---|
| **Włącznik** | sterownik ESP32 z przekaźnikami (`deviceType: switch`) |
| **Przekaźnik** | wyjście sterownika, numerowane od 1; może mieć nazwę |
| **Tryb** | harmonogram, włączony na czas, włączony bez limitu albo wyłączony |
| **Okno harmonogramu** | wpis „dzień + od–do”; okno przez północ należy do dnia, w którym się zaczyna |
| **Włączenie** | jeden okres od włączenia do wyłączenia przekaźnika w historii |
| **Czas przybliżony** (≈) | koniec włączenia oszacowany, bo sterownik stracił zasilanie albo łączność |
| **Offline** | sterownik nie zgłosił się od ponad 30 s |
