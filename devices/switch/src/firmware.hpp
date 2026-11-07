// Stałe sprzętowe i kontraktowe sterownika włącznika, wspólne dla całego firmware.
// Zmiana DEVICE_TYPE wymaga zmiany typu urządzenia na serwerze (DeviceType.SWITCH).
#pragma once

#include <cstdint>

// Typ urządzenia w chmurze.
constexpr const char *DEVICE_TYPE = "switch";
// Wersja firmware: wysyłana w zgłoszeniu i porównywana z ofertą chmury (OTA). Podnieść przy
// każdym wydaniu, zanim zbudujesz obraz; tę samą wersję wpisuje się w aplikacji przy wgrywaniu.
// 1.1.2: diagnostyka w zgłoszeniu stanu (przyczyna startu, numer startu, zerwania Wi-Fi, RSSI, czas HTTP).
// 1.1.3: pogoda z Open-Meteo pobierana z domowego łącza i wysyłana w zgłoszeniu stanu (weather.hpp).
// 1.2.0: pogoda dla wielu miejsc z chmury (weather_queries, kafelki pogody na liście sterowników), tablica weather.
// 1.3.0: przekaźnik poczty (devices/common/mail_relay): klucz płytki w zgłoszeniu (mailKey), dane SMTP z chmury tylko
//        w RAM, wysyłka maili chmury (kody logowania) z domowego łącza, bo Render blokuje SMTP.
// 1.3.1: wspólna biblioteka pogody devices/common/weather używana także jako zapas przez sterownik co.
// 1.3.2: rozszerzona diagnostyka w zgłoszeniu stanu (pamięć sterty, wynik pobierania pogody: kod HTTP, błąd TLS);
//        2026-10-18 pogoda nie dochodziła przez 8 h przy działającym włączniku.
// 1.3.3: pogoda z modelu DWD ICON (models=icon_seamless) zamiast automatycznego wyboru Open-Meteo.
// 1.3.4: pogoda zwykłym HTTP zamiast HTTPS; po dobie pracy TLS nie dostawał pamięci (mbedtls -0x7F00,
//        2026-10-19: 808 nieudanych pobrań na 1072, największy blok sterty 45 KB).
// 1.3.5: strony sterownika (/, /install) po angielsku.
// 1.3.6: adres chmury dom.mojeturnie.pl (Oracle) zamiast chpc-web.onrender.com.
constexpr const char *FW_VERSION = "1.3.6";
// Nazwa nadawana nowemu urządzeniu przy pierwszym zgłoszeniu.
constexpr const char *DEVICE_NAME = "Włącznik";

// Przekaźniki płytki, w kolejności numerów w chmurze (1, 2, …). Płytka „ESP32 Relay AC X1”
// ma jeden przekaźnik Songle 30 A na GPIO2, włączany stanem wysokim (test pinów 2026-10-02
// wskazał GPIO17 albo GPIO2; na GPIO17 przekaźnik nie klikał, na GPIO2 działa, 2026-10-03).
// GPIO2 to pin trybu startu: wyjściem staje się dopiero w setup(), po starcie układu.
// Liczbę przekaźników sterownik wysyła w zgłoszeniu.
constexpr uint8_t RELAY_PINS[] = {2};
constexpr uint8_t RELAY_COUNT = sizeof(RELAY_PINS) / sizeof(RELAY_PINS[0]);
constexpr bool RELAY_ACTIVE_HIGH = true;

// Domyślny czas „Włącz” do pierwszego zgłoszenia (potem z chmury), 0 (bez limitu) – 10080 min.
constexpr uint16_t DEFAULT_ON_MINUTES = 30;
constexpr uint16_t MAX_ON_MINUTES = 10080;

// Stały adres chmury (nie ma go na stronie /install). Środowisko esp32dev-local
// (platformio.ini) podmienia go na lokalny serwer (npm run local) po HTTP; host, port
// i TLS dla WebSocket są wyliczane z tego adresu (switch.cpp, parseCloudUrl).
#ifndef SWITCH_CLOUD_URL
#define SWITCH_CLOUD_URL "https://dom.mojeturnie.pl/api/"
#endif
constexpr const char *CLOUD_URL = SWITCH_CLOUD_URL;
