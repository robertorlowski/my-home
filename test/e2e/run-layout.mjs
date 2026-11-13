// Układ widoków wszystkich rodzajów sterowników (pompa ciepła, piec, hydrofor, włącznik, fotowoltaika) na lokalnym
// chpc-web: dla każdego rodzaju z lokalnej bazy każdy widok przy 360, 768 i 1280 px, w motywie ciemnym i jasnym —
// strona bez przewijania w poziomie (wyjątek: tabele i wykresy we własnym przewijanym kontenerze), żaden element nie
// wystaje poza okno, bez błędów konsoli, zrzut ekranu. Od 2026-10-16 (nowy wygląd): także pasek górny, boczne menu na
// komputerze i dolna nawigacja na telefonie.
//
// Wymaga uruchomionego "npm run local" i urządzeń w bazie lokalnej (np. scripts/seed-local.mjs, scripts/seed-pv-local.mjs
// --keep, symulatory). Logowanie: konto systemowe bez hasła (od 2026-11-13) kodem awaryjnym z polecenia serwera
// (npm run kod-awaryjny -w server) na bazie lokalnej npm run local albo E2E_MONGODB_URI, w przeglądarce „system” →
// „Mam już kod” → kod. Przeglądarka: Chromium Playwright, albo BROWSER_CHANNEL=msedge (chrome: systemowy Chrome).
// Wyniki: test/raport-testow/uklad-wyniki.json i zrzuty test/raport-testow/zrzuty/uklad-<rodzaj>-<widok>-<szerokość>-<motyw>.png (poza gitem).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'raport-testow');
const SHOTS = join(OUT, 'zrzuty');
mkdirSync(SHOTS, { recursive: true });

const API = 'http://localhost:4001/api';
const WEB = 'http://localhost:5173';
// baza serwera z npm run local (scripts/local-dev.mjs, LOCAL_DB_URI)
const DB = process.env.E2E_MONGODB_URI ?? 'mongodb://127.0.0.1:27027/chpc-local';
// kod konta system z polecenia awaryjnego (core/cli.ts): jednorazowy, ważny 5 min, bez poczty
const systemCode = () => {
  const out = execFileSync('npm', ['run', '--silent', 'kod-awaryjny', '-w', 'server'], {
    cwd: join(HERE, '..', '..'), env: { ...process.env, MONGODB_URI: DB }, encoding: 'utf8', shell: true,
  });
  const code = /(\d{3}) (\d{3})/.exec(out)?.slice(1).join('');
  if (!code) throw new Error(`Brak kodu awaryjnego w wyniku polecenia: ${out}`);
  return code;
};
const WIDTHS = [360, 768, 1280];
const THEMES = ['dark', 'light'];
// widoki z menu rodzaju (client/src/devices/<rodzaj>/device-type.tsx)
const VIEWS = {
  heat_pump: ['/', '/data', '/chart', '/schedules', '/operations', '/settings'],
  'pellet-boiler-pelux200': ['/', '/data', '/chart', '/schedules', '/alarms', '/operations', '/settings'],
  'water-pressure-tank': ['/', '/data', '/chart', '/operations', '/settings'],
  switch: ['/', '/data', '/schedules', '/operations', '/settings'],
  photovoltaic: ['/', '/data', '/chart', '/settings'],
};
// strony bez sterownika
const PAGES = ['/devices', '/account'];

const results = [];
const check = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail) });
  console.log('[uklad]', ok ? 'OK  ' : 'BŁĄD', step, detail ? `- ${detail}` : '');
};

// lista sterowników: po zalogowaniu, z tokenem sesji z przeglądarki (konta użytkowników: bez niego 401)
let devices = [];
const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});

