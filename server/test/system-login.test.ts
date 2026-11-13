// Konto system bez hasła (od 2026-11-13, plan oracle-cloud/vm-prod/admin/docs/plan-logowanie-system-kodem.md):
// kod z maila na stały adres z ustawień (SYSTEM_EMAIL, bez niego MAIL_ADMIN) z adresem IP, bez poczty kod w dzienniku
// serwera, jednorazowy i ważny 5 min, limity (raz na minutę, 5 na godzinę), blokada po 5 błędnych kodach, polecenie
// awaryjne (--kod-awaryjny) zdejmujące blokadę, odrzucenie hasła, polecenie --api z tokenem wewnętrznym bez konta.
// SMTP udaje atrapa nodemailera (vi.hoisted), czas przesuwa się zmianą dat w auth_codes.
import { existsSync, rmSync } from 'fs'
import { AddressInfo } from 'net'
import { Server } from 'http'
import { Readable } from 'stream'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest'

const smtp = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string; html: string }>, fail: false }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string; text: string; html: string }) => {
        if (smtp.fail) throw new Error('SMTP niedostępny')
        smtp.sent.push(mail)
      },
    }),
  },
}))
vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}))

import app from '../src/core/app'
import { runCli } from '../src/core/cli'
import { internalTokenFile, saveInternalToken } from '../src/core/internal'
import { AuthCodeModel } from '../src/core/models/auth.model'
import { DeviceModel } from '../src/core/models/device.model'
import { OperationLogModel } from '../src/core/models/operation-log.model'
import { ensureSystemUser, SYSTEM_CODES_PER_HOUR } from '../src/core/services/auth.service'
import { resetMailTransport, systemLoginMail } from '../src/core/services/mail.service'
import { resetSettingsCache } from '../src/core/services/settings.service'
import { DeviceType } from '../src/core/types'

const IP = '203.0.113.7'
const codes = () => mongoose.connection.collection('auth_codes')
const start = (body: object = {}) => request(app).post('/api/auth/system').set('X-Forwarded-For', IP).send(body)
const verify = (code: string) => request(app).post('/api/auth/system/verify').set('X-Forwarded-For', IP).send({ code })
const digits = (text = '') => /(\d{3}) (\d{3})/.exec(text)?.slice(1).join('') ?? ''
// przesuwa w przeszłość ślady wysłanych kodów, jakby minęło ms (limit raz na minutę)
const age = (ms: number) => codes().updateMany({ purpose: 'system-sent' }, [{ $set: { createdAt: { $subtract: ['$createdAt', ms] } } }])
const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000')

