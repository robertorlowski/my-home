// Testy pogody z Open-Meteo (od 1.1.3): położenie z odpowiedzi chmury, adres zapytania, parser odpowiedzi,
// pole weather w telemetrii i harmonogram pobierania. Uruchamianie: pio test -e native.
#ifdef ARDUINO
#include <Arduino.h>
#endif
#include <unity.h>

#include <weather.hpp>

void setUp() {}
void tearDown() {}

static JsonDocument json(const char *text)
{
  JsonDocument document;
  deserializeJson(document, text);
  return document;
}

void testLocationFromCloudResponse()
{
  WeatherLocation location;
  TEST_ASSERT_FALSE(parseWeatherLocation(json("{\"operation\":{}}").as<JsonVariantConst>(), location));
  TEST_ASSERT_FALSE(parseWeatherLocation(json("{\"weather_query\":{\"lat\":120,\"lon\":20}}").as<JsonVariantConst>(), location));
  TEST_ASSERT_FALSE(location.valid);
  TEST_ASSERT_TRUE(parseWeatherLocation(json("{\"weather_query\":{\"lat\":49.374298,\"lon\":20.007237}}").as<JsonVariantConst>(), location));
  TEST_ASSERT_TRUE(location.valid);
  TEST_ASSERT_EQUAL_STRING(
    "http://api.open-meteo.com/v1/forecast?latitude=49.3743&longitude=20.0072"
    "&current=temperature_2m,weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,is_day&timezone=Europe%2FWarsaw"
    "&models=icon_seamless",
    openMeteoUrl(location).c_str());
}

// odpowiedź Open-Meteo z 14.10.2026 23:15 (Biały Dunajec, pochmurno, noc)
void testParseOpenMeteoResponse()
{
  const char *response =
    "{\"latitude\":49.378174,\"current_units\":{\"weather_code\":\"wmo code\"},\"current\":{\"time\":\"2026-10-14T23:15\","
    "\"interval\":900,\"temperature_2m\":6.0,\"weather_code\":3,\"cloud_cover\":100,\"precipitation\":0.00,\"rain\":0.00,\"snowfall\":0.00,"
    "\"wind_speed_10m\":5.8,\"is_day\":0}}";
  WeatherReading reading;
  TEST_ASSERT_TRUE(parseOpenMeteoCurrent(response, strlen(response), reading));
  TEST_ASSERT_EQUAL_INT(3, reading.code);
  TEST_ASSERT_EQUAL_INT(100, reading.cloudCover);
  TEST_ASSERT_EQUAL_INT(58, static_cast<int>(reading.windSpeed * 10 + 0.5));
  TEST_ASSERT_EQUAL_INT(60, static_cast<int>(reading.temperature * 10 + 0.5));
  TEST_ASSERT_FALSE(reading.isDay);
  TEST_ASSERT_TRUE(reading.valid);

  WeatherReading broken;
  const char *missing = "{\"current\":{\"weather_code\":61}}";
  TEST_ASSERT_FALSE(parseOpenMeteoCurrent(missing, strlen(missing), broken));
  TEST_ASSERT_FALSE(parseOpenMeteoCurrent("{nie json", 9, broken));
  TEST_ASSERT_FALSE(broken.valid);
}

void testTelemetryField()
{
  JsonDocument document;
  WeatherReading reading;
  reading.temperature = 6.5;
  reading.code = 61;
  reading.cloudCover = 90;
  reading.precipitation = 1.2;
  reading.rain = 1.2;
  reading.windSpeed = 12.5;
  reading.isDay = true;
  reading.valid = true;
  writeWeather(document, reading, 120500);
  std::string text;
  serializeJson(document, text);
  TEST_ASSERT_EQUAL_STRING(
    "{\"weather\":{\"temp\":6.5,\"code\":61,\"cloud\":90,\"precip\":1.2,\"rain\":1.2,\"snow\":0,\"wind\":12.5,\"day\":1,\"age_s\":120}}",
    text.c_str());
  // za stara pogoda znika z telemetrii
  writeWeather(document, reading, WEATHER_MAX_AGE_MS + 1);
  TEST_ASSERT_TRUE(document["weather"].isNull());
}

void testSchedule()
{
  WeatherSchedule schedule;
  TEST_ASSERT_FALSE(schedule.due(false, 0));  // bez położenia nic
  TEST_ASSERT_TRUE(schedule.due(true, 1000));
  schedule.onAttempt(false, 1000);
  TEST_ASSERT_FALSE(schedule.due(true, 1000 + WEATHER_RETRY_MS - 1));
  TEST_ASSERT_TRUE(schedule.due(true, 1000 + WEATHER_RETRY_MS));
  schedule.onAttempt(true, 400000);
  TEST_ASSERT_FALSE(schedule.due(true, 400000 + WEATHER_RETRY_MS));
  TEST_ASSERT_TRUE(schedule.due(true, 400000 + WEATHER_INTERVAL_MS));
  // nowe położenie: pobranie od razu
  schedule.onLocation(true);
  TEST_ASSERT_TRUE(schedule.due(true, 400001));
}

