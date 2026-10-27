// Endpointy urządzeń wspólne dla wszystkich rodzajów: lista i wybór w kliencie
// (/devices), zgłoszenie sterownika (/devices/register), nazwa, sterownik domyślny
// i ustawienia (/device/properties). Logika w services/device.service.ts.
// Konta użytkowników (2026-10-11): lista, kafelki, sterownik domyślny i kolejność według zalogowanego (req.user);
// nazwę, aktualizację firmware i udostępnienia zmienia tylko właściciel albo użytkownik systemowy. Bez req.user
// (AUTH_DISABLED=1, testy starszych modułów) zachowanie jak przed kontami.
import { Request, Response } from 'express';
import { DefinitionConflictError, DeviceProperties, DeviceType } from '../types';
import { DeviceDocument } from '../models/device.model';
import {
  createDevice, getDeviceProperties, listDevices, parseBoilerConfig, parsePumpConfig, registerDevice, setDevicesOrder,
  updateDeviceData, updateDeviceProperties,
} from '../services/device.service'
import { mailConfigFor, mailKeyInfo, recordMailKey } from '../services/mail-relay.service';
import { getDeviceTypeModule } from '../device-types';
import { getDeviceInfo } from '../services/device-info.service';
import { getDeviceTiles } from '../services/tile.service';
import { requestLang, t } from '../i18n';
import {
  FirmwareError, cancelFirmwareUpdate, firmwareOfferForDevice, requestFirmwareUpdate,
} from '../services/firmware.service';
import { sendMessage } from '../websocket';
import { serverBaseUrl } from './firmware.controller';
import { UserEntry, UserModel } from '../models/user.model';
import { accessibleDevices, canManage, deviceAccess, SIMPLE_TAB } from '../services/access.service';
import { placeForViewer, saveViewerOrder, setViewerHidden, setViewerSimple } from '../services/tile-layout.service';
import { viewerWeatherTileIds } from '../services/weather-tile.service';
import { AuthError, userName } from '../services/auth.service';
import { createShare, deleteShare, listShares, updateShare } from '../services/share.service';
import { appUserMeta, logPropertiesChange, metaFromRequest, setStatusByRef } from '../services/operation-log.service';

// Kształt urządzenia w API; rootId to _id dokumentu w kolekcji devices.
const toPublicDevice = (device: DeviceDocument) => ({
  rootId: String(device._id),
  deviceType: device.deviceType,
  deviceId: device.deviceId,
  name: device.name,
  hidden: device.hidden ?? false,
  sortOrder: device.sortOrder,
  firmwareVersion: device.firmwareVersion,
  firmwareSeenAt: device.firmwareSeenAt,
  firmwareUpdate: device.firmwareUpdate ?? undefined,
  ipAddress: device.ipAddress,
  ipSeenAt: device.ipSeenAt,
  pumpConfig: device.pumpConfig ?? undefined,
  boilerConfig: device.boilerConfig ?? undefined,
  // przekaźnik poczty (włącznik, co): odcisk zatwierdzonego i czekającego klucza płytki
  mailKey: mailKeyInfo(device),
});

// Ustawienia, które sterownik pobiera w odpowiedzi na zgłoszenie (tylko rodzaje, które je mają).
const controllerSettings = (device: DeviceDocument) =>
  getDeviceTypeModule(device.deviceType).controllerSettings?.(device.properties ?? {}, device);

export async function getProperties(req: Request, res: Response) {
  try {
    return res.status(200).json(await getDeviceProperties(req.deviceRootId as string));
  } catch (error) {
    return res.status(404).json({ message: String(error) });
  }
}

