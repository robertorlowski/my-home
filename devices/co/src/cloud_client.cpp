// Komunikacja z chpc-web: HTTPS (hp/add, pv/add, devices/register), WebSocket
// i pobieranie obrazu firmware (OTA na zlecenie „Aktualizuj”, od 1.1.0).
// Kontrakt: CLAUDE.md, punkty 3 (rejestracja, 404/409) i 8 (WebSocket).
// Certyfikat serwera nie jest weryfikowany (brak CA w kliencie).
// Zapasowy przekaźnik poczty (1.3.0–1.3.4, devices/common/mail_relay) usunięty w 1.4.0: serwer na Oracle wysyła
// maile sam. Klucz płytki, który 1.3.x zapisał w NVS, zostaje nieużywany.
#include <cloud_client.hpp>

#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <device_config.hpp>
#include <mbedtls/sha256.h>

namespace {
constexpr const char *CLOUD_HOST = "dom.mojeturnie.pl";
constexpr const char *CLOUD_BASE_URL = "https://dom.mojeturnie.pl/api/";

// The main loop is blocked for the whole request, so the timeouts must cover
// a TLS handshake plus a slow response without stalling the pump bus for
// minutes. A cold-started instance misses one cycle and is picked up by the
// next one.
constexpr int32_t CONNECT_TIMEOUT_MS = 5000;
constexpr uint16_t RESPONSE_TIMEOUT_MS = 5000;

// A failed registration is retried at this pace, so an unreachable cloud
// costs one blocked request a minute instead of stalling every loop.
constexpr unsigned long REGISTRATION_RETRY_MS = 60000;

// Pobieranie obrazu OTA: limit na połączenie i na przerwę w danych.
constexpr uint16_t OTA_TIMEOUT_MS = 15000;

String rootIdQuery()
{
  return String("rootId=") + deviceConfig().rootId;
}

// The serial always goes along: the server resolves the device from it when
// there is no rootId yet and rejects a rootId that belongs to another serial.
String deviceQuery()
{
  String query = String("deviceId=") + deviceSerial();
  if (deviceRegistered()) query += String("&") + rootIdQuery();
  return query;
}

String cloudUrl(const String &normalizedPath)
{
  const char separator = normalizedPath.indexOf('?') >= 0 ? '&' : '?';
  return String(CLOUD_BASE_URL) + normalizedPath + separator + deviceQuery();
}

// The server answers a rootId that does not match the serial with 409.
constexpr int HTTP_CONFLICT = 409;
}

CloudClient *CloudClient::instance = nullptr;

void CloudClient::begin()
{
  instance = this;
  if (deviceRegistered()) startWebSocket();
}

// The WebSocket path carries the rootId, so an unregistered controller opens
// it only once the registration has produced one.
void CloudClient::startWebSocket()
{
  String webSocketPath = String("/ws?") + rootIdQuery();
  webSocket.beginSSL(CLOUD_HOST, 443, webSocketPath.c_str());
  webSocket.onEvent(handleWebSocketEvent);
  webSocket.setReconnectInterval(10000);
  webSocketStarted = true;
}

void CloudClient::tick()
{
  if (WiFi.status() != WL_CONNECTED) {
    unsigned long now = millis();
    if (now - lastWifiReconnectAt >= 10000) {
      lastWifiReconnectAt = now;
      WiFi.reconnect();
    }
    return;
  }
  if (!webSocketStarted && deviceRegistered()) startWebSocket();
  if (webSocketStarted) webSocket.loop();
}

void CloudClient::stopWebSocket()
{
  if (!webSocketStarted) return;
  webSocket.disconnect();
  webSocketStarted = false;
}

// Zgłoszenie jest potrzebne, gdy w tym uruchomieniu nie było udanego z bieżącym
// adresem: po starcie (registeredIp = 0.0.0.0), po zmianie IP i po 409.
bool CloudClient::registrationDue() const
{
  return WiFi.status() == WL_CONNECTED && !(registeredIp == WiFi.localIP())
    && (!registrationAttempted
      || millis() - lastRegistrationAt >= REGISTRATION_RETRY_MS);
}

