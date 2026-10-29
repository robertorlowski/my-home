# Heat-pump module — how it works

[← System documentation](../../README.md) · [1. Business description](1-business-description.md) · **2. How it works** · [3. Technical documentation](3-technical-documentation.md) · [Polski](../../../moduly/heat-pump/2-zasada-dzialania.md)

## Control chain

```mermaid
flowchart LR
    CHPC["CHPC<br/>heat pump"] <-- "RS-485<br/>JSON and commands" --> CO["co<br/>ESP32"]
    DTU["Hoymiles DTU"] <-- "Modbus" --> CO
    CO -- "POST /hp/add every 10–30 s" --> HP["hp.controller<br/>addHp"]
    HP -- "reply: operation + t_out" --> CO
    CO -- "POST /pv/add every 60 s" --> PV["pv.controller"]
    SCH["scheduler<br/>every 60 s"] --> OPS["operation.service<br/>operation in memory"]
    UI["application: Settings<br/>/operation/set, /action"] --> OPS
    OPS --> HP
    HP --> DB[("MongoDB<br/>hp, pv, devices")]
    PV --> DB
    SCH --> DB
    HP -- "WebSocket update" --> WEB["application: main view"]
```

The server never connects to the pump on its own. The operation waits in server memory and `co` receives it in the reply to its next telemetry report.

## Telemetry → operation cycle

```mermaid
sequenceDiagram
    participant CO as co (ESP32)
    participant H as POST /api/hp/add
    participant O as operation.service
    participant P as pv.service
    participant S as hp.service
    participant M as MongoDB (hp)
    participant WS as WebSocket
    CO->>H: telemetry {HP: JSON from CHPC, time, work_mode, co_pomp, cop, ...}
    H->>O: getOperationData(rootId) + takeOperationActions (error_reset, restart)
    H->>O: clearOperation(rootId) — rebuilds the operation from schedule and manual fields
    H->>O: consumeManualForceOnStart — manual force is dropped when the compressor starts
    alt telemetry has HP.Ttarget
        H->>P: PV.total_power from the latest PV reading (≤ 3 min) if there is no own PV
        H->>S: addHpData: rootId, deviceType, deviceId, t_out (IMGW), error_code
        S->>M: save the record
        S->>WS: "update" for browsers
    end
    H-->>CO: {operation: {...all values as strings}, t_out}
```

When CHPC does not answer, `co` still sends telemetry (with an empty `HP`). The server does not store it but returns the operation, so the controller knows the operating mode even with the pump disconnected.

## Scheduler (every minute)

```mermaid
flowchart TD
    T["every 60 s (first run immediately)"] --> MID{"new date in Warsaw<br/>since the previous run?"}
    MID -- yes --> MA["mode M → A: in properties<br/>and in the manual override"]
    MID -- no --> L
    MA --> L["for each heat_pump device"]
    L --> DEF["default operation:<br/>temperatures from properties (none → from telemetry),<br/>work_mode from properties (none → CWU),<br/>force = 0, no co_pomp"]
    DEF --> K{"work_mode"}
    K -- "A" --> TA["co schedules + off breaks"]
    K -- "CWU" --> TC["cwu schedules + off breaks"]
    K -- "M, OFF" --> NONE["no schedule"]
    TA --> ACT
    TC --> ACT
    ACT{"schedule active now?<br/>(day, date, hours, Warsaw)"}
    ACT -- yes --> PICK["one by priority:<br/>date > recurring, off > co/cwu,<br/>later start, _id"]
    PICK --> OPH["operation from the schedule"]
    ACT -- no --> WAS{"was one active a moment ago?"}
    NONE --> WAS
    WAS -- yes --> CLR["clear the manual overrides"]
    WAS -- no --> DFT
    CLR --> DFT["default operation;<br/>in mode A: work_mode = CWU"]
    OPH --> SAVE["replaceOperationData:<br/>schedule + manual fields"]
    DFT --> SAVE
```

| Schedule type | `work_mode` | Temperatures | `force` |
|---|---|---|---|
| `off` (break) | `OFF` | default | always `0` |
| `co` | `A` | `co_min`, `co_max` (missing in the schedule → default) | `forceStart` |
| `cwu` | `CWU` | `cwu_min`, `cwu_max` (missing → default) | `forceStart` |

A time range may cross midnight (`21:30–05:30`); the end is exclusive. Days: a specific weekday, every day, working days (Mon–Fri without holidays) or days off (weekends and Polish holidays, Christmas Eve included). A specific date takes precedence over the weekday.

## Operations: schedule, manual fields and actions

The server keeps three maps per device in memory:

```mermaid
flowchart LR
    SCHED["scheduledOperations<br/>latest from the scheduler"] --> MERGE["operations = {...schedule, ...manual}"]
    MAN["manualOperations<br/>POST /operation/set"] --> MERGE
    MERGE --> RESP["reply to /hp/add"]
    ACT["one-off actions<br/>error_reset, restart"] --> RESP
```

