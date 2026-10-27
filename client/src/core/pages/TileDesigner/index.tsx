// NIEUŻYWANE od 2026-10-17: lista rysuje kafelki w stałym układzie makiety (DeviceTileCard), przycisk „Projekt kafelka”
// jest ukryty, trasa i API wzoru (PUT /api/devices/tile-template) zostają w kodzie na wypadek powrotu do pomysłu.
// Strona /tile-designer: projektant kafelka listy sterowników (przycisk „Projekt kafelka” w trybie „Zmień kolejność”
// na /devices). Jeden kafelek z danymi wybranego sterownika (GET /api/devices i /devices/summary): pole przesuwa się
// przeciągnięciem, rozmiar zmienia narożnik albo pola liczbowe (px kafelka o rozmiarze ze wzoru), Shift + strzałki
// rozmiar, strzałki położenie. Sprawdzanie na kafelkach wszystkich sterowników: pola z treścią nachodzące na siebie,
// tekst, który się nie mieści, i pola na ołówku i trybiku (prawy dolny róg). Pod spodem podgląd listy i telefonu.
// „Zapisz” wysyła wzór na serwer (PUT /api/devices/tile-template), lista używa go od następnego wejścia.
import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { DeviceRequests } from '../../api';
import { Device, DeviceTiles } from '../../types';
import { IconButton } from '../../components/IconButton';
import { BackIcon } from '../../components/icons';
import Notification from '../../components/Notification';
import { deviceSlots, TemplateTile } from '../../components/TemplateTile';
import {
  cacheTemplate, cloneTemplate, normalizeTemplate, TILE_SLOT_KEYS, TILE_SLOTS, TILE_TEMPLATE, TILE_TOOLS_AREA,
  TileField, TileSlot, TileTemplate,
} from '../../tile-template';
import { tileName } from '../Devices';
import './style.css';

type Box = Pick<TileField, 'x' | 'y' | 'w' | 'h'>;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pl = (value: number, digits = 1) => value.toLocaleString('pl-PL', { maximumFractionDigits: digits });

type Problem = { tile: string; slot: TileSlot; kind: 'overflow' | 'overlap' | 'tools'; other?: TileSlot };

// wzór kafelka jest wspólny dla wszystkich kont: projektant tylko dla użytkownika systemowego (serwer też odrzuca zapis)
export const TileDesigner: React.FC = () => {
  const { user } = useAuth();
  return user?.isSystem ? <TileDesignerEditor /> : <Navigate to="/devices" replace />;
};

