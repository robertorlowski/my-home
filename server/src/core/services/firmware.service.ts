// Firmware sterowników (OTA): zapis obrazów w bazie, oferta dla sterowników i
// przycinanie starych wersji. W bazie jest oferowana wersja i jedna poprzednia
// (powrót bez ponownego wgrywania); starsze pliki są usuwane przy zmianie oferty.
// Oferta trafia do sterownika tylko na zlecenie z aplikacji (przycisk „Aktualizuj”).
// Kontrakt ze sterownikami: devices/<rodzaj>/src/ota.*.
import { createHash } from 'crypto';
import { FirmwareImageModel, FirmwareOfferModel } from '../models/firmware.model';
import { DeviceModel } from '../models/device.model';
import { cachedDeviceById } from './device-cache.service';
import { getDeviceTypeModule } from '../device-types';
import { DeviceType, OperationMeta } from '../types';
import { appUserMeta, logOperation, setStatusByRef } from './operation-log.service';

// Partycja aplikacji OTA ESP32 (0x140000); większy obraz się nie zmieści.
export const MAX_FIRMWARE_BYTES = 1310720;
// Pierwszy bajt obrazu aplikacji ESP32 (nagłówek esptool).
const ESP_IMAGE_MAGIC = 0xe9;
// Wersja trafia do adresu pliku, więc tylko znaki bezpieczne w ścieżce.
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
export const MAX_DESCRIPTION_LENGTH = 500;

export class FirmwareError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const isValidFirmwareVersion = (version: string) => VERSION_PATTERN.test(version);

