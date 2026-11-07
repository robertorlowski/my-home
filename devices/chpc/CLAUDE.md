# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

CHPC (Cheap Heat Pump Controller) is an Arduino firmware for an AVR board that runs a heat pump. It switches the compressor, the hot-side and cold-side circulating pumps, the sump (compressor) heater and a 4-way valve. It drives a stepper EEV, reads DS18B20 temperature sensors on OneWire, measures compressor power with a current transformer, and is controlled from a 1602 I2C LCD with buttons and/or RS-485. Changes on this branch include COP calculation, RS-485 commands and wattage limits stored in EEPROM. Commit messages and some code comments are in Polish.

The entire firmware is one file: [src/CHPC_firmware.ino](src/CHPC_firmware.ino), about 2200 lines. [archiwum/](archiwum/) holds old snapshots of the firmware and is not built. Do not read, search or use it as a reference (access is denied in `.claude/settings.json`). [docs/](docs/) holds the PCB files (Gerber, BOM, schematic) and photos.

## Building / flashing

The project builds with PlatformIO ([platformio.ini](platformio.ini), env `promini` = Arduino Pro Mini ATmega328P 5V/16MHz). There is no linter or test suite. The libraries (`OneWire`, `DallasTemperature`, `LiquidCrystal_I2C`) come from `lib_deps`.

```sh
pio run                            # compile (pio is in ~/.platformio/penv/Scripts/ if not on PATH)
pio run -t upload --upload-port COM3
pio device monitor                 # 9600 baud
```

**Diagnostic build.** `pio run -e promini_debug -t upload --upload-port COM3` builds with `DEBUG_LOG`: the firmware works as usual and also sends, unasked, JSON lines `{"t":ms,"ev":...}` on the UART: `boot` (settings), `btn` (raw buttons and the menu input ADC reading `a1`, 1023 = 5 V), `rel` (relay changes), `eev` (start and end of each valve move), `err`, `lcd` (every menu and status text) and `st` (temperatures, W, EEV, errors and loop count every 10 s). It still answers `0x01`. Capture with `powershell -ExecutionPolicy Bypass -File tools/serial-log.ps1 -Port COM3 -Seconds 300`; logs go to `logs/` (git-ignored). Never use it on a bus wired to `co`. It fills flash to ~99.9%, so trim it when the firmware grows. `pio test -e native_debug` runs `test/test_chpc_debuglog` against it (`native` skips that suite).

The "redefined" warnings for `DISPLAY`, `INPUTS`, `BUTTON_REPEAT_MS` and similar come from PlatformIO's ino-to-cpp pass, which ignores `#ifdef`. They are harmless. The real compile warnings come after them.

**Flash is 95.0% full** (29 174 B of 30 720 B, 2026-09-29). Check the `Flash:` line after every change. `String` concatenation is expensive here, so prefer `F("...")` and direct `print` calls.

**Tests on the PC (main test path).** Use these first, because they are fast and have no quota.

- **Unity firmware simulation.** `pio test -e native` runs 7 scenario suites in `test/test_chpc_*`, about 15 s in total. Each suite compiles the unmodified `src/CHPC_firmware.ino` against hardware mocks in [test/sim_env/](test/sim_env/):
  - `Arduino.h`: virtual `millis`/`delay`, a `String` class, the UART, and a CT sine wave for the power reading;
  - `DallasTemperature.h`: sensors that can be plugged in and out; after `sim::powerOnSensor(s)`/`powerOnSensors()` a sensor returns 85 °C until 750 ms after `requestTemperatures()`, like a real DS18B20;
  - `EEPROM.h` and `LiquidCrystal_I2C.h`. The LCD mock also keeps `sim::lcdLog`, a log of everything printed. Tests and the sensor discovery hook read status and error texts from it, because the production build sends them only to the LCD. `sim::tx` should hold only JSON.

  `chpc_sim.h` provides the helpers: `boot()`, which runs sensor discovery like a human would, plus `runMs()`, `waitUntil()`, `query()`/`sendFrame()` (acting as `co`), `jsonNumber()` and `resetGlobalsLikeReboot()`.
- **Harness rules.**
  - Each suite runs as its own process. Tests inside a suite form one ordered scenario, because firmware globals are never reset between them.
  - A reboot is `resetGlobalsLikeReboot()` + `setup()`. It also restarts `millis()` from zero.
  - Long waits use `runMs(ms, 1000..2000)`. Right after a stop, sample densely (`runMs(3000)`), otherwise the RMS power window still carries the old power.
  - Firmware functions that are called before they are defined need a prototype in `chpc_sim.h`. Arduino IDE and PlatformIO add these prototypes automatically; this build does not.
