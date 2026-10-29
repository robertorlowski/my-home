# Switch module — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/switch/3-dokumentacja-techniczna.md)

## Files — server (`server/src/modules/switch`)

| File | Role |
|---|---|
| `routes.ts` | `/switch/*` routes |
| `device-type.ts` | registry entry: `initialProperties` (`default_on_minutes: 30`), `controllerSettings` (`{default_on_minutes}` in the registration reply), `firmwareUpdates: true` (OTA on an "Aktualizuj" request), `onRegister` (relays from the `relays` field of the registration) |
| `types.ts` | `RelayMode`, `CommandSource`, `ActivationSource`, `SwitchRelay`, `SwitchSchedule`, `SwitchActivation`, `RelayReport`, `RelayCommand`, `timePattern` |
| `controllers/switch.controller.ts` | route handlers; waking the controller (`sendMessage('operation')`) after a mode or schedule change, `update` for browsers after a state change; firmware offer in the state reply (`firmwareOfferForRoot`) |
| `services/switch.service.ts` | relays (`ensureRelays`), command (`relayCommand`), state report (`parseStateReport`, `reportState`), history (`recordActivation`), mode (`setRelayMode`), names, list for the application (`listRelays`), activations (`listActivations`) |
| `services/switch-schedule.service.ts` | schedule windows (`scheduleWindow`, `activeSchedule` with window merging, `nextScheduleStart`), entry validation (`parseSchedule`), create, replace, delete |
| `models/switch-relay.model.ts` | `switch_relays` collection |
| `models/switch-schedule.model.ts` | `switch_schedules` collection |
| `models/switch-activation.model.ts` | `switch_activations` collection |

Changes in `core` for the switch: `DeviceType.SWITCH`, `WeekDay` moved to `core/types.ts` (the heat-pump module re-exports it), `scheduleDayMatches` in `core/services/calendar.service.ts` (whether an entry applies to a given date in Warsaw), `onRegister` in `DeviceTypeModule` (called by `POST /devices/register` after the device is stored), `default_on_minutes` in `DeviceProperties` and the `properties` schema, the paths `/switch/state` and `/switch/mode` in `controllerPaths`.

## Files — client (`client/src/devices/switch`)

| File | Role |
|---|---|
| `device-type.tsx` | registry entry: switch icon, menu Włącznik, Harmonogram, Ustawienia, Dane, Operacje (no chart), `firmwareUpdates: true`, `firmwareUpdateHint` |
| `api.ts` | `SwitchRequests` |
| `types.ts` | `RelayMode`, `SwitchRelay`, `SwitchSchedule`, `SwitchActivation` |
| `pages/Home.tsx` | "Instrument" layout: a `.card-relay` card per relay (state switch, mode description, Offline banner, countdown or next start, Włącz / Wyłącz / Harmonogram, on time h / min), the "Dziś" card; refresh every 5 s and WebSocket `update` |
| `pages/Data.tsx` | filter bar (day via arrows or calendar, relay buttons, CSV) and the "Włączenia w dniu" card (`components/ActivationsTable.tsx`) |
| `pages/Schedules.tsx` | a card per relay with a mode chip and the `.entries` list ("działa teraz", inactive entries greyed out), the `.modal` entry dialog |
| `pages/Settings.tsx` | two columns: the "Przekaźniki" and "Czas włączenia" cards, on the right the "Sterownik" card (`ControllerCard` from `core`) and "Udostępnianie" (`DeviceSharing`) |
| `components/ActivationsTable.tsx`, `components/icons.tsx` | activations table (main view and Data), switch icons |
| `pages/style.css` | switch view styles |
| `utils/format.ts` | Warsaw times, mode description (`describeMode`), countdown, time within a day for activations across midnight (`secondsInDay`), CSV |

## API

| Method and path | Who | Description |
|---|---|---|
| `POST /switch/state` | controller | `{uptimeS?, relays: [{on, changedS}], diag?, weather?}` (`diag` — firmware diagnostics, `weather` — Open-Meteo weather, CLAUDE.md section 5d; 1–16 relays, `changedS` ≥ 0); `deviceId` alone is enough, 404/409 as in core; reply 200 `{relays: [{on, offAfterS?, mode}], firmware?}` (`firmware: {version, url, sha256, request}` only with an "Aktualizuj" request; firmware from 1.1.0 updates from it without a restart); bad data 400 |
| `PUT /switch/mode` | application, controller | `{relay, mode, minutes?, source?}`; `mode`: `schedule`, `on`, `timer`, `off`, `pause` (off until the end of the current schedule window, outside a window = `schedule`); `minutes` only for `timer`, whole 1–10080; `source: "controller"` or a request with `deviceId` only = change from the controller; reply: the relay as in `GET /switch/relays`; 400 bad mode, number, time or unknown relay |
| `GET /switch/relays` | application | relays: `relay`, `name`, `mode` (an expired timer or pause already as `schedule`), `modeSource`, `modeChangedAt`, `on`, `changedAt`, `lastSeenAt`, `online`, `desiredOn`, `until`, `scheduleId` (entry active now), `nextStart` |
| `PUT /switch/relays/:relay` | application | `{name}` (at most 40 characters, empty = "Przekaźnik N"); 404 unknown relay |
| `GET /switch/schedules` | application | all entries (disabled ones too), by relay and start time |
| `POST /switch/schedules` | application | `{relay, dayOfWeek \| date, startTime, endTime, enabled?}`; `relay` 1…number of relays, times `HH:mm`, `dayOfWeek` −3…6 (without `date`); 201; 400 with an error message |
| `PUT /switch/schedules/:id` | application | full replacement of the entry (an omitted `date` or `dayOfWeek` disappears); 404; 400 |
| `DELETE /switch/schedules/:id` | application | 200 `{}`; 404; 400 bad id |
| `GET /switch/activations?date=YYYY-MM-DD[&relay=N]` | application | activations overlapping the day (Warsaw), including those started the day before and ongoing ones, ascending by `onAt`, with `durationS` (up to now for ongoing ones); the application filters by relay itself and does not use `relay` |
| `GET /switch/diagnostics` | application | last controller diagnostics from server memory (until restart) or `{}`: `reset`, `resetText`, `boot`, `bootAt`, `uptimeS`, `wifiDrops`, `rssi`, `httpMs`, `at`; from firmware 1.3.2 also `heapFree`, `heapMin`, `heapBlock` (bytes) and `weather {places, ok, fail, code, tls, heapBlock, agoS}` (fields described in the switch firmware technical documentation) |

