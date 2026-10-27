// Logowanie i dostęp dla każdego żądania /api (konta użytkowników, 2026-10-11; montowane w core/app.ts):
// - authenticate (przed kontekstem urządzenia): token z nagłówka Authorization: Bearer → req.user, req.sessionToken;
// - authorize (po kontekście urządzenia): bez logowania przechodzą tylko /auth/*, endpointy sterowników (bez zmian
//   w firmware), pobranie pliku firmware i wywołania wewnętrzne; reszta wymaga sesji (401), a żądanie z rootId
//   dostępu do sterownika (403; osoba z udostępnieniem: zapisy według zakładek, access.service.ts).
// AUTH_DISABLED=1 wyłącza sprawdzanie (testy starszych modułów; nie ustawiać na produkcji).
import { NextFunction, Request, Response } from 'express';
import { requestLang, t } from '../i18n';
import { UserEntry } from '../models/user.model';
import { INTERNAL_TOKEN, INTERNAL_TOKEN_HEADER } from '../internal';
import { deviceAccess, DeviceAccess, sharedWriteDenied } from '../services/access.service';
import { sessionFromToken } from '../services/auth.service';

declare global {
  namespace Express {
    interface Request {
      user?: UserEntry;
      sessionToken?: string;
      deviceAccess?: DeviceAccess;
    }
  }
}

export const authDisabled = () => process.env.AUTH_DISABLED === '1';

const bearer = (req: Request) => {
  const header = req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next();
  try {
    const found = await sessionFromToken(token);
    if (found) {
      req.user = found.user;
      req.sessionToken = token;
    }
    return next();
  } catch (error) {
    return res.status(500).json({ message: String(error) });
  }
}

// Endpointy sterowników (metoda i ścieżka względem /api): działają jak przed kontami, bez logowania.
const CONTROLLER_ROUTES = new Set([
  'POST /devices/register',
  'POST /hp/add',
  'POST /pv/add',
  'POST /water-pressure-tank/add',
  'PUT /water-pressure-tank/settings',
  'POST /pellet-boiler-pelux200/add',
  'POST /pellet-boiler-pelux200/settings',
  'POST /pellet-boiler-pelux200/alerts',
  'GET /pellet-boiler-pelux200/commands/next',
  'POST /pellet-boiler-pelux200/commands/result',
  'POST /switch/state',
  // przekaźnik poczty (treść zaszyfrowana kluczem płytki, mail-relay.service.ts)
  'GET /mail/config',
  'GET /mail/next',
  'POST /mail/result',
]);

function isPublic(req: Request) {
  if (req.path.startsWith('/auth/')) return true;
  if (CONTROLLER_ROUTES.has(`${req.method} ${req.path}`)) return true;
  // tryb przekaźnika ze strony włącznika (sam deviceId, source: controller)
  if (req.method === 'PUT' && req.path === '/switch/mode' && !req.user && req.body?.source === 'controller') return true;
  // plik firmware dla sterownika (adres z oferty OTA)
  if (req.method === 'GET' && /^\/firmware\/[^/]+\/[^/]+$/.test(req.path)) return true;
  return req.header(INTERNAL_TOKEN_HEADER) === INTERNAL_TOKEN;
}

// Ścieżki bez rootId tylko dla użytkownika systemowego: pliki firmware, zajętość bazy, ręczne dodanie urządzenia.
function systemOnly(req: Request) {
  if (req.path.startsWith('/firmware/') && req.method !== 'GET') return true;
  if (req.path === '/devices/db-stats') return true;
  return req.method === 'POST' && req.path === '/devices';
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Wersja demo: siatka bezpieczeństwa na odpowiedzi — każdy JSON traci klucze z danymi wrażliwymi, bo numer seryjny
// (deviceId = MAC płytki) jest w rekordach telemetrii, a sam SN wystarcza do poleceń sterownika (PUT /switch/mode ze
// źródłem controller); e-mail, adres i położenie to dane właściciela. Kontrolery dodatkowo zaokrąglają współrzędne
// kafelków pogody i anonimizują dziennik operacji.
const DEMO_HIDDEN_KEYS = new Set(['deviceId', 'ipAddress', 'ipSeenAt', 'mailKey', 'mailKeyPending', 'email', 'street', 'postalCode', 'city', 'location', 'endpoint']);
export function scrubDemo(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubDemo);
  if (value && typeof value === 'object') {
    // tylko zwykłe obiekty i tablice; Date, ObjectId itp. zostają (res.json serializuje je przez toJSON)
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!DEMO_HIDDEN_KEYS.has(key)) out[key] = scrubDemo(item);
    }
    return out;
  }
  return value;
}
function scrubDemoResponses(res: Response) {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(scrubDemo(body))) as Response['json'];
}

export async function authorize(req: Request, res: Response, next: NextFunction) {
  if (authDisabled()) return next();
  // wersja demo: żadnych zapisów, także w /auth/* (zmiana e-maila i usunięcie konta właściciela); zostaje wylogowanie
  if (req.user?.isDemo && !READ_METHODS.has(req.method) && !(req.method === 'POST' && req.path === '/auth/logout')) {
    return res.status(403).json({ message: t(requestLang(req), 'err.demoReadOnly'), demo: true });
  }
  if (req.user?.isDemo) scrubDemoResponses(res);
  if (isPublic(req)) return next();
  const user = req.user;
  if (!user) return res.status(401).json({ message: t(requestLang(req), 'err.signIn') });
  if (systemOnly(req) && !user.isSystem) return res.status(403).json({ message: t(requestLang(req), 'err.systemOnly') });
  if (!req.deviceRootId) return next();
  try {
    const access = await deviceAccess(user, req.deviceRootId);
    if (!access) return res.status(403).json({ message: t(requestLang(req), 'err.noDeviceAccess') });
    if (access.role === 'shared') {
      const denied = sharedWriteDenied(req.method, req.path, access.tabs, requestLang(req));
      if (denied) return res.status(403).json({ message: denied });
    }
    req.deviceAccess = access;
    return next();
  } catch (error) {
    return res.status(500).json({ message: String(error) });
  }
}