- **Full chain across all three projects.** `test/e2e/` in the My Home root (not in this folder) joins the pieces:
  - `bridge.exe`, built by `build-bridge.sh`, combines the simulated firmware with the real `co` code (`operation_parser`, `operation_controller`, `modbus_frame`, `cop_estimator`);
  - `run-e2e.mjs` plays `co`'s HTTP role against a local My Home and drives the web UI with Playwright and the system Edge.

  To run it:
  1. start `npm run local` in My Home: a persistent MongoDB in `.local-db/` plus the server on 4001 and the client on 5173;
  2. from the My Home root: `cd test/e2e && npm install && sh build-bridge.sh && node run-e2e.mjs`.

  Results go to `test/raport-testow/` in the My Home root (`e2e-wyniki.json`, `e2e-log.txt`, screenshots). The folder is created by the run and ignored by git, so it exists only locally.

**Simulation (Wokwi, secondary).** [test-wokwi/](test-wokwi/) (described in its README.md) holds a Wokwi project: `diagram.json` (a Nano stands in for the Pro Mini), `wokwi.toml` (points to the PlatformIO build) and `scenario.yaml`. The scenario runs the whole flow. It discovers the sensors (each DS18B20 is attached through a push button to mimic plugging it in), sends RS-485 frames, resets the board and checks that EEPROM survived. The CI token is in `.wokwi-token` in the repo root, which git ignores. `wokwi-cli` is not installed globally; download `wokwi-cli-win-x64.exe` from the wokwi-cli GitHub releases.

```sh
pio run -e wokwi && WOKWI_CLI_TOKEN=$(grep -m1 -o 'wok_[A-Za-z0-9]*' .wokwi-token) wokwi-cli test-wokwi --scenario scenario.yaml --timeout 280000
```

The free plan stops a run after 5 minutes, and sensor discovery alone takes about 60 s of simulated time. Wokwi does not simulate resistor dividers, so A6 (the current sensor) is biased by a potentiometer at mid position. Keep the setpoint below `Ttarget` in scenarios, because the simulated current reading is not realistic once the compressor starts. A sensor's temperature can be changed during a run with `set-control: { part-id: sTbe, control: temperature, value: -1 }`. This works although the Wokwi docs do not list it. Messages printed with `Print_D` go only to the LCD, so scenarios cannot wait for them. A logic analyzer (`la`) records RX (D0) and TX (D1). Run with `--vcd-file out.vcd`, then `test-wokwi/latency.sh out.vcd` prints, for each RS-485 request, the simulated time until the reply starts ("brak" means no reply). Wall-clock time is useless for this, because Wokwi does not run at a steady speed. The free plan also has a monthly CI-minute quota, which ran out on 2026-09-23.

RS-485 runs at 9600 baud on the hardware UART (pins 0/1); `RS485Serial` is a `#define` for `Serial`. That means RS-485 is disconnected while the board is being flashed over USB.


## Configuration model (compile-time `#define`s)

Behaviour is selected by editing the `USER OPTIONS` block at the top of the `.ino`, lines ~21–119. Nothing is selected at runtime:

- **Board:** only `BOARD_TYPE_G` (the gonzho000 PCB v1.3) is supported. Support for boards F and G9 (relays driven through a 74HC595) was removed. `halifise()` writes the relay outputs.
- **Display:** `DISPLAY_1602` (I2C LCD 16x2, address 0x27) or `DISPLAY_NONE`. The 0.96" OLED support (`DISPLAY_096`) was removed.
- **Serial mode:** `RS485_HUMAN`, `RS485_PYTHON` or `RS485_NONE`. The default is `RS485_PYTHON`: the bus carries only replies to `co`, and status and error texts go to the LCD only. A `-D` build flag overrides it. The `wokwi` env builds with `RS485_HUMAN`, because the Wokwi scenarios wait for those texts on the UART. Never flash the `wokwi` build to a pump that is wired to `co`.
- **Feature flags:** `EEV_SUPPORT`, `EEV_ONLY`, `INPUTS_AS_BUTTONS` and `EEV_DEBUG`. `WATCHDOG` was removed: on a Pro Mini with the stock bootloader, a watchdog reset can end in an endless reset loop. Restart is done in software instead (`softRestart()`, a jump to address 0).
- **Protection thresholds:** `T_*_MIN/MAX`, `MAX_WATTS`. **Timing constants:** `POWERON_PAUSE`, `MINCYCLE_*`, `DEFFERED_STOP_*`. **EEV tuning:** `EEV_*`. Note: several `T_*` defines end with a stray `;`, so they can only be used as whole initializers (`const double cT_x = T_X;`), not inside expressions.

