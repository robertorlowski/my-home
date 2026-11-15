// Polecenia dla QNAP-a w sieci domowej przez sterownik co (od 2026-11-13, polecenie właściciela „ad 1 zrób”).
// Rozwiązanie próbne: ok. 13.12.2026 sprawdzamy, czy było używane, a bez użycia usuwamy całość (ten plik, kontroler
// qnap.controller.ts, polecenie --qnap w core/cli.ts, obsługę qnap_wynik w websocket.ts i qnap_relay w firmware co).
// Umowa z usługą na QNAP-ie jest poza tym repozytorium (publicznym), więc tu bez adresów i kluczy:
//   1. polecenie na serwerze `node dist/server.js --qnap stan|restart_sieci|restart|wybudz` (core/cli.ts) woła
//      POST /api/qnap/polecenia z tokenem wewnętrznym (tylko polecenie na serwerze, bez przycisku w aplikacji);
//   2. serwer składa ciało {"wersja":1,"polecenie":…,"czas":<ms>,"nonce":<32 hex>} i podpisuje je HMAC-SHA256
//      (klucz QNAP_POLECENIA_KLUCZ: 32 bajty zapisane szesnastkowo, tylko w środowisku serwera; kluczem HMAC są
//      te 32 bajty po odczytaniu z hex), szesnastkowo małymi literami;
//   3. wysyła {"typ":"qnap",id,adres,cialo,podpis} gniazdem WebSocket połączonego sterownika co (websocket.ts);
//      adres to QNAP_ADRES (ustawienie app_settings albo zmienna środowiska, adres:port w sieci prywatnej);
//   4. co wysyła ciało bez zmian POST-em na http://<adres>/polecenie z nagłówkiem X-Podpis i odsyła
//      {"typ":"qnap_wynik",id,status,cialo}; serwer czeka na to do QNAP_CZEKAJ_MS.
// Do bazy trafia tylko wpis w dzienniku operacji sterownika co (kto, kiedy, polecenie, status HTTP); odpowiedź QNAP-a
// idzie tylko do wypisania w terminalu.
//
// Polecenie wybudz (od 2026-11-15, firmware co 1.5.0; polecenie właściciela: QNAP usypia po bezczynności, a budzi go
// sterownik co): uśpiony albo wyłączony QNAP nie odpowiada na HTTP, więc zamiast POST-u sterownik wysyła w sieci
// domowej pakiet budzący (Wake-on-LAN). Serwer wysyła {"typ":"qnap_wybudz",id,mac:[…]} z adresami MAC z QNAP_MAC
// (ustawienie app_settings albo zmienna środowiska), bez klucza i bez QNAP_ADRES; co odsyła
// {"typ":"qnap_wynik",id,status:200,cialo:"{\"wyslano\":<liczba pakietów>}"} albo status 0 z opisem. Pakiet budzący
// nie ma podpisu (tak działa Wake-on-LAN) i niczego nie potwierdza: czy QNAP wstał, widać dopiero po jego tunelu.
// Starszy firmware (1.4.0) wiadomości qnap_wybudz nie zna i nie odpowiada: wynik „brak odpowiedzi sterownika”.
import crypto from 'crypto';
import { DeviceModel } from '../models/device.model';
import { DeviceType, OperationMeta } from '../types';
import { controllerRootIds, onControllerMessage, sendToController } from '../websocket';
import { logOperation, systemMeta } from './operation-log.service';
import { isPrivateHostPort, parseMacs, setting } from './settings.service';

export const QNAP_POLECENIA = ['stan', 'restart_sieci', 'restart', 'wybudz'] as const;
export type QnapPolecenie = (typeof QNAP_POLECENIA)[number];
export const QNAP_CZEKAJ_MS = 20_000;
/** ciało polecenia i odpowiedzi QNAP-a: najwyżej 1 KB */
export const QNAP_CIALO_MAX = 1024;

export type QnapWynik = {
  id: string;
  polecenie: QnapPolecenie;
  rootId: string;
  /** kod HTTP odpowiedzi QNAP-a; 0 = sterownik nie połączył się z QNAP-em albo nie odpowiedział w czasie */
  status: number;
  /** odpowiedź QNAP-a (tylko do wypisania, nie trafia do bazy) */
  cialo: string;
  czasMs: number;
  brakOdpowiedziSterownika?: boolean;
};

export class QnapError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** klucz HMAC: QNAP_POLECENIA_KLUCZ (64 znaki hex = 32 bajty) albo null */
export function qnapKlucz(): Buffer | null {
  const text = (process.env.QNAP_POLECENIA_KLUCZ ?? '').trim();
  return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
}

/** QNAP_ADRES z ustawień (app_settings) albo ze środowiska, jeśli poprawny */
export function qnapAdres(): string | null {
  const text = (setting('QNAP_ADRES') ?? '').trim();
  return isPrivateHostPort(text) ? text : null;
}

/** adresy MAC QNAP-a (QNAP_MAC z ustawień albo ze środowiska) dla polecenia wybudz albo null */
export function qnapMac(): string[] | null {
  const text = (setting('QNAP_MAC') ?? '').trim();
  return text ? parseMacs(text) : null;
}

export const cialoPolecenia = (polecenie: QnapPolecenie, czasMs = Date.now(), nonce = crypto.randomBytes(16).toString('hex')) =>
  JSON.stringify({ wersja: 1, polecenie, czas: czasMs, nonce });

export const podpisCiala = (klucz: Buffer, cialo: string) => crypto.createHmac('sha256', klucz).update(cialo, 'utf8').digest('hex');