const TileDesignerEditor: React.FC = () => {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [tiles, setTiles] = useState<DeviceTiles>({});
  const [saved, setSaved] = useState<TileTemplate>(TILE_TEMPLATE);
  const [draft, setDraft] = useState<TileTemplate>(cloneTemplate(TILE_TEMPLATE));
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<TileSlot>('main');
  const [sample, setSample] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [textBox, setTextBox] = useState<'export' | 'import' | null>(null);
  const [text, setText] = useState('');
  const [textMsg, setTextMsg] = useState('');
  const now = useRef(Date.now()).current;

  useEffect(() => {
    Promise.all([DeviceRequests.getDevices(), DeviceRequests.getDeviceTiles(), DeviceRequests.getTileTemplate()])
      .then(([list, summary, stored]) => {
        if (list) { setDevices(list); setSample((current) => current || list[0]?.rootId || ''); }
        if (summary) setTiles(summary);
        const template = normalizeTemplate(stored) ?? TILE_TEMPLATE;
        setSaved(template);
        setDraft(cloneTemplate(template));
        if (!list || stored === undefined) setError('Nie udało się pobrać sterowników albo wzoru z serwera.');
      })
      .finally(() => setLoaded(true));
  }, []);

  const update = (change: (next: TileTemplate) => void) => setDraft((current) => {
    const next = cloneTemplate(current);
    change(next);
    return next;
  });
  const updateField = (change: (field: TileField, template: TileTemplate) => void) =>
    update((next) => change(next.f[sel], next));

  // ---------- scena: szerokość kafelka w projektancie (powiększony do 1,6×, gdy jest miejsce) ----------
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);
  const displayWidth = Math.max(200, Math.min((stageWidth || draft.w) - 8, draft.w * 1.6));
  const zoom = displayWidth / draft.w;

  // ---------- przeciąganie pola i narożnika (wartości przyciągane do pełnych px kafelka ze wzoru) ----------
  const tileRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ slot: TileSlot; resize: boolean; x: number; y: number; start: TileField } | null>(null);
  const snapX = (value: number) => Math.round(value * draft.w / 100) * 100 / draft.w;
  const snapY = (value: number) => Math.round(value * draft.h / 100) * 100 / draft.h;
  const onPointerDown = (event: React.PointerEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-slot]');
    if (!target) return;
    event.preventDefault();
    const slot = target.dataset.slot as TileSlot;
    setSel(slot);
    drag.current = { slot, resize: !!(event.target as HTMLElement).closest('[data-resize]'), x: event.clientX, y: event.clientY, start: { ...draft.f[slot] } };
    tileRef.current?.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    const rect = tileRef.current?.getBoundingClientRect();
    if (!current || !rect) return;
    const dx = (event.clientX - current.x) / rect.width * 100;
    const dy = (event.clientY - current.y) / rect.height * 100;
    const o = current.start;
    update((next) => {
      const field = next.f[current.slot];
      if (current.resize) {
        field.w = snapX(Math.max(1, Math.min(100 - o.x, o.w + dx)));
        field.h = snapY(Math.max(3, Math.min(100 - o.y, o.h + dy)));
      } else {
        field.x = snapX(Math.max(0, Math.min(100 - o.w, o.x + dx)));
        field.y = snapY(Math.max(0, Math.min(100 - o.h, o.y + dy)));
      }
    });
  };
  const endDrag = () => { drag.current = null; };

  // strzałki: położenie o 1 px, Shift + strzałki: rozmiar (gdy kursor jest nad kafelkiem)
  const hover = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!hover.current || !event.key.startsWith('Arrow')) return;
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!step) return;
      event.preventDefault();
      const sx = 100 / draft.w, sy = 100 / draft.h;
      updateField((field) => {
        if (event.shiftKey) {
          field.w = Math.max(sx, Math.min(100 - field.x, field.w + step[0] * sx));
          field.h = Math.max(3, Math.min(100 - field.y, field.h + step[1] * sy));
        } else {
          field.x = Math.max(0, Math.min(100 - field.w, field.x + step[0] * sx));
          field.y = Math.max(0, Math.min(100 - field.h, field.y + step[1] * sy));
        }
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ---------- sprawdzanie na kafelkach wszystkich sterowników (ukryte kafelki o rozmiarze ze wzoru) ----------
  const measureRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const found: Problem[] = [];
    devices.forEach((device) => {
      const label = tileName(device, devices);
      const slots = deviceSlots(device.deviceType, label, tiles[device.rootId], now);
      const shown = TILE_SLOT_KEYS.filter((key) => draft.f[key].v && (key === 'divider' || slots[key] != null));
      shown.forEach((a, index) => shown.slice(index + 1).forEach((b) => {
        if (overlaps(draft.f[a], draft.f[b])) found.push({ tile: label, slot: a, kind: 'overlap', other: b });
      }));
      shown.forEach((key) => { if (overlaps(draft.f[key], TILE_TOOLS_AREA)) found.push({ tile: label, slot: key, kind: 'tools' }); });
      root.querySelectorAll<HTMLElement>(`[data-root="${device.rootId}"] .tt-f`).forEach((element) => {
        const fontSize = parseFloat(getComputedStyle(element).fontSize) || 0;
        const inner = [...element.querySelectorAll<HTMLElement>('.tt-ellipsis, .tt-note > span, .tt-relay small')];
        const tooWide = element.scrollWidth > element.clientWidth + 1 || inner.some((e) => e.scrollWidth > e.clientWidth + 1);
        // wartość główna ma podpisy pod liczbami i obniżoną ikonę (celowo poza polem), więc tylko szerokość
        const tooTall = element.dataset.slot !== 'main'
          && (element.scrollHeight > element.clientHeight + fontSize * 0.15 || inner.some((e) => e.scrollHeight > e.clientHeight + 1));
        if (tooWide || tooTall) found.push({ tile: label, slot: element.dataset.slot as TileSlot, kind: 'overflow' });
      });
    });
    setProblems((current) => same(current, found) ? current : found);
  }, [draft, devices, tiles, now]);

  const badSlots = new Set<TileSlot>(problems.flatMap((problem) => problem.other ? [problem.slot, problem.other] : [problem.slot]));
  const report = (() => {
    const groups: string[] = [];
    const describe = (kind: Problem['kind'], title: string, text: (p: Problem) => string) => {
      const items = problems.filter((p) => p.kind === kind);
      if (!items.length) return;
      const byText = new Map<string, Set<string>>();
      items.forEach((p) => { const key = text(p); byText.set(key, (byText.get(key) ?? new Set()).add(p.tile)); });
      groups.push(`${title}: ${[...byText].map(([key, names]) => `${key} (${[...names].join(', ')})`).join('; ')}.`);
    };
    describe('overlap', 'Nachodzą na siebie', (p) => `${TILE_SLOTS[p.slot].label} i ${TILE_SLOTS[p.other!].label}`);
    describe('overflow', 'Tekst się nie mieści', (p) => TILE_SLOTS[p.slot].label);
    describe('tools', 'Pod ołówkiem i trybikiem', (p) => TILE_SLOTS[p.slot].label);
    return groups;
  })();

  const dirty = !same(draft, saved);
  const field = draft.f[sel];
  const px = (value: number, base: number) => Math.round(value * base / 100);
  const fontPx = TILE_SLOTS[sel].k ? field.h / 100 * draft.h * TILE_SLOTS[sel].k : 0;
  const sampleDevice = devices.find((device) => device.rootId === sample) ?? devices[0];

  // proporcjonalna zmiana rozmiaru: szerokość, wysokość i odstęp razem (pola w %, czcionki z wysokości)
  const scaleBase = useRef<TileTemplate | null>(null);
  const [scale, setScale] = useState(100);
  const scaled = (base: TileTemplate, k: number) => ({
    ...base, w: Math.max(240, Math.round(base.w * k)), h: Math.max(120, Math.round(base.h * k)), gap: Math.round((base.gap ?? 0) * k),
  });

  const save = async () => {
    setSaving(true);
    try {
      const result = await DeviceRequests.saveTileTemplate(draft);
      const template = normalizeTemplate(result.template) ?? draft;
      setSaved(template);
      setDraft(cloneTemplate(template));
      cacheTemplate(template);
      setError('');
      setNotice('Wzór zapisany. Lista sterowników używa go od teraz.');
    } catch (failure) {
      setError(`Nie udało się zapisać wzoru${(failure as { serverMessage?: string }).serverMessage ? `: ${(failure as { serverMessage?: string }).serverMessage}` : '.'}`);
    } finally {
      setSaving(false);
    }
  };

  const openText = (mode: 'export' | 'import') => {
    setTextBox(mode);
    if (mode === 'export') {
      const value = JSON.stringify(draft);
      setText(value);
      setTextMsg('Wzór jest poniżej; skopiuj go (Ctrl+C).');
      navigator.clipboard?.writeText(value).then(() => setTextMsg('Skopiowano do schowka.'), () => undefined);
    } else {
      setText('');
      setTextMsg('Wklej wzór i kliknij „Wczytaj”.');
    }
  };
  const loadText = () => {
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* zły JSON */ }
    const template = normalizeTemplate(parsed);
    if (!template) { setTextMsg('To nie jest wzór kafelka.'); return; }
    setDraft(template);
    setTextMsg('Wzór wczytany. Zapisz go, żeby lista go używała.');
  };

  const previewCard = { '--tile-basis': `${Math.round(draft.w * 300 / 340)}px`, '--tile-max': `${draft.w}px` } as CSSProperties;

  return (
    <div className="tile-designer">
      <Notification message={notice} />
      <div className="tile-designer-header">
        <IconButton label="Wróć do listy sterowników" icon={<BackIcon />} onClick={() => navigate('/devices')} />
        <h2>Projekt kafelka</h2>
        <span className="tile-designer-spacer" aria-hidden="true" />
      </div>
      <p className="tile-designer-lead">
        Przeciągnij pole, żeby je przesunąć, a narożnikiem zmień jego rozmiar (czcionka rośnie z wysokością pola).
        Czerwona ramka: pola nachodzą na siebie, tekst się nie mieści albo pole wchodzi na ołówek i trybik
        w którymś kafelku. Wzór obowiązuje wszystkie kafelki na liście.
      </p>
      {error && <p className="tile-designer-error" role="alert">{error}</p>}

      <div className="tile-designer-grid">
        <section className="tile-designer-stage" ref={stageRef}>
          <label className="tile-designer-sample">Dane z kafelka
            <select value={sampleDevice?.rootId ?? ''} onChange={(event) => setSample(event.target.value)}>
              {devices.map((device) => <option key={device.rootId} value={device.rootId}>{tileName(device, devices)}</option>)}
            </select>
          </label>
          {sampleDevice && (
            <div className="tile-designer-card" style={{ width: displayWidth }} ref={tileRef}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
              onPointerEnter={() => { hover.current = true; }} onPointerLeave={() => { hover.current = false; }}>
              <TemplateTile template={draft} deviceType={sampleDevice.deviceType} name={tileName(sampleDevice, devices)}
                tile={tiles[sampleDevice.rootId]} now={now} design={{ selected: sel, bad: badSlots }}>
                <span className="tile-designer-tools" aria-hidden="true" style={{
                  left: `${TILE_TOOLS_AREA.x}%`, top: `${TILE_TOOLS_AREA.y}%`, width: `${TILE_TOOLS_AREA.w}%`, height: `${TILE_TOOLS_AREA.h}%`,
                }}>ołówek, trybik</span>
              </TemplateTile>
            </div>
          )}
          <span className="tile-designer-note">
            {zoom > 1.01 ? `Podgląd powiększony ×${pl(zoom, 2)}; wartości w px dotyczą kafelka ${draft.w} × ${draft.h} px.` : `Kafelek ${draft.w} × ${draft.h} px.`}
          </span>
          <p className={`tile-designer-report ${report.length ? 'bad' : 'ok'}`}>
            {report.length ? report.join(' ') : 'Wszystkie kafelki mieszczą się w tym wzorze i żadne pola na siebie nie nachodzą.'}
          </p>
        </section>

        <aside className="tile-designer-inspector">
          <h3>Kafelek</h3>
          <div className="tile-designer-row2">
            <label>Szerokość {draft.w} px
              <input type="range" min={240} max={600} step={2} value={draft.w} onChange={(event) => update((next) => { next.w = +event.target.value; })} />
            </label>
            <label>Wysokość {draft.h} px
              <input type="range" min={120} max={450} step={2} value={draft.h} onChange={(event) => update((next) => { next.h = +event.target.value; })} />
            </label>
            <label className="wide">Rozmiar proporcjonalnie {scale} %
              <input type="range" min={40} max={160} step={1} value={scale}
                onChange={(event) => {
                  if (!scaleBase.current) scaleBase.current = cloneTemplate(draft);
                  setScale(+event.target.value);
                  setDraft(scaled(scaleBase.current, +event.target.value / 100));
                }}
                onPointerUp={() => { scaleBase.current = null; setScale(100); }}
                onKeyUp={() => { scaleBase.current = null; setScale(100); }} />
            </label>
            <div className="tile-designer-actions wide">
              <button type="button" onClick={() => setDraft(scaled(draft, 0.9))}>Zmniejsz o 10 %</button>
              <button type="button" onClick={() => setDraft(scaled(draft, 1 / 0.9))}>Powiększ o 10 %</button>
            </div>
            <label className="wide">Odstęp między kafelkami {draft.gap ?? 0} px
              <input type="range" min={0} max={40} step={1} value={draft.gap ?? 0} onChange={(event) => update((next) => { next.gap = +event.target.value; })} />
            </label>
          </div>

          <h3>Pole: {TILE_SLOTS[sel].label}</h3>
          <div className="tile-designer-row2">
            {([['X (px)', 'x', 'w', 0], ['Y (px)', 'y', 'h', 0], ['Szerokość (px)', 'w', 'w', 4], ['Wysokość (px)', 'h', 'h', 4]] as const).map(([label, key, dim, min]) => (
              <label key={key}>{label}
                <input type="number" min={min} value={px(field[key], draft[dim])} onChange={(event) => updateField((f, t) => {
                  const value = Math.max(min, +event.target.value || 0) * 100 / t[dim];
                  const limit = { x: 100 - f.w, y: 100 - f.h, w: 100 - f.x, h: 100 - f.y }[key];
                  f[key] = Math.min(value, limit);
                })} />
              </label>
            ))}
            <label>Wyrównanie
              <select value={field.a} onChange={(event) => updateField((f) => { f.a = event.target.value as TileField['a']; })}>
                <option value="left">do lewej</option>
                <option value="center">do środka</option>
                <option value="right">do prawej</option>
              </select>
            </label>
            <label>Czcionka<span className="tile-designer-value">{fontPx ? `${pl(fontPx)} px` : '—'}</span></label>
          </div>
          <span className="tile-designer-note">Strzałki przesuwają zaznaczone pole o 1 px, Shift + strzałki zmieniają jego rozmiar.</span>

          <h3>Pola (odznacz, żeby ukryć)</h3>
          <div className="tile-designer-fields">
            {TILE_SLOT_KEYS.map((key) => (
              <label key={key} className={`${key === sel ? 'current' : ''}${badSlots.has(key) ? ' bad' : ''}`}
                onClick={(event) => { if ((event.target as HTMLElement).tagName !== 'INPUT') { event.preventDefault(); setSel(key); } }}>
                <input type="checkbox" checked={draft.f[key].v}
                  onChange={(event) => { setSel(key); update((next) => { next.f[key].v = event.target.checked; }); }} />
                {TILE_SLOTS[key].label}
              </label>
            ))}
          </div>

          <div className="tile-designer-actions">
            <button type="button" onClick={() => openText('export')}>Kopiuj wzór</button>
            <button type="button" onClick={() => openText('import')}>Wklej wzór</button>
            <button type="button" onClick={() => setDraft(cloneTemplate(TILE_TEMPLATE))}>Domyślny wzór</button>
            <button type="button" disabled={!dirty} onClick={() => setDraft(cloneTemplate(saved))}>Cofnij zmiany</button>
            <button type="button" className="primary" disabled={!dirty || saving || !loaded} onClick={save}>Zapisz</button>
          </div>
          {textBox && (
            <div className="tile-designer-text">
              <textarea value={text} spellCheck={false} aria-label="Wzór kafelka (JSON)" readOnly={textBox === 'export'}
                onChange={(event) => setText(event.target.value)} onFocus={(event) => textBox === 'export' && event.target.select()} />
              <div className="tile-designer-actions">
                <button type="button" onClick={() => setTextBox(null)}>Zamknij</button>
                {textBox === 'import' && <button type="button" className="primary" onClick={loadText}>Wczytaj</button>}
              </div>
              <span className="tile-designer-note">{textMsg}</span>
            </div>
          )}
          <span className={`tile-designer-state${dirty ? ' dirty' : ''}`}>
            {dirty ? 'Zmiany nie są zapisane.' : 'Lista sterowników używa tego wzoru.'}
          </span>
        </aside>
      </div>

      <section className="tile-designer-preview">
        <h3>Podgląd listy</h3>
        <div className="device-list tile-designer-list" style={{ gap: draft.gap ?? 0 }}>
          {devices.map((device) => (
            <div key={device.rootId} className="device-card" style={previewCard}>
              <div className="device-choose">
                <TemplateTile template={draft} deviceType={device.deviceType} name={tileName(device, devices)} tile={tiles[device.rootId]} now={now} />
              </div>
            </div>
          ))}
        </div>
        <h3>Telefon 360 px</h3>
        <div className="device-list tile-designer-phone" style={{ gap: Math.max(draft.gap ?? 0, 10) }}>
          {devices.map((device) => (
            <div key={device.rootId} className="device-card">
              <div className="device-choose">
                <TemplateTile template={draft} deviceType={device.deviceType} name={tileName(device, devices)} tile={tiles[device.rootId]} now={now} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ukryte kafelki o rozmiarze ze wzoru: na nich sprawdzane jest mieszczenie się tekstu */}
      <div className="tile-designer-measure" ref={measureRef} aria-hidden="true">
        {devices.map((device) => (
          <div key={device.rootId} data-root={device.rootId} style={{ width: draft.w }}>
            <TemplateTile template={draft} deviceType={device.deviceType} name={tileName(device, devices)} tile={tiles[device.rootId]} now={now} />
          </div>
        ))}
      </div>
    </div>
  );
};
