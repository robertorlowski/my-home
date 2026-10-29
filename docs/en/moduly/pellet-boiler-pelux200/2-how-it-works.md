# Module pellet-boiler-pelux200 — how it works

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · **2. How it works** · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/pellet-boiler-pelux200/2-zasada-dzialania.md)

## Diagram

```mermaid
flowchart LR
    ECO["Pellux 200 boiler<br/>ecoMAX controller<br/>(module A)"] -- "RS-485 115200 baud<br/>SensorData frames,<br/>receive only" --> CO["boiler controller<br/>(ESP32-C3 + HW-519)"]
    CO -- "POST /devices/register<br/>(at every start)" --> SRV["My Home"]
    CO -- "POST /pellet-boiler-pelux200/add<br/>every poll_interval_seconds" --> SRV
    SRV -- "{poll_interval_seconds}" --> CO
    SRV --> DB[("MongoDB:<br/>devices,<br/>pellet_boiler_pelux200")]
    WEB["web application"] <--> SRV
```

The controller side (wiring, frame parser, pins, protocol) is described in the [controller README](../../../../devices/pellet-boiler-pelux200/README.md) and [piec-pellux200.md](../../../../devices/pellet-boiler-pelux200/docs/piec-pellux200.md) (both Polish). This document describes the cloud and application side. The boiler is **only a data source**: the server has no scheduler, no operations and no control replies for it (the only value sent back to the controller is the polling interval).

## Stages

| Stage | Scope | Status |
|---|---|---|
| 1 | the boiler controller receives `SensorData` frames from the boiler bus and sends readings to the cloud | implemented; frame format from PyPlumIO **not verified on a boiler** |
| 2 | the boiler controller answers the ecoMAX controller's device-presence query (`CheckDevice`) and transmits on the bus, boiler control | **not implemented** |

## The boiler controller

