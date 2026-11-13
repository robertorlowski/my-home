// Testy native (pio test -e native) logiki włącznika niezależnej od sprzętu: przekaźniki
// (polecenia chmury, odliczanie, zmiany ze strony i ich pierwszeństwo), JSON wymiany z
// chmurą, oferta OTA i naprawa łączności. Pliki .cpp z src są dołączane bezpośrednio (native nie buduje src).
#include <unity.h>

#include <string>

#include <net_recovery.hpp>
#include <ota.hpp>
#include <protocol.hpp>
#include <relays.hpp>
#include "../../src/net_recovery.cpp"
#include "../../src/ota.cpp"
#include "../../src/protocol.cpp"
#include "../../src/relays.cpp"

void setUp() {}
void tearDown() {}

void test_cloud_timed_on_turns_off_by_itself()
{
  RelayBank bank(1);
  TEST_ASSERT_TRUE(bank.applyCloud(0, true, 60, RelayMode::Schedule, 1000));
  TEST_ASSERT_TRUE(bank.relay(0).on);
  TEST_ASSERT_EQUAL_UINT32(30000, bank.remainingMs(0, 31000));
  // bez kolejnych poleceń (brak sieci) wyłącza się po 60 s
  TEST_ASSERT_EQUAL_UINT32(0, bank.update(60999));
  TEST_ASSERT_EQUAL_UINT32(1, bank.update(61000));
  TEST_ASSERT_FALSE(bank.relay(0).on);
  TEST_ASSERT_EQUAL_UINT32(61000, bank.relay(0).changedMs);
}

void test_cloud_refresh_extends_timer_without_state_change()
{
  RelayBank bank(1);
  bank.applyCloud(0, true, 10, RelayMode::Schedule, 0);
  // kolejna odpowiedź przesuwa koniec, stan bez zmian i bez nowego changedMs
  TEST_ASSERT_FALSE(bank.applyCloud(0, true, 10, RelayMode::Schedule, 5000));
  TEST_ASSERT_EQUAL_UINT32(0, bank.relay(0).changedMs);
  TEST_ASSERT_EQUAL_UINT32(0, bank.update(12000));
  TEST_ASSERT_TRUE(bank.relay(0).on);
}

void test_cloud_on_without_limit_stays_on()
{
  RelayBank bank(1);
  bank.applyCloud(0, true, 0, RelayMode::On, 0);
  TEST_ASSERT_EQUAL_UINT32(0, bank.update(10UL * 24 * 3600 * 1000));
  TEST_ASSERT_TRUE(bank.relay(0).on);
  TEST_ASSERT_EQUAL_UINT32(0, bank.remainingMs(0, 5000));
}

void test_local_change_wins_until_confirmed()
{
  RelayBank bank(1);
  bank.applyCloud(0, true, 600, RelayMode::Schedule, 0);
  TEST_ASSERT_TRUE(bank.applyLocal(0, RelayMode::Off, 0, true, 1000));
  TEST_ASSERT_FALSE(bank.relay(0).on);
  TEST_ASSERT_TRUE(bank.anyPending());
  // chmura jeszcze nie wie o zmianie: jej polecenie nie włącza przekaźnika
  TEST_ASSERT_FALSE(bank.applyCloud(0, true, 600, RelayMode::Schedule, 2000));
  TEST_ASSERT_FALSE(bank.relay(0).on);
  // potwierdzenie starszej zmiany nie kasuje nowszej
  const uint32_t first = bank.relay(0).pendingSeq;
  bank.applyLocal(0, RelayMode::On, 0, true, 3000);
  bank.confirmPending(0, first);
  TEST_ASSERT_TRUE(bank.anyPending());
  bank.confirmPending(0, bank.relay(0).pendingSeq);
  TEST_ASSERT_FALSE(bank.anyPending());
  TEST_ASSERT_TRUE(bank.applyCloud(0, false, 0, RelayMode::Off, 4000));
}

