# Module pellet-boiler-pelux200 — business description

[← System documentation](../../README.md) · **1. Business description** · [2. How it works](2-how-it-works.md) · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/pellet-boiler-pelux200/1-opis-biznesowy.md)

## Why this module exists

The module handles a **Plum Pellux 200 Touch pellet boiler** with an ecoMAX controller in the application. It shows what the boiler "knows about itself": the operating state, temperatures, fuel level, power and the output states (fan, feeder, pumps, igniter, alarm), and it stores every reading in a history.

The boiler has no internet module of its own, so the data is collected by a separate **boiler controller**: an ESP32-C3 SuperMini board with an HW-519 RS-485 module ([devices/pellet-boiler-pelux200](../../../../devices/pellet-boiler-pelux200/README.md), Polish). It listens to the link the ecoMAX controller uses to talk to its touch panel and sends the latest reading to the cloud every few minutes. Until 2026-10-02 this was done by the `co` (heat pump) controller as its second role; since 2026-10-03 the boiler has its own controller, and the module in the application has not changed.

The module lets you:

- **see the current boiler state** — from a phone too, without walking up to the panel;
- **browse the readings of a chosen day** and download them as a CSV file;
- **set how often the controller reads the boiler** (from half a minute to an hour; every 5 minutes by default);
- the application also has the tabs Wykres (day temperatures, burnt pellet), Harmonogram (season and CWU in time windows), Alarmy and Operacje, and changing regulator parameters from Settings — described in [CLAUDE.md](../../../../CLAUDE.md), section 5c (Polish); this documentation describes the reading stage and the look of the screens.

## Implementation status

