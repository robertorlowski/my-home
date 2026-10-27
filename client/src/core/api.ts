// API urządzeń wspólne dla wszystkich rodzajów sterowników: /api/devices (lista, nazwa, domyślny)
// i /api/device/properties (ustawienia wybranego urządzenia). Używane przez App, stronę Devices,
// popup DeviceEditModal, Harmonogramy pompy oraz widoki hydroforu.
import { Requests } from './http';
import { DatabaseStats, Device, DeviceDefinition, DeviceProperties, DeviceShare, DeviceTiles, DeviceType, FirmwareSummary, FirmwareUpdateRequest, MailKeyInfo, OperationsDay, OutdoorConditions, PushRule, PushSettings, PushSubscriptionInfo, User, WeatherTile } from './types';

// Urządzenia wszystkich rodzajów: lista, nazwa, sterownik domyślny i ustawienia (properties).
export class DeviceRequests {
  // bez rootId/deviceId w zapytaniu: lista jest potrzebna, zanim cokolwiek wybrano;
  // przy błędzie zwraca null (Requests.get nie rzuca wyjątku)
  static getDevices(): Promise<Device[]> {
    return Requests.get('/devices', false) as Promise<Device[]>;
  }

  // zajętość bazy dla stopki strony /devices; null przy błędzie (np. 503 bez połączenia z bazą)
  static getDatabaseStats(): Promise<DatabaseStats | null> {
    return Requests.get('/devices/db-stats', false) as Promise<DatabaseStats | null>;
  }

  // okno „Dane sterownika”: nazwa i pola rodzaju (definicja pompy); rootId w ścieżce,
  // bo na liście urządzeń żadne nie jest jeszcze wybrane
  static updateDevice(rootId: string, data: { name: string } & DeviceDefinition): Promise<Device> {
    return Requests.put(`/devices/${encodeURIComponent(rootId)}`, data, false) as Promise<Device>;
  }

  // ukrycie / pokazanie kafelka sterownika (tryb „Zmień kolejność”)
  static setDeviceHidden(rootId: string, hidden: boolean): Promise<Device> {
    return Requests.put(`/devices/${encodeURIComponent(rootId)}`, { hidden }, false) as Promise<Device>;
  }

  // przełącznik „Kafelek prosty” w oknie „Dane sterownika”: tylko na tym koncie (users.simpleTiles)
  static setDeviceSimple(rootId: string, simple: boolean): Promise<Device> {
    return Requests.put(`/devices/${encodeURIComponent(rootId)}`, { simple }, false) as Promise<Device>;
  }

  // temperatura z czujnika kotła i pogoda z Open-Meteo nad kafelkami (null w polach bez świeżych danych); null przy błędzie
  static getOutdoorConditions(): Promise<OutdoorConditions | null> {
    return Requests.get('/temperature', false) as Promise<OutdoorConditions | null>;
  }

  // kafelki sterowników {rootId: kafelek}; null przy błędzie (Requests.get nie rzuca wyjątku)
  static getDeviceTiles(): Promise<DeviceTiles | null> {
    return Requests.get('/devices/summary', false) as Promise<DeviceTiles | null>;
  }

  // wzór kafelka (projektant kafelka): zapisany wzór, null = wbudowany, undefined przy błędzie sieci

  // układ szachownicy (tryb „Zmień układ”): pola po kolei z Root ID sterownika, id kafelka pogody albo null
  // (puste pole); zwraca posortowaną listę sterowników
  static setDevicesOrder(rootIds: (string | null)[]): Promise<Device[]> {
    return Requests.put('/devices/order', { rootIds }, false) as Promise<Device[]>;
  }

  // sterownik otwierany po starcie aplikacji; w bazie najwyżej jeden

  // przycisk „Aktualizuj”: zlecenie aktualizacji firmware do oferowanej wersji (i jego odwołanie);
  // bez zlecenia sterownik niczego nie pobiera. Rzuca wyjątek z komunikatem serwera.
  static requestFirmwareUpdate(rootId: string): Promise<FirmwareUpdateRequest> {
    return Requests.postJson(`/devices/${encodeURIComponent(rootId)}/firmware-update`);
  }