void test_local_timer_and_minutes_to_send()
{
  RelayBank bank(1);
  TEST_ASSERT_TRUE(bank.applyLocal(0, RelayMode::Timer, 30, false, 0));
  TEST_ASSERT_EQUAL_UINT32(30, bank.pendingMinutes(0, 0));
  // wysyłka po 10 min 30 s: zostało 19,5 min, w górę do 20
  TEST_ASSERT_EQUAL_UINT32(20, bank.pendingMinutes(0, 630000));
  TEST_ASSERT_EQUAL_UINT32(1, bank.update(30UL * 60000));
  TEST_ASSERT_EQUAL_STRING("schedule", relayModeName(bank.relay(0).mode));
  TEST_ASSERT_FALSE(bank.applyLocal(0, RelayMode::Timer, 0, false, 0));
}

void test_local_schedule_turns_off_only_without_cloud()
{
  RelayBank bank(1);
  bank.applyLocal(0, RelayMode::On, 0, true, 0);
  TEST_ASSERT_FALSE(bank.applyLocal(0, RelayMode::Schedule, 0, true, 1000));
  TEST_ASSERT_TRUE(bank.relay(0).on);
  TEST_ASSERT_TRUE(bank.applyLocal(0, RelayMode::Schedule, 0, false, 2000));
  TEST_ASSERT_FALSE(bank.relay(0).on);
}

void test_state_report_json()
{
  RelayBank bank(2);
  bank.applyCloud(1, true, 0, RelayMode::On, 5000);
  const std::string json = buildStateReport(bank, 65000);
  TEST_ASSERT_EQUAL_STRING("{\"uptimeS\":65,\"relays\":[{\"on\":false,\"changedS\":65},{\"on\":true,\"changedS\":60}]}",
    json.c_str());
}

// od 1.1.2: diagnostyka sterownika w zgłoszeniu stanu
void test_state_report_with_diag()
{
  RelayBank bank(1);
  ControllerDiag diag;
  diag.reset = "brownout";
  diag.boot = 7;
  diag.wifiDrops = 2;
  diag.rssi = -63;
  diag.httpMs = 840;
  // od 1.3.2: pamięć (pogoda w diagnostyce do 1.3.7)
  diag.heapFree = 61000;
  diag.heapMin = 30500;
  diag.heapBlock = 40000;
  diag.netHttpResets = 1;
  diag.netWifiReconnects = 4;
  const std::string json = buildStateReport(bank, 4000, &diag);
  TEST_ASSERT_EQUAL_STRING("{\"uptimeS\":4,\"relays\":[{\"on\":false,\"changedS\":4}],"
    "\"diag\":{\"reset\":\"brownout\",\"boot\":7,\"wifiDrops\":2,\"rssi\":-63,\"httpMs\":840,"
    "\"heapFree\":61000,\"heapMin\":30500,\"heapBlock\":40000,\"net\":{\"http\":1,\"wifi\":4}}}", json.c_str());
}

void test_apply_state_response()
{
  RelayBank bank(2);
  uint32_t changed = 0;
  TEST_ASSERT_TRUE(applyStateResponse(
    "{\"relays\":[{\"on\":true,\"offAfterS\":1200,\"mode\":\"schedule\"},{\"on\":false,\"mode\":\"off\"}]}",
    bank, 1000, changed));
  TEST_ASSERT_EQUAL_UINT32(1, changed);
  TEST_ASSERT_EQUAL_UINT32(1200000, bank.remainingMs(0, 1000));
  TEST_ASSERT_EQUAL_STRING("off", relayModeName(bank.relay(1).mode));
  TEST_ASSERT_FALSE(applyStateResponse("{\"message\":\"x\"}", bank, 2000, changed));
  TEST_ASSERT_FALSE(applyStateResponse("nie json", bank, 2000, changed));
}

