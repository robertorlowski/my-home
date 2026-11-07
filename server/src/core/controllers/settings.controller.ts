// POST /api/settings/read i PUT /api/settings: ustawienia aplikacji dla konta systemowego (core/services/settings.service.ts).
// Konto sprawdza middleware/session.ts (systemOnly), a hasło ustawień jest w treści żądania, więc nie trafia do adresu ani logów.
// Po zapisie poczta i powiadomienia używają nowych wartości od razu.
import { Request, Response } from 'express';
import { requestLang, t } from '../i18n';
import { resetMailTransport } from '../services/mail.service';
import { resetPushConfig } from '../services/push.service';
import { checkSettingsPassword, saveSettings, SettingsError, SettingsLockError, settingsView } from '../services/settings.service';

const unlocked = (req: Request, res: Response) => {
  try {
    checkSettingsPassword(req.body?.password);
    return true;
  } catch (error) {
    if (!(error instanceof SettingsLockError)) throw error;
    const key = error.status === 429 ? 'err.tooManyTryMinute' : 'err.settingsLocked';
    res.status(error.status).json({ message: t(requestLang(req), key), locked: true });
    return false;
  }
};

export function readSettings(req: Request, res: Response) {
  if (!unlocked(req, res)) return;
  return res.status(200).json(settingsView());
}

export async function putSettings(req: Request, res: Response) {
  if (!unlocked(req, res)) return;
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