void CloudClient::registerDevice()
{
  registrationAttempted = true;
  lastRegistrationAt = millis();

  const String &serial = deviceSerial();
  if (serial.length() == 0) return;

  // Pompa zgłasza się bez nazwy (nadaje ją użytkownik).
  IPAddress sentIp = WiFi.localIP();
  JsonDocument request;
  request["deviceType"] = "heat_pump";
  request["deviceId"] = serial;
  request["version"] = FW_VERSION;
  request["ip"] = sentIp.toString();
  String response = send(String(CLOUD_BASE_URL) + "devices/register", request);
  if (response.length() == 0) return;

  JsonDocument reply;
  if (deserializeJson(reply, response)) {
    requestErrors++;
    return;
  }
  // The same serial always gets the same rootId back, so a controller whose
  // NVS was wiped reattaches to its existing cloud record. Inny rootId niż
  // zapisany (np. stary z secrets.h) jest podmieniany, a WebSocket otwierany
  // ponownie z nowym (tick()).
  String rootId = reply["rootId"] | "";
  if (rootId.length() == 0) {
    requestErrors++;
    return;
  }
  if (rootId != deviceConfig().rootId) {
    if (!saveRootId(rootId)) {
      requestErrors++;
      return;
    }
    stopWebSocket();
  }
  registeredIp = sentIp;
}

bool CloudClient::takeOperationRequest()
{
  bool requested = operationRequested;
  operationRequested = false;
  return requested;
}

bool CloudClient::takeQnapRequest(QnapRequest &out)
{
  if (!qnapPending) return false;
  qnapPending = false;
  out = qnapRequest;
  qnapRequest = QnapRequest();
  return true;
}

void CloudClient::sendQnapResult(const std::string &json)
{
  if (!webSocketStarted) return;
  String text(json.c_str());
  webSocket.sendTXT(text);
}

String CloudClient::post(const String &path, const JsonDocument &data)
{
  // Without a rootId the serial alone identifies the controller, so only a
  // controller that cannot read its own MAC has nothing to send with.
  if (!deviceRegistered() && deviceSerial().length() == 0) return "";

  String normalizedPath = path;
  while (normalizedPath.startsWith("/")) normalizedPath.remove(0, 1);
  String response = send(cloudUrl(normalizedPath), data);

  if (httpStatus == HTTP_CONFLICT && deviceRegistered()) {
    // The stored rootId belongs to another device. Forgetting it lets the
    // registration fetch the right one; the WebSocket reopens with it.
    clearRootId();
    registrationAttempted = false;
    registeredIp = IPAddress();
    stopWebSocket();
  }
  return response;
}

