# Heat-pump module — business description

[← System documentation](../../README.md) · **1. Business description** · [2. How it works](2-how-it-works.md) · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/heat-pump/1-opis-biznesowy.md)

## Why this module exists

The module handles the **heat pump** in the application: a pump driven by the CHPC controller and connected to the cloud through the `co` controller. From a phone or a computer the user can:

- decide **what the pump heats and when**: central heating (CO, *centralne ogrzewanie*), domestic hot water (CWU, *ciepła woda użytkowa*) or nothing;
- set **temperatures** and **schedules** (hours, working days and days off including Polish holidays, specific dates, breaks);
- give a **manual command**: forced start, circulation pumps, the expansion valve (EEV), the power limit;
- see the **live pump state**, the **history** of readings, **charts** of energy and temperatures and the **energy cost** in the G12w tariff;
- see **pump controller errors**, unlock it and restart it remotely;
- follow the **photovoltaic production**, because surplus PV is worth using for heating.

Every minute the server works out from the schedules what the pump should do. The application does not have to be open.

## Who uses it

**The home owner** with a CHPC heat pump and a `co` controller; the controller can be shared with household members with selected tabs (user accounts, [core module](../core/1-business-description.md)).

## Operating modes

| Mode | In the application | What the pump does |
|---|---|---|
| `A` | **Automatyczny** (automatic) | schedule entries apply (work and breaks); outside them the default setting |
| `CWU` | legacy value, shown in the application as **Automatyczny** | like `A` (until 2026-10-05 separate hot water schedules; today what the pump heats follows the CWU / CO connection in the "Dane sterownika" dialog) |
| `M` | **Ręczny** (manual) | schedules do not apply, the default setting does; at midnight the mode returns to `A` |
| `OFF` | **Wyłączony** (off) | the compressor does not start |

## Screens

The user interface is in Polish; the screenshots show it as is. They come from the local demo database with data from 13.10.2026 (the "Instrument" look, light theme); the controller was offline at the time, so the main view shows the "Offline od …" banner and empty pump values.

![Main view](../../../moduly/heat-pump/img/glowny.png)

