// Kod z aplikacji na telefonie (TOTP, od 2026-11-13; plan oracle-cloud/vm-prod/admin/docs/plan-logowanie-system-kodem.md):
// mechanizm (wektory RFC 6238, base32 RFC 4648, AES-256-GCM, adres otpauth), wspólna baza kluczy (totp_klucze, totp_uzyte
// z TTL 180 s), krok 1 logowania, logowanie kodem z telefonu z limitem prób, kod użyty w innej aplikacji, telefon
// zarejestrowany w innej aplikacji, rejestracja i wyłączenie (kodem z telefonu i z maila), konto system (klucz adresu
// SYSTEM_EMAIL, blokada system), serwer bez klucza, z innym kluczem i bez dostępu do bazy kluczy (kod z maila działa).
// Czas jest stały (vi.setSystemTime, tylko Date), więc kody z sąsiednich okien 30 s są przewidywalne.
import crypto from 'crypto'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
  getWeatherFor: () => null,
  setHomeWeatherKey: () => undefined,
  WEATHER_LOCATION: { lat: 49.37, lon: 20.01 },
}))

import app from '../src/core/app'
import { runCli } from '../src/core/cli'
import { AuthCodeModel } from '../src/core/models/auth.model'
import { ensureSystemUser, issueEmergencySystemCode } from '../src/core/services/auth.service'
import { outbox } from '../src/core/services/mail.service'
import { resetSettingsCache } from '../src/core/services/settings.service'
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, matchTotp, otpauthUrl, resetTotpIndex, TotpStoreError, totpCode,
  totpConfigProblem, totpProblem, totpWindow,
} from '../src/core/services/totp.service'

const KEY = crypto.randomBytes(32).toString('base64')
const ENV_KEYS = ['AUTH_DISABLED', 'LOGOWANIE_KLUCZ', 'LOGIN_KEYS_DB', 'SYSTEM_EMAIL', 'MAIL_ADMIN', 'SMTP_HOST', 'MAIL_RELAY', 'CLIENT_URL']
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const lastMail = (to: string) => [...outbox].reverse().find((mail) => mail.to === to)
const mailCode = (to: string) => /(\d{3}) (\d{3})/.exec(lastMail(to)?.subject ?? '')?.slice(1).join('') ?? ''

// logowanie kodem z maila (omija limit 60 s między kodami, jak w auth.test.ts)
async function loginByMail(email: string) {
  await mongoose.connection.collection('auth_codes').deleteMany({ email })
  await request(app).post('/api/auth/start').send({ email }).expect(200)
  const res = await request(app).post('/api/auth/verify').send({ email, code: mailCode(email) }).expect(200)
  return res.body.token as string
}

