// Kiedy czytać ustawienia regulatora i kiedy ponowić ich wysyłkę do chmury (od firmware 1.11.0; bez Arduino,
// testy w test_logic).
//
// Odczyt (SettingsRefresh): pellet.cpp woła onReading przy każdym SensorData w zadaniu magistrali (busTask), więc
// odczyt działa także bez Wi-Fi i chmury (do 1.10.1 powody okresowy i „zmiana zadanej” sprawdzała pętla chmury,
// tylko przy Wi-Fi i po zgłoszeniu). Powody:
//   - pierwszy SensorData po przerwie GAP_MS albo dłuższej: regulator milczał albo nie wysyłał SensorData
//     (31.10.2026 10:02–10:50), mógł się w tym czasie zrestartować albo ktoś zmienił coś na panelu, a zmiana
//     tabeli wersji ramek (FrameVersionWatch w bus_watch.hpp) mogła przepaść;
//   - zmiana zadanej (kocioł, CWU, mieszacze; także na panelu), najwyżej co TRIGGER_MIN_MS i nie zaraz po odczycie;
//   - REFRESH_MS od końca ostatniego odczytu (od 1.11.0 co 15 min, wcześniej co 60 min) — sezon i tryb pracy
//     w aplikacji najwyżej kwadrans za kotłem także wtedy, gdy zmiany z panelu nie wykryje tabela wersji.
// Pozostałe powody odczytu (start, zapis parametru, tabela wersji, „p” z konsoli) zostają w pellet.cpp.
//
// Ponowienie wysyłki (SettingsUpload, pętla chmury): wysyłka idzie po każdym pełnym odczycie; po błędzie
// najpóźniej po RETRY_MS, a od razu, gdy udała się wysyłka odczytu kotła (serwer znowu odpowiada).
#pragma once

#include <cstdint>

class SettingsRefresh {
public:
  static constexpr uint32_t REFRESH_MS = 15UL * 60 * 1000;
  static constexpr uint32_t GAP_MS = 2UL * 60 * 1000;
  static constexpr uint32_t TRIGGER_MIN_MS = 60000;
  static constexpr uint32_t AFTER_READ_MS = 10000;

  enum class Reason : uint8_t { NONE, AFTER_GAP, TARGETS, PERIODIC };

  // Każdy SensorData. targets: podpis zadanych (≠ 0); readDoneMs: koniec ostatniego odczytu ustawień;
  // requested: odczyt zlecony, jeszcze nie zaczęty (powód „po przerwie” jest nim spełniony);
  // blocked: odczyt ustawień, zapis parametru albo zlecenie z aplikacji w toku — powód „po przerwie” czeka.
  Reason onReading(uint32_t nowMs, uint32_t targets, uint32_t readDoneMs, bool requested, bool blocked);

private:
  bool hasReading_ = false;
  uint32_t lastReadingMs_ = 0;
  uint32_t targets_ = 0;
  uint32_t lastTriggerMs_ = 0;
  bool gapPending_ = false;
};

class SettingsUpload {
public:
  static constexpr uint32_t RETRY_MS = 10UL * 60 * 1000;

  // Czy wysłać teraz niewysłane ustawienia.
  bool due(uint32_t nowMs) const { return !retrying_ || static_cast<int32_t>(nowMs - retryAtMs_) >= 0; }
  void onResult(bool ok, uint32_t nowMs);
  // Udana wysyłka odczytu kotła: serwer odpowiada, ponowienie bez czekania.
  void onCloudOk() { retrying_ = false; }

private:
  bool retrying_ = false;
  uint32_t retryAtMs_ = 0;
};
