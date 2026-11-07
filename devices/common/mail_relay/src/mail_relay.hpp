#pragma once
// Przekaźnik poczty (2026-10-17), wspólny dla włącznika i sterownika co. Render na darmowym planie blokuje
// wychodzące SMTP, więc maile chmury (kody logowania, zaproszenia) wysyła płytka z domowego łącza: włącznik
// pierwszy, co zapasowo (chmura sama przekazuje mail drugiemu, server/src/core/services/mail-relay.service.ts).
//
// Działa we własnym zadaniu FreeRTOS z własnym klientem HTTPS, więc nie blokuje pętli sterownika (przekaźniki,
// magistrala RS-485 pompy). Pętla sterownika podaje tylko Root ID i SN (setDevice), część odpowiedzi na zgłoszenie
// (onRegisterReply: zaszyfrowane dane SMTP) i sygnał WebSocket „mail” (wake). Zadanie:
//   - dane SMTP: z odpowiedzi na zgłoszenie albo GET mail/config; odszyfrowane trzyma tylko w RAM (bez NVS),
//   - GET mail/next po sygnale „mail”, co 25 s przez 90 s po nim (przejęcie maila od drugiej płytki) i co 60 s,
//   - mail: odszyfrowanie, SMTP z STARTTLS (smtp_client), POST mail/result z potwierdzeniem z zadania.
// Klucz płytki: mail_crypto.hpp (prywatny w NVS „mail_key”, publiczny w zgłoszeniu jako mailKey).
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "mail_crypto.hpp"
#include "smtp_client.hpp"

namespace mail_relay {

class MailRelay {
public:
  // cloudUrl: adres API z ukośnikiem na końcu (np. „https://dom.mojeturnie.pl/api/”). Tworzy albo wczytuje
  // klucz i uruchamia zadanie. False = klucza nie da się utworzyć (płytka działa dalej, bez poczty).
  bool begin(Preferences &preferences, const String &cloudUrl);

  // Pole mailKey do zgłoszenia (puste, gdy begin się nie udało) i odcisk do strony /install.
  const String &publicKey() const { return crypto.publicKey(); }
  const String &fingerprint() const { return crypto.fingerprint(); }

  // Wołane z pętli sterownika (bezpieczne między zadaniami).
  void setDevice(const String &rootId, const String &serial);
  void onRegisterReply(JsonVariantConst mail);
  void wake();

  // Stan do strony /install: klucz, dane SMTP, ostatnia wysyłka.
  String statusText();

private:
  static void taskEntry(void *self);
  void run();
  bool http(const char *method, const String &path, const String &body, String &response, int &status);
  void applyMailField(const String &json, const String &rootId);
  bool sendNextMail(const String &rootId);
  void forgetSettings();
  void setStatus(const String &text);

  MailCrypto crypto;
  String apiUrl;
  SemaphoreHandle_t lock = nullptr;
  TaskHandle_t task = nullptr;

  // wspólne z pętlą sterownika (pod lock)
  String deviceRootId;
  String deviceSerial;
  String registerMail;
  bool woken = false;
  uint32_t wokenAtMs = 0;
  String keyState = "?";
  String lastResult = "nothing sent yet";
  uint32_t sentCount = 0;

  // tylko w zadaniu
  bool haveSettings = false;
  SmtpSettings settings;
};

}  // namespace mail_relay
