// Polecenia dla QNAP-a przez sterownik co (od 2026-11-13, próbnie; opis w services/qnap.service.ts). Tylko polecenie
// na serwerze (--qnap w core/cli.ts, token wewnętrzny), bez przycisku w aplikacji:
//   POST /qnap/polecenia {polecenie: stan|restart_sieci|restart, rootId?} — 200 z wynikiem po odpowiedzi sterownika
//   albo po QNAP_CZEKAJ_MS (status 0); 400 nieznane polecenie, 403 bez tokenu wewnętrznego, 404/409 sterownik,
//   503 brak klucza albo adresu.
import { Request, Response } from 'express';
import { INTERNAL_TOKEN, INTERNAL_TOKEN_HEADER } from '../internal';
import { metaFromRequest, systemMeta } from '../services/operation-log.service';
import { QnapError, wyslijPolecenieQnap } from '../services/qnap.service';

export async function postQnapPolecenie(req: Request, res: Response) {
  if (req.header(INTERNAL_TOKEN_HEADER) !== INTERNAL_TOKEN) {
    return res.status(403).json({ message: 'Polecenia dla QNAP-a wysyła tylko polecenie na serwerze (--qnap).' });
  }
  try {
    const body = (req.body ?? {}) as { polecenie?: unknown; rootId?: unknown };
    const wynik = await wyslijPolecenieQnap(body, metaFromRequest(req, systemMeta('Polecenie na serwerze')));
    return res.status(200).json(wynik);
  } catch (error) {
    if (error instanceof QnapError) return res.status(error.status).json({ message: error.message });
    console.error('[qnap]', error);
    return res.status(500).json({ message: 'Błąd serwera.' });
  }
}
