#pragma once

#include <pv_telemetry.hpp>
#include <telemetry.hpp>

// Strony WWW sterownika na porcie 80 (sieć lokalna i AP MyHome-HeatPump-…):
// GET / (podgląd, otwarty), GET /telemetry.json, GET /pv.json (otwarte),
// GET /install i POST /save (Basic Auth, dane w device_config.hpp).
// Nieznany adres przekierowuje na /.

// Serves a single configuration page on port 80, reachable both on the local
// network and on the fallback access point.
void beginConfigPortal(const Telemetry &telemetry, const PvTelemetry &pvTelemetry);
void handleConfigPortal();
