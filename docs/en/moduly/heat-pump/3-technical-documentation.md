# Heat-pump module — technical documentation

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../../../moduly/heat-pump/3-dokumentacja-techniczna.md)

## Files — server (`server/src/modules/heat-pump`)

| File | Role |
|---|---|
| `routes.ts` | module routes: `/hp`, `/pv`, `/operation`, `/schedules` |
| `device-type.ts` | entry in the kind registry (the pump has no settings in the registration reply) |
| `types.ts` | `HpEntry`, `HpMetrics`, `PvEntry`, `PvMetrics`, `PvPanel`, `OperationEntry`, `ScheduleEntry`, `ScheduleType`, `WeekDay`, `WorkMode`, `SettingsEntry`, `TimeSlot` |
| `controllers/hp.controller.ts` | `addHp` (telemetry → operation), day/range/year reads, monthly balance, latest error, clearing |
| `controllers/operation.controller.ts` | operation for the form, manual save, one-off actions (+ WebSocket `operation`) |
| `controllers/pv.controller.ts` | PV save and read |
| `controllers/schedule.controller.ts` | schedule CRUD, schedule in force now |
| `services/hp.service.ts` | telemetry save, error event detection, cache of the latest telemetry and of days with data |
| `services/operation.service.ts` | operation maps in memory, manual field merging, actions, `consumeManualForceOnStart`, M→A |
| `services/scheduler.service.ts` | the per-minute run, schedule selection, default operation, `getCurrentSchedule` |
| `services/schedule.service.ts` | schedules embedded in the device, filter for a date |
| `services/pv.service.ts` | latest PV reading (≤ 3 min), summary for `GET /hp`, panel cleanup after 90 days |
| `models/hp.model.ts` | `hp` collection (strict telemetry schema) |
| `models/pv.model.ts` | `pv` collection and the PV summary schema embedded in `hp` |
| `models/schedule.model.ts` | schedule schema (embedded in `devices.schedules`) |

## Files — client (`client/src/devices/heat-pump`)

| File | Role |
|---|---|
| `device-type.tsx` | registry entry: HP, Dane, Wykres, Harmonogram, Operacje, Ustawienia menu; `/hp` outside the menu; "Dane sterownika" dialog fields (CWU / CO connection, tank volume, PV) |
| `api.ts` | `HpRequests`: telemetry, days, balance, operations, actions, error, schedules |
| `types.ts` | client-side telemetry, PV, operation and schedule types; `pumpWorkMode` (A / CWU → Automatyczny, OFF → Wyłączony, the rest → Ręczny) |
| `pages/Home/` | main view in the "Instrument" layout: banners (Offline, pump paused, CWU loading), hero card (tank temperature on a range bar, compressor, KPIs), the "Pomiary", "Obieg" and "Energia dziś" cards; WebSocket `update` |
| `pages/Data/` | filter bar (days with data, "Wszystkie odczyty", CSV) and the "Odczyty dnia" card; error rows highlighted |
| `pages/Charts/` | filter bar (period, date, "Cały dzień"), stat tiles, the "Temperatury" and "Moc i produkcja PV" cards (day) or "Energia i koszt" (month, year) |
| `pages/Settings/` | two columns: the "Ustaw" card (manual operation), "Błędy sterownika", the "Sterownik" and "Udostępnianie" cards from `core` |
| `pages/Schedules/` | the "Tryb pracy" (default settings) and "Wpisy" cards (`.entries` list, "działa teraz", "Poza harmonogramem"), the "Wpis harmonogramu" dialog |
| `components/DateNav.tsx` | date navigation (`.date-nav`): arrows and a list of days with data (`useHpDates`), months or years |
| `components/Segmented.tsx`, `components/Switch.tsx` | the segmented switch (operating mode, chart period) and the `.switch` toggle from the mock-up |
| `components/PumpConfigFields.tsx`, `pumpConfig.css` | "Dane sterownika" dialog fields: CWU / CO connection with a diagram, tank volume, PV |
| `components/icons.tsx` | heat pump view icons |
| `utils/utils.ts` | fetching and flattening a day's data for the table and the chart |
| `utils/energy-cost-g12w.ts` | energy cost in the G12w tariff (Warsaw time, `YYYY.MM.DD` format) |
| `utils/errors.ts` | CHPC error code descriptions (change together with `ERRC_*` in the firmware) |

