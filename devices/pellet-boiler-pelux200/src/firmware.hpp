// Stałe sprzętowe i kontraktowe sterownika pieca Pellux 200 (osobna płytka ESP32-C3
// SuperMini z modułem RS-485 HW-519). Zmiana DEVICE_TYPE wymaga zmiany na serwerze
// (DeviceType.PELLET_BOILER_PELUX200). Do 2026-10-02 tę rolę pełnił firmware co.
#pragma once

#include <cstdint>

constexpr const char *DEVICE_TYPE = "pellet-boiler-pelux200";
// Wersja firmware: wysyłana w zgłoszeniu (strona Ustawienia w aplikacji). Podnieść przy wydaniu.
constexpr const char *FW_VERSION = "1.11.1";
// Nazwa nadawana nowemu urządzeniu przy pierwszym zgłoszeniu.
constexpr const char *DEVICE_NAME = "Piec Pellux 200";

// Magistrala ecoMAX przez HW-519 (transceiver z automatycznym kierunkiem, bez pinu DE/RE;
// opisy pinów od strony modułu): TXD modułu (dane z magistrali) na GPIO21, sprawdzone
// 2026-10-03; RXD modułu (dane na magistralę) na GPIO20 od 1.1.0 (etap 2: odpowiedzi ecoNET,
// econet.hpp). Sterownik nadaje tylko odpowiedzi na zapytania regulatora do adresu 0x56.
constexpr int ECOMAX_RX_PIN = 21;
constexpr int ECOMAX_TX_PIN = 20;
constexpr uint32_t ECOMAX_BAUD = 115200;

// Odczyt starszy niż to nie jest wysyłany.
constexpr uint32_t READING_MAX_AGE_MS = 60000;
// Odstęp wysyłki do pierwszego zgłoszenia; potem settings.poll_interval_seconds (30–3600).
constexpr uint16_t DEFAULT_POLL_SECONDS = 300;

// Stały adres chmury; flaga -D PELLET_CLOUD_URL=... (build_flags) podmienia go np. na serwer lokalny.
#ifndef PELLET_CLOUD_URL
#define PELLET_CLOUD_URL "https://dom.mojeturnie.pl/api/"
#endif
constexpr const char *CLOUD_URL = PELLET_CLOUD_URL;
