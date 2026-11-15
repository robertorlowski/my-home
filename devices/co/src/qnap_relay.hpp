// Polecenia dla QNAP-a w sieci domowej przez sterownik (od 1.4.0, 2026-11-13; rozwiązanie próbne: ok. 13.12.2026
// sprawdzamy użycie i bez niego usuwamy całość). Serwer wysyła przez WebSocket
//   {"typ":"qnap","id":"<id żądania>","adres":"<adres:port>","cialo":"<JSON jako tekst>","podpis":"<hex>"}
// a sterownik wysyła ciało bez zmian POST-em na http://<adres>/polecenie z nagłówkiem X-Podpis (limit czasu 10 s)
// i odsyła tym samym WebSocketem
//   {"typ":"qnap_wynik","id":"…","status":<kod HTTP albo 0 bez połączenia>,"cialo":"<odpowiedź, najwyżej 1 KB>"}.
// Podpis (HMAC-SHA256 kluczem, którego sterownik nie zna) sprawdza usługa na QNAP-ie. Sterownik niczego nie zapisuje,
// nie ponawia i nie wysyła nic do QNAP-a sam z siebie. Adres tylko z sieci prywatnej.
//
// Budzenie (od 1.5.0, 2026-11-15; QNAP usypia po bezczynności i nie odpowiada wtedy na HTTP). Serwer wysyła
//   {"typ":"qnap_wybudz","id":"<id żądania>","mac":["aa:bb:cc:dd:ee:ff", …]}   (od 1 do QNAP_WAKE_MAX_MACS adresów)
// a sterownik wysyła w sieci domowej pakiet budzący (Wake-on-LAN: 6 bajtów 0xFF i 16 razy adres MAC, UDP port 9,
// na adres rozgłoszeniowy) do każdego adresu i odsyła
//   {"typ":"qnap_wynik","id":"…","status":200,"cialo":"{\"wyslano\":<liczba pakietów>}"}   albo status 0 z opisem.
// Pakiet budzący nie ma podpisu i niczego nie potwierdza: czy QNAP wstał, serwer widzi dopiero po jego połączeniu.
#pragma once

#include <ArduinoJson.h>
#include <array>
#include <stddef.h>
#include <stdint.h>
#include <string>
#include <vector>

// ciało polecenia i odpowiedzi QNAP-a: najwyżej 1 KB
constexpr size_t QNAP_BODY_MAX = 1024;
// budzenie: najwyżej tyle adresów MAC w jednej wiadomości; pakiet budzący ma zawsze 102 bajty
constexpr size_t QNAP_WAKE_MAX_MACS = 4;
constexpr size_t QNAP_MAGIC_PACKET_SIZE = 102;
constexpr uint16_t QNAP_WAKE_PORT = 9;

using MacAddress = std::array<uint8_t, 6>;

struct QnapRequest {
  std::string id;
  std::string host;
  uint16_t port = 0;
  std::string body;
  std::string signature;
  // true: wiadomość qnap_wybudz (pakiet budzący do adresów macs); pola host, port, body i signature są wtedy puste
  bool wake = false;
  std::vector<MacAddress> macs;
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

// "aa:bb:cc:dd:ee:ff" (także z myślnikami i wielkimi literami); false przy złym zapisie, adresie rozgłoszeniowym
// (same FF) i zerowym.
bool parseMacAddress(const std::string &text, MacAddress &mac);

// Pakiet budzący Wake-on-LAN dla adresu mac: 6 bajtów 0xFF, potem 16 razy adres (QNAP_MAGIC_PACKET_SIZE bajtów).
void buildMagicPacket(const MacAddress &mac, uint8_t packet[QNAP_MAGIC_PACKET_SIZE]);

// Wiadomość WebSocket od serwera (qnap albo qnap_wybudz); przy Invalid out.id jest ustawione, a error opisuje błąd.
QnapParse parseQnapRequest(JsonVariantConst message, QnapRequest &out, std::string &error);

// Odpowiedź do serwera; ciało przycięte do QNAP_BODY_MAX bajtów bez rozcinania znaku UTF-8.
std::string buildQnapResult(const std::string &id, int status, const std::string &body);
