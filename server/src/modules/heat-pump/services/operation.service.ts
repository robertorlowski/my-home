
// Operacje dla sterownika co, tylko w pamięci procesu (restart serwera je kasuje).
// Scheduler ustawia operację wyliczoną (replaceOperationData), użytkownik — ręczne
// nadpisania (setManualOperationData), a /hp/add odbiera bieżącą i ją czyści.
// Ręczne pola wygrywają: { ...scheduled, ...manual }. Nad nimi jest jeszcze nadpisanie na czas ładowania
// CWU w kotle (services/cwu-loading.service.ts): { ...scheduled, ...manual, ...cwuLoading }.
// Moduł kotła (modules/pellet-boiler-pelux200) nie importuje tego kodu — steruje pompą przez API serwera
// jak aplikacja, z nagłówkami x-operation-* (kto i dlaczego, do dziennika operacji):
//   - PUT /hp/cwu-loading: ładowanie CWU w kotle (47–49 °C) i wstrzymanie pompy przy CWU z peletu (OFF),
//   - POST /operation/set {force: "1"}: cykl Zimy w trybie „Pompa ciepła” (kocioł na Lecie czeka, aż pompa
//     nagrzeje wodę do Tmax − 3 °C; pellet-boiler-pelux200-winter-cycle.service.ts) — zwykłe ręczne force,
//     zdejmowane przy starcie sprężarki (consumeManualForceOnStart).
import { OperationEntry  } from '../types';

// operacja do wysłania w najbliższej odpowiedzi /hp/add
const operations = new Map<string, OperationEntry>();
// ostatnia operacja wyliczona przez scheduler
const scheduledOperations = new Map<string, OperationEntry>();
// ręczne nadpisania z /operation/set (tylko przekazane pola)
const manualOperations = new Map<string, OperationEntry>();
// nadpisanie na czas ładowania CWU w kotle (temperatury 47–49 °C) albo wstrzymanie pompy na czas CWU z peletu
// (work_mode OFF), ustawiane przez cwu-loading.service.ts
const cwuLoadingOperations = new Map<string, OperationEntry>();
// Ręczne force: czy od jego ustawienia telemetria pokazała sprężarkę w spoczynku.
const manualForceSeenIdle = new Map<string, boolean>();
// Jawne "0" dla ręcznie włączonych wymuszeń pomp i grzałki po skasowaniu ręcznych nadpisań
// (clearManualOperation). co trzyma ostatnią przysłaną wartość, więc samo usunięcie klucza
// zostawiało pompę wymuszoną bez końca. Do pierwszej odpowiedzi /hp/add (clearOperation).
const releasedOperations = new Map<string, OperationEntry>();
const RELEASED_ON_CLEAR = ['hot_pomp', 'cold_pomp', 'sump_heater'] as const;

const mergeWithManualOperation = (rootId: string, operation: OperationEntry) => ({
  ...operation,
  ...(releasedOperations.get(rootId) ?? {}),
  ...(manualOperations.get(rootId) ?? {}),
  ...(cwuLoadingOperations.get(rootId) ?? {}),
});

// Ładowanie CWU w kotle: nadpisanie temperatur nad harmonogramem i ręcznymi polami albo jego zdjęcie
// (undefined). Bieżąca operacja od razu dostaje nowy stan; bez wyliczonej operacji czeka na scheduler.
export const setCwuLoadingOperation = (rootId: string, data: OperationEntry | undefined) => {
  if (data) cwuLoadingOperations.set(rootId, data);
  else cwuLoadingOperations.delete(rootId);
  const base = scheduledOperations.get(rootId);
  if (base) operations.set(rootId, mergeWithManualOperation(rootId, base));
  else if (data) operations.set(rootId, { ...getOperationData(rootId), ...data });
};

// Operacja, którą co dostaje teraz (harmonogram, jawne zera, ręczne pola, ładowanie CWU); dziennik operacji
// porównuje ją z poprzednią (hp-operation-log.service.ts).
export const getEffectiveOperation = (rootId: string): OperationEntry =>
  mergeWithManualOperation(rootId, scheduledOperations.get(rootId) ?? {});

// scheduler policzył już operację (po restarcie serwera: od pierwszego przebiegu)
export const hasScheduledOperation = (rootId: string) => scheduledOperations.has(rootId);

// Tryb pracy, który pompa dostaje teraz (harmonogram z ręcznymi polami); OFF = pompa wyłączona.
export const getEffectiveWorkMode = (rootId: string) =>
  ({ ...(scheduledOperations.get(rootId) ?? {}), ...(manualOperations.get(rootId) ?? {}) }).work_mode;

export const getOperationData = (rootId: string) => {
  return operations.get(rootId) ?? {};
}

// Po obsłużeniu /hp/add. Przy ręcznych nadpisaniach operacja od razu wraca (każda
// odpowiedź niesie pełny stan z nadpisaniem); bez nich jest pusta do przebiegu schedulera.
export const clearOperation = (rootId: string) => {
  operations.delete(rootId);
  // jawne "0" po skasowaniu ręcznych wymuszeń poszło w tej odpowiedzi
  releasedOperations.delete(rootId);

  const manualOperation = manualOperations.get(rootId);
  const loading = cwuLoadingOperations.get(rootId);
  if (manualOperation || loading) {
    operations.set(
      rootId,
      mergeWithManualOperation(rootId, scheduledOperations.get(rootId) ?? manualOperation ?? {}),
    );
  }

  return;
}

