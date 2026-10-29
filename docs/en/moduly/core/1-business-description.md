# Core module — business description

[← System documentation](../../README.md) · **1. Business description** · [2. How it works](2-how-it-works.md) · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/core/1-opis-biznesowy.md)

## Why this module exists

Core is the shared part of the My Home application, independent of the device kind. It lets one application handle several controllers of different kinds (today a heat pump, photovoltaics, a water pressure tank, a switch and a pellet boiler), switch between them and add new kinds without rebuilding everything.

The module is responsible for:

- **the list of controllers** (tiles) and choosing the one the user works with;
- **self-registration of controllers**: a new controller shows up in the application by itself once it is on the internet; nothing has to be typed in;
- **controller names**, the tile layout and weather tiles;
- **user accounts**: login by e-mail and code, account data, sharing a controller with another person with a choice of tabs;
- **the shared look**: the controller bar with tabs, the bottom navigation on a phone, the light and dark theme, Polish or English language, dialogs, the "Sterownik" card and the operations log;
- **menus and screens that depend on the controller kind** (the heat pump has schedules, the water pressure tank and photovoltaics do not);
- **shared services**: outdoor temperature (IMGW), the weather of the home and of the weather tiles (Open-Meteo, fetched by the switch), a weather page with a forecast, the Polish public holiday calendar, fast notifications to the controller and the browser (WebSocket);
- **mail**: login codes and notifications are sent by the controllers at home (the switch, with `co` as a fallback), because the server on Render's free plan cannot reach a mail server.

## Who uses it

- **The installation owner** — logs in, chooses a controller, names it, arranges the tiles, shares a controller with household members. Uses the application on a computer and on a phone.
- **The installer** (usually the same person) — connects a new controller; it is enough to give the controller Wi-Fi, the rest happens automatically.
- **The system user** — the administrative account (login "system" with a password): sees all controllers, manages the firmware of controller kinds and sees the database usage.

## What the user can do

| Action | Where |
|---|---|
| Log in | login screen: e-mail → code from the mail (or a link from the mail); after login the question "Zapamiętać?" (remember?) — a remembered session lasts 90 days. The mail is sent by a controller at home; when none is online the screen says "Poczta jest chwilowo niedostępna…" (mail temporarily unavailable) |
| Turn on notifications on the phone and in the browser | "Moje dane" → the "Powiadomienia" (notifications) card → "Włącz na tym urządzeniu" (browser consent), then tick the events for each controller: compressor start / stop, pump error, boiler kindling and burn-out, boiler alarm, relay on / off, water pump start, controller stopped / resumed responding; "domyślne" ticks the most important ones. Quiet hours from–to hold everything except urgent events (error, alarm). Notifications are enabled on each device separately, the choice of events is shared by the account; "Wyślij próbne" sends a test |
| Show the installation to someone without an account | login screen → "Zobacz wersję demo": a read-only view of the controllers of the owner configured on the server (every attempt to change something ends with a message), without serial numbers, addresses or the home location; a yellow "Wersja demo" bar with "Wyjdź"; the session lasts 2 hours |
| Have the app on the phone | Chrome on Android: menu → "Add to Home screen" (a PWA with an icon, no address bar, opens without network with a "Brak połączenia" screen); iPhone: Share → "Add to Home Screen". The Android package (TWA, `android/`) can be installed from an `.apk` file or, eventually, from Google Play |
| See the weather and forecast for a town | click a weather tile → the weather page with the tabs Teraz (now), Najbliższe dni (next days), Słońce i PV (sun and PV), Ogrzewanie (heating), Powietrze (air), Wiatr i opady (wind and precipitation); the "Moja lokalizacja" tile takes the position from the browser |
| See all controllers and choose one | the "Sterowniki" tile list (`/devices`); the application always starts there |
| Give or change a controller name | pencil on the tile (on hover) or the pencil in the "Sterownik" card in Settings |
| Arrange tiles, hide a tile, add a weather tile for any town | grid icon in the bar → "Zmień układ" (change layout) mode: arrows (move, swap), eye (hide), "+ kafelek pogody" (weather tile) in an empty field, "Gotowe" (done) |
| Switch to another controller | the back arrow in the bar (to the list) or, on a phone, "Więcej" (more) → "Lista sterowników" (controller list) |
| See the Root ID, SN, IP address and firmware of a controller | the "Dane sterownika" dialog and the "Sterownik" card in Settings |
| Share a controller with another person (selected tabs or "Panel prosty") | the "Udostępnianie" (sharing) card in Settings → "Udostępnij"; "Panel prosty" (simple panel) = the person sees only the simple tile (big buttons), no controller views |
| Turn on the simple tile on your own list (boiler switch: on / off / schedule; pellet boiler: turn the boiler on / off / DHW) | pencil on the tile → "Dane sterownika" → "Kafelek prosty"; this account only |
| Browse the controller's operations log | the "Operacje" tab (all kinds except photovoltaics) |
| Change the theme | the moon / sun icon in the bar (light ↔ dark) or the account menu: Jasny / Ciemny / Jak system (light / dark / as system) |
| Change the language | the PL / EN toggle on the login bar or the account menu: Polski / English; without a choice the browser language (anything other than Polish or English = Polish); after signing in the choice is stored in the account and applies on every device, also to mails, notifications and server messages |
| Change account data, log out, delete the account | the account menu (avatar in the bar) → "Moje dane" (my data) |

