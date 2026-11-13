# Core module — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/core/3-dokumentacja-techniczna.md)

## Files — server (`server/src`)

| File | Role |
|---|---|
| `server.ts` | entry point: MongoDB, heat pump scheduler, PV panel cleanup, weather, HTTP and WebSocket listening |
| `core/app.ts` | Express application: CORS, response compression (`compression`, only with `Accept-Encoding` gzip / br / deflate, controllers unchanged), JSON, `device-context` and routes under `/api` |
| `core/routes.ts` | assembles the routes: devices and `/temperature` from core plus each module's `routes.ts` |
| `core/types.ts` | `DeviceType`, `WeekDay` (schedule days of the heat pump and the switch), `Device`, `DeviceProperties` (one settings field for all kinds), `DeviceTypeModule` |
| `core/device-types.ts` | controller kind registry: `DeviceType` → module description (`device-type.ts`) |
| `core/time.ts` | `TIME_ZONE = Europe/Warsaw`, Warsaw day boundaries as a UTC range |
| `core/websocket.ts` | WebSocket server (`/ws?rootId=`), `sendMessage(type, rootId)` with a 1 s delay; since 2026-11-13 (trial) controller sockets after the `ESP32` greeting: `sendToController`, `onControllerMessage`, `controllerRootIds` (QNAP commands) |
| `core/middleware/device-context.ts` | resolves the device from `rootId` or (for controller paths in the `controllerPaths` map) from the pair `{deviceId, deviceType}`, from the device document cache; 400/404/409 |
| `core/services/device-cache.service.ts`, `device-cache-store.ts` | device documents cached in memory (`cachedDeviceById`, `cachedDeviceBySn`) for controller paths; every write to `devices` through the model clears the cache (hooks in `device.model.ts`), refreshed every 5 min (`DEVICE_CACHE_TTL_MS`) |
| `core/models/device.model.ts` | Mongoose model `devices`: device schema, `properties`, embedded schedules and legacy `settings` |
| `core/controllers/device.controller.ts` | device routes; the registration reply includes `settings` from the registry; firmware update request and its cancellation |
| `core/controllers/meteo.controller.ts` | `GET /temperature` |
| `core/controllers/firmware.controller.ts` | `/firmware/:kind...`: state, file upload, offer, download; only kinds with `firmwareUpdates` |
| `core/models/firmware.model.ts` | `firmware_images` (`.bin` file, size, SHA-256) and `firmware_offers` (offered and previous version, `enabled`) |
| `core/services/firmware.service.ts` | image validation and storage (ESP32 header, ≤ 1,310,720 B), update request (`requestFirmwareUpdate`, `cancelFirmwareUpdate`), offer for the controller only with a request (`firmwareOfferForDevice`, `firmwareOfferForRoot`), pruning to the current and one previous version |
| `core/services/device.service.ts` | list, create, register, name, default, read and write `properties` |
| `core/services/device-info.service.ts` | device kind and `deviceId` cached in memory (for module data records) |
| `core/services/calendar.service.ts` | Polish holidays, day of the week in Warsaw, `scheduleDayMatches` (whether a switch schedule entry applies to a given date) |
| `core/services/weather-fetch.service.ts` | Open-Meteo weather fetched by the server (since 2026-11-07, the only source since 2026-11-13): one request for the home and the visible tiles (at most 8) every 15 min, after an error after 5 min, immediately after the list changes; started in `server.ts` (`startServerWeather`) |
| `core/services/meteo.service.ts` | outdoor temperature from the boiler sensor (without a fresh reading, from the forecast); weather from the server (`setWeatherReadings`) kept in memory by tile id, readings older than 45 min ignored; home temperature from the boiler sensor or the forecast. Until 2026-11-13 also weather from the controllers (`setWeatherFromController`, `weatherStale`, `WEATHER_BACKUP_AFTER_MS`, the home key `home`) |
| `core/services/weather-tile.service.ts`, `models/weather-tile.model.ts`, `controllers/weather-tile.controller.ts` | weather tiles `weather_tiles` (`home` from `WEATHER_LOCATION`, at most 8 per account), `weatherQueries` — places fetched by the server; `switchWeatherQueries` and `backupWeatherQueries` (fallback places for the switch and `co`) removed on 2026-11-13 |
| `core/services/mail.service.ts` | `sendMail`: SMTP from the settings (`SMTP_*`), without `SMTP_HOST` an in-memory outbox and the log (`mailConfigured()` = `SMTP_HOST` set); the body in Polish or English (`lang`: the recipient's account language, otherwise the request's; `mailLang`). The mail relay through controllers (`MAIL_RELAY=1`, `mail-relay.service.ts`, `mail-relay.controller.ts`, `models/mail-outbox.model.ts`, `/mail/*`, `assertMailAvailable`; since 2026-10-17) was removed on 2026-11-13 |
| `core/services/qnap.service.ts`, `controllers/qnap.controller.ts`, `core/cli.ts` (`--qnap`) | trial QNAP commands through the `co` controller (since 2026-11-13): body and HMAC-SHA256 signature, choice of the connected `co`, the `qnap` message and waiting for `qnap_wynik` (`QNAP_CZEKAJ_MS` 20 s), operations log entry; `POST /qnap/polecenia` only with the internal token (described below) |
| `core/services/push.service.ts`, `push-watchdog.service.ts`, `models/push-subscription.model.ts`, `controllers/push.controller.ts` | Web Push notifications: event catalogue `PUSH_EVENTS`, `notify`, quiet hours, 60 s threshold, deletion of expired subscriptions, `body` as `Texts {pl, en}` chosen by the recipient's language; offline / online watchdog from the tiles every minute; `/push/*` |
| `core/services/auth.service.ts` (`demoLogin`, `demoAvailable`), `core/middleware/session.ts` (`scrubDemo`), `core/services/access.service.ts` (the `demo` role) | demo mode: a read-only session on the `DEMO_OWNER_EMAIL` account, write blocking, removal of sensitive data from responses |
| `core/services/totp.service.ts`, `core/services/auth.service.ts` (the "phone app code" part) | sign-in with a code from the phone app (TOTP, since 2026-11-13): RFC 6238 codes, base32, AES-256-GCM secret encryption, the shared key database `logowanie` (`totp_klucze`, `totp_uzyte`) via `useDb`; the rules (sign-in step 1, attempt limits, registration, turning off) in `auth.service.ts` |
| `core/services/tile-layout.service.ts`, `tile.service.ts`, `tile-format.ts` | the account's tile layout (`users.deviceOrder`, `hiddenTiles`) and tile data `GET /devices/summary` (from each module's `tile.ts`) |
| `core/i18n.ts` | the server dictionary pl / en: `requestLang(req)` (`Accept-Language` → `users.language` → pl), `t(lang, key, params)`, `both(fn)` (text in both languages for push), `pick`, `tabLabel`, `userLanguage`; it feeds the tile texts (`tile-format.ts`, the modules' `tile.ts` with a `lang` parameter), the `AuthError` / `PushError` errors (`messageFor(lang)`), mails and notifications |

## Files — client (`client/src`)

| File | Role |
|---|---|
| `index.tsx` | entry point: applies the theme (`core/theme.ts`), `DeviceProvider` + `App` |
| `theme.css` | colour tokens of the "Instrument" look: `--bg`, `--card`, `--fg*`, `--line*`, `--accent`, states `--ok-*` / `--warn-*` / `--err-*` / `--run-*`, kind colours `--c-heat`, `--c-water`, `--c-sun`, `--c-switch`, `--c-fire`, `--c-sky`, chart series `--ch-1…4`; the light theme under `:root`, the dark one under `prefers-color-scheme: dark` (without an explicit choice) and `[data-theme="dark"]` |
| `style.css` | global styles: the `header.app-header` bar, the `nav.app-tabs` side menu (from 900 px, `.app-container.has-side`, the `--page-vw` variable), the `nav.bottom-nav` bottom navigation and the "Więcej" sheet, cards, buttons, fields, phone rules |
| `makieta.css` | shared components carried over from the mock-up (`makiety/src/makieta.css`): `.card`, `.hero`, `.kpi`, `.filters`, `.date-nav`, `.segmented`, `.switch`, `.chip`, `.entries`, `.kv`, `.timeline`, `.tile*`, `.modal`, `.banner`; loaded after `style.css` |
| `core/theme.ts` | light / dark / as-system theme: the choice in `localStorage` `chpc.theme`, `data-theme` on `<html>`, light without a choice (since 2026-10-17); `useTheme`, `setTheme` |
| `core/i18n/` | the `pl.ts` / `en.ts` dictionaries (same keys; `en` type-checked as `Record<keyof typeof pl, string>`), `index.ts`: `t`, `tn` (plurals via `Intl.PluralRules`, keys `.one` / `.few` / `.many`), `useLang()` → `{lang, locale, t, tn}` (the component re-renders on change), `getLang` / `setLang` (`localStorage` `chpc.lang`, the `chpc-lang-change` event, `<html lang>`), `format.ts` (dates and numbers in the language's locale); outside components `import { t as tr }`. New text always goes through the dictionary, in both files |
| `core/chartColors.ts` | Recharts chart colours from the tokens (`cc()`), because SVG does not accept `var()` |
| `core/App.tsx` | routing, `AuthGate` (login, completing a new account's data, the "Zapamiętać?" question), `DeviceGuard` (no controller → `/devices`; a new browser session starts from the list), `DeviceRoute` (tabs of a shared controller), bars of pages without tabs (`/devices`, `/account`, `/firmware`), `BottomNav` on a phone; the "Aktywne urządzenie" footer is gone since 2026-10-16 |
| `core/device-types.tsx` | registry: `DeviceType` → `DeviceTypeView` (tile icon, kind name, menu screens, extra routes, "Dane sterownika" dialog fields) |
| `core/types.ts` | `DeviceType`, `WeekDay`, `Device` (with the sharing fields `access`, `tabs`, `owner`), `DeviceProperties`, `DeviceView`, `DeviceTypeView`, `DeviceTile` (tile data) |
| `core/http.ts` | API and WebSocket addresses, requests with the selected controller's `rootId` and `deviceId` and the session and `Accept-Language` headers (language of the server's reply) |
| `core/api.ts` | `DeviceRequests`: list, tile summaries (`/devices/summary`), name, hiding, layout (`setDevicesOrder` with `null` in empty fields), `properties`, firmware update request and cancellation; `WeatherTileRequests`: weather tiles; `AuthRequests`: login, session, account, account language (`setLanguage`) |
| `core/context/DeviceContext.tsx` | selected controller (state + `localStorage` `chpc.selectedDevice`), `deviceLabel` |
| `core/context/AuthContext.tsx` | the user session (`localStorage` `chpc.session`), login by code or link, "Zapamiętaj" (90 days), logout |
| `core/components/Header.tsx` | the controller bar: back arrow, name, Włączony / Wyłączony (the `power` field; since 2026-10-27) and "pracuje" (running) chips (from the tile memory `chpc.deviceTiles.<account id>`), kind description (`deviceSubText`), tabs from the registry (`nav.app-tabs`), `UserMenu`; `BottomNav`: first 4 views + "Więcej" |
| `core/components/UserMenu.tsx`, `ThemeToggle.tsx`, `LangToggle.tsx` | the theme icon (moon / sun: light ↔ dark; also on the login screen), the PL / EN language toggle (login screen) and the account avatar with a menu: name and e-mail, "Moje dane", theme Jasny / Ciemny / Jak system, language Polski / English, "Wyloguj", "Usuń konto" |
| `core/pages/Login/` | the login screen (`.auth-card`): e-mail → code (6 digits, 10 min) or a link from the mail; "system" (since 2026-11-13 without a password) → "Send code" to the address from the server settings or "I already have a code" (emergency code) → code (5 min) → the remember question; an address with a phone (since 2026-11-13, `POST /auth/methods`) → "Code from the app" and "Send a code by e-mail" |
| `core/pages/Account/`, `components/ProfileForm.tsx`, `RememberDialog.tsx`, `account.css` | `/account` "Moje dane": the cards "Moje dane" (e-mail changed via a code, first and last name, address, country, location on a map), "Sesja" and "Usunięcie konta" (`.card-danger`, confirmation by a link from the mail); the "Zapamiętać?" dialog |
| `core/pages/Operations/` | the `/operations` tab (heat pump, tank, switch, boiler): the day's operations log (`GET /operations?date=`, 5 days), the filter Wszystkie / Użytkownik / System, the "Zaplanowane" (scheduled) card (today) and the `.timeline` with a state chip; today refreshed every 30 s and after WebSocket `update` |
| `core/components/DeviceEditModal.tsx` | the "Dane sterownika" dialog (`.modal`): name, kind, SN and Root ID read-only, kind fields from the registry (`DefinitionFields`, e.g. the heat pump configuration), the "Kafelek prosty" toggle for kinds with `SimpleTile` in the registry (`PUT /devices/:rootId {simple}`, account only); from the tile and from the "Sterownik" card |
| `core/components/ControllerCard.tsx`, `ControllerCardTitle.tsx`, `DeviceAddress.tsx` | the "Sterownik" card in the Settings of every kind: pencil (the "Dane sterownika" dialog), the `.kv` list: Nazwa, SN, Root ID (shortened, "kopiuj"), Adres IP (link to the controller pages), Firmware with a state chip, Ostatnie zgłoszenie, the "Aktualizuj firmware" button; the "Poczta" (mail) row (`MailKeyRow`, the mail relay board key) was here from 2026-10-17 to 2026-11-13 |
| `core/components/FirmwareStatus.tsx` | the "Firmware" and "Ostatnie zgłoszenie" rows and the "Aktualizuj firmware" / "Anuluj aktualizację" button (with confirmation) of the "Sterownik" card; state "aktualny" (up to date) / "dostępna wersja X" (version X available) / "zlecona, czeka na sterownik" (requested, waiting for the controller), the kind's hint (`firmwareUpdateHint`); refreshed every 15 s while a request is pending; no button when the version is current, a disabled button with a message while the heat pump compressor runs or a switch relay is on ("Sprężarka pracuje.", "Przekaźnik włączony."; state from `GET /devices/summary`) |
| `core/components/DeviceSharing.tsx` | the "Udostępnianie" card in Settings: the list of people with tabs, the "Udostępnij sterownik" dialog (e-mail, "Pełna aplikacja" with the kind's tabs or "Panel prosty" = `tabs: ['simple']`), changing tabs and revoking access; owner and system user only |
| `core/components/OfflineBanner.tsx` | the red "Offline od …" banner with the reason at the top of a controller screen (`.banner.banner-off`) |
| `core/components/Notification.tsx` | short message at the top of the screen |
| `core/components/icons.tsx`, `pictograms.tsx`, `WeatherIcon.tsx` | shared menu and action icons, kind pictograms, sky icons |
| `core/components/IconButton.tsx`, `iconButton.css` | icon button template (icon only, a danger variant for deletion, label as tooltip and aria-label) |
| `core/components/InfoTip.tsx` | an "i" icon with a tooltip |
| `core/pages/Devices/`, `components/DeviceTileCard.tsx` | the controller list `/devices`: the home weather strip (`.outdoor-strip`; sky icon `WeatherCodeIcon` before the temperature; source “Open-Meteo · X min ago” as text, hidden on a phone), the `.tiles` checkerboard in the fixed mock-up layout (`DeviceTileCard`: header with the kind icon, name, chip and tools, big value, running state, fact fields, warning, switch relays, the "dane sprzed …" footer; since 2026-10-27 a Włączony / Wyłączony chip from the `power` field (heat pump, boiler, tank) instead of Online / Offline, and a missing response is a `note` line with `icon: 'offline'` (the `OfflineIcon` from `OfflineBanner`); `WeatherTileCard` for weather; a controller with `device.simple` draws the kind's `SimpleTile` from the registry — `devices/switch/components/SimpleTile.tsx`, `devices/pellet-boiler-pelux200/components/SimpleTile.tsx`, shared `core/components/simpleTile.css` — the tile is then not a link, the name opens the full views), an auto-fill grid ≥ 300 px (1–4 columns), the "Zmień układ" mode (grid icon in the bar: arrows, eye, "+ kafelek pogody", "Gotowe", an empty row pushes the rest to the bottom of the screen), the status bar with database usage (`/devices/db-stats`, system user); tile data from `GET /devices/summary`, refreshed after WebSocket `update` and periodically. The error bar on a tile has a close button: the browser remembers it (`core/dismissedNotes.ts`) by `note.id` from the server; a new event shows the bar again, and a state without a time (a boiler alarm with the same code, low fuel) after 7 days without occurring. The footer shows the database size on disk in MB (`storageSize` + `indexSize`) |
| `core/components/WeatherTileModal.tsx`, `LocationPicker.tsx` | the "Kafelek pogody" dialog (`.modal`): town search (Open-Meteo geocoder from the browser), coordinates, deletion; location choice on a map (account) |
| `core/pages/Firmware/` | `/firmware/:deviceType` (cog on the tile, system user): the cards "Aktualna wersja" (description, date, size, SHA-256, the "Aktualizacje" switch; the plus opens the "Dodaj wersję" card), "Sterowniki tego rodzaju" (version from the last report, state chip) and "Poprzednie wersje" (restore, delete); outside the device context |
| `core/pages/Weather/` (`index.tsx`, `NowTab`, `DaysTab`, `SunTab`, `HeatingTab`, `AirTab`, `WindTab`, `forecast.ts`, `style.css`), `core/currentPlace.ts` | the weather page `/weather/:id` (click on a weather tile; mock-up `#pogoda-*`): tabs in `?tab=` — Teraz, Najbliższe dni, Słońce i PV (yield forecast fitted to the DTU), Ogrzewanie (DHW window in G12w), Powietrze, Wiatr i opady; current conditions from `GET /weather-tiles`, forecast and air quality directly from Open-Meteo (`forecast.ts`); the "Moja lokalizacja" tile (`current`) with the browser's position |
| `core/components/PushSettingsCard.tsx`, `core/push.ts`, `public/sw.js` | the "Powiadomienia" card on `/account` (this browser's subscription, list of browsers, rules, quiet hours, test), service worker and PushManager subscription registration, receiving notifications and opening the application on click |
| `core/components/PhoneLoginCard.tsx` | the "Logowanie kodem z telefonu" card on `/account` and in the system account "Moje dane": turning on (QR code and the key as text, the first app code), state (since when, in which application), turning off with a phone or e-mail code |
| `core/App.tsx` (`DemoBanner`, `DemoToast`), `core/http.ts`, `core/auth.ts`, `core/types.ts` (`canEditDevice`) | demo mode in the client: the bar, writes stopped with a message, the `chpc.demo` flag, editing only own controllers |
| `public/manifest.webmanifest`, `public/icon-*.png`, `public/.well-known/assetlinks.json`, `index.tsx` (`sw.js` registration) | PWA: manifest with PNG icons, Digital Asset Links for the Android app, service worker with the cached shell (see `public/sw.js` above) |
| `android/` (`twa-manifest.json`, `build.ps1`, `README.md`) | the Android package (TWA, Bubblewrap); the signing key and passwords outside git |

## API

All paths are prefixed with `/api`. Except for the public paths a request needs `?rootId=` (the client adds it automatically, together with `deviceId`). Exception: the controller endpoints in the `controllerPaths` map (below) also accept `?deviceId=` alone.

### The `controllerPaths` map (`core/middleware/device-context.ts`)

The same SN may be registered under several controller kinds (roles of one physical controller), so a controller endpoint has to know which device kind it is looking for. The `controllerPaths` map assigns a kind to a path:

| Path (relative to `/api`) | Kind |
|---|---|
| `/hp/add`, `/pv/add` | `heat_pump` |
| `/water-pressure-tank/add`, `/water-pressure-tank/settings` | `water-pressure-tank` |
| `/pellet-boiler-pelux200/add` | `pellet-boiler-pelux200` |
| `/switch/state`, `/switch/mode` | `switch` (`/switch/mode` is also called by the application, with `rootId`) |

Behaviour for a path in the map:

- no `rootId`, `deviceId` alone: `DeviceModel.findOne({deviceId, deviceType})`; unknown — 404;
- with `rootId` (and possibly `deviceId`): the device by `rootId`; **409** when its `deviceId` differs from the one given or its `deviceType` differs from the path kind (e.g. a pump `rootId` on `/pellet-boiler-pelux200/add`);
- neither `rootId` nor `deviceId` — 400.

Paths outside the map (application, `GET`s, `/device/properties`) require `rootId` and do not check the kind.

| Method and path | Context | Description | Replies |
|---|---|---|---|
| `GET /devices` | public | device list: `rootId`, `deviceType`, `deviceId`, `name` | 200 |
| `POST /devices` | public | manual creation (not used by the client; used by the E2E test) | 201; 400 if the SN exists |
| `POST /devices/register` | public | controller registration `{deviceId, deviceType?, name?, version?, ip?}`; `deviceType` defaults to `heat_pump`; `ip` IPv4 only (others and `0.0.0.0` are ignored) | 201 new, 200 known (+ `settings` for kinds with `controllerSettings`); 400 missing SN / unknown kind |
| `PUT /devices/:rootId` | public | rename `{name}` (empty allowed) | 200; 400; 404 |
| `POST /devices/:rootId/firmware-update` | public | "Aktualizuj": request an update to the offered version, stores `firmwareUpdate {version, requestedAt}`; a WebSocket `operation` wakes the controller | 200 `{version, requestedAt}`; 400 kind without updates (heat pump); 404; 409 no offered version, updates disabled or the controller already has that version |
| `DELETE /devices/:rootId/firmware-update` | public | "Anuluj aktualizację": remove the request (a download already in progress completes) | 200; 404 |
| `GET /device/properties` | `rootId` | device settings | 200; 404 |
| `PUT /device/properties` | `rootId` | save the whole settings object (Mongoose schema validation) | 200; 400 |
| `GET /temperature` | `rootId` | home temperature and home weather `{temperature, temperatureSource, weather}` (boiler sensor, forecast without a fresh reading) | 200 |
| `GET` / `POST /weather-tiles`, `PUT` / `DELETE /weather-tiles/:id` | public (session) | the account's weather tiles `{name, lat, lon, hidden}` with current weather and `nearHome` (within 3 km of home: temperature from the boiler sensor); `home` cannot be deleted; at most 8 | 200; 400; 404 |
| `GET /push/settings`, `POST /push/subscriptions`, `DELETE /push/subscriptions/:id`, `PUT /push/rules`, `POST /push/test` | signed in, no `rootId` | notification settings (VAPID key, subscriptions, rules, event catalogue, controllers), browser subscription, rules `{rules: [{rootId, events}], quietFrom, quietTo}`, test notification | 200; 201; 204; 400; 403; 404; 409; 503 |
| `POST /auth/system` | public | the `system` account code (since 2026-11-13 instead of a password) to the fixed address from the settings (`SYSTEM_EMAIL`, without it `MAIL_ADMIN`) or, without mail or an address, to the server log; an address from the form is ignored, the mail shows the requester's IP; `{password}` (old client) → 400 without a code | 200 `{delivery: "mail" \| "log", expiresInSeconds, resendAfterSeconds}`; 400; 429 (once a minute, 5 an hour, `locked`); 503 mail |
| `POST /auth/system/verify` | public | `{code}` → a `system` account session `{token, created, user}`; 5 wrong codes invalidate the code and lock `system` sign-in for 15 min (429 `locked: true`, `Retry-After`) | 200; 400; 429 |
| `POST /auth/methods` | public | sign-in step 1 without sending a mail: `{email}` (or `system`) → `{email, totp}`; `totp` = the address has a registered phone this server can check | 200; 400 |
| `POST /auth/totp/verify` | public | `{email, code}` the app code (±30 s, once in every application thanks to `totp_uzyte`) → a session like `POST /auth/verify` (a new address creates an account); 5 wrong codes lock the address's phone code for 15 min (429 `locked`), the e-mail code works | 200; 400; 429; 503 key database unavailable |
| `GET /auth/totp`, `POST` / `DELETE /auth/totp/setup`, `POST /auth/totp/confirm`, `POST /auth/totp/disable/code`, `POST /auth/totp/disable` | session | state `{available, enabled, address, app?, since?, reason?}`; registration: the key (base32), `otpauthUrl`, a QR code (PNG) for 10 min, then `{code}` stores the key in `totp_klucze`; turning off `{code}` with a phone or e-mail code (the e-mail code is ordered by `disable/code`; system account: the usual system account code) | 200; 204; 400; 409 already on; 429; 503 |
| `GET /settings`, `PUT /settings` | system user | application settings (`app_settings`) without an extra password (since 2026-11-13); `PUT {values}` changes the given keys; `POST /settings/read` = the old read, the password is ignored | 200; 400; 401; 403 |
| `GET /auth/demo`, `POST /auth/demo` | public | demo mode: availability `{available}` / read-only session (404 without `DEMO_OWNER_EMAIL`, 429 on too many entries) | 200; 404; 429 |
| `PUT /auth/me/language` | session | account language `{language: "pl" | "en"}`, stored in `users.language` and returned by `/auth/me` | 200; 400 |
| `POST /qnap/polecenia` | internal token (only the `--qnap` command on the server) | a trial QNAP command through the connected `co` controller: `{polecenie: "stan" \| "restart_sieci" \| "restart", rootId?}`; waits up to 20 s for `qnap_wynik`; an operations log entry of `co` (described below) | 200 `{id, polecenie, rootId, status, cialo, czasMs, brakOdpowiedziSterownika?}` (`status` 0 = the controller did not connect to the QNAP or did not answer); 400 unknown command or a `rootId` of another kind; 403 without the internal token; 404 unknown `rootId`; 409 no connected `co` or several without `rootId`; 503 no key or address |

The mail relay endpoints (`GET /mail/config`, `GET /mail/next`, `POST /mail/result`, `POST` / `DELETE /devices/:rootId/mail-key`) were removed on 2026-11-13; older firmware gets 404 from them.

WebSocket: `ws(s)://<server>/ws?rootId=<rootId>`. The server sends `{"type":"operation"|"update","rootId":"…"}`; a connection without `rootId` is closed with code 1008. Since 2026-11-13 (trial) a socket that sent the text `ESP32` after connecting (the `co` controller) is a controller socket: only it receives `{"typ":"qnap",…}`, and the server accepts `{"typ":"qnap_wynik",…}` only from it (contract below).

## Data model — `devices` collection

| Field | Type | Description |
|---|---|---|
| `_id` | ObjectId | Root ID |
| `deviceType` | `heat_pump` \| `water-pressure-tank` \| `pellet-boiler-pelux200` \| `switch` | controller kind (role) |
| `deviceId` | string | controller SN (ESP32 MAC, 12 hex characters); devices of different kinds may share an SN (roles of one controller), no unique index |
| `name` | string | user-given name, empty by default |
| `firmwareVersion`, `firmwareSeenAt` | string, Date | firmware version from the registration `version` field and its time; older controllers do not send them |
| `firmwareUpdate` | `{version, requestedAt}` | update request from the application ("Aktualizuj"); only with it does the controller get the firmware offer; removed when the controller reports the offered version, or by "Anuluj aktualizację" |
| `ipAddress`, `ipSeenAt` | string, Date | controller IPv4 address in the local network from the registration `ip` field and its time; without the field the last known one stays; shown in the client as "Adres IP" in Settings (`DeviceAddress`) |
| `properties` | object | settings; heat pump: `co_min`, `co_max`, `cwu_min`, `cwu_max`, `work_mode` (default `CWU`); tank: `compressor_seconds` (1–3600); pellet boiler: `poll_interval_seconds` (integer 30–3600, default 300; seconds between boiler readings sent by the controller); switch: `default_on_minutes` (whole minutes 0–10080, 0 = no limit, default 30) |
| `schedules[]` | object | heat pump schedules (heat-pump module) |
| `createdAt`, `updatedAt` | Date | timestamps |

The device document is shared by all kinds, so `core/models/device.model.ts` imports part schemas from the modules (schedule, legacy pump settings).

## Controller kind registry

**Server** — `core/types.ts`, `DeviceTypeModule`:

```ts
{
  type: DeviceType;
  initialProperties?: DeviceProperties;                       // settings of a new device
  controllerSettings?: (properties: DeviceProperties) => unknown; // settings field in the registration reply
  firmwareUpdates?: boolean;                                  // OTA on an "Aktualizuj" request: offer {version, url, sha256, request}
                                                              // in the registration settings.firmware (switch: also /switch/state, boiler: /commands/next)
  onRegister?: (rootId, deviceId, body) => Promise<void>;     // extra registration fields (switch: relays)
}
```

**Client** — `core/types.ts`, `DeviceTypeView`:

```ts
{
  type: DeviceType;
  tileIcon: ReactNode;                                    // tile icon on the list
  label?: string;                                         // kind name in headers (e.g. the firmware page)
  views: { path, label, icon, element }[];                // screens in menu order; '/' = home page
  extraRoutes?: { path, element }[];                      // routes outside the menu (e.g. the heat pump's /hp)
  DefinitionFields?: ComponentType;                       // extra fields of the "Dane sterownika" dialog (e.g. the pump configuration)
  firmwareUpdates?: boolean;                              // firmware cog on the tile, "Sterownik" card with "Aktualizuj"
  firmwareUpdateHint?: string;                            // when the controller downloads the firmware (hint in the "Sterownik" card)
}
```

### Adding a new controller kind

1. A value in `DeviceType` — in `server/src/core/types.ts` and `client/src/core/types.ts` (the same one).
2. Server: a `server/src/modules/<kind>/` folder with `controllers/`, `services/`, `models/`, `types.ts`, `routes.ts`, `device-type.ts`; an entry in `server/src/core/device-types.ts`; `routes.ts` added in `server/src/core/routes.ts`; paths the controller calls with the SN only — in `controllerPaths` in `device-context.ts`, together with the kind (without an entry the path requires `rootId` and the kind is not checked).
3. Client: a `client/src/devices/<kind>/` folder with `pages/`, `api.ts`, `types.ts`, `device-type.tsx`; an entry in `client/src/core/device-types.tsx`.
4. If the kind has its own settings in `properties`: fields in `DeviceProperties` (both `types.ts`) and in the schema in `device.model.ts`.
5. Firmware: registration with the new `deviceType`.
6. Documentation: `docs/moduly/<kind>/` (three parts, plus `docs/en/`) and an entry in `docs/README.md`.

## Configuration

| Variable (server) | Meaning |
|---|---|
| `MONGODB_URI` | MongoDB connection; required, the server stops without it |
| `PORT` | HTTP and WebSocket port (default 3001) |
| settings in the database | since 2026-11-07 `SMTP_*`, `MAIL_*`, `CLIENT_URL`, `DEMO_OWNER_EMAIL`, `VAPID_*` and `BACKGROUND_JOBS` (off by default, changes apply after a restart) are in the `app_settings` collection and on the system account screen (`GET` / `PUT /api/settings`, since 2026-11-13 without a settings password); `SYSTEM_EMAIL` is the address of the `system` account codes (empty = `MAIL_ADMIN`); since 2026-11-13 also the hidden `QNAP_ADRES` (no field on the screen, `GET /settings` does not show it); an environment variable only applies when the database has no value (local work, tests) |
| `MAIL_RELAY` | removed on 2026-11-13 together with the mail relay through controllers (off since 2026-11-07); the value in `app_settings` is to be removed after the deployment ([database](../../database.md)) and is ignored until then |
| `QNAP_POLECENIA_KLUCZ` | trial QNAP commands (since 2026-11-13): the HMAC key, 32 random bytes written as 64 hex characters, server environment only (never in the database or the repository); the HMAC key is those 32 bytes decoded from hex. Without it `--qnap` gets 503 |
| `QNAP_ADRES` | the QNAP `<address>:<port>` in a private network (10/8, 172.16/12, 192.168/16); a hidden setting in `app_settings` (`--api PUT /settings '{"values":{"QNAP_ADRES":"<address>:<port>"}}'`) or an environment variable; without a valid address `--qnap` gets 503 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push notifications; disabled without the keys (pair: `npx web-push generate-vapid-keys` in `server/`) |
| `DEMO_OWNER_EMAIL` | e-mail of the account shown read-only in demo mode; without a value there is no "Zobacz wersję demo" button |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_ADMIN` | the server's mail account; sender `Mój Dom <SMTP_USER>`, replies to `MAIL_FROM`; without `SMTP_HOST` mails go to an in-memory outbox and the log |
| `CLIENT_URL`, `AUTH_DISABLED=1` | application address in mail links, login disabled (local environment) |
| `SYSTEM_EMAIL` | the address of the "system" account sign-in codes (in the database, Settings → Mail screen); empty = `MAIL_ADMIN`, without both or without mail the code is in the server log. The address is not in the code: the application code is public and someone else's installation would send codes to the owner |
| `SYSTEM_PASSWORD` | ignored since 2026-11-13 (the "system" account signs in with a code); if present in the environment, one warning at startup |
| `LOGOWANIE_KLUCZ`, `LOGIN_KEYS_DB` | sign-in with a phone code (since 2026-11-13), server environment only: the key encrypting phone secrets (32 bytes in plain base64, the same in My Home and Archiwum on one server, never in the database or the repository) and the name of the shared key database (default `logowanie`, test `logowanie_test`; the database account from `MONGODB_URI` needs the `readWrite` role on it). Without the key or without database access the phone code is off and the e-mail code works |
| `INTERNAL_API_URL` | the address of the own API for internal calls and the `--api` command (default `http://127.0.0.1:PORT/api`) |
| `WEATHER_LOCATION` | home coordinates for the "Dom" weather tile |
| `CLIENT_DIR` | directory with the client build served by the server (`core/client-static.ts`); set only by the Docker image |

On the server only `MONGODB_URI`, for the phone code `LOGOWANIE_KLUCZ` and `LOGIN_KEYS_DB`, and since 2026-11-13 (trial) `QNAP_POLECENIA_KLUCZ` are environment variables; the rest is in the `app_settings` collection. Locally the values are in `server/.env` (outside git, template `server/.env.example`).

**Commands on the server (since 2026-11-13, `core/cli.ts`)** run the same file as the server; the server does not start then. In the container on vm-prod (directory `/app/server`, container variables), locally `npm run kod-awaryjny -w server` or `node dist/server.js …` in `server/` after a build:

- `docker exec my-home-prod node dist/server.js --kod-awaryjny` — a one-time `system` account code in the terminal, valid for 5 minutes, without mail; removes the lock after wrong codes and the hourly code limit, invalidates a sent code. It connects only to the database (`MONGODB_URI`), so it also works with the server stopped. On the login screen: "system", "I already have a code".
- `docker exec my-home-test node dist/server.js --kod-totp <KEY>` — the current and the next app code for the base32 key shown under the QR code (phone registration), without the database: checking phone code sign-in without a phone; locally `npm run kod-totp -w server -- <KEY>`.
- `docker exec -i my-home-prod node dist/server.js --api METHOD /path ['{json}'] [--bin < file]` — a request to the server running in the same container with its internal-call token (`core/internal.ts`: random at every start, written by the server to `/tmp/my-home-internal-<PORT>.token`), without an account or a password; replaces scripts that signed in with the old system password. The response goes to standard output, the status to standard error, exit code 0 only for 2xx; the operation log shows the source "Polecenie na serwerze". Uploading firmware: `--api PUT '/firmware/switch/1.3.8?description=…' --bin < switch-1.3.8.bin`, ordering the update: `--api POST /devices/<Root ID>/firmware-update`.
- `docker exec my-home-prod node dist/server.js --qnap stan|restart_sieci|restart [ROOT_ID]` (since 2026-11-13, trial) — a command for the QNAP through the connected `co` controller. It calls the server running in the same container (`POST /qnap/polecenia`, the internal token as in `--api`), because only that server has the WebSocket connection with the controller, and waits up to 20 s for the result. It prints the result (JSON: the QNAP's HTTP status and its answer) to standard output and the request status to standard error; exit code 0 only for status 200, 2 for a wrong command, 1 otherwise. ROOT_ID is needed only when several `co` controllers are connected.

In development the client talks to the server on port 4001 of the same host the page was opened from; in production to the address from `VITE_SERVER_URL`, and without this variable to `https://dom.mojeturnie.pl`. The value `same-origin` means the address the page was opened from. The addresses are in `client/src/core/http.ts`.

## QNAP commands through the `co` controller (trial)

Since 2026-11-13, at the owner's request ("ad 1 zrób"). When the QNAP at home cannot be reached from outside (e.g. its tunnel to the cloud server hangs) but works in the home network, Claude can send it one of three commands through `co`: `stan` (state), `restart_sieci` (network restart), `restart`. When the QNAP network card has no link at all, no network request reaches it. Around 2026-12-13 we check whether it was used; if not, the whole feature is removed: the service on the QNAP, the `qnap` handling in the `co` firmware, the `--qnap` command (`qnap.service.ts`, `qnap.controller.ts`, part of `websocket.ts`) and the key. The binding contract with the service on the QNAP is in the private `oracle-cloud` repository (`qnap/polecenia-przez-co.md`); this repository is public, so there are no addresses or keys here.

1. `--qnap <command> [ROOT_ID]` (`core/cli.ts`) calls `POST /api/qnap/polecenia {polecenie, rootId?}` with the internal token. The controller accepts only this token (403 otherwise); there is no button in the application.
2. The server (`qnap.service.ts`) checks the command (400), the key and the address (503) and picks the connected `co` controller: 409 when there is none or several without `rootId`; 404 unknown `rootId`; 400 a `rootId` of another kind.
3. **Body:** `{"wersja":1,"polecenie":"…","czas":<ms since 1970>,"nonce":"<32 hex characters>"}` in UTF-8, at most 1 KB; `nonce` from `crypto.randomBytes(16)`. **Signature:** HMAC-SHA256 of exactly those bytes; the key is the 32 bytes decoded from the hex `QNAP_POLECENIA_KLUCZ`, the result in lowercase hex.
4. The message `{"typ":"qnap","id":"…","adres":"<QNAP_ADRES>","cialo":"<body text>","podpis":"<hex>"}` goes over the existing WebSocket only to the controller socket of that `co` (`sendToController`); browsers with the same `rootId` do not receive it.
5. The controller sends the body unchanged with `POST http://<address>/polecenie` and the `X-Podpis` header and replies `{"typ":"qnap_wynik","id":"…","status":<HTTP code, 0 = no connection>,"cialo":"<QNAP answer, ≤ 1 KB>"}`. The server accepts the result only from that controller's socket and waits for it up to 20 s (`QNAP_CZEKAJ_MS`); after that it returns status 0 and `brakOdpowiedziSterownika`.
6. **Operations log of `co`:** `QNAP: <polecenie> — HTTP <status>` (or `— sterownik nie połączył się z QNAP-em`, the controller did not connect to the QNAP; `— brak odpowiedzi sterownika w 20 s`, no controller answer in 20 s), status `done` for HTTP 200, `error` otherwise, actor system, source "Polecenie na serwerze (--qnap)". Nothing else goes into the database or `hp/add`; the QNAP answer is only in the command result, and the server console logs only the id and the status.

The controller side is described in the [`co` technical documentation](../../../../devices/co/docs/en/3-technical-documentation.md#qnap-commands-since-140-trial).

## Docker image (Oracle)

On `vm-prod` the server and client run in one image (`deploy/oracle/Dockerfile`). Local development does not use Docker.

| Branch | Channel | Image on `vm-prod` |
|---|---|---|
| `main` | production | `my-home:prod-<commit>` |
| `develop` | test | `my-home:test-<commit>` |

Since 2026-11-08 the server builds the image itself: `oracle-cloud/vm-prod/.deploy-my-home/deploy-my-home.sh prod|test [commit]` sends a `git archive` of the chosen commit (by default `origin/main` or `origin/develop`) over ssh to `docker build` on `vm-prod` and installs it. Only files from git go into the image. Each channel keeps the current version and 2 previous ones. Before that, GitHub Actions built the image and published it to `ghcr.io`.

## Local environment and demo data

```bash
npm run local                    # database (27027, .local-db/), server (4001), application (5173)
node scripts/seed-local.mjs      # clears the local database and loads demo data
```

`scripts/seed-local.mjs` writes to the local database only. From production it reads (public GET) the heat pump telemetry and PV of the last days and replaces the identifiers with made-up ones; it generates the tank data (several months of runs and water meter readings). After loading, restart the local server, because it keeps data in memory.

## Tests

- `server/test/app.test.ts` — devices (registration, name, default, unknown rootId) and the heat pump API; `mongodb-memory-server` database.
- `server/test/water-pressure-tank.test.ts` — among others tank registration with settings, context 404/409.
- `server/test/pellet-boiler-pelux200.test.ts` — among others two roles of the same SN (two `rootId`s, routing by endpoint kind, 409 for a `rootId` of the other role), boiler registration with `settings`, `poll_interval_seconds` validation in `PUT /device/properties`.
- The heat pump's `pv.test.ts` and `scheduler.test.ts` live in the same `server/test/` folder; the server has 218 tests in total (run of 2026-10-21, 17 files, all passing; including the account language, an English mail and error via `Accept-Language`, English push body and tiles).
- `server/test/qnap.test.ts` (since 2026-11-13) — QNAP commands: the HMAC-SHA256 signature (a fixed test vector, the key from hex, not from text) and the body with a random `nonce`, clear errors (internal token only, unknown command, no key, address or connected `co`), the message only to the controller socket, the `qnap_wynik` result and the operations log entry, the `--qnap` command with its exit code.
- The client has no unit tests; the checks are `tsc` and `vite build`, plus the layout test `node test/e2e/run-layout.mjs` (Playwright Chromium; all kinds × views × 360 / 768 / 1280 px × dark / light theme: horizontal scrolling, elements outside the window, console errors, the bar, side menu / bottom navigation).

```bash
npx tsc -p server/tsconfig.tests.json --noEmit
npm test -w server -- --run
npm run build -w client
node test/e2e/run-layout.mjs
```

## Deployment

The server and the client are deployed together from the `main` branch: GitHub builds the image and `oracle-cloud/vm-prod/.deploy-my-home/deploy-my-home.sh prod` installs it. A core change that alters the API needs the server to be deployed before the firmware.

## Known issues

- **Controller endpoints without authorisation.** There is no API key (the inactive `verifyApiKey` and the `x-api-key` header were removed on 2026-10-27); the application is protected by account sessions, and the `controllerPaths` endpoints accept the bare SN.
- **Data in server memory** (`device-info.service.ts`, latest telemetry, manual operations) is lost on restart; after changing `deviceId` in the database the server has to be restarted.
- **The home location** for the weather is hard-coded (`WEATHER_LOCATION` in `meteo.service.ts`).
- **Only the server handles weather and mail** (since 2026-11-13, no fallback in the controllers). When the server gets no weather from Open-Meteo, the tiles show the last reading (up to 45 min), then the forecast; without `SMTP_HOST` mails only go to an in-memory outbox and the server log.
- **A controller socket is recognised only by the `ESP32` greeting** (QNAP commands). The WebSocket has no authentication, so someone who knows the `co` Root ID could receive a signed command or send back a fake result. They cannot change the command without the key, and the service on the QNAP rejects an old or repeated command.
- **SN and kind.** Registration, `POST /devices` and `device-context` for paths in `controllerPaths` look a device up by the pair (kind, SN), so the same SN may have several devices of different kinds (`co` roles). A controller path missing from `controllerPaths` gets 400 for a `deviceId` alone and does not check the kind for a `rootId`; a new controller endpoint has to be added there.
- **`PUT /device/properties` replaces the whole `properties`** — omitted keys disappear. The client always sends the full set of its kind's fields.
- **The device kind is checked only on controller endpoints** (`controllerPaths`: a mismatched kind gives 409). The other module endpoints (e.g. `GET /hp` with a tank's `rootId`) do not check it.
- **A new heat pump gets no `properties`** on registration (the pump's `initialProperties` is empty); the `CWU` mode comes from a fallback in the scheduler.
- **The WebSocket** accepts a connection on any path and does not check that `rootId` exists; a message reaches every connection of that `rootId` (browsers also get `operation`, `co` gets `update`); the exception is `qnap`, which goes only to the controller socket.
- **Client error handling (`core/http.ts`)**: `get` returns `null`, `post` swallows the error (with `json = false` it returns the `Response`), `put` and `delete` throw — so screens show save errors differently.
- **Page styles end up in one CSS bundle** — unprefixed rules in the kinds' `pages/style.css` apply to the whole application; the shared components are in `makieta.css`, and colours come only from the `theme.css` tokens.
