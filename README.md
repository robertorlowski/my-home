# My Home

Cloud control of a CHPC heat pump, photovoltaic data, a water pressure tank, a pellet boiler and a 230 V switch, in one repository: the server (Node.js), the web application (React) and the controllers' firmware (`devices/`).

## What it does

- **Heat pump.** The user sets the mode (central heating, domestic hot water, off), temperatures and schedules. Every minute the server works out what the pump should do, and the `co` controller (ESP32) passes it to the CHPC pump controller (Arduino Pro Mini) over RS-485.
- **Photovoltaics.** The `co` controller reads power and production from the Hoymiles microinverters every minute.
- **Water pressure tank.** At every pump start the tank controller runs the air compressor and reports run times. Water use is calculated from pump run time and water meter readings.
- **Pellet boiler.** A separate ESP32-C3 controller acts as an ecoNET module on the boiler's ecoMAX bus. It reads state and settings and changes parameters on request from the application.
- **Switch.** An ESP32 relay board follows the mode and schedule set in the application, for example to run a water heater.
- **Application.** Live state, history, charts, schedules, sharing with other accounts, Web Push notifications, a read-only demo and an installable PWA. The interface is available in Polish and English.

```text
CHPC (Pro Mini) ⇄ RS-485 ⇄ co (ESP32) ⇄ HTTPS / WebSocket ⇄ server (Node.js) ⇄ browser / phone
                             │                                    │
Hoymiles DTU (PV) ───────────┘                                    └── MongoDB
Water tank, pellet boiler, switch (ESP32) ⇄ HTTPS ⇄ server
```

## Repository layout

| Folder | Contents |
|---|---|
| `server/` | Express, TypeScript, Mongoose, WebSocket, schedulers |
| `client/` | React, TypeScript, Vite |
| `devices/co/` | ESP32 firmware between the heat pump, the PV system and the cloud (MIT) |
| `devices/chpc/` | heat pump controller firmware |
| `devices/water-pressure-tank/`, `devices/switch/`, `devices/pellet-boiler-pelux200/` | firmware of the other controllers |
| `docs/` | system and module documentation |
| `test/e2e/` | end-to-end test of the whole chain |

## Quick start

```bash
npm install
npm run local    # local MongoDB, server on port 4001, web app on port 5173
```

In production the server runs in Docker on Oracle Cloud (https://dom.mojeturnie.pl). It reads `MONGODB_URI` from the environment and the remaining settings from the database, changed on the system account screen. The "system" account has no password (since 2026-11-13): its sign-in code goes to the address in the `SYSTEM_EMAIL` setting (empty: `MAIL_ADMIN`; without mail it is written to the server log), and `node dist/server.js --kod-awaryjny` on the server prints an emergency code. Sign-in with a code from a phone app (TOTP) uses the shared key database of the mojeturnie.pl applications and needs `LOGOWANIE_KLUCZ` (and optionally `LOGIN_KEYS_DB`) in the environment; without them the e-mail code works as before. For local work, a template is in `server/.env.example`.

## Documentation

- [English documentation](docs/en/README.md): system overview, diagram and documentation of each module.
- [Dokumentacja po polsku](docs/README.md): the primary version.
- [CLAUDE.md](CLAUDE.md): the full contract between server, client and firmware, in Polish.

Firmware projects have their own `README.md` in `devices/<name>/`.