// Zapis zastępuje całe properties (wszystkie rodzaje w jednym polu): klient musi
// wysłać komplet, bo pominięte klucze znikną. Pompa: od razu, ręczne ustawienia znikają
// (onPropertiesSaved); hydrofor: od następnego zgłoszenia, czyli uruchomienia pompy.
// Zmienione ustawienia trafiają do dziennika operacji (kto z nagłówków x-operation-*, inaczej aplikacja).
export async function updateProperties(req: Request<{}, {}, DeviceProperties>, res: Response) {
  try {
    const rootId = req.deviceRootId as string;
    const before = await getDeviceProperties(rootId);
    const properties = await updateDeviceProperties(rootId, req.body);
    const { deviceType } = await getDeviceInfo(rootId);
    const typeModule = getDeviceTypeModule(deviceType);
    const meta = metaFromRequest(req, appUserMeta('Ustawienia', 'Zapis ustawień.'));
    await logPropertiesChange(rootId, typeModule.propertyLabels, before, properties, meta, { pending: typeModule.propertiesOnRegister });
    await typeModule.onPropertiesSaved?.(rootId, meta);
    return res.status(200).json(properties);
  } catch (error) {
    return res.status(400).json({ message: String(error) });
  }
}

// Sterowniki widoczne dla użytkownika z właścicielem i rodzajem dostępu; pole szachownicy (sortOrder), ukrycie
// (hidden) i kafelek prosty (simple) z układu konta (tile-layout.service.ts); udostępnienie „Panel prosty” daje
// simple zawsze.
async function userDevices(sessionUser: UserEntry) {
  const access = await accessibleDevices(sessionUser);
  const devices = (await listDevices()).filter((device) => access.has(String(device._id)));
  const ownerIds = [...new Set(devices.map((device) => device.ownerId).filter((id): id is string => !!id))];
  const owners = new Map((await UserModel.find({ _id: { $in: ownerIds } }).lean<UserEntry[]>()).map((owner) => [String(owner._id), owner]));
  const list = devices.map((device) => {
    const rootId = String(device._id);
    const entry = access.get(rootId)!;
    const owner = device.ownerId ? owners.get(device.ownerId) : undefined;
    const demo = !!sessionUser.isDemo;
    const publicDevice = toPublicDevice(device);
    return {
      ...publicDevice,
      // wersja demo: bez numeru seryjnego, adresu IP i klucza poczty
      ...(demo ? { deviceId: '', ipAddress: undefined, ipSeenAt: undefined, mailKey: undefined } : {}),
      id: rootId,
      access: entry.role,
      ...(entry.role === 'shared' ? { tabs: entry.tabs } : {}),
      simple: false,
      owner: owner ? (demo ? { id: '', name: 'Właściciel', email: null } : { id: String(owner._id), name: userName(owner), email: owner.email ?? null }) : null,
    };
  });
  const rank = (device: { sortOrder?: number }) => device.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return (await placeForViewer(sessionUser, list)).sort((a, b) => rank(a) - rank(b))
    .map(({ id: _id, ...device }) => ({ ...device, simple: !!device.simple || !!device.tabs?.includes(SIMPLE_TAB) }));
}

// Zmiana sterownika z :rootId tylko dla właściciela i użytkownika systemowego (bez req.user: jak przed kontami).
async function allowManage(req: Request<{ rootId: string }>, res: Response): Promise<boolean> {
  if (!req.user) return true;
  try {
    const access = await deviceAccess(req.user, req.params.rootId);
    if (!access) {
      res.status(404).json({ message: 'Nie znaleziono sterownika.' });
      return false;
    }
    if (!canManage(access)) {
      res.status(403).json({ message: 'Tylko właściciel sterownika.' });
      return false;
    }
    return true;
  } catch {
    res.status(400).json({ message: 'Nieprawidłowy rootId.' });
    return false;
  }
}

export async function getDevices(req: Request, res: Response) {
  try {
    if (req.user) return res.status(200).json(await userDevices(req.user));
    const devices = await listDevices();
    return res.status(200).json(devices.map(toPublicDevice));
  } catch (error) {
    return res.status(500).json({ message: String(error) });
  }
}

