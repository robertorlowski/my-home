# Core module — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/core/3-dokumentacja-techniczna.md)

## Files — server (`server/src`)

| File | Role |
|---|---|
| `server.ts` | entry point: MongoDB, heat pump scheduler, PV panel cleanup, weather, HTTP and WebSocket listening |
| `core/app.ts` | Express application: CORS, JSON, `device-context` and routes under `/api` |
| `core/routes.ts` | assembles the routes: devices and `/temperature` from core plus each module's `routes.ts` |
| `core/types.ts` | `DeviceType`, `WeekDay` (schedule days of the heat pump and the switch), `Device`, `DeviceProperties` (one settings field for all kinds), `DeviceTypeModule` |
| `core/device-types.ts` | controller kind registry: `DeviceType` → module description (`device-type.ts`) |
| `core/time.ts` | `TIME_ZONE = Europe/Warsaw`, Warsaw day boundaries as a UTC range |
| `core/websocket.ts` | WebSocket server (`/ws?rootId=`), `sendMessage(type, rootId)` with a 1 s delay |
| `core/middleware/device-context.ts` | resolves the device from `rootId` or (for controller paths in the `controllerPaths` map) from the pair `{deviceId, deviceType}`; 400/404/409 |
| `core/models/device.model.ts` | Mongoose model `devices`: device schema, `properties`, embedded schedules and legacy `settings` |
| `core/controllers/device.controller.ts` | device routes; the registration reply includes `settings` from the registry; firmware update request and its cancellation |
| `core/controllers/meteo.controller.ts` | `GET /temperature` |
| `core/controllers/firmware.controller.ts` | `/firmware/:kind...`: state, file upload, offer, download; only kinds with `firmwareUpdates` |
| `core/models/firmware.model.ts` | `firmware_images` (`.bin` file, size, SHA-256) and `firmware_offers` (offered and previous version, `enabled`) |
| `core/services/firmware.service.ts` | image validation and storage (ESP32 header, ≤ 1,310,720 B), update request (`requestFirmwareUpdate`, `cancelFirmwareUpdate`), offer for the controller only with a request (`firmwareOfferForDevice`, `firmwareOfferForRoot`), pruning to the current and one previous version |
| `core/services/device.service.ts` | list, create, register, name, default, read and write `properties` |
| `core/services/device-info.service.ts` | device kind and `deviceId` cached in memory (for module data records) |
| `core/services/calendar.service.ts` | Polish holidays, day of the week in Warsaw, `scheduleDayMatches` (whether a switch schedule entry applies to a given date) |
| `core/services/meteo.service.ts` | temperature from the IMGW Zakopane station; weather from the switch kept in memory by tile id (the home also under `home`), readings older than 45 min ignored; home temperature from the boiler sensor or the forecast |
| `core/services/weather-tile.service.ts`, `models/weather-tile.model.ts`, `controllers/weather-tile.controller.ts` | weather tiles `weather_tiles` (`home` from `WEATHER_LOCATION`, at most 8 per account), `weatherQueries` — places for the switch |
| `core/services/mail.service.ts` | `sendMail`: with `MAIL_RELAY=1` composes MIME (`MailComposer`) and queues it in `mail_outbox`, otherwise direct SMTP; `assertMailAvailable` (503 without a controller); the body in Polish or English (`lang`: the recipient's account language, otherwise the request's; `mailLang`) |
| `core/services/mail-relay.service.ts`, `models/mail-outbox.model.ts`, `controllers/mail-relay.controller.ts` | mail relay: board keys (`mailKey`, `mailKeyPending`, approval), `encryptFor` encryption (ECDH P-256 + AES-256-GCM), mail queue and lease (`FAILOVER_MS` 20 s, `LEASE_MS` 60 s, 3 attempts, 15 min), `GET /mail/config`, `GET /mail/next`, `POST /mail/result` |
| `core/services/push.service.ts`, `push-watchdog.service.ts`, `models/push-subscription.model.ts`, `controllers/push.controller.ts` | Web Push notifications: event catalogue `PUSH_EVENTS`, `notify`, quiet hours, 60 s threshold, deletion of expired subscriptions, `body` as `Texts {pl, en}` chosen by the recipient's language; offline / online watchdog from the tiles every minute; `/push/*` |
| `core/services/auth.service.ts` (`demoLogin`, `demoAvailable`), `core/middleware/session.ts` (`scrubDemo`), `core/services/access.service.ts` (the `demo` role) | demo mode: a read-only session on the `DEMO_OWNER_EMAIL` account, write blocking, removal of sensitive data from responses |
| `core/services/tile-layout.service.ts`, `tile.service.ts`, `tile-format.ts` | the account's tile layout (`users.deviceOrder`, `hiddenTiles`) and tile data `GET /devices/summary` (from each module's `tile.ts`) |
| `core/i18n.ts` | the server dictionary pl / en: `requestLang(req)` (`Accept-Language` → `users.language` → pl), `t(lang, key, params)`, `both(fn)` (text in both languages for push), `pick`, `tabLabel`, `userLanguage`; it feeds the tile texts (`tile-format.ts`, the modules' `tile.ts` with a `lang` parameter), the `AuthError` / `PushError` / `MailUnavailableError` errors (`messageFor(lang)`), mails and notifications |

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
| `core/pages/Login/` | the login screen (`.auth-card`): e-mail → code (6 digits, 10 min) or a link from the mail; "system" shows the system user's password field |
| `core/pages/Account/`, `components/ProfileForm.tsx`, `RememberDialog.tsx`, `account.css` | `/account` "Moje dane": the cards "Moje dane" (e-mail changed via a code, first and last name, address, country, location on a map), "Sesja" and "Usunięcie konta" (`.card-danger`, confirmation by a link from the mail); the "Zapamiętać?" dialog |
| `core/pages/Operations/` | the `/operations` tab (heat pump, tank, switch, boiler): the day's operations log (`GET /operations?date=`, 5 days), the filter Wszystkie / Użytkownik / System, the "Zaplanowane" (scheduled) card (today) and the `.timeline` with a state chip; today refreshed every 30 s and after WebSocket `update` |
| `core/components/DeviceEditModal.tsx` | the "Dane sterownika" dialog (`.modal`): name, kind, SN and Root ID read-only, kind fields from the registry (`DefinitionFields`, e.g. the heat pump configuration), the "Kafelek prosty" toggle for kinds with `SimpleTile` in the registry (`PUT /devices/:rootId {simple}`, account only); from the tile and from the "Sterownik" card |
| `core/components/ControllerCard.tsx`, `ControllerCardTitle.tsx`, `DeviceAddress.tsx` | the "Sterownik" card in the Settings of every kind: pencil (the "Dane sterownika" dialog), the `.kv` list: Nazwa, SN, Root ID (shortened, "kopiuj"), Adres IP (link to the controller pages), Firmware with a state chip, Ostatnie zgłoszenie, the "Aktualizuj firmware" button |
| `core/components/FirmwareStatus.tsx` | the "Firmware" and "Ostatnie zgłoszenie" rows and the "Aktualizuj firmware" / "Anuluj aktualizację" button (with confirmation) of the "Sterownik" card; state "aktualny" (up to date) / "dostępna wersja X" (version X available) / "zlecona, czeka na sterownik" (requested, waiting for the controller), the kind's hint (`firmwareUpdateHint`); refreshed every 15 s while a request is pending; no button when the version is current, a disabled button with a message while the heat pump compressor runs or a switch relay is on ("Sprężarka pracuje.", "Przekaźnik włączony."; state from `GET /devices/summary`) |
| `core/components/DeviceSharing.tsx` | the "Udostępnianie" card in Settings: the list of people with tabs, the "Udostępnij sterownik" dialog (e-mail, "Pełna aplikacja" with the kind's tabs or "Panel prosty" = `tabs: ['simple']`), changing tabs and revoking access; owner and system user only |
| `core/components/OfflineBanner.tsx` | the red "Offline od …" banner with the reason at the top of a controller screen (`.banner.banner-off`) |
| `core/components/Notification.tsx` | short message at the top of the screen |
| `core/components/icons.tsx`, `pictograms.tsx`, `WeatherIcon.tsx` | shared menu and action icons, kind pictograms, sky icons |
| `core/components/IconButton.tsx`, `iconButton.css` | icon button template (icon only, a danger variant for deletion, label as tooltip and aria-label) |
| `core/components/InfoTip.tsx` | an "i" icon with a tooltip |
| `core/pages/Devices/`, `components/DeviceTileCard.tsx` | the controller list `/devices`: the home weather strip (`.outdoor-strip`; sky icon `WeatherCodeIcon` before the temperature; source “Open-Meteo · X min ago” as text, hidden on a phone), the `.tiles` checkerboard in the fixed mock-up layout (`DeviceTileCard`: header with the kind icon, name, chip and tools, big value, running state, fact fields, warning, switch relays, the "dane sprzed …" footer; since 2026-10-27 a Włączony / Wyłączony chip from the `power` field (heat pump, boiler, tank) instead of Online / Offline, and a missing response is a `note` line with `icon: 'offline'` (the `OfflineIcon` from `OfflineBanner`); `WeatherTileCard` for weather; a controller with `device.simple` draws the kind's `SimpleTile` from the registry — `devices/switch/components/SimpleTile.tsx`, `devices/pellet-boiler-pelux200/components/SimpleTile.tsx`, shared `core/components/simpleTile.css` — the tile is then not a link, the name opens the full views), an auto-fill grid ≥ 300 px (1–4 columns), the "Zmień układ" mode (grid icon in the bar: arrows, eye, "+ kafelek pogody", "Gotowe", an empty row pushes the rest to the bottom of the screen), the status bar with database usage (`/devices/db-stats`, system user); tile data from `GET /devices/summary`, refreshed after WebSocket `update` and periodically |
| `core/components/WeatherTileModal.tsx`, `LocationPicker.tsx` | the "Kafelek pogody" dialog (`.modal`): town search (Open-Meteo geocoder from the browser), coordinates, deletion; location choice on a map (account) |
| `core/pages/Firmware/` | `/firmware/:deviceType` (cog on the tile, system user): the cards "Aktualna wersja" (description, date, size, SHA-256, the "Aktualizacje" switch; the plus opens the "Dodaj wersję" card), "Sterowniki tego rodzaju" (version from the last report, state chip) and "Poprzednie wersje" (restore, delete); outside the device context |
| `core/pages/Weather/` (`index.tsx`, `NowTab`, `DaysTab`, `SunTab`, `HeatingTab`, `AirTab`, `WindTab`, `forecast.ts`, `style.css`), `core/currentPlace.ts` | the weather page `/weather/:id` (click on a weather tile; mock-up `#pogoda-*`): tabs in `?tab=` — Teraz, Najbliższe dni, Słońce i PV (yield forecast fitted to the DTU), Ogrzewanie (DHW window in G12w), Powietrze, Wiatr i opady; current conditions from `GET /weather-tiles`, forecast and air quality directly from Open-Meteo (`forecast.ts`); the "Moja lokalizacja" tile (`current`) with the browser's position |
| `core/components/MailKeyRow.tsx` | the "Poczta" row of the "Sterownik" card (switch, heat pump): board key state (approved / pending / none, fingerprint), "Zatwierdź" after comparing with `/install` and "Usuń" — system user only |
| `core/components/PushSettingsCard.tsx`, `core/push.ts`, `public/sw.js` | the "Powiadomienia" card on `/account` (this browser's subscription, list of browsers, rules, quiet hours, test), service worker and PushManager subscription registration, receiving notifications and opening the application on click |
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
| `POST` / `DELETE /devices/:rootId/mail-key` | public (system user) | approve `{fingerprint}` / remove the mail relay board key | 200; 403; 404; 409 |
| `GET /push/settings`, `POST /push/subscriptions`, `DELETE /push/subscriptions/:id`, `PUT /push/rules`, `POST /push/test` | signed in, no `rootId` | notification settings (VAPID key, subscriptions, rules, event catalogue, controllers), browser subscription, rules `{rules: [{rootId, events}], quietFrom, quietTo}`, test notification | 200; 201; 204; 400; 403; 404; 409; 503 |
| `GET /auth/demo`, `POST /auth/demo` | public | demo mode: availability `{available}` / read-only session (404 without `DEMO_OWNER_EMAIL`, 429 on too many entries) | 200; 404; 429 |
| `PUT /auth/me/language` | session | account language `{language: "pl" | "en"}`, stored in `users.language` and returned by `/auth/me` | 200; 400 |
| `GET /mail/config`, `GET /mail/next`, `POST /mail/result` | controller (`?rootId=&deviceId=`, no login) | SMTP credentials encrypted with the board key; next mail (encrypted, leased); result `{id, ok, receipt, error?}` | 200; 204 no mail; 403 key not approved |

WebSocket: `ws(s)://<server>/ws?rootId=<rootId>`. The server sends `{"type":"operation"|"update","rootId":"…"}`; a connection without `rootId` is closed with code 1008.

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
| `MAIL_RELAY=1` | the controllers send the mail (mail relay) instead of the server; mandatory on Render, whose free plan blocks SMTP (ports 25, 465, 587) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push notifications; disabled without the keys (pair: `npx web-push generate-vapid-keys` in `server/`) |
| `DEMO_OWNER_EMAIL` | e-mail of the account shown read-only in demo mode; without a value there is no "Zobacz wersję demo" button |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_ADMIN` | the mail account (with `MAIL_RELAY=1` handed to the boards encrypted); sender `MyHome <SMTP_USER>`, replies to `MAIL_FROM` |
| `CLIENT_URL`, `SYSTEM_PASSWORD`, `INITIAL_OWNER_EMAIL`, `AUTH_DISABLED=1` | application address in mail links, the "system" account password, the first owner, login disabled (local environment) |
| `WEATHER_LOCATION` | home coordinates for the "Dom" weather tile |

Values live only in environment variables: on Render in the service Environment, locally in `server/.env` (outside git, template `server/.env.example`).

In development the client talks to the server on port 4001 of the same host the page was opened from; in production to `https://chpc-web.onrender.com`. The addresses are in `client/src/core/http.ts`.

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
- The client has no unit tests; the checks are `tsc` and `vite build`, plus the layout test `node test/e2e/run-layout.mjs` (Playwright Chromium; all kinds × views × 360 / 768 / 1280 px × dark / light theme: horizontal scrolling, elements outside the window, console errors, the bar, side menu / bottom navigation).

```bash
npx tsc -p server/tsconfig.tests.json --noEmit
npm test -w server -- --run
npm run build -w client
node test/e2e/run-layout.mjs
```

## Deployment

The server and the client are deployed together from the `main` branch to Render (build started manually). A core change that alters the API needs the server to be deployed before the firmware.

## Known issues

- **Controller endpoints without authorisation.** There is no API key (the inactive `verifyApiKey` and the `x-api-key` header were removed on 2026-10-27); the application is protected by account sessions, and the `controllerPaths` endpoints accept the bare SN.
- **Data in server memory** (`device-info.service.ts`, latest telemetry, manual operations) is lost on restart; after changing `deviceId` in the database the server has to be restarted.
- **The IMGW station** is hard-coded (`meteo.service.ts`, Zakopane).
- **Mail and weather depend on the controllers at home.** Without the switch (and `co` with an approved key) login by code gets 503 and the tile weather is not refreshed (the forecast remains). The `/mail/*` endpoints accept the bare SN; without key approval in the application someone who knows the SN could plant their own key — hence a new key waits for the system user.
- **SN and kind.** Registration, `POST /devices` and `device-context` for paths in `controllerPaths` look a device up by the pair (kind, SN), so the same SN may have several devices of different kinds (`co` roles). A controller path missing from `controllerPaths` gets 400 for a `deviceId` alone and does not check the kind for a `rootId`; a new controller endpoint has to be added there.
- **`PUT /device/properties` replaces the whole `properties`** — omitted keys disappear. The client always sends the full set of its kind's fields.
- **The device kind is checked only on controller endpoints** (`controllerPaths`: a mismatched kind gives 409). The other module endpoints (e.g. `GET /hp` with a tank's `rootId`) do not check it.
- **A new heat pump gets no `properties`** on registration (the pump's `initialProperties` is empty); the `CWU` mode comes from a fallback in the scheduler.
- **The WebSocket** accepts a connection on any path and does not check that `rootId` exists; a message reaches every connection of that `rootId` (browsers also get `operation`, `co` gets `update`).
- **Client error handling (`core/http.ts`)**: `get` returns `null`, `post` swallows the error (with `json = false` it returns the `Response`), `put` and `delete` throw — so screens show save errors differently.
- **Page styles end up in one CSS bundle** — unprefixed rules in the kinds' `pages/style.css` apply to the whole application; the shared components are in `makieta.css`, and colours come only from the `theme.css` tokens.