The registration (`POST /devices/register`, core module) with `deviceType: "switch"` additionally accepts `relays` (integer 1–16): `onRegister` creates the relays at once. The reply carries `settings: {default_on_minutes, firmware?}` (`firmware` only with an update request, `POST /devices/:rootId/firmware-update`, core module). The setting is stored by the shared `PUT /device/properties` (core module).

## Data model

**`switch_relays`** — one document per `{rootId, relay}` (unique index):

| Field | Description |
|---|---|
| `rootId`, `deviceId`, `relay` | identification; `relay` from 1 |
| `name` | name (≤ 40 characters, empty by default) |
| `mode`, `until` | mode `schedule` \| `on` \| `timer` \| `off` \| `pause` (default `schedule`); `until` — end of `timer` or `pause` mode |
| `modeSource`, `modeChangedAt` | who set the mode and when (`app` \| `controller`) |
| `on`, `changedAt` | state reported by the controller and the moment it changed (`now − changedS`) |
| `lastSeenAt` | last state report (online < 5 min) |
| `createdAt`, `updatedAt` | write timestamps |

**`switch_schedules`** — schedule entries: `rootId`, `relay`, `enabled`, `dayOfWeek` (`WeekDay`), `date`, `startTime`, `endTime` (`HH:mm`); index `{rootId, relay}`. A separate collection rather than `devices.schedules`: an entry has a relay number and none of the pump fields (type, temperatures, force).

**`switch_activations`** — one activation: `rootId`, `deviceId`, `relay`, `onAt`, `offAt` (`null` = ongoing), `source` (`schedule` \| `app` \| `controller`), `approximate`; indexes `{rootId, onAt}` and `{rootId, relay, offAt}`.

**`devices.properties`** of the switch: `default_on_minutes` — default "Włącz" time in whole minutes 0–10080 (0 = no limit), 30 by default.

## Constants

| Constant | Value | Where |
|---|---|---|
| `MAX_RELAYS` | 16 | `switch.service.ts` (firmware: 8) |
| `MAX_TIMER_MINUTES` | 10080 (7 days) | `switch.service.ts`, `properties` schema, firmware `MAX_ON_MINUTES` |
| `OFFLINE_AFTER_MS` | 5 min | `switch.service.ts` |
| `BOOT_MARGIN_S` | 5 s (margin when detecting a restart and a new activation) | `switch.service.ts` |
| `nextStart` search | 8 days | `switch-schedule.service.ts` |
| window merging | at most 16 steps | `activeSchedule` |
| default settings | `default_on_minutes` = 30 | `device-type.ts` |

## Tests and tools

```bash
npm test -w server -- --run       # server/test/switch.test.ts: 13 tests (server total: 109)
node scripts/simulate-switch.mjs [--relays N] [--history]   # controller simulator (npm run local)
```

`server/test/switch.test.ts` checks: merging of touching windows, a window across midnight belonging to its start day, working days without holidays and the exclusive window end, the next activation, registration creating relays and returning the default time, commands in every mode (including the end of a timer), the `pause` mode (end of the window, `schedule` in the command for the controller, simple-tile data), mode and time validation, a mode change with `deviceId` only (controller page), identification as for the tank (`deviceId`, 404, 409), history with times from the controller, closing an activation at the last report after a power loss, validating, changing and deleting an entry, renaming a relay.

The simulator (`scripts/simulate-switch.mjs`) registers with SN `4C0000000E2E` (or `SIMULATED_SN`), sends the state every 5 s, executes commands with a local countdown and reacts to the WebSocket `operation`; `--history` writes activations from 7 days directly into the local database.

## Known issues

- **`PUT /switch/mode` and `/switch/state` have no authorisation** (like the whole server): anyone who knows the controller's SN can change a relay mode.
- **`PUT /device/properties` replaces the whole `properties`** — the application sends all fields; the switch also gets `work_mode: CWU` from the schema default (unused).
- **End of "on for a time" during a schedule window** (follows from the code, not verified on the board): the controller switches the relay off after the countdown, and the next report (right after the change) gets an on command from the schedule — a short gap and two history entries.
- **`relay` in `GET /switch/activations`** is not used by the application.
- **The history has no retention** — `switch_activations` grows without limit (a few documents per day per relay).
- **The activation cause (`source`)** is stored but not shown by the application (the "Źródło" column was removed from the tables and the CSV).
