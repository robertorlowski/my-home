// Popup „Kafelek pogody” (lista sterowników) w wyglądzie „Instrument” (okno .modal z makiety makiety/src/makieta.html,
// #modal-kafelek-pogody): dodanie i zmiana kafelka pogody (POST/PUT /api/weather-tiles), usunięcie (DELETE; kafelka „Dom”
// nie da się usunąć, bo daje temperaturę domu). Miejscowość szuka się w geokoderze Open-Meteo z przeglądarki (bez limitu
// na adres serwera), podpowiedzi jako lista .choices; współrzędne można też wpisać ręcznie. „Użyj mojej lokalizacji”
// dodaje kafelek bieżącej lokalizacji (current, najwyżej jeden na konto; położenie z przeglądarki, core/currentPlace.ts),
// a przy jego zmianie okno ma tylko nazwę (zastępowaną nazwą miejscowości, gdy przeglądarka ją ustali).
// Zamykany przyciskiem Anuluj, ikoną zamknięcia, klawiszem Esc albo kliknięciem w tło.
import { FormEvent, useEffect, useRef, useState } from 'react';
import { WeatherTileRequests } from '../api';
import { refreshCurrentPlace } from '../currentPlace';
import { WeatherTile } from '../types';
import { useLang } from '../i18n';
import { ListIcon } from './DeviceTileCard';
import './deviceEditModal.css';

type Props = {
  /** null = nowy kafelek */
  tile: WeatherTile | null;
  /** konto nie ma jeszcze kafelka bieżącej lokalizacji */
  canAddCurrent: boolean;
  onClose: () => void;
  onSaved: (tile: WeatherTile) => void;
  onRemoved: (id: string) => void;
};

type Hit = { name: string; admin1?: string; country?: string; latitude: number; longitude: number };

const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';
const coordinate = (value: number, locale: string) => value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseCoordinate = (text: string) => Number(text.replace(',', '.').trim());