// Wołane przez scheduler co minutę: nowa operacja wyliczona, z nałożonymi ręcznymi polami.
export const replaceOperationData = (rootId: string, data: OperationEntry) => {
  scheduledOperations.set(rootId, { ...data });
  const operation = mergeWithManualOperation(rootId, data);
  operations.set(rootId, operation);
  return operation;
};

// Doklejenie pól do bieżącej operacji (co_pomp "1" po zapisie ustawień domyślnych, device-type.ts).
export const setOperationData = (rootId: string, data :OperationEntry) => {
  const operation = { ...getOperationData(rootId), ...data };
  operations.set(rootId, operation);
  return operation;
}

export const getManualOperationData = (rootId: string) => {
  return manualOperations.get(rootId) ?? {};
};

// Zmiana trybu pracy bez co_pomp przywraca pompy CO/CWU ("1"). Samo usunięcie klucza
// nie wystarczy: co trzyma ostatnią przysłaną wartość, więc ręczne "0" wyłączałoby
// przekaźniki także po zmianie trybu i restarcie sterownika, aż do ręcznego "1".
export const setManualOperationData = (rootId: string, data: OperationEntry) => {
  const manualOperation = {
    ...getManualOperationData(rootId),
    ...(data.work_mode !== undefined ? { co_pomp: '1' } : {}),
    ...data,
  };

  manualOperations.set(rootId, manualOperation);
  // nowe force: zdjęcie po starcie wymaga najpierw odczytu w spoczynku
  // (force ustawione w trakcie pracy czeka na postój i kolejny start)
  if (data.force !== undefined) manualForceSeenIdle.set(rootId, false);
  const operation = mergeWithManualOperation(
    rootId,
    scheduledOperations.get(rootId) ?? getOperationData(rootId),
  );
  operations.set(rootId, operation);
  return manualOperation;
};

// Ręczne force: "1" jest jednorazowe. Znika z ręcznych nadpisań przy pierwszym starcie
// sprężarki (HPS: spoczynek -> praca) po jego ustawieniu; wraca force z harmonogramu
// (forceStart na czas wpisu) albo domyślne "0". Bez tego co wymuszał start po każdym
// zatrzymaniu, bo CHPC kasuje force przy stopie, a serwer wciąż przysyłał "1".
// Wywoływane po clearOperation, więc ustawiona tu operacja idzie w następnej odpowiedzi.
export const consumeManualForceOnStart = (rootId: string, running: boolean) => {
  const manualOperation = manualOperations.get(rootId);
  if (manualOperation?.force !== '1') return false;
  if (!running) {
    manualForceSeenIdle.set(rootId, true);
    return false;
  }
  if (!manualForceSeenIdle.get(rootId)) return false;

  manualForceSeenIdle.delete(rootId);
  const { force: _force, ...rest } = manualOperation;
  if (Object.keys(rest).length > 0) {
    manualOperations.set(rootId, rest);
  } else {
    manualOperations.delete(rootId);
  }
  // jawne force: co trzyma ostatnią przysłaną wartość, więc samo usunięcie klucza nie wystarczy
  // (bez przebiegu schedulera bieżąca operacja wciąż zawiera ręczne "1")
  const scheduled = scheduledOperations.get(rootId);
  const base = scheduled ? { force: '0', ...scheduled } : { ...getOperationData(rootId), force: '0' };
  operations.set(rootId, mergeWithManualOperation(rootId, base));
  return true;
};

// Akcje jednorazowe dla sterownika: nie są scalane z operacją ręczną ani harmonogramem,
// trafiają do jednej odpowiedzi na /hp/add i znikają.
export type OperationAction = 'error_reset' | 'restart';
export const OPERATION_ACTIONS: OperationAction[] = ['error_reset', 'restart'];
const pendingActions = new Map<string, OperationEntry>();

export const addOperationAction = (rootId: string, action: OperationAction) => {
  const actions = { ...(pendingActions.get(rootId) ?? {}), [action]: '1' };
  pendingActions.set(rootId, actions);
  return actions;
};

export const takeOperationActions = (rootId: string): OperationEntry => {
  const actions = pendingActions.get(rootId) ?? {};
  pendingActions.delete(rootId);
  return actions;
};

// Usuwa ręczne nadpisania; scheduler woła to przy przejściu z aktywnego harmonogramu
// do braku harmonogramu, a zapis ustawień domyślnych przez onPropertiesSaved (device-type.ts).
// Ręcznie włączone hot_pomp, cold_pomp i sump_heater dostają jawne "0" (releasedOperations).
export const clearManualOperation = (rootId: string) => {
  const manualOperation = manualOperations.get(rootId) ?? {};
  manualOperations.delete(rootId);
  manualForceSeenIdle.delete(rootId);

  const released: OperationEntry = { ...(releasedOperations.get(rootId) ?? {}) };
  for (const key of RELEASED_ON_CLEAR) {
    if (manualOperation[key] === '1') released[key] = '0';
  }
  if (Object.keys(released).length > 0) releasedOperations.set(rootId, released);

  const scheduledOperation = scheduledOperations.get(rootId);
  if (scheduledOperation) {
    operations.set(rootId, mergeWithManualOperation(rootId, scheduledOperation));
  } else if (Object.keys(released).length > 0) {
    operations.set(rootId, mergeWithManualOperation(rootId, {}));
  } else {
    operations.delete(rootId);
  }
};


