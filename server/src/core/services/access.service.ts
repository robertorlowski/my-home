// Dostęp do sterowników (konta użytkowników, 2026-10-11): użytkownik systemowy widzi wszystkie, właściciel swoje,
// a osoba z udostępnieniem — sterownik z wybranymi zakładkami. Zakładki pilnują ZAPISÓW (tabela WRITE_RULES):
// zapis jest dozwolony, gdy udostępnienie obejmuje którąś z zakładek, w których aplikacja go wykonuje; zapis spoza
// tabeli robi tylko właściciel. Odczyty (GET) są dozwolone przy każdym udostępnieniu: menu klienta pokazuje tylko
// udostępnione zakładki, a dane tego samego sterownika czyta kilka zakładek naraz.
import { DeviceShareModel } from '../models/device-share.model';
import { DEFAULT_LANG, Lang, t, tabLabel } from '../i18n';
import { DeviceModel } from '../models/device.model';
import { UserEntry } from '../models/user.model';

/** ścieżki zakładek klienta (menu rodzaju sterownika); nie każdy rodzaj ma wszystkie. SIMPLE_TAB to nie zakładka,
 *  tylko „Panel prosty” (2026-10-20): osoba widzi sterownik jako kafelek prosty na liście (duże przyciski) i nie
 *  otwiera jego widoków; na razie włącznik */
export const SIMPLE_TAB = 'simple';
export const TABS = ['/', '/data', '/chart', '/schedules', '/alarms', '/operations', '/settings', SIMPLE_TAB] as const;

/** demo (2026-10-21): sterowniki właściciela z DEMO_OWNER_EMAIL tylko do odczytu (zapisy blokuje authorize) */
export type DeviceAccess = { role: 'system' | 'owner' | 'demo' } | { role: 'shared'; tabs: string[] };

export async function deviceAccess(user: UserEntry, rootId: string): Promise<DeviceAccess | null> {
  if (user.isSystem) return { role: 'system' };
  const device = await DeviceModel.findById(rootId).select('ownerId').lean<{ ownerId?: string | null }>();
  if (!device) return null;
  if (device.ownerId && device.ownerId === String(user._id)) return { role: user.isDemo ? 'demo' : 'owner' };
  if (user.isDemo) return null;
  const share = await DeviceShareModel.findOne({ rootId, userId: String(user._id) }).select('tabs').lean<{ tabs: string[] }>();
  return share ? { role: 'shared', tabs: share.tabs } : null;
}

export const canManage = (access: DeviceAccess | null) => access?.role === 'system' || access?.role === 'owner';

// Zapisy aplikacji (metoda i ścieżka względem /api) → zakładki, w których się odbywają.
const WRITE_RULES: { method: string; path: RegExp; tabs: string[] | 'any' }[] = [
  // pompa ciepła: przełączniki na Podglądzie i panel Ustawień; harmonogramy; ustawienia domyślne w Harmonogramie
  { method: 'POST', path: /^\/operation\/(set|action)$/, tabs: ['/', '/settings'] },
  { method: '*', path: /^\/schedules(\/[^/]+)?$/, tabs: ['/schedules'] },
  // ustawienia sterownika; Statystyki (/chart): cena pelletu kotła (koszt ogrzewania)
  { method: 'PUT', path: /^\/device\/properties$/, tabs: ['/settings', '/schedules', '/chart'] },
  // kocioł
  { method: 'POST', path: /^\/pellet-boiler-pelux200\/commands$/, tabs: ['/', '/settings'] },
  { method: 'PUT', path: /^\/pellet-boiler-pelux200\/schedule-settings$/, tabs: ['/schedules', '/settings'] },
  { method: 'POST', path: /^\/pellet-boiler-pelux200\/turn-on$/, tabs: ['/', '/settings'] },
  // kafelek prosty pieca
  { method: 'POST', path: /^\/pellet-boiler-pelux200\/simple$/, tabs: ['/', '/settings', SIMPLE_TAB] },
  { method: 'PUT', path: /^\/pellet-boiler-pelux200\/(pellet-cwu|season)$/, tabs: ['/', '/schedules', '/settings'] },
  { method: 'POST', path: /^\/pellet-boiler-pelux200\/auto-pellet\/ack$/, tabs: 'any' },
  { method: '*', path: /^\/pellet-boiler-pelux200\/schedules(\/[^/]+)?$/, tabs: ['/schedules'] },
  // włącznik: tryb z Podglądu i z przycisków kafelka prostego
  { method: 'PUT', path: /^\/switch\/mode$/, tabs: ['/', SIMPLE_TAB] },
  { method: 'PUT', path: /^\/switch\/relays\/[^/]+$/, tabs: ['/settings'] },
  { method: '*', path: /^\/switch\/schedules(\/[^/]+)?$/, tabs: ['/schedules'] },
  // hydrofor: odczyty wodomierza w zakładce Dane
  { method: '*', path: /^\/water-pressure-tank\/meter(\/[^/]+)?$/, tabs: ['/data'] },
];

/** null = dozwolone; inaczej komunikat odmowy (403) */
export function sharedWriteDenied(method: string, path: string, tabs: string[], lang: Lang = DEFAULT_LANG): string | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const rule = WRITE_RULES.find((r) => (r.method === '*' || r.method === method) && r.path.test(path));
  if (!rule) return t(lang, 'err.ownerOnlyChange');
  if (rule.tabs === 'any' || rule.tabs.some((tab) => tabs.includes(tab))) return null;
  return t(lang, 'err.noTabAccess', { tabs: rule.tabs.map((tab) => tabLabel(tab, lang)).join(' / ') });
}

/** sterowniki widoczne dla użytkownika: rootId → dostęp (system: wszystkie) */
export async function accessibleDevices(user: UserEntry): Promise<Map<string, DeviceAccess>> {
  const result = new Map<string, DeviceAccess>();
  if (user.isSystem) {
    for (const device of await DeviceModel.find().select('_id').lean()) result.set(String(device._id), { role: 'system' });
    return result;
  }
  for (const device of await DeviceModel.find({ ownerId: String(user._id) }).select('_id').lean()) {
    result.set(String(device._id), { role: user.isDemo ? 'demo' : 'owner' });
  }
  if (user.isDemo) return result;
  for (const share of await DeviceShareModel.find({ userId: String(user._id) }).select('rootId tabs').lean()) {
    if (!result.has(share.rootId)) result.set(share.rootId, { role: 'shared', tabs: share.tabs });
  }
  return result;
}
