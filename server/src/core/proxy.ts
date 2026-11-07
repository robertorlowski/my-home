// Tryb pośrednika (PROXY_TARGET): proces nie uruchamia aplikacji ani nie łączy się z bazą, tylko przekazuje HTTP
// i WebSocket na serwer docelowy. Render przekazuje tak ruch sterowników ze starym adresem, dopóki nie dostaną nowego firmware.
// Przy awarii celu odpowiedź to zawsze 502: 404 i 409 kasują w sterownikach Root ID, więc tych kodów pośrednik sam nie wysyła.
import http from 'http';
import https from 'https';
import type { Duplex } from 'stream';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const REQUEST_TIMEOUT_MS = 60_000;
const UNAVAILABLE = JSON.stringify({ message: 'Serwer docelowy jest niedostępny.' });

const withoutHopByHop = (headers: http.IncomingHttpHeaders) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));

const refuse = (socket: Duplex, status: number, message: string) => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

export const createProxyServer = (targetUrl: string) => {
  const target = new URL(targetUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true });

  const targetRequest = (req: http.IncomingMessage) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    const address = req.socket.remoteAddress ?? '';
    return {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: {
        ...withoutHopByHop(req.headers),
        // Host celu: serwer buduje z niego adres pliku firmware, który sterownik pobiera już bezpośrednio z celu
        host: target.host,
        'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${address}` : address,
        'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
      },
    };
  };

  const server = http.createServer((req, res) => {
    const upstream = transport.request({ ...targetRequest(req), agent, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      res.writeHead(response.statusCode ?? 502, withoutHopByHop(response.headers));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('przekroczony czas odpowiedzi')));
    upstream.on('error', (error) => {
      if (res.destroyed) return;
      console.error(`[pośrednik] ${req.method} ${req.url?.split('?')[0]}: ${error.message}`);
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(UNAVAILABLE);
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const { headers, ...options } = targetRequest(req);
    const upstream = transport.request({ ...options, agent: false, headers: { ...headers, connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' } });

    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);

      const closeBoth = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', closeBoth);
      socket.on('close', closeBoth);
      upstreamSocket.on('error', closeBoth);
      upstreamSocket.on('close', closeBoth);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // Cel odmówił WebSocket (np. 401): ten sam kod dla sterownika
    upstream.on('response', (response) => {
      response.resume();
      refuse(socket, response.statusCode ?? 502, response.statusMessage ?? 'Bad Gateway');
    });
    upstream.on('error', (error) => {
      console.error(`[pośrednik] WebSocket ${req.url?.split('?')[0]}: ${error.message}`);
      refuse(socket, 502, 'Bad Gateway');
    });
    socket.once('error', () => upstream.destroy());
    upstream.end();
  });

  return server;
};