void test_mode_body_json()
{
  TEST_ASSERT_EQUAL_STRING("{\"relay\":1,\"mode\":\"timer\",\"minutes\":45,\"source\":\"controller\"}",
    buildModeBody(1, RelayMode::Timer, 45).c_str());
  TEST_ASSERT_EQUAL_STRING("{\"relay\":2,\"mode\":\"off\",\"source\":\"controller\"}",
    buildModeBody(2, RelayMode::Off, 45).c_str());
}

void test_default_minutes_from_settings()
{
  JsonDocument document;
  deserializeJson(document, "{\"default_on_minutes\":45}");
  uint16_t minutes = 30;
  TEST_ASSERT_TRUE(parseDefaultMinutes(document.as<JsonVariantConst>(), minutes));
  TEST_ASSERT_EQUAL_UINT16(45, minutes);
  // 0 = „Włącz” bez limitu
  deserializeJson(document, "{\"default_on_minutes\":0}");
  TEST_ASSERT_TRUE(parseDefaultMinutes(document.as<JsonVariantConst>(), minutes));
  TEST_ASSERT_EQUAL_UINT16(0, minutes);
  deserializeJson(document, "{\"default_on_minutes\":20000}");
  TEST_ASSERT_FALSE(parseDefaultMinutes(document.as<JsonVariantConst>(), minutes));
  TEST_ASSERT_EQUAL_UINT16(0, minutes);
}

void test_ota_offer()
{
  JsonDocument document;
  deserializeJson(document, "{\"firmware\":{\"version\":\"1.0.1\",\"url\":\"https://x/fw.bin\","
    "\"sha256\":\"ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789\"}}");
  OtaOffer offer;
  TEST_ASSERT_TRUE(parseOtaOffer(document.as<JsonVariantConst>(), offer));
  TEST_ASSERT_EQUAL_STRING("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", offer.sha256.c_str());
  TEST_ASSERT_TRUE(shouldUpdate(offer, "1.0.0", ""));
  TEST_ASSERT_FALSE(shouldUpdate(offer, "1.0.1", ""));
  TEST_ASSERT_FALSE(shouldUpdate(offer, "1.0.0", "1.0.1"));
}

// Oferta w odpowiedzi na stan (zlecenie „Aktualizuj”): jedna próba na zlecenie, nowe zlecenie = kolejna.
void test_ota_offer_per_request()
{
  JsonDocument document;
  deserializeJson(document, "{\"relays\":[{\"on\":false,\"mode\":\"schedule\"}],\"firmware\":{\"version\":\"1.1.1\","
    "\"url\":\"https://x/fw.bin\",\"sha256\":\"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
    "\"request\":\"1759500000000\"}}");
  OtaOffer offer;
  TEST_ASSERT_TRUE(parseOtaOffer(document.as<JsonVariantConst>(), offer));
  TEST_ASSERT_EQUAL_STRING("1.1.1#1759500000000", otaKey(offer).c_str());
  TEST_ASSERT_TRUE(shouldUpdate(offer, "1.1.0", ""));
  TEST_ASSERT_TRUE(shouldUpdate(offer, "1.1.0", "1.1.1"));
  TEST_ASSERT_FALSE(shouldUpdate(offer, "1.1.0", "1.1.1#1759500000000"));
  offer.request = "1759500099000";
  TEST_ASSERT_TRUE(shouldUpdate(offer, "1.1.0", "1.1.1#1759500000000"));

  // odpowiedź bez oferty: zlecenia nie ma
  deserializeJson(document, "{\"relays\":[]}");
  TEST_ASSERT_FALSE(parseOtaOffer(document.as<JsonVariantConst>(), offer));
}

// od 1.3.7: naprawa łączności (net_recovery.hpp), czasy w minutach od startu bez odpowiedzi serwera
constexpr uint32_t MIN = 60000;