## API

| Method and path | Caller | Description |
|---|---|---|
| `POST /hp/add` | `co` | telemetry; reply `{operation, t_out}`; `deviceId` alone is enough (404/409 as in core) |
| `GET /hp` | application | latest telemetry from memory + full PV summary |
| `GET /hp/all` | application | data since the start of the year (CSV) |
| `GET /hp/dates` | application | days with data (`YYYY.MM.DD`) |
| `GET /hp/4day?date=` or `?startDate=&endDate=` | application | records of a day / a range of days (Warsaw time) |
| `GET /hp/monthly-summary?startDate=&endDate=&group=month\|day` | application | energy, PV, grid use, cost |
| `GET /hp/last-error` | application | latest record with `error_code` (24 h, no limit while locked) |
| `POST /pv/add` | `co` | PV reading; `total_power` required; reply `{}` (201) |
| `GET /pv`, `GET /pv/range?date=` / `?startDate=&endDate=` | application | latest reading with panels / readings in a range |
| `GET /operation` | application | values for the Settings form |
| `POST /operation/set` | application | save a manual operation |
| `POST /operation/action` | application | `{action: "error_reset" \| "restart"}` |
| `GET /schedules`, `POST /schedules`, `PUT /schedules/:id`, `DELETE /schedules/:id` | application | schedules |
| `GET /schedules/current` | application | `{scheduleId, work_mode}`; `scheduleId: null` = default setting |

## Operation contract (server → `co`)

All values are **strings**.

| Key | Values | RS-485 command to CHPC |
|---|---|---|
| `work_mode` | `M`, `A`, `CWU`, `OFF` (`co` also accepts `PV`) | `0x0C` CO on/off + CO/CWU relays in `co` |
| `force` | `"0"`, `"1"` | `0x03` (CHPC accepts it only when idle) |
| `co_min`, `co_max`, `cwu_min`, `cwu_max` | °C | `0x04` target T (max), `0x05` delta (max − min) |
| `co_pomp` | `"0"`, `"1"` | CO/CWU relays in `co` |
| `hot_pomp`, `cold_pomp`, `sump_heater` | `"0"`, `"1"` | `0x09`, `0x0A`, `0x0B` |
| `working_watt` | W | `0x0E` power limit (1001–4000 W in CHPC) |
| `eev_max_pulse_open`, `eev_min_pulse_open` | steps | `0x0D`, then `0x0F` |
| `eev_setpoint` | °C | `0x08` superheat |
| `error_reset`, `restart` | `"1"` (one-off actions) | `0x10` unlock, `0x11` restart |

An empty operation `{}` changes nothing; `co` does not resend a value that has not changed.

## Telemetry (`co` → server)

- `HP` — the JSON from CHPC as is. Keys `co` and the server rely on: `HPS` (>0 = compressor running), `Tho`, `Ttarget` (sensor in the middle of the tank), `lt_pow` (Wh since compressor start), `lt_hp_on` (s of operation), `F`, `CO`, `Tmin`, `Tmax`, `Tbe`, `Tae`, `Tsump`, `EEV`, `EEV_dt`, `EEV_pos`, `Watts`, `WWatt`, `HCS`, `CCS`, `SHS` (crankcase heater), `EEVmax`, `EEVmin`, `ERR`, `ERRn`, `ERRc`.
- `time` — `"YYYY.MM.DD HH:MM:SS"` (Polish time).
- `work_mode`, `co_min`, `co_max`, `cwu_min`, `cwu_max`, `co_pomp`, `cwu_pomp`, `controller_mode`.
- Tank COP: `cop`, `cop_min`, `cop_max`, `t_min`, `t_max`, `cop_bottom_start`.
- `co` diagnostic counters (`serial_*`, `cloud_*`, `*_error`).

**The `hp` schema is strict**: keys outside it (among others `EEV_pulse`, `cop_min`, `cop_max`, `controller_mode`, diagnostic counters) are not stored; they are visible only in `GET /hp` until the server restarts. A new telemetry field has to be added to `models/hp.model.ts`, `types.ts` (server and client) and the screens.

## Data model