The power limit `c_wattage_max` also works as a deliberate switch. When it is above `MAX_WATTS` (3200), the flow protection ("Err CP") is on. Any limit of 3200 W or less turns it off (the user sets 3200 W), for example when the heat pump runs from another power source on which the flow sensor is unreliable. Keep this coupling.

Code is heavily wrapped in `#ifdef`. When you change logic, make sure it still compiles under the other display, serial and EEV combinations, or guard it correctly.

## Runtime architecture

The sketch uses the usual `setup()`/`loop()` structure. All state is in globals, including shared scratch variables `i, z, x, y, d, e, tempint, tempdouble, outString`. Check that a scratch variable isn't already in use before you reuse it.

- **`setup()`:** sets up the pins, then initializes serial and display (`InitS_and_D`). It loads persisted settings from EEPROM and discovers the DS18B20 addresses (`FindAddr`), which it stores in EEPROM behind the `MAGIC` byte. Changing `MAGIC` forces the sensors to be discovered again.
- **`loop()`:** is non-blocking and timed with `millis()`. Each pass:
  1. Takes one current sample for the asynchronous RMS power measurement (`async_wattage`). Supply voltage comes from `ReadVcc()`.
  2. Advances the EEV stepper by at most one step (`eevise()`), following `EEV_apulses`, `EEV_fast` and the `EEV_PULSE_*_MILLIS` pacing.
  3. Checks for overload and reads the emergency input.
  4. Parses RS-485 commands. This block sits before the check cycle so that it still runs while the check cycle `return`s during `POWERON_PAUSE`. Code placed after the check cycle can be skipped by that `return`. Right after it, `error_count >= 5` (lock) ends the pass: control stops, but RS-485 keeps answering and accepts `0x10` (unlock) and `0x11` (restart).
  5. Handles buttons (`input_type` selects which setting the buttons edit: `INPUT_TYPE_*`), then updates the display.
  6. Runs the **check cycle** once every `millis_cycle` (1 s). It reads the temperatures (`Get_Temperatures`; `-127` means the sensor is missing). It sets `errorcode` (`ERR_*`), runs the EEV control algorithm (keep superheat Tae−Tbe at `T_EEV_setpoint`), and then decides whether the compressor, pumps and sump heater should run. That decision applies the protections and the minimum on/off cycle times. `stopOnError()` is the common shutdown path. While the compressor is off, frost protection (`frost_protect`) runs the hot-side pump when any connected sensor is ≤ `T_FROST_ON` (0 °C). It stops the pump once all sensors are ≥ `T_FROST_OFF` (2 °C).
- **Sensors:** the DS18B20s live in `st_tsens sensors[T_SENSORS]`, indexed by `BIT_*`, which is also their bit in `used_sensors` and their slot in the EEPROM address layout. `Tae, Tbe, Ttarget, Tsump, Tci, Tco, Thi, Tho, Tbc, Tac, Touter, Tcwu` are references to the array elements, and `sensor_names[]` holds their display names. Code that handles every sensor the same way loops over the array. `.e` marks a sensor as enabled. The README table explains the abbreviations.
- **EEPROM:** runtime-tunable settings sit at fixed addresses (`eeprom_addr_co`, `_EEV_MAX`, `_EEV_MIN`, `_EEV_setpoint`, `_dT`, `_WATT`) and are written with `WriteFloatEEPROM`/`WriteIntEEPROM`. The sensor addresses are stored before these, so keep new addresses clear of both.
- **RS-485 commands:** handled in the `switch` in the RS-485 block of `loop()` (step 4 above). The response is built by `StatsSerial()`. New settings must be written to EEPROM when they need to survive a reboot. The protocol is a contract with another project, described in the next section.

## RS-485 contract with the `co` controller

The bus master is the ESP32 firmware `co` in `devices/co` of the same My Home repository (PlatformIO; the old `D:\DevLocal\arduino_src\heatpump` copy is out of date). It polls this heat pump, forwards the data to a cloud service, computes COP and sends settings back. **Any change to the frame format, command codes, value encoding or JSON keys must be made in both projects.** On the `co` side, the relevant code is:

