#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ota.hpp>
#include <qnap_relay.hpp>

// Klient chmury chpc-web (https://dom.mojeturnie.pl/api/): POST JSON
// (hp/add, pv/add) z ?deviceId=<SN>[&rootId=<id>], rejestracja
// (devices/register) i WebSocket /ws?rootId=… Komunikat {type:"operation"}
// tylko ustawia flagę; POST wykonuje main.cpp, gdy magistrala jest wolna.
// {typ:"qnap"} (od 1.4.0, qnap_relay.hpp) zapamiętuje jedno polecenie dla QNAP-a w RAM; main.cpp wysyła je przy wolnej
// magistrali i odsyła wynik {typ:"qnap_wynik"} tym samym WebSocketem (sendQnapResult).
class CloudClient {
public:
  void begin();
  // Ponowne łączenie Wi-Fi co 10 s i obsługa WebSocketu; wołane w loop().
  void tick();
  // True raz po komunikacie WebSocket "operation": wyślij /hp/add od razu.
  bool takeOperationRequest();
  // Polecenie dla QNAP-a z WebSocketu (najwyżej jedno naraz); true raz, z poleceniem w out.
  bool takeQnapRequest(QnapRequest &out);
  // Wynik polecenia ({typ:"qnap_wynik"}) do serwera tym samym WebSocketem.
  void sendQnapResult(const std::string &json);
  // Zgłoszenie (devices/register) przy każdym starcie i po każdej zmianie
  // adresu IP, także z zapisanym Root ID: serwer zwraca rootId dla SN (ten sam
  // dla znanego sterownika), a sterownik podmienia zapisany, gdy jest inny.
  // Pole ip trafia do Ustawień w aplikacji. True, gdy w tym uruchomieniu nie
  // było udanego zgłoszenia z bieżącym IP i minęło opóźnienie ponowienia.
  // registerDevice() blokuje na całe żądanie HTTP, więc main.cpp woła je
  // tylko przy wolnej magistrali.
  bool registrationDue() const;
  void registerDevice();
  // Blokujący POST; zwraca treść odpowiedzi 2xx, a w każdym innym przypadku "".
  // Odpowiedź 409 kasuje Root ID i uruchamia ponowną rejestrację.
  String post(const String &path, const JsonDocument &data);
  // Pobiera obraz z oferty OTA do drugiej partycji i aktywuje go przy zgodnej
  // SHA-256 (restart robi main.cpp). Blokuje pętlę; status: opis wyniku.
  bool downloadFirmware(const OtaOffer &offer, String &status);
  int lastHttpStatus() const;
  // Any HTTP status, errors included, proves the internet is reachable.
  bool lastRequestAnswered() const;
  unsigned long lastAnswerAt() const;
  uint32_t requestErrorCount() const;
  uint32_t webSocketDisconnectCount() const;

private:
  static CloudClient *instance;
  static void handleWebSocketEvent(
    WStype_t type, uint8_t *payload, size_t length);

  void startWebSocket();
  void stopWebSocket();
  String send(const String &url, const JsonDocument &data);

  HTTPClient http;
  WebSocketsClient webSocket;
  bool webSocketStarted = false;
  bool operationRequested = false;
  // polecenie dla QNAP-a czekające na wolną magistralę (tylko RAM, bez ponowień)
  bool qnapPending = false;
  QnapRequest qnapRequest;
  bool registrationAttempted = false;
  unsigned long lastRegistrationAt = 0;
  // adres z ostatniego udanego zgłoszenia w tym uruchomieniu (brak = 0.0.0.0)
  IPAddress registeredIp;
  unsigned long lastWifiReconnectAt = 0;
  int httpStatus = 0;
  bool answered = false;
  unsigned long answeredAt = 0;
  uint32_t requestErrors = 0;
  uint32_t webSocketDisconnects = 0;
};
