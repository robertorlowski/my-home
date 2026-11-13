# MongoDB database

[Polski](../baza-danych.md)

The My Home database: where it runs, its collections, what they hold, how long data is kept and how to change the model safely. Document counts and sizes come from the production database on 8.11.2026.

## Where it runs

| Item | Value |
|---|---|
| Server | `vm-prod` (Oracle Cloud), container `mongodb-prod`, MongoDB 8.0 |
| Production database | `hpdb`, about 84 MB on disk |
| Test database | `hpdb_test`, a copy of production used by `my-home-test` and the local test |
| Access | only from the server (`127.0.0.1:27017`); from a computer through an SSH tunnel (`node test-lokalny.mjs` in the `oracle-cloud` repository, port 27117) |
| Users | `admin` (administration and backups), `myhome` (the application, `hpdb` only), `myhome_test` (test, `hpdb_test` only) |
| Backups | daily at 01:30 UTC, the last 7, `/srv/apps/storage/backups` on the server |
| Atlas | the former production database; on request it receives the structure and configuration, without history |

Server details, passwords (without values) and procedures are in the private `oracle-cloud` repository (`notatki-konfiguracji.md`).

## Common rules

- **`rootId`** is the `_id` of a `devices` document stored as text. Every collection with controller data has a `rootId` field, and deleting an account removes the documents with the `rootId` of its controllers from all such collections (`deleteUserAndData` in `server/src/core/services/auth.service.ts`).
- **`deviceId`** is the controller serial number (ESP32 MAC, 12 hex characters).
- **Time:** Mongoose adds `createdAt` and `updatedAt` (UTC). The `time` field in `hp` and `pv` is text from the controller, `YYYY.MM.DD HH:MM:SS` in Polish time. The server computes day boundaries in reports in Warsaw time.
- **`__v`** is the Mongoose version counter, meaningless for the application.
- **Strict schemas:** in `hp` and `pellet_boiler_pelux200` a field outside the schema is silently dropped on save. A new telemetry field has to be added to the model and to the server and client types.
- **Indexes** are defined in the models (`server/src/**/models/*.model.ts`) and Mongoose creates them when the server starts. Removing an index or a collection from the code does not remove it from the database; that has to be done by hand.
- **Outside the database** (server memory only, lost on restart): weather, the last raw pump telemetry, manual pump operations, controller diagnostics, WebSocket state.

## Collections

| Collection | Contents | Documents | Data | Retention |
|---|---|---|---|---|
| **Accounts and access** | | | | |
| `users` | user accounts and the system account | 2 | 1 KB | unlimited |
| `sessions` | login sessions (token hash) | 21 | 5 KB | TTL `expiresAt` |
| `auth_codes` | codes and links from e-mails (hashes) | 0 | — | TTL `expiresAt` |
| `device_shares` | controller shares | 1 | 1 KB | unlimited |
| `app_settings` | application settings (mail, push, background jobs) | 1 | 1 KB | one document |
| **Controllers** | | | | |
| `devices` | controllers, their settings and pump schedules | 5 | 3 KB | unlimited |
| `operation_log` | operation log ("Operacje" tab) | 110 | 40 KB | TTL 5 days |
| `firmware_images` | firmware `.bin` files | 8 | 8.3 MB | offered and previous version |
| `firmware_offers` | offered version per controller type | 4 | 1 KB | one per type |
| **Heat pump and PV** | | | | |
| `hp` | pump telemetry every few seconds | 424,164 | 246 MB | unlimited |
| `pv` | photovoltaic readings | 44,730 | 76 MB | `panels` removed after 90 days |
| `heat_pump_cwu_loading` | ongoing boiler DHW loading by this pump | 1 | — | one per pump |
| **Pellet boiler** | | | | |
| `pellet_boiler_pelux200` | boiler readings | 41,671 | 31 MB | unlimited |
| `pellet_boiler_pelux200_alerts` | alarms from the boiler panel | 101 | 20 KB | unlimited |
| `pellet_boiler_pelux200_commands` | requests to change regulator parameters | 385 | 93 KB | unlimited |
| `pellet_boiler_pelux200_settings` | last reading of the regulator settings | 1 | 4 KB | one per boiler |
| `pellet_boiler_pelux200_schedules` | boiler schedule entries | 5 | 1 KB | unlimited |
| `pellet_boiler_pelux200_schedule_settings` | boiler schedule state and settings | 1 | 1 KB | one per boiler |
| **Switch** | | | | |
| `switch_relays` | relays: name, mode, state | 1 | — | one per relay |
| `switch_schedules` | relay schedule entries | 2 | — | unlimited |
| `switch_activations` | switch-on history | 85 | 17 KB | unlimited |
| **Water pressure tank** | | | | |
| `water_pressure_tank` | pump runs of the water pressure tank | 65 | 23 KB | unlimited |
| `water_meter` | manual water meter readings | 5 | 1 KB | unlimited |
| **Other** | | | | |
| `weather_tiles` | weather tiles | 4 | 1 KB | at most 8 per account |
| `push_subscriptions` | Web Push subscriptions | 2 | 1 KB | removed after a 404 / 410 error |
| `mail_outbox` | mail queue for the mail relay | 0 | — | TTL one day |