- `src/modbus_frame.cpp`: command encoding, covered by `test/test_modbus_frame` (`pio test -e native`).
- `src/serial_bus.cpp`: queue, timing and frame detection.
- `src/heat_pump_data_processor.cpp` and `src/cop_estimator.cpp`: JSON parsing and COP.
- `src/device_io.cpp`: the TFT dashboard.
- `src/operation_controller.cpp`: which commands are sent and when.

**Bus.** Half-duplex RS-485, 9600 8N1. The same line carries three devices, and only `co` starts a transfer:

| Address | Device | Frame format |
|---|---|---|
| `0x41` | this heat pump | 5-byte frames described below |
| `0x69` | Hoymiles DTU (PV inverters) | Modbus RTU with CRC; responses are about 200 bytes |
| `0x10` | `co` itself | answers 4-byte requests `[0x10][op][x][0xFF]` |

CHPC must ignore every frame whose first byte isn't `0x41` and must never send anything it wasn't asked for.

**Request.** `[0x41][cmd][d1][d2][0xFF]`. Decimal values are sent as `d1` = whole part and `d2` = hundredths, so 45.5 is sent as `[45][50]`. Watts are sent as `d1` = W/100 and `d2` = W%100.

| cmd | Meaning | Sent by `co` |
|---|---|---|
| `0x01` | return JSON stats | GET_HP_DATA: every 10 s while running, every 30 s idle (every 10th poll goes to the PV inverters instead) |
| `0x02` | same as `0x01` | not used |
| `0x03` | force start, `d1` = 0/1 | SET_HP_FORCE_ON/OFF |
| `0x04` | T setpoint (CO max), decimal | SET_T_SETPOINT_CO = `co_max` or `cwu_max` |
| `0x05` | T delta, decimal | SET_T_DELTA_CO = max − min |
| `0x07` | EEV max open | not used (duplicate of `0x0D`) |
| `0x08` | EEV superheat setpoint, decimal | SET_EEV_SETPOINT |
| `0x09` / `0x0A` / `0x0B` | force hot pump / cold pump / sump heater, `d1` = 0/1 | SET_HOT_PUMP / SET_COLD_PUMP / SET_SUMP_HEATER |
| `0x0C` | CO on/off, `d1` = 0/1 | SET_HP_CO_ON/OFF |
| `0x0D` | EEV max open pulses, `d1` 26–255 (≤ 25 ignored). If the new maximum is ≤ the minimum, the minimum drops to max − 1. `0x07` behaves the same | SET_EEV_MAXPULSES_OPEN (`co` accepts `eev_max_pulse_open` 0–255) |
| `0x0F` | EEV min work position, `d1` 25–255 (< 25 ignored). If the new minimum is ≥ the maximum, the maximum rises to min + 1. It is stored in EEPROM, the same as the buttons use. `co` sends `0x0D` before `0x0F`, so any valid pair ends up as requested | SET_EEV_MINWORKPOS (`co` accepts `eev_min_pulse_open` 0–255, set in the web UI Settings tab) |
| `0x0E` | max watts, `d1*100 + d2`. Only 1001 to `MAX_WATTS_LIMIT` (4000) is accepted; anything else is ignored | SET_WORKING_WATT (`co` accepts `working_watt` 0–25599 from the cloud) |
| `0x10` | unlock: resets `error_count` (clears the `Error x5` lock); pumps keep running | HP_ERROR_RESET from the one-shot operation `error_reset:"1"` |
| `0x11` | software restart (`softRestart()`): relays off, `setup()` again, EEPROM reload, EEV calibration, 90 s pause | HP_RESTART from the one-shot operation `restart:"1"`. `co` then resends its whole state with the next operation, because CHPC forgets forced pumps and force start |

**Response to `0x01`.** One JSON object on one line, sent by `StatsSerial()`. `co` detects the end of the frame by 5 ms of silence and times out after 3 s. It spaces commands at least 500 ms apart and never waits for a reply to set-commands. This puts three constraints on CHPC:

- It must answer within 3 s, and the loop must not block for long. While it blocks, frames from `co` pile up in the UART buffer. The parser handles consecutive `[0x41 … 0xFF]` frames in one read, but a frame behind other bus traffic (a PV response) is still lost. `LiquidCrystal_I2C::begin()` alone contains `delay(1000)`, so outside `setup()` it is called only once a minute. Other blocking `delay()`s, slow `GetT` retries and the `error_count >= 5` lock-up still risk timeouts, which `co` counts in its `serial_read_timeout` telemetry.
- The JSON must go out without pauses longer than 5 ms.
- Nothing else may be sent while `co` waits for the response. JSON that fails to parse is counted in `hp_json_error`.

