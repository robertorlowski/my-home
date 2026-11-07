# Firmware CHPC — opis biznesowy

[← Dokumentacja systemu](../../../docs/README.md) · **1. Opis biznesowy** · [2. Zasada działania](2-zasada-dzialania.md) · [3. Dokumentacja techniczna](3-dokumentacja-techniczna.md) · [English](en/1-business-description.md)

## Po co jest ten sterownik

CHPC (*Cheap Heat Pump Controller*) to sterownik samej pompy ciepła, zbudowany na Arduino Pro Mini i płytce CHPC v1.3. **To on fizycznie włącza sprężarkę i pompy** — pozostałe części systemu (`co`, chmura, aplikacja) tylko mówią mu, czego się od niego oczekuje.

Sterownik:

- włącza i wyłącza **sprężarkę** jak termostat, według temperatury wody w zbiorniku;
- steruje **pompami obiegowymi** (strona gorąca — ogrzewanie podłogowe, strona zimna — dolne źródło), **grzałką karteru** sprężarki i **zaworem rozprężnym EEV**;
- **chroni sprężarkę i wymienniki** przed przegrzaniem, zamrożeniem, przeciążeniem i brakiem przepływu;
- mierzy **pobór mocy** i **12 temperatur** w obiegu;
- pokazuje stan na **wyświetlaczu 1602** i pozwala zmieniać ustawienia przyciskami;
- odpowiada sterownikowi `co` po **RS-485** i przyjmuje od niego polecenia.

Firmware jest dostosowany do jednej instalacji: pompa gruntowa zasilająca ogrzewanie podłogowe i zbiornik CWU.

![Instalacja](m_CHPC_i2.jpg)

## Dla kogo

- **Właściciel** — zwykle nie dotyka sterownika; steruje z aplikacji.
- **Serwisant** — czyta wyświetlacz, zmienia ustawienia przyciskami, wgrywa firmware, odczytuje błędy.

## Co widać na sterowniku

![Ekrany wyświetlacza](img/lcd-ekrany.png)

*Emulacja wyświetlacza 1602 z danymi demonstracyjnymi. Ekrany zmieniają się co 5 s (pierwszy pokazywany 10 s): temperatury CO (min/max i bieżąca), parownik i zawór EEV, karter, woda wychodząca, moc i przepływ. Przez 90 s po włączeniu sterownik czeka („Wait”), a błędy zastępują zwykły ekran.*

## Czujniki w obiegu

![Rozmieszczenie czujników](m_HeatPump_t_sensors_med.png)

| Skrót | Miejsce | Do czego |
|---|---|---|
| Tae | za parownikiem | przegrzanie EEV, ochrona przed zamarzaniem **(wymagany)** |
| Tbe | przed parownikiem | przegrzanie EEV **(wymagany)** |
| Ttarget | środek zbiornika / obieg grzewczy | termostat: start i stop sprężarki **(wymagany)** |
| Tsump | karter sprężarki | grzałka karteru, za wysoka i za niska temperatura |
| Tci / Tco | obieg zimny wejście / wyjście | ochrona dolnego źródła przed zamarzaniem |
| Thi / Tho | obieg gorący wejście / wyjście | przegrzanie strony gorącej, wybieg pompy |
| Tbc | przed skraplaczem (tłoczenie) | przegrzanie tłoczenia |
| Tac, Touter, Tcwu | za skraplaczem, na zewnątrz, CWU | tylko informacja |

## Zabezpieczenia (co widzi użytkownik)

Każde zdarzenie trafia do aplikacji jako kod błędu z datą. Pięć błędów „liczonych” (przeciążenie, brak przepływu, za mała moc) **blokuje sterownik** — pompa nie wystartuje, dopóki ktoś nie naciśnie „Odblokuj” w aplikacji albo nie zrestartuje sterownika. Pełna lista kodów jest w [dokumentacji technicznej](3-dokumentacja-techniczna.md#zabezpieczenia).

## Ograniczenia

- **Brak zegara** — sterownik nie zna godziny; czas zdarzeń nadaje dopiero chmura (dokładność 10–30 s).
- **Pamięć programu jest prawie pełna** (95%) — każdy nowy klucz w odpowiedzi JSON trzeba dodawać oszczędnie.
- **Polecenia nie są potwierdzane** — sterownik `co` sprawdza ich skutek w kolejnym odczycie.
- **Limit mocy do 3200 W wyłącza ochronę przepływu** (celowo, dla zasilania, przy którym czujnik przepływu działa niepewnie) — **także przy domyślnym limicie 3200 W**. Żeby ochrona działała, limit musi być wyższy niż 3200 W.

## Słownik

| Pojęcie | Znaczenie |
|---|---|
| **Sprężarka** | serce pompy ciepła; CHPC włącza ją przekaźnikiem |
| **EEV** | elektroniczny zawór rozprężny (silnik krokowy, 480 kroków) |
| **Przegrzanie** | różnica Tae − Tbe; zawór EEV utrzymuje je na zadanej wartości |
| **T max / delta** | sprężarka startuje poniżej T max − delta, zatrzymuje się powyżej T max |
| **Wymuszenie** (`F`) | start bez czekania na spadek o całą deltę (wystarczy T max − 3 °C) |
| **Blokada x5** | stan po pięciu błędach liczonych; zdejmuje go odblokowanie albo restart |
| **RS-485** | magistrala do sterownika `co`; CHPC ma adres 0x41 |