The `hp`, `pv` and `pellet_boiler_pelux200` data are compressed on disk (about 50 MB together instead of 350 MB).

## Accounts and access

### `users`

Account: `email` (unique among accounts with an e-mail), `firstName`, `lastName`, address (`street`, `postalCode`, `city`, `country`), `location {lat, lng}`, `language` (`pl` / `en`), `defaultRootId`, `deviceOrder` (layout of the controller and tile list), `simpleTiles`, `notifications {rules: [{rootId, events}], quietFrom, quietTo}`. The system account (login `system`, since 2026-11-13 without a password: a code by e-mail to the address in the `SYSTEM_EMAIL` setting) has `isSystem: true` and no e-mail. Index: unique `{email}` only for documents with an e-mail.

### `sessions` and `auth_codes`

The database holds only SHA-256 hashes of the token, code and link, not the values. `sessions`: `tokenHash` (unique), `userId`, `remember` (90 days), `demo` (demo session, 2 h), `expiresAt`, `lastSeenAt`. `auth_codes`: `purpose` (`login`, `email-change`, `delete-account`; since 2026-11-13 the `system` account: `system-login` the code, valid 5 min, `system-sent` a trace of a sent code for the limit of 5 per hour, `system-fail` the counter of wrong `system` account codes (phone codes included), `system-lock` the lock after 5 wrong codes; phone code: `totp-fail` the counter of wrong phone codes of an address, at 5 the phone code is locked until `expiresAt`, `totp-disable` the e-mail code for turning the phone off), `email` (for the `system` account the text `system`), `codeHash`, `tokenHash`, `attempts`, `ip` and `delivery` (`mail` / `log` / `emergency`; `system` account only), `expiresAt`. Both collections have a TTL index on `expiresAt`, so MongoDB removes expired documents itself; the emergency command (`--kod-awaryjny`) removes the `system-*` documents and creates a new code.

### The shared key database `logowanie` (phone code, since 2026-11-13)

A separate database (name from `LOGIN_KEYS_DB`, default `logowanie`, test `logowanie_test`), shared with Archiwum and the admin panel; My Home connects to it with its own database account (`myhome` has the `readWrite` role). The format is fixed in `oracle-cloud/vm-prod/admin/docs/plan-logowanie-system-kodem.md` and is byte-for-byte the same in every application:

- `totp_klucze`: `{_id: e-mail address in lower case, sekret: "<iv>.<tag>.<ciphertext>", utworzono, aplikacja: "my-home" | "archiwum" | "admin"}` — one document per address; `sekret` is the raw 20 secret bytes encrypted with AES-256-GCM using `LOGOWANIE_KLUCZ` (iv 12 B, tag 16 B, no AAD, parts in base64url). Removing the document turns the phone code off in all applications. The `system` account has its key under the system account code address (`SYSTEM_EMAIL`).
- `totp_uzyte`: `{_id: "<address>:<30 s window counter of the accepted code>", czas}`, TTL index on `czas` (180 s); inserted before a code is accepted, a duplicate = the code has already been used (also in another application).

