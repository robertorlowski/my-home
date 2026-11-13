# co firmware — technical documentation

[← System documentation](../../../../docs/en/README.md) · [1. Business description](1-business-description.md) · [2. How it works](2-how-it-works.md) · **3. Technical documentation** · [Polski](../3-dokumentacja-techniczna.md)

## Hardware

| Part | Details |
|---|---|
| Board | ESP32 (PlatformIO `esp32dev`) |
| RS-485 | 9600 8N1, half duplex; addresses: CHPC `0x41`, DTU `0x69`, `co` `0x10` |
| Display | ST7735 128×160, portrait |
| Clock | RTC DS3231, NTP synchronisation (Polish time) |
| Button | GPIO5, active high, 50 ms debounce |
| Relays | CO and CWU (switched together) |

Pins and addresses are in `src/hardware_config.hpp`.

Since 2026-10-03 the Pellux 200 boiler (ecoMAX bus, formerly on this controller's UART2) is read by a separate board — [devices/pellet-boiler-pelux200](../../../pellet-boiler-pelux200/README.md) (Polish).

## Files (`devices/co/src`)

| File | Role |
|---|---|
| `main.cpp` | main loop: CHPC and PV readings, mode button, cloud exchange, `co` replies as device 0x10 |
| `access_point_policy.*` | when the `MyHome-HeatPump-XXXX` AP should run (3 min / 1 min / 5 min) |
| `cloud_client.*` | HTTPS to My Home (`hp/add`, `pv/add`, `devices/register`), WebSocket `/ws?rootId=` (since 1.4.0 also `qnap` → one command in RAM, `sendQnapResult`), 409 handling |
| `command_sink.hpp` | command queue interface (`SerialBus` on the device, `RecordingSink` in tests) |
| `config_portal.*` | web server on port 80 (`/`, `/telemetry.json`, `/pv.json`, `/install`, `/save`) |
| `cop_estimator.*` | COP estimate of the 300 l tank per compressor cycle |
| `device_config.*` | Wi-Fi and Root ID in NVS (namespace `hp`), SN from the MAC, `/install` login data; removes the keys of the former boiler role at start |
| `device_io.*` | display, RTC and NTP, Wi-Fi AP+STA, relays, writing replies to the bus |
| `domain_types.hpp` | PV types, `SERIAL_OPERATION`, `WORK_MODE`, `ControllerMode`, `DeviceSettings` |
| `hardware_config.hpp` | addresses 0x10 and 0x69, DTU register map, pins |
| `heat_pump_data_processor.*` | parse the CHPC JSON, feed the COP estimator |
| `json_converters.hpp` | ArduinoJson converters (PV fields, `time` as `YYYY.MM.DD HH:MM:SS`, modes) |
| `modbus_frame.*` | CHPC command frames (5 B), Modbus queries to the DTU (8 B), CRC-16/MODBUS |
| `operation_controller.*` | cloud state → RS-485 commands (changes only), modes, OFF sequence, force from PV, retry after mismatch, relays |
| `operation_parser.*` | `operation` JSON → `ServerOperationState`, with ranges |
| `operation_types.hpp` | `ServerValue`/`ServerOperationState` (`present` flag), `HeatPumpReport`, merging |
| `pv_data_processor.*` | two DTU replies → installation totals and `panels[]` |
| `pv_telemetry.*` | `POST /api/pv/add` and `/pv.json` document |
| `qnap_relay.*` | QNAP commands (since 1.4.0, trial): `parseQnapAddress` (private IPv4:port only), `parseQnapRequest` (the `qnap` message), `buildQnapResult` (the `qnap_wynik` reply, body up to 1 KB without splitting a UTF-8 character); no Arduino, `native` tests. The `POST` itself is sent by `relayQnapRequest` in `main.cpp` |
| `serial_bus.*` | RS-485 queue in three classes (safety, PV continuation, regular); 500 ms, 3 s, 5 ms |
| `telemetry.*` | `POST /api/hp/add` and `/telemetry.json` document |
| `secrets.example.h` | template of `secrets.h` (outside git): default Wi-Fi and optional `CLOUD_ROOT_ID` |

## RS-485 protocol with CHPC

Command frame: `[0x41][cmd][d1][d2][0xFF]`. Decimal numbers: `d1` = integer part, `d2` = hundredths. Watts: `d1 = W/100`, `d2 = W%100`.

| cmd | Meaning | Source in the operation |
|---|---|---|
| `0x01` | read JSON | periodic reading |
| `0x03` | force start 0/1 | `force` (in `PV` — from PV production) |
| `0x04` | target T (max) | `co_max` or `cwu_max` |
| `0x05` | delta T | max − min |
| `0x08` | EEV superheat | `eev_setpoint` |
| `0x09` / `0x0A` / `0x0B` | hot / cold pump / crankcase heater | `hot_pomp`, `cold_pomp`, `sump_heater` |
| `0x0C` | CO on/off | `work_mode` (+ CO/CWU relays) |
| `0x0D` | EEV max (26–255) | `eev_max_pulse_open` |
| `0x0F` | EEV min (25–255), sent after `0x0D` | `eev_min_pulse_open` |
| `0x0E` | power limit (1001–4000 W) | `working_watt` |
| `0x10` | unlock after 5 errors | `error_reset` action |
| `0x11` | CHPC software restart | `restart` action (then the whole state again) |

`co` also answers as device `0x10`: `0x01` — telemetry with `PV` and `pv_power` in one JSON, `0x02` — settings and `controller_mode`, `0x03` — nothing.

DTU: two Modbus queries of five ports each — from `0x1000` and from `0x10C8` (ports every `0x28` addresses, although a record has 20 registers).

## Cloud contract

| Direction | Address | Content |
|---|---|---|
| `co` → server | `POST /api/hp/add?deviceId=SN&rootId=…` | telemetry (described in the [heat-pump module](../../../../docs/en/moduly/heat-pump/3-technical-documentation.md)) |
| server → `co` | reply | `{"operation": {...strings...}, "t_out": 12.3}` |
| `co` → server | `POST /api/pv/add?...` | `time`, `total_power` (required), `total_prod`, `total_prod_today`, `temperature` (lowest of the ports), `pv_power` (≥ 2000 W), `panels[]` |
| `co` → server | `POST /api/devices/register` | `{deviceType: "heat_pump", deviceId: SN, ip}` — at every start, after an IP change and after a 409 (`registrationDue()`), also with a Root ID; a different `rootId` in the reply replaces the stored one and restarts the WebSocket |
| server → `co` | WebSocket `/ws?rootId=` | `{"type":"operation"}` → immediate `hp/add`; after connecting `co` sends the text `ESP32`, by which the server recognises the controller socket |
| server → `co` → server | WebSocket (the same connection) | since 1.4.0, trial: `{"typ":"qnap",…}` → `POST` to the QNAP in the home network → `{"typ":"qnap_wynik",…}` (below) |

Up to 1.3.4 the contract also had **backup weather** (from 1.3.1: `weather_queries [{id, lat, lon}]` in the `hp/add` reply, a fetch from Open-Meteo while the bus is idle, the `weather [{id, temp, code, …}]` field and the counters `weather_ok`, `weather_fail`, `weather_code` in the next `hp/add`) and the **mail relay** (from 1.3.0: `mailKey` in the registration, SMTP credentials in the reply, the WebSocket message `{"type":"mail"}`, `GET /api/mail/next`). Since 1.4.0 (2026-11-13) neither exists, and no controller is a fallback any more (switch 1.4.0 dropped both too): only the server on Oracle fetches the weather and sends mail. The server sends `co` no `weather_queries` and ignores `weather`, the `weather_*` counters and `mailKey` from an older `co`; the mail relay task of an older `co` gets 404 from the removed `/api/mail/*` (only entries in the board's log).

A rejected PV reading is retried every 60 s until a newer one replaces it.

### QNAP commands (since 1.4.0, trial)

Since 2026-11-13. When the QNAP at home cannot be reached from outside but works in the home network, the server can send it one of the commands `stan` (state), `restart_sieci` (network restart), `restart` through `co` (the `--qnap` command on the server, described in the [core module](../../../../docs/en/moduly/core/3-technical-documentation.md#qnap-commands-through-the-co-controller-trial)). Around 2026-12-13 we check whether it was used; if not, the `qnap` handling will be removed from the firmware. The binding contract with the service on the QNAP: the private `oracle-cloud` repository, `qnap/polecenia-przez-co.md`.

| Direction | Message |
|---|---|
| server → `co` (WebSocket) | `{"typ":"qnap","id":"<request id>","adres":"<address>:<port>","cialo":"<JSON as text>","podpis":"<64 hex characters>"}` |
| `co` → QNAP (home network) | `POST http://<address>:<port>/polecenie`, `Content-Type: application/json`, header `X-Podpis: <signature>`, body unchanged |
| `co` → server (WebSocket) | `{"typ":"qnap_wynik","id":"…","status":<HTTP code or 0>,"cialo":"<QNAP answer, at most 1 KB>"}` |

- **Checks** (`parseQnapRequest`): `id` non-empty, up to 64 characters (otherwise the message is ignored); the address only a private IPv4 with a port (10/8, 172.16/12, 192.168/16, port 1–65535); the body non-empty, at most 1 KB; the signature 64 lowercase hex characters. A bad field gets an immediate `qnap_wynik` with status 0 and a short description.
- **Queue:** at most one command in RAM. A second one while the first is waiting gets an immediate `qnap_wynik` with status 0 ("sterownik wykonuje poprzednie polecenie", the controller is executing the previous command).
- **Sending** (`relayQnapRequest` in `main.cpp`): only with an idle RS-485 bus and Wi-Fi connected, a blocking `POST` with a 10 s limit (connect 4 s, answer 6 s). Every HTTP code goes back to the server with the QNAP answer cut to 1 KB without splitting a UTF-8 character; no connection is status 0 with a description.
- **No key and no memory:** the controller does not know the HMAC key (the service on the QNAP checks the signature), stores nothing, never retries and never sends anything to the QNAP on its own. Nothing from the QNAP goes into `hp/add`.
- **Tests:** `test/test_qnap_relay` (4): address only from a private network, reading without changing the body, other messages and bad fields, the reply with the 1 KB limit.

## Web pages (port 80)

| Address | Access | Content |
|---|---|---|
| `GET /` | open | view (HTML `TELEMETRY_PAGE` in `config_portal.cpp`; JS fetches both JSON documents every 5 s) |
| `GET /telemetry.json` | open | telemetry document |
| `GET /pv.json` | open | PV reading with panels (`{}` before the first reading) |
| `GET /install` | Basic Auth | Wi-Fi, SN and Root ID read-only, registration state (`PAGE_TEMPLATE`) |
| `POST /save` | Basic Auth | `ssid`, `password` (empty = unchanged); save in NVS, restart after 500 ms |

An unknown address redirects (302) to `/`. The `/install` login and password are in `src/device_config.hpp`. The page texts are in English (from 1.3.3: title "Heat pump controller", buttons "Save and restart" / "Register and restart", state "Registered in the cloud" / "Not registered…"). In 1.3.0–1.3.4 the `/install` page also had the "Mail (board key)" field with the key fingerprint and the mail relay state (in Polish, from `devices/common/mail_relay`); since 1.4.0 it is gone.

![Main page (wide)](../img/strona-glowna.png)

## Configuration

| NVS key (`hp`) | Meaning |
|---|---|
| `wifi_ssid`, `wifi_pass` | Wi-Fi (empty = value from `secrets.h`) |
| `root_id` | Root ID from registration (empty = `CLOUD_ROOT_ID` from `secrets.h`, if set) |
| `mode` | controller mode (`ControllerMode`), default `CLOUD` |
| `pellet_root`, `pellet_poll` | former boiler role (firmware of 2026-10-01–02); `loadDeviceConfig()` removes them at start |

Cloud settings (`DeviceSettings`: operating mode, temperatures) live only in RAM; after start they default to `OFF`, 35/45, 40/47 until the first operation.

## Build, tests, flashing

```bash
cp devices/co/src/secrets.example.h devices/co/src/secrets.h   # once, fill in
pio test -d devices/co -e native     # 89 tests (2026-11-13): operation controller, parser, COP, Modbus frames, PV, AP policy, diagnostics, OTA, QNAP commands
pio run -d devices/co                # esp32dev build
pio run -d devices/co -t upload      # flash over USB
```

The `native` tests need no hardware (`test/test_access_point_policy`, `test/test_bus_diagnostics`, `test/test_hp_link_watch`, `test/test_modbus_frame`, `test/test_operation_controller`, `test/test_ota`, `test/test_pv_data_processor`, `test/test_qnap_relay`; `test_weather_backup` was removed in 1.4.0 together with the weather). `esp32dev` build 1.4.0 (2026-11-13): static RAM 17.3 % (56,800 B; 1.3.4: 57,000 B), Flash 57.3 % of the 1.9 MB partition (1,126,697 B with the QNAP command code; 1.3.4: 1,145,873 B with the mail relay and the weather); without the mail relay task its 16 KB stack is free as well. The `co` RS-485 code is also used by the whole-chain test (`test/e2e`, `bridge.exe`), currently out of date.

Deployment order: the server first, then `co`, CHPC last.

## History

- [State before the refactor (2026-09-10)](../baseline-before-server-driven-refactor.md) (Polish)
- [Refactor to server-driven control (2026-09-20)](../server-driven-refactor-2026-09-20.md) (Polish) — some descriptions are out of date (number of web pages, permanent AP, sending before registration); this document prevails.
- [Proposal: reaching the QNAP through `co` (2026-11-13)](../propozycja-qnap-2026-11-13.md) (Polish) — options for a decision; only the commands were implemented, in a different way (WebSocket instead of `hp/add`, "QNAP commands" above).

## Known issues

- **The `error_reset` and `restart` actions are lost outside `CLOUD` mode**: `applyServerOperation` (`main.cpp`) rejects the whole operation then, and the server sends the action only once. The comment in `operation_controller.cpp` ("Maintenance actions run in every controller mode") describes an intent that is not met.
- **An outdated TODO** in `main.cpp` ("Scheduler must perform the MANUAL -> AUTO transition") — the server already does it.
- **`DeviceSettings.controllerMode`** is unused; the mode is kept in `OperationController::localMode`.
- **Security**: open AP, `/install` login and password in the code, HTTPS without certificate checking.
- **Silent range validation**: an out-of-range value is not applied, and the application does not show it.
- **A QNAP command blocks the loop** for up to 10 s (as the weather fetch used to), but only with an idle bus. When the bus does not become idle within 20 s, the server stops waiting ("no controller answer") and ignores the later result, while the command may still reach the QNAP later.
