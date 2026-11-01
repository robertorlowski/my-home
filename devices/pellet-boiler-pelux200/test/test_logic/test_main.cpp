// Testy native automatycznego wyboru polaryzacji magistrali (bus_polarity.*), licznika pelletu (fuel_meter.*)
// i powodów odczytu oraz ponowienia wysyłki ustawień regulatora (settings_refresh.*).
#include <unity.h>

#include <bus_polarity.hpp>
#include "../../src/bus_polarity.cpp"
#include <fuel_meter.hpp>
#include "../../src/fuel_meter.cpp"
#include <settings_refresh.hpp>
#include "../../src/settings_refresh.cpp"

void setUp() {}
void tearDown() {}

void test_flips_when_bytes_without_frames()
{
  BusPolarity polarity(false);
  TEST_ASSERT_FALSE(polarity.update(0));
  polarity.onBytes(500);
  TEST_ASSERT_FALSE(polarity.update(7999));
  TEST_ASSERT_TRUE(polarity.update(8000));
  TEST_ASSERT_TRUE(polarity.inverted());
  TEST_ASSERT_EQUAL_UINT32(1, polarity.switches());
}

void test_silence_keeps_polarity()
{
  BusPolarity polarity(true);
  polarity.update(0);
  polarity.onBytes(10);
  TEST_ASSERT_FALSE(polarity.update(9000));
  TEST_ASSERT_TRUE(polarity.inverted());
}

void test_frame_confirms_and_holds_longer()
{
  BusPolarity polarity(false);
  polarity.update(0);
  polarity.onFrame(1000);
  TEST_ASSERT_TRUE(polarity.confirmed());
  polarity.onBytes(5000);
  // potwierdzona: krótka seria złych bajtów (zakłócenia) nie zmienia polaryzacji
  TEST_ASSERT_FALSE(polarity.update(60000));
  TEST_ASSERT_TRUE(polarity.update(1000 + BusPolarity::CONFIRMED_SWITCH_AFTER_MS));
  TEST_ASSERT_TRUE(polarity.inverted());
  TEST_ASSERT_FALSE(polarity.confirmed());
}

void test_frames_keep_resetting_window()
{
  BusPolarity polarity(false);
  polarity.update(0);
  for (uint32_t t = 1000; t < 60000; t += 1000) {
    polarity.onBytes(300);
    polarity.onFrame(t);
    TEST_ASSERT_FALSE(polarity.update(t));
  }
  TEST_ASSERT_FALSE(polarity.inverted());
}

// Licznik pelletu jak FuelMeter w PyPlumIO: kg/h × czas od poprzedniego SensorData, przerwa ≥ 5 min pomijana.
void test_fuel_meter_integrates_like_pyplumio()
{
  FuelMeter meter;
  meter.begin(1000.0);  // stan z NVS: 1 kg
  EcomaxFloat rate;
  rate.present = true;
  rate.value = 3.6f;  // 3,6 kg/h = 1 g/s
  meter.onSensorData(rate, 10000);  // pierwszy: tylko czas odniesienia
  TEST_ASSERT_DOUBLE_WITHIN(0.001, 1000.0, meter.grams());
  meter.onSensorData(rate, 12500);  // 2,5 s
  TEST_ASSERT_DOUBLE_WITHIN(0.01, 1002.5, meter.grams());
  // przerwa 5 min: odcinek pominięty, potem liczy dalej
  meter.onSensorData(rate, 12500 + FuelMeter::MAX_GAP_MS);
  TEST_ASSERT_DOUBLE_WITHIN(0.01, 1002.5, meter.grams());
  meter.onSensorData(rate, 12500 + FuelMeter::MAX_GAP_MS + 1000);
  TEST_ASSERT_DOUBLE_WITHIN(0.01, 1003.5, meter.grams());
  // bez zużycia w ramce i przy 0 kg/h nic nie przybywa
  EcomaxFloat none;
  meter.onSensorData(none, 400000);
  rate.value = 0;
  meter.onSensorData(rate, 401000);
  TEST_ASSERT_DOUBLE_WITHIN(0.01, 1003.5, meter.grams());
  TEST_ASSERT_DOUBLE_WITHIN(0.00001, 1.0035, meter.kilograms());
}

using Reason = SettingsRefresh::Reason;
constexpr uint32_t MIN = 60000;