Deleting an account in My Home does not remove the address key (it belongs to the address, not the account, and another application may use it); an e-mail change leaves the key of the old address.

### `device_shares`

A controller share: `rootId`, `ownerId`, the invited person's `email`, `userId` (empty until the person creates an account), `tabs` (shared tabs). Indexes: unique `{rootId, email}`, `{userId}`, `{email}`.

### `app_settings`

One document with the settings changed on the system account screen: `values` (`SMTP_*`, `MAIL_FROM`, `MAIL_ADMIN`, `SYSTEM_EMAIL` (since 2026-11-13: the address of the `system` account sign-in codes), `MAIL_RELAY`, `CLIENT_URL`, `DEMO_OWNER_EMAIL`, `VAPID_*`, `BACKGROUND_JOBS`) and `updatedAt`. `_id` is the database name, so a copy of production restored as `hpdb_test` has the `hpdb` document and the test environment does not use it. Secret values are stored in plain form; the screen does not show them. Only `MONGODB_URI` stays outside the database (`SYSTEM_PASSWORD` is not used since 2026-11-13: the `system` account signs in with a code from the e-mail).

## Controllers

### `devices`

A controller:

- `deviceType`: `heat_pump`, `water-pressure-tank`, `pellet-boiler-pelux200` (boiler) or `switch`.
- `deviceId`: the serial number. The oldest controller had `hp-1`, changed to the SN in production (also in `hp`, 2026-09-26).
- `name`: a name given by the user; empty means the application shows `deviceId`.
- `ownerId`: the owner (an account from `users`); without an owner only the system account sees the controller.
- `firmwareVersion`, `firmwareSeenAt`: the firmware version and the time of the report that carried it.
- `firmwareUpdate {version, requestedAt}`: an update request from the "Aktualizuj" button; it disappears when the controller reports that version.
- `ipAddress`, `ipSeenAt`: the controller address on the local network.
- `sortOrder`, `hidden`: the tile position on the list (numbering shared with `weather_tiles`) and hiding.
- `properties`: settings of all controller types in one object. Pump: `work_mode` (`MANUAL`, `AUTO`, `OFF`; `M`, `A`, `CWU` and the `co_*`, `cwu_*` pairs are former values), `temp_min`, `temp_max`. Water pressure tank: `compressor_seconds` (1–3600). Boiler: `poll_interval_seconds` (30–3600), `pellet_price_per_ton`. Switch: `default_on_minutes` (0–10080, 0 = no limit). The default `work_mode` is added to every type.
- `schedules`: embedded pump schedules (other controllers have their own schedule collections).
- `pumpConfig {connection, tankLiters, pvDtu, pvForce}` (pump), `boilerConfig {heatPumpRootId}` (boiler linked to the pump).
- `mailKey {publicKey, fingerprint, approvedAt, seenAt}` and `mailKeyPending`: the controller's mail relay key.

Index: `{ownerId}`. Old documents may have a `settings` field from the former time settings model; the schema ignores it.

### `operation_log`

A log entry: `rootId`, `at`, `actor {type, name, userId}` (`type`: `user`, `system`, `controller`), `source`, `action` (description of the change), `status` (`pending`, `sent`, `delivered`, `done`, `error`, `replaced`), `statusAt`, `error`, `reason`, `conditions`, `refs` (controller requests whose status the log copies). Indexes: `{rootId, at}`, `{refs}` and a TTL on `at` after 5 days.

### `firmware_images` and `firmware_offers`

`firmware_images`: `deviceType`, `version`, `data` (the `.bin` file, about 1 MB), `size`, `sha256`, `description`; unique `{deviceType, version}`. `firmware_offers`: one document per controller type: `version` (offered), `previousVersion`, `enabled`; unique `{deviceType}`. When the offer changes, files older than the offered and previous ones are deleted. A controller receives the offer only with a request in `devices.firmwareUpdate`.

## Heat pump and PV

### `hp`

