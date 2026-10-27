// Operacje pompy (/operation...): formularz Ustawień w kliencie, ręczne nadpisania
// (/operation/set) i akcje jednorazowe (/operation/action). Stan operacji jest
// tylko w pamięci (services/operation.service.ts); do sterownika trafia przez /hp/add.
import { Request, Response } from 'express'
import { addOperationAction, OPERATION_ACTIONS, OperationAction, setManualOperationData } from '../services/operation.service';
import { OperationEntry, PumpWorkMode } from '../types';
import { getHpLastData } from '../services/hp.service';
import { PUMP_WORK_MODES, pumpWorkMode, temperatureError, temperatureFields } from '../services/pump-mode.service';
import { sendMessage } from '../../../core/websocket';
import { DeviceModel } from '../../../core/models/device.model';
import { getDeviceProperties } from '../../../core/services/device.service';
import { heatPumpDeviceType } from '../device-type';
import { appUserMeta, logPropertiesChange, metaFromRequest } from '../../../core/services/operation-log.service';
import { noteOperationAction, noteOperationChange } from '../services/hp-operation-log.service';


const optionalText = (value: unknown) => value === undefined || value === null ? undefined : String(value);

// GET /operation: wartości początkowe formularza Ustawień. Tryb pracy z ustawień urządzenia
// (ręczny / automatyczny / OFF), reszta z ostatniej telemetrii, czyli rzeczywisty stan pompy:
// temperatura od–do to Tmin/Tmax z CHPC (bez nich para z trybu, który co zgłosił). Bez telemetrii
// pól temperatur, EEV i mocy nie ma (formularz pokazuje puste).
export async function prepareOperation(req: Request, res: Response) {
  try {
    const rootId = req.deviceRootId as string;
    const data = await getHpLastData(rootId);
    const properties = await getDeviceProperties(rootId);
    const cwu = data?.work_mode === 'CWU';
    const op: OperationEntry = {};
    op.work_mode = pumpWorkMode(properties.work_mode);
    op.temp_min = optionalText(data?.HP?.Tmin) ?? optionalText(data?.temp_min)
      ?? optionalText(cwu ? data?.cwu_min : data?.co_min);
    op.temp_max = optionalText(data?.HP?.Tmax) ?? optionalText(data?.temp_max)
      ?? optionalText(cwu ? data?.cwu_max : data?.co_max);
    // HP.F: wymuszenie w CHPC, trwa od ustawienia do zatrzymania sprężarki
    op.force = data.HP?.F ? "1" :"0";
    // rzeczywisty stan pomp: praca automatyczna, włączenie komendą albo ochrona przed mrozem
    op.cold_pomp = data?.HP?.CCS ? "1" : "0";
    op.hot_pomp = data?.HP?.HCS ? "1" : "0";
    // grzałka karteru: automatycznie (Tsump < 5 °C przy zgodzie na pracę) albo wymuszona komendą
    op.sump_heater = data?.HP?.SHS ? "1" : "0";
    op.eev_max_pulse_open = optionalText(data?.HP?.EEVmax);
    op.eev_min_pulse_open = optionalText(data?.HP?.EEVmin);
    op.working_watt = optionalText(data?.HP?.WWatt);
    // HP.EEV to zadane przegrzanie EEV (komenda 0x08), stąd eev_setpoint
    op.eev_setpoint = optionalText(data?.HP?.EEV);

    return res.status(200).send(op);
  } catch (error) {
    return res.status(500).send({ error: error })
  }
}

// POST /operation/set: przycisk „Zmień” w Ustawieniach.
// - work_mode (MANUAL, AUTO, OFF) to tryb pracy urządzenia: zapis w properties, jak w Harmonogramie
//   (ręczne nadpisania znikają, scheduler liczy operację od razu, onPropertiesSaved);
// - temp_min / temp_max (1–50 °C, od ≤ do) to ręczne nadpisanie obu par co_* i cwu_* (kontrakt co);
// - pozostałe pola (force, pompy, EEV, moc) idą jako ręczne nadpisanie bez zmian. Zakresy EEV i mocy
//   przycina dopiero co i CHPC.
// WebSocket „operation” budzi co, więc zmiana dochodzi do pompy w kilka sekund.
export const setOperation = async (req: Request<{}, {}, OperationEntry>, res: Response) => {
  const rootId = req.deviceRootId as string;
  const { work_mode, temp_min, temp_max, ...rest } = req.body ?? {};

  if (work_mode !== undefined && !PUMP_WORK_MODES.includes(work_mode as PumpWorkMode)) {
    return res.status(400).json({ message: `Nieznany tryb pracy: ${work_mode}` });
  }
  const error = temperatureError(temp_min, temp_max);
  if (error) return res.status(400).json({ message: error });

  try {
    // kto: aplikacja albo moduł kotła przez API (nagłówki x-operation-*, np. wymuszenie z cyklu Zimy)
    const meta = metaFromRequest(req, appUserMeta('Ustawienia', 'Przycisk „Zmień” w Ustawieniach.'));
    if (work_mode !== undefined) {
      const before = await getDeviceProperties(rootId);
      await DeviceModel.updateOne({ _id: rootId }, { $set: { 'properties.work_mode': work_mode } });
      await logPropertiesChange(rootId, heatPumpDeviceType.propertyLabels, before, { ...before, work_mode: work_mode as PumpWorkMode }, meta);
      await heatPumpDeviceType.onPropertiesSaved?.(rootId, meta);
    }
    const manual: OperationEntry = {
      ...rest,
      ...temperatureFields(optionalText(temp_min), optionalText(temp_max)),
    };
    if (Object.keys(manual).length > 0) {
      setManualOperationData(rootId, manual);
      await noteOperationChange(rootId, meta);
    }
    sendMessage('operation', rootId);
    return res.status(201).json({ message: req.body });
  } catch (error) {
    return res.status(400).json({ message: String(error) });
  }
}

// POST /api/operation/action { action: 'error_reset' | 'restart' }
// Akcja trafia do sterownika raz, przy najbliższym /hp/add. Komunikat WebSocket
// "operation" budzi sterownik, żeby wysłał telemetrię od razu, a nie po 10-30 s.
export const setOperationAction = async (req: Request<{}, {}, { action?: string }>, res: Response) => {
  const action = req.body?.action as OperationAction;
  if (!OPERATION_ACTIONS.includes(action)) {
    return res.status(400).json({ message: `Nieznana akcja: ${req.body?.action}` });
  }

  const rootId = req.deviceRootId as string;
  addOperationAction(rootId, action);
  await noteOperationAction(rootId, action, metaFromRequest(req, appUserMeta('Ustawienia',
    action === 'error_reset' ? 'Przycisk „Odblokuj” (sterownik zablokowany po 5 błędach).' : 'Przycisk „Restart sterownika”.')));
  sendMessage('operation', rootId);
  return res.status(201).json({ action });
}