// żądania czekające na qnap_wynik: id → sterownik, do którego poszło, i dokończenie
const czekajace = new Map<string, { rootId: string; koniec: (status: number, cialo: string) => void }>();
let nasluch = false;
function nasluchuj() {
  if (nasluch) return;
  nasluch = true;
  onControllerMessage((rootIds, message) => {
    if (message.typ !== 'qnap_wynik' || typeof message.id !== 'string') return;
    const zadanie = czekajace.get(message.id);
    // wynik tylko z gniazda tego sterownika, do którego poszło polecenie
    if (!zadanie || !rootIds.includes(zadanie.rootId)) return;
    const status = typeof message.status === 'number' && Number.isInteger(message.status) ? message.status : 0;
    zadanie.koniec(status, typeof message.cialo === 'string' ? message.cialo.slice(0, QNAP_CIALO_MAX) : '');
  });
}

async function sterownikCo(rootId: unknown): Promise<string> {
  const polaczone = new Set(controllerRootIds());
  if (rootId !== undefined && rootId !== null && rootId !== '') {
    const id = String(rootId);
    const device = /^[0-9a-f]{24}$/.test(id) ? await DeviceModel.findById(id).select('deviceType').lean() : null;
    if (!device) throw new QnapError('Nieznany sterownik.', 404);
    if (device.deviceType !== DeviceType.HP) throw new QnapError('Polecenia dla QNAP-a przewozi tylko sterownik co (pompa ciepła).', 400);
    if (!polaczone.has(id)) throw new QnapError('Ten sterownik co nie jest teraz połączony z serwerem (WebSocket).', 409);
    return id;
  }
  const pumps = (await DeviceModel.find({ deviceType: DeviceType.HP }).select('_id').lean()).map((device) => String(device._id));
  const online = pumps.filter((id) => polaczone.has(id));
  if (online.length === 0) throw new QnapError('Żaden sterownik co nie jest teraz połączony z serwerem (WebSocket), więc polecenia nie ma kto przewieźć.', 409);
  if (online.length > 1) throw new QnapError(`Połączonych jest kilka sterowników co (${online.join(', ')}): podaj rootId.`, 409);
  return online[0];
}

const opisStatusu = (wynik: QnapWynik, czekajMs: number) => {
  if (wynik.brakOdpowiedziSterownika) return `brak odpowiedzi sterownika w ${Math.ceil(czekajMs / 1000)} s`;
  if (wynik.polecenie === 'wybudz') return wynik.status === 200 ? 'pakiet budzący wysłany' : 'sterownik nie wysłał pakietu budzącego';
  if (wynik.status === 0) return 'sterownik nie połączył się z QNAP-em';
  return `HTTP ${wynik.status}`;
};

/**
 * Jedno polecenie: podpis, wysyłka do połączonego co, czekanie na wynik i wpis w dzienniku operacji.
 * Błąd konfiguracji (klucz, adres, sterownik) to QnapError z czytelnym opisem.
 */
export async function wyslijPolecenieQnap(input: { polecenie?: unknown; rootId?: unknown },
  meta: OperationMeta = systemMeta('Polecenie na serwerze'), czekajMs = QNAP_CZEKAJ_MS): Promise<QnapWynik> {
  const polecenie = String(input.polecenie ?? '') as QnapPolecenie;
  if (!QNAP_POLECENIA.includes(polecenie)) throw new QnapError(`Nieznane polecenie. Dostępne: ${QNAP_POLECENIA.join(', ')}.`, 400);
  const id = crypto.randomBytes(8).toString('hex');
  // wybudz: pakiet budzący do adresów MAC, bez podpisu i bez adresu usługi (uśpiony QNAP nie odpowiada na HTTP)
  let wiadomosc: Record<string, unknown>;
  if (polecenie === 'wybudz') {
    const mac = qnapMac();
    if (!mac) throw new QnapError('Brak QNAP_MAC (od 1 do 4 adresów MAC po przecinku) w ustawieniach serwera albo w środowisku.', 503);
    wiadomosc = { typ: 'qnap_wybudz', id, mac };
  } else {
    const klucz = qnapKlucz();
    if (!klucz) throw new QnapError('Brak klucza QNAP_POLECENIA_KLUCZ (64 znaki szesnastkowe) w środowisku serwera.', 503);
    const adres = qnapAdres();
    if (!adres) throw new QnapError('Brak QNAP_ADRES (adres:port w sieci prywatnej) w ustawieniach serwera albo w środowisku.', 503);
    const cialo = cialoPolecenia(polecenie);
    wiadomosc = { typ: 'qnap', id, adres, cialo, podpis: podpisCiala(klucz, cialo) };
  }
  const rootId = await sterownikCo(input.rootId);
  nasluchuj();

  const start = Date.now();
  const wynik = await new Promise<QnapWynik>((resolve) => {
    const zakoncz = (status: number, odpowiedz: string, brak = false) => {
      clearTimeout(zegar);
      czekajace.delete(id);
      resolve({ id, polecenie, rootId, status, cialo: odpowiedz, czasMs: Date.now() - start, ...(brak ? { brakOdpowiedziSterownika: true } : {}) });
    };
    const zegar = setTimeout(() => zakoncz(0, '', true), czekajMs);
    czekajace.set(id, { rootId, koniec: (status, odpowiedz) => zakoncz(status, odpowiedz) });
    if (sendToController(rootId, wiadomosc) === 0) zakoncz(0, '', true);
  });
  const opis = opisStatusu(wynik, czekajMs);
  console.log(`[qnap] ${polecenie} (${id}) przez co ${rootId}: ${opis} po ${wynik.czasMs} ms`);
  // dziennik operacji: kto (meta), kiedy (at), polecenie i status; bez treści odpowiedzi QNAP-a
  await logOperation(rootId, meta, `QNAP: ${polecenie} — ${opis}`, { status: wynik.status === 200 ? 'done' : 'error' });
  return wynik;
}