String CloudClient::send(const String &url, const JsonDocument &data)
{
  if (WiFi.status() != WL_CONNECTED) {
    httpStatus = 0;
    answered = false;
    requestErrors++;
    return "";
  }

  if (!http.begin(url)) {
    httpStatus = 0;
    answered = false;
    requestErrors++;
    return "";
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Cache-Control", "no-cache");
  http.setConnectTimeout(CONNECT_TIMEOUT_MS);
  http.setTimeout(RESPONSE_TIMEOUT_MS);

  String payload;
  serializeJson(data, payload);
  httpStatus = http.POST(payload);
  // HTTPClient reports connection and timeout failures as negative codes.
  answered = httpStatus > 0;
  if (answered) answeredAt = millis();

  String response;
  if (httpStatus >= 200 && httpStatus < 300) {
    response = http.getString();
  } else {
    requestErrors++;
  }
  http.end();
  return response;
}

// Pobiera obraz z oferty do nieaktywnej partycji OTA, licząc SHA-256 w locie; obraz jest aktywowany
// (Update.end) dopiero po zgodnej sumie. Blokuje pętlę na czas pobierania (ok. 1 MB, kilkanaście
// sekund), dlatego main.cpp woła je tylko przy wolnej magistrali i postoju sprężarki.
bool CloudClient::downloadFirmware(const OtaOffer &offer, String &status)
{
  if (WiFi.status() != WL_CONNECTED) {
    status = "brak Wi-Fi";
    return false;
  }
  stopWebSocket();
  WiFiClientSecure client;
  client.setInsecure();  // integralność daje SHA-256 z odpowiedzi chmury
  HTTPClient download;
  download.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
  download.setConnectTimeout(OTA_TIMEOUT_MS);
  download.setTimeout(OTA_TIMEOUT_MS);
  if (!download.begin(client, offer.url.c_str())) {
    status = "zły adres pliku";
    return false;
  }
  const int code = download.GET();
  const int total = download.getSize();
  if (code != 200 || total <= 0 || !Update.begin(total)) {
    status = "pobieranie nie powiodło się (HTTP " + String(code) + ")";
    download.end();
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  WiFiClient *stream = download.getStreamPtr();
  uint8_t buffer[1024];
  int remaining = total;
  unsigned long lastDataAt = millis();
  bool ok = true;
  while (remaining > 0) {
    const size_t available = stream->available();
    if (available == 0) {
      if (!download.connected() || millis() - lastDataAt > OTA_TIMEOUT_MS) { ok = false; break; }
      delay(1);
      continue;
    }
    const size_t count = stream->readBytes(buffer,
      min(min(available, sizeof(buffer)), static_cast<size_t>(remaining)));
    mbedtls_sha256_update(&sha, buffer, count);
    if (Update.write(buffer, count) != count) { ok = false; break; }
    remaining -= count;
    lastDataAt = millis();
  }
  download.end();

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  char hex[65];
  for (int index = 0; index < 32; index++) snprintf(hex + index * 2, 3, "%02x", digest[index]);

  if (!ok || remaining != 0) {
    Update.abort();
    status = "przerwane pobieranie";
    return false;
  }
  if (offer.sha256 != hex) {
    Update.abort();
    status = "suma SHA-256 niezgodna";
    return false;
  }
  if (!Update.end(true)) {
    status = "obraz odrzucony";
    return false;
  }
  status = "pobrano wersję " + String(offer.version.c_str()) + ", restart";
  return true;
}

int CloudClient::lastHttpStatus() const
{
  return httpStatus;
}

bool CloudClient::lastRequestAnswered() const
{
  return answered;
}

unsigned long CloudClient::lastAnswerAt() const
{
  return answeredAt;
}

uint32_t CloudClient::requestErrorCount() const
{
  return requestErrors;
}

uint32_t CloudClient::webSocketDisconnectCount() const
{
  return webSocketDisconnects;
}

void CloudClient::handleWebSocketEvent(
  WStype_t type, uint8_t *payload, size_t length)
{
  if (instance == nullptr) return;

  switch (type) {
    case WStype_CONNECTED:
      // Powitanie; serwer rozpoznaje urządzenie po rootId w ścieżce.
      instance->webSocket.sendTXT("ESP32");
      break;
    case WStype_TEXT:
    {
      JsonDocument message;
      DeserializationError error = deserializeJson(message, payload, length);
      if (!error && message["rootId"] == deviceConfig().rootId.c_str()) {
        if (message["type"] == "operation") instance->operationRequested = true;
      }
      // polecenie dla QNAP-a (od 1.4.0): złe pole albo drugie polecenie w trakcie pierwszego = odpowiedź od razu
      // ze statusem 0; poprawne czeka w RAM na wolną magistralę (main.cpp, relayQnapRequest)
      if (!error) {
        QnapRequest request;
        std::string problem;
        const QnapParse parsed = parseQnapRequest(message.as<JsonVariantConst>(), request, problem);
        if (parsed == QnapParse::Invalid) {
          instance->sendQnapResult(buildQnapResult(request.id, 0, problem));
        } else if (parsed == QnapParse::Ok && instance->qnapPending) {
          instance->sendQnapResult(buildQnapResult(request.id, 0, "sterownik wykonuje poprzednie polecenie"));
        } else if (parsed == QnapParse::Ok) {
          instance->qnapRequest = request;
          instance->qnapPending = true;
        }
      }
      break;
    }
    case WStype_DISCONNECTED:
      instance->webSocketDisconnects++;
      break;
    default:
      break;
  }
}
