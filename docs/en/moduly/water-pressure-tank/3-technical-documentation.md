# Water-pressure-tank module — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/water-pressure-tank/3-dokumentacja-techniczna.md)

## Files — server (`server/src/modules/water-pressure-tank`)

| File | Role |
|---|---|
| `routes.ts` | `/water-pressure-tank/*` routes |
| `device-type.ts` | registry entry: default settings of a new tank and the `settings` field in the registration reply |
| `types.ts` | `WaterPressureTankRun`, `WaterMeterReading` |
| `controllers/water-pressure-tank.controller.ts` | `add`, `settings`, `runs`, `summary`, `flow`, water meter and its summary; period boundaries in Warsaw time |
| `services/water-pressure-tank.service.ts` | message validation and save (dates from relative times), `pumpSeconds` (pump time without manual compressor operation), flow from the water meter (`loadFlow`, `getFlowRate`), water (`litersFor`), summaries, water meter, compressor time |
| `models/water-pressure-tank-run.model.ts` | `water_pressure_tank` collection |
| `models/water-meter.model.ts` | `water_meter` collection |

## Files — client (`client/src/devices/water-pressure-tank`)

| File | Role |
|---|---|
| `device-type.tsx` | registry entry: Hydrofor, Dane, Wykres, Operacje, Ustawienia (no schedules) |
| `api.ts` | `WaterPressureTankRequests` |
| `types.ts` | runs, flow (`WaterFlow`), summaries, water meter |
| `pages/Home.tsx` | "Instrument" layout: Offline banner, the "Woda dziś" hero with pump and compressor switches and compressor time / flow KPIs, today's runs card (every 5 s) and 7-day consumption bars |
| `pages/Data.tsx` | filter bar (runs / water meter readings switch, month, CSV), the runs card ("≈", "z kolejki" chip) or the water meter readings card (form and list) |
| `pages/Chart.tsx` | filter bar (Dzień / Miesiąc / Rok, date), stat tiles, water bars (pump time bars without a flow), year with the water meter and the flow |
| `pages/Settings.tsx` | two columns: the "Kompresor" and "Przepływ pompy" (`FlowDetails`) cards, on the right the "Sterownik" card (`ControllerCard` from `core`) and "Udostępnianie" (`DeviceSharing`) |
| `components/FlowDetails.tsx` | the flow in l/min and what it was computed from, or instructions (two water meter readings); in Settings |
| `components/DateNav.tsx`, `DurationValue.tsx`, `TankIcons.tsx` | date navigation (`.date-nav`), pump time as "4 min 10 s" with units, tank icons |
| `pages/style.css` | tank screen styles |
| `utils/water.ts` | formats (litres, pump time as "4 min 10 s"), Warsaw dates, totals, CSV |

## API

| Method and path | Caller | Description |
|---|---|---|
| `POST /water-pressure-tank/add` | controller | `{runId, pumpRunS, compressorStartS?, compressorEndS?, restarts, manualCompressorS?, queued?}`; `deviceId` alone is enough; 404/409 as in core; reply `{}` (201); bad data 400 |
| `PUT /water-pressure-tank/settings` | controller | `{compressor_seconds}` (whole seconds 1–3600, otherwise 400); changes only that field; 404 for another device kind |
| `GET /water-pressure-tank/runs?from=YYYY-MM-DD&to=YYYY-MM-DD` | application | runs of the days (Warsaw, `to` inclusive), with `inProgress`, `compressorRunning`, `pumpSeconds` (pump time without manual compressor operation) and `waterLiters` (`null` without a flow) |
| `GET /water-pressure-tank/summary?period=day\|month\|year&date=YYYY-MM-DD` | application | `{period, date, buckets, flow}`; buckets `{key, pumpSeconds, waterLiters \| null, runs}` per hour (24), per day of the month or per month (12); empty buckets are zero |
| `GET /water-pressure-tank/flow` | application | pump flow `{litersPerMinute \| null, periods, meterLiters, pumpSeconds}`: number of periods used, total litres from the meter and total pump time |
| `GET /water-pressure-tank/meter` | application | readings, oldest first |
| `POST /water-pressure-tank/meter` | application | `{readAt, valueM3, note?}` |
| `DELETE /water-pressure-tank/meter/:id` | application | delete; 404 for an unknown or foreign reading |
| `GET /water-pressure-tank/meter/summary?year=YYYY` | application | `{year, periods, months, flow}`; periods `{from, to, meterLiters, pumpSeconds, estimatedLiters \| null}`, months `{month, meterLiters, estimatedLiters}` (`null` outside the reading range); < 2 readings → empty lists |

