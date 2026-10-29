// Aplikacja Express bez nasłuchu: używa jej server.ts i testy (supertest).
// Kolejność: CORS, kompresja, JSON, sesja (req.user), kontekst urządzenia (req.deviceRootId), dostęp (konta użytkowników), trasy /api.
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import apiRoute from './routes'
import { resolveDeviceContext } from './middleware/device-context'
import { authenticate, authorize } from './middleware/session'

const app = express()
// Za proxy Render: req.protocol ma być https (adres pliku firmware w ofercie dla sterowników).
app.set('trust proxy', 1)

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // <- zezwala wszystkim
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  // x-api-key: wysyła go jeszcze klient sprzed 2026-10-27 (karta albo PWA bez odświeżenia); bez niego zapytania z takiej
  // kopii nie przejdą preflight CORS. Do usunięcia, gdy wszystkie urządzenia mają nowy klient.
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
  next();
});

app.use(cors())

// Kompresja odpowiedzi (2026-10-29, limit transferu Render 5 GB): dane dnia pompy (/hp/4day) to ok. 4 MB JSON-u
// bez kompresji i 180 KB po niej. Cloudflare przed Render kompresuje dla przeglądarki, ale serwer wysyła do niego
// pełny rozmiar. Tylko gdy zapytanie wprost przyjmuje gzip / br / deflate: sterowniki (HTTPClient ESP32 wysyła
// „identity”) dostają odpowiedzi bez zmian. Małe odpowiedzi (< 1 KB) zostają bez kompresji (domyślny próg).
app.use(compression({
  filter: (req, res) => /\b(gzip|br|deflate)\b/.test(String(req.headers['accept-encoding'] ?? '')) && compression.filter(req, res),
}))
app.use(express.json())

// Każde żądanie /api (poza /devices...) musi wskazać urządzenie; kontrolery
// czytają już tylko req.deviceRootId.
app.use('/api', authenticate)
app.use('/api', resolveDeviceContext)
app.use('/api', authorize)
app.use('/api', apiRoute)

export default app