The user interface is in Polish; the screenshots below show it as is.

![Controller list](../../../moduly/core/img/lista-sterownikow.png)

*Controller list (production, computer, light theme): the home weather strip at the top, tiles in a fixed layout — the icon and the left edge in the kind's colour (sun — photovoltaics, waves — heat pump, drop — water pressure tank, flame — pellet boiler, toggle — switch), the name, a Włączony / Wyłączony (on / off) chip (since 2026-10-27; heat pump, boiler and tank, with a pulsing dot while running; the switch and photovoltaics have none; the screenshot predates this and still shows Online / Offline), a big value with a caption, fact fields (heat pump: power, compressor and outlet water temperature; boiler: DHW and both mixers; photovoltaics: today's yield; tank: pump, runs, last run), a state badge ("pracuje" — running, CO / CWU), a warning (when the controller does not respond: a red line with an icon, "Sterownik nie odpowiada od X") and the "dane sprzed …" (data from …) footer; the switch shows its relays with toggles. Below, weather tiles; at the bottom, the status bar with database usage (system user only). The pencil and the firmware cog appear when hovering a tile. The screenshots in this documentation come from the production installation (2026-10-18); the name, e-mail, address, SN, Root ID, IP addresses and microinverter serial numbers are altered.*

![Controller list on a phone](../../../moduly/core/img/lista-sterownikow-telefon.png)

*The same list on a phone (360 px): one column, tiles one after another.*

![Change layout](../../../moduly/core/img/zmien-uklad.png)

*"Zmień układ" mode (grid icon in the bar): arrows move a tile, the eye hides it, an empty field can take a weather tile, "Gotowe" saves the layout. Hidden tiles are visible only here, greyed out with an "Ukryty" (hidden) chip.*

![Controller data](../../../moduly/core/img/dane-sterownika.png)

*The "Dane sterownika" dialog (here the boiler): the name can be changed; the kind, SN (Device ID) and Root ID are read-only; kinds with their own fields (heat pump: configuration with the piping diagram) show them below.*

| Weather page (computer) | Weather page (phone) |
|---|---|
| ![Weather page](../../../moduly/core/img/pogoda.png) | ![Weather page on a phone](../../../moduly/core/img/pogoda-telefon.png) |

*The weather page (click on a weather tile): tabs Teraz, Najbliższe dni, Słońce i PV, Ogrzewanie, Powietrze, Wiatr i opady — like controller views: in the side menu on a computer, in the bottom navigation with "More" on a phone. "Teraz" is a card with the temperature, sky description, the day's high and low, apparent temperature, wind, humidity, pressure and sun hours, a strip of the next 48 hours (icon, temperature, precipitation probability) and tomorrow's temperature. The current conditions come from the reading fetched by the switch; the forecast and air quality are fetched by the browser directly from Open-Meteo.*