// Odczyt ustawień co 15 min od końca ostatniego odczytu, przy niezmienionych zadanych.
void test_settings_refresh_every_15_minutes()
{
  SettingsRefresh refresh;
  const uint32_t readDone = 1000;
  // SensorData co 2,5 s jak z regulatora: do 15 min od odczytu nic
  uint32_t now = 5000;
  for (; now < readDone + 15 * MIN; now += 2500) {
    TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(now, 7, readDone, false, false)));
  }
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::PERIODIC), static_cast<int>(refresh.onReading(now, 7, readDone, false, false)));
}

// Pierwszy SensorData po przerwie ≥ 2 min: odczyt od razu; krótsza przerwa nic nie zleca.
void test_settings_refresh_after_gap()
{
  SettingsRefresh refresh;
  const uint32_t readDone = 10 * MIN;
  refresh.onReading(readDone + 1000, 7, readDone, false, false);
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(readDone + 1000 + 2 * MIN - 1, 7, readDone, false, false)));
  const uint32_t back = readDone + 1000 + 4 * MIN;
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::AFTER_GAP), static_cast<int>(refresh.onReading(back, 7, readDone, false, false)));
  // kolejne SensorData bez przerwy: nic
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(back + 2500, 7, readDone, true, false)));
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(back + 5000, 7, back + 4000, false, false)));
}

// Przerwa w czasie zapisu parametru: odczyt czeka do jego końca; odczyt już zlecony spełnia powód.
void test_settings_refresh_gap_waits_for_writer()
{
  SettingsRefresh refresh;
  refresh.onReading(20 * MIN, 7, 19 * MIN, false, false);
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(25 * MIN, 7, 19 * MIN, false, true)));
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::AFTER_GAP), static_cast<int>(refresh.onReading(25 * MIN + 2500, 7, 19 * MIN, false, false)));

  SettingsRefresh requested;
  requested.onReading(20 * MIN, 7, 19 * MIN, false, false);
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(requested.onReading(25 * MIN, 7, 19 * MIN, true, false)));
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(requested.onReading(25 * MIN + 2500, 7, 25 * MIN + 2000, false, false)));
}

// Zmiana zadanej: odczyt, ale nie zaraz po odczycie ani częściej niż co minutę.
void test_settings_refresh_on_target_change()
{
  SettingsRefresh refresh;
  const uint32_t readDone = 2 * MIN;
  refresh.onReading(3 * MIN, 7, readDone, false, false);
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::TARGETS), static_cast<int>(refresh.onReading(3 * MIN + 2500, 9, readDone, false, false)));
  const uint32_t readDone2 = 3 * MIN + 20000;
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::NONE), static_cast<int>(refresh.onReading(3 * MIN + 22500, 11, readDone2, false, false)));
  TEST_ASSERT_EQUAL(static_cast<int>(Reason::TARGETS), static_cast<int>(refresh.onReading(4 * MIN + 5000, 13, readDone2, false, false)));
}

// Wysyłka ustawień: od razu; po błędzie po 10 min albo zaraz po udanej wysyłce odczytu kotła.
void test_settings_upload_retry_and_cloud_back()
{
  SettingsUpload upload;
  TEST_ASSERT_TRUE(upload.due(1000));
  upload.onResult(false, 1000);
  TEST_ASSERT_FALSE(upload.due(1000 + 9 * MIN));
  TEST_ASSERT_TRUE(upload.due(1000 + SettingsUpload::RETRY_MS));
  upload.onCloudOk();
  TEST_ASSERT_TRUE(upload.due(1000 + MIN));
  upload.onResult(true, 2000);
  TEST_ASSERT_TRUE(upload.due(2001));
}

int main()
{
  UNITY_BEGIN();
  RUN_TEST(test_flips_when_bytes_without_frames);
  RUN_TEST(test_silence_keeps_polarity);
  RUN_TEST(test_frame_confirms_and_holds_longer);
  RUN_TEST(test_frames_keep_resetting_window);
  RUN_TEST(test_fuel_meter_integrates_like_pyplumio);
  RUN_TEST(test_settings_refresh_every_15_minutes);
  RUN_TEST(test_settings_refresh_after_gap);
  RUN_TEST(test_settings_refresh_gap_waits_for_writer);
  RUN_TEST(test_settings_refresh_on_target_change);
  RUN_TEST(test_settings_upload_retry_and_cloud_back);
  return UNITY_END();
}