JSON keys `co` depends on (don't rename or remove them; adding keys is fine within the flash budget). Values may be numbers or quoted strings, because `co` accepts both:

- **COP calculation:** `HPS` (>0 = compressor running), `Tho`, `Ttarget`. Also `lt_pow`: Wh used since the last compressor start, reset at every start. And `lt_hp_on`: seconds of the current run, or the length of the last run once the compressor has stopped.
- **Dashboard:** `F`, `CO`, `Ttarget`, `Tmin`, `Tmax`, `Tbe`, `Tae`, `Tsump`, `Tho`, `EEV`, `EEV_dt`, `EEV_pos`, `Watts`, `HCS`, `CCS`.
- **Web app (My Home):** `EEVmax` and `EEVmin`, the current EEV limits. They also fill in the defaults of the Settings form.
- **Errors:**
  - `ERR`: code of the last error event;
  - `ERRn`: event sequence number, which grows with every event, so a repeated code is still a new event;
  - `ERRc`: `error_count`; 5 means locked.

  The codes are `ERRC_*` in the firmware and `client/src/devices/heat-pump/utils/errors.ts` in My Home; change both together. 1 sensor, 2 overload, 3 no flow, 4 wattage min, 5 Tho, 6 Tsump high, 7 Tbc, 8 Tae, 9 Tco, 10 relay, 11 locked x5, 12 Tsump low, 13 Tbe (evaporating below −1 °C for over 60 s: the plate heat exchanger may freeze). Each event also shows `ERR: …` on the LCD.
- **Cloud:** the whole object is forwarded as telemetry `HP`.

**Known mismatches with the current firmware:**

- `0x04` above `T_SETPOINT_MAX` and `0x05` above `T_DELTA_MAX` are silently ignored.
- With `RS485_HUMAN` (the `wokwi` env only), `PrintS_and_D()` also writes status and error text to the bus without being asked. That breaks the rule against sending unrequested data and can corrupt HP or PV reads. The production build (`promini`, `RS485_PYTHON`) does not do this.

## Cloud path: `co` ⇄ My Home

The data from this firmware continues to the My Home web app in the root of this repository (`D:\DevLocal\arduino_src\my-home`). It has an Express + TypeScript + Mongoose server in `server/src`, a React + Vite client in `client/src`, and a description of the whole system, which is the leading one for all three repos, in its `CLAUDE.md`. It is deployed at `https://chpc-web.onrender.com`. The whole chain is **chpc ⇄ RS-485 ⇄ co ⇄ HTTPS/WebSocket ⇄ My Home**. A change to any field has to be followed through all three repos. On the `co` side, the relevant files are `src/cloud_client.cpp`, `telemetry.cpp`, `operation_parser.cpp` and `operation_controller.cpp`.

**Telemetry.** `co` sends `POST /api/hp/add?rootId=<id>` every 10 s while the compressor runs and every 30 s when idle. The body contains:
- `HP`: the JSON from `StatsSerial()`, forwarded unchanged;
- `PV`: the inverter data;
- `time` as `"YYYY.MM.DD HH:MM:SS"`;
- `work_mode`, `co_min`, `co_max`, `cwu_min`, `cwu_max`, `co_pomp`, `cwu_pomp`, `pv_power`, `controller_mode`;
- COP estimates (`cop`, `cop_min`, `cop_max`, `t_min`, `t_max`, `cop_bottom_start`), computed by `co` from `HPS`, `Tho`, `Ttarget`, `lt_pow` and `lt_hp_on`;
- diagnostic counters (`serial_read_timeout`, `hp_json_error`, `pv_crc_error`, `cloud_*`, `operation_validation_error`…).

The server saves a record only when `HP.Ttarget` is truthy. It adds `t_out` (outdoor temperature from a weather API) and pushes a WebSocket `"update"` to browsers.

**Errors.** When `HP.ERRn` differs from the previous record and `HP.ERR` is not 0, the server stores the code in the top-level `error_code` field of the new record (`detectErrorEvent` in `server/src/modules/heat-pump/services/hp.service.ts`). `GET /api/hp/last-error` returns the newest record with `error_code` from the last 24 hours (a rolling window, not calendar days); older errors stay only in the data list. The client shows a small red bell in front of the "T:" label on the main view (error within 24 h or lock; description and time in the tooltip), a red row under the record in the data list, and the error, the counter and the "Odblokuj" and "Restart sterownika" buttons on the Settings tab.

**The Mongo schema is strict** (`server/src/modules/heat-pump/models/hp.model.ts`), so any key it does not list is silently dropped. That includes `EEV_pulse`, `cop_min`, `cop_max`, `controller_mode` and **all diagnostic counters**. The latest raw body stays available through `GET /api/hp`, which serves an in-memory cache, until the server restarts. **A new telemetry key must be added to the schema, the TS types `server/src/modules/heat-pump/types.ts` and `client/src/devices/heat-pump/types.ts`, and the client views**, or it will not be stored or shown.

**Operation.** The response to every POST is `{"operation":{…}}`. **All values are strings**, e.g. `"1"`, `"45"`. The keys are:
- `work_mode`: `M`, `A`, `CWU`, `OFF`. `co` also accepts `PV`, which the server never sends.
- `force`, `co_pomp`, `hot_pomp`, `cold_pomp`, `sump_heater`: `"0"` or `"1"`.
- `co_min`, `co_max`, `cwu_min`, `cwu_max`;
- `working_watt`, `eev_max_pulse_open`, `eev_min_pulse_open`, `eev_setpoint`.
- **One-shot actions** `error_reset` and `restart` (value `"1"`). They are queued by `POST /api/operation/action {action}`, added to exactly one `/hp/add` response and never merged into the manual or scheduled operation. `co` turns them into `0x10` / `0x11` and does not keep them.

Where the values come from:
- **Scheduler** (every 60 s): `work_mode`, `force` and the temperatures, from device defaults or the active schedule.
- **Manual overrides** from the `/settings` page (`POST /api/operation/set`): any key. They win over the scheduler, are re-sent on every POST, live only in server memory, and are cleared when an active schedule ends. A manual `force: "1"` is one-shot: the server drops it at the first compressor start (`HP.HPS` idle → running) after it was set and sends the scheduled `force` (or `"0"`) instead. A scheduled `forceStart` stays for the whole schedule entry.

`co` parses the operation and turns changed values into RS-485 commands:
- `co_max` / `cwu_max` → `0x04`;
- max − min → `0x05`;
- `working_watt` → `0x0E`;
- `eev_max_pulse_open` → `0x0D`, then `eev_min_pulse_open` → `0x0F`, then `eev_setpoint` → `0x08`;
- pumps and force → `0x09`–`0x0B`, `0x03`;
- work mode → `0x0C` plus `co`'s own CO/CWU relays.

`co` sends each value only once, and does not resend it until it changes.

**Validation happens in three places, each silently:**
- My Home checks nothing: neither the UI nor `/operation/set` has range checks.
- `co` rounds `co_*`/`cwu_*` to whole degrees in 1–50, and accepts `working_watt` 0–25599, `eev_max_pulse_open` 0–255 and `eev_setpoint` 0–255.99.
- CHPC applies its own limits (see the RS-485 table).

A value rejected downstream still shows as "set" in the web UI. Compare it with the telemetry (`WWatt`, `EEVmax`, `Tmax`) to see what the pump really uses.

**Known mismatches** (as of 2026-09-24):
- The server sends the WebSocket message `{type:"operation"}` only for one-shot actions (`/api/operation/action`), so they reach the pump within seconds. Ordinary settings from `/operation/set` still wait for the next periodic POST, 10–30 s later.
- (fixed 2026-09-24) The main view showed `lt_pow` with a "W" unit; it is now labelled "Energia cyklu" in Wh.
- (fixed 2026-09-24) The client's energy-cost code (`client/src/devices/heat-pump/utils/energy-cost-g12w.ts`) parsed only `YYYY-MM-DD`, while `co` sends `YYYY.MM.DD`. Dotted timestamps fell back to `new Date()`, which depends on the browser: Chrome/Edge read browser-local time, stricter engines threw "Nieprawidłowy czas" and no cost was shown. The parser now accepts both separators and always uses Warsaw time.
- The time of an error is the time of the telemetry record that first carries the new `ERRn` (see **Errors** above), so it is accurate to 10–30 s. CHPC has no clock.
- The server's API-key check (`verifyApiKey`) is disabled in `server/src/core/app.ts`. `POST /api/operation/set` is open and unvalidated.
- My Home tests (`npm test -w server`, vitest + mongodb-memory-server) cover the scheduler, `EEVmin` storage, error-event detection and one-shot actions. They do not cover the WebSocket.