// POST /devices: ręczne utworzenie (test E2E). Duplikat deviceId = 400.
export async function addDevice(
  req: Request<{}, {}, { deviceType?: DeviceType; deviceId?: string; name?: string }>,
  res: Response,
) {
  const { deviceType = DeviceType.HP, deviceId, name } = req.body;

  if (!deviceId?.trim()) {
    return res.status(400).json({ message: 'deviceId jest wymagane.' });
  }

  try {
    const device = await createDevice(deviceType, deviceId.trim(), name?.trim());
    return res.status(201).json(toPublicDevice(device));
  } catch (error) {
    return res.status(400).json({ message: String(error) });
  }
}

const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

// Adres IPv4 w zapisie dziesiętnym (a.b.c.d, 0–255); 0.0.0.0 to brak adresu w ESP32.
const ipv4 = (value: unknown) => {
  const text = optionalText(value);
  if (!text || text === '0.0.0.0') return undefined;
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    ? text
    : undefined;
};

// Zgłoszenie sterownika: rootId i (hydrofor) ustawienia do zapisania w sterowniku.
// Sterownik woła je przy każdym starcie; 201 = nowe urządzenie, 200 = znane.
// Brak deviceType oznacza pompę ciepła. Oferta firmware (OTA) dla rodzajów z firmwareUpdates.
// Pole version (wersja firmware, najwyżej 32 znaki) jest zapisywane w firmwareVersion,
// a ip (adres IPv4 w sieci lokalnej) w ipAddress; ip w innym formacie jest pomijane.
export async function registerDeviceEntry(
  req: Request<{}, {}, { deviceType?: DeviceType; deviceId?: string; name?: string; version?: string; ip?: string }>,
  res: Response,
) {
  const { deviceType = DeviceType.HP, deviceId, name, version, ip } = req.body;

  if (!deviceId?.trim()) {
    return res.status(400).json({ message: 'deviceId jest wymagane.' });
  }
  if (!Object.values(DeviceType).includes(deviceType)) {
    return res.status(400).json({ message: `Nieznany typ urządzenia: ${deviceType}` });
  }

  try {
    const { device, created } = await registerDevice(
      deviceType, deviceId.trim(), optionalText(name), optionalText(version)?.slice(0, 32), ipv4(ip),
    );
    const typeModule = getDeviceTypeModule(device.deviceType);
    await typeModule.onRegister?.(String(device._id), device.deviceId, req.body as Record<string, unknown>);
    // przekaźnik poczty: klucz publiczny płytki (nowy czeka na zatwierdzenie w aplikacji)
    await recordMailKey(device, (req.body as Record<string, unknown>).mailKey);
    // ustawienia z aplikacji idą w tej odpowiedzi (hydrofor): w dzienniku „dostarczona”
    if (typeModule.propertiesOnRegister && !created) await setStatusByRef(String(device._id), 'properties', ['pending'], 'delivered');
    // oferta firmware (OTA) tylko przy zleceniu „Aktualizuj”; zgłoszenie z oferowaną wersją je kasuje
    const firmware = typeModule.firmwareUpdates
      ? await firmwareOfferForDevice(device, serverBaseUrl(req))
      : undefined;
    const settings = controllerSettings(device) as object | undefined;
    // dane SMTP zaszyfrowane kluczem płytki (tylko zatwierdzony klucz, MAIL_RELAY=1); płytka trzyma je w RAM
    const mail = mailConfigFor(device);
    return res.status(created ? 201 : 200).json({
      ...toPublicDevice(device),
      settings: firmware ? { ...settings, firmware } : settings,
      ...(mail ? { mail } : {}),
    });
  } catch (error) {
    return res.status(400).json({ message: String(error) });
  }
}

const firmwareError = (res: Response, error: unknown) =>
  error instanceof FirmwareError
    ? res.status(error.status).json({ message: error.message })
    : res.status(400).json({ message: String(error) });