// elementy wychodzące poza okno (poza przewijanymi kontenerami: tabele, wykresy) i przewijanie strony w poziomie
const measure = () => {
  const vw = document.documentElement.clientWidth;
  const scrollable = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
    }
    return false;
  };
  const over = [...document.querySelectorAll('body *')]
    .filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'
        && (b.right > vw + 1 || b.left < -1) && !scrollable(e);
    })
    .slice(0, 5)
    .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''} (${Math.round(e.getBoundingClientRect().right)} px)`);
  const header = document.querySelector('header.app-header');
  const side = document.querySelector('nav.app-tabs');
  const bottom = document.querySelector('nav.bottom-nav');
  const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  return { scrollWidth: document.documentElement.scrollWidth, vw, over, path: location.pathname,
    header: visible(header), side: visible(side), bottom: visible(bottom) };
};

for (const theme of THEMES) {
  const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.addInitScript(() => sessionStorage.setItem('chpc.defaultApplied', '1'));

  // logowanie kontem systemowym bez hasła: „system” w polu e-mail, „Mam już kod”, kod awaryjny
  await page.goto(`${WEB}/`);
  await page.waitForTimeout(1500);
  if (await page.locator('input').count()) {
    await page.fill('input', 'system');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^(Mam już kod|I already have a code)$/ }).click();
    await page.fill('input.code', systemCode());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const no = page.getByRole('button', { name: /^Nie/ });
    if (await no.count()) await no.first().click();
  }
  check(`${theme}: zalogowano`, await page.locator('header.app-header').count() > 0);
  devices = await page.evaluate(async (api) => {
    const token = localStorage.getItem('chpc.session') ?? sessionStorage.getItem('chpc.session');
    const r = await fetch(`${api}/devices`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return r.ok ? r.json() : [];
  }, API);
  check(`${theme}: lista sterowników (${devices.length})`, devices.length > 0);

  // nawigacja wewnątrz aplikacji (React Router), bez przeładowania: wejście na „/” z adresu cofa na listę
  const open = (path) => page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);

  const testView = async (label, view, device) => {
    for (const width of WIDTHS) {
      consoleErrors.length = 0;
      await page.setViewportSize({ width, height: 900 });
      await open(view);
      await page.waitForTimeout(2200);
      const r = await page.evaluate(measure);
      const name = `uklad-${label}-${view === '/' ? 'glowny' : view.slice(1)}-${width}-${theme}`;
      await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
      const ok = r.scrollWidth <= r.vw + 1 && r.over.length === 0;
      check(`${label} ${view} @ ${width}px ${theme}: bez przewijania w poziomie`, ok,
        ok ? '' : `szerokość ${r.scrollWidth}px > ${r.vw}px; ${r.over.join('; ')}`);
      const errors = consoleErrors.filter((e) => !/Warning:|width\(0\) and height\(0\)/.test(e));
      check(`${label} ${view} @ ${width}px ${theme}: bez błędów konsoli`, errors.length === 0, errors.slice(0, 3).join(' | '));
      check(`${label} ${view} @ ${width}px ${theme}: widok otwarty (bez przekierowania)`, r.path === view, r.path);
      check(`${label} ${view} @ ${width}px ${theme}: pasek górny`, r.header);
      if (device) {
        if (width >= 900) check(`${label} ${view} @ ${width}px ${theme}: boczne menu, bez dolnej nawigacji`, r.side && !r.bottom, `menu ${r.side}, dół ${r.bottom}`);
        else check(`${label} ${view} @ ${width}px ${theme}: dolna nawigacja, bez bocznego menu`, r.bottom && !r.side, `menu ${r.side}, dół ${r.bottom}`);
      }
    }
  };

  for (const view of PAGES) await testView('strona', view, false);

  for (const [type, views] of Object.entries(VIEWS)) {
    const device = devices.find((d) => d.deviceType === type);
    if (!device) {
      check(`${type}: urządzenie w bazie lokalnej`, false, 'brak — pominięto widoki');
      continue;
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('/devices');
    await page.waitForTimeout(1200);
    // wybór kafelka jak użytkownik (zapisuje chpc.selectedDevice i otwiera widok główny); po nazwie z pola kafelka,
    // bo has-text na całej karcie łapie też np. „brak pogody z włącznika” na kafelku Dom
    const tile = page.locator(`.device-card:has(.tt-f-name:has-text("${device.name || device.deviceId}")) button.device-choose`).first();
    if (await tile.count()) await tile.click(); else {
      await page.evaluate((d) => localStorage.setItem('chpc.selectedDevice', JSON.stringify(d)),
        { rootId: device.rootId, deviceId: device.deviceId, deviceType: device.deviceType, name: device.name ?? '' });
    }
    await page.waitForTimeout(1500);
    for (const view of views) await testView(type, view, true);
  }
  await context.close();
}

await browser.close();
writeFileSync(join(OUT, 'uklad-wyniki.json'), JSON.stringify({ results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`[uklad] WYNIK: ${results.length - failed.length}/${results.length} sprawdzeń OK`);
process.exit(failed.length ? 1 : 0);
