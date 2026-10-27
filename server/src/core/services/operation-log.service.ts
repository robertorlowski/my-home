// Dziennik operacji (zakładka „Operacje”, od 2026-10-11): zapis operacji z kim, czym, dlaczego i warunkami,
// przepisywanie statusu zleceń sterownika (refs) i odczyt dnia: wykonane z kolekcji operation_log oraz — dla dnia
// dzisiejszego — zaplanowane: wpisy w toku i przejścia harmonogramu do końca doby (plannedOperations modułu rodzaju).
// Wywołania między modułami idą przez API (np. kocioł → pompa ciepła), więc kto i dlaczego jedzie w nagłówkach
// x-operation-* (operationHeaders / metaFromRequest); bez nich zmiana z API to „Użytkownik (aplikacja)”.
import { Request } from 'express';
import { formatInTimeZone } from 'date-fns-tz';
import { getDeviceTypeModule } from '../device-types';
import { OperationLogEntry, OperationLogModel } from '../models/operation-log.model';
import { DeviceProperties, OperationActor, OperationActorType, OperationMeta, OperationStatus, PlannedOperation, PropertyLabel } from '../types';
import { TIME_ZONE, warsawDayBoundsUTC } from '../time';
import { getDeviceInfo } from './device-info.service';
import { sendMessage } from '../websocket';

/** operacja z aplikacji przed kontami użytkowników (decyzja 2026-10-11) */
export const APP_USER: OperationActor = { type: 'user', name: 'Użytkownik (aplikacja)' };
export const appUserMeta = (source = 'Ustawienia', reason?: string): OperationMeta => ({ actor: APP_USER, source, ...(reason ? { reason } : {}) });
export const systemMeta = (source: string, reason?: string, conditions?: string): OperationMeta =>
  ({ actor: { type: 'system' }, source, ...(reason ? { reason } : {}), ...(conditions ? { conditions } : {}) });
/** zmiana na stronie sterownika (sieć lokalna albo jego punkt dostępowy) */
export const controllerMeta = (source = 'Strona sterownika', reason?: string): OperationMeta =>
  ({ actor: { type: 'controller', name: 'Sterownik' }, source, ...(reason ? { reason } : {}) });

// Nagłówki z opisem operacji dla wywołań API między modułami (wartości zakodowane, bo nagłówki HTTP są ASCII).
const HEADER = { actor: 'x-operation-actor', source: 'x-operation-source', reason: 'x-operation-reason', conditions: 'x-operation-conditions' };
export function operationHeaders(meta: OperationMeta): Record<string, string> {
  return {
    [HEADER.actor]: meta.actor.type,
    [HEADER.source]: encodeURIComponent(meta.source),
    ...(meta.reason ? { [HEADER.reason]: encodeURIComponent(meta.reason) } : {}),
    ...(meta.conditions ? { [HEADER.conditions]: encodeURIComponent(meta.conditions) } : {}),
  };
}
/** kto i dlaczego z nagłówków x-operation-* (wywołanie z innego modułu), inaczej fallback (zwykle aplikacja) */
export function metaFromRequest(req: Request, fallback: OperationMeta): OperationMeta {
  const header = (name: string) => {
    const value = req.get(name);
    if (!value) return undefined;
    try { return decodeURIComponent(value).slice(0, 300); } catch { return undefined; }
  };
  const source = header(HEADER.source);
  if (!source) return fallback;
  const type = req.get(HEADER.actor) as OperationActorType | undefined;
  const actor: OperationActor = type === 'user' ? APP_USER : type === 'controller' ? { type, name: 'Sterownik' } : { type: 'system' };
  const reason = header(HEADER.reason);
  const conditions = header(HEADER.conditions);
  return { actor, source, ...(reason ? { reason } : {}), ...(conditions ? { conditions } : {}) };
}

export async function logOperation(rootId: string, meta: OperationMeta, action: string, options: {
  status?: OperationStatus; refs?: string[]; at?: Date; statusAt?: Date | null;
} = {}) {
  const status = options.status ?? 'done';
  const at = options.at ?? new Date();
  const entry = await OperationLogModel.create({
    rootId, at, actor: meta.actor, source: meta.source, action, status,
    statusAt: options.statusAt ?? (status === 'done' ? at : null),
    reason: meta.reason ?? null, conditions: meta.conditions ?? null,
    ...(options.refs?.length ? { refs: options.refs } : {}),
  });
  sendMessage('update', rootId);
  return entry.toObject();
}

// Status operacji ze statusów jej zleceń: błąd, gdy któreś się nie udało; zastąpiona, gdy wszystkie zastąpione;
// wykonana, gdy reszta wykonana; inaczej najwcześniejszy etap (czeka / wysłana).
export function aggregateStatus(statuses: OperationStatus[]): OperationStatus {
  if (statuses.includes('error')) return 'error';
  const live = statuses.filter((status) => status !== 'replaced');
  if (live.length === 0) return 'replaced';
  if (live.every((status) => status === 'done')) return 'done';
  if (live.includes('pending')) return 'pending';
  if (live.includes('sent')) return 'sent';
  return 'delivered';
}

/**
 * Przepisanie statusu operacji, w których są zlecenia ids. commandsOf zwraca aktualne zlecenia (status, kiedy, błąd)
 * danej operacji — moduł rodzaju wie, gdzie je trzyma.
 */
