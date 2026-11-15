// Testy poleceń dla QNAP-a (qnap_relay.hpp, od 1.4.0): odczyt wiadomości WebSocket {"typ":"qnap",…}, adres tylko
// z sieci prywatnej, ciało do 1 KB, podpis 64 znaki hex, odpowiedź {"typ":"qnap_wynik",…} z ciałem przyciętym do 1 KB
// bez rozcinania znaku UTF-8. Od 1.5.0 budzenie: wiadomość {"typ":"qnap_wybudz",…} z adresami MAC, odczyt adresu MAC
// i treść pakietu budzącego Wake-on-LAN.
// Uruchamianie: pio test -e native (plik .cpp włączany bezpośrednio).
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include <cstring>
#include <unity.h>

#include <qnap_relay.hpp>
#include "../../src/qnap_relay.cpp"

namespace {
const char *const BODY = "{\"wersja\":1,\"polecenie\":\"stan\",\"czas\":1763060000000,\"nonce\":\"00112233445566778899aabbccddeeff\"}";
const char *const SIGNATURE = "fb0fb0d5f9c21cbe3d0ca056a4f87d7fef27f8a4937d575badff2c37f4990019";

JsonDocument message(const std::string &address = "10.1.2.3:8250", const std::string &body = BODY,
  const std::string &signature = SIGNATURE)
{
  JsonDocument document;
  document["typ"] = "qnap";
  document["id"] = "a1b2c3d4e5f60718";
  document["adres"] = address;
  document["cialo"] = body;
  document["podpis"] = signature;
  return document;
}
}

void setUp() {}
void tearDown() {}

