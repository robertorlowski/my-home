// Licznik spalonego pelletu (od firmware 1.7.1; bez Arduino, testy w test_logic).
//
// Regulator w każdym SensorData (co ok. 2,5 s) podaje chwilowe zużycie paliwa w kg/h (fuel_consumption, szacowane
// z czasu pracy podajnika i jego wydajności z kalibracji). Licznik sumuje je jak FuelMeter w PyPlumIO (devices/ecomax.py):
// spalone += zużycie × (czas od poprzedniego SensorData / 3600); odcinek MAX_GAP_MS albo dłuższy jest pomijany
// (nie wiadomo, co się działo w przerwie). Stan w gramach jest narastający: pellet.cpp zapisuje go w NVS co
// SAVE_EVERY_MS i przed restartem, a wysyła w każdym odczycie jako fuel_burned_kg; zużycie za okres serwer liczy
// z różnicy stanów: spadek do 1 kg to restart bez zapisu (powrót do stanu z NVS sprzed najwyżej SAVE_EVERY_MS,
// przyrost 0), większy = nowy licznik, np. wymiana płytki (pellet-boiler-pelux200-fuel.service.ts).
#pragma once

#include <cstdint>

#include <ecomax_frame.hpp>

class FuelMeter {
public:
  static constexpr uint32_t MAX_GAP_MS = 5UL * 60 * 1000;
  static constexpr uint32_t SAVE_EVERY_MS = 5UL * 60 * 1000;

  // Stan po starcie (z NVS); pierwszy SensorData tylko ustawia czas odniesienia.
  void begin(double grams) { grams_ = grams < 0 ? 0 : grams; hasLast_ = false; }
  // SensorData z odczytanym zużyciem; bez zużycia nic się nie zmienia (przerwa rośnie).
  void onSensorData(const EcomaxFloat &consumptionKgPerHour, uint32_t nowMs);
  double grams() const { return grams_; }
  double kilograms() const { return grams_ / 1000.0; }

private:
  double grams_ = 0;
  bool hasLast_ = false;
  uint32_t lastMs_ = 0;
};
