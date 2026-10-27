# Module pellet-boiler-pelux200 — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/pellet-boiler-pelux200/3-dokumentacja-techniczna.md)

## Files — server (`server/src/modules/pellet-boiler-pelux200`)

| File | Role |
|---|---|
| `routes.ts` | routes `/pellet-boiler-pelux200/*` |
| `device-type.ts` | registry entry: default settings of a new boiler (`poll_interval_seconds: 300`), the `settings` field in the registration reply and `firmwareUpdates: true` (OTA on an "Aktualizuj" request, from firmware 1.5.0) |
| `types.ts` | `PelletBoilerPelux200Measurements` (measurement fields), `PelletBoilerPelux200Entry` |
| `controllers/pellet-boiler-pelux200.controller.ts` | `add` (reply with the polling interval), `last`, `list` (Warsaw day) |
| `services/pellet-boiler-pelux200.service.ts` | `validateReading`, save, last reading in memory (`lastByRoot`), time range, `getPollIntervalSeconds` |
| `models/pellet-boiler-pelux200.model.ts` | collection `pellet_boiler_pelux200` |

No scheduler and no operation service. The module imports only from `core` (`device-info`, `DeviceModel`, `websocket`, `time`).

## Files — client (`client/src/devices/pellet-boiler-pelux200`)

| File | Role |
|---|---|
| `device-type.tsx` | registry entry: Kocioł, Dane, Wykres, Harmonogram, Alarmy, Operacje, Ustawienia (flame icon); `firmwareUpdates: true` (firmware cog on the tile, page `/firmware/pellet-boiler-pelux200`) and `firmwareUpdateHint`; "Dane sterownika" dialog fields (`components/BoilerConfigFields.tsx`: linked heat pump) |
| `api.ts` | `PelletBoilerRequests` (`getLast`, `getList`, regulator settings, requests, schedule) |
| `types.ts` | `PelletBoilerReading` and the settings, request and schedule types |
| `pages/Home.tsx` | "Instrument" layout: Offline banner, hero card (boiler temperature, set point, state with a flame, season and mode chips, KPIs), the CWU and mixer cards, "Urządzenia kotła", "Pozostałe"; refresh every 30 s |
| `pages/Data.tsx` | filter bar (day, "Wszystkie parametry", CSV) and the "Odczyty dnia" card (`.table-wrap` with a sticky header) |
| `pages/Chart.tsx` | day temperatures with series chips and a burning band, or burnt pellet; colours from `core/chartColors.ts` |
| `components/SimpleTile.tsx` | the simple tile on the controller list (`DeviceTile.boiler` from `GET /devices/summary`, actions `POST /pellet-boiler-pelux200/simple {action: on \| off \| cwu-on \| cwu-off}`, server `services/pellet-boiler-pelux200-simple.service.ts`) |
| `pages/Schedules.tsx` | the "Harmonogram" card ("Harmonogram działa – mode", "i" tip; with "CWU – grzanie peletem" the "Teraz" state and "działa teraz" come from the Pellet list — `state.pelletCwu` from `GET /schedules/current`) and the entry cards "Tryb Zima · …" / "CWU · …" (`.entries`, "działa teraz", "Poza harmonogramem"), the `.modal` entry dialog |
| `pages/Settings.tsx` | two columns: "Regulator", "Tryb pracy", "Główne parametry" (with the "Nastawy trybów" dialog: `ModeProfiles` with `formId`, the save button in the footer of the `modal-wide` dialog) and "Ostatnie zmiany" (`components/MainParameters.tsx`); the "Odczyt" card (interval in seconds 30–3600), "Ustawienia zaawansowane" (`components/AdvancedSettings.tsx`), the "Sterownik" card (`ControllerCard` from `core`) and "Udostępnianie" |
| `components/Alerts.tsx`, `ui.tsx`, `icons.tsx`, `WinterCycleStatus.tsx`, `ModeProfiles.tsx` | the Alarmy tab, shared elements of the boiler views (`DateNav`, `Segmented`, `CsvButton`, dialog), icons, winter cycle state, mode presets |
| `pages/style.css` | styles of the boiler views |
| `utils/boiler.ts` | state names 0–11, number and time formats (Warsaw), `isStale`, `readingsToCsv`, `downloadText` |