Tank settings are saved with the shared `PUT /device/properties` (core module). Registration (`POST /devices/register`) returns `settings`: `{compressor_seconds}` and, when an update was requested in the application ("Aktualizuj" in the "Sterownik" card, `POST /devices/:rootId/firmware-update`, core module), `firmware: {version, url, sha256, request}`. The tank controller is powered only while the pump runs, so it updates at the next pump run, with the compressor off.

Message validation: `runId` — integer ≥ 0; `pumpRunS` — 0 to 24 h; other times (including `manualCompressorS`) ≥ 0.

**Flow and water** (`loadFlow`): water meter readings, oldest first, define the periods; in each, the `pumpSeconds` of runs with `pumpStart` in the period are summed. Periods with pump time > 0 and a meter increase ≥ 0 enter the flow: `l/s = Σ litres / Σ seconds`. The water of a run, bucket or month = `pumpSeconds × l/s`, rounded to 0.1 l. Summaries compute pump time in the MongoDB aggregation with the same expression (`PUMP_SECONDS_EXPR`).

## Data model

**`water_pressure_tank`** — one pump run:

| Field | Description |
|---|---|
| `rootId`, `deviceType`, `deviceId`, `runId` | identification (`runId` is assigned by the controller: a counter in NVS with a random start) |
| `pumpStart`, `pumpEnd` | pump start and end |
| `compressorStart`, `compressorEnd` | compressor on and last off |
| `restarts` | number of manual compressor starts ("Uruchom na N s" and "Włącz") |
| `manualSeconds` | total manual compressor time ("Włącz") [s]; subtracted from the pump time |
| `timeApproximate` | dates from the time received (queued run) |
| `lastSeenAt` | last message (run "in progress" < 5 s) |
| `compressorRunning` | compressor on according to the last message (`compressorStartS` without `compressorEndS`); needed after "Uruchom na N s", because `compressorEnd` keeps the previous stop. `GET …/runs` returns it only with `inProgress` |
| `createdAt`, `updatedAt` | timestamps |

Indexes: unique `{rootId, runId}` and `{rootId, pumpStart}`. The record holds no water (until version 1.3.0 it had `waterLiters`, `waterAirBaseLiters` and `waterMembraneLiters`; they remain in older documents but are not used, and `waterLiters` in the `GET …/runs` reply is always computed afresh).

**`water_meter`** — water meter readings: `rootId`, `readAt` (the application stores the date as local noon), `valueM3`, `note`; index `{rootId, readAt}`.

**`devices.properties`** of a tank: `compressor_seconds` (1–3600). The former fields `pressure_low`, `pressure_high` and `tanks[]` (until version 1.3.0) are no longer in the schema.

## Constants

| Constant | Value | Where |
|---|---|---|
| `RUN_IN_PROGRESS_MS` | 5 s | service |
| `MAX_COMPRESSOR_SECONDS` | 3600 | service, `properties` schema, firmware |
| default settings | `compressor_seconds` = 30 | `device-type.ts` |

## Tests and tools

```bash
npm test -w server -- --run       # server/test/water-pressure-tank.test.ts: 31 tests (server in total: 96)
node scripts/simulate-water-pressure-tank.mjs [--history] [--fast]   # controller simulator (npm run local)
node scripts/seed-local.mjs       # demo data: several months of runs and water meter readings ("real" flow 1 l/s)
```

`server/test/water-pressure-tank.test.ts` checks: pump time without manual compressor operation, the flow from the water meter and the water of each run, the time-weighted average skipping periods without pump runs, no water before two readings, registration with settings, settings and their validation, compressor time from the controller (one field changed, 404, 409), dates from relative times, the queue and approximate time, "in progress", compressor running (also after a restart), saving `manualCompressorS`, summaries, water meter.

## Known issues

- **The controller sends runs only after a successful registration** (unlike `co`) — without the cloud the run waits in NVS and goes to the queue at the next start.
- **A tank gets `work_mode: CWU` in `properties`** from the schema default — the field is unused.
- **`PUT /device/properties` replaces the whole `properties`** — the application sends the full set of tank fields; any other API client must do the same.
- **Water depends on a constant pump flow.** There is one flow for the whole history; a pump change or a clogged filter changes it only through the average of later readings.
- **Every water query reads all water meter readings and the runs between the first and the last one** (`loadFlow`), without a cache.
- **The firmware and the controller pages have no hardware tests** — they are checked in an emulator and in `native` tests.
