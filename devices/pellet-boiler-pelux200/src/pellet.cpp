// Sterownik pieca Pellux 200 (typ pellet-boiler-pelux200) na osobnej płytce ESP32-C3
// SuperMini z modułem RS-485 HW-519 (CLAUDE.md, punkt 5c; do 2026-10-02 rola firmware co):
// nasłuch magistrali ecoMAX kotła, dekodowanie SensorData (ecomax_frame.*), wysyłka ostatniego
// odczytu co poll_interval_seconds. Polaryzacja magistrali wybierana sama (bus_polarity.hpp).
// Od 1.1.0 (etap 2) sterownik udaje moduł ecoNET (0x56): odpowiada na CheckDevice i
// ProgramVersion, żeby regulator wysyłał mu SensorData (econet.hpp). Nie odpowiada, gdy
// odzywa się fabryczny ecoNET kotła (EconetGuard). Magistralę obsługuje osobne zadanie
// FreeRTOS (busTask), bo odpowiedź musi wyjść od razu, a HTTP blokuje loop() do 8 s.
// Etap 3: po starcie (i na polecenie „p” z konsoli USB) sterownik czyta wszystkie ustawienia
// kotła (boiler_settings.hpp) — linie „SETTINGS …” na konsoli i /boiler-settings.json; to
// kopia na wypadek awarii regulatora. Ustawień nie zapisuje.
// Kontrakt z chmurą: POST devices/register (rootId, settings.poll_interval_seconds),
// POST pellet-boiler-pelux200/add (odpowiedź {poll_interval_seconds}). NVS: przestrzeń „pel”.
// Od 1.5.0 aktualizacja z chmury (OTA) na zlecenie z aplikacji: oferta w odpowiedzi na
// GET commands/next (ota.hpp), pobieranie z kontrolą SHA-256, gdy nie trwa zapis parametru.
// Od 1.6.0 WebSocket /ws?rootId= (jak we włączniku): „operation” = nowe zlecenie, płytka od razu pyta
// o zlecenia; odczyt idzie od razu po zmianie stanu kotła i po wykonanym zleceniu (nie tylko co poll_s).
// Od 1.6.1 także od razu po włączeniu i wyłączeniu pompy CWU (ładowanie CWU przestawia pompę ciepła).
// Od 1.6.2: odczyt od razu po każdej zmianie stanu, wyjść (pompy, wentylator, podajnik, zapalarka, alarm)
// i zadanych (kocioł, CWU, mieszacze) — także zmienionych na panelu; zmiana zadanej i co 10 min pełny
// odczyt ustawień (zmiany z panelu w chmurze); zapis parametru zawsze (bez pomijania według kopii
// ustawień płytki) i na ustawieniach nie starszych niż SETTINGS_FRESH_MS (2026-10-04: kopia sprzed zmiany
// na panelu kazała pominąć zapis CWU 42 przy 45 na kotle).
// Od 1.7.2 zmiany ustawień z panelu wykrywa tabela wersji z SensorData (FrameVersionWatch, jak PyPlumIO): pełny
// odczyt ustawień zaraz po zmianie wersji 0x31/0x32/0x36/0x38/0x5C, dziennik alarmów po zmianie 0x3D; odczyt
// okresowy rzadziej, co 60 min, tylko jako zabezpieczenie.
// Od 1.11.0 (settings_refresh.hpp): odczyt ustawień co 15 min, także zaraz po przerwie w SensorData (2 min i dłużej)
// i bez Wi-Fi (powody sprawdza busTask, nie tick()); niewysłane ustawienia idą od razu po udanej wysyłce odczytu.
// Przy kotle nikt nie naciśnie resetu, więc sterownik restartuje się sam: watchdog pętli
// (WATCHDOG_S) i po WIFI_RESTART_AFTER_MS bez Wi-Fi (2026-10-03 płytka raz zawisła bez restartu);
// wcześniej co 2 min ponowne łączenie bez restartu. Przyczyna restartu programowego w NVS.
#include <Arduino.h>
#include <esp_task_wdt.h>
#include <cstdarg>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <Update.h>
#include <esp_mac.h>
#include <mbedtls/sha256.h>

#include <boiler_settings.hpp>
#include <bus_polarity.hpp>
#include <bus_watch.hpp>
#include <alerts_log.hpp>
#include <fuel_meter.hpp>
#include <ecomax_frame.hpp>
#include <econet.hpp>
#include <firmware.hpp>
#include <ota.hpp>
#include <pellet_telemetry.hpp>
#include <secrets.h>
#include <service_password.hpp>
#include <settings_refresh.hpp>

