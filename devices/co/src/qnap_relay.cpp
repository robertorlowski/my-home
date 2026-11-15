// Polecenia dla QNAP-a (opis w qnap_relay.hpp). Bez Arduino: testowane w pio test -e native.
#include <qnap_relay.hpp>

#include <cstdio>

namespace {
bool lowerHex(const std::string &text)
{
  for (const char character : text) {
    const bool digit = character >= '0' && character <= '9';
    const bool letter = character >= 'a' && character <= 'f';
    if (!digit && !letter) return false;
  }
  return true;
}

// długość nie dłuższa niż max, bez rozcinania sekwencji UTF-8 (bajty 10xxxxxx to kontynuacja znaku)
size_t utf8Prefix(const std::string &text, size_t max)
{
  if (text.size() <= max) return text.size();
  size_t length = max;
  while (length > 0 && (static_cast<unsigned char>(text[length]) & 0xC0) == 0x80) length--;
  return length;
}
}

bool parseQnapAddress(const std::string &text, std::string &host, uint16_t &port)
{
  unsigned a = 0, b = 0, c = 0, d = 0, p = 0;
  char tail = 0;
  if (std::sscanf(text.c_str(), "%3u.%3u.%3u.%3u:%5u%c", &a, &b, &c, &d, &p, &tail) != 5) return false;
  if (a > 255 || b > 255 || c > 255 || d > 255 || p == 0 || p > 65535) return false;
  const bool privateNetwork = a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
  if (!privateNetwork) return false;
  host = std::to_string(a) + "." + std::to_string(b) + "." + std::to_string(c) + "." + std::to_string(d);
  port = static_cast<uint16_t>(p);
  return true;
}

bool parseMacAddress(const std::string &text, MacAddress &mac)
{
  if (text.size() != 17) return false;
  bool allOnes = true;
  bool allZeros = true;
  for (size_t index = 0; index < 6; index++) {
    unsigned value = 0;
    for (size_t digit = 0; digit < 2; digit++) {
      const char character = text[index * 3 + digit];
      unsigned nibble = 0;
      if (character >= '0' && character <= '9') nibble = character - '0';
      else if (character >= 'a' && character <= 'f') nibble = character - 'a' + 10;
      else if (character >= 'A' && character <= 'F') nibble = character - 'A' + 10;
      else return false;
      value = value * 16 + nibble;
    }
    if (index < 5 && text[index * 3 + 2] != ':' && text[index * 3 + 2] != '-') return false;
    mac[index] = static_cast<uint8_t>(value);
    allOnes = allOnes && value == 0xFF;
    allZeros = allZeros && value == 0;
  }
  return !allOnes && !allZeros;
}

void buildMagicPacket(const MacAddress &mac, uint8_t packet[QNAP_MAGIC_PACKET_SIZE])
{
  for (size_t index = 0; index < 6; index++) packet[index] = 0xFF;
  for (size_t repeat = 0; repeat < 16; repeat++) {
    for (size_t index = 0; index < 6; index++) packet[6 + repeat * 6 + index] = mac[index];
  }
}

namespace {
// {"typ":"qnap_wybudz","id":…,"mac":[…]}: od 1 do QNAP_WAKE_MAX_MACS poprawnych adresów MAC
QnapParse parseWakeRequest(JsonVariantConst message, QnapRequest &out, std::string &error)
{
  out.wake = true;
  JsonArrayConst addresses = message["mac"].as<JsonArrayConst>();
  if (addresses.isNull() || addresses.size() == 0 || addresses.size() > QNAP_WAKE_MAX_MACS) {
    error = "oczekiwane od 1 do 4 adresow MAC";
    return QnapParse::Invalid;
  }
  for (JsonVariantConst address : addresses) {
    MacAddress mac{};
    if (!parseMacAddress(address | "", mac)) {
      error = "zly adres MAC";
      out.macs.clear();
      return QnapParse::Invalid;
    }
    out.macs.push_back(mac);
  }
  return QnapParse::Ok;
}
}

QnapParse parseQnapRequest(JsonVariantConst message, QnapRequest &out, std::string &error)
{
  out = QnapRequest();
  error.clear();
  const bool wake = message["typ"] == "qnap_wybudz";
  if (!wake && !(message["typ"] == "qnap")) return QnapParse::NotQnap;
  out.id = message["id"] | "";
  if (out.id.empty() || out.id.size() > 64) return QnapParse::NotQnap;
  if (wake) return parseWakeRequest(message, out, error);
  const std::string address = message["adres"] | "";
  out.body = message["cialo"] | "";
  out.signature = message["podpis"] | "";
  if (!parseQnapAddress(address, out.host, out.port)) error = "adres spoza sieci prywatnej albo bez portu";
  else if (out.body.empty() || out.body.size() > QNAP_BODY_MAX) error = "puste albo za duze cialo";
  else if (out.signature.size() != 64 || !lowerHex(out.signature)) error = "zly podpis (oczekiwane 64 znaki hex)";
  return error.empty() ? QnapParse::Ok : QnapParse::Invalid;
}

std::string buildQnapResult(const std::string &id, int status, const std::string &body)
{
  JsonDocument document;
  document["typ"] = "qnap_wynik";
  document["id"] = id;
  document["status"] = status;
  document["cialo"] = body.substr(0, utf8Prefix(body, QNAP_BODY_MAX));
  std::string text;
  serializeJson(document, text);
  return text;
}