  // przekaźnik poczty: zatwierdzenie klucza płytki (odcisk z karty, zgodny z /install płytki) i jego usunięcie
  static approveMailKey(rootId: string, fingerprint: string): Promise<MailKeyInfo> {
    return Requests.json<MailKeyInfo>('POST', `/devices/${encodeURIComponent(rootId)}/mail-key`, { fingerprint });
  }

  static revokeMailKey(rootId: string): Promise<void> {
    return Requests.json<void>('DELETE', `/devices/${encodeURIComponent(rootId)}/mail-key`);
  }

  static cancelFirmwareUpdate(rootId: string): Promise<void> {
    return Requests.deleteJson(`/devices/${encodeURIComponent(rootId)}/firmware-update`);
  }

  // properties wybranego urządzenia (rootId z kontekstu): pompa — tryb i temperatury domyślne
  // schedulera, hydrofor — czas kompresora, progi presostatu i zbiorniki
  static getDeviceProperties(): Promise<DeviceProperties> {
    return Requests.get('/device/properties') as Promise<DeviceProperties>;
  }

  static updateDeviceProperties(properties: DeviceProperties) {
    return Requests.put('/device/properties', properties) as Promise<DeviceProperties>;
  }
}

// Firmware sterowników przez sieć (OTA): bez rootId, bo dotyczy rodzaju sterownika, nie jednego
// urządzenia. Używane przez stronę /firmware.
export class FirmwareRequests {
  // przy błędzie zwraca null (Requests.get nie rzuca wyjątku)
  static get(type: DeviceType): Promise<FirmwareSummary | null> {
    return Requests.get(`/firmware/${type}`, false) as Promise<FirmwareSummary | null>;
  }

  // zapisuje plik i ustawia go jako oferowany; serwer liczy SHA-256 i sprawdza obraz ESP32
  static upload(type: DeviceType, version: string, file: Blob, description = ''): Promise<FirmwareSummary> {
    const query = description ? `?description=${encodeURIComponent(description)}` : '';
    return Requests.putFile(`/firmware/${type}/${encodeURIComponent(version)}${query}`, file);
  }

  // usuwa plik wersji, która nie jest oferowana
  static remove(type: DeviceType, version: string): Promise<FirmwareSummary> {
    return Requests.deleteJson(`/firmware/${type}/${encodeURIComponent(version)}`);
  }

  // włączenie i wyłączenie oferty albo przywrócenie wersji, której plik jest jeszcze w bazie
  static update(type: DeviceType, change: { enabled?: boolean; version?: string }): Promise<FirmwareSummary> {
    return Requests.put(`/firmware/${type}`, change, false) as Promise<FirmwareSummary>;
  }
}

// Konta użytkowników (/api/auth/*, 2026-10-11): logowanie kodem lub linkiem z maila, system, „Zapamiętaj 90 dni”,
// dane konta, zmiana e-maila, usunięcie konta. Błędy jako ApiError z komunikatem serwera.
type Session = { token: string; created: boolean; user: User };
export const AuthRequests = {
  start: (email: string) => Requests.json<{ email: string; resendAfterSeconds: number }>('POST', '/auth/start', { email }),
  verifyCode: (email: string, code: string) => Requests.json<Session>('POST', '/auth/verify', { email, code }),
  verifyLink: (token: string) => Requests.json<Session>('POST', '/auth/verify', { token }),
  system: (password: string) => Requests.json<Session>('POST', '/auth/system', { password }),
  // wersja demo: dostępność (przycisk pod logowaniem) i wejście bez hasła (sesja 2 h, tylko odczyt)
  demoAvailable: () => Requests.json<{ available: boolean }>('GET', '/auth/demo'),
  demo: () => Requests.json<Session>('POST', '/auth/demo'),
  remember: (remember: boolean) => Requests.json<{ remember: boolean }>('POST', '/auth/remember', { remember }),
  logout: () => Requests.json<null>('POST', '/auth/logout'),
  me: () => Requests.json<User>('GET', '/auth/me'),
  updateMe: (data: Partial<User>) => Requests.json<User>('PUT', '/auth/me', data),
  setLanguage: (language: string) => Requests.json<User>('PUT', '/auth/me/language', { language }),
  changeEmail: (email: string) => Requests.json<{ email: string }>('POST', '/auth/email-change', { email }),
  verifyEmail: (code: string) => Requests.json<User>('POST', '/auth/email-change/verify', { code }),
  deleteAccount: () => Requests.json<{ email: string; devices: number }>('POST', '/auth/delete'),
  confirmDelete: (token: string) => Requests.json<{ devices: number }>('POST', '/auth/delete/confirm', { token }),
};