Telemetry sent by the `co` controller (`POST /api/hp/add`), completed by the server: `rootId`, `deviceType`, `deviceId`, `time`, `work_mode`, `temp_min`, `temp_max`, `t_min` and `t_max` (tank temperature range in the cycle), `t_out` (outdoor temperature: boiler sensor or forecast), `error_code` (a new pump error in this reading). The `HP` object is the state of the CHPC controller: temperatures (`Tbe`, `Tae`, `Tco`, `Tho`, `Ttarget`, `Tsump`, `Tmin`, `Tmax`), power (`Watts`, `WWatt`), the EEV valve (`EEV`, `EEV_dt`, `EEV_pos`, `EEVmin`, `EEVmax`), output states (`HPS`, `HCS`, `CCS`, `CO`, `SHS`, `F`, `FLW`), errors (`ERR`, `ERRn`, `ERRc`) and the last cycle (`lt_pow`, `lt_hp_on`). The server adds `PV.total_power` from the last PV reading; records from before 2026-09-26 have a full `PV` from telemetry.

Indexes: `{rootId, createdAt}`, `{createdAt}`, `{deviceId}`. About 7,100 documents a day (about 4.3 MB before compression). The `co` diagnostic counters are not saved (strict schema); the last raw telemetry is available from `GET /api/hp` in server memory.

### `pv`

A DTU reading (`POST /api/pv/add`), one document per reading: `rootId`, `deviceType`, `deviceId`, `time`, `total_power`, `total_prod`, `total_prod_today`, `temperature`, `pv_power` and `panels[]`. `panels` is removed from documents older than 90 days (`PANEL_DETAILS_RETENTION_DAYS`); the summary stays. Indexes: `{rootId, createdAt}`, `{createdAt}`. About 720 documents a day.

### `heat_pump_cwu_loading`

One document per pump (unique `{rootId}`): `active`, `refreshedAt`, `pelletBlock`. The boiler sets it (`PUT /hp/cwu-loading`, every minute) so that a server restart neither interrupts an ongoing DHW loading nor leaves the pump on raised temperatures.

## Pellet boiler

### `pellet_boiler_pelux200`

A boiler reading every few minutes: state (`state`, `alarm`, `alerts_active`), temperatures and set points (`heating_temp`, `heating_target`, `water_heater_temp`, `water_heater_target`, `outside_temp`, `optical_temp`, mixers `mixer1_*`, `mixer2_*`), fuel and power (`fuel_level`, `fuel_consumption`, `fuel_burned_kg`, `boiler_load`, `boiler_power`, `fan_power`), outputs (`fan`, `feeder`, pumps, `lighter`, `output_flags`) and `heat_pump_running`. Strict schema. Index: `{rootId, createdAt}`. About 2,650 documents a day.

### `pellet_boiler_pelux200_alerts`

An alarm from the boiler panel: `code`, `from` and `fromRaw` (start; `fromRaw` in ecoMAX seconds), `to` and `toRaw` (end, filled in later), `initial` (an entry from the first upload), `uncertain`, `seenAt`. Indexes: unique `{rootId, code, fromRaw}`, `{rootId, from}`.

### `pellet_boiler_pelux200_commands`

A request from the application to change a regulator parameter: `kind` (`ecomax`, `mixer`), `mixer` (from 1), `index`, `value` (raw), `previous`, `label`, `status` (`pending`, `sent`, `done`, `error`, `replaced`), `waitOff`, `error`, `sentAt`, `doneAt`. Indexes: `{rootId, createdAt}`, `{rootId, status, createdAt}`.

### `pellet_boiler_pelux200_settings`

The last reading of the regulator settings, one document per boiler (unique `{rootId}`): `readAt`, `deviceId`, raw regulator responses as hex (`ecomax_parameters`, `mixer_parameters`, `thermostat_parameters`, `schedules`, `regulator_data_schema`). The server decodes them when reading.

### `pellet_boiler_pelux200_schedules` and `pellet_boiler_pelux200_schedule_settings`