| Phone — bar and bottom navigation | Phone — "Więcej" |
|---|---|
| ![Controller bar on a phone](../../../moduly/core/img/nawigacja-pompa-telefon.png) | !["Więcej" sheet](../../../moduly/core/img/nawigacja-wiecej-telefon.png) |

*The controller bar: a back arrow to the list, the name, below it a Włączony / Wyłączony chip (since 2026-10-27, as on the tile) and a kind-dependent description (mode and SN, number of panels, last run, relays and firmware, regulator and read interval), the theme icon and the account avatar. On a computer (from 900 px) the tabs form a side menu on the left; on a phone the bottom navigation shows the first four views and "Więcej" — a sheet with the remaining views and "Lista sterowników". The tabs depend on the kind: the heat pump has six (HP, Statystyki, Harmonogram, Ustawienia, Dane, Operacje), the tank and the switch five, the boiler seven (with Alarmy), photovoltaics four.*

![Login](../../../moduly/core/img/logowanie.png)

*Login: a card with the e-mail address; the code and the link arrive by mail. The theme icon already works on this screen. The mail is sent by the switch at home (with the `co` controller as a fallback), so it arrives within seconds; without a controller online the login gets a "mail unavailable" message, and the system user logs in with a password.*

![My data](../../../moduly/core/img/konto.png)

*"Moje dane" (account menu): e-mail changed via a code, first and last name, address and country, location chosen on the map or "Moja lokalizacja" from the browser (it drives the home weather). Below, the "Sesja" (session) and "Usunięcie konta" (account deletion) cards.*

![Firmware of a controller kind](../../../moduly/core/img/firmware.png)

*The firmware page of a controller kind (cog on the tile, system user only): the cards "Aktualna wersja" (current version; the plus opens the "Dodaj wersję" card), "Sterowniki tego rodzaju" (controllers of this kind, with the version from the last report) and "Poprzednie wersje" (previous versions).*

![Operations](../../../moduly/core/img/operacje.png)

*The "Operacje" tab: the day (arrows or calendar), the filter Wszystkie / Użytkownik / System (all / user / system) and a timeline of events: time, who and from where, what changed and a state chip (done, delivered, pending, error). The log keeps 5 days.*

## Typical scenarios

1. **A new controller.** The installer connects the controller and sets its Wi-Fi. The controller registers itself with the cloud and appears on the list — without a name, with its identifier (SN) only. The user names it with the pencil.
2. **Everyday use.** When opened, the application shows the tile list with the current state of every controller (temperature, power, water, relays). Clicking a tile opens the controller's screens; the arrow in the bar goes back to the list.
3. **Several controllers.** The user switches through the list (back arrow or "Więcej" on a phone). The selected controller stays in the browser after a page reload, but a new browser session starts from the list again.
4. **Replacing a controller or wiping its memory.** The controller registers again with the same SN and gets the same record back — the data history stays.
5. **A controller with several roles.** One physical controller may appear in the application as several devices with the same identifier (SN), each with its own Root ID, menu and data history. That was the case on 2026-10-01–02, when `co` served the heat pump and the pellet boiler; since 2026-10-03 the boiler has its own boiler controller, and the role mechanism stays in the application.
6. **A household member.** The owner shares a controller with a household member's e-mail and selected tabs; after logging in, the member sees the controller's tile and only those tabs.

## Limitations and risks