// Powiadomienia Web Push konta (/api/push/*, 2026-10-21): ustawienia, subskrypcja tej przeglądarki, reguły, próbne.
export const PushRequests = {
  settings: () => Requests.json<PushSettings>('GET', '/push/settings'),
  subscribe: (subscription: PushSubscriptionJSON, label: string) =>
    Requests.json<PushSubscriptionInfo>('POST', '/push/subscriptions', { endpoint: subscription.endpoint, keys: subscription.keys, label }),
  unsubscribe: (id: string) => Requests.json<null>('DELETE', `/push/subscriptions/${encodeURIComponent(id)}`),
  saveRules: (rules: PushRule[], quietFrom: string | null, quietTo: string | null) =>
    Requests.json<{ rules: PushRule[]; quietFrom: string | null; quietTo: string | null }>('PUT', '/push/rules', { rules, quietFrom, quietTo }),
  test: () => Requests.json<{ sent: number }>('POST', '/push/test'),
};

// Udostępnianie sterownika (właściciel): osoby z dostępem i ich zakładki.
const sharesPath = (rootId: string) => `/devices/${encodeURIComponent(rootId)}/shares`;
export const ShareRequests = {
  list: (rootId: string) => Requests.json<DeviceShare[]>('GET', sharesPath(rootId)),
  add: (rootId: string, email: string, tabs: string[]) => Requests.json<DeviceShare>('POST', sharesPath(rootId), { email, tabs }),
  update: (rootId: string, id: string, tabs: string[]) => Requests.json<DeviceShare>('PUT', `${sharesPath(rootId)}/${id}`, { tabs }),
  remove: (rootId: string, id: string) => Requests.json<null>('DELETE', `${sharesPath(rootId)}/${id}`),
};

// Dziennik operacji wybranego sterownika z dnia (zakładka „Operacje”); null przy błędzie
export class OperationRequests {
  static getDay(date: string): Promise<OperationsDay | null> {
    return Requests.get(`/operations?date=${date}`) as Promise<OperationsDay | null>;
  }
}

// Kafelki pogody na liście sterowników (bez rootId); kolejność razem ze sterownikami w DeviceRequests.setDevicesOrder.
export class WeatherTileRequests {
  static list(): Promise<WeatherTile[] | null> {
    return Requests.get('/weather-tiles', false) as Promise<WeatherTile[] | null>;
  }

  // stałe miejsce {name, lat, lon} albo kafelek bieżącej lokalizacji {current: true}
  static create(data: { name: string; lat: number; lon: number } | { current: true; name?: string }): Promise<WeatherTile> {
    return Requests.put('/weather-tiles', data, false, 'POST') as Promise<WeatherTile>;
  }

  static update(id: string, data: Partial<{ name: string; lat: number; lon: number; hidden: boolean }>): Promise<WeatherTile> {
    return Requests.put(`/weather-tiles/${encodeURIComponent(id)}`, data, false) as Promise<WeatherTile>;
  }

  static remove(id: string): Promise<void> {
    return Requests.delete(`/weather-tiles/${encodeURIComponent(id)}`, false);
  }
}
