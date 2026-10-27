// Aplikacja Express bez nasłuchu: używa jej server.ts i testy (supertest).
// Kolejność: CORS, JSON, sesja (req.user), kontekst urządzenia (req.deviceRootId), dostęp (konta użytkowników), trasy /api.
import express from 'express'
import cors from 'cors'
import apiRoute from './routes'
import { resolveDeviceContext } from './middleware/device-context'
import { authenticate, authorize } from './middleware/session'

const app = express()
// Za proxy Render: req.protocol ma być https (adres pliku firmware w ofercie dla sterowników).
app.set('trust proxy', 1)

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // <- zezwala wszystkim
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  next();
});

app.use(cors())
app.use(express.json())

// Każde żądanie /api (poza /devices...) musi wskazać urządzenie; kontrolery
// czytają już tylko req.deviceRootId.
app.use('/api', authenticate)
app.use('/api', resolveDeviceContext)
app.use('/api', authorize)
app.use('/api', apiRoute)

export default app