export function WeatherTileModal({ tile, canAddCurrent, onClose, onSaved, onRemoved }: Props) {
  const { t, lang, locale } = useLang();
  const current = !!tile?.current;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [name, setName] = useState(tile?.name ?? '');
  const [lat, setLat] = useState(tile?.lat != null ? String(tile.lat) : '');
  const [lon, setLon] = useState(tile?.lon != null ? String(tile.lon) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  // szukanie po 400 ms od ostatniej litery (od 2 znaków), najwyżej 6 podpowiedzi po polsku
  useEffect(() => {
    window.clearTimeout(searchTimer.current);
    const text = query.trim();
    if (text.length < 2) { setHits([]); return undefined; }
    searchTimer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(`${GEOCODER}?name=${encodeURIComponent(text)}&count=6&language=${lang}&format=json`);
        const body = await response.json() as { results?: Hit[] };
        setHits(body.results ?? []);
      } catch {
        setHits([]);
        setError(t('weatherTile.geocoderDown'));
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => window.clearTimeout(searchTimer.current);
  }, [query]);

  // wybór podpowiedzi wypełnia nazwę i współrzędne; pole szukania jest czyszczone, żeby lista zniknęła
  const pick = (hit: Hit) => {
    setName(hit.name);
    setLat(String(hit.latitude));
    setLon(String(hit.longitude));
    setHits([]);
    setQuery('');
    setError('');
  };

  // kafelek bieżącej lokalizacji: pytanie o zgodę na położenie od razu (w geście użytkownika), potem zapis
  const addCurrent = async () => {
    refreshCurrentPlace(true);
    setSaving(true);
    setError('');
    try {
      onSaved(await WeatherTileRequests.create({ current: true }));
    } catch (caught) {
      // serverMessage: błąd z http.ts z treścią odpowiedzi serwera (np. „jest już kafelek bieżącej lokalizacji”)
      setError((caught as { serverMessage?: string }).serverMessage ?? t('weatherTile.addCurrentFailed'));
      setSaving(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (current && tile) {
      if (!name.trim()) { setError(t('weatherTile.nameRequired')); return; }
      setSaving(true);
      try {
        onSaved(await WeatherTileRequests.update(tile.id, { name: name.trim() }));
      } catch {
        setError(t('weatherTile.saveFailed'));
        setSaving(false);
      }
      return;
    }
    // zwykły kafelek: współrzędne z podpowiedzi albo wpisane ręcznie (przecinek dziesiętny dozwolony); zakres sprawdzany
    // tu, serwer sprawdza jeszcze raz
    const data = { name: name.trim(), lat: parseCoordinate(lat), lon: parseCoordinate(lon) };
    if (!data.name) { setError(t('weatherTile.nameRequired')); return; }
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lon) || Math.abs(data.lat) > 90 || Math.abs(data.lon) > 180) {
      setError(t('weatherTile.coordsInvalid'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      onSaved(tile ? await WeatherTileRequests.update(tile.id, data) : await WeatherTileRequests.create(data));
    } catch (caught) {
      setError((caught as { serverMessage?: string }).serverMessage ?? t('weatherTile.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!tile) return;
    setSaving(true);
    try {
      await WeatherTileRequests.remove(tile.id);
      onRemoved(tile.id);
    } catch {
      setError(t('weatherTile.removeFailed'));
      setSaving(false);
    }
  };

  return (
    <div className="modal-layer device-modal-layer">
      <div className="scrim" onClick={onClose} />
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="weather-modal-title" onSubmit={save}>
        <header className="modal-head">
          <h2 id="weather-modal-title">{tile ? t('weatherTile.title') : t('weatherTile.titleNew')}</h2>
          <button type="button" className="icon-btn sm" aria-label={t('common.close')} onClick={onClose}><ListIcon name="close" /></button>
        </header>
        <div className="modal-body">
          {!tile && canAddCurrent && (
            <>
              <button type="button" className="btn btn-ghost wx-locate" onClick={addCurrent} disabled={saving}><ListIcon name="locate" />{t('weatherTile.useMyLocation')}</button>
              <p className="help">{t('weatherTile.myLocationHint')}</p>
              <div className="wx-or"><span>{t('weatherTile.orFixedPlace')}</span></div>
            </>
          )}
          {!current && <>
          <label className="field">
            <span>{t('weatherTile.place')}</span>
            <input type="search" id="weather-search" value={query} placeholder={t('weatherTile.placePlaceholder')} autoFocus={!tile} autoComplete="off"
              onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          {(hits.length > 0 || searching) && (
            <ul className="choices" aria-label={t('weatherTile.suggestions')}>
              {searching && hits.length === 0 && <li className="choice-note"><small>{t('weatherTile.searching')}</small></li>}
              {hits.map((hit, index) => (
                <li key={`${hit.latitude}-${hit.longitude}-${index}`} role="button" tabIndex={0} onClick={() => pick(hit)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(hit); } }}>
                  <strong>{hit.name}{hit.country && hit.country !== 'Polska' && hit.country !== 'Poland' ? `, ${hit.country}` : ''}</strong>
                  <small>{hit.admin1 ? `${hit.admin1} · ` : ''}{coordinate(hit.latitude, locale)} N, {coordinate(hit.longitude, locale)} E</small>
                </li>
              ))}
            </ul>
          )}
          </>}
          <label className="field">
            <span>{t('weatherTile.tileName')}</span>
            <input type="text" id="weather-name" value={name} maxLength={40} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          {!current && <div className="weather-coords">
            <label className="field">
              <span>{t('weatherTile.latitude')}</span>
              <input type="text" id="weather-lat" value={lat} inputMode="decimal" onChange={(event) => setLat(event.currentTarget.value)} />
            </label>
            <label className="field">
              <span>{t('weatherTile.longitude')}</span>
              <input type="text" id="weather-lon" value={lon} inputMode="decimal" onChange={(event) => setLon(event.currentTarget.value)} />
            </label>
          </div>}
          <p className="help">
            {current ? t('weatherTile.currentHint') : tile?.home ? t('weatherTile.homeHint') : t('weatherTile.placeHint')}
          </p>
          {error && <p className="device-modal-error" role="alert">{error}</p>}
        </div>
        {confirmRemove ? (
          <footer className="modal-foot">
            <span className="help">{t('weatherTile.removeConfirm', { name: tile?.name ?? '' })}</span>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setConfirmRemove(false)} disabled={saving}>{t('common.no')}</button>
            <button type="button" className="btn btn-danger" onClick={remove} disabled={saving}>{t('common.delete')}</button>
          </footer>
        ) : (
          <footer className="modal-foot">
            {tile && !tile.home && (
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmRemove(true)} disabled={saving}>{t('weatherTile.remove')}</button>
            )}
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
          </footer>
        )}
      </form>
    </div>
  );
}
