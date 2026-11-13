// Testy poleceń dla QNAP-a (qnap_relay.hpp, od 1.4.0): odczyt wiadomości WebSocket {"typ":"qnap",…}, adres tylko
// z sieci prywatnej, ciało do 1 KB, podpis 64 znaki hex, odpowiedź {"typ":"qnap_wynik",…} z ciałem przyciętym do 1 KB
// bez rozcinania znaku UTF-8.
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

int main()
{
  UNITY_BEGIN();
  RUN_TEST(test_address_only_from_private_network);
  RUN_TEST(test_reads_request_without_changing_body);
  RUN_TEST(test_other_messages_and_bad_fields);
  RUN_TEST(test_result_message_with_body_limit);
  return UNITY_END();
}
