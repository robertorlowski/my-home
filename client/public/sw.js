// Service worker aplikacji (PWA, 2026-10-21): powłoka aplikacji z pamięci podręcznej (działa bez sieci i spełnia
// wymagania instalacji Chrome / Androida), strona „Brak połączenia” i odbiór powiadomień Web Push
// (core/services/push.service.ts) z otwarciem aplikacji po kliknięciu. Rejestruje go index.tsx (tylko build produkcyjny)
// i core/push.ts (przy „Włącz na tym urządzeniu”). API (inny adres, /api/) i WebSocket nie są buforowane.
//
// Strategie: nawigacje (index.html) — najpierw sieć z limitem NETWORK_TIMEOUT_MS, potem kopia z pamięci, na końcu
// wbudowana strona offline; /assets/ (pliki z hashem w nazwie z Vite) — najpierw pamięć; pozostałe pliki własne
// (ikony, manifest) — pamięć, a w tle odświeżenie. Pliki dev Vite (/src/, /@vite/, /node_modules/) są pomijane.
const CACHE = 'myhome-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
const NETWORK_TIMEOUT_MS = 5000;
// serwery (Render, vite preview) odsyłają Vary: Origin, a żądanie modułu ma nagłówek Origin, którego nie miało żądanie
// zapisujące — bez ignoreVary dopasowanie w pamięci nie trafia i aplikacja bez sieci ma pustą stronę
const MATCH = { ignoreVary: true };

const OFFLINE_HTML = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mój Dom – brak połączenia</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f2f4;color:#1e2126;font:16px/1.5 Barlow,system-ui,sans-serif}
main{max-width:360px;padding:32px 24px;text-align:center}h1{font-size:22px;margin:16px 0 8px}p{margin:0 0 20px;color:#5c6370}
button{font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:8px;background:#c7791c;color:#fff;cursor:pointer}
img{width:72px;height:72px;border-radius:16px}</style></head><body><main><img src="/icon-192.png" alt="">
<h1>Brak połączenia</h1><p>Aplikacja nie może połączyć się z serwerem. Sprawdź sieć i spróbuj ponownie.</p>
<button onclick="location.reload()">Spróbuj ponownie</button></main></body></html>`;

// Pliki /assets/ z index.html (skrypt i style z hashem z Vite): przy pierwszym otwarciu ładują się przed aktywacją
// service workera, więc bez tego nie trafiłyby do pamięci i aplikacja bez sieci miałaby pustą stronę.
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL).catch(() => undefined);
  try {
    const html = await (await fetch('/index.html', { cache: 'no-cache' })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
  } catch { /* bez sieci: pliki trafią do pamięci przy kolejnym otwarciu */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

async function navigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put('/index.html', response.clone());
    return response;
  } catch {
    const cached = await cache.match('/index.html', MATCH);
    return cached || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, MATCH);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, MATCH);
  const refresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/node_modules/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// treść z serwera: {title, body, url, tag, event, at}; tag = sterownik:zdarzenie, więc nowe powiadomienie tego samego
// rodzaju zastępuje poprzednie zamiast układać się w stos
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Mój Dom';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    timestamp: data.at ? Date.parse(data.at) : Date.now(),
    data: { url: data.url || '/devices' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// kliknięcie: istniejące okno aplikacji dostaje adres, inaczej nowe okno
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/devices', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => 'focus' in client);
      if (open) {
        return open.focus().then((client) => (client && 'navigate' in client ? client.navigate(url) : undefined));
      }
      return self.clients.openWindow(url);
    }),
  );
});
