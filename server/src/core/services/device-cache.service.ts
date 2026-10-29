// Dokumenty urządzeń w pamięci (2026-10-29, limit transferu Render 5 GB): sterowniki pytają co kilka sekund
// (pompa hp/add co 10–30 s, piec commands/next co 15 s, włącznik co 5 s), a każde zapytanie czytało dokument
// urządzenia z bazy 1–3 razy (kontekst urządzenia, oferta firmware, tryb i konfiguracja pompy). Pamięć kasuje
// każdy zapis do devices (haczyki modelu, device-cache-store.ts), a po DEVICE_CACHE_TTL_MS dokument jest czytany
// od nowa na wypadek zapisu z innej drogi. Zwracane dokumenty są wspólne: wywołujący ich nie zmieniają.
// Używane tylko do odczytu na ścieżkach sterowników; zapis i odczyt z aplikacji idą prosto do bazy.
import { DeviceModel } from '../models/device.model';
import { Device, DeviceType } from '../types';
import { bySn, byRoot, cacheGeneration, CacheEntry } from './device-cache-store';

export const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedDevice = Readonly<Device> & { _id: unknown };

async function cached(
  map: Map<string, CacheEntry<unknown>>, key: string, load: () => Promise<CachedDevice | null>, now: number,
): Promise<CachedDevice | null> {
  const entry = map.get(key) as CacheEntry<CachedDevice> | undefined;
  if (entry && now - entry.at < DEVICE_CACHE_TTL_MS) return entry.doc;
  const generation = cacheGeneration();
  const doc = await load();
  // zapis do devices w trakcie odczytu: nie zapamiętuj (mógł zmienić ten dokument)
  if (cacheGeneration() === generation) map.set(key, { at: now, doc });
  return doc;
}

// Urządzenie po Root ID; null, gdy nie ma. Nieprawidłowy Root ID rzuca CastError jak findById.
export const cachedDeviceById = (rootId: string, now = Date.now()) =>
  cached(byRoot, rootId, () => DeviceModel.findById(rootId).lean<CachedDevice>(), now);

// Urządzenie po SN i rodzaju (endpointy sterownika bez Root ID); null, gdy nie ma.
export const cachedDeviceBySn = (deviceId: string, deviceType: DeviceType, now = Date.now()) =>
  cached(bySn, `${deviceType}:${deviceId}`, () => DeviceModel.findOne({ deviceId, deviceType }).lean<CachedDevice>(), now);
