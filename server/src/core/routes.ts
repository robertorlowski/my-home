// Router /api (montowany w core/app.ts po resolveDeviceContext): trasy wspólne
// i routery modułów. Pełna lista endpointów: CLAUDE.md, punkt 8.
import express from 'express'

import {
  addDevice, addDeviceShare, cancelDeviceFirmwareUpdate, getDeviceShares, getDevices, getProperties, registerDeviceEntry,
  removeDeviceShare, requestDeviceFirmwareUpdate, updateDevice, updateDeviceShare, updateDevicesOrder,
  updateProperties,
} from './controllers/device.controller'
import {
  authDelete, authDeleteConfirm, authDemo, authDemoAvailable, authEmailChange, authEmailChangeVerify, authLogout, authMe, authRemember,
  authStart, authSystem, authSetLanguage, authUpdateMe, authVerify,
} from './controllers/auth.controller'
import { deleteFirmware, downloadFirmware, getFirmware, updateFirmwareOffer, uploadFirmware } from './controllers/firmware.controller'
import { getTemperature } from './controllers/meteo.controller'
import { approveDeviceMailKey, getMailConfig, getNextMail, postMailResult, revokeDeviceMailKey } from './controllers/mail-relay.controller'
import { getOperations } from './controllers/operation-log.controller'
import { deletePushSubscription, getPushSettings, postPushSubscription, postPushTest, putPushRules } from './controllers/push.controller'
import { getDatabaseStatsEntry } from './controllers/database.controller'
import { getDeviceTilesEntry } from './controllers/device.controller'
import { deleteWeatherTile, getWeatherTiles, postWeatherTile, putWeatherTile } from './controllers/weather-tile.controller'
import heatPumpRoutes from '../modules/heat-pump/routes'
import waterPressureTankRoutes from '../modules/water-pressure-tank/routes'
import pelletBoilerPelux200Routes from '../modules/pellet-boiler-pelux200/routes'
import switchRoutes from '../modules/switch/routes'
import photovoltaicRoutes from '../modules/photovoltaic/routes'

// Trasy /api: wspólne (urządzenia, temperatura zewnętrzna) i moduły rodzajów sterowników.
const router = express.Router()

// Konta użytkowników (logowanie kodem z maila, sesja w nagłówku Authorization; core/middleware/session.ts)
router.post('/auth/start', authStart)
router.post('/auth/verify', authVerify)
router.post('/auth/system', authSystem)
// wersja demo (publiczny podgląd konta z DEMO_OWNER_EMAIL, tylko odczyt)
router.get('/auth/demo', authDemoAvailable)
router.post('/auth/demo', authDemo)
router.post('/auth/remember', authRemember)
router.post('/auth/logout', authLogout)
router.get('/auth/me', authMe)
router.put('/auth/me', authUpdateMe)
router.put('/auth/me/language', authSetLanguage)
router.post('/auth/email-change', authEmailChange)
router.post('/auth/email-change/verify', authEmailChangeVerify)
router.post('/auth/delete', authDelete)
router.post('/auth/delete/confirm', authDeleteConfirm)

// Urządzenia wszystkich rodzajów: lista, zgłoszenie sterownika, nazwa,
// sterownik domyślny i ustawienia (properties).
router.get('/devices', getDevices)
// zajętość bazy (stopka strony /devices); przed /devices/:rootId, bez rootId
router.get('/devices/db-stats', getDatabaseStatsEntry)
// kafelki sterowników (stan i kluczowe wartości) dla strony /devices; bez rootId
router.get('/devices/summary', getDeviceTilesEntry)
// ręczne dodanie (test E2E); klient go nie używa, sterowniki rejestrują się same
router.post('/devices', addDevice)
router.post('/devices/register', registerDeviceEntry)
// wzór kafelka (projektant kafelka w aplikacji); przed /devices/:rootId, bez rootId
// kolejność kafelków na /devices; przed /devices/:rootId, bez rootId
router.put('/devices/order', updateDevicesOrder)
router.put('/devices/:rootId', updateDevice)
// przycisk „Aktualizuj” w Ustawieniach sterownika: zlecenie aktualizacji firmware i jego odwołanie
router.post('/devices/:rootId/firmware-update', requestDeviceFirmwareUpdate)
router.delete('/devices/:rootId/firmware-update', cancelDeviceFirmwareUpdate)
// przekaźnik poczty (włącznik, co): zatwierdzenie i usunięcie klucza płytki (użytkownik systemowy)
router.post('/devices/:rootId/mail-key', approveDeviceMailKey)
router.delete('/devices/:rootId/mail-key', revokeDeviceMailKey)
// udostępnianie sterownika z wyborem zakładek (właściciel)
router.get('/devices/:rootId/shares', getDeviceShares)
router.post('/devices/:rootId/shares', addDeviceShare)
router.put('/devices/:rootId/shares/:id', updateDeviceShare)
router.delete('/devices/:rootId/shares/:id', removeDeviceShare)
router.get('/device/properties', getProperties)
router.put('/device/properties', updateProperties)

// Przekaźnik poczty: sterownik pobiera zaszyfrowane dane SMTP i maile, odsyła wynik (?rootId=&deviceId=, bez logowania)
router.get('/mail/config', getMailConfig)
router.get('/mail/next', getNextMail)
router.post('/mail/result', postMailResult)

// Firmware sterowników przez sieć (OTA): oferta, wgranie pliku, pobranie.
// Plik .bin to surowa treść żądania (application/octet-stream), bez multipart.
router.get('/firmware/:deviceType', getFirmware)
router.put('/firmware/:deviceType', updateFirmwareOffer)
router.put('/firmware/:deviceType/:version', express.raw({ type: 'application/octet-stream', limit: '2mb' }), uploadFirmware)
router.get('/firmware/:deviceType/:version', downloadFirmware)
router.delete('/firmware/:deviceType/:version', deleteFirmware)

router.get('/temperature', getTemperature)

// kafelki pogody na liście sterowników (bez rootId); kolejność razem ze sterownikami: PUT /devices/order
router.get('/weather-tiles', getWeatherTiles)
router.post('/weather-tiles', postWeatherTile)
router.put('/weather-tiles/:id', putWeatherTile)
router.delete('/weather-tiles/:id', deleteWeatherTile)

// dziennik operacji sterownika z dnia (zakładka „Operacje”)
router.get('/operations', getOperations)

// powiadomienia Web Push konta (karta „Powiadomienia” w /account; bez rootId, wymaga zalogowania)
router.get('/push/settings', getPushSettings)
router.post('/push/subscriptions', postPushSubscription)
router.delete('/push/subscriptions/:id', deletePushSubscription)
router.put('/push/rules', putPushRules)
router.post('/push/test', postPushTest)

// Moduły nie sprawdzają rodzaju urządzenia: np. /hp/add z rootId hydroforu
// zostanie przyjęte. Rozdział rodzajów jest po stronie sterowników i klienta.
router.use(heatPumpRoutes)
router.use(waterPressureTankRoutes)
router.use(pelletBoilerPelux200Routes)
router.use(switchRoutes)
router.use(photovoltaicRoutes)

export default router
