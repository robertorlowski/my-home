# Water-pressure-tank module — business description

[← System documentation](../../README.md) · **1. Business description** · [2. How it works](2-how-it-works.md) · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/water-pressure-tank/1-opis-biznesowy.md)

## Why this module exists

The module handles the **water pressure tank system** (*hydrofor*) in the application: a household well-water installation in which a pump fills pressure tanks and a pressure switch starts it when pressure drops and stops it once pressure is restored. In a tank with an air cushion the air slowly dissolves in the water, so at every pump start the tank controller runs an **air compressor** for a while to top the air up.

The module lets the user:

- **set the compressor run time**;
- **see every pump run**: when it happened and how long the pump and the compressor ran;
- **calculate water consumption** without an electronic water meter: from the pump run time and the pump flow, which the application derives from manual water meter readings;
- **compare the water from pump time with the water meter** month by month.

## Who uses it

**The home owner** with a water pressure tank system and the tank controller (ESP32). The controller is powered only while the pump runs, so it needs no attention.

## Screens

The user interface is in Polish; the screenshots show it as is. They come from the local demo database (two runs from 12–13.10.2026 and generated water meter readings; the "Instrument" look, light theme); the data is sample data, hence the unrealistic flow.

![Main view](../../../moduly/water-pressure-tank/img/glowny.png)

*Hydrofor: at the top the "Offline od …" banner with the reason (the controller is powered only while the pump runs). The "Woda dziś" (water today) hero card with the number of runs, pump time and this month's water, the "Pompa wody" and "Kompresor powietrza" switches (state from the current run) and the "Czas kompresora" and "Przepływ" fields. Below, the "Dzisiejsze uruchomienia" card (today's runs: columns Kompresor, Pompa e.g. "4 min 10 s" without manual compressor time, Woda; a run in progress is highlighted) and the "Zużycie w tygodniu" card with bars per day. Runs refresh every 5 s.*

| Phone | Settings on a phone |
|---|---|
| ![Main view on a phone](../../../moduly/water-pressure-tank/img/glowny-telefon.png) | ![Settings on a phone](../../../moduly/water-pressure-tank/img/ustawienia-telefon.png) |

*On a phone (360 px) the cards stack, and the bottom navigation shows Hydrofor, Statystyki, Ustawienia, Dane and "Więcej" (Operacje, controller list).*

| Data — pump runs | Data — water meter readings |
|---|---|
| ![Runs](../../../moduly/water-pressure-tank/img/dane-uruchomienia.png) | ![Meter readings](../../../moduly/water-pressure-tank/img/dane-odczyty-wodomierza.png) |

*Data: the filter bar with the "Uruchomienia pompy" / "Odczyty wodomierza" switch, month navigation and CSV. The "Uruchomienia w miesiącu" card (date, time, compressor, pump in minutes and seconds, water, notes; the header says "razem X l · pompa Y · N uruchomień"; "≈" and the "z kolejki" (from the queue) chip mark an approximate time, i.e. a run sent later because the network was missing). The "Odczyty wodomierza" card: a form (date, reading in m³, notes) and a list, newest first, with the increase, pump time and the period's flow; the bin deletes a reading.*

| Chart — day | Chart — month |
|---|---|
| ![Day](../../../moduly/water-pressure-tank/img/wykres-dzien.png) | ![Month](../../../moduly/water-pressure-tank/img/wykres-miesiac.png) |

*Chart: the Dzień / Miesiąc / Rok switch with date navigation, the tiles water, pump, runs and flow, and a card with water bars per hour, day or month (axis in m³ for large values). Until the flow is known, the bars show the pump run time in minutes, with a hint about two water meter readings below the chart.*

![Year with the water meter](../../../moduly/water-pressure-tank/img/wykres-rok-wodomierz.png)

*The year chart with "Pokaż odczyty z wodomierza" on: water meter consumption next to water "z czasu pompy" (from pump time) for each month, and under the checkbox the flow used to compute it.*

![Settings](../../../moduly/water-pressure-tank/img/ustawienia.png)

*Settings (two columns): on the left the "Kompresor" card (compressor run time, effective from the next pump run) and the "Przepływ pompy" card (the flow, the number of periods, water meter water and pump time it was computed from, or instructions: two water meter readings); on the right the "Sterownik" card (name, SN, Root ID, IP address, firmware with state, "Aktualizuj firmware"; the pencil opens the "Dane sterownika" dialog) and the "Udostępnianie" (sharing) card.*

## First start

1. After its first start the controller registers with the cloud by itself and receives the default setting: compressor 30 s.
2. Add **water meter readings** (Dane → Odczyty wodomierza): at least two with pump runs between them, ideally every few weeks. From the second reading on the application knows the pump flow and shows water also for past runs.
3. Optionally share the tank with household members (Settings → "Udostępnianie").

A compressor time change in the application reaches the controller **at the next pump run** (the controller is powered only while the pump runs). The compressor time can also be changed on the controller's `/install` page; it is then sent to the cloud.

## Limitations

- **Water is approximate.** It assumes a constant pump flow. The flow is the average over all periods between water meter readings, weighted by pump run time.
- **There is no water before two water meter readings** ("---" in the application). The pump run time is shown from the start.
- **Every new water meter reading changes the flow**, and therefore the water in the whole history, because water is not stored but computed on read.
- **Manual compressor operation** ("Włącz" on the controller page) is subtracted from the pump run time, because the pump does not deliver water to consumers during it.
- **Without a network** a run reaches the cloud at the next start, with an approximate time.
- **Run times** are accurate to about 1 s (the controller has no clock; the server computes the times).

## Glossary

| Term | Meaning |
|---|---|
| **Hydrofor** (water pressure tank system) | pump + pressure tanks + pressure switch |
| **Pressure switch** (presostat) | starts the pump at the lower threshold, stops it at the upper one |
| **Air-cushion tank** | a tank (e.g. galvanised) in which water touches air; air is lost, hence the compressor |
| **Run** (uruchomienie) | one pump cycle from start to stop by the pressure switch |
| **Pump time** | the pump run time of a run without manual compressor operation |
| **Pump flow** (przepływ pompy) | litres per minute: total water from the meter divided by total pump time over the periods between readings |
| **Water meter** (wodomierz) | water counter; readings are entered by the user |
