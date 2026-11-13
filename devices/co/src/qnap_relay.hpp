// Polecenia dla QNAP-a w sieci domowej przez sterownik (od 1.4.0, 2026-11-13; rozwiązanie próbne: ok. 13.12.2026
// sprawdzamy użycie i bez niego usuwamy całość). Serwer wysyła przez WebSocket
//   {"typ":"qnap","id":"<id żądania>","adres":"<adres:port>","cialo":"<JSON jako tekst>","podpis":"<hex>"}
// a sterownik wysyła ciało bez zmian POST-em na http://<adres>/polecenie z nagłówkiem X-Podpis (limit czasu 10 s)
// i odsyła tym samym WebSocketem
//   {"typ":"qnap_wynik","id":"…","status":<kod HTTP albo 0 bez połączenia>,"cialo":"<odpowiedź, najwyżej 1 KB>"}.
// Podpis (HMAC-SHA256 kluczem, którego sterownik nie zna) sprawdza usługa na QNAP-ie. Sterownik niczego nie zapisuje,
// nie ponawia i nie wysyła nic do QNAP-a sam z siebie. Adres tylko z sieci prywatnej.
#pragma once

#include <ArduinoJson.h>
#include <stddef.h>
#include <stdint.h>
#include <string>

// ciało polecenia i odpowiedzi QNAP-a: najwyżej 1 KB
constexpr size_t QNAP_BODY_MAX = 1024;

struct QnapRequest {
  std::string id;
  std::string host;
  uint16_t port = 0;
  std::string body;
  std::string signature;
};

enum class QnapParse {
  // inna wiadomość (np. {"type":"operation"})
  NotQnap,
  // wiadomość qnap z id, ale złym polem: odpowiedź od razu ze statusem 0 i opisem w error
  Invalid,
  Ok,
};

// "a.b.c.d:port" tylko w sieciach prywatnych (10/8, 172.16/12, 192.168/16), port 1–65535; inaczej false.
bool parseQnapAddress(const std::string &text, std::string &host, uint16_t &port);

// Wiadomość WebSocket od serwera; przy Invalid out.id jest ustawione, a error opisuje błąd.
QnapParse parseQnapRequest(JsonVariantConst message, QnapRequest &out, std::string &error);

// Odpowiedź do serwera; ciało przycięte do QNAP_BODY_MAX bajtów bez rozcinania znaku UTF-8.
std::string buildQnapResult(const std::string &id, int status, const std::string &body);
