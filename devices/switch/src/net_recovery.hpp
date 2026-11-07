// Naprawa łączności (od 1.3.7, 2026-11-07: włącznik przestał się zgłaszać na ponad godzinę, a router w jego sieci
// czasem się blokuje). Bez zależności od Arduino, testowane w test_logic; switch.cpp wykonuje zwrócone kroki.
// Czas braku łączności liczy się od ostatniej odpowiedzi HTTP serwera (dowolny kod, bo odpowiedź = sieć działa),
// a przed pierwszą odpowiedzią od startu płytki. Kroki, kolejno:
//   2 min    nowe połączenie z serwerem (zamknięcie połączenia keep-alive),
//   5 min    rozłączenie z routerem i ponowne połączenie Wi-Fi (nowy adres z DHCP), potem co 5 min,
//   15 min   restart płytki, tylko przy wyłączonych przekaźnikach (restart je wyłącza, a bez chmury nikt ich
//            nie przywróci); po takim restarcie następny dopiero po 60 min bez łączności.
#pragma once

#include <cstdint>

enum class NetAction { None, ResetHttp, ReconnectWifi, Restart };

struct NetRecoveryTimes {
  uint32_t resetHttpMs = 2UL * 60 * 1000;
  uint32_t reconnectWifiMs = 5UL * 60 * 1000;
  uint32_t reconnectEveryMs = 5UL * 60 * 1000;
  uint32_t restartMs = 15UL * 60 * 1000;
  // gdy płytka wystartowała po restarcie z powodu braku łączności (flaga w NVS)
  uint32_t restartAfterNetRestartMs = 60UL * 60 * 1000;
};

class NetRecovery {
public:
  // afterNetRestart: poprzedni start był restartem z braku łączności
  void begin(uint32_t nowMs, bool afterNetRestart);
  // odpowiedź HTTP serwera: łączność jest, liczenie od nowa
  void online(uint32_t nowMs);
  // Krok do wykonania teraz (najwyżej jeden na wywołanie). canRestart: przekaźniki wyłączone i nikt nie
  // konfiguruje płytki przez jej AP. Zwrócony krok uznaje się za wykonany.
  NetAction next(uint32_t nowMs, bool canRestart);
  uint32_t offlineMs(uint32_t nowMs) const { return nowMs - sinceMs_; }
  uint32_t httpResets() const { return httpResets_; }
  uint32_t wifiReconnects() const { return wifiReconnects_; }
  bool afterNetRestart() const { return afterNetRestart_; }

  NetRecoveryTimes times;

private:
  uint32_t sinceMs_ = 0;
  uint32_t lastReconnectMs_ = 0;
  bool httpResetDone_ = false;
  bool reconnected_ = false;
  bool afterNetRestart_ = false;
  uint32_t httpResets_ = 0;
  uint32_t wifiReconnects_ = 0;
};