Settings go through the shared `DeviceRequests` in `core/api.ts` (`/device/properties`), not through the module's `api.ts`.

## API

| Method and path | Who | Description |
|---|---|---|
| `POST /pellet-boiler-pelux200/add` | controller | boiler reading (fields below); `deviceId` alone is enough; 404/409 as in core; reply **201** `{poll_interval_seconds}`; 400 "Nieprawidłowy odczyt kotła." for a bad body |
| `GET /pellet-boiler-pelux200/last` | application | the last reading or `{}`; needs `rootId` |
| `GET /pellet-boiler-pelux200/list?date=YYYY-MM-DD` | application | readings of a Warsaw day, descending by `createdAt`; without `date` — today; a bad format gives 400 (`date: YYYY-MM-DD.`) |

Boiler settings are saved by the shared `PUT /device/properties` (core module). Registration (`POST /devices/register`, `deviceType: "pellet-boiler-pelux200"`) returns `settings: {poll_interval_seconds, firmware?}` (`firmware` only with an update request; the boiler controller reads the offer from `commands/next`, below).

### Reading fields

All optional; at least one is required.

| Group | Fields | Type |
|---|---|---|
| state | `state` — 0–11: OFF, STABILIZATION, KINDLING, WORKING, SUPERVISION, PAUSED, STANDBY, BURNING_OFF, ALERT, MANUAL, UNSEALING, OTHER | number |
| temperatures [°C] | `heating_temp`, `feeder_temp`, `water_heater_temp`, `outside_temp`, `return_temp`, `exhaust_temp`, `optical_temp`, `upper_buffer_temp`, `lower_buffer_temp` | number |
| targets and statuses | `heating_target`, `water_heater_target` (°C), `heating_status`, `water_heater_status` (code) | number |
| operation | `fuel_level` [%], `fan_power` [%], `boiler_load` [%], `boiler_power` [kW], `fuel_consumption` [kg/h], `lambda_level` [%] | number |
| outputs | `fan`, `feeder`, `heating_pump`, `water_heater_pump`, `circulation_pump`, `lighter`, `alarm` | boolean |

Validation (`validateReading`): the body has to be an object (not an array); a numeric field has to be a finite number (not a string, `null`, `NaN`), a logical field of type `boolean` (not `1`); omitted fields are allowed; no measurement field at all (e.g. `time` alone) is a 400. Value ranges are not checked. Unknown keys and `time` are ignored, and the Mongoose schema is strict — **a new field has to be added in `types.ts`, in `validateReading` (the field lists), in the model, in the client types and in the views**.

## Data model

**`pellet_boiler_pelux200`** — one boiler reading:

| Field | Description |
|---|---|
| `rootId`, `deviceType`, `deviceId` | identification (added by the server from `device-info`) |
| reading fields | as in the table above |
| `createdAt`, `updatedAt` | write timestamps; `createdAt` is the time of receipt (the server ignores the controller's `time`) |

Index: `{rootId, createdAt: -1}`. No data expiry.

**`devices.properties`** of the boiler: `poll_interval_seconds` — an integer 30–3600 (default 300). The schema (`core/models/device.model.ts`) checks the range and integrality, so `PUT /device/properties` with an out-of-range or fractional value gives 400 and leaves the stored value unchanged.

## Constants

| Constant | Value | Where |
|---|---|---|
| `DEFAULT_POLL_INTERVAL_SECONDS` | 300 | service, `device-type.ts` |
| `poll_interval_seconds` range | 30–3600 s | `properties` schema; client form 0.5–60 min |
| Kocioł view refresh | 30 s | `Home.tsx` |
| stale reading | `3 × poll_interval_seconds` | `utils/boiler.ts` (`isStale`), `DEFAULT_POLL_SECONDS` = 300 |
| reading age limit on the controller | 60 s | boiler controller firmware (`READING_MAX_AGE_MS` in `devices/pellet-boiler-pelux200/src/firmware.hpp`) |

## Contract with the boiler controller

The boiler controller is a separate ESP32-C3 SuperMini board with an HW-519 RS-485 module (`devices/pellet-boiler-pelux200`, since 2026-10-03; before that, a second role of the `co` controller). The contract did not change.

- Registration at every start: `POST /devices/register` `{deviceId: SN, deviceType: "pellet-boiler-pelux200", name: "Piec Pellux 200", version, ip}`; reply 201/200 with `rootId` and `settings.poll_interval_seconds`; the Root ID and the interval are kept in NVS (namespace `pel`, keys `root_id`, `poll_s`). A failed registration is retried every 30 s.
- Sending: `POST /api/pellet-boiler-pelux200/add?deviceId=SN&rootId=…` every `poll_interval_seconds` (without `time`). A failed send is retried after 60 s; 404/409 drop the Root ID and start the registration again.
- Firmware update (OTA, from firmware 1.5.0): only on an "Aktualizuj" request in Settings (`POST /devices/:rootId/firmware-update`, core module). The controller polls `GET /pellet-boiler-pelux200/commands/next` every 15 s; with a request the reply is `{firmware: {version, url, sha256, request}}` **instead of** a parameter command (parameter commands wait until the update is done). The controller downloads the image when no parameter command or settings read is in progress, checks SHA-256 and restarts; registering with the new version clears the request. Firmware 1.4.0 has no OTA, so 1.5.0 is flashed once over USB or the controller's `/install`.
- Context: `controllerPaths` in `core/middleware/device-context.ts` contains `/pellet-boiler-pelux200/add` → `pellet-boiler-pelux200`. Details in the [core module](../core/3-technical-documentation.md).
- Firmware code: `devices/pellet-boiler-pelux200/src/pellet.cpp` (registration, sending, pages, OTA download), `ota.*`, `ecomax_frame.*`, `pellet_telemetry.*`, `bus_polarity.*`; description: [controller README](../../../../devices/pellet-boiler-pelux200/README.md) and [piec-pellux200.md](../../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md) (both Polish).

## Tests

```bash
npm test -w server -- --run       # pellet-boiler-pelux200.test.ts: 8 tests (server in total: 81)
npx tsc -p server/tsconfig.tests.json --noEmit
npm run build -w client
```

`server/test/pellet-boiler-pelux200.test.ts` checks: registration with the 300 s setting in `settings`, two roles of the same SN (two `rootId`s, routing by endpoint kind, 409 for a `rootId` of the other role), saving a reading while skipping unknown fields and `time` and replying with the interval, 400 (empty body, `time` alone, fields of the wrong type), 404 for an unknown `deviceId` and 409 for another device's `rootId`, `last` (`{}`, then the newest, 400 without `rootId`), `list` (Warsaw day boundaries, descending, 400 for a bad date), saving and validating `poll_interval_seconds` through `PUT /device/properties` and returning it in the reply to a reading.

The client has no unit tests; the checks are `tsc` and `vite build`.

## Known issues

- **Frame format not verified on a boiler.** The `SensorData` decoder and its assumptions (sender `0x45`, the alert counter, subtracting 101 from the fuel level) come from PyPlumIO; the 115200 baud rate and the connection point (G2 of module A) have not been checked on a boiler; the boiler controller board (receiving on GPIO21) has only been checked on a desk. The listening has to be verified before anything is transmitted.
- **Stage 2 does not exist.** No transmitting onto the boiler bus, no reply to `CheckDevice` and no control; the server has no boiler operations or scheduler.
- **`lambda_level`** is in the contract, the schema and the types, but the boiler controller firmware does not fill it (the view shows `---`).
- **`heating_status` and `water_heater_status`** are raw numbers of undocumented meaning.
- **The HTTP send blocks the boiler controller loop** for a few seconds; the UART buffer (4 KB) drops the excess and the parser resynchronises.
- **`PUT /device/properties` replaces the whole `properties`** — the client has to send the full set of fields (the boiler Settings extend the loaded object).
- **No charts, aggregates or data expiry.** The history grows without limit (a reading every 5 minutes is about 288 records a day).
- **The last reading in server memory** (`lastByRoot`) is restored from the database after a restart; there is no other in-memory state.
- **Value ranges** (e.g. `state` 0–11, percentages 0–100) are not checked on the server; the view shows `Stan N` for a state outside the list.
