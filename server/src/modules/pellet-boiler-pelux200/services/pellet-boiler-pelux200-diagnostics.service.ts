// Starty sterownika pieca w dzienniku operacji (firmware od 1.11.2, pole diag w zgłoszeniu POST /devices/register,
// wołane z onRegister w device-type.ts): przyczyna startu (esp_reset_reason albo restart programowy z przyczyną zapisaną
// w NVS), numer startu, sygnał Wi-Fi i czas od startu. 2026-11-21 sterownik restartował się przez watchdog przy sygnale
// −88 dBm (3.10.2026: −74 dBm), a przyczynę pokazywał tylko na swojej stronie w sieci domowej, dla ostatniego startu.
// Sterownik zgłasza się raz na start, ale ponawia zgłoszenie po błędzie albo braku odpowiedzi (także po 404/409), więc
// ten sam numer startu trafia do dziennika raz: sprawdzenie wpisu w dzienniku (trzyma OPERATION_LOG_RETENTION_DAYS),
// odporne na restart serwera. Starszy firmware bez diag nie daje wpisu.
import { OperationLogModel } from '../../../core/models/operation-log.model';
import { isResetCode, resetReasonText } from '../../../core/services/controller-reset.service';
import { controllerMeta, logOperation } from '../../../core/services/operation-log.service';

export type BoilerControllerDiag = { reset: string; boot: number; rssi?: number; uptimeS?: number };

export const BOILER_RESTART_ACTION = 'Restart sterownika';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

// Pole diag zgłoszenia; brak albo błędne = undefined (zgłoszenie jest przyjmowane i tak).
export function parseBoilerControllerDiag(body: Record<string, unknown>): BoilerControllerDiag | undefined {
  const diag = body.diag as Record<string, unknown> | undefined;
  if (!diag || typeof diag !== 'object' || !isResetCode(diag.reset) || !isCount(diag.boot)) return undefined;
  return {
    reset: diag.reset,
    boot: diag.boot,
    ...(typeof diag.rssi === 'number' && Number.isInteger(diag.rssi) && diag.rssi < 0 && diag.rssi > -128 ? { rssi: diag.rssi } : {}),
    ...(isCount(diag.uptimeS) ? { uptimeS: diag.uptimeS } : {}),
  };
}

export async function noteBoilerControllerStart(rootId: string, body: Record<string, unknown>, now = new Date()) {
  const diag = parseBoilerControllerDiag(body);
  if (!diag) return;
  const start = `start nr ${diag.boot}`;
  if (await OperationLogModel.exists({ rootId, action: BOILER_RESTART_ACTION, conditions: { $regex: `^${start}(;|$)` } })) return;
  const conditions = [start];
  if (diag.rssi !== undefined) conditions.push(`sygnał Wi-Fi ${diag.rssi} dBm`);
  if (typeof body.version === 'string' && /^[\w.-]{1,20}$/.test(body.version)) conditions.push(`firmware ${body.version}`);
  // chwila startu: zgłoszenie bywa dużo później (słaby sygnał, ponowienia co 30 s)
  const at = diag.uptimeS !== undefined ? new Date(now.getTime() - diag.uptimeS * 1000) : now;
  await logOperation(rootId, {
    ...controllerMeta('Sterownik', `Przyczyna: ${resetReasonText(diag.reset)}.`), conditions: conditions.join('; '),
  }, BOILER_RESTART_ACTION, { at });
}