- **Controller endpoints without authorisation.** The application requires login (user accounts), but the controller endpoints accept the bare SN (there is no API key). The Root ID should not be published (the screenshots in this documentation use made-up identifiers).
- **A controller cannot be deleted in the application.** Deleting it requires a change in the database.
- **Some data lives in server memory** (latest telemetry, manual operations, device info). A server restart clears it; the controller restores it with its next report.
- **The outdoor temperature** comes from a single IMGW station (Zakopane) — for an installation elsewhere the station has to be changed in the code.
- **Mail depends on a controller at home.** The server on Render's free plan cannot reach SMTP, so mails (login codes, invitations, confirmations) are sent by the switch, with `co` as a fallback. When both are offline, login by code does not work ("Poczta jest chwilowo niedostępna"); the system account with a password remains. The key of a board that is to receive the mail credentials is approved by the system user after comparing the fingerprint with the board's `/install` page.
- **Notifications depend on the browser.** On an iPhone they work only in the application added to the home screen (iOS 16.4+), not at all in incognito mode, and Android may delay them while saving battery. The temperature on the "Dom" tile comes from the boiler's outdoor sensor when the boiler delivers a fresh reading (up to 15 min); with the boiler off it comes from the weather model, which in the valley is off by a few degrees at night.
- **The demo is public.** Anyone who knows the application address sees the owner's installation data (temperatures, history, schedules). The server hides sensitive data and blocks writes, but the view itself is open; it is switched off by removing `DEMO_OWNER_EMAIL` from the server configuration.
- **Weather depends on the switch.** Current conditions are fetched by the switch over the home connection (Render shares its IP address with other services and Open-Meteo rejected the server's requests); without the switch the strip and weather tiles show the last reading, then the forecast.

## Glossary

| Term | Meaning |
|---|---|
| **Controller** (sterownik) | the device at the installation that talks to the cloud: `co` (heat pump), the tank controller, the boiler controller (pellet boiler) or the switch |
| **Controller kind** (`deviceType`) | `heat_pump`, `water-pressure-tank`, `pellet-boiler-pelux200` or `switch`; decides the menu, screens and data handling |
| **Controller role** | one task of a physical controller (e.g. `co` as the heat pump or, on 2026-10-01–02, as the boiler); each role is a separate device in the application |
| **SN** (`deviceId`) | the controller serial number — the factory MAC address of the ESP32, 12 hex characters; shared by all roles of the same controller |
| **Root ID** (`rootId`) | the device (role) identifier in the database; the application and the controller send it with every request |
| **Controller registration** (zgłoszenie) | the request a controller sends at start; creates the device or returns the existing one |
| **Account** | an application user: e-mail, first and last name, location; own controllers, own tile layout and weather tiles |
| **Share** (udostępnienie) | another account's access to a controller with selected tabs or as a "Panel prosty"; the owner can change or revoke it |
| **Simple tile** (kafelek prosty) | the switch or boiler tile on the list with big buttons instead of values (2026-10-20); two such tiles fit on a phone screen without scrolling |
| **Tile** (kafelek) | a field on the controller list: a controller with its current state or the weather of a town |
| **Weather page** | the screen behind a weather tile: current conditions, forecast, sun and PV, heating, air, wind and precipitation |
| **Mail relay** (przekaźnik poczty) | a controller at home (the switch, `co` as a fallback) that sends the application's mails; it receives the mail credentials encrypted with its own key and keeps them only in memory |
| **Web Push notification** | a system message on the phone or in the browser about a controller event; the browser stores a subscription, the server sends through the browser's push service |
| **Demo mode** (wersja demo) | public entry without a password from the login screen: a read-only session on the owner's account, 2 hours, without sensitive data |
| **PWA / TWA** | a web application installed from the browser ("Add to Home screen") / its wrapper as an Android application for Google Play (the `android/` directory) |
| **Settings** (`properties`) | controller settings stored in the cloud (e.g. heat pump temperatures, the tank compressor time) |
| **Controller kind registry** | the place in the code where each kind describes its menu, screens and default settings |
| **Theme** (motyw) | the light or dark look ("Instrument"); light without a choice, "Jak system" follows the device setting |
| **Language** (język) | Polish or English: application texts, tiles, mails, notifications and server error messages; from the browser, after signing in from the account. Names stored in the database (request reasons, the operations log, boiler parameter ratings) stay Polish |
