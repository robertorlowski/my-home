// Diagnostyka sterownika włącznika (firmware od 1.1.2, pole diag w POST /switch/state; 2026-10-14: płytka
// restartowała się przy włączaniu bojlera 1,5–2 kW; od 1.3.2 także pamięć sterty; wynik pobierania pogody był w 1.3.2–1.3.7,
// od 1.4.0 włącznik pogody nie pobiera i pole diag.weather jest pomijane). Każdy nowy start sterownika (inny numer startu) trafia do
// dziennika operacji z przyczyną (np. brownout = spadek napięcia zasilania) i z włączeniem przekaźnika tuż przed
// restartem, jeśli było. Ostatnia diagnostyka jest w pamięci (GET /switch/diagnostics). Po restarcie serwera
// pierwsze zgłoszenie jest punktem odniesienia: start zapisuje się tylko, gdy sterownik działa krócej niż
// FRESH_BOOT_S (inaczej start był dawno i mógł już trafić do dziennika).
import { controllerMeta, logOperation } from '../../../core/services/operation-log.service';
import { SwitchActivationModel } from '../models/switch-activation.model';
import { SwitchRelayModel } from '../models/switch-relay.model';

// heapFree, heapMin, heapBlock (od 1.3.2): pamięć sterty sterownika w bajtach. net (od 1.3.7): od startu nowe połączenia
// z serwerem (http) i ponowne łączenia z Wi-Fi (wifi) z braku odpowiedzi serwera (firmware net_recovery.hpp).
export type ControllerDiag = {
  reset: string; boot: number; wifiDrops?: number; rssi?: number; httpMs?: number;
  heapFree?: number; heapMin?: number; heapBlock?: number; net?: { http: number; wifi: number };
};

// nazwy jak esp_reset_reason w firmware (switch.cpp, resetReasonName)
const RESET_NAMES: Record<string, string> = {
  power_on: 'włączenie zasilania',
  ext: 'reset z pinu EN (zewnętrzny)',
  software: 'restart programowy (np. po aktualizacji)',
  panic: 'błąd programu (panic)',
  int_wdt: 'watchdog przerwań',
  task_wdt: 'watchdog zadań',
  wdt: 'watchdog',
  deepsleep: 'wybudzenie z uśpienia',
  brownout: 'spadek napięcia zasilania (brownout)',
  sdio: 'reset SDIO',
  no_cloud: 'restart po braku łączności z serwerem (sterownik, od 1.3.7)',
  unknown: 'nieznana',
};
export const resetReasonText = (reset: string) => RESET_NAMES[reset] ?? reset;

const FRESH_BOOT_S = 120;
// włączenie przekaźnika najwyżej tyle przed startem uznajemy za powiązane z restartem
const SWITCH_ON_WINDOW_S = 60;

type Saved = ControllerDiag & { at: Date; uptimeS?: number; bootAt?: Date };
const lastDiag = new Map<string, Saved>();

const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function parseNetDiag(input: unknown): { http: number; wifi: number } | undefined {
  const value = input as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object' || !isCount(value.http) || !isCount(value.wifi)) return undefined;
  return { http: value.http as number, wifi: value.wifi as number };
}

// Pole diag ze zgłoszenia; brak albo błędne = undefined (stan przekaźników jest przyjmowany i tak).
export function parseControllerDiag(body: unknown): ControllerDiag | undefined {
  const diag = ((body ?? {}) as { diag?: unknown }).diag as Record<string, unknown> | undefined;
  if (!diag || typeof diag !== 'object') return undefined;
  if (typeof diag.reset !== 'string' || !/^[a-z_]{1,20}$/.test(diag.reset) || !isCount(diag.boot)) return undefined;
  return {
    reset: diag.reset,
    boot: diag.boot as number,
    ...(isCount(diag.wifiDrops) ? { wifiDrops: diag.wifiDrops as number } : {}),
    ...(typeof diag.rssi === 'number' && Number.isFinite(diag.rssi) ? { rssi: diag.rssi } : {}),
    ...(isCount(diag.httpMs) ? { httpMs: diag.httpMs as number } : {}),
    ...(isCount(diag.heapFree) ? { heapFree: diag.heapFree as number } : {}),
    ...(isCount(diag.heapMin) ? { heapMin: diag.heapMin as number } : {}),
    ...(isCount(diag.heapBlock) ? { heapBlock: diag.heapBlock as number } : {}),
    ...(parseNetDiag(diag.net) ? { net: parseNetDiag(diag.net) } : {}),
  };
}