void test_address_only_from_private_network()
{
  std::string host;
  uint16_t port = 0;
  TEST_ASSERT_TRUE(parseQnapAddress("10.1.2.3:8250", host, port));
  TEST_ASSERT_EQUAL_STRING("10.1.2.3", host.c_str());
  TEST_ASSERT_EQUAL_UINT16(8250, port);
  TEST_ASSERT_TRUE(parseQnapAddress("172.20.1.1:80", host, port));
  TEST_ASSERT_TRUE(parseQnapAddress("192.168.0.10:8250", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("172.32.1.1:8250", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("203.0.113.5:8250", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("10.1.2.3", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("10.1.2.3:0", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("10.1.2.3:8250x", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("10.300.2.3:8250", host, port));
  TEST_ASSERT_FALSE(parseQnapAddress("qnap.local:8250", host, port));
}

void test_reads_request_without_changing_body()
{
  QnapRequest request;
  std::string error;
  JsonDocument document = message();
  TEST_ASSERT_TRUE(parseQnapRequest(document.as<JsonVariantConst>(), request, error) == QnapParse::Ok);
  TEST_ASSERT_EQUAL_STRING("a1b2c3d4e5f60718", request.id.c_str());
  TEST_ASSERT_EQUAL_STRING("10.1.2.3", request.host.c_str());
  TEST_ASSERT_EQUAL_UINT16(8250, request.port);
  TEST_ASSERT_EQUAL_STRING(BODY, request.body.c_str());
  TEST_ASSERT_EQUAL_STRING(SIGNATURE, request.signature.c_str());
  TEST_ASSERT_TRUE(error.empty());
}

void test_other_messages_and_bad_fields()
{
  QnapRequest request;
  std::string error;
  JsonDocument operation;
  operation["type"] = "operation";
  operation["rootId"] = "6730c3a1b2c3d4e5f6070809";
  TEST_ASSERT_TRUE(parseQnapRequest(operation.as<JsonVariantConst>(), request, error) == QnapParse::NotQnap);
  JsonDocument withoutId = message();
  withoutId.remove("id");
  TEST_ASSERT_TRUE(parseQnapRequest(withoutId.as<JsonVariantConst>(), request, error) == QnapParse::NotQnap);

  JsonDocument publicAddress = message("203.0.113.5:8250");
  TEST_ASSERT_TRUE(parseQnapRequest(publicAddress.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  TEST_ASSERT_EQUAL_STRING("a1b2c3d4e5f60718", request.id.c_str());
  TEST_ASSERT_FALSE(error.empty());

  JsonDocument tooBig = message("10.1.2.3:8250", std::string(QNAP_BODY_MAX + 1, 'x'));
  TEST_ASSERT_TRUE(parseQnapRequest(tooBig.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  JsonDocument badSignature = message("10.1.2.3:8250", BODY, "ABC");
  TEST_ASSERT_TRUE(parseQnapRequest(badSignature.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
}

void test_result_message_with_body_limit()
{
  const std::string answer = "{\"ok\":true,\"polecenie\":\"stan\",\"opis\":\"line \\\"quoted\\\"\\n\"}";
  JsonDocument parsed;
  TEST_ASSERT_FALSE(deserializeJson(parsed, buildQnapResult("a1b2c3d4e5f60718", 200, answer)));
  TEST_ASSERT_EQUAL_STRING("qnap_wynik", parsed["typ"]);
  TEST_ASSERT_EQUAL_STRING("a1b2c3d4e5f60718", parsed["id"]);
  TEST_ASSERT_EQUAL(200, parsed["status"].as<int>());
  TEST_ASSERT_EQUAL_STRING(answer.c_str(), parsed["cialo"]);

  // bez połączenia: status 0
  TEST_ASSERT_FALSE(deserializeJson(parsed, buildQnapResult("a1b2c3d4e5f60718", 0, "brak polaczenia (HTTP -1)")));
  TEST_ASSERT_EQUAL(0, parsed["status"].as<int>());

  // „ł” to 2 bajty UTF-8: przycięcie w środku znaku cofa się do jego początku
  std::string longBody(QNAP_BODY_MAX - 1, 'a');
  longBody += "\xC5\x82zzz";
  TEST_ASSERT_FALSE(deserializeJson(parsed, buildQnapResult("a1b2c3d4e5f60718", 200, longBody)));
  TEST_ASSERT_EQUAL(QNAP_BODY_MAX - 1, strlen(parsed["cialo"] | ""));
  std::string exact(QNAP_BODY_MAX, 'b');
  TEST_ASSERT_FALSE(deserializeJson(parsed, buildQnapResult("a1b2c3d4e5f60718", 200, exact + "c")));
  TEST_ASSERT_EQUAL(QNAP_BODY_MAX, strlen(parsed["cialo"] | ""));
}

// przykładowe adresy MAC (administrowane lokalnie, nie istnieją)
JsonDocument wakeMessage()
{
  JsonDocument document;
  document["typ"] = "qnap_wybudz";
  document["id"] = "0011223344556677";
  JsonArray addresses = document["mac"].to<JsonArray>();
  addresses.add("02:00:00:00:00:01");
  addresses.add("02-00-00-AB-CD-EF");
  return document;
}

void test_mac_address()
{
  MacAddress mac{};
  TEST_ASSERT_TRUE(parseMacAddress("02:00:00:ab:cd:ef", mac));
  const uint8_t expected[6] = {0x02, 0x00, 0x00, 0xAB, 0xCD, 0xEF};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, mac.data(), 6);
  TEST_ASSERT_TRUE(parseMacAddress("02-00-00-AB-CD-EF", mac));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, mac.data(), 6);
  TEST_ASSERT_FALSE(parseMacAddress("02:00:00:ab:cd", mac));
  TEST_ASSERT_FALSE(parseMacAddress("02:00:00:ab:cd:ef:01", mac));
  TEST_ASSERT_FALSE(parseMacAddress("02:00:00:ab:cd:eg", mac));
  TEST_ASSERT_FALSE(parseMacAddress("0200.00ab.cdef.00", mac));
  TEST_ASSERT_FALSE(parseMacAddress("020000abcdef", mac));
  TEST_ASSERT_FALSE(parseMacAddress("ff:ff:ff:ff:ff:ff", mac));
  TEST_ASSERT_FALSE(parseMacAddress("00:00:00:00:00:00", mac));
  TEST_ASSERT_FALSE(parseMacAddress("", mac));
}

void test_magic_packet()
{
  MacAddress mac{};
  TEST_ASSERT_TRUE(parseMacAddress("02:00:00:ab:cd:ef", mac));
  uint8_t packet[QNAP_MAGIC_PACKET_SIZE];
  memset(packet, 0x55, sizeof(packet));
  buildMagicPacket(mac, packet);
  TEST_ASSERT_EQUAL(102, static_cast<int>(sizeof(packet)));
  for (size_t index = 0; index < 6; index++) TEST_ASSERT_EQUAL_UINT8(0xFF, packet[index]);
  for (size_t repeat = 0; repeat < 16; repeat++) TEST_ASSERT_EQUAL_UINT8_ARRAY(mac.data(), packet + 6 + repeat * 6, 6);
}

void test_wake_request()
{
  QnapRequest request;
  std::string error;
  JsonDocument document = wakeMessage();
  TEST_ASSERT_TRUE(parseQnapRequest(document.as<JsonVariantConst>(), request, error) == QnapParse::Ok);
  TEST_ASSERT_TRUE(request.wake);
  TEST_ASSERT_EQUAL_STRING("0011223344556677", request.id.c_str());
  TEST_ASSERT_EQUAL(2, static_cast<int>(request.macs.size()));
  const uint8_t second[6] = {0x02, 0x00, 0x00, 0xAB, 0xCD, 0xEF};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(second, request.macs[1].data(), 6);
  TEST_ASSERT_TRUE(request.body.empty());
  TEST_ASSERT_TRUE(error.empty());

  // zwykłe polecenie nie jest budzeniem
  JsonDocument ordinary = message();
  TEST_ASSERT_TRUE(parseQnapRequest(ordinary.as<JsonVariantConst>(), request, error) == QnapParse::Ok);
  TEST_ASSERT_FALSE(request.wake);
  TEST_ASSERT_TRUE(request.macs.empty());

  // złe pola: odpowiedź od razu (Invalid z id), bez adresów
  JsonDocument withoutAddresses = wakeMessage();
  withoutAddresses.remove("mac");
  TEST_ASSERT_TRUE(parseQnapRequest(withoutAddresses.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  TEST_ASSERT_EQUAL_STRING("0011223344556677", request.id.c_str());
  TEST_ASSERT_FALSE(error.empty());
  JsonDocument empty = wakeMessage();
  empty["mac"].to<JsonArray>();
  TEST_ASSERT_TRUE(parseQnapRequest(empty.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  JsonDocument tooMany = wakeMessage();
  for (int index = 0; index < 3; index++) tooMany["mac"].add("02:00:00:00:00:09");
  TEST_ASSERT_TRUE(parseQnapRequest(tooMany.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  JsonDocument badAddress = wakeMessage();
  badAddress["mac"].add("ff:ff:ff:ff:ff:ff");
  TEST_ASSERT_TRUE(parseQnapRequest(badAddress.as<JsonVariantConst>(), request, error) == QnapParse::Invalid);
  TEST_ASSERT_TRUE(request.macs.empty());
  JsonDocument withoutId = wakeMessage();
  withoutId.remove("id");
  TEST_ASSERT_TRUE(parseQnapRequest(withoutId.as<JsonVariantConst>(), request, error) == QnapParse::NotQnap);
}

int main()
{
  UNITY_BEGIN();
  RUN_TEST(test_address_only_from_private_network);
  RUN_TEST(test_reads_request_without_changing_body);
  RUN_TEST(test_other_messages_and_bad_fields);
  RUN_TEST(test_result_message_with_body_limit);
  RUN_TEST(test_mac_address);
  RUN_TEST(test_magic_packet);
  RUN_TEST(test_wake_request);
  return UNITY_END();
}