Since 2026-10-03 the boiler is read by a separate boiler controller (an ESP32-C3 SuperMini board with an HW-519 RS-485 module, `devices/pellet-boiler-pelux200`). It has its own SN (the board's MAC), so in the cloud it is an ordinary device of kind `pellet-boiler-pelux200`. Until 2026-10-02 this role was played by the `co` controller: the same SN was then two devices in the cloud (the heat pump and the boiler, different `rootId`s). The server still supports several roles of one SN (described in the [core module](../core/2-how-it-works.md)): it tells them apart by the **endpoint path** (`controllerPaths` in `device-context`, lookup by the pair `{deviceId, deviceType}`), and a `rootId` of another role gives **409**.

## Registration: at every start

```mermaid
sequenceDiagram
    participant K as boiler (ecoMAX)
    participant C as boiler controller
    participant R as POST /devices/register
    participant A as POST /pellet-boiler-pelux200/add
    participant M as MongoDB
    C->>R: once on Wi-Fi: {deviceId: SN, deviceType: "pellet-boiler-pelux200", name: "Piec Pellux 200", version, ip}
    R->>M: create the device (properties.poll_interval_seconds = 300) or return the existing one
    R-->>C: {rootId, ..., settings: {poll_interval_seconds}}
    C->>C: store rootId and the interval in NVS (namespace pel)
    K->>C: SensorData frames (continuously, to the panel)
    loop every poll_interval_seconds
        C->>A: the last valid reading (younger than 60 s)
        A->>M: save the reading
        A-->>C: 201 {poll_interval_seconds}
        C->>C: store the new interval in NVS
    end
    Note over C,A: failed send: retry after 60 s;<br/>404 or 409 → the controller drops the Root ID and registers again
```

- A failed registration is retried every 30 s; until it succeeds nothing is sent. The controller registers even with no boiler connected (the device then has no readings).
- The name "Piec Pellux 200" goes only to a **new** device; a known device keeps its name.
- The controller may also send a reading with `deviceId` only (no `rootId`) if a device with that SN and kind `pellet-boiler-pelux200` already exists.

## Saving a reading in the cloud

```mermaid
flowchart TD
    B["POST /pellet-boiler-pelux200/add<br/>{state, heating_temp, ..., fan, alarm}"] --> V{"body is an object,<br/>numeric fields are finite numbers,<br/>logical fields are boolean,<br/>at least one measurement field?"}
    V -- no --> E400["400: Nieprawidłowy odczyt kotła."]
    V -- yes --> S["save to pellet_boiler_pelux200<br/>(rootId, deviceType, deviceId + fields);<br/>time from the server clock"]
    S --> C["last reading in server memory (per rootId)"]
    S --> W["WebSocket: update → browsers"]
    S --> R["201 reply:<br/>{poll_interval_seconds}"]
```

- All measurement fields are optional: the controller sends what it managed to read. A single field of the wrong type rejects the whole reading (400).
- The `time` field and unknown keys are **ignored**: the record time (`createdAt`) is set by the server when it accepts the reading.
- The reply carries the current `poll_interval_seconds`, so a change in the application reaches the controller with the next send, without a new registration.

## Polling interval: application ↔ controller

```mermaid
sequenceDiagram
    participant U as application (Settings)
    participant S as server
    participant C as controller
    U->>S: PUT /device/properties {poll_interval_seconds: minutes × 60}
    S->>S: validation: whole seconds 30–3600 (otherwise 400)
    Note over C: the next reading send
    C->>S: POST /pellet-boiler-pelux200/add
    S-->>C: 201 {poll_interval_seconds: new value}
    C->>C: store in NVS, apply the new interval
```

The application form (the "Odczyt" card in Settings) takes whole seconds (30–3600; until 2026-10-13 minutes 0.5–60). `PUT /device/properties` replaces the whole `properties`, so the application sends the loaded object with the new value of the field.

## Application screens

| Screen | Data | Refresh |
|---|---|---|
| **Kocioł** (`/`) | `GET /pellet-boiler-pelux200/last`, `GET /device/properties` (the interval, to judge freshness), the last settings reading (season, operating mode) | last reading every 30 s |
| **Dane** (`/data`) | `GET /pellet-boiler-pelux200/list?date=YYYY-MM-DD`, CSV in the browser | on entry and on date change |
| **Statystyki** (`/chart`) | day temperatures from `GET /pellet-boiler-pelux200/list`, burnt pellet | on day and view change |
| **Harmonogram** (`/schedules`), **Alarmy** (`/alarms`), **Operacje** (`/operations`) | boiler schedule and mode presets, regulator alarms, operations log (shared page `core/pages/Operations`) — described in CLAUDE.md, section 5c | Harmonogram: state every minute; Operacje: today every 30 s |
| **Ustawienia** (`/settings`) | `GET/PUT /device/properties` (the "Odczyt" card); operating mode, main parameters and last changes (parameter requests); the "Sterownik" and "Udostępnianie" cards from `core` with the firmware state: `GET /devices`, `GET /firmware/pellet-boiler-pelux200`, `POST`/`DELETE /devices/:rootId/firmware-update` ("Aktualizuj firmware" / "Anuluj aktualizację"; from 1.5.0 the controller gets the offer in the `commands/next` reply within about 15 s) | on entry; the "Sterownik" card every 15 s while an update request is pending |

- **Data freshness.** A reading is stale when it is older than `3 × poll_interval_seconds` (or has no time): the view then shows the red "Offline od …" banner at the top (`OfflineBanner` from `core`). The default interval used for the judgement is 300 s until the properties are loaded.
- **Alarm state.** The state chip in the hero card and the "Urządzenia kotła" card show the regulator alarm when `alarm` is `true` or `state` = 8 (Alarm); the Alarmy tab lists active alarms and the history.
- **No data.** An `{}` reply from `/last` gives the message "Brak danych od sterownika" (no data from the controller).
- Paths outside the boiler menu (e.g. `/hp`) redirect to `/`.