// POST /devices/:rootId/firmware-update — przycisk „Aktualizuj”: zlecenie aktualizacji do oferowanej
// wersji. Sterownik dostaje ofertę w najbliższej odpowiedzi chmury (piec co 15 s, włącznik co 5 s,
// hydrofor przy następnym uruchomieniu pompy); WebSocket budzi włącznik od razu.
export async function requestDeviceFirmwareUpdate(req: Request<{ rootId: string }>, res: Response) {
  if (!(await allowManage(req, res))) return;
  try {
    const firmwareUpdate = await requestFirmwareUpdate(req.params.rootId,
      metaFromRequest(req, appUserMeta('Ustawienia', 'Przycisk „Aktualizuj” w karcie Sterownik.')));
    void sendMessage('operation', req.params.rootId);
    return res.status(200).json(firmwareUpdate);
  } catch (error) {
    return firmwareError(res, error);
  }
}

// DELETE /devices/:rootId/firmware-update — odwołanie zlecenia.
export async function cancelDeviceFirmwareUpdate(req: Request<{ rootId: string }>, res: Response) {
  if (!(await allowManage(req, res))) return;
  try {
    await cancelFirmwareUpdate(req.params.rootId,
      metaFromRequest(req, appUserMeta('Ustawienia', 'Przycisk „Anuluj aktualizację” w karcie Sterownik.')));
    return res.status(200).json({});
  } catch (error) {
    return firmwareError(res, error);
  }
}

// Okno „Dane sterownika”: nazwa {name}, dla pompy ciepła definicja {pumpConfig} (komplet pól), dla kotła
// pelletowego {boilerConfig} (powiązana pompa ciepła; 409, gdy moduł odrzuci, np. usunięcie pompy w trybie pompy);
// rootId i deviceId nie podlegają edycji. Pusta nazwa jest dozwolona (klient pokazuje wtedy deviceId).
// Definicja pompy nie zmienia trybu pracy ani temperatur, więc nie budzi schedulera.
// {hidden} i {simple} (kafelek prosty) to układ konta: zapis tylko z kontem, dla każdego z dostępem do sterownika.
export async function updateDevice(
  req: Request<{ rootId: string }, {}, { name?: string; hidden?: unknown; simple?: unknown; pumpConfig?: unknown; boilerConfig?: unknown }>,
  res: Response,
) {
  const { name, hidden, simple, pumpConfig, boilerConfig } = req.body ?? {};
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ message: 'name: napis.' });
  }
  if (hidden !== undefined && typeof hidden !== 'boolean') {
    return res.status(400).json({ message: 'hidden: true albo false.' });
  }
  if (simple !== undefined && typeof simple !== 'boolean') {
    return res.status(400).json({ message: 'simple: true albo false.' });
  }
  if (name === undefined && hidden === undefined && simple === undefined && pumpConfig === undefined && boilerConfig === undefined) {
    return res.status(400).json({ message: 'name, hidden, simple, pumpConfig albo boilerConfig jest wymagane.' });
  }
  if (simple !== undefined && !req.user) return res.status(400).json({ message: 'simple: kafelek prosty wymaga konta.' });
  // z kontem ukrycie i tryb prosty kafelka zapisują się w układzie konta (każdy z dostępem do sterownika, także udostępnionego)
  if (req.user && (hidden !== undefined || simple !== undefined)) {
    const access = await accessibleDevices(req.user);
    if (!access.has(req.params.rootId)) return res.status(404).json({ message: 'Nie znaleziono sterownika.' });
    if (hidden !== undefined) {
      const mine = await userDevices(req.user);
      await setViewerHidden(req.user, req.params.rootId, hidden as boolean,
        mine.map((device) => ({ id: device.rootId, hidden: device.hidden })));
    }
    if (simple !== undefined) await setViewerSimple(req.user, req.params.rootId, simple as boolean);
    if (name === undefined && pumpConfig === undefined && boilerConfig === undefined) {
      return res.status(200).json((await userDevices(req.user)).find((device) => device.rootId === req.params.rootId));
    }
  }
  if (!(await allowManage(req, res))) return;

  try {
    const device = await updateDeviceData(req.params.rootId, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(hidden !== undefined && !req.user ? { hidden } : {}),
      ...(pumpConfig !== undefined ? { pumpConfig: parsePumpConfig(pumpConfig) } : {}),
      ...(boilerConfig !== undefined ? { boilerConfig: await parseBoilerConfig(boilerConfig) } : {}),
    });
    return res.status(200).json(toPublicDevice(device));
  } catch (error) {
    if (error instanceof DefinitionConflictError) return res.status(409).json({ message: error.message });
    return res.status(String(error).includes('not found') ? 404 : 400).json({ message: String(error) });
  }
}

