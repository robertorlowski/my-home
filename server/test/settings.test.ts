// Ustawienia w bazie (GET /api/settings, PUT /api/settings; supertest na core/app, baza w mongodb-memory-server):
// tylko konto systemowe, od 2026-11-13 bez hasła ustawień (konto system loguje się kodem z maila), sekrety nie wracają
// przez API, walidacja, pierwszeństwo przed środowiskiem, dokument innej bazy ignorowany, adres kodów konta system.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
}))

import app from '../src/core/app'
import { SettingsModel } from '../src/core/models/settings.model'
import { UserModel } from '../src/core/models/user.model'
import { ensureSystemUser, issueEmergencySystemCode, systemEmail } from '../src/core/services/auth.service'
import { demoAvailable } from '../src/core/services/auth.service'
import { clientBaseUrl } from '../src/core/services/mail.service'
import { pushConfigured } from '../src/core/services/push.service'
import { loadSettings, resetSettingsCache, setting } from '../src/core/services/settings.service'

describe('ustawienia w bazie', () => {
  let mongoServer: MongoMemoryServer
  let system: string
  const saved = { auth: process.env.AUTH_DISABLED, demo: process.env.DEMO_OWNER_EMAIL, admin: process.env.MAIL_ADMIN, systemEmail: process.env.SYSTEM_EMAIL }
  const put = (values: unknown, token = system) => request(app).put('/api/settings').set('Authorization', `Bearer ${token}`).send({ values })
  const read = (token = system) => request(app).get('/api/settings').set('Authorization', `Bearer ${token}`)

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0'
    delete process.env.DEMO_OWNER_EMAIL
    delete process.env.MAIL_ADMIN
    delete process.env.SYSTEM_EMAIL
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    await ensureSystemUser()
    // konto system kodem awaryjnym (jak polecenie --kod-awaryjny); przebieg z mailem: system-login.test.ts
    system = (await request(app).post('/api/auth/system/verify').send({ code: (await issueEmergencySystemCode()).code }).expect(200)).body.token
  })

  beforeEach(async () => {
    await SettingsModel.deleteMany({})
    resetSettingsCache()
  })

  afterAll(async () => {
    resetSettingsCache()
    process.env.AUTH_DISABLED = saved.auth
    for (const [key, value] of [['DEMO_OWNER_EMAIL', saved.demo], ['MAIL_ADMIN', saved.admin], ['SYSTEM_EMAIL', saved.systemEmail]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('bez logowania 401, zwykłe konto 403, konto systemowe 200 bez dodatkowego hasła', async () => {
    await request(app).get('/api/settings').expect(401)
    await request(app).put('/api/settings').send({ values: {} }).expect(401)
    // konto bez uprawnień: sesja wersji demo, bo zwykłe logowanie wymaga kodu z maila
    await UserModel.create({ email: 'demo@example.com' })
    await put({ DEMO_OWNER_EMAIL: 'demo@example.com' }).expect(200)
    const demo = (await request(app).post('/api/auth/demo').expect(200)).body.token
    await read(demo).expect(403)
    await put({ SMTP_HOST: 'x.example.com' }, demo).expect(403)
    expect(setting('SMTP_HOST')).toBeUndefined()
    const response = await read().expect(200)
    expect(response.body.map((item: { key: string }) => item.key)).toContain('SMTP_HOST')
    expect(response.body.map((item: { key: string }) => item.key)).toContain('SYSTEM_EMAIL')
    expect(response.body.map((item: { key: string }) => item.key)).not.toContain('MONGODB_URI')
    expect(response.body.map((item: { key: string }) => item.key)).not.toContain('SYSTEM_PASSWORD')
  })

  it('dawne żądania z hasłem ustawień działają, hasło jest pomijane (klient sprzed 2026-11-13)', async () => {
    const old = await request(app).post('/api/settings/read').set('Authorization', `Bearer ${system}`).send({ password: 'cokolwiek' }).expect(200)
    expect(old.body.map((item: { key: string }) => item.key)).toContain('SMTP_HOST')
    await request(app).put('/api/settings').set('Authorization', `Bearer ${system}`).send({ password: 'zle', values: { SMTP_HOST: 'x.example.com' } }).expect(200)
    expect(setting('SMTP_HOST')).toBe('x.example.com')
    await request(app).post('/api/settings/read').send({}).expect(401)
  })

  it('sekret zapisuje się, ale API go nie zwraca', async () => {
    const response = await put({ SMTP_PASS: 'haslo-poczty', SMTP_HOST: 'smtp.example.com' }).expect(200)
    const pass = response.body.find((item: { key: string }) => item.key === 'SMTP_PASS')
    expect(pass).toMatchObject({ isSet: true, kind: 'secret' })
    expect(pass.value).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('haslo-poczty')
    expect(setting('SMTP_PASS')).toBe('haslo-poczty')
    expect(response.body.find((item: { key: string }) => item.key === 'SMTP_HOST').value).toBe('smtp.example.com')
  })

  it('zmienia tylko podane klucze, pusty tekst usuwa wartość', async () => {
    await put({ SMTP_HOST: 'a.example.com', SMTP_USER: 'konto' }).expect(200)
    await put({ SMTP_HOST: 'b.example.com' }).expect(200)
    expect(setting('SMTP_HOST')).toBe('b.example.com')
    expect(setting('SMTP_USER')).toBe('konto')
    const response = await put({ SMTP_USER: '' }).expect(200)
    expect(response.body.find((item: { key: string }) => item.key === 'SMTP_USER').isSet).toBe(false)
    expect(setting('SMTP_USER')).toBeUndefined()
  })

  it('odrzuca nieznane klucze i złe wartości, bez częściowego zapisu', async () => {
    for (const values of [{ MONGODB_URI: 'x' }, { SYSTEM_PASSWORD: 'x' }, { SMTP_PORT: '70000' }, { MAIL_ADMIN: 'bez-malpy' }, { SYSTEM_EMAIL: 'bez-malpy' }, { BACKGROUND_JOBS: 'tak' }, { MAIL_RELAY: 'tak' }, { CLIENT_URL: 'ftp://x' }, { SMTP_HOST: 5 }]) {
      await put(values).expect(400)
    }
    await put({ SMTP_HOST: 'c.example.com', SMTP_PORT: 'zly' }).expect(400)
    expect(setting('SMTP_HOST')).toBeUndefined()
    await put('tekst').expect(400)
  })

  it('adres kodów konta system: SYSTEM_EMAIL z ustawień, bez niego MAIL_ADMIN, bez obu pusty (kod w dzienniku)', async () => {
    expect(systemEmail()).toBe('')
    await put({ MAIL_ADMIN: 'admin@example.com' }).expect(200)
    expect(systemEmail()).toBe('admin@example.com')
    const response = await put({ SYSTEM_EMAIL: 'wlasciciel@example.com' }).expect(200)
    expect(response.body.find((item: { key: string }) => item.key === 'SYSTEM_EMAIL')).toMatchObject({ group: 'mail', kind: 'email', isSet: true, value: 'wlasciciel@example.com' })
    expect(systemEmail()).toBe('wlasciciel@example.com')
    await put({ SYSTEM_EMAIL: '' }).expect(200)
    expect(systemEmail()).toBe('admin@example.com')
  })

  it('kod używa wartości z bazy od razu po zapisie', async () => {
    expect(demoAvailable()).toBe(false)
    await put({ DEMO_OWNER_EMAIL: 'demo@example.com', CLIENT_URL: 'https://dom.example, https://inny.example' }).expect(200)
    expect(demoAvailable()).toBe(true)
    expect(clientBaseUrl()).toBe('https://dom.example')
    expect(clientBaseUrl('https://inny.example')).toBe('https://inny.example')
  })

  it('baza ma pierwszeństwo przed środowiskiem, a bez wartości działa środowisko', async () => {
    process.env.MAIL_ADMIN = 'env@example.com'
    expect(setting('MAIL_ADMIN')).toBe('env@example.com')
    await put({ MAIL_ADMIN: 'baza@example.com' }).expect(200)
    expect(setting('MAIL_ADMIN')).toBe('baza@example.com')
    delete process.env.MAIL_ADMIN
  })

  it('dokument kopii z inną nazwą bazy jest ignorowany', async () => {
    await SettingsModel.create({ _id: 'hpdb', values: { BACKGROUND_JOBS: 'on', SMTP_PASS: 'produkcyjne', SMTP_HOST: 'smtp.example.com', SYSTEM_EMAIL: 'wlasciciel@example.com' } })
    await loadSettings()
    expect(setting('BACKGROUND_JOBS')).toBeUndefined()
    expect(setting('SMTP_PASS')).toBeUndefined()
    expect(systemEmail()).toBe('')
    const response = await read().expect(200)
    expect(response.body.every((item: { isSet: boolean }) => !item.isSet)).toBe(true)
  })

  it('nieprawidłowe klucze powiadomień nie psują zapisu, a powiadomienia zostają wyłączone', async () => {
    await put({ VAPID_PUBLIC_KEY: 'zly', VAPID_PRIVATE_KEY: 'zly' }).expect(200)
    expect(pushConfigured()).toBe(false)
  })
})
