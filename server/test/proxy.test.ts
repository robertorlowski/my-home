// Testy trybu pośrednika (core/proxy.ts): przekazywanie HTTP i WebSocket na lokalny serwer docelowy,
// kody odpowiedzi bez zmian, 502 przy awarii celu (nigdy 404 ani 409, bo te kasują w sterownikach Root ID).
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProxyServer } from '../src/core/proxy';

const listen = (server: http.Server) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
const close = (server: http.Server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});

describe('tryb pośrednika', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  let target: http.Server;
  let wss: WebSocketServer;
  let proxy: http.Server;
  let targetPort: number;
  let proxyUrl: string;

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      if (req.url === '/big') return void res.end(big);
      if (req.url?.startsWith('/status/')) {
        res.statusCode = Number(req.url.split('/')[2]);
        return void res.end('{}');
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-z-celu', 'tak');
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
      });
    });
    wss = new WebSocketServer({ server: target });
    wss.on('connection', (ws, req) => {
      ws.send(`url ${req.url}`);
      ws.on('message', (message) => ws.send(`echo ${message}`));
    });
    targetPort = await listen(target);
    proxy = createProxyServer(`http://127.0.0.1:${targetPort}`);
    proxyUrl = `127.0.0.1:${await listen(proxy)}`;
  });

  afterAll(async () => {
    wss.clients.forEach((client) => client.terminate());
    await close(proxy);
    await close(target);
  });

  it('przekazuje metodę, adres, treść i nagłówki', async () => {
    const response = await fetch(`http://${proxyUrl}/api/hp/add?rootId=abc&deviceId=F8`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-z-celu')).toBe('tak');
    const echo = await response.json();
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/api/hp/add?rootId=abc&deviceId=F8');
    expect(echo.body).toBe('{"a":1}');
    expect(echo.headers.authorization).toBe('Bearer t');
    // Host celu: adres pliku firmware w ofercie ma wskazywać serwer docelowy
    expect(echo.headers.host).toBe(`127.0.0.1:${targetPort}`);
    expect(echo.headers['x-forwarded-proto']).toBe('https');
    expect(echo.headers['x-forwarded-for']).toMatch(/^203\.0\.113\.5, .*127\.0\.0\.1$/);
  });

  it('zostawia kody odpowiedzi celu', async () => {
    for (const status of [401, 404, 409, 500]) {
      expect((await fetch(`http://${proxyUrl}/status/${status}`)).status).toBe(status);
    }
  });

  it('przekazuje dużą odpowiedź w całości', async () => {
    expect((await (await fetch(`http://${proxyUrl}/big`)).text()).length).toBe(big.length);
  });

  it('przekazuje WebSocket w obie strony, z adresem i parametrami', async () => {
    const ws = new WebSocket(`ws://${proxyUrl}/?rootId=abc`);
    const messages: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      ws.on('message', (message) => {
        messages.push(message.toString());
        if (messages.length === 1) ws.send('ping');
        if (messages.length === 2) resolve();
      });
      ws.on('error', reject);
    });
    await done;
    ws.close();
    expect(messages).toEqual(['url /?rootId=abc', 'echo ping']);
  });

  describe('gdy cel nie działa', () => {
    let deadProxy: http.Server;
    let deadUrl: string;

    beforeAll(async () => {
      const free = http.createServer();
      const deadPort = await listen(free);
      await close(free);
      deadProxy = createProxyServer(`http://127.0.0.1:${deadPort}`);
      deadUrl = `127.0.0.1:${await listen(deadProxy)}`;
    });

    afterAll(() => close(deadProxy));

    it('odpowiada 502', async () => {
      expect((await fetch(`http://${deadUrl}/api/hp/add`, { method: 'POST', body: '{}' })).status).toBe(502);
    });

    it('odrzuca WebSocket kodem 502', async () => {
      const status = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${deadUrl}/?rootId=abc`);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
        ws.on('error', () => undefined);
      });
      expect(status).toBe(502);
    });
  });
});
