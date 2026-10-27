// Dziennik operacji pompy ciepła (zakładka „Operacje”): zapisywane są tylko zmiany tego, co dostaje sterownik co
// (decyzja użytkownika 2026-10-11), nie każde przekazanie operacji. Po każdej zmianie w operation.service
// (scheduler, Ustawienia, ładowanie CWU w kotle, wymuszenie) wołający podaje kto i dlaczego (noteOperationChange);
// różnica względem ostatnio zapisanej operacji idzie do dziennika jako „czeka”, a odpowiedź /hp/add, która ją
// niesie, zmienia status na „dostarczona” (co nie potwierdza wykonania; skutek widać w telemetrii).
import { logOperation, setStatusByRef } from '../../../core/services/operation-log.service';
import { OperationMeta, PlannedOperation } from '../../../core/types';
import { OperationEntry } from '../types';
import { getEffectiveOperation, hasScheduledOperation } from './operation.service';

export const HP_OPERATION_REF = 'hp-operation';

// tryb co (kontrakt operacji) → tekst
const WORK_MODE: Record<string, string> = {
  M: 'praca (CO)', A: 'praca (CO, harmonogram)', CWU: 'praca (CWU)', OFF: 'wyłączona', PV: 'praca (PV)',
};
const onOff = (on: string, off: string) => (value: string) => (value === '1' ? on : off);
const FIELDS: { key: keyof OperationEntry | string; label: string; text: (value: string) => string }[] = [
  { key: 'work_mode', label: 'Pompa', text: (value) => WORK_MODE[value] ?? value },
  { key: 'force', label: 'Wymuszenie startu', text: onOff('tak', 'nie') },
  { key: 'co_pomp', label: 'Pompy CO/CWU', text: onOff('włączone', 'wyłączone') },
  { key: 'hot_pomp', label: 'Pompa strony gorącej', text: onOff('wymuszona', 'automatycznie') },
  { key: 'cold_pomp', label: 'Pompa strony zimnej', text: onOff('wymuszona', 'automatycznie') },
  { key: 'sump_heater', label: 'Grzałka karteru', text: onOff('wymuszona', 'automatycznie') },
  { key: 'working_watt', label: 'Limit mocy', text: (value) => `${value} W` },
  { key: 'eev_max_pulse_open', label: 'EEV max', text: (value) => value },
  { key: 'eev_min_pulse_open', label: 'EEV min', text: (value) => value },
  { key: 'eev_setpoint', label: 'Przegrzanie EEV', text: (value) => `${value} °C` },
];

const field = (operation: OperationEntry, key: string) => {
  const value = (operation as Record<string, unknown>)[key];
  return value === undefined || value === null ? undefined : String(value);
};
// temperatura od–do: obie pary co_* i cwu_* mają te same wartości (pump-mode.service.ts); CWU, a bez niej CO
const range = (operation: OperationEntry) => ({
  min: field(operation, 'cwu_min') ?? field(operation, 'co_min'),
  max: field(operation, 'cwu_max') ?? field(operation, 'co_max'),
});

/**
 * Opis zmiany operacji: pola, które w after mają wartość inną niż w before („Pompa: wyłączona → praca (CWU) ·
 * Temperatura od–do: 35–47 → 40–45 °C”). Brak pola w after = bez zmiany (co trzyma ostatnią przysłaną wartość).
 */
export function describeOperationChange(before: OperationEntry, after: OperationEntry): string[] {
  const changes: string[] = [];
  for (const { key, label, text } of FIELDS) {
    const next = field(after, key);
    const previous = field(before, key);
    if (next === undefined || next === previous) continue;
    changes.push(previous === undefined ? `${label}: ${text(next)}` : `${label}: ${text(previous)} → ${text(next)}`);
  }
  const was = range(before);
  const now = range(after);
  const min = now.min ?? was.min;
  const max = now.max ?? was.max;
  if ((now.min !== undefined && now.min !== was.min) || (now.max !== undefined && now.max !== was.max)) {
    const pair = (from?: string, to?: string) => `${from ?? '?'}–${to ?? '?'}`;
    changes.push(was.min === undefined && was.max === undefined
      ? `Temperatura od–do: ${pair(min, max)} °C`
      : `Temperatura od–do: ${pair(was.min, was.max)} → ${pair(min, max)} °C`);
  }
  return changes;
}

// ostatnio zapisana operacja (stan, który ma co), tylko w pamięci: po restarcie serwera pierwsza operacja
// (pierwszy przebieg schedulera) jest punktem odniesienia, bez wpisu
const lastLogged = new Map<string, OperationEntry>();
// wpisy „czeka” do oznaczenia przy najbliższym /hp/add (bez zapytania do bazy przy każdej telemetrii)
const awaitingDelivery = new Set<string>();

const withDefined = (base: OperationEntry, next: OperationEntry): OperationEntry => ({
  ...base,
  ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== null)),
});

/** po zmianie w operation.service: wpis, gdy operacja dla co się zmieniła */
export async function noteOperationChange(rootId: string, meta: OperationMeta) {
  // przed pierwszym przebiegiem schedulera operacja jest niepełna: punkt odniesienia ustawia scheduler
  if (!hasScheduledOperation(rootId)) return null;
  const current = getEffectiveOperation(rootId);
  const before = lastLogged.get(rootId);
  lastLogged.set(rootId, withDefined(before ?? {}, current));
  if (!before) return null;
  const changes = describeOperationChange(before, current);
  if (!changes.length) return null;
  awaitingDelivery.add(rootId);
  return logOperation(rootId, meta, changes.join(' · '), { status: 'pending', refs: [HP_OPERATION_REF] });
}

const ACTION_TEXT: Record<string, string> = {
  error_reset: 'Odblokowanie sterownika (po 5 błędach)',
  restart: 'Restart sterownika pompy (CHPC)',
};
/** akcja jednorazowa (Odblokuj, Restart): czeka do najbliższego /hp/add */
export async function noteOperationAction(rootId: string, action: string, meta: OperationMeta) {
  awaitingDelivery.add(rootId);
  return logOperation(rootId, meta, ACTION_TEXT[action] ?? action, { status: 'pending', refs: [HP_OPERATION_REF] });
}

/** /hp/add: odpowiedź niesie bieżącą operację, więc czekające wpisy są dostarczone */
export async function markOperationsDelivered(rootId: string, at = new Date()) {
  if (!awaitingDelivery.has(rootId)) return;
  awaitingDelivery.delete(rootId);
  await setStatusByRef(rootId, HP_OPERATION_REF, ['pending'], 'delivered', at);
}

/** zaplanowana zmiana operacji (przejścia harmonogramu, scheduler.service.ts) jako wpis dziennika */
export const plannedOperation = (at: Date, before: OperationEntry, after: OperationEntry, reason: string, conditions?: string): PlannedOperation | null => {
  const changes = describeOperationChange(before, after);
  return changes.length
    ? { at, actor: { type: 'system' }, source: 'Harmonogram', action: changes.join(' · '), reason, ...(conditions ? { conditions } : {}) }
    : null;
};
