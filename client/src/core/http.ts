import { getLang, t } from './i18n';
import { getSelectedDevice } from './context/DeviceContext';
import { getToken, isDemoSession, notifyDemoBlocked, notifyUnauthorized } from './auth';

// Połączenie z serwerem: adresy API i WebSocket oraz zapytania z kontekstem
// wybranego urządzenia (rootId, deviceId). API poszczególnych rodzajów
// sterowników jest w devices/<rodzaj>/api.ts, a urządzeń w core/api.ts.
//
// Uwaga na różną obsługę błędów: get zwraca null (nie rzuca), post połyka wyjątek i zwraca
// undefined (z json = false zwraca Response, więc wywołujący sprawdza status), a put i delete
// rzucają wyjątek przy statusie innym niż 2xx.

// Dopisuje rootId i deviceId wybranego sterownika. Czyta wybór wprost z localStorage
// (getSelectedDevice), bo jest wołana poza komponentami React; serwer (device-context) wymaga rootId.
function withDeviceContext(path: string, includeDevice: boolean) {
  if (!includeDevice) return path;

  const device = getSelectedDevice();
  if (!device) throw new Error('Wybierz urządzenie przed użyciem aplikacji.');

  const separator = path.includes('?') ? '&' : '?';
  // wersja demo nie dostaje numeru seryjnego (deviceId pusty); serwer wymaga tylko rootId
  const params = `rootId=${encodeURIComponent(device.rootId)}&deviceId=${encodeURIComponent(device.deviceId ?? '')}`;
  return `${path}${separator}${params}`;
}

// w trybie dev serwer jest na tym samym komputerze co Vite, port 4001; nazwa hosta z paska adresu
// pozwala otworzyć klienta z telefonu w sieci lokalnej (npm run local -- --host)
const devServerHost = () => window.location.hostname;
// VITE_API_PORT: inny port serwera w trybie dev (np. podgląd na bazie produkcyjnej obok środowiska lokalnego)
const devServerPort = () => import.meta.env.VITE_API_PORT ?? '4001';

// Adres WebSocket serwera; ?rootId=… dopisuje wywołujący (widok główny pompy), bez niego serwer
// zamyka połączenie. Serwer przyjmuje dowolną ścieżkę, klient łączy się na ścieżkę główną.
// Produkcja: stały adres Render; build nie ma konfiguracji adresu przez zmienne środowiskowe.
export const wsAddressServer = () => {
  if (import.meta.env.DEV)
    return  `ws://${devServerHost()}:${devServerPort()}`
  else
    return  "wss://chpc-web.onrender.com/";
}

function prefixMocks(path: string) {
  if (import.meta.env.DEV)
    return  `http://${devServerHost()}:${devServerPort()}/api`.concat(path)
  else
    return  "https://chpc-web.onrender.com/api".concat(path);

}

// Sesja (konta użytkowników): token z core/auth.ts w nagłówku Authorization każdego zapytania; 401 = sesja
// wygasła albo wylogowano na innym urządzeniu — AuthContext pokazuje wtedy logowanie.
// nagłówek sesji i język aplikacji (core/i18n): serwer odpowiada komunikatami i wysyła maile w tym języku
const authHeader = (): Record<string, string> => {
  const token = getToken();
  return { 'Accept-Language': getLang(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

const apiFetch = async (input: string, init: RequestInit) => {
  // wersja demo: zapis nie wychodzi z przeglądarki (serwer i tak odpowiedziałby 403), a App pokazuje komunikat
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && isDemoSession() && !input.endsWith('/auth/logout')) {
    notifyDemoBlocked();
    return new Response(JSON.stringify({ message: t('app.demoBlocked'), demo: true }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const response = await fetch(input, init);
  if (response.status === 401 && getToken()) notifyUnauthorized();
  return response;
};

// Błąd z kodem i komunikatem serwera (pole message) dla formularzy kont i udostępniania.
export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfterSeconds?: number) {
    super(message);
  }
}

export class Requests {
  // JSON w obie strony, bez kontekstu urządzenia (chyba że includeDevice); rzuca ApiError z komunikatem serwera
  static async json<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown, includeDevice = false): Promise<T> {
    let response: Response;
    try {
      response = await apiFetch(prefixMocks(withDeviceContext(path, includeDevice)), {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...authHeader() },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    } catch {
      throw new ApiError('Brak połączenia z serwerem.', 0);
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(body?.message ?? `Błąd serwera (${response.status}).`, response.status, body?.retryAfterSeconds);
    return body as T;
  }

  static async get(path: string, includeDevice = true) {
    try {
      const response = await apiFetch(prefixMocks(withDeviceContext(path, includeDevice)), {
        method: "GET",
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...authHeader()
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.warn("Fetch error:", error);
      return null;
    }
  }

  static post(path :string, data = {}, json = true, includeDevice = true) {
    return apiFetch(
      prefixMocks(withDeviceContext(path, includeDevice)),
        Object.assign(
          {
            method: "POST",
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
          ...authHeader()
            },
            body: JSON.stringify(data)
          }
        )
      )
      .then(response => {
          return json ? response.json() : response
      })
      .then(response => {
        console.log("POST", path, data, "resp", response);
        return response;
      })
      .catch(error => {
        console.warn(error);
      });
  }

  static async delete(path: string, includeDevice = true) {
    const response = await apiFetch(prefixMocks(withDeviceContext(path, includeDevice)), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
          ...authHeader(),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  // PUT z surową treścią (plik .bin); w odróżnieniu od put rzuca wyjątek z komunikatem serwera
  // (pole message), bo walidacja pliku zwraca konkretną przyczynę odmowy.
  static async putFile(path: string, file: Blob) {
    const response = await apiFetch(prefixMocks(path), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
          ...authHeader(),
      },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message ?? `HTTP error! status: ${response.status}`);
    return body;
  }

  // POST bez treści i bez kontekstu urządzenia; jak putFile rzuca wyjątek z komunikatem serwera
  static async postJson(path: string) {
    const response = await apiFetch(prefixMocks(path), {
      method: 'POST',
      headers: { ...authHeader() },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message ?? `HTTP error! status: ${response.status}`);
    return body;
  }

  // DELETE bez kontekstu urządzenia; jak putFile rzuca wyjątek z komunikatem serwera
  static async deleteJson(path: string) {
    const response = await apiFetch(prefixMocks(path), {
      method: 'DELETE',
      headers: { ...authHeader() },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message ?? `HTTP error! status: ${response.status}`);
    return body;
  }

  // method: PUT albo POST z tą samą obsługą błędu (kod i komunikat serwera w wyjątku)
  static async put(path: string, data: unknown, includeDevice = true, method: 'PUT' | 'POST' = 'PUT') {
    const response = await apiFetch(prefixMocks(withDeviceContext(path, includeDevice)), {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
          ...authHeader(),
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      // kod i komunikat serwera dla wywołującego (np. 409 w oknie „Dane sterownika”); treść błędu bez zmian
      const body = await response.json().catch(() => null);
      throw Object.assign(new Error(`HTTP error! status: ${response.status}`), { status: response.status, serverMessage: body?.message });
    }

    return response.json();
  }

}
