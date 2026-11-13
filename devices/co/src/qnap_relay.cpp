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

QnapParse parseQnapRequest(JsonVariantConst message, QnapRequest &out, std::string &error)
{
  out = QnapRequest();
  error.clear();
  if (!(message["typ"] == "qnap")) return QnapParse::NotQnap;
  out.id = message["id"] | "";
  if (out.id.empty() || out.id.size() > 64) return QnapParse::NotQnap;
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