- **When the operation reaches `co`.** After telemetry is handled, `clearOperation` clears the current operation. Without manual overrides the operation is therefore sent once after each scheduler run (every minute) and the other replies are `{}` — `co` remembers the last values. With manual overrides every reply carries the full state.
- **Manual fields win** over the schedule, but only those actually sent.
- **Manual overrides disappear** when a schedule ends (transition "active → none"), after a server restart, and `force: "1"` alone — at the first compressor start (`HP.HPS`: idle → running). Without this a manual force would last forever, because CHPC clears forcing when it stops and `co` would send it again.
- **A mode change without `co_pomp`** stores `co_pomp: "1"`: `co` remembers the last value, so an earlier manual `"0"` would keep the CO/CWU relays off despite the mode change.
- **One-off actions** (`error_reset` — unlock, `restart` — CHPC restart) go into exactly one reply and are never merged with the operation. The server immediately sends `operation` over the WebSocket, so the action reaches the pump within seconds. **Note:** `co` applies the reply only in CLOUD mode; in other modes the action is lost.
- **The default mode never comes from telemetry** — the controller reports the mode it received, so the server would echo its own state back and e.g. `OFF` would stick forever.

On the `co` side changed values turn into RS-485 commands for CHPC. CHPC does not acknowledge commands, so after every reading `co` compares the pump state (`HP.CO`, `HP.F`, `HP.Tmax`, `HP.Tmin`) with the expected one and resends the command on a mismatch — details in the [co firmware documentation](../../../../devices/co/docs/en/2-how-it-works.md).

## Photovoltaics

```mermaid
sequenceDiagram
    participant CO as co
    participant PV as POST /api/pv/add
    participant S as pv.service
    participant M as MongoDB (pv)
    participant H as /hp/add, GET /hp
    CO->>PV: every 60 s {time, total_power, total_prod, total_prod_today, temperature, pv_power, panels[]}
    PV->>S: save + latest reading in memory (restored from the database after a restart)
    S->>M: pv document (panels removed after 90 days)
    H->>S: latest reading younger than 3 min?
    S-->>H: PV.total_power into the hp record; full summary for GET /hp
```

The `hp` record gets only `PV.total_power` — for the energy balance. **The `hp` and `pv` collections are never joined in an aggregation**: the production Atlas sorts at most 32 MB in memory and does not allow `allowDiskUse`.

## Pump errors

1. In every reply CHPC gives `ERR` (code of the last event), `ERRn` (event number, increasing) and `ERRc` (error counter; 5 = lock).
2. When `ERRn` differs from the previous record and `ERR` ≠ 0, the server stores `error_code` in the new record.
3. `GET /hp/last-error` returns the newest record with `error_code` from the last 24 h; while locked (`ERRc` ≥ 5) — with no time limit, until unlocked.
4. The application shows a red bell in the main view, a red row in the data table and a description in Settings.

| Code | Meaning | Code | Meaning |
|---|---|---|---|
| 1 | temperature sensor | 8 | Tae (after the evaporator) too low |
| 2 | overload (power) | 9 | Tco too low |
| 3 | no flow | 10 | relay (power while the compressor is off) |
| 4 | power too low | 11 | lock after 5 errors |
| 5 | Tho (outgoing water) too high | 12 | Tsump (crankcase) too low |
| 6 | Tsump too high | 13 | Tbe (before the evaporator) below −1 °C for more than 60 s |
| 7 | Tbc too high | | |

## Application screens

| Screen | Data | Refresh |
|---|---|---|
| **Main view** (`/`, `/hp`) | `GET /hp` (latest telemetry + PV summary), `GET /hp/last-error`; today's energy from `GET /hp/4day` | on the WebSocket `update` message and every 30 s; today's energy every 5 min |
| **Data** (`/data`) | `GET /hp/dates` (day list), `GET /hp/4day?date=` (day); CSV — `GET /hp/all` (whole year) | on day change |
| **Statystyki** (`/chart`) | day: `/hp/4day`; month and year: `/hp/monthly-summary` (energy, PV, G12w cost) | on period change |
| **Schedule** (`/schedules`) | `GET/POST/PUT/DELETE /schedules`, `GET /schedules/current`, `GET/PUT /device/properties` | every minute and after saving (the "działa teraz" marker) |
| **Operations** (`/operations`, shared page `core/pages/Operations`) | `GET /operations?date=` (5-day log) | today every 30 s and after WebSocket `update` |
| **Settings** (`/settings`) | `GET /operation` (form values), `POST /operation/set`, `POST /operation/action`, telemetry and error; the "Sterownik" and "Udostępnianie" cards from `core` | on entry |

The locks in Settings follow pump behaviour: "Pompy CO/CWU" are locked in `CWU` and `OFF` modes (there `co` keeps the relays off anyway); forced start and the cold/hot water pumps — while the compressor runs (`HPS` > 0), because the pump drives them itself and accepts forcing only when idle. "Crankcase heater" (state `HP.SHS`, operation `sump_heater`) is not locked: CHPC accepts the override at any time, also in `OFF`; switching it off only removes the override, and below Tsump 5 °C the heater keeps heating on its own.