*Main view (HP): at the top the "Offline od …" banner with the reason when the pump sends no data. The hero card: the temperature in the middle of the tank on a from–to range bar, compressor state (with cycle time and energy), the from–to target and reading time, and four fields: power, PV now, mode and outdoor temperature (COP is in the "Pomiary" card). The heat pump tile on the controller list shows the tank temperature, the target, power and the compressor and outlet water temperatures. Below, the cards "Pomiary" (measurements: temperatures, EEV, power limit, cycle energy and time, tank COP, errors), "Obieg" (circuit: toggles with the relay state from telemetry — compressor start consent, hot and cold circuit, flow) and "Energia dziś" (today's energy: use, share from PV, G12w cost, a mini power chart). It refreshes by itself after every controller report.*

| Phone | Schedule on a phone |
|---|---|
| ![Main view on a phone](../../../moduly/heat-pump/img/glowny-telefon.png) | ![Schedule on a phone](../../../moduly/heat-pump/img/harmonogramy-telefon.png) |

*On a phone (360 px) the cards stack, and the bottom navigation shows HP, Statystyki, Harmonogram, Ustawienia and "Więcej" (Dane, Operacje, controller list).*

![Data](../../../moduly/heat-pump/img/dane.png)

*Data: the filter bar (a day with data via the ‹ › arrows or from a list after clicking the date, "Wszystkie odczyty" — by default only compressor runs and errors, the CSV button) and the "Odczyty dnia" card with the number of readings and the compressor run time; a row with a controller error is highlighted and has a chip with the code. The table scrolls horizontally in its own container.*

![Day chart](../../../moduly/heat-pump/img/wykres-dzien.png)

*Day chart: the Dzień / Miesiąc / Rok switch, date navigation and "Cały dzień" (unchecked: compressor runs only); the tiles consumption, from the grid, G12w cost and run time; two charts with one axis each — temperatures (tank, outgoing water, before and after the evaporator) and compressor draw with PV production; the legend in the card header toggles series.*

![Month chart](../../../moduly/heat-pump/img/wykres-miesiac.png)

*Month chart: energy drawn per day, the share from PV and the cost in the G12w tariff (from the server balance); the tiles consumption, from the grid, cost and from PV. The year view shows the same per month.*

![Settings](../../../moduly/heat-pump/img/ustawienia.png)

*Settings (two columns): on the left the "Ustaw" card — the command for the controller: mode Ręczny / Automatyczny / Wyłączony, temperature from–to, power limit, EEV min / max, EEV superheat, toggles for forced start and circulation pumps (greyed ones show the pump's state while the pump drives them itself), the "Zmień" button. On the right the cards "Błędy sterownika" (last error, counter, "Odblokuj" and "Restart sterownika"), "Sterownik" (name, SN, Root ID, IP address, firmware with state, the "Poczta" row with the mail relay key state — `co` from 1.3.0, "Aktualizuj firmware"; the pencil opens the "Dane sterownika" dialog) and "Udostępnianie" (sharing).*

![Schedule](../../../moduly/heat-pump/img/harmonogramy.png)

*Schedule: the "Tryb pracy" card (Ręczny / Automatyczny / Wyłączony — decides whether entries apply) with the default from–to temperature and "Zapisz"; the "Wpisy" card with the list (day, hours, "(+1 dzień)" for a window past midnight, work with temperatures and forced start, or a break), a pencil and a bin at every entry, "+ Dodaj wpis" and the "Poza harmonogramem" (outside the schedule) item. The entry in force right now is highlighted with a "działa teraz" marker. Entries are added and edited in the "Wpis harmonogramu" dialog.*

## Typical scenarios

1. **Winter, cheap night tariff.** "Automatyczny" mode, work entries 21:30–5:30 (G12w night) and 12:30–15:00; outside them the default setting.
2. **Summer.** "Automatyczny" mode, work entries during PV production hours with forced start.
3. **Holidays.** `OFF` mode or an `off` break for specific dates.
4. **A fault.** A red bell appears in the main view; Settings show the error description and date. After five errors the pump controller locks — "Odblokuj" removes the lock, "Restart sterownika" restarts it.
5. **Cost control.** The month chart shows use and cost; comparing it with PV production shows how much energy came from photovoltaics.

## Limitations

- **No range validation in the application.** An out-of-range value is "set" in the application, but the `co` controller or the pump rejects it. What the pump really uses is visible in the data (power limit, EEV, temperatures).
- **Ordinary commands reach the pump within 10–30 s** (at the controller's next report); only "Odblokuj" and "Restart" act immediately — and only when `co` is in CLOUD mode.
- **Manual commands live in server memory** — a server restart clears them; they also expire when a schedule ends.
- **The error time is approximate** (to 10–30 s), because the pump has no clock.
- **The energy cost is an estimate** based on the G12w tariff written into the code.
- **The pump has one sensor in the tank** — "T" in the main view is the temperature in the middle of the tank, not the target temperature.

## Glossary

| Term | Meaning |
|---|---|
| **CO** | central heating |
| **CWU** | domestic hot water |
| **CHPC** | heat pump controller (Arduino Pro Mini): compressor, circulation pumps, EEV valve, protections |
| **co** | ESP32 controller between the pump, photovoltaics and the cloud |
| **Telemetry** | pump state sent by `co` every 10 s (compressor running) or 30 s (idle) |
| **Operation** | what the pump should do (mode, temperatures, forced start…); the server returns it in the reply to telemetry |
| **Schedule** | a range of hours on chosen days in which `co` / `cwu` work or an `off` break applies |
| **Default setting** | mode and temperatures in force outside schedules |
| **Forced start** (`force`) | compressor start without waiting for the temperature to drop; the pump accepts it only when idle |
| **HPS** | compressor state (running / idle) |
| **EEV** | electronic expansion valve; "EEV temp." is the target superheat |
| **COP** | coefficient of performance: heat delivered / energy drawn (estimate for the 300 l tank) |
| **G12w** | two-zone electricity tariff with cheaper nights, weekends and part of the day |
| **PV** | photovoltaics; read from Hoymiles microinverters (DTU) |