export async function syncOperations(
  ids: string[],
  commandsOf: (refs: string[]) => Promise<{ status: OperationStatus; doneAt?: Date | null; error?: string | null }[]>,
) {
  if (!ids.length) return;
  const entries = await OperationLogModel.find({ refs: { $in: ids } }).lean<OperationLogEntry[]>();
  for (const entry of entries) {
    const commands = await commandsOf(entry.refs ?? []);
    if (!commands.length) continue;
    const status = aggregateStatus(commands.map((command) => command.status));
    const times = commands.map((command) => command.doneAt).filter((time): time is Date => !!time).map((time) => new Date(time).getTime());
    const error = commands.map((command) => command.error).find(Boolean) ?? null;
    if (status === entry.status && (error ?? null) === (entry.error ?? null)) continue;
    await OperationLogModel.updateOne({ _id: entry._id }, {
      $set: { status, error, statusAt: ['done', 'error', 'replaced'].includes(status) && times.length ? new Date(Math.max(...times)) : null },
    });
    sendMessage('update', entry.rootId);
  }
}

/**
 * Status operacji po odniesieniu ref (np. „firmware”, „relay:1”, „hp-operation”): wpisy rootId z tym ref
 * i statusem z from dostają status (i czas). Zwraca liczbę zmienionych.
 */
export async function setStatusByRef(
  rootId: string, ref: string, from: OperationStatus[], status: OperationStatus, at = new Date(), error?: string,
) {
  const result = await OperationLogModel.updateMany(
    { rootId, refs: ref, status: { $in: from } },
    { $set: { status, statusAt: at, ...(error ? { error } : {}) } },
  );
  if (result.modifiedCount > 0) sendMessage('update', rootId);
  return result.modifiedCount;
}

// wartość ustawienia do dziennika: tłumaczenie z values albo liczba z jednostką; brak = „—”
const propertyValue = (label: PropertyLabel, value: unknown) => {
  if (value === undefined || value === null || value === '') return '—';
  const text = String(value);
  return label.values?.[text] ?? (label.unit ? `${text} ${label.unit}` : text);
};

/**
 * Zapis ustawień urządzenia w dzienniku: tylko klucze z propertyLabels rodzaju, które się zmieniły
 * („Czas kompresora: 30 → 45 s”). Bez zmian nic nie zapisuje. options.pending: sterownik dostaje ustawienia
 * dopiero przy zgłoszeniu (status „czeka”, ref „properties”).
 */
export async function logPropertiesChange(
  rootId: string, labels: Record<string, PropertyLabel> | undefined, before: DeviceProperties, after: DeviceProperties,
  meta: OperationMeta, options: { pending?: boolean } = {},
) {
  const value = (properties: DeviceProperties, key: string) => (properties as Record<string, unknown>)[key];
  const changes = Object.entries(labels ?? {})
    .filter(([key]) => String(value(before, key) ?? '') !== String(value(after, key) ?? ''))
    .map(([key, label]) => `${label.label}: ${propertyValue(label, value(before, key))} → ${propertyValue(label, value(after, key))}`);
  if (!changes.length) return null;
  if (options.pending) await setStatusByRef(rootId, 'properties', ['pending'], 'replaced');
  return logOperation(rootId, meta, changes.join(' · '), options.pending ? { status: 'pending', refs: ['properties'] } : {});
}

// w toku: czeka albo wysłane; „dostarczona” jest końcowa (sterownik nie potwierdza wykonania)
const IN_PROGRESS: OperationStatus[] = ['pending', 'sent'];

/**
 * Dzień dziennika (doba warszawska): zaplanowane (tylko dziś: w toku i przejścia harmonogramu do końca doby)
 * i pozostałe wpisy dnia, najnowsze u góry.
 */
export async function getOperationsDay(rootId: string, date: string, now = new Date()) {
  const { startUTC, endUTC } = warsawDayBoundsUTC(date);
  const entries = await OperationLogModel.find({ rootId, at: { $gte: startUTC, $lt: endUTC } }).sort({ at: -1 }).lean<OperationLogEntry[]>();
  const today = formatInTimeZone(now, TIME_ZONE, 'yyyy-MM-dd') === date;
  const inProgress = entries.filter((entry) => IN_PROGRESS.includes(entry.status));
  let planned: PlannedOperation[] = [];
  if (today) {
    const { deviceType } = await getDeviceInfo(rootId);
    planned = (await getDeviceTypeModule(deviceType).plannedOperations?.(rootId, now, endUTC).catch(() => [])) ?? [];
  }
  return {
    date,
    today,
    planned: [
      ...[...inProgress].reverse().map((entry) => ({ ...publicEntry(entry), planned: false })),
      ...planned.map((operation) => ({ ...operation, status: 'planned' as const, planned: true })),
    ],
    done: entries.filter((entry) => !IN_PROGRESS.includes(entry.status)).map(publicEntry),
  };
}

const publicEntry = (entry: OperationLogEntry) => ({
  id: String(entry._id),
  at: entry.at,
  actor: entry.actor,
  source: entry.source,
  action: entry.action,
  status: entry.status,
  statusAt: entry.statusAt ?? null,
  error: entry.error ?? null,
  reason: entry.reason ?? null,
  conditions: entry.conditions ?? null,
});