A schedule entry: `mode` (`heat-pump` or `pellet`), `type` (`cwu` or `season`), `enabled`, `dayOfWeek` or a date, `startTime`, `endTime`, for DHW `cwuFrom` and `cwuTo`, for a season `season` (`winter`, `summer`), `winterBelow`, `summerAbove`, `coldBelow`; index `{rootId, mode}`. Settings (one document per boiler, unique `{rootId}`): `enabled`, `defaults` and `profiles` for both modes, `lastApplied`, `lastAppliedAt` and the state of the automations: `cwuLoading`, `pelletCwu`, `pendingTurnOn`, `autoPellet`, `manualSeason`, `winterCycle`, `winterMixer`.

## Switch

- **`switch_relays`**: one document per relay (unique `{rootId, relay}`, `relay` from 1): `name`, `mode` (`schedule`, `on`, `timer`, `off`, `pause`), `until`, `modeSource` (`app` or `controller`), `modeChangedAt`, the state from the controller `on`, `changedAt`, `lastSeenAt`.
- **`switch_schedules`**: `relay`, `enabled`, `dayOfWeek` or `date`, `startTime`, `endTime`; index `{rootId, relay}`.
- **`switch_activations`**: `relay`, `onAt`, `offAt` (`null` = ongoing), `source` (`schedule`, `app`, `controller`), `approximate`; indexes `{rootId, onAt}`, `{rootId, relay, offAt}`.

## Water pressure tank

- **`water_pressure_tank`**: one pump run per controller `runId`: `pumpStart`, `pumpEnd`, `compressorStart`, `compressorEnd`, `compressorRunning`, `restarts`, `manualSeconds`, `timeApproximate`, `lastSeenAt`. Indexes: unique `{rootId, runId}`, `{rootId, pumpStart}`. Water is not stored: the server computes it when reading, from the pump time and the water meter. Older documents may have the unused `waterLiters`, `waterAirBaseLiters`, `waterMembraneLiters`.
- **`water_meter`**: manual water meter readings: `readAt`, `valueM3`, `note`; index `{rootId, readAt}`.

## Other

- **`weather_tiles`**: `name`, `lat`, `lon`, `ownerId`, `sortOrder`, `hidden`, `home` (the "Dom" tile, created when the server starts), `current` (the browser's current location, without coordinates); index `{ownerId}`. Weather is not stored.
- **`push_subscriptions`**: a Web Push subscription of a browser or phone: `userId`, `endpoint` (unique), `keys {p256dh, auth}`, `label`, `lastUsedAt`; index `{userId}`.
- **`mail_outbox`**: the mail queue for sending through controllers (an option in Settings, off by default since 2026-11-07): `to`, `subject`, `raw` (MIME message), `status`, `attempts`, `leasedBy`, `leaseUntil`, `receipt`, `sentBy`, `sentAt`, `error`, `expiresAt`. Indexes: `{status, createdAt}` and a TTL one day after creation.

## Changing the data model

- **New field:** the model in `server/src/**/models/`, the server and client types, the views. In `hp` and `pellet_boiler_pelux200` a field missing from the schema is not saved.
- **New collection with controller data:** a `rootId` field, so that account deletion covers it. A configuration collection: add it to the copy to Atlas (`vm-prod/sync-atlas.js` in `oracle-cloud`).
- **Removing a collection, field or index from the code:** remove it from the production and test databases too, after a backup. Mongoose does not do it.
- **Reading data from a computer:** an SSH tunnel and the `myhome_test` account for the test database. Do not change production by hand without a backup.

## Cleanup 2026-11-08

Removed from `hpdb` and `hpdb_test` on 8.11.2026: leftovers of removed code, not used by the application. Backup taken before removal: `/srv/apps/storage/backups/pozostalosci-20261108.tar.gz` on the server.

| Item | Origin |
|---|---|
| collection `settings` (1 document: `night_hour`, `settings`, `cwu_settings`) | the former pump time settings model, removed from the code on 2026-10-21 |
| collection `tile_template` (empty) | the tile designer, removed from the code |
| collection `migrations` (1 document) | the one-off owner migration (`INITIAL_OWNER_EMAIL`), removed from the code on 2026-11-07 |
| `devices` indexes `{settings.rootId}` and `{hp.rootId}` | fields of the former device model |