describe('Konto system: kod zamiast hasła', () => {
  let mongoServer: MongoMemoryServer
  const ENV_KEYS = ['AUTH_DISABLED', 'SMTP_HOST', 'MAIL_ADMIN', 'SYSTEM_EMAIL', 'MAIL_RELAY', 'SYSTEM_PASSWORD', 'PORT', 'INTERNAL_API_URL']
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  let log: MockInstance<typeof console.log>
  // kod z dziennika serwera (bez poczty): ostatni wpis „[konta] system: kod logowania 123 456 …”
  const loggedCode = () => digits(log.mock.calls.map((call) => String(call[0])).reverse().find((line) => line.includes('system: kod logowania')))

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0'
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    await ensureSystemUser()
  })

  beforeEach(async () => {
    for (const key of ['SMTP_HOST', 'MAIL_ADMIN', 'SYSTEM_EMAIL', 'MAIL_RELAY', 'SYSTEM_PASSWORD']) delete process.env[key]
    resetSettingsCache()
    resetMailTransport()
    smtp.sent.length = 0
    smtp.fail = false
    await AuthCodeModel.deleteMany({})
    log = vi.spyOn(console, 'log')
  })

  afterEach(() => {
    log.mockRestore()
  })

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('bez poczty kod jest w dzienniku serwera; kod działa raz, daje sesję system i pytanie o zapamiętanie', async () => {
    const sent = await start().expect(200)
    expect(sent.body).toEqual({ delivery: 'log', expiresInSeconds: 300, resendAfterSeconds: 60 })
    const code = loggedCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(smtp.sent).toHaveLength(0)
    const ok = await verify(code).expect(200)
    expect(ok.body.user).toMatchObject({ isSystem: true, email: null })
    const token = ok.body.token as string
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200)).body.isSystem).toBe(true)
    // „Zapamiętać …?” jak u zwykłych kont
    expect((await request(app).post('/api/auth/remember').set('Authorization', `Bearer ${token}`).send({ remember: true }).expect(200)).body.remember).toBe(true)
    await verify(code).expect(400)
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.includes(`zalogowano kodem z dziennika serwera z IP ${IP}`))).toBe(true)
  })

  it('z pocztą kod idzie tylko na adres z ustawień (SYSTEM_EMAIL, bez niego MAIL_ADMIN), w mailu adres IP; adres z formularza pomijany', async () => {
    process.env.SMTP_HOST = 'smtp.example'
    process.env.MAIL_ADMIN = 'admin@example.com'
    const sent = await start({ email: 'obcy@example.com' }).expect(200)
    expect(sent.body.delivery).toBe('mail')
    expect(JSON.stringify(sent.body)).not.toContain('@')
    expect(smtp.sent.map((mail) => mail.to)).toEqual(['admin@example.com'])
    const mail = smtp.sent[0]
    expect(mail.subject).toMatch(/^Kod logowania system: \d{3} \d{3}$/)
    expect(mail.text).toContain(`adresu IP ${IP}`)
    expect(mail.html).toContain(IP)
    expect(mail.text).toContain('ważny 5 minut')
    // kod nie trafia do dziennika, gdy poszedł mailem
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(digits(mail.subject).slice(0, 3) + ' ' + digits(mail.subject).slice(3))

    process.env.SYSTEM_EMAIL = 'wlasciciel@example.com'
    await age(61_000)
    await start().set('Accept-Language', 'en').expect(200)
    expect(smtp.sent.map((mail) => mail.to)).toEqual(['admin@example.com', 'wlasciciel@example.com'])
    expect(smtp.sent[1].subject).toMatch(/^System sign-in code: \d{3} \d{3}$/)
    expect(smtp.sent[1].text).toContain(`IP address ${IP}`)
    // nowy kod unieważnia poprzedni
    await verify(digits(smtp.sent[0].subject)).expect(400)
    await verify(digits(smtp.sent[1].subject)).expect(200)
  })

  it('błąd poczty: 503 bez ważnego kodu, kod nie trafia do dziennika', async () => {
    process.env.SMTP_HOST = 'smtp.example'
    process.env.SYSTEM_EMAIL = 'wlasciciel@example.com'
    smtp.fail = true
    const failed = await start().expect(503)
    expect(failed.body.message).toContain('polecenia awaryjnego')
    expect(await AuthCodeModel.countDocuments({ purpose: 'system-login' })).toBe(0)
    expect(log.mock.calls.some((call) => String(call[0]).includes('system: kod logowania'))).toBe(false)
  })

  it('limity: nowy kod najwyżej raz na minutę i 5 razy na godzinę', async () => {
    await start().expect(200)
    const again = await start().expect(429)
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0)
    expect(again.body.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(again.body.locked).toBeUndefined()
    for (let i = 1; i < SYSTEM_CODES_PER_HOUR; i += 1) {
      await age(61_000)
      await start().expect(200)
    }
    await age(61_000)
    const hourly = await start().expect(429)
    expect(hourly.body.message).toMatch(/^Za dużo kodów w ciągu godziny/)
    expect(hourly.body.retryAfterSeconds).toBeGreaterThan(60)
    // po godzinie ślady wygasają (TTL) i można znowu
    await codes().updateMany({ purpose: 'system-sent' }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    await start().expect(200)
  })

  it('kod wygasa po 5 minutach; zły format nie liczy się jako próba', async () => {
    await start().expect(200)
    const code = loggedCode()
    await verify('12345').expect(400)
    expect((await AuthCodeModel.findOne({ purpose: 'system-login' }).lean())?.attempts).toBe(0)
    await codes().updateMany({ purpose: 'system-login' }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    const expired = await verify(code).expect(400)
    expect(expired.body.message).toMatch(/^Kod wygasł/)
  })

  it('5 błędnych kodów unieważnia kod i blokuje wysłanie i wpisanie; polecenie awaryjne zdejmuje blokadę', async () => {
    await start().expect(200)
    const code = loggedCode()
    for (let left = 4; left >= 1; left -= 1) {
      expect((await verify(wrongOf(code)).expect(400)).body.message).toContain(`Zostało prób: ${left}`)
    }
    const locked = await verify(wrongOf(code)).expect(429)
    expect(locked.body).toMatchObject({ locked: true })
    expect(locked.body.message).toMatch(/zablokowane na 15 min/)
    expect(locked.headers['retry-after']).toBe('900')
    // właściwy kod już nie działa, nowego nie da się zamówić
    await verify(code).expect(429)
    expect((await start().expect(429)).body.locked).toBe(true)
    const lock = await AuthCodeModel.findOne({ purpose: 'system-lock' }).lean()
    expect(lock?.ip).toBe(IP)

    const printed: string[] = []
    expect(await runCli(['--kod-awaryjny'], { print: (text) => printed.push(text), printError: (text) => printed.push(text) })).toBe(0)
    expect(printed[0]).toMatch(/^Kod awaryjny konta system: \d{3} \d{3}$/)
    expect(printed.join('\n')).toContain('Blokada po błędnych kodach i limit kodów zdjęte')
    expect(await AuthCodeModel.countDocuments({ purpose: { $in: ['system-lock', 'system-sent'] } })).toBe(0)
    await verify(digits(printed[0])).expect(200)
    expect(log.mock.calls.some((call) => String(call[0]).includes(`zalogowano kodem awaryjnym z IP ${IP}`))).toBe(true)
  })

  it('polecenie awaryjne działa bez poczty i unieważnia wysłany kod', async () => {
    process.env.SMTP_HOST = 'smtp.example'
    process.env.SYSTEM_EMAIL = 'wlasciciel@example.com'
    await start().expect(200)
    const mailed = digits(smtp.sent[0].subject)
    const printed: string[] = []
    await runCli(['--kod-awaryjny'], { print: (text) => printed.push(text) })
    expect(smtp.sent).toHaveLength(1)
    await verify(mailed).expect(400)
    await verify(digits(printed[0])).expect(200)
  })

  it('hasła nie ma: żądanie z hasłem dostaje 400 bez wysłania kodu, SYSTEM_PASSWORD w środowisku nic nie zmienia', async () => {
    process.env.SYSTEM_PASSWORD = 'tajne-haslo'
    const old = await start({ password: 'tajne-haslo' }).expect(400)
    expect(old.body.message).toMatch(/nie ma już hasła/)
    expect(await AuthCodeModel.countDocuments({})).toBe(0)
    await verify('tajne-haslo').expect(400)
    await request(app).post('/api/auth/verify').send({ email: 'system', code: '123456' }).expect(400)
    expect((await start().expect(200)).body.delivery).toBe('log')
  })

  it('treść maila: kod, adres IP i czas, oba języki', () => {
    const at = new Date('2026-11-13T00:30:00Z')
    const limits = { minutes: 5, attempts: 5, lock: 15 }
    const pl = systemLoginMail('a@example.com', '123456', new Date(at.getTime() + 300_000), '198.51.100.4', limits, 'pl', at)
    expect(pl.subject).toBe('Kod logowania system: 123 456')
    expect(pl.text).toContain('Kod zamówiono z adresu IP 198.51.100.4 (13.11.2026, 01:30)')
    expect(pl.text).toContain('ważny 5 minut (do 01:35)')
    expect(pl.text).toContain('po 5 błędnych kodach logowanie system blokuje się na 15 minut')
    const en = systemLoginMail('a@example.com', '123456', new Date(at.getTime() + 300_000), '198.51.100.4', limits, 'en', at)
    expect(en.subject).toBe('System sign-in code: 123 456')
    expect(en.text).toContain('requested from the IP address 198.51.100.4')
  })

  describe('polecenie --api (token wewnętrzny serwera zamiast hasła systemowego)', () => {
    let server: Server
    let port: number
    const run = async (args: string[], stdin?: Buffer) => {
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(['--api', ...args], { print: (text) => out.push(text), printError: (text) => err.push(text), ...(stdin ? { stdin: Readable.from([stdin]) } : {}) })
      return { code, out: out.join('\n'), err: err.join('\n') }
    }

    beforeAll(async () => {
      server = app.listen(0)
      await new Promise((resolve) => server.once('listening', resolve))
      port = (server.address() as AddressInfo).port
      process.env.PORT = String(port)
      delete process.env.INTERNAL_API_URL
    })

    afterAll(async () => {
      rmSync(internalTokenFile(port), { force: true })
      await new Promise((resolve) => server.close(resolve))
    })

    it('bez pliku z tokenem: błąd i kod wyjścia 1; zła składnia: 2', async () => {
      rmSync(internalTokenFile(port), { force: true })
      const missing = await run(['GET', '/firmware/switch'])
      expect(missing.code).toBe(1)
      expect(missing.err).toContain(internalTokenFile(port))
      expect((await run(['PATCH', '/x'])).code).toBe(2)
      expect((await run(['GET', 'bez-ukosnika'])).code).toBe(2)
    })

    it('wgranie firmware i zlecenie aktualizacji bez konta; w dzienniku operacji „Polecenie na serwerze”', async () => {
      saveInternalToken(port)
      expect(existsSync(internalTokenFile(port))).toBe(true)
      // bez tokenu to samo żądanie wymaga logowania
      await request(app).get('/api/firmware/switch').expect(401)
      const image = Buffer.alloc(2048, 3)
      image[0] = 0xe9
      const upload = await run(['PUT', '/firmware/switch/9.9.9?description=Test%20polecenia', '--bin'], image)
      expect(upload.code).toBe(0)
      expect(upload.err).toContain('HTTP 200')
      expect(JSON.parse(upload.out)).toMatchObject({ enabled: true, version: '9.9.9' })
      const rootId = String((await DeviceModel.create({ deviceType: DeviceType.SWITCH, deviceId: 'AA00000000C1', firmwareVersion: '1.0.0' }))._id)
      const order = await run(['POST', `/api/devices/${rootId}/firmware-update`])
      expect(order.code).toBe(0)
      expect((await DeviceModel.findById(rootId).lean())?.firmwareUpdate?.version).toBe('9.9.9')
      const entry = await OperationLogModel.findOne({ rootId }).lean()
      expect(entry).toMatchObject({ actor: { type: 'system' }, source: 'Polecenie na serwerze' })
      const json = await run(['PUT', '/firmware/switch', '{"enabled":false}'])
      expect(json.code).toBe(0)
      expect(JSON.parse(json.out).enabled).toBe(false)
      const refused = await run(['POST', `/devices/${rootId}/firmware-update`])
      expect(refused.code).toBe(1)
      expect(refused.err).toContain('HTTP 409')
      expect((await run(['PUT', '/firmware/switch', '{zly json'])).code).toBe(2)
    })
  })
})