| Collection | Content | Indexes / retention |
|---|---|---|
| `hp` | telemetry + `rootId`, `deviceType`, `deviceId`, `t_out`, `error_code`, `PV.total_power`, `createdAt` | `rootId`, `deviceId` |
| `pv` | DTU reading: summary + `panels[]` (microinverter port: power, voltages, current, temperature, status, alarm) | `{rootId, createdAt}`, `{createdAt}`; `panels` removed after 90 days |
| `devices.schedules[]` | `type` (`co`/`cwu`/`off`), `enabled`, `dayOfWeek` (-1 every, -2 working, -3 off, 0–6), `date?`, `startTime`, `endTime` (`HH:mm`), `forceStart`, `minTemperature?`, `maxTemperature?` | embedded in the device |
| `devices.properties` | `co_min`, `co_max`, `cwu_min`, `cwu_max`, `work_mode` | — |

## Constants

| Constant | Value | File |
|---|---|---|
| `SCHEDULER_INTERVAL_MS` | 60 000 | `services/scheduler.service.ts` |
| `PV_MAX_AGE_MS` | 3 min | `services/pv.service.ts` |
| `PANEL_DETAILS_RETENTION_DAYS` | 90 | `services/pv.service.ts` |
| latest error window | 24 h | `services/hp.service.ts` |
| CHPC lock | `ERRc` ≥ 5 | `services/hp.service.ts`, `utils/errors.ts` |

## Tests

```bash
npm test -w server -- --run      # server/test/: app.test.ts, pv.test.ts, scheduler.test.ts (+ tank, boiler); 81 tests in total
```

- `app.test.ts` — telemetry save and read, `EEVmin`, error events (also while locked), actions, `co_pomp` on mode change, force at start.
- `pv.test.ts` — PV save with `deviceId` only, 404/409, `PV.total_power` in `hp` (3 min limit, older firmware PV unchanged), full PV in `GET /hp`, balance, panel removal.
- `scheduler.test.ts` — schedule kinds by mode, breaks, manual override and its clearing, default temperatures, `CWU` outside the schedule in mode `A`, M→A after midnight, schedule in force now, weekends and holidays, no `co_pomp` in the operation.

The whole-chain test (`test/e2e`, a bridge with the real `co` code and a simulated CHPC) is out of date: it waits for a controller-adding form the application no longer has.

## Known issues

- **No validation** in `/operation/set` or the UI; ranges are checked only by `co` (e.g. temperatures 1–50, `working_watt` 0–25599) and CHPC (e.g. power limit 1001–4000, target ≤ 50, delta ≤ 30) — silently.
- **One-off actions are lost when `co` is not in CLOUD mode** (`applyServerOperation` in `devices/co/src/main.cpp` rejects the whole operation, and the server sends the action only once).
- **Manual operations and the latest telemetry live only in memory** — a server restart clears them.
- **A schedule for a specific weekday crossing midnight** (e.g. Monday 22:00–06:00) is active on Monday 00:00–06:00 and 22:00–24:00, not on Tuesday morning — the day is checked for the current moment. "Every day" entries work as expected.
- **The G12w cost is computed twice, differently**: the client (day chart) treats holidays as the cheap zone and splits intervals at zone boundaries, the server (`monthly-summary`) knows no holidays and assigns the zone by the sample hour. On holidays the day and the month may show a different cost. Rates and zone hours are hard-coded in both places.
- **An `hp` record is created only for a non-zero `HP.Ttarget`** — on purpose: the tank is never cooled down to 0 °C, so 0 means no reading from CHPC.
- **Never join `hp` with `pv` in an aggregation** (32 MB Atlas sort limit, no `allowDiskUse`).
- Clean-up 2026-10-21: `GET /hp/all` computes the start of the year in Warsaw time; a new schedule shows its save error (`Requests.json`); the client calls `/hp/4day`; removed the unused `getSchedulesForDate`, `getHpDataForDay`, `assignLegacyHpData`, `/operation/getAndClear`, `utils/energy.ts`, `components/ResourceBlock.tsx` and the legacy time settings model (`settings` collection, `GET /settings`, `POST /settings/set`, the `devices.settings` field; old documents keep the field, the schema ignores it). `setOperationData` stays (used by `onPropertiesSaved`).
