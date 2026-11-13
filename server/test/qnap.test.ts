// Testy poleceń dla QNAP-a przez sterownik co (core/services/qnap.service.ts, od 2026-11-13, próbnie; baza
// w mongodb-memory-server, prawdziwy serwer WebSocket i udawany sterownik): podpis HMAC-SHA256 z ciała (wspólny
// wektor), budowa ciała z nonce, czytelne błędy bez klucza, adresu i połączonego co, tylko token wewnętrzny,
// wiadomość tylko do gniazda sterownika (nie do przeglądarki), czekanie na qnap_wynik, brak odpowiedzi sterownika,
// polecenie --qnap i wpis w dzienniku operacji (bez treści odpowiedzi QNAP-a).
import crypto from 'crypto'
import { rmSync } from 'fs'
import { Server } from 'http'
import { AddressInfo } from 'net'
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../src/core/app'
import { runCli } from '../src/core/cli'
import { INTERNAL_TOKEN, INTERNAL_TOKEN_HEADER, internalTokenFile, saveInternalToken } from '../src/core/internal'
import { DeviceModel } from '../src/core/models/device.model'
import { OperationLogModel } from '../src/core/models/operation-log.model'
import { issueEmergencySystemCode } from '../src/core/services/auth.service'
import { cialoPolecenia, podpisCiala, QnapError, wyslijPolecenieQnap } from '../src/core/services/qnap.service'
import { DeviceType } from '../src/core/types'
import { createWsServer } from '../src/core/websocket'

const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
// przykładowy adres z sieci prywatnej (repozytorium jest publiczne: bez prawdziwych adresów)
const ADDRESS = '10.1.2.3:8250'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Message = Record<string, unknown>