describe('TOTP: mechanizm', () => {
  it('kody z wektorów RFC 6238 (SHA-1, ostatnie 6 cyfr)', () => {
    const secret = Buffer.from('12345678901234567890')
    expect(totpCode(secret, 59_000)).toBe('287082')
    expect(totpCode(secret, 1_111_111_109_000)).toBe('081804')
    expect(totpCode(secret, 1_111_111_111_000)).toBe('050471')
    expect(totpCode(secret, 1_234_567_890_000)).toBe('005924')
    expect(totpCode(secret, 2_000_000_000_000)).toBe('279037')
    expect(totpCode(secret, 20_000_000_000_000)).toBe('353130')
  })

  it('base32 z RFC 4648 bez dopełnienia, odczyt klucza przepisanego ręcznie', () => {
    const vectors: Array<[string, string]> = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded)
      expect(base32Decode(encoded).toString()).toBe(plain)
    }
    const secret = crypto.randomBytes(20)
    const key = base32Encode(secret)
    expect(key).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(key.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(secret)).toBe(true)
  })

  it('okno bieżące i po jednym obok, dalsze nie; zwraca okno, w którym kod pasuje', () => {
    const secret = crypto.randomBytes(20)
    const now = 1_800_000_015_000
    const window = totpWindow(now)
    expect(matchTotp(secret, totpCode(secret, now), now)).toBe(window)
    expect(matchTotp(secret, totpCode(secret, now - 30_000), now)).toBe(window - 1)
    expect(matchTotp(secret, totpCode(secret, now + 30_000), now)).toBe(window + 1)
    const far = totpCode(secret, now - 60_000)
    if (![-1, 0, 1].some((shift) => totpCode(secret, now + shift * 30_000) === far)) expect(matchTotp(secret, far, now)).toBeNull()
    expect(matchTotp(secret, '12345', now)).toBeNull()
  })

  it('sekret: AES-256-GCM, „<iv>.<tag>.<szyfrogram>” w base64url; inny klucz i zmiana treści nie odszyfrowują', () => {
    const key = crypto.randomBytes(32)
    const secret = crypto.randomBytes(20)
    const text = encryptSecret(secret, key)
    const [iv, tag, data] = text.split('.')
    expect(text).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect([Buffer.from(iv, 'base64url').length, Buffer.from(tag, 'base64url').length, Buffer.from(data, 'base64url').length]).toEqual([12, 16, 20])
    expect(decryptSecret(text, key).equals(secret)).toBe(true)
    expect(() => decryptSecret(text, crypto.randomBytes(32))).toThrow(TotpStoreError)
    const flipped = Buffer.from(data, 'base64url')
    flipped[0] ^= 1
    expect(() => decryptSecret(`${iv}.${tag}.${flipped.toString('base64url')}`, key)).toThrow(TotpStoreError)
  })

  it('adres otpauth według ustaleń (jak w Archiwum: „@” bez kodowania, inne znaki kodowane)', () => {
    expect(otpauthUrl('robert@mojeturnie.pl', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/mojeturnie.pl:robert@mojeturnie.pl?secret=JBSWY3DPEHPK3PXP&issuer=mojeturnie.pl&algorithm=SHA1&digits=6&period=30')
    expect(otpauthUrl('a+b@x.pl', 'AAAA')).toContain('mojeturnie.pl:a%2Bb@x.pl?')
  })

  // Zgodność z Archiwum co do bajtu (vm-prod/archiwum/server/src/core/totp.ts): surowe 20 bajtów sekretu, AES-256-GCM,
  // iv 12 B, znacznik 16 B, bez AAD, base64url(iv).base64url(tag).base64url(szyfrogram), klucz = base64 LOGOWANIE_KLUCZ.
  // Wektor policzony tym samym algorytmem (node:crypto) dla klucza 01..20, iv a0..ab i sekretu z RFC 6238.
  it('zgodność szyfrowania z Archiwum: stały wektor i szyfrowanie w obie strony', () => {
    const key = Buffer.from('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=', 'base64')
    const vector = 'oKGio6Slpqeoqaqr.5ozepNhwKN1L8KxELYCm3A.iOMOUsiDbTxGPpNZwrEVsmDviSk'
    expect(decryptSecret(vector, key).toString()).toBe('12345678901234567890')
    // szyfrowanie drugiej aplikacji (to samo co encrypt w Archiwum, ze stałym iv) → odszyfrowanie tutaj
    const iv = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i))
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const sealed = Buffer.concat([cipher.update(Buffer.from('12345678901234567890')), cipher.final()])
    expect([iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64url')).join('.')).toBe(vector)
    // szyfrowanie tutaj → odszyfrowanie tak jak w Archiwum (decrypt: podział na trzy części, setAuthTag, bez AAD)
    const secret = crypto.randomBytes(20)
    const [ivText, tagText, dataText] = encryptSecret(secret, key).split('.')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    expect(Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).equals(secret)).toBe(true)
    // klucz spoza zwykłego base64 albo innej długości wyłącza kod z telefonu tak samo jak w Archiwum
    const saved = process.env.LOGOWANIE_KLUCZ
    try {
      // base64url (znaki _ i -) nie jest zwykłym base64
      process.env.LOGOWANIE_KLUCZ = Buffer.alloc(32, 0xff).toString('base64url')
      expect(totpConfigProblem()).toMatch(/32 bajty/)
      process.env.LOGOWANIE_KLUCZ = crypto.randomBytes(16).toString('base64')
      expect(totpConfigProblem()).toMatch(/32 bajty/)
      process.env.LOGOWANIE_KLUCZ = crypto.randomBytes(32).toString('base64')
      expect(totpConfigProblem()).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.LOGOWANIE_KLUCZ
      else process.env.LOGOWANIE_KLUCZ = saved
    }
  })

  it('polecenie --kod-totp: bieżący kod dla klucza bez bazy', async () => {
    const secret = crypto.randomBytes(20)
    const printed: string[] = []
    expect(await runCli(['--kod-totp', base32Encode(secret)], { print: (text) => printed.push(text) })).toBe(0)
    expect(printed[0]).toContain(totpCode(secret).replace(/(\d{3})(\d{3})/, '$1 $2'))
    expect(await runCli(['--kod-totp', 'zly'], { printError: () => undefined })).toBe(2)
  })
})

