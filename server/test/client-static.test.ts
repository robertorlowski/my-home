// Pliki klienta z serwera (core/client-static.ts, obraz Dockera): nagłówki pamięci podręcznej, ścieżki aplikacji
// jednostronicowej i to, że /api oraz /assets nigdy nie dostają index.html.
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveClient } from '../src/core/client-static';

describe('pliki klienta z serwera', () => {
  let dir: string;
  const app = express();

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, '.well-known'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>aplikacja</html>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc.js'), 'skrypt()');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'sw()');
    fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
    fs.writeFileSync(path.join(dir, '.well-known', 'assetlinks.json'), '[]');
    app.get('/api/istnieje', (_req, res) => void res.json({ ok: true }));
    serveClient(app, dir);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(['/', '/devices', '/hp/2026-11-07'])('%s to index.html bez długiej pamięci', async (url) => {
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.text).toContain('aplikacja');
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('pliki z hashem mogą leżeć w pamięci długo', async () => {
    const response = await request(app).get('/assets/app-abc.js');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('service worker i manifest są zawsze sprawdzane', async () => {
    expect((await request(app).get('/sw.js')).headers['cache-control']).toBe('no-cache');
    const manifest = await request(app).get('/manifest.webmanifest');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
  });

  it('podaje .well-known dla aplikacji Android', async () => {
    expect((await request(app).get('/.well-known/assetlinks.json')).status).toBe(200);
  });

  it('brakujący plik /assets to 404, nie strona HTML', async () => {
    expect((await request(app).get('/assets/stary-123.js')).status).toBe(404);
  });

  it('nieznane /api to 404, nie strona HTML', async () => {
    for (const url of ['/api', '/api/nie-ma', '/api/hp/add?rootId=abc']) {
      const response = await request(app).get(url);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('aplikacja');
    }
    expect((await request(app).get('/api/istnieje')).body).toEqual({ ok: true });
  });
});
