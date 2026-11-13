# co firmware — how it works

[← System documentation](../../../../docs/en/README.md) · [1. Business description](1-business-description.md) · **2. How it works** · [3. Technical documentation](3-technical-documentation.md) · [Polski](../2-zasada-dzialania.md)

## Connection diagram

```mermaid
flowchart LR
    CHPC["CHPC 0x41<br/>heat pump"] <-- "RS-485 9600 8N1<br/>half duplex" --> CO
    DTU["Hoymiles DTU 0x69<br/>Modbus RTU"] <-- "RS-485" --> CO
    CO["co (ESP32) 0x10"]
    CO --> REL["CO / CWU relays"]
    CO --> LCD["ST7735 display 128×160"]
    RTC["RTC DS3231 + NTP"] --> CO
    BTN["button GPIO5"] --> CO
    CO <-- "Wi-Fi: HTTPS + WebSocket" --> SRV["My Home"]
    CO -- "AP MyHome-HeatPump-XXXX, web pages :80" --> USR["phone / laptop"]
```

Only `co` starts transmissions on the bus. There are at least 500 ms between frames; the end of a frame is 5 ms of silence; no answer within 3 s is a timeout.

Since 2026-10-03 `co` no longer reads the Pellux 200 boiler (ecoMAX bus); a separate board does — [devices/pellet-boiler-pelux200](../../../pellet-boiler-pelux200/README.md) (Polish).

## Main loop

Every `loop()` pass:

1. mode button (applied 5 s after the last press);
2. `serialBus.tick()` — send the next frame from the queue;
3. `operationController.tick()` — retry commands the queue did not accept;
4. CO/CWU relays;
5. received frames: CHPC → telemetry, DTU → PV, queries to `co` (0x10) → reply;
6. WebSocket, web pages, access point policy.

Then the timed tasks. Those that block (HTTP, NTP) wait until the bus is idle:

```mermaid
flowchart TD
    A["bus idle?"] -- no --> Z["next pass"]
    A -- yes --> NTP{"NTP every 6 h<br/>(after an error every 5 min)"}
    NTP --> REG{"start, IP change or 409?<br/>register (retry every 60 s)"}
    REG --> HP{"time to read CHPC?<br/>10 s (HPS>0) / 30 s"}
    HP -- yes --> R1["0x01 → pump JSON → POST /api/hp/add"]
    HP -- no --> FAST{"3 s after the last command<br/>(at most every 10 s)?"}
    FAST -- yes --> R1
    R1 --> PV{"60 s since the PV reading?"}
    FAST -- no --> PV
    PV -- yes --> R2["DTU: ports 1–5 (0x1000),<br/>then 6–10 (0x10C8) → POST /api/pv/add"]
    PV -- no --> Z
    R2 --> Z
```