- **Stage 1 — receive only (implemented).** The boiler controller listens to the boiler bus and transmits nothing on it. The server and the application are ready.
- **Frame format not verified on a boiler.** The way the data is encoded on the bus comes from the PyPlumIO library (reverse engineering, not manufacturer documentation). It has not been checked on a real boiler, and the connection point in the boiler has not been checked at the boiler. The controller board was checked on 2026-10-03 on a desk, with a computer playing the boiler. Until the listening is verified, data may not appear or may be decoded wrongly.
- **Stage 2 — transmitting and control (not implemented).** Sending anything onto the boiler bus (a reply to the controller's device-presence query) and changing boiler settings from the application do not exist.

The boiler controller (board, pages, flashing): [devices/pellet-boiler-pelux200/README.md](../../../../devices/pellet-boiler-pelux200/README.md) (Polish). Wiring, the protocol and the list of fields read: [devices/pellet-boiler-pelux200/docs/piec-pellux200.md](../../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md) (Polish). Boiler manufacturer documentation: [devices/pellet-boiler-pelux200/docs/pellux200-dokumentacja/](../../../../devices/pellet-boiler-pelux200/docs/pellux200-dokumentacja/README.md).

## Who uses it

**A home owner** with a Pellux 200 pellet boiler and a boiler controller connected to its controller. The boiler appears in the application by itself once the controller first connects to the cloud — nothing has to be added.

## Screens

The application interface is in Polish; the screenshots show it as is. They come from the local demo database with readings from 12–13.10.2026 (the "Instrument" look, light theme); the controller was offline at the time, hence the "Offline od …" banner. The boiler menu has seven tabs: Kocioł, Dane, Wykres, Harmonogram, Alarmy, Operacje, Ustawienia.

![Boiler view](../../../moduly/pellet-boiler-pelux200/img/piec-kociol.png)

*"Kocioł" (Boiler): the hero card with the boiler temperature, set point and hysteresis, the operating state (an upper-case badge, e.g. "PRACA", with a flame while burning), the season (Zima / Lato — winter / summer) and operating mode (heat pump / pellet) chips and the tiles Mieszacz 1 (CO), Mieszacz 2 and CWU (temperature, a "POMPA" indicator — amber while running, grey when stopped; set point, valve as an arrow ↑ opening / ↓ closing; with domestic hot water switched off in the controller the from–to range, e.g. "35–50 °C · wyłączone") and Zewnętrzna (outdoor). Below, the cards Moc (power, with load), Spalony dziś (pellet burnt today, with the monthly total) and Pelet (fuel level), the "Urządzenia kotła" card (read-only toggles, CO and CWU pumps first, then fan with power, feeder, circulation pump, igniter) and "Pozostałe" (flue gas, room temperature, thermostat, cleaning, last reading). The view refreshes every 30 s; when the last reading is older than three polling intervals, an "Offline od …" bar is shown at the top. A missing value is `---`. The screenshots above predate this layout (2026-10-19).*

![Boiler view on a phone](../../../moduly/pellet-boiler-pelux200/img/piec-kociol-telefon.png)

*The same view on a phone (360 px): the cards stack, the bottom navigation shows Kocioł, Dane, Wykres, Harmonogram and "Więcej" (Alarmy, Operacje, Ustawienia, controller list).*

![Data view](../../../moduly/pellet-boiler-pelux200/img/piec-dane.png)

*"Dane" (Data): the filter bar (the day via the ‹ › arrows or from the calendar, "Wszystkie parametry" — main columns by default, CSV always complete) and the "Odczyty dnia" card with the number of readings; rows newest first. The table scrolls in both directions in its own container with a sticky header.*

![Chart view](../../../moduly/pellet-boiler-pelux200/img/piec-wykres.png)

*"Wykres" (Chart): the Temperatury / Spalony pellet switch, day navigation, series chips (boiler, CWU, CO = mixer 1, mixer 2, outdoor) and the "Temperatury kotła" card with a legend; burning periods are highlighted with a band on the chart.*

![Schedule view](../../../moduly/pellet-boiler-pelux200/img/piec-harmonogram.png)

*"Harmonogram" (Schedule): the "Harmonogram" card ("Harmonogram działa – pompa ciepła / pelet" with an "i" tip, outdoor temperature, state now — with the "CWU – grzanie peletem" flag the DHW range comes from the Pellet list, marked "z peletu" — and the last error; since 2026-10-20 without the "Lista: pompa ciepła / pelet" switch) and, for each mode, the "Tryb Zima · …" and "CWU · …" cards with entries (day, hours, setting; "działa teraz" at the entry or at the "Poza harmonogramem" item), a pencil, a bin and "+ Dodaj wpis".*

![Settings view](../../../moduly/pellet-boiler-pelux200/img/piec-ustawienia.png)

*"Ustawienia" (Settings, two columns): on the left the cards "Regulator" (since 2026-10-27: a Włączony / Wyłączony chip, the state, large "Włącz regulator" / "Wyłącz regulator" buttons), "Tryb pracy" (Pompa ciepła / Pellet, Zima / Lato; the switch dialog without the settings list), "Główne parametry" (boiler, CWU and mixer parameters with a pencil; the "Nastawy trybów" link opens an editable table of both modes' settings) and "Ostatnie zmiany" with a status; on the right the "Odczyt" card ("Interwał odpytywania pieca" in seconds, 30–3600), the collapsed "Ustawienia zaawansowane" card, the "Sterownik" card (name, SN, Root ID, IP address, firmware with state, "Aktualizuj firmware") and "Udostępnianie".*

## First start

1. Connect the boiler controller to the boiler's ecoMAX controller following the [wiring description](../../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md) (Polish) and set its Wi-Fi (access point `MyHome-PelletBoiler-XXXX` (XXXX = last 4 SN characters), page `http://10.10.10.1/install`; [controller README](../../../../devices/pellet-boiler-pelux200/README.md)).
2. Once connected to Wi-Fi, the controller registers itself with the cloud as "Piec Pellux 200". The boiler appears on the device list; data appears once the controller receives valid frames from the boiler.
3. Choose the boiler on the list, optionally rename it (pencil on the tile).
4. In Settings change the polling interval if 5 minutes does not suit.

The controller registers even with no boiler connected (the boiler is then on the list, but without readings). The controller's `/` page shows the bus diagnostics (bytes, frames, polarity).

## Limitations

- **Data not confirmed on a boiler** (see "Implementation status").
- **A reading every few minutes**, not live: the controller sends the last received reading every set interval (300 s by default). A change of the interval in the application takes effect at the next send.
- **The controller sends data only when the last frame from the boiler is less than 60 s old.** With no frames the boiler in the application keeps its last reading and after three intervals gets the "Dane nieaktualne" mark.
- **Some contract fields are not filled yet.** The oxygen level in the flue gas (`lambda_level`) is in the contract and in the view, but the controller does not read it — the application shows `---`. The Kocioł view also shows "Status CO" and "Status CWU" values whose meaning is undocumented.
- A server restart clears only the cache of the last reading; the history is in the database.

## Glossary

| Term | Meaning |
|---|---|
| **Pellet boiler** | a boiler burning wood pellets; here the Plum Pellux 200 Touch |
| **ecoMAX** | a family of Plum boiler controllers; the boiler controller, with a separate touch panel on an RS-485 link |
| **Reading** | a set of boiler measurements and states stored as one record (`SensorData`) |
| **Polling interval** (`poll_interval_seconds`) | how many seconds between readings sent by the controller to the cloud (30–3600, default 300) |
| **Boiler controller** | an ESP32-C3 SuperMini board with an HW-519 RS-485 module (`devices/pellet-boiler-pelux200`); until 2026-10-02 this role was played by the `co` controller (same SN as the pump, a separate Root ID) |
| **Boiler state** | 0 Off, 1 Stabilisation, 2 Kindling, 3 Working, 4 Supervision, 5 Paused, 6 Standby, 7 Burning off, 8 Alarm, 9 Manual, 10 Unsealing, 11 Other |
| **Stage 1 / stage 2** | stage 1: frame reception only; stage 2: transmitting onto the boiler bus (not implemented) |