// Wiele miejsc (1.2.0): weather_queries z chmury, odczyt zachowany przy tym samym id, zmiana położenia = pobranie
// od razu, jedno pobranie naraz z odstępem, tablica weather w zgłoszeniu; starsza chmura (weather_query) = obiekt.
void testPlacesFromCloud()
{
  WeatherPlaces places;
  TEST_ASSERT_FALSE(places.update(json("{\"relays\":[]}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(0, places.size());
  // starsza chmura: jedno miejsce bez id
  TEST_ASSERT_TRUE(places.update(json("{\"weather_query\":{\"lat\":49.37,\"lon\":20.0}}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(1, places.size());
  TEST_ASSERT_EQUAL_STRING("", places.at(0).id.c_str());
  // nowa chmura: lista z id; wpis bez id albo poza zakresem pomijany
  TEST_ASSERT_TRUE(places.update(json(
    "{\"weather_query\":{\"lat\":49.37,\"lon\":20.0},\"weather_queries\":[{\"id\":\"dom\",\"lat\":49.37,\"lon\":20.0},"
    "{\"id\":\"krakow\",\"lat\":50.06,\"lon\":19.94},{\"lat\":1,\"lon\":1},{\"id\":\"zle\",\"lat\":99,\"lon\":0}]}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(2, places.size());
  TEST_ASSERT_EQUAL_STRING("krakow", places.at(1).id.c_str());
  // odpowiedź bez miejsc (chmura od 2026-10-29 wysyła je tylko przy zmianie): lista bez zmian
  TEST_ASSERT_FALSE(places.update(json("{\"relays\":[{\"on\":false,\"mode\":\"schedule\"}]}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(2, places.size());
  TEST_ASSERT_EQUAL_STRING("krakow", places.at(1).id.c_str());

  // pobieranie: pierwsze miejsce od razu, drugie dopiero po odstępie
  TEST_ASSERT_EQUAL(0, places.dueIndex(1000));
  WeatherReading reading;
  reading.temperature = 6.5;
  reading.code = 61;
  reading.cloudCover = 90;
  reading.precipitation = 1.2;
  reading.rain = 1.2;
  reading.windSpeed = 12.5;
  reading.isDay = true;
  reading.valid = true;
  places.onFetched(0, true, reading, 1000);
  TEST_ASSERT_EQUAL(-1, places.dueIndex(1000 + WEATHER_SPACING_MS - 1));
  TEST_ASSERT_EQUAL(1, places.dueIndex(1000 + WEATHER_SPACING_MS));
  places.onFetched(1, false, reading, 1000 + WEATHER_SPACING_MS);
  TEST_ASSERT_EQUAL(-1, places.dueIndex(2000 + WEATHER_SPACING_MS));

  // zgłoszenie: tylko miejsca z odczytem
  JsonDocument document;
  places.write(document, 121500);
  std::string text;
  serializeJson(document, text);
  TEST_ASSERT_EQUAL_STRING(
    "{\"weather\":[{\"id\":\"dom\",\"temp\":6.5,\"code\":61,\"cloud\":90,\"precip\":1.2,\"rain\":1.2,\"snow\":0,\"wind\":12.5,\"day\":1,\"age_s\":120}]}",
    text.c_str());

  // ta sama lista z chmury zachowuje odczyt; zmiana położenia domu = pobranie od razu; usunięty Kraków znika
  TEST_ASSERT_TRUE(places.update(json("{\"weather_queries\":[{\"id\":\"dom\",\"lat\":49.37,\"lon\":20.0}]}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(1, places.size());
  TEST_ASSERT_TRUE(places.at(0).reading.valid);
  TEST_ASSERT_EQUAL(-1, places.dueIndex(200000));
  TEST_ASSERT_TRUE(places.update(json("{\"weather_queries\":[{\"id\":\"dom\",\"lat\":49.30,\"lon\":19.95}]}").as<JsonVariantConst>()));
  TEST_ASSERT_EQUAL(0, places.dueIndex(200000));

  // stary odczyt znika z telemetrii
  JsonDocument old;
  places.write(old, 1000 + WEATHER_MAX_AGE_MS + 1);
  TEST_ASSERT_TRUE(old["weather"].isNull());

  // starsza chmura po nowej: obiekt zamiast tablicy
  WeatherPlaces legacy;
  legacy.update(json("{\"weather_query\":{\"lat\":49.37,\"lon\":20.0}}").as<JsonVariantConst>());
  legacy.onFetched(0, true, reading, 5000);
  JsonDocument single;
  legacy.write(single, 65000);
  TEST_ASSERT_EQUAL(61, single["weather"]["code"].as<int>());
  TEST_ASSERT_EQUAL(60, single["weather"]["age_s"].as<int>());
}

int runAllTests()
{
  UNITY_BEGIN();
  RUN_TEST(testLocationFromCloudResponse);
  RUN_TEST(testParseOpenMeteoResponse);
  RUN_TEST(testTelemetryField);
  RUN_TEST(testSchedule);
  RUN_TEST(testPlacesFromCloud);
  return UNITY_END();
}

#ifdef ARDUINO
void setup()
{
  delay(2000);
  runAllTests();
}

void loop()
{
}
#else
int main()
{
  return runAllTests();
}
#endif
