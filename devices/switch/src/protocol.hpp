// JSON wymieniany z chmurą (bez zależności od Arduino, testowane w test_logic).
// Kontrakt: server/src/modules/switch (POST switch/state, PUT switch/mode, zgłoszenie).
#pragma once

#include <ArduinoJson.h>
#include <cstdint>
#include <string>

#include <relays.hpp>

// Diagnostyka sterownika w zgłoszeniu stanu (od 1.1.2, 2026-10-14: płytka restartowała się przy
// włączaniu bojlera 1,5–2 kW): przyczyna ostatniego startu (esp_reset_reason, np. "brownout" = spadek
// napięcia), numer startu z NVS, zerwania Wi-Fi od startu, siła sygnału i czas poprzedniej wymiany HTTP
// (opóźnione zgłoszenie serwer mógłby wziąć za przełączenie przekaźnika).
struct ControllerDiag {
  const char *reset = "unknown";
  uint32_t boot = 0;
  uint32_t wifiDrops = 0;
  int32_t rssi = 0;
  uint32_t httpMs = 0;
  // od 1.3.2 (2026-10-18: pogoda przestała dochodzić od 1.3.0, podejrzenie braku pamięci na kolejne połączenie TLS):
  // pamięć sterty [B] — wolna, najmniejsza od startu, największy ciągły blok (TLS potrzebuje ok. 16 KB ciągłych)
  uint32_t heapFree = 0;
  uint32_t heapMin = 0;
  uint32_t heapBlock = 0;
  // od 1.3.7 (net_recovery.hpp): od startu nowe połączenia z serwerem i ponowne łączenia z Wi-Fi z braku łączności
  uint32_t netHttpResets = 0;
  uint32_t netWifiReconnects = 0;
  // diagnostyka pogody (weather {places, ok, fail, code, tls, heapBlock, agoS}) była w 1.3.2–1.3.7; od 1.4.0 bez pogody
};

// Zgłoszenie stanu: {"uptimeS":N,"relays":[{"on":true,"changedS":12},…],"diag":{…}}.
// changedS — od ilu sekund przekaźnik jest w obecnym stanie; serwer liczy z tego czas
// włączenia i wyłączenia w historii, także po przerwie w łączności. diag tylko, gdy podane. Pole weather (pogoda
// z Open-Meteo, 1.1.3–1.3.7) od 1.4.0 nie istnieje: pogodę pobiera serwer.
std::string buildStateReport(const RelayBank &bank, uint32_t nowMs, const ControllerDiag *diag = nullptr);

// Odpowiedź na zgłoszenie stanu: {"relays":[{"on":true,"offAfterS":1200,"mode":"schedule"},…]}.
// Stosuje polecenia do bank (pomijając przekaźniki z niewysłaną zmianą lokalną). Zwraca
// false, gdy odpowiedź nie jest poprawnym JSON-em z tablicą relays; changedMask — maska
// przekaźników, które zmieniły stan.
bool applyStateResponse(const char *json, RelayBank &bank, uint32_t nowMs, uint32_t &changedMask);

// Zmiana ze strony sterownika dla PUT switch/mode: {"relay":1,"mode":"timer","minutes":30,"source":"controller"}.
std::string buildModeBody(uint8_t relayNumber, RelayMode mode, uint32_t minutes);

// Domyślny czas „Włącz” z settings odpowiedzi na zgłoszenie (default_on_minutes, 0 = bez limitu, do 10080).
// Zwraca false, gdy brak albo poza zakresem (out bez zmian).
bool parseDefaultMinutes(JsonVariantConst settings, uint16_t &out);