- **The fast read** after a series of commands checks whether the pump accepted them and sends the fresh state at once; the regular cycle then starts over.
- **The WebSocket `operation` message** forces an earlier `POST /api/hp/add`.
- **A QNAP command** (since 1.4.0, trial): the WebSocket message `{"typ":"qnap"}` waits in RAM for an idle bus; then the controller sends one `POST` to the QNAP in the home network (at most 10 s, the loop waits) and sends the answer back as `{"typ":"qnap_wynik"}` over the same WebSocket ([technical documentation](3-technical-documentation.md#qnap-commands-since-140-trial)).
- **No answer from the pump** means `heatPumpLost()`: the first reading after it comes back resends the whole state to the pump.
- Telemetry is sent even with the pump disconnected (with an empty `HP`), so the server returns the operating mode.

## From a cloud operation to RS-485 commands

```mermaid
sequenceDiagram
    participant S as My Home
    participant C as cloud_client
    participant P as operation_parser
    participant O as operation_controller
    participant Q as serial_bus (queue)
    participant H as CHPC
    C->>S: POST /api/hp/add (telemetry)
    S-->>C: {operation: {...}, t_out}
    C->>P: parseServerOperation — ranges (temp. 1–50, power 0–25599, EEV 0–255)
    P->>O: applyServerPatch — merge with the expected state (missing field = unchanged)
    O->>O: reconcile — only values different from the last sent ones
    O->>Q: 0x0C CO, 0x04 Tmax, 0x05 delta, 0x0B heater, 0x0A/0x09 pumps,<br/>0x03 force, 0x0E power, 0x0D → 0x0F EEV, 0x08 superheat
    Q->>H: frames [0x41][cmd][d1][d2][0xFF] every ≥ 500 ms
    H-->>Q: (no acknowledgement)
    Q->>H: 0x01 (read) — 3 s after the series
    H-->>O: JSON: CO, F, Tmax, Tmin, HPS…
    O->>O: mismatch? → send the command again
```

Comparison after a pump reading (`updateHeatPumpReport`):

| Pump field | Expected | When checked |
|---|---|---|
| `HP.CO` | `1` for a mode other than `OFF`, `0` for `OFF` and local `OFF` | always (except `MANUAL_*`) |
| `HP.F` | `force` from the cloud (in `PV` — from PV production) | only when `HPS = 0`; CHPC accepts forcing only when idle |
| `HP.Tmax` | `co_max` / `cwu_max` | except `OFF`; tolerance 0.11 °C; skipped when > 50 |
| `HP.Tmax − HP.Tmin` | max − min | as above; skipped when > 30 |

Why all this: CHPC reads up to 49 bytes from the bus and processes them only if the buffer starts with its address. A command that lands in one read together with foreign bytes (e.g. the tail of a DTU reply) is lost without a trace.

## Controller modes

```mermaid
stateDiagram-v2
    [*] --> CLOUD: default (NVS "mode")
    OFF --> CLOUD: button
    CLOUD --> MANUAL_CO: button
    MANUAL_CO --> MANUAL_CWU: button
    MANUAL_CWU --> OFF: button
    note right of OFF: relays off, safety sequence<br/>(CO off, force off, pumps off), repeated<br/>when the pump reports CO=1 or F=1
    note right of CLOUD: applies the cloud operation;<br/>sends nothing until the first non-empty operation
```

In `MANUAL_CO` the relays are on, in `MANUAL_CWU` off; in both `co` sends no commands to the pump and does not check its state. The cloud operation (unlock and restart actions included) is applied **only in `CLOUD`**.

The CO and CWU relays switch together: on in `M`, `A`, `PV` (unless `co_pomp` = 0), off in `CWU` and `OFF`.

## Registration and the access point

```mermaid
sequenceDiagram
    participant C as co
    participant S as My Home
    C->>S: every request ?deviceId=SN (&rootId= if stored)
    alt start, IP address change or after a 409
        C->>S: POST /api/devices/register {deviceType: heat_pump, deviceId: SN, ip} (retry every 60 s)
        S-->>C: {rootId, ...}
        C->>C: rootId different from the stored one? store it in NVS, (re)start WebSocket /ws?rootId=
    end
    S-->>C: 409 (the Root ID belongs to another SN)
    C->>C: drop the Root ID, disconnect the WebSocket, register again
```

The `MyHome-HeatPump-XXXX` access point (open) starts with the controller. `AccessPointPolicy` switches it off when for 3 min Wi-Fi has an address and every cloud request gets an HTTP reply (any code). It comes back when Wi-Fi has been disconnected for more than 1 min or the cloud has been silent for 5 min.

## COP estimate

For every compressor cycle (`HPS` 0→1→0) `cop_estimator` computes the heat delivered to the 300 l tank from the rise of its mean temperature — the top is `Tho`, the middle `Ttarget`, the bottom is estimated — and divides it by the pump energy (`lt_pow`). The result is ready after the compressor stops; `cop_min` and `cop_max` are the bounds due to the unknown bottom temperature. The fields `cop`, `cop_min`, `cop_max`, `t_min`, `t_max`, `cop_bottom_start` go with the telemetry.

## Display

- Row 1: date, time, mode (`L-OFF`, `M-CO`, `M-CWU`, `C-M`, `C-A`, `C-PV`, `C-CWU`, `C-OFF`).
- Row 2: `P:` PV power/production today, `T:` inverter temperature (`--` at zero power or a reading older than 5 min).
- Middle: a yellow "F" when forced; the big `T:` = `HP.Ttarget` — red when `ERRc` > 0, yellow while the compressor runs, white otherwise; `T. out:` (outdoor temperature; `T. zew:` up to 1.3.2) from the cloud (`--` after 30 min without a new value).
- Bottom: centred `T:` Tmin - Tmax from the pump (what CHPC has set; since 1.2.1, before that `T.HP` and `T.od-do`), below it `T.be/T.ae`, `T.hp/T.ho` (Tsump/Tho), `E.ev/E.dt`, `E.ps/Watt`, `HC.s/CC.s` (pumps).
- Mode screen (3 s after a button press): source (`LOCAL` / `CLOUD`), mode (`MANUAL`, `RECZNY` up to 1.3.2; `AUTO`; `OFF`), IP (`Error WIFI` without a network), `AP: <ip>` or `AP: off`.
- Display and web page texts are in English (from 1.3.3).