void test_net_recovery_steps()
{
  NetRecovery net;
  net.begin(0, false);
  TEST_ASSERT_TRUE(net.next(2 * MIN - 1, true) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(2 * MIN, true) == NetAction::ResetHttp);
  TEST_ASSERT_TRUE(net.next(3 * MIN, true) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(5 * MIN, true) == NetAction::ReconnectWifi);
  TEST_ASSERT_TRUE(net.next(9 * MIN, true) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(10 * MIN, true) == NetAction::ReconnectWifi);
  TEST_ASSERT_TRUE(net.next(15 * MIN, true) == NetAction::Restart);
  TEST_ASSERT_EQUAL_UINT32(1, net.httpResets());
  TEST_ASSERT_EQUAL_UINT32(2, net.wifiReconnects());
}

void test_net_recovery_online_resets_clock()
{
  NetRecovery net;
  net.begin(0, false);
  TEST_ASSERT_TRUE(net.next(2 * MIN, true) == NetAction::ResetHttp);
  net.online(4 * MIN);
  TEST_ASSERT_TRUE(net.next(5 * MIN, true) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(6 * MIN, true) == NetAction::ResetHttp);
  TEST_ASSERT_TRUE(net.next(9 * MIN, true) == NetAction::ReconnectWifi);
}

// włączony przekaźnik: bez restartu, dalej ponowne łączenie z Wi-Fi co 5 min
void test_net_recovery_no_restart_with_relay_on()
{
  NetRecovery net;
  net.begin(0, false);
  net.next(2 * MIN, false);
  net.next(5 * MIN, false);
  net.next(10 * MIN, false);
  TEST_ASSERT_TRUE(net.next(15 * MIN, false) == NetAction::ReconnectWifi);
  TEST_ASSERT_TRUE(net.next(16 * MIN, false) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(16 * MIN, true) == NetAction::Restart);
}

// po restarcie z braku łączności kolejny dopiero po 60 min; odpowiedź serwera wraca do 15 min
void test_net_recovery_after_net_restart()
{
  NetRecovery net;
  net.begin(0, true);
  TEST_ASSERT_TRUE(net.afterNetRestart());
  TEST_ASSERT_TRUE(net.next(15 * MIN, true) == NetAction::ReconnectWifi);
  TEST_ASSERT_TRUE(net.next(59 * MIN, true) == NetAction::ReconnectWifi);
  TEST_ASSERT_TRUE(net.next(60 * MIN, true) == NetAction::Restart);
  net.online(61 * MIN);
  TEST_ASSERT_FALSE(net.afterNetRestart());
  TEST_ASSERT_TRUE(net.next(76 * MIN, true) == NetAction::Restart);
}

// millis() przekręca się po ok. 49 dniach
void test_net_recovery_millis_wrap()
{
  NetRecovery net;
  net.begin(0xFFFFFFFFUL - MIN + 1, false);
  TEST_ASSERT_TRUE(net.next(MIN - 1, true) == NetAction::None);
  TEST_ASSERT_TRUE(net.next(MIN, true) == NetAction::ResetHttp);
}

int main()
{
  UNITY_BEGIN();
  RUN_TEST(test_cloud_timed_on_turns_off_by_itself);
  RUN_TEST(test_cloud_refresh_extends_timer_without_state_change);
  RUN_TEST(test_cloud_on_without_limit_stays_on);
  RUN_TEST(test_local_change_wins_until_confirmed);
  RUN_TEST(test_local_timer_and_minutes_to_send);
  RUN_TEST(test_local_schedule_turns_off_only_without_cloud);
  RUN_TEST(test_state_report_json);
  RUN_TEST(test_state_report_with_diag);
  RUN_TEST(test_apply_state_response);
  RUN_TEST(test_mode_body_json);
  RUN_TEST(test_default_minutes_from_settings);
  RUN_TEST(test_ota_offer);
  RUN_TEST(test_ota_offer_per_request);
  RUN_TEST(test_net_recovery_steps);
  RUN_TEST(test_net_recovery_online_resets_clock);
  RUN_TEST(test_net_recovery_no_restart_with_relay_on);
  RUN_TEST(test_net_recovery_after_net_restart);
  RUN_TEST(test_net_recovery_millis_wrap);
  return UNITY_END();
}