namespace {

constexpr const char *PREFERENCES_NAMESPACE = "pel";
constexpr const char *KEY_WIFI_SSID = "wifi_ssid";
constexpr const char *KEY_WIFI_PASSWORD = "wifi_pass";
constexpr const char *KEY_ROOT_ID = "root_id";
constexpr const char *KEY_POLL_SECONDS = "poll_s";
constexpr const char *KEY_INVERTED = "bus_inv";
// licznik spalonego pelletu [g] (fuel_meter.hpp, od 1.7.1)
constexpr const char *KEY_FUEL_GRAMS = "fuel_g";
// hasło serwisowe regulatora (od 1.8.0, service_password.hpp): tylko NVS i /install
constexpr const char *KEY_SERVICE_PASSWORD = "svc_pw";
// klucz oferty OTA (wersja#zlecenie, ota.hpp), po której pobraniu sterownik się zrestartował
constexpr const char *KEY_OTA_TRIED = "ota_tried";

constexpr uint32_t TICK_MS = 1000;
constexpr uint32_t REGISTER_RETRY_MS = 30000;
// po nieudanej wysyłce ponowienie po 60 s, nie po pełnym interwale
constexpr uint32_t POST_RETRY_MS = 60000;
constexpr uint32_t AP_OFF_AFTER_MS = 60000;
constexpr uint32_t AP_ON_AFTER_MS = 60000;
constexpr uint16_t HTTP_TIMEOUT_MS = 5000;
constexpr uint16_t REGISTER_TIMEOUT_MS = 8000;
constexpr uint16_t OTA_TIMEOUT_MS = 15000;
constexpr uint32_t STATUS_LOG_MS = 30000;
// pętla stoi dłużej (najdłuższe zapytanie HTTP to 8 s) = zawieszenie, restart układu
constexpr uint32_t WATCHDOG_S = 30;
// Brak Wi-Fi: co WIFI_RECONNECT_EVERY_MS ponowne łączenie bez restartu, restart układu dopiero po
// WIFI_RESTART_AFTER_MS (stos Wi-Fi bywa, że nie wraca sam). Do 2026-10-03 restart był już po 10 min
// i przerywał pracę na magistrali kotła (11:08:51, w trakcie sterowania ręcznego z panelu).
constexpr uint32_t WIFI_RECONNECT_EVERY_MS = 2UL * 60 * 1000;
constexpr uint32_t WIFI_RESTART_AFTER_MS = 30UL * 60 * 1000;
// przyczyna ostatniego restartu programowego (NVS), pokazywana po starcie
constexpr const char *KEY_RESTART_REASON = "restart";
// bufor UART (zapas, gdy zadanie magistrali chwilę nie dostanie procesora)
constexpr size_t RX_BUFFER_BYTES = 4096;
constexpr size_t MAX_BYTES_PER_LOOP = 512;
// Odstęp przed odpowiedzią: regulator po ostatnim bajcie zapytania musi przełączyć swój
// nadajnik na odbiór (bajt przy 115200 bodów to ok. 0,1 ms).
constexpr uint32_t ECONET_REPLY_DELAY_MS = 2;
// Odstęp zapytania o ustawienia od naszej odpowiedzi na CheckDevice (handleEconet).
constexpr uint32_t SETTINGS_QUERY_GAP_MS = 50;
constexpr uint32_t BUS_TASK_STACK = 6144;
constexpr UBaseType_t BUS_TASK_PRIORITY = 2;  // wyżej niż loop() (1)

// sieć sterownika (AP): ten sam adres we wszystkich sterownikach (od 2026-10-10)
const IPAddress AP_ADDRESS(10, 10, 10, 1);

const char *const STATE_NAMES[] = {
  "off", "stabilization", "kindling", "working", "supervision", "paused", "standby",
  "burning off", "alert", "manual", "unsealing", "other"};

Preferences preferences;
WebServer server(80);
WiFiClientSecure secureClient;
WiFiClient plainClient;
HTTPClient http;

// Stan wspólny zadania magistrali i loop(): odczyt, ramki, stan sieci dla ecoNET — zmiany
// i kopie pod stateLock (sekcja krytyczna, bez wypisywania na konsolę w środku).
portMUX_TYPE stateLock = portMUX_INITIALIZER_UNLOCKED;
EcomaxFrameParser parser;
BusPolarity polarity;
EcomaxSensorData latest;
bool hasReading = false;
uint32_t readingAtMs = 0;
uint32_t busBytes = 0;
uint32_t validFrames = 0;
uint32_t sensorFrames = 0;

// ecoNET (etap 2): osłona adresu 0x56, stan sieci zgłaszany regulatorowi (aktualizowany
// w tick()), zapytania pominięte w czasie nasłuchu albo blokady.
EconetGuard guard;
// spalony pellet (fuel_meter.hpp, od 1.7.1): zmieniany w busTask przy SensorData, czytany pod stateLock
FuelMeter fuelMeter;
uint32_t lastFuelSaveMs = 0;
double lastSavedFuelGrams = 0;
// cisza regulatora i StartMaster (bus_watch.hpp, od 1.7.0); zmieniane w busTask, czytane przez strony pod stateLock
BusSilenceWatch silenceWatch;
// zmiany z panelu po tabeli wersji SensorData (od 1.7.2, bus_watch.hpp); tylko busTask
FrameVersionWatch versionWatch;
// Nasz zapis też podbija wersję 0x38; ponowny odczyt po nim i tak jest zlecony, więc zmiana wersji w OWN_WRITE_MS
// po potwierdzeniu zapisu nie zleca drugiego.
constexpr uint32_t OWN_WRITE_MS = 15000;
uint32_t ownWriteConfirmedMs = 0;
bool ownWriteConfirmed = false;
// polaryzacja zapisana w NVS po pierwszej poprawnej ramce: przy ciszy zaraz po starcie (brak ramek, więc
// polarity.confirmed() = false) wiadomo, jak nadawać StartMaster
bool polarityKnown = false;
EconetNetworkInfo networkInfo;
uint32_t econetSkipped = 0;
bool econetAllowed = false;

// Odczyt ustawień kotła (etap 3): zlecany flagą (start, konsola, settingsRefresh), wykonywany w busTask.
BoilerSettingsReader boilerSettings;
volatile bool boilerSettingsRequested = true;
// powody odczytu „po przerwie w SensorData”, „zmiana zadanej” i „co 15 min” (settings_refresh.hpp; busTask)
SettingsRefresh settingsRefresh;
// Dziennik alarmów z panelu (alerts_log.hpp, od 1.7.0): odczyt po starcie (po ustawieniach), co ALERTS_EVERY_MS
// i przy zmianie liczby aktywnych alarmów w SensorData; kompletny dziennik po każdej zmianie idzie do chmury.
AlertsLogReader alertsLog;
volatile bool alertsRequested = true;
constexpr uint32_t ALERTS_EVERY_MS = 60UL * 60 * 1000;
uint32_t alertsStartedMs = 0;
int16_t lastPendingAlerts = -1;
uint32_t alertsUploadedRevision = 0;
uint32_t nextAlertsUploadMs = 0;
// Hasło serwisowe (od 1.8.0): odczyt na żądanie z /install (servicePasswordRequested), odpowiedź w busTask,
// zapis w NVS w tick() (servicePasswordSavePending). Hasło nie trafia na konsolę ani do chmury.
ServicePasswordReader servicePasswordReader;
volatile bool servicePasswordRequested = false;
volatile bool servicePasswordSavePending = false;
String servicePassword;
uint32_t servicePasswordAtMs = 0;
// które zapytanie poszło w bieżącym oknie (do cofnięcia, gdy magistrala zajęta)
enum class QuerySource : uint8_t { NONE, WRITER, SETTINGS, PASSWORD, ALERTS };
// koniec odczytu z parametrami kotła → wysyłka do chmury w tick() (sendSettings)
volatile bool settingsUploadPending = false;

// Zmiana parametru kotła albo mieszacza: z konsoli („set <nr> <wartość>”, „setm <mieszacz>
// <nr> <wartość>”) albo ze zlecenia z aplikacji (GET commands/next co CLOUD_COMMAND_POLL_MS).
// busTask sprawdza zakres z ostatniego odczytu ustawień — w każdym stanie kotła (decyzja
// użytkownika 2026-10-04, jak fabryczny ecoNET300; do 1.2.0 tylko przy stanie 0) — wysyła
// 0x33/0x34, po potwierdzeniu czyta ustawienia od nowa (nowa wartość idzie do chmury).
// Wynik zlecenia z aplikacji odsyła loop() (POST commands/result).
BoilerParameterWriter parameterWriter;
volatile bool parameterSetRequested = false;
volatile uint8_t parameterSetIndex = 0;
volatile uint8_t parameterSetValue = 0;
volatile uint8_t parameterSetMixer = BoilerParameterWriter::NO_MIXER;
// zlecenie z aplikacji: od odebrania do odesłania wyniku; wynik ustawia busTask
// Harmonogram (od 1.8.0): po wysłaniu 0x37 wynik pokazuje ponowny odczyt harmonogramów (finishSettingsRead);
// przy niezgodności jeszcze jeden odczyt, potem błąd.
bool scheduleVerifyPending = false;
uint8_t scheduleVerifyIndex = 0;
uint8_t scheduleVerifyValue = 0;
uint8_t scheduleVerifyReads = 0;
volatile bool cloudCommandActive = false;
volatile bool cloudResultReady = false;
bool cloudResultOk = false;
char cloudResultError[96] = {};

// Podgląd czasów na magistrali („t” z konsoli): przez TRACE_MS każda ramka i każde nasze
// nadanie jako „TRACE <µs> …” — do ustalenia, kiedy regulator słucha.
constexpr uint32_t TRACE_MS = 3000;
volatile uint32_t traceUntilMs = 0;

bool tracing()
{
  return traceUntilMs != 0 && static_cast<int32_t>(traceUntilMs - millis()) > 0;
}

// Nagranie rozmowy z kotłem („r” z konsoli): przez CAPTURE_MS każda poprawna ramka z magistrali
// i każde nasze nadanie w całości, „RAW <ms> RX|TX <hex>”. Z nagrań powstają dane testowe
// (test/fixtures) i symulator kotła (tools/), bo kocioł nie zawsze jest pod ręką.
constexpr uint32_t CAPTURE_MS = 5UL * 60 * 1000;
volatile uint32_t captureUntilMs = 0;

bool capturing()
{
  return captureUntilMs != 0 && static_cast<int32_t>(captureUntilMs - millis()) > 0;
}

void captureFrame(const char *direction, const uint8_t *bytes, size_t length)
{
  if (!capturing()) return;
  // hasło serwisowe (0xBA) nigdy na konsolę: sam nagłówek, dane ukryte
  if (length > 7 && isServicePasswordFrame(bytes[7])) {
    Serial.printf("# RAW %lu %s ramka 0xBA (hasło serwisowe) pominięta\n", static_cast<unsigned long>(millis()), direction);
    return;
  }
  Serial.printf("RAW %lu %s ", static_cast<unsigned long>(millis()), direction);
  for (size_t index = 0; index < length; index++) Serial.printf("%02x", bytes[index]);
  Serial.println();
}

// Diagnostyka magistrali (od 1.0.2): jakie ramki naprawdę lecą na magistrali kotła —
// para (typ, nadawca, odbiorca) z licznikiem; pierwsza ramka każdej pary trafia na konsolę
// w hex. Na kotle 2026-10-03 przychodziły poprawne ramki, ale żadna SensorData (0x35).
struct FrameKind {
  uint8_t type;
  uint8_t sender;
  uint8_t recipient;
  uint32_t count;
  uint16_t lastLength;
};
constexpr uint8_t MAX_FRAME_KINDS = 24;
FrameKind frameKinds[MAX_FRAME_KINDS];
uint8_t frameKindCount = 0;

// Pełne dane ramek do rozszyfrowania (od 1.0.3): RegulatorData 0x08 (regulator → wszyscy,
// co 2 s), 0x89 (panele → wszyscy) i od 1.1.0 SensorData 0x35, najwyżej raz na
// DUMP_INTERVAL_MS dla każdego typu.
// Linia: "DUMP <typ> <nadawca> <ms> <hex>" — do porównania z wartościami na panelu kotła.
constexpr uint32_t DUMP_INTERVAL_MS = 10000;
uint32_t lastDump08Ms = 0;
uint32_t lastDump89Ms = 0;
uint32_t lastDump35Ms = 0;

void dumpFrame(const EcomaxFrame &frame)
{
  uint32_t *last = frame.type == 0x08 ? &lastDump08Ms
    : frame.type == 0x89            ? &lastDump89Ms
    : frame.type == 0x35            ? &lastDump35Ms
                                    : nullptr;
  if (!last) return;
  const uint32_t now = millis();
  if (*last != 0 && now - *last < DUMP_INTERVAL_MS) return;
  *last = now;
  Serial.printf("DUMP %02x %02x %lu ", frame.type, frame.sender, static_cast<unsigned long>(now));
  for (size_t index = 0; index < frame.dataLength; index++) Serial.printf("%02x", frame.data[index]);
  Serial.println();
}

// Zlicza ramkę; przy nowej parze wypisuje nagłówek i do 48 bajtów danych.
void recordFrameKind(const EcomaxFrame &frame)
{
  dumpFrame(frame);
  bool added = false;
  portENTER_CRITICAL(&stateLock);
  uint8_t index = 0;
  for (; index < frameKindCount; index++) {
    FrameKind &kind = frameKinds[index];
    if (kind.type == frame.type && kind.sender == frame.sender && kind.recipient == frame.recipient) {
      kind.count++;
      kind.lastLength = static_cast<uint16_t>(frame.dataLength);
      break;
    }
  }
  if (index == frameKindCount && frameKindCount < MAX_FRAME_KINDS) {
    frameKinds[frameKindCount++] = {frame.type, frame.sender, frame.recipient, 1, static_cast<uint16_t>(frame.dataLength)};
    added = true;
  }
  portEXIT_CRITICAL(&stateLock);
  if (!added) return;
  char hex[3 * 48 + 1] = {};
  // hasło serwisowe (0xBA): bez danych
  const size_t shown = isServicePasswordFrame(frame.type) ? 0 : frame.dataLength < 48 ? frame.dataLength : 48;
  for (size_t index = 0; index < shown; index++) snprintf(hex + index * 3, 4, "%02x ", frame.data[index]);
  Serial.printf("[%7lu] ramka nowa: typ 0x%02x od 0x%02x (typ nadawcy 0x%02x, wersja %u) do 0x%02x, dane %u B: %s\n",
    static_cast<unsigned long>(millis()), frame.type, frame.sender, frame.senderType, frame.version, frame.recipient,
    static_cast<unsigned>(frame.dataLength), hex);
}

String wifiSsid;
String wifiPassword;
const String cloudUrl = CLOUD_URL;
String rootId;
String serial;
uint16_t pollSeconds = DEFAULT_POLL_SECONDS;

bool registeredThisBoot = false;
uint32_t lastRegisterAttemptMs = 0;
uint32_t nextPostMs = 0;
uint32_t lastPostOkMs = 0;
int lastHttpStatus = 0;
int lastPostStatus = 0;
uint32_t lastTickMs = 0;
uint32_t lastStatusLogMs = 0;

// WebSocket /ws?rootId= do tego samego serwera co HTTP (od 1.6.0): komunikat „operation” (nowe zlecenie
// z aplikacji, „Aktualizuj”) ustawia commandPollDue i płytka od razu pyta o zlecenia; bez WebSocketu
// zostaje pytanie co CLOUD_COMMAND_POLL_MS.
WebSocketsClient webSocket;
bool webSocketStarted = false;
bool cloudTls = true;
String cloudHost;
uint16_t cloudPort = 443;
volatile bool commandPollDue = true;
// Odczyt od razu, poza poll_s: po zmianie stanu kotła (np. praca → wygaszanie → wyłączony) i po
// wykonanym zleceniu; najwyżej co IMMEDIATE_POST_MIN_MS, żeby zmieniający się stan nie zasypał chmury.
constexpr uint32_t IMMEDIATE_POST_MIN_MS = 10000;
bool readingDue = false;
// podpis ostatnio wysłanego odczytu (readingSignature; 0 = jeszcze nic): stan, wyjścia i zadane
uint32_t lastSentSignature = 0;
uint32_t lastImmediatePostMs = 0;
// Ustawienia kotła: koniec ostatniego pełnego odczytu (busTask); zapis parametru tylko na odczycie nie starszym
// niż SETTINGS_FRESH_MS. Kiedy czytać od nowa: settingsRefresh (settings_refresh.hpp).
constexpr uint32_t SETTINGS_FRESH_MS = 60000;
volatile uint32_t settingsReadDoneMs = 0;

bool accessPointOn = false;
uint32_t wifiLostSinceMs = 0;
uint32_t wifiConnectedSinceMs = 0;
bool uploadAccepted = false;
bool uploadFinished = false;

// Dziennik na konsoli USB (115200): czas w ms od startu i linia tekstu.
void logf(const char *format, ...)
{
  char line[200];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  Serial.printf("[%7lu] %s\n", static_cast<unsigned long>(millis()), line);
}

// SN = fabryczny MAC z eFuse (12 znaków hex), deviceId w chmurze.
String readSerial()
{
  uint8_t mac[6] = {};
  if (esp_efuse_mac_get_default(mac) != ESP_OK) return "";
  char text[13];
  snprintf(text, sizeof(text), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return text;
}

// Nazwa sieci sterownika (AP, otwarta): MyHome-PelletBoiler-<4 ostatnie znaki SN> (od 2026-10-10, wcześniej AP_SSID z secrets.h).
const char *accessPointSsid()
{
  static String ssid;
  if (ssid.isEmpty()) {
    const String sn = readSerial();
    ssid = "MyHome-PelletBoiler-" + sn.substring(sn.length() > 4 ? sn.length() - 4 : 0);
  }
  return ssid.c_str();
}

// Wartość z NVS, a gdy jej nie ma (pierwszy start) — wkompilowana z secrets.h.
String storedOrDefault(const char *key, const char *fallback)
{
  String value = preferences.getString(key, "");
  return value.length() > 0 ? value : String(fallback);
}

// Wi-Fi, Root ID, interwał wysyłki i zatwierdzona polaryzacja magistrali z NVS.
void loadConfig()
{
  wifiSsid = storedOrDefault(KEY_WIFI_SSID, WIFI_SSID);
  wifiPassword = storedOrDefault(KEY_WIFI_PASSWORD, WIFI_PASSWORD);
  rootId = preferences.getString(KEY_ROOT_ID, "");
  pollSeconds = preferences.getUShort(KEY_POLL_SECONDS, DEFAULT_POLL_SECONDS);
  polarity = BusPolarity(preferences.getBool(KEY_INVERTED, false));
  polarityKnown = preferences.isKey(KEY_INVERTED);
  lastSavedFuelGrams = preferences.getDouble(KEY_FUEL_GRAMS, 0);
  servicePassword = preferences.getString(KEY_SERVICE_PASSWORD, "");
  fuelMeter.begin(lastSavedFuelGrams);
}

// --- magistrala ecoMAX ---

// UART1: odbiór GPIO21, nadawanie GPIO20; invert odwraca sygnał w obu kierunkach, gdy
// przewody A/B są zamienione.
void startBus()
{
  Serial1.end();
  Serial1.setRxBufferSize(RX_BUFFER_BYTES);
  Serial1.begin(ECOMAX_BAUD, SERIAL_8N1, ECOMAX_RX_PIN, ECOMAX_TX_PIN, polarity.inverted());
  logf("magistrala: odbiór GPIO%d, nadawanie GPIO%d, %lu bodów, sygnał %s", ECOMAX_RX_PIN, ECOMAX_TX_PIN,
    static_cast<unsigned long>(ECOMAX_BAUD), polarity.inverted() ? "odwrócony" : "normalny");
}

// Stan odpowiedzi ecoNET do strony i konsoli.
const char *econetStateText(uint32_t nowMs)
{
  if (guard.blocked(nowMs)) {
    return guard.blockReason() == EconetBlockReason::COLLISIONS ? "paused: bus collisions"
                                                                : "paused: another ecoNET module responds";
  }
  if (!polarity.confirmed()) return "waiting for valid frames";
  if (!guard.mayTransmit(nowMs)) return "listening before transmitting";
  return "responding";
}

void requestSettingsWhenChanged(uint32_t nowMs, const EcomaxSensorData &reading);

// Koniec odczytu ustawień (busTask): wpis na konsoli i zlecenie wysyłki do chmury.
void finishParameterSet(bool ok, const char *error);

void finishSettingsRead()
{
  settingsReadDoneMs = millis();
  logf("ustawienia kotła: koniec odczytu (bez odpowiedzi: %lu)", static_cast<unsigned long>(boilerSettings.failed()));
  if (boilerSettings.has(0)) settingsUploadPending = true;
  if (!scheduleVerifyPending) return;
  uint8_t enabled;
  if (scheduleSwitch(boilerSettings, scheduleVerifyIndex, enabled) && enabled == scheduleVerifyValue) {
    scheduleVerifyPending = false;
    logf("harmonogram nr %u: odczyt potwierdza %s", scheduleVerifyIndex, enabled ? "włączony" : "wyłączony");
    finishParameterSet(true, nullptr);
  } else if (scheduleVerifyReads++ < 1) {
    boilerSettingsRequested = true;
    logf("harmonogram nr %u: odczyt jeszcze bez zmiany, czytam ponownie", scheduleVerifyIndex);
  } else {
    scheduleVerifyPending = false;
    logf("harmonogram nr %u: regulator nie zmienił przełącznika", scheduleVerifyIndex);
    finishParameterSet(false, "regulator nie zmienił harmonogramu — sprawdź na panelu");
  }
}

// Harmonogram wysłany (potwierdzony 0xB7 albo bez odpowiedzi): odczyt ustawień rozstrzyga wynik.
void verifySchedule(uint8_t schedule, uint8_t value)
{
  scheduleVerifyPending = true;
  scheduleVerifyIndex = schedule;
  scheduleVerifyValue = value;
  scheduleVerifyReads = 0;
  boilerSettingsRequested = true;
}

// Odpowiedź z ustawieniami: jedna linia „SETTINGS <nazwa> <ms> <hex>” na konsoli.
void logSettingsResponse(uint8_t item)
{
  Serial.printf("SETTINGS %s %lu ", BOILER_SETTINGS_REQUESTS[item].name,
    static_cast<unsigned long>(boilerSettings.receivedAtMs(item)));
  const uint8_t *data = boilerSettings.data(item);
  for (size_t index = 0; index < boilerSettings.length(item); index++) Serial.printf("%02x", data[index]);
  Serial.println();
}

// Wynik zlecenia z aplikacji (busTask); bez zlecenia w toku (konsola) nic nie robi.
void finishParameterSet(bool ok, const char *error)
{
  if (!cloudCommandActive || cloudResultReady) return;
  portENTER_CRITICAL(&stateLock);
  cloudResultOk = ok;
  strncpy(cloudResultError, error ? error : "", sizeof(cloudResultError) - 1);
  cloudResultError[sizeof(cloudResultError) - 1] = '\0';
  cloudResultReady = true;
  portEXIT_CRITICAL(&stateLock);
}

// „kocioł nr 119” albo „mieszacz 1 nr 0” do komunikatów.
String parameterName(uint8_t mixer, uint8_t index)
{
  char text[32];
  if (mixer == BoilerParameterWriter::CONTROL) return String("włącz/wyłącz regulator");
  if (mixer == BoilerParameterWriter::SCHEDULE) {
    if (index == SCHEDULE_BOILER_CLEAN) return String("harmonogram czyszczenia");
    snprintf(text, sizeof(text), "harmonogram nr %u", index);
    return String(text);
  }
  if (mixer == BoilerParameterWriter::NO_MIXER) snprintf(text, sizeof(text), "kocioł nr %u", index);
  else snprintf(text, sizeof(text), "mieszacz %u nr %u", mixer + 1, index);
  return String(text);
}

// Zlecona zmiana parametru (konsola albo aplikacja): wartość w zakresie min–max z ostatniego
// odczytu ustawień, w każdym stanie kotła. Czeka, aż trwający odczyt ustawień się skończy.
void startParameterSet(uint32_t)
{
  // po poprzedniej zmianie najpierw ponowny odczyt: zakres zadanej zależy od zmienionego minimum
  if (!parameterSetRequested || parameterWriter.busy() || boilerSettings.busy() || boilerSettingsRequested) return;
  parameterSetRequested = false;
  const uint8_t index = parameterSetIndex;
  const uint8_t value = parameterSetValue;
  const uint8_t mixer = parameterSetMixer;
  const String name = parameterName(mixer, index);
  // włącz/wyłącz regulator (0x3B): bez zakresu z odczytu ustawień, tylko 0 albo 1
  if (mixer == BoilerParameterWriter::CONTROL) {
    if (value > 1) {
      finishParameterSet(false, "włącz/wyłącz: wartość 0 albo 1");
      return;
    }
    parameterWriter.start(0, value, mixer);
    logf("regulator: %s, wysyłam", value ? "włącz" : "wyłącz");
    return;
  }
  // zakres i wartość ze świeżego odczytu ustawień (kopia sprzed zmiany na panelu bywa nieaktualna)
  if (millis() - settingsReadDoneMs > SETTINGS_FRESH_MS) {
    parameterSetRequested = true;
    boilerSettingsRequested = true;
    logf("parametr %s: najpierw świeży odczyt ustawień", name.c_str());
    return;
  }
  // harmonogram: tydzień i parametr ze świeżego odczytu bez zmian, zmienia się tylko przełącznik
  if (mixer == BoilerParameterWriter::SCHEDULE) {
    uint8_t data[SET_SCHEDULE_DATA_SIZE];
    uint8_t current;
    if (value > 1 || !scheduleSwitch(boilerSettings, index, current)
      || buildSetScheduleData(boilerSettings, index, value, data, sizeof(data)) == 0) {
      logf("%s: brak w odczycie ustawień albo wartość inna niż 0/1, nie zmieniam", name.c_str());
      finishParameterSet(false, value > 1 ? "harmonogram: wartość 0 albo 1" : "brak harmonogramu w odczycie ustawień");
      return;
    }
    parameterWriter.startSchedule(index, value, data, sizeof(data));
    logf("%s: %s → %s, wysyłam", name.c_str(), current ? "włączony" : "wyłączony", value ? "włączony" : "wyłączony");
    return;
  }
  uint8_t current, min, max;
  const bool known = mixer == BoilerParameterWriter::NO_MIXER
    ? ecomaxParameterValues(boilerSettings, index, current, min, max)
    : mixerParameterValues(boilerSettings, mixer, index, current, min, max);
  // Mieszacz, którego nastaw regulator nie podaje (u nas mieszacz 2: same FF w 0xB2, choć pracuje): od 1.8.1 zapis
  // bez zakresu z odczytu — zakres sprawdza serwer (zadana 20–40 °C, reszta jak mieszacz 1), wyniku nie da się
  // odczytać (decyzja użytkownika 2026-10-08).
  if (!known && mixer != BoilerParameterWriter::NO_MIXER && boilerSettings.has(1) && !mixerReported(boilerSettings, mixer)) {
    parameterWriter.start(index, value, mixer);
    logf("parametr %s: → %u, regulator nie podaje nastaw tego mieszacza — wysyłam bez zakresu z odczytu", name.c_str(), value);
    return;
  }
  if (!known) {
    logf("parametr %s: brak w odczycie ustawień (najpierw „p”), nie zmieniam", name.c_str());
    finishParameterSet(false, "brak parametru w odczycie ustawień sterownika");
    return;
  }
  if (value < min || value > max) {
    logf("parametr %s: %u poza zakresem %u–%u, nie zmieniam", name.c_str(), value, min, max);
    finishParameterSet(false, "wartość poza zakresem regulatora");
    return;
  }
  // zapis zawsze, także gdy odczyt pokazuje tę samą wartość (serwer zleca tylko różnice)
  parameterWriter.start(index, value, mixer);
  logf("parametr %s: %u → %u (zakres %u–%u), wysyłam", name.c_str(), current, value, min, max);
}

// Ramka od 0x56 (echo albo fabryczny ecoNET), odpowiedź regulatora z ustawieniami
// i odpowiedź na zapytanie regulatora do 0x56 (z doklejonym zapytaniem o ustawienia).
void handleEconet(const EcomaxFrame &frame, uint32_t nowMs)
{
  if (frame.sender == ECONET_ADDRESS) {
    if (!guard.onEconetFrame(frame, millis())) {
      logf("ecoNET: ramka typu 0x%02x od 0x56, która nie jest naszą — inny moduł ecoNET, cisza na %lu min",
        frame.type, static_cast<unsigned long>(EconetGuard::BLOCK_MS / 60000));
    }
    return;
  }
  if (frame.recipient != ECONET_ADDRESS && frame.recipient != ECOMAX_ADDRESS_BROADCAST) return;
  if (parameterWriter.onResponse(frame)) {
    logf("parametr %s = %u: regulator potwierdził, czytam ustawienia od nowa",
      parameterName(parameterWriter.mixer(), parameterWriter.index()).c_str(), parameterWriter.value());
    if (parameterWriter.isSchedule()) verifySchedule(parameterWriter.index(), parameterWriter.value());
    else finishParameterSet(true, nullptr);
    boilerSettingsRequested = true;
    ownWriteConfirmed = true;
    ownWriteConfirmedMs = nowMs;
    return;
  }
  const int8_t item = boilerSettings.current();
  portENTER_CRITICAL(&stateLock);
  const bool stored = boilerSettings.onResponse(frame, nowMs);
  portEXIT_CRITICAL(&stateLock);
  if (stored) {
    logf("ustawienia kotła: %s, %u B", BOILER_SETTINGS_REQUESTS[item].name,
      static_cast<unsigned>(boilerSettings.length(item)));
    logSettingsResponse(item);
    if (!boilerSettings.busy()) finishSettingsRead();
    return;
  }
  if (frame.recipient != ECONET_ADDRESS) return;
  EconetNetworkInfo network;
  portENTER_CRITICAL(&stateLock);
  network = networkInfo;
  portEXIT_CRITICAL(&stateLock);
  uint8_t reply[ECONET_MAX_FRAME];
  const size_t length = buildEconetResponse(frame, network, reply, sizeof(reply));
  if (length == 0) return;
  if (!polarity.confirmed() || !guard.mayTransmit(nowMs)) {
    econetSkipped++;
    return;
  }
  // Zapytanie o ustawienia tylko za odpowiedzią na CheckDevice (regulator oddał nam magistralę).
  size_t queryLength = 0;
  uint8_t query[ECONET_MAX_FRAME];
  QuerySource source = QuerySource::NONE;
  if (frame.type == ECOMAX_FRAME_CHECK_DEVICE) {
    startParameterSet(nowMs);
    if (parameterWriter.busy()) {
      queryLength = parameterWriter.nextRequest(nowMs, query, sizeof(query));
      source = QuerySource::WRITER;
    } else {
      if (boilerSettingsRequested && !boilerSettings.busy()) {
        boilerSettingsRequested = false;
        boilerSettings.start();
        logf("ustawienia kotła: początek odczytu");
      }
      if (boilerSettings.busy()) {
        queryLength = boilerSettings.nextRequest(nowMs, query, sizeof(query));
        source = QuerySource::SETTINGS;
      } else if (servicePasswordRequested || servicePasswordReader.busy()) {
        // hasło serwisowe na żądanie z /install, przed dziennikiem alarmów
        if (servicePasswordRequested && !servicePasswordReader.busy()) {
          servicePasswordRequested = false;
          servicePasswordReader.start();
          logf("hasło serwisowe: odczyt");
        }
        queryLength = servicePasswordReader.nextRequest(nowMs, query, sizeof(query));
        source = QuerySource::PASSWORD;
      } else {
        // dziennik alarmów dopiero po ustawieniach (kolejność jak przy starcie panelu)
        if (alertsRequested && !alertsLog.busy()) {
          alertsRequested = false;
          alertsStartedMs = nowMs;
          alertsLog.start();
          logf("alarmy: początek odczytu dziennika");
        }
        queryLength = alertsLog.nextRequest(nowMs, query, sizeof(query));
        source = QuerySource::ALERTS;
      }
    }
  }
  vTaskDelay(pdMS_TO_TICKS(ECONET_REPLY_DELAY_MS));
  Serial1.write(reply, length);
  captureFrame("TX", reply, length);
  if (tracing()) {
    Serial.printf("TRACE %lu TX typ 0x%02x %u B\n", static_cast<unsigned long>(micros()), reply[7],
      static_cast<unsigned>(length));
  }
  guard.onTransmitted(reply, length, millis(), parser.rejectedCount());
  if (queryLength == 0) return;
  // Zapytanie osobno, SETTINGS_QUERY_GAP_MS po odpowiedzi: doklejone tuż za nią regulator
  // pomijał (2026-10-03). Okno adresu 0x56 trwa ok. 300 ms, więc to wciąż nasza kolej;
  // gdy ktoś w tym czasie nadaje, zapytanie czeka na następne CheckDevice.
  vTaskDelay(pdMS_TO_TICKS(SETTINGS_QUERY_GAP_MS));
  if (Serial1.available() > 0) {
    if (source == QuerySource::WRITER) parameterWriter.cancelRequest();
    else if (source == QuerySource::SETTINGS) boilerSettings.cancelRequest();
    else if (source == QuerySource::PASSWORD) servicePasswordReader.cancelRequest();
    else if (source == QuerySource::ALERTS) alertsLog.cancelRequest();
    return;
  }
  Serial1.write(query, queryLength);
  captureFrame("TX", query, queryLength);
  if (tracing()) {
    Serial.printf("TRACE %lu TX typ 0x%02x %u B (zapytanie)\n", static_cast<unsigned long>(micros()), query[7],
      static_cast<unsigned>(queryLength));
  }
  guard.onTransmitted(query, queryLength, millis(), parser.rejectedCount());
}

// Ramka od innego urządzenia niż my: koniec ewentualnej ciszy (wpis do logu) i obce 0x18 / 0x19 (bus_watch.hpp).
void watchFrame(const EcomaxFrame &frame, uint32_t nowMs)
{
  const bool wasSilent = silenceWatch.silent(nowMs);
  const bool masterFrame = frame.type == ECOMAX_FRAME_STOP_MASTER || frame.type == ECOMAX_FRAME_START_MASTER;
  portENTER_CRITICAL(&stateLock);
  silenceWatch.onFrame(frame, nowMs);
  portEXIT_CRITICAL(&stateLock);
  if (wasSilent) {
    // zdarzenie ciszy jest ostatnie, a przy ramce 0x18 / 0x19 przedostatnie (onFrame dopisuje je po ciszy)
    const BusSilenceWatch::Event &silence = silenceWatch.event(silenceWatch.eventCount() - (masterFrame ? 2 : 1));
    logf("magistrala: koniec ciszy po %lu s, StartMaster wysłane %u, regulator odezwał się po naszej ramce: %s",
      static_cast<unsigned long>(silence.durationMs / 1000), static_cast<unsigned>(silence.startMasterSent),
      silence.wokeAfterStartMaster ? "tak" : "nie");
  }
  if (masterFrame) {
    logf("magistrala: ramka %s (0x%02x) od 0x%02x do 0x%02x",
      frame.type == ECOMAX_FRAME_STOP_MASTER ? "StopMaster" : "StartMaster", frame.type, frame.sender, frame.recipient);
  }
}

// Po każdych BusSilenceWatch::SILENCE_MS bez ramki od innego urządzenia: StartMaster do regulatora, jak PyPlumIO.
// Tylko przy znanej polaryzacji i gdy EconetGuard pozwala nadawać (minuta nasłuchu, brak obcego ecoNET i kolizji).
void sendStartMasterIfSilent(uint32_t nowMs)
{
  if (!silenceWatch.startMasterDue(nowMs)) return;
  if (!(polarity.confirmed() || polarityKnown) || !guard.mayTransmit(nowMs)) return;
  uint8_t frame[16];
  const size_t length = buildStartMasterFrame(frame, sizeof(frame));
  if (length == 0) return;
  Serial1.write(frame, length);
  captureFrame("TX", frame, length);
  guard.onTransmitted(frame, length, millis(), parser.rejectedCount());
  portENTER_CRITICAL(&stateLock);
  silenceWatch.onStartMasterSent(nowMs);
  const unsigned sent = silenceWatch.startMasterInSilence();
  portEXIT_CRITICAL(&stateLock);
  logf("magistrala: cisza %lu s — StartMaster (0x19) do regulatora, %u. w tej ciszy",
    static_cast<unsigned long>(silenceWatch.silenceMs(nowMs) / 1000), sent);
}

// Bajty z UART1 do parsera; każda poprawna ramka potwierdza polaryzację, SensorData to odczyt.
// Wołane tylko z busTask.
void readBus(uint32_t nowMs)
{
  size_t budget = MAX_BYTES_PER_LOOP;
  while (budget > 0 && Serial1.available() > 0) {
    const int byte = Serial1.read();
    if (byte < 0) break;
    budget--;
    busBytes++;
    polarity.onBytes(1);
    parser.feed(static_cast<uint8_t>(byte));

    EcomaxFrame frame;
    while (parser.next(frame)) {
      validFrames++;
      if (!polarity.confirmed()) {
        preferences.putBool(KEY_INVERTED, polarity.inverted());
        logf("magistrala: pierwsza poprawna ramka, sygnał %s", polarity.inverted() ? "odwrócony" : "normalny");
      }
      polarity.onFrame(nowMs);
      // cała ramka: dane leżą w buforze parsera zaraz za 8 bajtami nagłówka
      captureFrame("RX", frame.data - 8, frame.dataLength + 10);
      if (tracing()) {
        Serial.printf("TRACE %lu RX typ 0x%02x 0x%02x->0x%02x %u B\n", static_cast<unsigned long>(micros()),
          frame.type, frame.sender, frame.recipient, static_cast<unsigned>(frame.dataLength));
      }
      recordFrameKind(frame);
      if (frame.sender != ECONET_ADDRESS) watchFrame(frame, nowMs);
      if (frame.type == ECOMAX_FRAME_PASSWORD_RESPONSE && servicePasswordReader.onResponse(frame)) {
        servicePasswordSavePending = true;
        logf("hasło serwisowe: odczytane (pokazywane tylko na /install)");
      }
      if (frame.type == ECOMAX_FRAME_ALERTS_RESPONSE) {
        portENTER_CRITICAL(&stateLock);
        alertsLog.onResponse(frame, nowMs);
        portEXIT_CRITICAL(&stateLock);
      }
      handleEconet(frame, nowMs);
      if (!isSensorDataFrame(frame)) continue;
      EcomaxSensorData decoded;
      if (!decodeSensorData(frame.data, frame.dataLength, decoded)) continue;
      portENTER_CRITICAL(&stateLock);
      latest = decoded;
      hasReading = true;
      readingAtMs = nowMs;
      sensorFrames++;
      fuelMeter.onSensorData(decoded.fuelConsumption, nowMs);
      portEXIT_CRITICAL(&stateLock);
      requestSettingsWhenChanged(nowMs, decoded);
      uint8_t refresh = versionWatch.onTable(decoded.frameVersions, decoded.frameVersionCount);
      if ((refresh & FrameVersionWatch::REFRESH_SETTINGS) && ownWriteConfirmed && nowMs - ownWriteConfirmedMs < OWN_WRITE_MS) {
        logf("ramka 0x%02x wersja %u → %u po naszym zapisie, odczyt już zlecony", versionWatch.changedType(),
          static_cast<unsigned>(versionWatch.oldVersion()), static_cast<unsigned>(versionWatch.newVersion()));
        refresh &= ~FrameVersionWatch::REFRESH_SETTINGS;
      }
      if (refresh) {
        logf("zmiana na panelu: ramka 0x%02x wersja %u → %u, %s", versionWatch.changedType(),
          static_cast<unsigned>(versionWatch.oldVersion()), static_cast<unsigned>(versionWatch.newVersion()),
          (refresh & FrameVersionWatch::REFRESH_SETTINGS) && (refresh & FrameVersionWatch::REFRESH_ALERTS)
            ? "czytam ustawienia i alarmy"
            : (refresh & FrameVersionWatch::REFRESH_SETTINGS) ? "czytam ustawienia" : "czytam alarmy");
        if (refresh & FrameVersionWatch::REFRESH_SETTINGS) boilerSettingsRequested = true;
        if (refresh & FrameVersionWatch::REFRESH_ALERTS) alertsRequested = true;
      }
      if (decoded.pendingAlerts.present && decoded.pendingAlerts.value != lastPendingAlerts) {
        if (lastPendingAlerts >= 0) {
          logf("alarmy: aktywnych %d → %u, czytam dziennik", lastPendingAlerts, decoded.pendingAlerts.value);
          alertsRequested = true;
        }
        lastPendingAlerts = decoded.pendingAlerts.value;
      }
    }
  }
  guard.update(millis(), parser.rejectedCount());
  sendStartMasterIfSilent(nowMs);
  const bool writing = parameterWriter.busy();
  parameterWriter.update(millis());
  if (writing && parameterWriter.result() == BoilerParameterWriter::Result::FAILED) {
    logf("parametr %s: brak potwierdzenia po %u próbach — sprawdź wartość na panelu",
      parameterName(parameterWriter.mixer(), parameterWriter.index()).c_str(),
      static_cast<unsigned>(BoilerParameterWriter::ATTEMPTS));
    finishParameterSet(false, "regulator nie potwierdził zmiany — sprawdź wartość na panelu");
    boilerSettingsRequested = true;
  }
  if (writing && parameterWriter.result() == BoilerParameterWriter::Result::UNCONFIRMED) {
    logf("%s: bez odpowiedzi 0xB7, sprawdzam odczytem",
      parameterName(parameterWriter.mixer(), parameterWriter.index()).c_str());
    verifySchedule(parameterWriter.index(), parameterWriter.value());
    ownWriteConfirmed = true;
    ownWriteConfirmedMs = nowMs;
  }
  const uint32_t passwordFailed = servicePasswordReader.failed();
  servicePasswordReader.update(millis());
  if (servicePasswordReader.failed() != passwordFailed) logf("hasło serwisowe: brak odpowiedzi regulatora");
  const uint32_t alertsFailed = alertsLog.failed();
  const bool alertsWasBusy = alertsLog.busy();
  alertsLog.update(millis());
  if (alertsLog.failed() != alertsFailed) logf("alarmy: brak odpowiedzi na zapytanie o dziennik (bez panelu?)");
  if (alertsWasBusy && !alertsLog.busy() && alertsLog.complete()) {
    logf("alarmy: dziennik %u wpisów", static_cast<unsigned>(alertsLog.entries()));
  }
  if (!alertsLog.busy() && !alertsRequested && alertsStartedMs != 0 && nowMs - alertsStartedMs >= ALERTS_EVERY_MS) {
    alertsRequested = true;
  }
  const int8_t settingsItem = boilerSettings.current();
  const uint32_t settingsFailed = boilerSettings.failed();
  boilerSettings.update(millis());
  if (boilerSettings.failed() != settingsFailed) {
    logf("ustawienia kotła: brak odpowiedzi na %s po %u próbach", BOILER_SETTINGS_REQUESTS[settingsItem].name,
      static_cast<unsigned>(BoilerSettingsReader::ATTEMPTS));
    if (!boilerSettings.busy()) finishSettingsRead();
  }
  const bool allowed = polarity.confirmed() && guard.mayTransmit(nowMs);
  if (allowed != econetAllowed) {
    econetAllowed = allowed;
    logf("ecoNET: %s", econetStateText(nowMs));
  }
  if (polarity.update(nowMs)) {
    logf("magistrala: bajty bez poprawnych ramek, odwracam sygnał (zmiana %lu)",
      static_cast<unsigned long>(polarity.switches()));
    startBus();
  }
}

// Zadanie magistrali: czyta bez przerwy (co 1 ms), także gdy loop() czeka na HTTP.
void busTask(void *)
{
  esp_task_wdt_add(nullptr);
  for (;;) {
    esp_task_wdt_reset();
    readBus(millis());
    vTaskDelay(1);
  }
}

// Kopia ostatniego odczytu (false, gdy go nie ma albo jest starszy niż READING_MAX_AGE_MS).
bool freshReading(EcomaxSensorData &out)
{
  portENTER_CRITICAL(&stateLock);
  const bool fresh = hasReading && millis() - readingAtMs < READING_MAX_AGE_MS;
  if (fresh) out = latest;
  portEXIT_CRITICAL(&stateLock);
  return fresh;
}

bool readingFresh()
{
  EcomaxSensorData ignored;
  return freshReading(ignored);
}

// --- chmura ---

// Adres endpointu sterownika: zawsze z deviceId (SN), z rootId, gdy jest zapisany.
String requestUrl(const char *path)
{
  String url = cloudUrl + path + "?deviceId=" + serial;
  if (rootId.length() > 0) url += "&rootId=" + rootId;
  return url;
}

// https://host[:port]/api/ albo http://host[:port]/api/ (środowisko lokalne): WebSocket łączy się z tym samym serwerem.
void parseCloudUrl()
{
  cloudTls = cloudUrl.startsWith("https://");
  const int hostStart = cloudUrl.indexOf("://") + 3;
  int hostEnd = cloudUrl.indexOf('/', hostStart);
  if (hostEnd < 0) hostEnd = cloudUrl.length();
  const String hostPort = cloudUrl.substring(hostStart, hostEnd);
  const int colon = hostPort.indexOf(':');
  cloudHost = colon < 0 ? hostPort : hostPort.substring(0, colon);
  cloudPort = colon < 0 ? (cloudTls ? 443 : 80) : static_cast<uint16_t>(hostPort.substring(colon + 1).toInt());
}

// Rozłącza WebSocket (zmiana Root ID, 404/409, pobieranie OTA); startWebSocket połączy go znowu.
void stopWebSocket()
{
  if (!webSocketStarted) return;
  webSocket.disconnect();
  webSocketStarted = false;
}

// {"type":"operation"}: nowe zlecenie albo „Aktualizuj” — pytanie o zlecenia w najbliższym tick();
// „update” (dla przeglądarek) jest pomijany.
void handleWebSocketEvent(WStype_t type, uint8_t *payload, size_t length)
{
  if (type == WStype_CONNECTED) {
    logf("WebSocket: połączony");
    commandPollDue = true;
  } else if (type == WStype_DISCONNECTED) {
    logf("WebSocket: rozłączony");
  } else if (type == WStype_TEXT) {
    JsonDocument message;
    if (!deserializeJson(message, reinterpret_cast<const char *>(payload), length)
      && strcmp(message["type"] | "", "operation") == 0) {
      commandPollDue = true;
    }
  }
}

// TLS dla https://; biblioteka sama łączy ponownie co 10 s po zerwaniu.
void startWebSocket()
{
  const String path = "/ws?rootId=" + rootId;
  if (cloudTls) webSocket.beginSSL(cloudHost.c_str(), cloudPort, path.c_str());
  else webSocket.begin(cloudHost.c_str(), cloudPort, path.c_str());
  webSocket.onEvent(handleWebSocketEvent);
  webSocket.setReconnectInterval(10000);
  webSocketStarted = true;
}

// Jedno zapytanie HTTP(S) (certyfikat nie jest sprawdzany, jak w pozostałych sterownikach).
// lastHttpStatus < 0 oznacza błąd połączenia.
bool post(const String &url, const String &body, String *response = nullptr, uint16_t timeoutMs = HTTP_TIMEOUT_MS)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  const bool secure = url.startsWith("https://");
  if (secure) secureClient.setInsecure();
  http.setReuse(true);
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  if (!(secure ? http.begin(secureClient, url) : http.begin(plainClient, url))) return false;
  http.addHeader("Content-Type", "application/json");
  lastHttpStatus = http.POST(body);
  const bool ok = lastHttpStatus >= 200 && lastHttpStatus < 300;
  if (ok && response) *response = http.getString();
  http.end();
  return ok;
}

bool get(const String &url, String &response, uint16_t timeoutMs = HTTP_TIMEOUT_MS)
{
  if (WiFi.status() != WL_CONNECTED) return false;
  const bool secure = url.startsWith("https://");
  if (secure) secureClient.setInsecure();
  http.setReuse(true);
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  if (!(secure ? http.begin(secureClient, url) : http.begin(plainClient, url))) return false;
  lastHttpStatus = http.GET();
  const bool ok = lastHttpStatus >= 200 && lastHttpStatus < 300;
  if (ok) response = http.getString();
  http.end();
  return ok;
}

// Interwał z settings zgłoszenia albo z odpowiedzi na wysyłkę (30–3600 s, inne pomijane).
void applyPollSeconds(JsonVariantConst value)
{
  if (!value.is<unsigned>()) return;
  const unsigned seconds = value.as<unsigned>();
  if (seconds < 30 || seconds > 3600 || seconds == pollSeconds) return;
  pollSeconds = static_cast<uint16_t>(seconds);
  preferences.putUShort(KEY_POLL_SECONDS, pollSeconds);
  logf("chmura: interwał wysyłki %u s", static_cast<unsigned>(pollSeconds));
}

// Zgłoszenie przy starcie (i po 404/409): rootId i interwał wysyłki.
void registerDevice()
{
  lastRegisterAttemptMs = millis();
  JsonDocument request;
  request["deviceId"] = serial;
  request["deviceType"] = DEVICE_TYPE;
  request["name"] = DEVICE_NAME;
  request["version"] = FW_VERSION;
  request["ip"] = WiFi.localIP().toString();
  String body;
  serializeJson(request, body);
  String response;
  if (!post(cloudUrl + "devices/register", body, &response, REGISTER_TIMEOUT_MS)) {
    logf("zgłoszenie: błąd, HTTP %d (ponowię za %lu s)", lastHttpStatus, static_cast<unsigned long>(REGISTER_RETRY_MS / 1000));
    return;
  }
  JsonDocument reply;
  if (deserializeJson(reply, response)) return;
  const String id = reply["rootId"] | "";
  if (id.length() == 0) return;
  if (id != rootId) {
    rootId = id;
    preferences.putString(KEY_ROOT_ID, rootId);
    stopWebSocket();
  }
  applyPollSeconds(reply["settings"]["poll_interval_seconds"]);
  registeredThisBoot = true;
  if (!webSocketStarted) startWebSocket();
  logf("zgłoszenie: OK (HTTP %d), rootId %s, interwał %u s", lastHttpStatus, rootId.c_str(),
    static_cast<unsigned>(pollSeconds));
}

// Odpowiedź z ustawieniami jako hex (kopia pod stateLock, bo zapisuje ją busTask); woła tylko
// loop() (strona /boiler-settings.json i wysyłka do chmury), więc bufor może być statyczny.
bool settingsItemHex(uint8_t item, String &hex, uint32_t &at)
{
  static uint8_t copy[BoilerSettingsReader::MAX_DATA];
  size_t length = 0;
  portENTER_CRITICAL(&stateLock);
  const bool has = boilerSettings.has(item);
  if (has) {
    length = boilerSettings.length(item);
    at = boilerSettings.receivedAtMs(item);
    memcpy(copy, boilerSettings.data(item), length);
  }
  portEXIT_CRITICAL(&stateLock);
  if (!has) return false;
  hex = "";
  hex.reserve(length * 2);
  char pair[3];
  for (size_t index = 0; index < length; index++) {
    snprintf(pair, sizeof(pair), "%02x", copy[index]);
    hex += pair;
  }
  return true;
}

// Ustawienia regulatora do chmury (panel „Ustawienia zaawansowane”) po każdym pełnym odczycie:
// POST pellet-boiler-pelux200/settings {nazwa: hex}. Błąd (także 404/409 — starszy serwer bez
// tego endpointu) nie kasuje Root ID, tylko ponawia wysyłkę po SETTINGS_RETRY_MS, a od 1.11.0 od razu
// po udanej wysyłce odczytu kotła (SettingsUpload). Flaga kasowana przed wysyłką: odczyt zakończony
// w trakcie zapytania (busTask) zostaje do wysłania.
constexpr uint32_t SETTINGS_RETRY_MS = SettingsUpload::RETRY_MS;
SettingsUpload settingsUpload;

void sendSettings(uint32_t nowMs)
{
  settingsUploadPending = false;
  JsonDocument document;
  for (uint8_t item = 0; item < BOILER_SETTINGS_COUNT; item++) {
    String hex;
    uint32_t at = 0;
    if (settingsItemHex(item, hex, at)) document[BOILER_SETTINGS_REQUESTS[item].name] = hex;
  }
  String body;
  serializeJson(document, body);
  const bool ok = post(requestUrl("pellet-boiler-pelux200/settings"), body);
  logf("ustawienia kotła do chmury: %s (HTTP %d, %u B)", ok ? "OK" : "błąd", lastHttpStatus,
    static_cast<unsigned>(body.length()));
  if (!ok) settingsUploadPending = true;
  settingsUpload.onResult(ok, nowMs);
}

// Dziennik alarmów do chmury po każdej zmianie (od 1.7.0): POST pellet-boiler-pelux200/alerts
// {total, alerts: [{i, code, from, to}]}, czasy surowe (sekundy ecoMAX od 2000-01-01, to = null, gdy trwa) —
// przelicza serwer. Błąd ponawia po SETTINGS_RETRY_MS i nie kasuje Root ID (starszy serwer bez endpointu).
void sendAlerts(uint32_t nowMs)
{
  JsonDocument document;
  AlertEntry copy[AlertsLogReader::MAX_ENTRIES];
  portENTER_CRITICAL(&stateLock);
  const uint32_t revision = alertsLog.revision();
  const uint8_t total = alertsLog.total();
  const size_t count = alertsLog.entries();
  for (size_t i = 0; i < count; i++) copy[i] = alertsLog.entry(i);
  portEXIT_CRITICAL(&stateLock);
  document["total"] = total;
  JsonArray list = document["alerts"].to<JsonArray>();
  for (size_t i = 0; i < count; i++) {
    JsonObject item = list.add<JsonObject>();
    item["i"] = i;
    item["code"] = copy[i].code;
    item["from"] = copy[i].from;
    if (copy[i].to == ECOMAX_ALERT_ONGOING) item["to"] = nullptr;
    else item["to"] = copy[i].to;
  }
  String body;
  serializeJson(document, body);
  const bool ok = post(requestUrl("pellet-boiler-pelux200/alerts"), body);
  logf("alarmy do chmury: %s (HTTP %d, %u wpisów)", ok ? "OK" : "błąd", lastHttpStatus, static_cast<unsigned>(count));
  if (ok) alertsUploadedRevision = revision;
  else nextAlertsUploadMs = nowMs + SETTINGS_RETRY_MS;
}

// Ostatni świeży odczyt do chmury. 404/409: Root ID nieaktualny, zgłoszenie od nowa.
uint32_t readingSignature(const EcomaxSensorData &reading);

// Stan licznika pelletu do odczytu (kg, 3 miejsca), od 1.7.1.
double fuelKilograms()
{
  portENTER_CRITICAL(&stateLock);
  const double grams = fuelMeter.grams();
  portEXIT_CRITICAL(&stateLock);
  return static_cast<double>(static_cast<int64_t>(grams + 0.5)) / 1000.0;
}

// Licznik pelletu do NVS co FuelMeter::SAVE_EVERY_MS (gdy przybył co najmniej 1 g) i przed restartem (force).
void saveFuel(uint32_t nowMs, bool force)
{
  if (!force && nowMs - lastFuelSaveMs < FuelMeter::SAVE_EVERY_MS) return;
  lastFuelSaveMs = nowMs;
  portENTER_CRITICAL(&stateLock);
  const double grams = fuelMeter.grams();
  portEXIT_CRITICAL(&stateLock);
  if (grams - lastSavedFuelGrams < 1.0) return;
  preferences.putDouble(KEY_FUEL_GRAMS, grams);
  lastSavedFuelGrams = grams;
}

void sendReading(uint32_t nowMs, const EcomaxSensorData &reading)
{
  JsonDocument document;
  fillPelletJson(document, reading);
  document["fuel_burned_kg"] = fuelKilograms();
  String body;
  serializeJson(document, body);
  String response;
  const bool ok = post(requestUrl("pellet-boiler-pelux200/add"), body, &response);
  lastPostStatus = lastHttpStatus;
  logf("odczyt do chmury: %s (HTTP %d)", ok ? "OK" : "błąd", lastHttpStatus);
  if (ok) {
    lastPostOkMs = nowMs;
    lastSentSignature = readingSignature(reading);
    // serwer odpowiada: niewysłane ustawienia od razu, bez czekania SETTINGS_RETRY_MS
    settingsUpload.onCloudOk();
    // zlecenia czekające na stan kotła (zmiana trybu po wyłączeniu) mogą być już do wysłania
    commandPollDue = true;
    JsonDocument reply;
    if (!deserializeJson(reply, response)) applyPollSeconds(reply["poll_interval_seconds"]);
    nextPostMs = nowMs + pollSeconds * 1000UL;
    return;
  }
  nextPostMs = nowMs + POST_RETRY_MS;
  if (lastHttpStatus == 404 || lastHttpStatus == 409) {
    rootId = "";
    preferences.remove(KEY_ROOT_ID);
    registeredThisBoot = false;
    lastRegisterAttemptMs = 0;
    stopWebSocket();
  }
}

// Podpis odczytu (FNV-1a): stan, wyjścia i zadane; temperatury pominięte (zmieniają się ciągle).
uint32_t fnv(uint32_t hash, uint32_t value, int bytes)
{
  for (int i = 0; i < bytes; i++) {
    hash ^= (value >> (8 * i)) & 0xFF;
    hash *= 16777619u;
  }
  return hash;
}

uint32_t targetsSignature(const EcomaxSensorData &reading)
{
  uint32_t hash = 2166136261u;
  hash = fnv(hash, reading.heatingTarget.present ? reading.heatingTarget.value : 0xFFFF, 2);
  hash = fnv(hash, reading.waterHeaterTarget.present ? reading.waterHeaterTarget.value : 0xFFFF, 2);
  for (const EcomaxMixer &mixer : reading.mixers) hash = fnv(hash, mixer.present ? mixer.target : 0xFFFF, 2);
  return hash | 1;  // 0 = „jeszcze nic”
}

uint32_t readingSignature(const EcomaxSensorData &reading)
{
  uint32_t hash = fnv(targetsSignature(reading), reading.state, 1);
  return fnv(hash, reading.outputs, 4) | 1;
}

// Pełny odczyt ustawień po przerwie w SensorData, po zmianie zadanej (na panelu albo naszej) i co 15 min
// (settings_refresh.hpp); nie w trakcie odczytu, zapisu ani zlecenia z aplikacji. Woła busTask przy każdym
// SensorData, także bez Wi-Fi (do 1.10.1 tick(), tylko z Wi-Fi i po zgłoszeniu).
void requestSettingsWhenChanged(uint32_t nowMs, const EcomaxSensorData &reading)
{
  const SettingsRefresh::Reason reason = settingsRefresh.onReading(nowMs, targetsSignature(reading), settingsReadDoneMs,
    boilerSettingsRequested, boilerSettings.busy() || parameterWriter.busy() || cloudCommandActive);
  if (reason == SettingsRefresh::Reason::NONE) return;
  boilerSettingsRequested = true;
  logf("ustawienia kotła: %s, odczyt od nowa",
    reason == SettingsRefresh::Reason::AFTER_GAP ? "dane z kotła po przerwie"
      : reason == SettingsRefresh::Reason::TARGETS ? "zmiana zadanej" : "co 15 min");
}

// Zlecenia zmiany parametrów z aplikacji (serwer: pellet-boiler-pelux200-command.service.ts):
// co CLOUD_COMMAND_POLL_MS pytanie o najstarsze oczekujące, jedno naraz; wynik (ok / błąd) wraca
// przez POST commands/result. Bez wyniku po CLOUD_COMMAND_TIMEOUT_MS (brak odczytu ustawień albo
// okna ecoNET) zlecenie kończy się błędem; zapis w toku nie jest przerywany.
constexpr uint32_t CLOUD_COMMAND_POLL_MS = 15000;
constexpr uint32_t CLOUD_COMMAND_TIMEOUT_MS = 120000;
uint32_t lastCommandPollMs = 0;
// oferta OTA z ostatniej odpowiedzi commands/next i klucz próbowany w tym uruchomieniu
OtaOffer otaOffer;
bool otaOfferReceived = false;
std::string otaAttemptedKey;
String otaStatus;
uint32_t cloudCommandAtMs = 0;
String cloudCommandId;

void sendCommandResult()
{
  bool ok;
  char error[sizeof(cloudResultError)];
  portENTER_CRITICAL(&stateLock);
  ok = cloudResultOk;
  memcpy(error, cloudResultError, sizeof(error));
  portEXIT_CRITICAL(&stateLock);
  JsonDocument document;
  document["id"] = cloudCommandId;
  document["ok"] = ok;
  if (!ok) document["error"] = error;
  String body;
  serializeJson(document, body);
  const bool sent = post(requestUrl("pellet-boiler-pelux200/commands/result"), body);
  logf("zlecenie z aplikacji: wynik %s do chmury: %s (HTTP %d)", ok ? "OK" : error, sent ? "wysłany" : "błąd",
    lastHttpStatus);
  // 404: serwer nie ma już tego zlecenia w toku (np. wróciło do kolejki) — i tak koniec
  if (!sent && lastHttpStatus != 404) return;
  cloudCommandId = "";
  cloudResultReady = false;
  cloudCommandActive = false;
  // następne zlecenie od razu, a aplikacja dostaje świeży odczyt (np. stan po włącz/wyłącz)
  commandPollDue = true;
  readingDue = true;
}

void pollCloudCommand(uint32_t nowMs)
{
  if (cloudCommandActive) {
    if (!cloudResultReady && !parameterWriter.busy() && nowMs - cloudCommandAtMs >= CLOUD_COMMAND_TIMEOUT_MS) {
      parameterSetRequested = false;
      const bool verifying = scheduleVerifyPending;
      scheduleVerifyPending = false;
      finishParameterSet(false, verifying ? "harmonogram wysłany, ale brak odczytu, który go potwierdza — sprawdź na panelu"
                                          : "brak odczytu ustawień albo okna ecoNET — zmiana nie wysłana");
    }
    if (cloudResultReady && nowMs - lastCommandPollMs >= 2000) {
      lastCommandPollMs = nowMs;
      sendCommandResult();
    }
    return;
  }
  // Regulator wyłączony albo bez komunikacji (brak odczytu młodszego niż READING_MAX_AGE_MS): nie
  // pobieramy zleceń, więc czekają w kolejce w chmurze i wykonają się po włączeniu kotła. Do 1.6.2
  // pobrane zlecenie kończyło się po 2 min błędem „brak okna ecoNET” (2026-10-05 17:06–17:17,
  // kocioł bez zasilania). Oferta OTA też przychodzi z commands/next, więc przy wyłączonym kotle czeka.
  if (!readingFresh()) return;
  if (!commandPollDue && lastCommandPollMs != 0 && nowMs - lastCommandPollMs < CLOUD_COMMAND_POLL_MS) return;
  commandPollDue = false;
  lastCommandPollMs = nowMs;
  String response;
  if (!get(requestUrl("pellet-boiler-pelux200/commands/next"), response)) return;
  JsonDocument document;
  if (deserializeJson(document, response)) return;
  // zlecenie „Aktualizuj”: oferta zamiast zlecenia parametru (tryFirmwareUpdate); jej brak = zlecenia nie ma
  const bool hadOffer = otaOfferReceived;
  otaOfferReceived = parseOtaOffer(document.as<JsonVariantConst>(), otaOffer);
  if (otaOfferReceived) {
    if (!hadOffer) logf("OTA: zlecona wersja %s", otaOffer.version.c_str());
    return;
  }
  const char *id = document["id"] | "";
  if (!*id) return;
  const String kind = document["kind"] | "";
  const int mixer = document["mixer"] | 0;
  const int index = document["index"] | -1;
  const int value = document["value"] | -1;
  const bool isMixer = kind == "mixer";
  const bool isControl = kind == "control";
  const bool isSchedule = kind == "schedule";
  cloudCommandId = id;
  cloudResultReady = false;
  cloudCommandActive = true;
  cloudCommandAtMs = nowMs;
  if ((!isMixer && !isControl && !isSchedule && kind != "ecomax") || index < 0 || index > 255 || value < 0 || value > 255
    || (isMixer && (mixer < 1 || mixer > ECOMAX_MIXER_MAX))) {
    finishParameterSet(false, "nieprawidłowe zlecenie");
    return;
  }
  parameterSetIndex = static_cast<uint8_t>(index);
  parameterSetValue = static_cast<uint8_t>(value);
  parameterSetMixer = isSchedule ? BoilerParameterWriter::SCHEDULE
    : isControl                 ? BoilerParameterWriter::CONTROL
    : isMixer                   ? static_cast<uint8_t>(mixer - 1)
                                : BoilerParameterWriter::NO_MIXER;
  parameterSetRequested = true;
  logf("zlecenie z aplikacji: %s → %d, czekam na okno ecoNET",
    parameterName(parameterSetMixer, parameterSetIndex).c_str(), value);
}

// Pobiera obraz z oferty do nieaktywnej partycji OTA, licząc SHA-256 w locie; obraz jest aktywowany
// dopiero po zgodnej sumie. Blokuje loop() (kilkanaście sekund, watchdog resetowany przy każdej
// porcji); magistralę dalej obsługuje busTask, więc regulator nie traci ecoNET.
void restartWithReason(const char *reason);

bool downloadFirmware(const OtaOffer &offer)
{
  logf("OTA: pobieram %s", offer.url.c_str());
  stopWebSocket();
  secureClient.stop();
  WiFiClientSecure client;
  client.setInsecure();  // integralność daje SHA-256 z odpowiedzi chmury
  HTTPClient download;
  download.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
  download.setConnectTimeout(OTA_TIMEOUT_MS);
  download.setTimeout(OTA_TIMEOUT_MS);
  if (!download.begin(client, offer.url.c_str())) return false;
  esp_task_wdt_reset();
  const int status = download.GET();
  const int total = download.getSize();
  if (status != 200 || total <= 0 || !Update.begin(total)) {
    otaStatus = "download failed (HTTP " + String(status) + ")";
    logf("OTA: HTTP %d, rozmiar %d", status, total);
    download.end();
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  WiFiClient *stream = download.getStreamPtr();
  uint8_t buffer[1024];
  int remaining = total;
  uint32_t lastDataMs = millis();
  bool ok = true;
  while (remaining > 0) {
    esp_task_wdt_reset();
    const size_t available = stream->available();
    if (available == 0) {
      if (!download.connected() || millis() - lastDataMs > OTA_TIMEOUT_MS) { ok = false; break; }
      delay(1);
      continue;
    }
    const size_t count = stream->readBytes(buffer, min(min(available, sizeof(buffer)), static_cast<size_t>(remaining)));
    mbedtls_sha256_update(&sha, buffer, count);
    if (Update.write(buffer, count) != count) { ok = false; break; }
    remaining -= count;
    lastDataMs = millis();
  }
  download.end();

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  char hex[65];
  for (int index = 0; index < 32; index++) snprintf(hex + index * 2, 3, "%02x", digest[index]);

  if (!ok || remaining != 0) {
    Update.abort();
    otaStatus = "download interrupted";
    logf("OTA: przerwane, brakuje %d B", remaining);
    return false;
  }
  if (offer.sha256 != hex) {
    Update.abort();
    otaStatus = "SHA-256 mismatch";
    logf("OTA: SHA-256 niezgodna (jest %s, oferta %s)", hex, offer.sha256.c_str());
    return false;
  }
  if (!Update.end(true)) {
    otaStatus = "image rejected";
    return false;
  }
  logf("OTA: obraz %d B zapisany, SHA-256 zgodna", total);
  return true;
}

// Aktualizacja na zlecenie z aplikacji, gdy nie trwa zlecenie parametru ani odczyt ustawień kotła
// (restart przerwałby rozmowę z regulatorem w połowie). Jedna próba na zlecenie w uruchomieniu
// (otaAttemptedKey) i jedna po pobraniu (ota_tried w NVS); ponowne „Aktualizuj” to nowe zlecenie.
// Po restarcie zgłoszenie niesie nową wersję i serwer kasuje zlecenie.
void tryFirmwareUpdate()
{
  if (!otaOfferReceived || cloudCommandActive || parameterSetRequested || parameterWriter.busy()
    || boilerSettings.busy()) return;
  const std::string key = otaKey(otaOffer);
  if (key == otaAttemptedKey) return;
  const String tried = preferences.getString(KEY_OTA_TRIED, "");
  if (!shouldUpdate(otaOffer, FW_VERSION, tried.c_str())) return;
  otaAttemptedKey = key;
  otaStatus = "downloading version " + String(otaOffer.version.c_str());
  if (!downloadFirmware(otaOffer)) return;
  preferences.putString(KEY_OTA_TRIED, key.c_str());
  restartWithReason(("cloud update to " + otaOffer.version).c_str());
}

// --- Wi-Fi i AP ---

const char *accessPointPassword()
{
  return strlen(AP_PASSWORD) >= 8 ? AP_PASSWORD : nullptr;
}

// Moc nadajnika Wi-Fi. Płytki ESP32-C3 SuperMini przy pełnej mocy (19,5 dBm) często nie łączą
// się z siecią (znana wada anteny i zasilania tej płytki); 8,5 dBm to sprawdzone obejście.
// Ustawiane po każdej zmianie trybu Wi-Fi, bo stos ją wtedy przywraca.
constexpr wifi_power_t WIFI_TX_POWER = WIFI_POWER_8_5dBm;
constexpr uint32_t WIFI_SCAN_EVERY_MS = 60000;
uint32_t lastWifiScanMs = 0;
// RSSI sieci z ostatniego skanu bez połączenia (0 = nie widać albo nie skanowano)
int wifiScanRssi = 0;
volatile uint8_t wifiLastDisconnectReason = 0;

uint32_t lastWifiReconnectMs = 0;
// przyczyna poprzedniego startu: sprzętowa (esp_reset_reason) i programowa z NVS
String lastResetText;

void applyTxPower()
{
  WiFi.setTxPower(WIFI_TX_POWER);
}

// Restart programowy z zapisem przyczyny w NVS (widać ją po starcie na konsoli i stronie /).
void saveFuel(uint32_t nowMs, bool force);

void restartWithReason(const char *reason)
{
  logf("restart: %s", reason);
  saveFuel(millis(), true);
  preferences.putString(KEY_RESTART_REASON, reason);
  delay(100);
  ESP.restart();
}

// Opis przyczyny poprzedniego startu; programowy restart z zapisaną przyczyną ma pierwszeństwo.
String describeLastReset()
{
  const String saved = preferences.getString(KEY_RESTART_REASON, "");
  preferences.remove(KEY_RESTART_REASON);
  switch (esp_reset_reason()) {
  case ESP_RST_POWERON: return "power on";
  case ESP_RST_SW: return saved.length() ? "software restart: " + saved : "software restart (upload, /install)";
  case ESP_RST_PANIC: return "program error (panic)";
  case ESP_RST_INT_WDT:
  case ESP_RST_TASK_WDT:
  case ESP_RST_WDT: return "watchdog (hang)";
  case ESP_RST_BROWNOUT: return "supply voltage drop (brownout)";
  case ESP_RST_DEEPSLEEP: return "wake-up";
  case ESP_RST_EXT: return "RESET button";
  case ESP_RST_UNKNOWN: return "unknown (e.g. reset after USB upload)";
  default: return "other (" + String(static_cast<int>(esp_reset_reason())) + ")";
  }
}

// Zdarzenia Wi-Fi na konsoli: przyczyna rozłączenia (np. 201 = nie widać sieci, 15 = złe hasło
// / brak uzgodnienia, 2 = wygasło uwierzytelnienie) i adres po połączeniu.
void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info)
{
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    const uint8_t reason = info.wifi_sta_disconnected.reason;
    if (reason != wifiLastDisconnectReason) {
      wifiLastDisconnectReason = reason;
      Serial.printf("[%7lu] Wi-Fi: rozłączone, przyczyna %u\n", static_cast<unsigned long>(millis()), reason);
    }
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    wifiLastDisconnectReason = 0;
    Serial.printf("[%7lu] Wi-Fi: połączone, IP %s, RSSI %d dBm\n", static_cast<unsigned long>(millis()),
      WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
}

// Bez połączenia co minutę skan: czy zapisana sieć jest widoczna i z jakim sygnałem.
void scanForNetwork(uint32_t nowMs)
{
  if (wifiSsid.length() == 0 || (lastWifiScanMs != 0 && nowMs - lastWifiScanMs < WIFI_SCAN_EVERY_MS)) return;
  lastWifiScanMs = nowMs;
  const int count = WiFi.scanNetworks();
  int best = 0;
  int channel = 0;
  for (int index = 0; index < count; index++) {
    if (WiFi.SSID(index) == wifiSsid && (best == 0 || WiFi.RSSI(index) > best)) {
      best = WiFi.RSSI(index);
      channel = WiFi.channel(index);
    }
  }
  WiFi.scanDelete();
  wifiScanRssi = best;
  if (count < 0) logf("Wi-Fi: skan nieudany (%d)", count);
  else if (best == 0) logf("Wi-Fi: sieci %s nie widać (widocznych sieci: %d)", wifiSsid.c_str(), count);
  else logf("Wi-Fi: sieć %s widoczna, RSSI %d dBm, kanał %d, nadal bez połączenia", wifiSsid.c_str(), best, channel);
}

// AP do konfiguracji (domyślnie otwarty): po starcie i po 1 min bez Wi-Fi; wyłączany
// po 1 min połączenia (strony są wtedy pod adresem IP sterownika w sieci domowej).
void updateAccessPoint(uint32_t nowMs)
{
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected) {
    wifiLostSinceMs = 0;
    wifiScanRssi = 0;
    if (wifiConnectedSinceMs == 0) wifiConnectedSinceMs = nowMs;
  } else {
    wifiConnectedSinceMs = 0;
    if (wifiLostSinceMs == 0) wifiLostSinceMs = nowMs;
    if (nowMs - wifiLostSinceMs >= 20000) scanForNetwork(nowMs);
  }
  if (accessPointOn && connected && nowMs - wifiConnectedSinceMs >= AP_OFF_AFTER_MS) {
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    applyTxPower();
    accessPointOn = false;
    logf("AP %s: wyłączony (strony pod %s)", accessPointSsid(), WiFi.localIP().toString().c_str());
  } else if (!accessPointOn && !connected && wifiLostSinceMs != 0 && nowMs - wifiLostSinceMs >= AP_ON_AFTER_MS) {
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(AP_ADDRESS, AP_ADDRESS, IPAddress(255, 255, 255, 0));
    accessPointOn = WiFi.softAP(accessPointSsid(), accessPointPassword());
    applyTxPower();
    logf("AP %s: włączony (brak Wi-Fi)", accessPointSsid());
  }
  if (connected || wifiSsid.length() == 0 || wifiLostSinceMs == 0) return;
  // Najpierw ponowne łączenie bez restartu.
  const uint32_t lostMs = nowMs - wifiLostSinceMs;
  if (lostMs >= WIFI_RECONNECT_EVERY_MS && nowMs - lastWifiReconnectMs >= WIFI_RECONNECT_EVERY_MS) {
    lastWifiReconnectMs = nowMs;
    logf("Wi-Fi: brak połączenia od %lu s, łączę od nowa", static_cast<unsigned long>(lostMs / 1000));
    WiFi.disconnect();
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
    applyTxPower();
  }
  // Restart dopiero po długim braku Wi-Fi; nie w trakcie konfiguracji przez AP (przerwałby
  // telefonowi stronę /install) ani w trakcie odczytu lub zmiany ustawień kotła.
  if (lostMs >= WIFI_RESTART_AFTER_MS && WiFi.softAPgetStationNum() == 0 && !boilerSettings.busy()
    && !parameterWriter.busy()) {
    restartWithReason("no Wi-Fi for 30 min");
  }
}

// Co 30 s jedna linia stanu na konsoli.
void logStatus(uint32_t nowMs)
{
  if (nowMs - lastStatusLogMs < STATUS_LOG_MS) return;
  lastStatusLogMs = nowMs;
  logf("stan: Wi-Fi %d, zgłoszony %d, bajty %lu, ramki %lu (SensorData %lu, odrzucone %lu), sygnał %s%s, odczyt %s",
    static_cast<int>(WiFi.status()), registeredThisBoot, static_cast<unsigned long>(busBytes),
    static_cast<unsigned long>(validFrames), static_cast<unsigned long>(sensorFrames),
    static_cast<unsigned long>(parser.rejectedCount()), polarity.inverted() ? "odwrócony" : "normalny",
    polarity.confirmed() ? "" : " (niepotwierdzony)", readingFresh() ? "świeży" : "brak");
  logf("ecoNET: %s, odpowiedzi %lu, echo %lu, pominięte %lu, obce ramki %lu, kolizje %lu", econetStateText(nowMs),
    static_cast<unsigned long>(guard.transmitted()), static_cast<unsigned long>(guard.echoes()),
    static_cast<unsigned long>(econetSkipped), static_cast<unsigned long>(guard.foreignFrames()),
    static_cast<unsigned long>(guard.collisions()));
  EcomaxSensorData reading;
  if (freshReading(reading)) {
    JsonDocument document;
    fillPelletJson(document, reading);
    String json;
    serializeJson(document, json);
    Serial.printf("          odczyt: %s\n", json.c_str());
  }
  FrameKind kinds[MAX_FRAME_KINDS];
  portENTER_CRITICAL(&stateLock);
  const uint8_t kindCount = frameKindCount;
  memcpy(kinds, frameKinds, sizeof(FrameKind) * kindCount);
  portEXIT_CRITICAL(&stateLock);
  for (uint8_t index = 0; index < kindCount; index++) {
    const FrameKind &kind = kinds[index];
    Serial.printf("          ramki: typ 0x%02x od 0x%02x do 0x%02x: %lu szt., ostatnio %u B\n", kind.type, kind.sender,
      kind.recipient, static_cast<unsigned long>(kind.count), static_cast<unsigned>(kind.lastLength));
  }
}

// Stan sieci, który ecoNET zgłasza regulatorowi w DeviceAvailable (menu ecoNET na panelu).
void updateNetworkInfo()
{
  EconetNetworkInfo info;
  info.wifiConnected = WiFi.status() == WL_CONNECTED;
  if (info.wifiConnected) {
    const IPAddress ip = WiFi.localIP();
    const IPAddress mask = WiFi.subnetMask();
    const IPAddress gateway = WiFi.gatewayIP();
    for (uint8_t i = 0; i < 4; i++) {
      info.ip[i] = ip[i];
      info.netmask[i] = mask[i];
      info.gateway[i] = gateway[i];
    }
    info.signalPercent = signalPercentFromRssi(WiFi.RSSI());
  }
  info.cloudConnected = registeredThisBoot && (lastPostStatus == 0 || (lastPostStatus >= 200 && lastPostStatus < 300));
  strlcpy(info.ssid, wifiSsid.c_str(), sizeof(info.ssid));
  portENTER_CRITICAL(&stateLock);
  networkInfo = info;
  portEXIT_CRITICAL(&stateLock);
}

// Co 1 s: AP, stan sieci dla ecoNET, zgłoszenie (co 30 s do skutku), wysyłka świeżego
// odczytu co pollSeconds.
void tick(uint32_t nowMs)
{
  updateAccessPoint(nowMs);
  updateNetworkInfo();
  logStatus(nowMs);
  if (WiFi.status() != WL_CONNECTED) return;
  if (!registeredThisBoot) {
    if (lastRegisterAttemptMs == 0 || nowMs - lastRegisterAttemptMs >= REGISTER_RETRY_MS) registerDevice();
    if (!registeredThisBoot) return;
  }
  EcomaxSensorData reading;
  const bool fresh = freshReading(reading);
  const bool changed = fresh && lastSentSignature != 0 && readingSignature(reading) != lastSentSignature;
  if (fresh && (readingDue || changed) && nowMs - lastImmediatePostMs >= IMMEDIATE_POST_MIN_MS) {
    lastImmediatePostMs = nowMs;
    readingDue = false;
    if (changed) logf("odczyt kotła: zmiana stanu, wyjść albo zadanych, do chmury od razu");
    sendReading(nowMs, reading);
  } else if (fresh && static_cast<int32_t>(nowMs - nextPostMs) >= 0) {
    sendReading(nowMs, reading);
  }
  if (settingsUploadPending && settingsUpload.due(nowMs)) sendSettings(nowMs);
  saveFuel(nowMs, false);
  if (servicePasswordSavePending) {
    servicePasswordSavePending = false;
    char text[ServicePasswordReader::MAX_LENGTH + 1];
    portENTER_CRITICAL(&stateLock);
    memcpy(text, servicePasswordReader.text(), sizeof(text));
    portEXIT_CRITICAL(&stateLock);
    text[sizeof(text) - 1] = '\0';
    servicePasswordAtMs = nowMs;
    if (servicePassword != text) {
      servicePassword = text;
      preferences.putString(KEY_SERVICE_PASSWORD, servicePassword);
    }
  }
  if (!alertsLog.busy() && alertsLog.complete() && alertsLog.revision() != alertsUploadedRevision
    && static_cast<int32_t>(nowMs - nextAlertsUploadMs) >= 0) {
    sendAlerts(nowMs);
  }
  pollCloudCommand(nowMs);
  tryFirmwareUpdate();
}

// --- strony WWW ---

String htmlEscape(const String &text)
{
  String out;
  for (char c : text) {
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

const char PAGE_HEAD[] PROGMEM = R"html(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pellux 200 boiler</title>
<style>body{font-family:sans-serif;margin:0 auto;max-width:28rem;padding:1rem;color:#222}@media(max-width:30rem){body{padding:.3rem}}
.card{background:#f1f1f1;border-radius:.5rem;padding:.75rem 1rem;margin-bottom:1rem;overflow-wrap:anywhere}
.on{color:#1481a5}.bad{color:#c62828}table{width:100%;border-collapse:collapse}td{padding:.15rem 0}
td+td{text-align:right;font-weight:600}button{background:#1481a5;color:#fff;border:0;border-radius:6px;padding:.6rem 1rem;font-size:1rem}
label{display:block;margin:.4rem 0}label input{width:100%;box-sizing:border-box;padding:.3rem}small{color:#555}
h2{margin:0 0 .5rem;padding-bottom:.3rem;border-bottom:2px solid #1481a5;color:#1481a5;font-size:1.25rem}
p:has(>button){text-align:right}
</style></head><body>)html";

// Odczyt i diagnostyka magistrali z /state.json (odświeżanie co 2 s).
const char MAIN_PAGE[] PROGMEM = R"html(<h1>Pellux 200 boiler</h1>
<div class="card"><h2>Reading</h2><div id="reading">---</div></div>
<div class="card"><h2>ecoMAX bus</h2><div id="bus">---</div></div>
<div class="card"><h2>Wi-Fi and cloud</h2><div id="net">---</div></div>
<p><a href="/install">Setup</a></p>
<script>
var L={state:'State',heating_temp:'Boiler [°C]',heating_target:'Boiler target [°C]',water_heater_temp:'DHW [°C]',
water_heater_target:'DHW target [°C]',feeder_temp:'Feeder [°C]',return_temp:'Return [°C]',exhaust_temp:'Exhaust [°C]',
outside_temp:'Outside [°C]',fuel_level:'Fuel [%]',fan_power:'Fan [%]',boiler_power:'Power [kW]',
boiler_load:'Load [%]',fuel_consumption:'Consumption [kg/h]',fan:'Fan',feeder:'Feeder',
heating_pump:'Heating pump',water_heater_pump:'DHW pump',circulation_pump:'Circulation',lighter:'Igniter',alarm:'Alarm'};
function v(x){return x===true?'yes':x===false?'no':typeof x=='number'?Math.round(x*10)/10:x}
function load(){fetch('/state.json',{cache:'no-store'}).then(r=>r.json()).then(s=>{
reading.innerHTML=s.reading?'<table>'+Object.keys(L).filter(k=>k in s.reading).map(k=>'<tr><td>'+L[k]+'</td><td>'
+(k=='state'?s.stateName:v(s.reading[k]))+'</td></tr>').join('')+'</table><small>'+s.ageS+' s ago</small>'
:'<span class="bad">No reading from the boiler</span>';
bus.innerHTML='Bytes: <b>'+s.bytes+'</b>, frames: <b>'+s.frames+'</b> (SensorData '+s.sensorFrames+', rejected '+s.rejected+')<br>'
+'Signal: <b>'+(s.inverted?'inverted':'normal')+'</b>'+(s.confirmed?'':' <small>(detecting)</small>')
+'<br>ecoNET (0x56): <b>'+s.econet+'</b><br><small>replies '+s.econetTx+', echo '+s.econetEcho
+', foreign frames '+s.econetForeign+', collisions '+s.econetCollisions+'</small>'
+'<br>Controller silence: '+(s.silenceS?'<b class="bad">for '+s.silenceS+' s</b>':'<b class="on">none</b>')
+', StartMaster sent: '+s.startMasterSent
+((s.busEvents||[]).length?'<br><small>'+s.busEvents.map(e=>e.kind=='silence'
?Math.round(e.agoS/60)+' min ago: silence '+e.durationS+' s, StartMaster '+e.startMasterSent+(e.woke?', woke it':'')+' (before: '+e.before+')'
:Math.round(e.agoS/60)+' min ago: '+e.kind+' '+e.frame).join('<br>')+'</small>':'')
+'<br>Boiler settings: <b>'+s.settingsRead+'/5</b>'+(s.settingsBusy?' (reading)':'')
+' <a href="/boiler-settings.json" download>download</a>'
+'<br><small>Receive GPIO21, transmit GPIO20, 115200 baud</small>';
net.innerHTML='Wi-Fi: '+(s.wifi?'<b class="on">'+s.ssid+'</b>, '+s.ip+', '+s.rssi+' dBm':'<b class="bad">none</b>'
+(s.scanRssi?' <small>(network visible, '+s.scanRssi+' dBm)</small>':'')
+(s.disconnectReason?' <small>reason '+s.disconnectReason+'</small>':''))
+'<br>Cloud: '+(s.registered?'<b class="on">registered</b>':'<b class="bad">not registered</b>')
+(s.lastPostS!==null?', last upload '+s.lastPostS+' s ago':'')+(s.lastStatus?' (HTTP '+s.lastStatus+')':'')
+'<br><small>Upload every '+s.pollSeconds+' s while the reading is fresh</small>'
+'<br><small>Up for '+Math.floor(s.uptimeS/60)+' min; previous start: '+s.lastReset+'</small>'})}
load();setInterval(load,2000);
</script></body></html>)html";

// GET / (i każda nieznana ścieżka).
void handleRoot()
{
  String page = FPSTR(PAGE_HEAD);
  page += FPSTR(MAIN_PAGE);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/html; charset=utf-8", page);
}

// GET /state.json: ostatni odczyt (te same pola co wysyłka), liczniki magistrali, sieć.
void handleState()
{
  JsonDocument state;
  EcomaxSensorData last;
  portENTER_CRITICAL(&stateLock);
  const bool have = hasReading;
  const uint32_t at = readingAtMs;
  if (have) last = latest;
  portEXIT_CRITICAL(&stateLock);
  const uint32_t now = millis();
  if (have) {
    JsonDocument reading;
    fillPelletJson(reading, last);
    reading["fuel_burned_kg"] = fuelKilograms();
    state["reading"] = reading;
    state["stateName"] = last.state < 12 ? STATE_NAMES[last.state] : "?";
    state["ageS"] = (now - at) / 1000;
  }
  uint8_t settingsRead = 0;
  for (uint8_t item = 0; item < BOILER_SETTINGS_COUNT; item++) settingsRead += boilerSettings.has(item) ? 1 : 0;
  state["settingsRead"] = settingsRead;
  state["settingsBusy"] = boilerSettings.busy();
  state["econet"] = econetStateText(now);
  state["econetTx"] = guard.transmitted();
  state["econetEcho"] = guard.echoes();
  state["econetForeign"] = guard.foreignFrames();
  state["econetCollisions"] = guard.collisions();
  state["bytes"] = busBytes;
  state["frames"] = validFrames;
  state["sensorFrames"] = sensorFrames;
  state["rejected"] = parser.rejectedCount();
  // cisza regulatora i StartMaster (od 1.7.0): bieżąca cisza, licznik i ostatnie zdarzenia
  {
    JsonArray events = state["busEvents"].to<JsonArray>();
    portENTER_CRITICAL(&stateLock);
    const uint32_t silence = silenceWatch.silenceMs(now);
    const uint32_t startMasters = silenceWatch.startMasterTotal();
    const size_t count = silenceWatch.eventCount();
    BusSilenceWatch::Event copy[BusSilenceWatch::EVENTS];
    for (size_t i = 0; i < count; i++) copy[i] = silenceWatch.event(i);
    portEXIT_CRITICAL(&stateLock);
    state["silenceS"] = silence / 1000;
    state["startMasterSent"] = startMasters;
    for (size_t i = count; i-- > 0;) {
      const BusSilenceWatch::Event &e = copy[i];
      JsonObject item = events.add<JsonObject>();
      item["agoS"] = (now - e.atMs) / 1000;
      if (e.kind == BusSilenceWatch::EventKind::SILENCE) {
        item["kind"] = "silence";
        item["durationS"] = e.durationMs / 1000;
        item["startMasterSent"] = e.startMasterSent;
        item["woke"] = e.wokeAfterStartMaster;
        char before[BusSilenceWatch::HISTORY * 10 + 1] = "";
        size_t used = 0;
        for (uint8_t k = 0; k < e.beforeCount; k++) {
          used += snprintf(before + used, sizeof(before) - used, "%s%02x@%02x", k ? " " : "", e.before[k].type, e.before[k].sender);
        }
        item["before"] = before;
      } else {
        item["kind"] = e.type == ECOMAX_FRAME_STOP_MASTER ? "StopMaster" : "StartMaster";
        char text[24];
        snprintf(text, sizeof(text), "0x%02x->0x%02x", e.sender, e.recipient);
        item["frame"] = text;
      }
    }
  }
  state["inverted"] = polarity.inverted();
  state["confirmed"] = polarity.confirmed();
  state["wifi"] = WiFi.status() == WL_CONNECTED;
  state["ssid"] = wifiSsid;
  if (WiFi.status() == WL_CONNECTED) {
    state["ip"] = WiFi.localIP().toString();
    state["rssi"] = WiFi.RSSI();
  } else {
    if (wifiScanRssi != 0) state["scanRssi"] = wifiScanRssi;
    if (wifiLastDisconnectReason != 0) state["disconnectReason"] = wifiLastDisconnectReason;
  }
  state["registered"] = registeredThisBoot;
  if (lastPostOkMs) state["lastPostS"] = (now - lastPostOkMs) / 1000;
  else state["lastPostS"] = nullptr;
  state["lastStatus"] = lastPostStatus ? lastPostStatus : lastHttpStatus;
  state["pollSeconds"] = pollSeconds;
  state["lastReset"] = lastResetText;
  state["uptimeS"] = now / 1000;
  String body;
  serializeJson(state, body);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

// GET /boiler-settings.json: surowe odpowiedzi regulatora z ustawieniami (hex, dane ramki bez
// nagłówka) — kopia na wypadek awarii; dekodowanie opisuje docs/kociol-ustawienia.md.
void handleBoilerSettings()
{
  JsonDocument document;
  document["firmware"] = FW_VERSION;
  document["busy"] = boilerSettings.busy();
  for (uint8_t item = 0; item < BOILER_SETTINGS_COUNT; item++) {
    String hex;
    uint32_t at = 0;
    if (!settingsItemHex(item, hex, at)) continue;
    JsonObject entry = document[BOILER_SETTINGS_REQUESTS[item].name].to<JsonObject>();
    entry["type"] = BOILER_SETTINGS_REQUESTS[item].type | 0x80;
    entry["ageS"] = (millis() - at) / 1000;
    entry["hex"] = hex;
  }
  String body;
  serializeJson(document, body);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

// Basic Auth stron /install (login z secrets.h).
bool authorized()
{
  if (server.authenticate(INSTALL_USER, INSTALL_PASSWORD)) return true;
  server.requestAuthentication();
  return false;
}

// /install: Wi-Fi, ręczne wgranie firmware (z chmury: „Aktualizuj” w aplikacji), dane sterownika.
void handleInstall()
{
  if (!authorized()) return;
  if (server.method() == HTTP_POST) {
    const String ssid = server.arg("ssid");
    const String password = server.arg("password");
    if (ssid.length() > 0) {
      wifiSsid = ssid;
      preferences.putString(KEY_WIFI_SSID, ssid);
      if (password.length() > 0) {
        wifiPassword = password;
        preferences.putString(KEY_WIFI_PASSWORD, password);
      }
    }
    WiFi.disconnect();
    if (wifiSsid.length() > 0) {
      WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
      applyTxPower();
    }
    server.sendHeader("Location", "/install", true);
    server.send(303, "text/plain", "");
    return;
  }
  String page = FPSTR(PAGE_HEAD);
  page += "<h1>Setup</h1><form method=\"post\" class=\"card\"><h2>Wi-Fi</h2>";
  page += "<label>Wi-Fi network (SSID)<input name=\"ssid\" value=\"" + htmlEscape(wifiSsid) + "\"></label>";
  page += "<label>Wi-Fi password <small>(empty = unchanged)</small><input name=\"password\" type=\"password\"></label>";
  page += "<p><button type=\"submit\">Save</button></p></form>";
  // Hasło serwisowe regulatora tylko na żądanie (?service=1): nowy odczyt z kotła i ostatnie zapisane hasło
  page += "<div class=\"card\"><h2>Controller service password</h2>";
  if (server.arg("service") == "1") {
    servicePasswordRequested = true;
    page += "<div>Password: <b>" + (servicePassword.length() ? htmlEscape(servicePassword) : String("---")) + "</b></div>";
    page += servicePasswordAtMs
      ? "<div><small>Read from the boiler " + String((millis() - servicePasswordAtMs) / 1000) + " s ago.</small></div>"
      : String("<div><small>Saved earlier in the controller; reading from the boiler — refresh the page in a few seconds.</small></div>");
    page += "<p><a href=\"/install\">Hide</a></p>";
  } else {
    page += "<p><a href=\"/install?service=1\">Show service password</a></p>";
  }
  page += "</div>";
  page += "<div class=\"card\"><div>SN: <b>" + serial + "</b></div>";
  page += "<div>Root ID: <b>" + (rootId.length() ? htmlEscape(rootId) : String("---")) + "</b></div>";
  page += "<div>Registered in the cloud: " + String(registeredThisBoot ? "yes" : "no") + "</div></div>";
  // firmware na końcu strony (jak we wszystkich sterownikach)
  page += "<form method=\"post\" action=\"/install/firmware\" enctype=\"multipart/form-data\" class=\"card\"><h2>Firmware</h2>";
  page += "<div>Version: <b>" + String(FW_VERSION) + "</b></div>";
  if (otaStatus.length() > 0) page += "<div><small>Cloud update: " + htmlEscape(otaStatus) + "</small></div>";
  page += "<label>firmware.bin file<input name=\"firmware\" type=\"file\" accept=\".bin\" required></label>";
  page += "<p><button type=\"submit\">Upload</button></p></form>";
  page += "<p><a href=\"/\">Home</a></p></body></html>";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/html; charset=utf-8", page);
}

// Ręczne wgranie firmware.bin (strona /install albo curl): prosto do nieaktywnej partycji OTA.
void handleFirmwareUpload()
{
  HTTPUpload &upload = server.upload();
  switch (upload.status) {
  case UPLOAD_FILE_START:
    uploadFinished = false;
    uploadAccepted = server.authenticate(INSTALL_USER, INSTALL_PASSWORD) && Update.begin(UPDATE_SIZE_UNKNOWN);
    break;
  case UPLOAD_FILE_WRITE:
    if (uploadAccepted && Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Update.abort();
      uploadAccepted = false;
    }
    break;
  case UPLOAD_FILE_END:
    if (uploadAccepted) uploadFinished = Update.end(true);
    uploadAccepted = false;
    break;
  default:
    if (uploadAccepted) Update.abort();
    uploadAccepted = false;
    break;
  }
}

// Koniec wgrywania: odpowiedź i restart do nowego obrazu.
void handleFirmwareDone()
{
  if (!authorized()) return;
  server.send(uploadFinished ? 200 : 409, "text/plain; charset=utf-8",
    uploadFinished ? "Firmware uploaded, the controller is restarting." : "Not uploaded: the file is invalid.");
  if (uploadFinished) {
    delay(500);
    restartWithReason("firmware upload via /install");
  }
}

// AP do konfiguracji (10.10.10.1) razem z siecią domową (AP+STA) i strony WWW.
void startNetwork()
{
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(AP_ADDRESS, AP_ADDRESS, IPAddress(255, 255, 255, 0));
  accessPointOn = WiFi.softAP(accessPointSsid(), accessPointPassword());
  applyTxPower();
  logf("AP %s: %s (10.10.10.1), moc nadajnika %.1f dBm", accessPointSsid(), accessPointOn ? "uruchomiony" : "NIE uruchomiony",
    WiFi.getTxPower() / 4.0);
  if (wifiSsid.length() > 0) {
    logf("Wi-Fi: łączę z %s", wifiSsid.c_str());
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
    applyTxPower();
  } else {
    logf("Wi-Fi: brak zapisanej sieci (ustaw na /install przez AP)");
  }
  server.on("/", HTTP_GET, handleRoot);
  server.on("/state.json", HTTP_GET, handleState);
  server.on("/boiler-settings.json", HTTP_GET, handleBoilerSettings);
  server.on("/install", handleInstall);
  server.on("/install/firmware", HTTP_POST, handleFirmwareDone, handleFirmwareUpload);
  server.onNotFound(handleRoot);
  server.begin();
}

}  // namespace

// Start: konfiguracja z NVS, nasłuch magistrali, sieć. Zgłoszenie i wysyłka w tick().
void setup()
{
  Serial.begin(115200);
  preferences.begin(PREFERENCES_NAMESPACE, false);
  // połączenie przez ecoNET300 (Wi-Fi) z wersji 1.9.0 wycofane 2026-10-10: kasujemy jego ustawienia z NVS
  for (const char *key : {"conn", "eco_ip", "eco_user", "eco_pass"}) {
    if (preferences.isKey(key)) preferences.remove(key);
  }
  loadConfig();
  parseCloudUrl();
  serial = readSerial();
  lastResetText = describeLastReset();
  logf("start: firmware %s, SN %s, rootId %s, chmura %s", FW_VERSION, serial.c_str(),
    rootId.length() > 0 ? rootId.c_str() : "brak", CLOUD_URL);
  logf("start: przyczyna — %s", lastResetText.c_str());
  // watchdog pętli i zadania magistrali: brak esp_task_wdt_reset() przez WATCHDOG_S = restart
  esp_task_wdt_init(WATCHDOG_S, true);
  esp_task_wdt_add(nullptr);
  startBus();
  guard.begin(millis());
  silenceWatch.begin(millis());
  xTaskCreate(busTask, "bus", BUS_TASK_STACK, nullptr, BUS_TASK_PRIORITY, nullptr);
  startNetwork();
}

// Strony WWW w każdym obiegu, reszta co 1 s (magistrala w busTask).
void loop()
{
  esp_task_wdt_reset();
  server.handleClient();
  if (webSocketStarted) webSocket.loop();
  // Konsola USB: litery p / t / r od razu, „set <nr> <wartość>” zakończone Enterem.
  static char consoleLine[32];
  static uint8_t consoleLength = 0;
  while (Serial.available() > 0) {
    const int command = Serial.read();
    if (consoleLength > 0 || command == 's' || command == 'S') {
      if (command == '\n' || command == '\r') {
        consoleLine[consoleLength] = '\0';
        consoleLength = 0;
        unsigned mixer, index, value;
        if (cloudCommandActive) {
          logf("konsola: trwa zlecenie z aplikacji, spróbuj za chwilę");
        } else if (sscanf(consoleLine, "sched %u %u", &index, &value) == 2 && index < 256 && value <= 1) {
          parameterSetMixer = BoilerParameterWriter::SCHEDULE;
          parameterSetIndex = static_cast<uint8_t>(index);
          parameterSetValue = static_cast<uint8_t>(value);
          parameterSetRequested = true;
          logf("harmonogram nr %u → %s: zlecone, czekam na okno ecoNET", index, value ? "włączony" : "wyłączony");
        } else if (sscanf(consoleLine, "setm %u %u %u", &mixer, &index, &value) == 3 && mixer >= 1
          && mixer <= ECOMAX_MIXER_MAX && index < 256 && value < 256) {
          parameterSetMixer = static_cast<uint8_t>(mixer - 1);
          parameterSetIndex = static_cast<uint8_t>(index);
          parameterSetValue = static_cast<uint8_t>(value);
          parameterSetRequested = true;
          logf("parametr mieszacz %u nr %u → %u: zlecone, czekam na okno ecoNET", mixer, index, value);
        } else if (sscanf(consoleLine, "set %u %u", &index, &value) == 2 && index < 256 && value < 256) {
          parameterSetMixer = BoilerParameterWriter::NO_MIXER;
          parameterSetIndex = static_cast<uint8_t>(index);
          parameterSetValue = static_cast<uint8_t>(value);
          parameterSetRequested = true;
          logf("parametr kotła nr %u → %u: zlecone, czekam na okno ecoNET", index, value);
        } else {
          logf("konsola: nieznane polecenie „%s” (set <nr> <wartość>, setm <mieszacz> <nr> <wartość>, sched <nr> <0|1>)", consoleLine);
        }
      } else if (consoleLength + 1 < sizeof(consoleLine)) {
        consoleLine[consoleLength++] = static_cast<char>(command);
      }
      continue;
    }
    if (command == 'p' || command == 'P') {
      boilerSettingsRequested = true;
      logf("ustawienia kotła: odczyt zlecony z konsoli");
    } else if (command == 't' || command == 'T') {
      traceUntilMs = millis() + TRACE_MS;
    } else if (command == 'r' || command == 'R') {
      captureUntilMs = millis() + CAPTURE_MS;
      logf("nagranie magistrali: %lu min", static_cast<unsigned long>(CAPTURE_MS / 60000));
    }
  }
  const uint32_t now = millis();
  if (now - lastTickMs >= TICK_MS) {
    lastTickMs = now;
    tick(now);
  }
}
