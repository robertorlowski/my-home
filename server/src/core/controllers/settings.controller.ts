// GET /api/settings i PUT /api/settings: ustawienia aplikacji dla konta systemowego (core/services/settings.service.ts).
// Konto sprawdza middleware/session.ts (systemOnly); od 2026-11-13 bez osobnego hasła ustawień, bo konto system loguje
// się kodem z maila. POST /api/settings/read to dawny odczyt z hasłem w treści: zostaje dla klienta sprzed zmiany
// (karta albo aplikacja bez odświeżenia), hasło jest pomijane. Po zapisie poczta i powiadomienia używają nowych wartości od razu.
import { Request, Response } from 'express';
import { requestLang, t } from '../i18n';
import { resetMailTransport } from '../services/mail.service';
import { resetPushConfig } from '../services/push.service';
import { saveSettings, SettingsError, settingsView } from '../services/settings.service';

export function readSettings(_req: Request, res: Response) {
  return res.status(200).json(settingsView());
}

export async function putSettings(req: Request, res: Response) {
  const changes = req.body?.values;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return res.status(400).json({ message: t(requestLang(req), 'err.settingInvalid', { key: 'values' }) });
  }
  try {
    const view = await saveSettings(changes);
    resetMailTransport();
    resetPushConfig();
    return res.status(200).json(view);
  } catch (error) {
    if (error instanceof SettingsError) {
      return res.status(400).json({ message: t(requestLang(req), 'err.settingInvalid', { key: error.key }) });
    }
    console.error(error);
    return res.status(500).json({ message: t(requestLang(req), 'err.settingsSave') });
  }
}