const label = (relay: { name?: string; relay: number }) => relay.name?.trim() || `Przekaźnik ${relay.relay}`;

// Naprawa łączności bez restartu (firmware 1.3.7): liczniki net wzrosły w tym samym starcie, więc sterownik odzyskał
// łączność nowym połączeniem albo ponownym łączeniem z Wi-Fi. Przerwa = czas od poprzedniego zgłoszenia.
async function noteNetRecovery(rootId: string, previous: Saved, diag: ControllerDiag, now: Date) {
  if (!previous.net || !diag.net) return;
  const http = diag.net.http - previous.net.http;
  const wifi = diag.net.wifi - previous.net.wifi;
  if (http <= 0 && wifi <= 0) return;
  const minutes = Math.round((now.getTime() - previous.at.getTime()) / 60000);
  const steps = [http > 0 ? `nowe połączenie z serwerem: ${http}` : '', wifi > 0 ? `ponowne łączenie z Wi-Fi: ${wifi}` : '']
    .filter(Boolean).join(', ');
  await logOperation(rootId, {
    ...controllerMeta('Sterownik', 'Brak odpowiedzi serwera, sterownik sam przywrócił łączność.'),
    conditions: `przerwa w zgłoszeniach: ${minutes} min; ${steps}`,
  }, 'Naprawa łączności', { at: now });
}

export async function noteControllerDiag(rootId: string, diag: ControllerDiag, uptimeS: number | undefined, now = new Date()) {
  const previous = lastDiag.get(rootId);
  const bootAt = uptimeS !== undefined ? new Date(now.getTime() - uptimeS * 1000) : undefined;
  lastDiag.set(rootId, { ...diag, at: now, uptimeS, bootAt });
  const newBoot = previous ? previous.boot !== diag.boot : uptimeS !== undefined && uptimeS < FRESH_BOOT_S;
  if (!newBoot) {
    if (previous) await noteNetRecovery(rootId, previous, diag, now);
    return;
  }

  // włączenie przekaźnika tuż przed startem: historia ma je z czasem ze sterownika (switch.service.ts)
  const at = bootAt ?? now;
  const switchedOn = await SwitchActivationModel.findOne({
    rootId, onAt: { $gte: new Date(at.getTime() - SWITCH_ON_WINDOW_S * 1000), $lte: at },
  }).sort({ onAt: -1 }).lean<{ relay: number; onAt: Date }>();
  let conditions = `start nr ${diag.boot}`;
  if (switchedOn) {
    const relay = await SwitchRelayModel.findOne({ rootId, relay: switchedOn.relay }).lean<{ name?: string; relay: number }>();
    const seconds = Math.max(0, Math.round((at.getTime() - new Date(switchedOn.onAt).getTime()) / 1000));
    conditions += `; ${seconds} s po włączeniu: ${label(relay ?? { relay: switchedOn.relay })}`;
  }
  if (previous && previous.wifiDrops) conditions += `; przed restartem zerwań Wi-Fi: ${previous.wifiDrops}`;
  await logOperation(rootId, { ...controllerMeta('Sterownik', `Przyczyna: ${resetReasonText(diag.reset)}.`), conditions },
    'Restart sterownika', { at });
}

export function getControllerDiag(rootId: string) {
  const saved = lastDiag.get(rootId);
  if (!saved) return {};
  return {
    ...saved,
    at: saved.at.toISOString(),
    bootAt: saved.bootAt?.toISOString() ?? null,
    resetText: resetReasonText(saved.reset),
  };
}