describe('Polecenia dla QNAP-a przez sterownik co', () => {
  let mongoServer: MongoMemoryServer
  let server: Server
  let port: number
  let pumpRoot: string
  let systemToken: string
  const sockets: WebSocket[] = []

  // udawany sterownik (z powitaniem "ESP32") albo przeglądarka (bez powitania) dla rootId
  const connect = async (rootId: string, controller: boolean) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?rootId=${rootId}`)
    sockets.push(socket)
    const received: Message[] = []
    socket.on('message', (data) => received.push(JSON.parse(data.toString())))
    await new Promise((resolve) => socket.once('open', resolve))
    if (controller) socket.send('ESP32')
    await pause(50)
    return { socket, received }
  }
  const internal = { [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN }

  beforeAll(async () => {
    process.env.AUTH_DISABLED = '0'
    process.env.QNAP_POLECENIA_KLUCZ = KEY_HEX
    process.env.QNAP_ADRES = ADDRESS
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    createWsServer(server)
    port = (server.address() as AddressInfo).port
    systemToken = (await request(app).post('/api/auth/system/verify').send({ code: (await issueEmergencySystemCode()).code }).expect(200)).body.token
    pumpRoot = String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId: 'C0C0C0C0C001', name: 'Pompa' }))._id)
  })

  afterAll(async () => {
    sockets.forEach((socket) => socket.close())
    delete process.env.QNAP_POLECENIA_KLUCZ
    delete process.env.QNAP_ADRES
    await new Promise((resolve) => server.close(resolve))
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('podpis HMAC-SHA256 z ciała kluczem z hex (wspólny wektor) i ciało z losowym nonce', () => {
    const body = '{"wersja":1,"polecenie":"stan","czas":1763060000000,"nonce":"00112233445566778899aabbccddeeff"}'
    expect(cialoPolecenia('stan', 1763060000000, '00112233445566778899aabbccddeeff')).toBe(body)
    expect(podpisCiala(Buffer.from(KEY_HEX, 'hex'), body)).toBe('b79089468055c5fbb2542a360d0a8dc13a13c079af4a7967584cf7861659e231')
    const first = JSON.parse(cialoPolecenia('restart_sieci'))
    const second = JSON.parse(cialoPolecenia('restart_sieci'))
    expect(first).toMatchObject({ wersja: 1, polecenie: 'restart_sieci' })
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(first.nonce).not.toBe(second.nonce)
    expect(Math.abs(first.czas - Date.now())).toBeLessThan(5000)
    expect(Buffer.byteLength(cialoPolecenia('restart_sieci'))).toBeLessThanOrEqual(1024)
  })

  it('czytelne błędy: tylko token wewnętrzny, nieznane polecenie, brak klucza, adresu i połączonego co', async () => {
    expect((await request(app).post('/api/qnap/polecenia').send({ polecenie: 'stan' })).status).toBe(401)
    expect((await request(app).post('/api/qnap/polecenia').set({ Authorization: `Bearer ${systemToken}` }).send({ polecenie: 'stan' })).status).toBe(403)
    expect((await request(app).post('/api/qnap/polecenia').set(internal).send({ polecenie: 'wylacz' })).status).toBe(400)

    delete process.env.QNAP_POLECENIA_KLUCZ
    const noKey = await request(app).post('/api/qnap/polecenia').set(internal).send({ polecenie: 'stan' })
    expect(noKey.status).toBe(503)
    expect(noKey.body.message).toContain('QNAP_POLECENIA_KLUCZ')
    process.env.QNAP_POLECENIA_KLUCZ = KEY_HEX

    process.env.QNAP_ADRES = '203.0.113.5:8250'
    const badAddress = await request(app).post('/api/qnap/polecenia').set(internal).send({ polecenie: 'stan' })
    expect(badAddress.status).toBe(503)
    expect(badAddress.body.message).toContain('QNAP_ADRES')
    process.env.QNAP_ADRES = ADDRESS

    // sterownik co nie jest połączony
    await expect(wyslijPolecenieQnap({ polecenie: 'stan' })).rejects.toThrow(QnapError)
    const offline = await request(app).post('/api/qnap/polecenia').set(internal).send({ polecenie: 'stan' })
    expect(offline.status).toBe(409)
    expect(offline.body.message).toContain('nie jest teraz połączony')
  })

  it('wiadomość tylko do gniazda sterownika; wynik qnap_wynik kończy czekanie; wpis w dzienniku operacji', async () => {
    const browser = await connect(pumpRoot, false)
    const controller = await connect(pumpRoot, true)
    // udawany co: odpowiada jak usługa na QNAP-ie po sprawdzeniu podpisu
    controller.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Message
      if (message.typ !== 'qnap') return
      const valid = podpisCiala(Buffer.from(KEY_HEX, 'hex'), String(message.cialo)) === message.podpis
      controller.socket.send(JSON.stringify({ typ: 'qnap_wynik', id: message.id, status: valid ? 200 : 403,
        cialo: JSON.stringify({ ok: valid, polecenie: JSON.parse(String(message.cialo)).polecenie, stan: { siec: true } }) }))
    })

    const result = await wyslijPolecenieQnap({ polecenie: 'stan' })
    expect(result).toMatchObject({ polecenie: 'stan', rootId: pumpRoot, status: 200 })
    expect(JSON.parse(result.cialo)).toMatchObject({ ok: true, polecenie: 'stan' })
    const sent = controller.received.find((message) => message.typ === 'qnap')!
    expect(sent).toMatchObject({ typ: 'qnap', id: result.id, adres: ADDRESS })
    expect(JSON.parse(String(sent.cialo))).toMatchObject({ wersja: 1, polecenie: 'stan' })
    // przeglądarka z tym samym rootId nie dostaje polecenia ani podpisu
    expect(browser.received.some((message) => message.typ === 'qnap')).toBe(false)

    const entry = await OperationLogModel.findOne({ rootId: pumpRoot, action: /QNAP: stan/ }).lean()
    expect(entry).toMatchObject({ action: 'QNAP: stan — HTTP 200', status: 'done', actor: { type: 'system' } })
    expect(JSON.stringify(entry)).not.toContain('siec')

    // wynik z gniazda innego sterownika nie zastępuje odpowiedzi tego, do którego poszło polecenie
    const otherRoot = String((await DeviceModel.create({ deviceType: DeviceType.SWITCH, deviceId: 'C0C0C0C0C0F1' }))._id)
    const intruder = await connect(otherRoot, true)
    const silent = await connect(pumpRoot, true)
    controller.socket.close()
    await pause(50)
    const pending = wyslijPolecenieQnap({ polecenie: 'restart_sieci' }, undefined, 500)
    await pause(100)
    const request_ = silent.received.find((message) => message.typ === 'qnap')!
    intruder.socket.send(JSON.stringify({ typ: 'qnap_wynik', id: request_.id, status: 200, cialo: '{}' }))
    const lost = await pending
    expect(lost).toMatchObject({ status: 0, brakOdpowiedziSterownika: true })
    expect(await OperationLogModel.findOne({ rootId: pumpRoot, action: /restart_sieci/ }).lean())
      .toMatchObject({ action: 'QNAP: restart_sieci — brak odpowiedzi sterownika w 1 s', status: 'error' })
    silent.socket.close()
    intruder.socket.close()
    await pause(50)
  })

  it('polecenie --qnap na serwerze: wynik na wyjściu, kod 0 przy 200, w dzienniku „Polecenie na serwerze (--qnap)”', async () => {
    process.env.PORT = String(port)
    delete process.env.INTERNAL_API_URL
    saveInternalToken(port)
    const controller = await connect(pumpRoot, true)
    controller.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Message
      if (message.typ === 'qnap') {
        controller.socket.send(JSON.stringify({ typ: 'qnap_wynik', id: message.id, status: 429, cialo: '{"ok":false,"blad":"limit"}' }))
      }
    })
    try {
      const out: string[] = []
      const err: string[] = []
      expect(await runCli(['--qnap', 'wylacz'], { print: (text) => out.push(text), printError: (text) => err.push(text) })).toBe(2)
      const code = await runCli(['--qnap', 'restart'], { print: (text) => out.push(text), printError: (text) => err.push(text) })
      // QNAP odpowiedział 429 (limit): wynik wypisany, kod wyjścia 1
      expect(code).toBe(1)
      expect(JSON.parse(out[out.length - 1])).toMatchObject({ polecenie: 'restart', status: 429, cialo: '{"ok":false,"blad":"limit"}' })
      expect(err[err.length - 1]).toBe('HTTP 200')
      expect(await OperationLogModel.findOne({ rootId: pumpRoot, action: /QNAP: restart —/ }).lean())
        .toMatchObject({ action: 'QNAP: restart — HTTP 429', status: 'error', source: 'Polecenie na serwerze (--qnap)' })
    } finally {
      controller.socket.close()
      rmSync(internalTokenFile(port), { force: true })
    }
  })

  it('crypto: klucz z hex, nie z tekstu (inny tekst klucza = inny podpis)', () => {
    const body = cialoPolecenia('stan', 1, 'ab'.repeat(16))
    expect(podpisCiala(Buffer.from(KEY_HEX, 'hex'), body)).not.toBe(crypto.createHmac('sha256', KEY_HEX).update(body).digest('hex'))
  })
})