// Zapisuje obraz (ta sama wersja zostaje nadpisana) i od razu ustawia go jako
// oferowany. Sumę SHA-256 liczy serwer, żeby nie trzeba było jej przepisywać.
export async function saveFirmwareImage(deviceType: DeviceType, version: string, data: Buffer, description = '') {
  if (!isValidFirmwareVersion(version)) {
    throw new FirmwareError(400, 'Wersja: 1–32 znaki (litery, cyfry, kropka, myślnik, podkreślenie).');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new FirmwareError(400, `Opis jest za długi: najwyżej ${MAX_DESCRIPTION_LENGTH} znaków.`);
  }
  if (data.length === 0 || data[0] !== ESP_IMAGE_MAGIC) {
    throw new FirmwareError(400, 'To nie jest obraz firmware ESP32 (oczekiwany plik .bin z pio run).');
  }
  if (data.length > MAX_FIRMWARE_BYTES) {
    throw new FirmwareError(400, `Plik jest za duży: ${data.length} B, limit ${MAX_FIRMWARE_BYTES} B.`);
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  await FirmwareImageModel.findOneAndUpdate(
    { deviceType, version },
    { $set: { data, size: data.length, sha256, description } },
    { upsert: true },
  );
  await activateFirmware(deviceType, version);
}

// Ustawia oferowaną wersję (istniejący plik). Dotychczasowa oferta staje się
// „poprzednią”, a pliki starsze niż te dwie są usuwane.
export async function activateFirmware(deviceType: DeviceType, version: string) {
  if (!(await FirmwareImageModel.exists({ deviceType, version }))) {
    throw new FirmwareError(404, `Brak pliku firmware w wersji ${version}.`);
  }
  const offer = await FirmwareOfferModel.findOne({ deviceType }).lean();
  const previousVersion = offer && offer.version !== version ? offer.version : offer?.previousVersion;
  await FirmwareOfferModel.findOneAndUpdate(
    { deviceType },
    { $set: { version, enabled: offer?.enabled ?? true, ...(previousVersion ? { previousVersion } : {}) } },
    { upsert: true },
  );
  await FirmwareImageModel.deleteMany({
    deviceType,
    version: { $nin: [version, ...(previousVersion ? [previousVersion] : [])] },
  });
}

// Usuwa plik wersji, która nie jest oferowana (oferowaną najpierw trzeba zastąpić inną).
export async function deleteFirmwareImage(deviceType: DeviceType, version: string) {
  const offer = await FirmwareOfferModel.findOne({ deviceType }).lean();
  if (offer?.version === version) {
    throw new FirmwareError(409, 'Nie można usunąć oferowanej wersji. Najpierw ustaw jako oferowaną inną.');
  }
  const result = await FirmwareImageModel.deleteOne({ deviceType, version });
  if (result.deletedCount === 0) throw new FirmwareError(404, `Brak pliku firmware w wersji ${version}.`);
  if (offer?.previousVersion === version) {
    await FirmwareOfferModel.updateOne({ deviceType }, { $unset: { previousVersion: 1 } });
  }
}

export async function setFirmwareEnabled(deviceType: DeviceType, enabled: boolean) {
  const result = await FirmwareOfferModel.updateOne({ deviceType }, { $set: { enabled } });
  if (result.matchedCount === 0) throw new FirmwareError(404, 'Nie wgrano jeszcze żadnego firmware.');
}

// Stan do strony /firmware: oferta i lista plików bez zawartości.
export async function getFirmwareSummary(deviceType: DeviceType) {
  const offer = await FirmwareOfferModel.findOne({ deviceType }).lean();
  const images = await FirmwareImageModel.find({ deviceType })
    .select('-data')
    .sort({ createdAt: -1 })
    .lean();
  return {
    enabled: offer?.enabled ?? false,
    version: offer?.version ?? null,
    previousVersion: offer?.previousVersion ?? null,
    images: images.map((image) => ({
      version: image.version,
      size: image.size,
      description: image.description ?? '',
      sha256: image.sha256,
      createdAt: (image as unknown as { createdAt: Date }).createdAt,
      active: image.version === offer?.version,
    })),
  };
}

export async function getFirmwareFile(deviceType: DeviceType, version: string) {
  return FirmwareImageModel.findOne({ deviceType, version }).lean();
}

// Oferowany obraz (bez treści) albo nic, gdy aktualizacje są wyłączone albo nie ma pliku.
async function offeredImage(deviceType: DeviceType) {
  const offer = await FirmwareOfferModel.findOne({ deviceType }).lean();
  if (!offer?.enabled) return undefined;
  return (await FirmwareImageModel.findOne({ deviceType, version: offer.version }).select('-data').lean()) ?? undefined;
}

// --- aktualizacja na żądanie (przycisk „Aktualizuj” w Ustawieniach sterownika) ---
// Sterownik nie aktualizuje się sam: oferta trafia do niego tylko wtedy, gdy przy urządzeniu jest
// zlecenie (devices.firmwareUpdate). Zlecenie znika, gdy sterownik zgłosi się z oferowaną wersją.

type FirmwareDevice = {
  _id: unknown;
  deviceType: DeviceType;
  firmwareVersion?: string;
  firmwareUpdate?: { version: string; requestedAt: Date } | null;
};

// Dziennik operacji: zlecenie „Aktualizuj” czeka (ref „firmware”), oferta w odpowiedzi sterownikowi = wysłana,
// zgłoszenie z oferowaną wersją = wykonana, odwołanie albo nowe zlecenie = zastąpiona.
const FIRMWARE_REF = 'firmware';

// POST /devices/:rootId/firmware-update: zlecenie aktualizacji do oferowanej wersji.
export async function requestFirmwareUpdate(rootId: string, meta: OperationMeta = appUserMeta()) {
  const device = await DeviceModel.findById(rootId).select('deviceType firmwareVersion').lean();
  if (!device) throw new FirmwareError(404, 'Nie znaleziono urządzenia.');
  if (!getDeviceTypeModule(device.deviceType).firmwareUpdates) {
    throw new FirmwareError(400, 'Ten rodzaj sterownika nie ma aktualizacji firmware.');
  }
  const image = await offeredImage(device.deviceType);
  if (!image) throw new FirmwareError(409, 'Brak oferowanej wersji albo aktualizacje są wyłączone.');
  if (device.firmwareVersion === image.version) throw new FirmwareError(409, 'Sterownik ma już tę wersję.');
  const firmwareUpdate = { version: image.version, requestedAt: new Date() };
  await DeviceModel.updateOne({ _id: rootId }, { $set: { firmwareUpdate } });
  await setStatusByRef(rootId, FIRMWARE_REF, ['pending', 'sent'], 'replaced');
  await logOperation(rootId, meta, `Aktualizacja firmware: ${device.firmwareVersion ?? '?'} → ${image.version}`,
    { status: 'pending', refs: [FIRMWARE_REF] });
  return firmwareUpdate;
}

// DELETE /devices/:rootId/firmware-update: odwołanie zlecenia (sterownik, który już pobiera, dokończy).
export async function cancelFirmwareUpdate(rootId: string, meta: OperationMeta = appUserMeta()) {
  const device = await DeviceModel.findById(rootId).select('firmwareUpdate').lean();
  const result = await DeviceModel.updateOne({ _id: rootId }, { $unset: { firmwareUpdate: 1 } });
  if (result.matchedCount === 0) throw new FirmwareError(404, 'Nie znaleziono urządzenia.');
  if (device?.firmwareUpdate) {
    await setStatusByRef(rootId, FIRMWARE_REF, ['pending', 'sent'], 'replaced');
    await logOperation(rootId, meta, `Anulowanie aktualizacji firmware do ${device.firmwareUpdate.version}`);
  }
}

// Oferta dla sterownika {version, url, sha256, request}, tylko przy zleceniu. request (czas zlecenia
// w ms) odróżnia kolejne kliknięcia „Aktualizuj”: sterownik próbuje raz na zlecenie (ota.hpp).
// Sterownik z oferowaną wersją kasuje zlecenie. baseUrl to adres serwera widziany przez sterownik.
export async function firmwareOfferForDevice(device: FirmwareDevice, baseUrl: string) {
  if (!device.firmwareUpdate || !getDeviceTypeModule(device.deviceType).firmwareUpdates) return undefined;
  const image = await offeredImage(device.deviceType);
  if (!image) return undefined;
  if (device.firmwareVersion === image.version) {
    await DeviceModel.updateOne({ _id: device._id }, { $unset: { firmwareUpdate: 1 } });
    await setStatusByRef(String(device._id), FIRMWARE_REF, ['pending', 'sent'], 'done');
    return undefined;
  }
  await setStatusByRef(String(device._id), FIRMWARE_REF, ['pending'], 'sent');
  return {
    version: image.version,
    url: `${baseUrl}/api/firmware/${device.deviceType}/${image.version}.bin`,
    sha256: image.sha256,
    request: String(new Date(device.firmwareUpdate.requestedAt).getTime()),
  };
}

// Oferta dla sterownika znanego tylko z rootId (odpowiedzi pompy, włącznika i pieca); dokument z pamięci
// (device-cache.service.ts), bo pytają co kilka sekund, a zlecenie „Aktualizuj” zapisuje devices i kasuje pamięć.
export async function firmwareOfferForRoot(rootId: string, baseUrl: string) {
  const device = await cachedDeviceById(rootId);
  return device ? firmwareOfferForDevice(device as FirmwareDevice, baseUrl) : undefined;
}
