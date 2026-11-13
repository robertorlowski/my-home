// WebSocket na tym samym porcie co HTTP (ścieżka dowolna, w praktyce /ws?rootId=…).
// Łączą się sterownik co i przeglądarki. Serwer tylko powiadamia: "operation"
// (setOperationAction) budzi co, żeby od razu wysłał /hp/add; "update" (addHpData)
// każe klientowi odświeżyć dane. Treść wiadomości przychodzących jest tylko logowana.
// Od 2026-11-13 (próbnie, services/qnap.service.ts): gniazdo, które po połączeniu wysłało powitanie "ESP32", jest
// gniazdem sterownika; tylko do niego idzie {typ:"qnap"} (sendToController) i tylko od niego jest przyjmowany
// {typ:"qnap_wynik"} (onControllerMessage). Treść qnap_wynik nie trafia do dziennika serwera.
import WebSocket, { WebSocketServer } from 'ws';

// połączenie -> rootId (albo kilka: lista sterowników w kliencie, ?rootIds=a,b,c); sterownik i przeglądarki
// tego samego urządzenia są nierozróżnialne, więc każdy komunikat trafia do wszystkich
const espClients = new Map<WebSocket, string[]>();
// gniazda sterowników (powitanie "ESP32"); przeglądarki go nie wysyłają
const controllerSockets = new Set<WebSocket>();
type ControllerListener = (rootIds: string[], message: Record<string, unknown>) => void;
const controllerListeners = new Set<ControllerListener>();

/** wiadomości JSON od sterowników (rootId z adresu gniazda); zwraca funkcję wypisującą słuchacza */
export function onControllerMessage(listener: ControllerListener): () => void {
  controllerListeners.add(listener);
  return () => { controllerListeners.delete(listener); };
}

/** urządzenia z otwartym gniazdem sterownika */
export function controllerRootIds(): string[] {
  const ids = new Set<string>();
  controllerSockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) (espClients.get(socket) ?? []).forEach((id) => ids.add(id));
  });
  return [...ids];
}

/** wiadomość JSON od razu do gniazd sterownika tego urządzenia (bez przeglądarek); zwraca liczbę gniazd */
export function sendToController(rootId: string, payload: object): number {
  const text = JSON.stringify(payload);
  let sent = 0;
  controllerSockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN && (espClients.get(socket) ?? []).includes(rootId)) {
      socket.send(text);
      sent++;
    }
  });
  return sent;
}

export const createWsServer = (server: any) => {
  const wss = new WebSocketServer({ server });    
  
  console.log("server create");

  wss.on('connection', async (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`New client connected: ${ip}`);
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    // rootIds: lista sterowników w kliencie odświeża kafelki po „update” któregokolwiek z nich
    const rootIds = (params.get('rootIds') ?? params.get('rootId') ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100);
    // bez rootId nie wiadomo, do którego sterownika kierować komunikaty
    if (rootIds.length === 0) {
      ws.close(1008, 'rootId jest wymagane');
      return;
    }
    espClients.set(ws, rootIds);
    console.log(`WebSocket registered for device: ${rootIds.join(', ')}`);

    ws.on('message', (message) => {
      const text = message.toString();
      if (text === 'ESP32') controllerSockets.add(ws);
      if (controllerSockets.has(ws) && text.startsWith('{')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === 'object') {
          const data = parsed as Record<string, unknown>;
          // wynik polecenia dla QNAP-a: do dziennika tylko id i status, bez odpowiedzi QNAP-a
          console.log(`Received from controller [${ip}]: ${String(data.typ ?? '?')} ${String(data.id ?? '')} ${String(data.status ?? '')}`.trim());
          controllerListeners.forEach((listener) => listener(rootIds, data));
          return;
        }
      }
      console.log(`Received from client [${ip}]:`, text);
    });

    ws.on('close', () => {
      console.log(`Client disconnected: ${ip}`);
      espClients.delete(ws);
      controllerSockets.delete(ws);
    });
  });

}

// Wysyła {type: message, rootId} do połączeń danego urządzenia z opóźnieniem 1 s,
// czyli już po zakończeniu bieżącego żądania (zapis w bazie, odpowiedź HTTP).
// Nie czeka na dostarczenie i nie kolejkuje: niepołączony odbiorca go nie dostanie.
export const sendMessage = async (message: String, rootId: string) => {
 if (!message) {
    return;
  }
  const payload = JSON.stringify({ type: String(message), rootId });
  setTimeout(() => {
    espClients.forEach((clientRootIds, client) => {
      if (clientRootIds.includes(rootId) && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }, 1000);
}