describe('Kod z telefonu: logowanie, rejestracja, wyłączenie', () => {
  let mongoServer: MongoMemoryServer
  let T0: number
  const DB = 'logowanie_test'
  const keys = () => mongoose.connection.useDb(DB, { useCache: true }).collection('totp_klucze')
  const used = () => mongoose.connection.useDb(DB, { useCache: true }).collection('totp_uzyte')
  const at = (ms: number) => vi.setSystemTime(T0 + ms)
  const code = (secret: Buffer, shiftWindows = 0) => totpCode(secret, Date.now() + shiftWindows * 30_000)
  const methods = (email: string) => request(app).post('/api/auth/methods').send({ email })
  const phoneLogin = (email: string, value: string) => request(app).post('/api/auth/totp/verify').send({ email, code: value })
  const systemVerify = (value: string) => request(app).post('/api/auth/system/verify').send({ code: value })

  // rejestracja przez API: kod QR i klucz, potwierdzenie bieżącym kodem
  async function register(token: string) {
    const setup = await request(app).post('/api/auth/totp/setup').set(bearer(token)).expect(200)
    const secret = base32Decode(setup.body.secret)
    await request(app).post('/api/auth/totp/confirm').set(bearer(token)).send({ code: code(secret) }).expect(200)
    return { secret, setup: setup.body }
  }

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0'
    process.env.LOGOWANIE_KLUCZ = KEY
    process.env.LOGIN_KEYS_DB = DB
    process.env.SYSTEM_EMAIL = 'wlasciciel@example.com'
    process.env.CLIENT_URL = 'https://app.example'
    for (const key of ['SMTP_HOST', 'MAIL_RELAY', 'MAIL_ADMIN']) delete process.env[key]
    resetSettingsCache()
    resetTotpIndex()
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    await ensureSystemUser()
    // środek okna 30 s, kilkadziesiąt sekund w przód: TTL bazy (prawdziwy czas) nie usuwa niczego w trakcie testu
    T0 = (Math.floor(Date.now() / 30_000) + 1) * 30_000 + 15_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  beforeEach(async () => {
    at(0)
    await keys().deleteMany({})
    await used().deleteMany({})
    await AuthCodeModel.deleteMany({})
  })

  afterAll(async () => {
    vi.useRealTimers()
    restoreEnv()
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('bez telefonu: krok 1 mówi totp false, kod z telefonu odrzucony, kod z maila działa jak dotąd', async () => {
    expect((await methods('Ewa@Example.com').expect(200)).body).toEqual({ email: 'ewa@example.com', totp: false })
    await methods('zly-adres').expect(400)
    expect((await phoneLogin('ewa@example.com', '123456').expect(400)).body.message).toMatch(/nie ma włączonego logowania kodem z telefonu/)
    await loginByMail('ewa@example.com')
  })

  it('rejestracja: kod QR i klucz, zapis dopiero po pierwszym kodzie, dokument według ustaleń, TTL totp_uzyte', async () => {
    const token = await loginByMail('ewa@example.com')
    expect((await request(app).get('/api/auth/totp').set(bearer(token)).expect(200)).body).toEqual({ available: true, enabled: false, address: 'ewa@example.com' })
    await request(app).get('/api/auth/totp').expect(401)
    const setup = await request(app).post('/api/auth/totp/setup').set(bearer(token)).expect(200)
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.body.qr).toMatch(/^data:image\/png;base64,/)
    expect(setup.body.otpauthUrl).toBe(otpauthUrl('ewa@example.com', setup.body.secret))
    expect(setup.body.expiresInSeconds).toBe(600)
    expect(await keys().countDocuments()).toBe(0)
    const secret = base32Decode(setup.body.secret)
    const wrong = code(secret) === '000000' ? '111111' : '000000'
    expect((await request(app).post('/api/auth/totp/confirm').set(bearer(token)).send({ code: wrong }).expect(400)).body.message).toMatch(/^Błędny kod z aplikacji/)
    const confirmed = await request(app).post('/api/auth/totp/confirm').set(bearer(token)).send({ code: code(secret) }).expect(200)
    expect(confirmed.body).toMatchObject({ available: true, enabled: true, address: 'ewa@example.com', app: 'my-home' })
    const doc = await keys().findOne({ _id: 'ewa@example.com' as never })
    expect(doc).toMatchObject({ _id: 'ewa@example.com', aplikacja: 'my-home' })
    expect(doc?.utworzono).toBeInstanceOf(Date)
    expect(decryptSecret(doc?.sekret).equals(secret)).toBe(true)
    expect(await used().findOne({ _id: `ewa@example.com:${totpWindow()}` as never })).toBeTruthy()
    const ttl = (await used().indexes()).find((index) => index.key?.czas === 1)
    expect(ttl?.expireAfterSeconds).toBe(180)
    // drugi telefon tylko po wyłączeniu
    await request(app).post('/api/auth/totp/setup').set(bearer(token)).expect(409)
  })

  it('logowanie kodem z telefonu: krok 1 totp true, ±30 s, kod działa raz, kod sprzed minuty odrzucony', async () => {
    const { secret } = await register(await loginByMail('ewa@example.com'))
    expect((await methods('ewa@example.com').expect(200)).body).toEqual({ email: 'ewa@example.com', totp: true })
    const far = code(secret, -2)
    if (![-1, 0, 1].some((shift) => code(secret, shift) === far)) {
      expect((await phoneLogin('ewa@example.com', far).expect(400)).body.message).toContain('Zostało prób: 4')
    }
    const ok = await phoneLogin('ewa@example.com', code(secret, -1)).expect(200)
    expect(ok.body).toMatchObject({ created: false, user: { email: 'ewa@example.com' } })
    expect((await phoneLogin('ewa@example.com', code(secret, -1)).expect(400)).body.message).toMatch(/już użyty/)
    await phoneLogin('ewa@example.com', code(secret, 1)).expect(200)
    // pytanie o zapamiętanie jak przy kodzie z maila
    await request(app).post('/api/auth/remember').set(bearer(ok.body.token)).send({ remember: true }).expect(200)
    // po udanym logowaniu licznik błędnych kodów znika
    expect(await AuthCodeModel.countDocuments({ purpose: 'totp-fail' })).toBe(0)
  })

  it('kod użyty już w innej aplikacji (totp_uzyte) nie działa', async () => {
    const { secret } = await register(await loginByMail('ewa@example.com'))
    at(90_000)
    const window = totpWindow()
    await used().insertMany([-1, 0, 1].map((shift) => ({ _id: `ewa@example.com:${window + shift}` as never, czas: new Date() })))
    expect((await phoneLogin('ewa@example.com', code(secret)).expect(400)).body.message).toMatch(/już użyty/)
  })

  it('5 błędnych kodów z telefonu blokuje kod z telefonu na 15 min, kod z maila działa dalej', async () => {
    const { secret } = await register(await loginByMail('ewa@example.com'))
    at(60_000)
    const wrong = [-1, 0, 1].map((shift) => code(secret, shift)).includes('000000') ? '999999' : '000000'
    for (let left = 4; left >= 1; left -= 1) {
      expect((await phoneLogin('ewa@example.com', wrong).expect(400)).body.message).toContain(`Zostało prób: ${left}`)
    }
    const locked = await phoneLogin('ewa@example.com', wrong).expect(429)
    expect(locked.body).toMatchObject({ locked: true })
    expect(locked.body.message).toMatch(/zablokowany na 15 min/)
    await phoneLogin('ewa@example.com', code(secret)).expect(429)
    await loginByMail('ewa@example.com')
    at(60_000 + 16 * 60_000)
    await phoneLogin('ewa@example.com', code(secret)).expect(200)
  })

  it('telefon zarejestrowany w innej aplikacji: krok 1 go widzi, kod z telefonu zakłada konto', async () => {
    const secret = crypto.randomBytes(20)
    await keys().insertOne({ _id: 'nowy@example.com' as never, sekret: encryptSecret(secret), utworzono: new Date(), aplikacja: 'archiwum' })
    expect((await methods('nowy@example.com').expect(200)).body.totp).toBe(true)
    const res = await phoneLogin('nowy@example.com', code(secret)).expect(200)
    expect(res.body).toMatchObject({ created: true, user: { email: 'nowy@example.com', profileComplete: false } })
    expect((await request(app).get('/api/auth/totp').set(bearer(res.body.token)).expect(200)).body).toMatchObject({ enabled: true, app: 'archiwum' })
  })

  it('wyłączenie: kodem z telefonu albo kodem z maila; klucz znika ze wspólnej bazy', async () => {
    const token = await loginByMail('ewa@example.com')
    const { secret } = await register(token)
    await request(app).post('/api/auth/totp/disable').set(bearer(token)).send({}).expect(400)
    at(30_000)
    const off = await request(app).post('/api/auth/totp/disable').set(bearer(token)).send({ code: code(secret) }).expect(200)
    expect(off.body).toMatchObject({ enabled: false })
    expect(await keys().countDocuments()).toBe(0)
    expect((await methods('ewa@example.com').expect(200)).body.totp).toBe(false)
    await request(app).post('/api/auth/totp/disable').set(bearer(token)).send({ code: '123456' }).expect(400)

    at(60_000)
    await register(token)
    await request(app).post('/api/auth/totp/disable/code').set(bearer(token)).expect(200)
    const mail = lastMail('ewa@example.com')
    expect(mail?.subject).toMatch(/^Wyłączenie kodu z telefonu: \d{3} \d{3}$/)
    await request(app).post('/api/auth/totp/disable').set(bearer(token)).send({ code: mailCode('ewa@example.com') }).expect(200)
    expect(await keys().countDocuments()).toBe(0)
  })

  it('konto system: klucz adresu SYSTEM_EMAIL, kod z telefonu w /auth/system/verify, błędne kody liczą się do blokady system', async () => {
    const systemToken = (await systemVerify((await issueEmergencySystemCode()).code).expect(200)).body.token as string
    expect((await request(app).get('/api/auth/totp').set(bearer(systemToken)).expect(200)).body).toMatchObject({ available: true, enabled: false, address: 'wlasciciel@example.com' })
    const { secret } = await register(systemToken)
    expect(await keys().findOne({ _id: 'wlasciciel@example.com' as never })).toBeTruthy()
    expect((await methods('system').expect(200)).body).toEqual({ email: 'system', totp: true })
    // bieżące okno zużyła rejestracja; następne mieści się w ±30 s
    await systemVerify(code(secret, 1)).expect(200)
    at(120_000)
    const wrong = [-1, 0, 1].map((shift) => code(secret, shift)).includes('000000') ? '999999' : '000000'
    for (let left = 4; left >= 1; left -= 1) expect((await systemVerify(wrong).expect(400)).body.message).toContain(`Zostało prób: ${left}`)
    expect((await systemVerify(wrong).expect(429)).body.locked).toBe(true)
    await systemVerify(code(secret)).expect(429)
    // polecenie awaryjne zdejmuje blokadę; kod z telefonu znów działa
    await issueEmergencySystemCode()
    await systemVerify(code(secret)).expect(200)
  })

  it('konto system bez adresu: telefonu nie da się włączyć', async () => {
    const systemToken = (await systemVerify((await issueEmergencySystemCode()).code).expect(200)).body.token as string
    delete process.env.SYSTEM_EMAIL
    try {
      expect((await request(app).get('/api/auth/totp').set(bearer(systemToken)).expect(200)).body).toMatchObject({ available: false, reason: 'address' })
      expect((await request(app).post('/api/auth/totp/setup').set(bearer(systemToken)).expect(503)).body.message).toMatch(/Adres kodów konta system/)
      expect((await methods('system').expect(200)).body.totp).toBe(false)
    } finally {
      process.env.SYSTEM_EMAIL = 'wlasciciel@example.com'
    }
  })

  it('serwer bez LOGOWANIE_KLUCZ albo z innym kluczem: kod z telefonu wyłączony, kod z maila działa', async () => {
    const token = await loginByMail('ewa@example.com')
    const { secret } = await register(token)
    at(30_000)
    try {
      delete process.env.LOGOWANIE_KLUCZ
      expect((await methods('ewa@example.com').expect(200)).body.totp).toBe(false)
      expect((await request(app).get('/api/auth/totp').set(bearer(token)).expect(200)).body).toMatchObject({ available: false, reason: 'off' })
      await request(app).post('/api/auth/totp/setup').set(bearer(token)).expect(503)
      expect(await totpProblem()).toBe('brak LOGOWANIE_KLUCZ')
      process.env.LOGOWANIE_KLUCZ = crypto.randomBytes(32).toString('base64')
      expect((await methods('ewa@example.com').expect(200)).body.totp).toBe(false)
      expect((await phoneLogin('ewa@example.com', code(secret)).expect(503)).body.message).toMatch(/chwilowo niedostępny/)
      await loginByMail('ewa@example.com')
    } finally {
      process.env.LOGOWANIE_KLUCZ = KEY
    }
  })
})

describe('Kod z telefonu: konto bazy bez dostępu do bazy kluczy', () => {
  let mongoServer: MongoMemoryServer

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0'
    process.env.LOGOWANIE_KLUCZ = KEY
    process.env.LOGIN_KEYS_DB = 'logowanie'
    for (const key of ['SMTP_HOST', 'MAIL_RELAY']) delete process.env[key]
    resetTotpIndex()
    // konto bazy aplikacji z rolą tylko do własnej bazy, jak myhome przed dodaniem roli do „logowanie”
    mongoServer = await MongoMemoryServer.create({
      auth: {
        enable: true, customRootName: 'root', customRootPwd: 'root-haslo',
        extraUsers: [{ createUser: 'myhome', pwd: 'myhome-haslo', roles: [{ role: 'readWrite', db: 'hpdb' }], database: 'admin' }],
      },
    })
    const { host } = new URL(mongoServer.getUri())
    await mongoose.connect(`mongodb://myhome:myhome-haslo@${host}/hpdb?authSource=admin`)
  })

  afterAll(async () => {
    restoreEnv()
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('krok 1 mówi totp false, karta konta „niedostępne”, logowanie kodem z maila działa', async () => {
    expect(await totpProblem()).toMatch(/baza logowanie/)
    expect((await request(app).post('/api/auth/methods').send({ email: 'ewa@example.com' }).expect(200)).body.totp).toBe(false)
    const token = await loginByMail('ewa@example.com')
    expect((await request(app).get('/api/auth/totp').set(bearer(token)).expect(200)).body).toMatchObject({ available: false, reason: 'store' })
    await request(app).post('/api/auth/totp/setup').set(bearer(token)).expect(503)
  })
})