// PUT /devices/order {rootIds: (string | null)[]} — pola szachownicy na /devices (tryb „Zmień układ”): z kontem
// w układzie konta, bez konta wspólnie (sortOrder w dokumentach).
export async function updateDevicesOrder(req: Request<{}, {}, { rootIds?: unknown }>, res: Response) {
  try {
    if (req.user) {
      const access = await accessibleDevices(req.user);
      const allowed = new Set([...access.keys(), ...(await viewerWeatherTileIds(req.user))]);
      await saveViewerOrder(req.user, req.body?.rootIds, allowed);
      return res.status(200).json(await userDevices(req.user));
    }
    await setDevicesOrder(req.body?.rootIds);
    return res.status(200).json((await listDevices()).map(toPublicDevice));
  } catch (error) {
    return res.status(String(error).includes('not found') ? 404 : 400).json({ message: String(error) });
  }
}

// GET /devices/summary — kafelki sterowników dla strony /devices: {[rootId]: DeviceTile}; rodzaj bez
// danych albo z błędem nie ma wpisu (kafelek zostaje wtedy tylko z nazwą).
export async function getDeviceTilesEntry(req: Request, res: Response) {
  try {
    const tiles = await getDeviceTiles(requestLang(req));
    if (!req.user) return res.status(200).json(tiles);
    const access = await accessibleDevices(req.user);
    return res.status(200).json(Object.fromEntries(Object.entries(tiles).filter(([rootId]) => access.has(rootId))));
  } catch (error) {
    return res.status(500).json({ message: String(error) });
  }
}

const shareError = (req: Request, res: Response, error: unknown) =>
  error instanceof AuthError
    ? res.status(error.status).json({ message: error.messageFor(requestLang(req)) })
    : res.status(String(error).includes('Cast to ObjectId') ? 404 : 500).json({ message: String(error) });

// Udostępnianie sterownika (karta „Udostępnianie” w Ustawieniach): tylko właściciel i użytkownik systemowy.
// GET /devices/:rootId/shares, POST {email, tabs}, PUT /devices/:rootId/shares/:id {tabs}, DELETE …/:id
export async function getDeviceShares(req: Request<{ rootId: string }>, res: Response) {
  if (!(await allowManage(req, res))) return;
  try {
    return res.status(200).json(await listShares(req.params.rootId));
  } catch (error) {
    return shareError(req, res, error);
  }
}

export async function addDeviceShare(req: Request<{ rootId: string }>, res: Response) {
  if (!req.user) return res.status(401).json({ message: t(requestLang(req), 'err.signIn') });
  if (!(await allowManage(req, res))) return;
  try {
    return res.status(201).json(await createShare(req.user, req.params.rootId, req.body ?? {}, req.header('origin'), requestLang(req)));
  } catch (error) {
    return shareError(req, res, error);
  }
}

export async function updateDeviceShare(req: Request<{ rootId: string; id: string }>, res: Response) {
  if (!(await allowManage(req, res))) return;
  try {
    return res.status(200).json(await updateShare(req.params.rootId, req.params.id, req.body ?? {}));
  } catch (error) {
    return shareError(req, res, error);
  }
}

export async function removeDeviceShare(req: Request<{ rootId: string; id: string }>, res: Response) {
  if (!(await allowManage(req, res))) return;
  try {
    await deleteShare(req.params.rootId, req.params.id);
    return res.status(204).end();
  } catch (error) {
    return shareError(req, res, error);
  }
}
