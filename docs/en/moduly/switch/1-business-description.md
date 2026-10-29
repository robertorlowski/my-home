# Switch module — business description

[← System documentation](../../README.md) · **1. Business description** · [2. How it works](2-how-it-works.md) · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/switch/1-opis-biznesowy.md)

## Why this module exists

The module handles the **switch** (*włącznik*) in the application: an ESP32 controller with a relay (or several) that turns a 230 V load on and off, e.g. a water heater element, a garden pump or lighting. It works like the heat pump schedule, but without temperatures: a relay is on during time windows or on the user's command.

The module lets the user:

- **turn a relay on right away**: for a time (e.g. 30 min) or without a limit;
- **turn it off and block the schedule** until the user goes back to the schedule;
- **set a schedule** for each relay: days (every day, working days, days off with Polish public holidays, a day of the week or a single date) and hours, also across midnight;
- **see the activation history**: when and how long a relay was on, with the daily total and a CSV export;
- **name the relays** ("Bojler" — water heater, "Oświetlenie" — lighting).

The first switch has been running since 2026-10-03 and controls the heating element of a water heater (relay "Bojler").

## Who uses it

**The home owner** who wants to control a 230 V load from the phone and by a schedule. The controller registers with the cloud by itself; after installation it is enough to name the relay and add a schedule.

## Screens

The user interface is in Polish; the screenshots show it as is.

The screenshots come from the local demo database (one relay "Bojler", data from 13.10.2026; the "Instrument" look, light theme); the controller was offline at the time.

![Main view](../../../moduly/switch/img/glowny.png)

*Main view: a card per relay — the name, a state switch on the right (the state reported by the controller), the mode description (here "Harmonogram · wyłączony, następne włączenie 22:00" — schedule, off, next activation 22:00; the "Wyłączony · harmonogram zablokowany" mode is in red), the "Offline od …" banner when the controller has not reported for more than 5 min, a dark field with a large countdown to switch-off or the next schedule start, the buttons "Włącz" (on), "Wyłącz" (off) and "Harmonogram" (schedule; the selected mode has an outline) and the "Czas włączenia" (on time) field (h, min). Below the cards the "Dziś" (today) card with today's activations and the total. The view refreshes every 5 s.*

| Phone | Description |
|---|---|
| ![Main view on a phone](../../../moduly/switch/img/glowny-telefon.png) | On a phone (360 px) the cards stack, and the bottom navigation shows Włącznik, Harmonogram, Ustawienia, Dane and "Więcej" (Operacje, controller list). When the relay state does not match the command yet, the card shows "Czeka na sterownik…" (waiting for the controller). |

![Data](../../../moduly/switch/img/dane.png)

*Data: the filter bar (the day via the ‹ › arrows or from the calendar after clicking the date, relay buttons with more than one relay, CSV) and the "Włączenia w dniu" card (from, to, duration, source) with the "razem w dniu" (daily total) in the header. An activation that started the day before has a date next to the time. "≈" before the switch-off time means an approximate time: the controller lost power or connectivity.*

![Schedule](../../../moduly/switch/img/harmonogram.png)

*Schedule: a card per relay with a mode chip (schedule, or a manual mode that blocks the schedule) and the list of entries: day, hours, "(+1 dzień)" for a window across midnight, a pencil and a bin; the entry active now is highlighted with a "działa teraz" marker. "+ Dodaj wpis" opens the entry dialog (relay, day or a one-off date, from–to, active). Below the cards a note about relays in a manual mode.*

![Settings](../../../moduly/switch/img/ustawienia.png)

*Settings (two columns): on the left the cards "Przekaźniki" (relay names) and "Czas włączenia" (default on time in minutes, 0 = no limit); on the right the "Sterownik" card with the name, SN, Root ID, number of relays, IP address, firmware version with state and the "Aktualizuj firmware" button (the pencil opens the "Dane sterownika" dialog) and the "Udostępnianie" (sharing) card.*

## Relay modes

| Mode | Button | What it does |
|---|---|---|
| **Schedule** | "Harmonogram" | the relay is on during schedule windows and off outside them; the default mode |
| **On for a time** | "Włącz" with a time > 0 | on until the time runs out, then back to the schedule |
| **On without a limit** | "Włącz" with 0 h 0 min | on until the user changes the mode |
| **Off** | "Wyłącz" | off; **the schedule will not turn it on** until the user selects "Harmonogram" |
| **Off until the end of the window** | "Wyłącz" on the simple tile | off until the end of the schedule window active now, then the schedule (the next activation stays); outside a window it is a plain "Harmonogram" |

**Simple tile** (2026-10-20, for a person who only turns the boiler on and off): on the controller list instead of the normal tile — a sentence about the state ("Bojler jest włączony · zgodnie z harmonogramem · wyłączy się dziś o 06:00") and two big buttons with a description of what will happen: when off manually "Włącz" (for the default time from Settings) and "Włączaj zgodnie z harmonogramem"; when on "Wyłącz" (until the end of the window) and "Wyłącz harmonogram uruchamiania"; when off by the schedule "Włącz" and "Wyłącz harmonogram uruchamiania". It is turned on in the "Dane sterownika" dialog ("Kafelek prosty", own account only) or shared as "Panel prosty".

The same choice is on the controller's own page (local network), so the switch can be operated without the internet as well.

## First start

1. Install the controller and enter the Wi-Fi network on its `/install` page ([switch firmware](../../../../devices/switch/docs/en/1-business-description.md)).
2. The controller registers with the cloud by itself; a tile with a switch icon and the name "Włącznik" appears on the controller list.
3. In Settings name the relays and, if needed, change the default on time (30 min).
4. Add the on windows on the Schedule tab.
5. Optionally share the switch with household members (Settings → "Udostępnianie").

## Limitations

- **The cloud evaluates the schedule.** Without the internet the controller finishes the current activation (it knows the switch-off time) and turns off, but it will not start the next window.
- **After a controller restart** (e.g. a power cut) the relays stay off until the controller connects to the cloud.
- **The state is refreshed every 5 s.** A change in the application reaches the controller immediately (WebSocket), or within 5 s when the WebSocket is down.
- **On and off times in the history** come from the controller (to the second); after a power loss the end of an activation is the last report before it (approximate time, "≈").
- **The default on time** changed in the application reaches the controller page only after the controller restarts (the application uses the new value at once).
- **The controller page has no login**: in the home network (and in the controller's open network after start) anyone can switch the relay.
- The longest timed activation: 7 days.

## Glossary

| Term | Meaning |
|---|---|
| **Switch** (*włącznik*) | an ESP32 controller with relays (`deviceType: switch`) |
| **Relay** | a controller output, numbered from 1; may have a name |
| **Mode** | schedule, on for a time, on without a limit, or off |
| **Schedule window** | an entry "day + from–to"; a window across midnight belongs to the day it starts on |
| **Activation** | one period from switching a relay on to switching it off in the history |
| **Approximate time** (≈) | the end of an activation was estimated because the controller lost power or connectivity |
| **Offline** | the controller has not reported for more than 5 min |
