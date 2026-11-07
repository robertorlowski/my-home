// Eksport CSV pompy (GET /hp/all, supertest na core/app, baza w mongodb-memory-server): odpowiedź strumieniem
// ma być tym samym JSON-em co tablica z bazy, także po kompresji, bez rekordów innego sterownika i z poprzedniego roku.
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/services/meteo.service', () => ({
  getTemperature: () => null,
  setOutdoorTemperature: () => undefined,
}))

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { HpEntryModel } from '../src/modules/heat-pump/models/hp.model'
import { jsonArrayChunks } from '../src/modules/heat-pump/services/hp.service'
import { DeviceType } from '../src/core/types'

const entries = (rootId: string, deviceId: string, count: number, from: Date) =>
  Array.from({ length: count }, (_, i) => ({
    rootId,
    deviceId,
    deviceType: DeviceType.HP,
    work_mode: 'CWU',
    time: `rekord "${i}" ąę`,
    HP: { Ttarget: 40 + (i % 5) },
    createdAt: new Date(from.getTime() + i * 1000),
  }))

const device = async (deviceId: string) =>
  String((await DeviceModel.create({ deviceType: DeviceType.HP, deviceId, name: deviceId, schedules: [] }))._id)

describe('GET /hp/all', () => {
  let mongoServer: MongoMemoryServer
  let rootId: string
  let otherRootId: string
  let emptyRootId: string
  const year = new Date().getUTCFullYear()

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    rootId = await device('eksport-1')
    otherRootId = await device('eksport-2')
    emptyRootId = await device('eksport-3')
    await HpEntryModel.collection.insertMany([
      ...entries(rootId, 'eksport-1', 1201, new Date(Date.UTC(year, 0, 2))),
      ...entries(rootId, 'eksport-1', 3, new Date(Date.UTC(year - 1, 5, 1))),
      ...entries(otherRootId, 'eksport-2', 2, new Date(Date.UTC(year, 0, 3))),
    ] as never[])
  })

  afterAll(async () => {
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  // to, co wysyłała poprzednia wersja: tablica z bazy przepuszczona przez JSON
  const expected = async () => JSON.parse(JSON.stringify(
    await HpEntryModel.find({ rootId, createdAt: { $gte: new Date(Date.UTC(year, 0, 1)) } }).sort({ createdAt: -1 }).lean()
  ))

  it('zwraca rekordy sterownika z bieżącego roku, od najnowszego, bez kompresji', async () => {
    const response = await request(app).get(`/api/hp/all?rootId=${rootId}&deviceId=eksport-1`).set('Accept-Encoding', 'identity').expect(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.body).toHaveLength(1201)
    expect(response.body).toEqual(await expected())
    expect(response.body[0].time).toBe('rekord "1200" ąę')
  })

  it('po kompresji gzip daje ten sam JSON', async () => {
    const response = await request(app).get(`/api/hp/all?rootId=${rootId}&deviceId=eksport-1`).set('Accept-Encoding', 'gzip').expect(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.body).toEqual(await expected())
  })

  it('bez rekordów zwraca pustą tablicę', async () => {
    const response = await request(app).get(`/api/hp/all?rootId=${emptyRootId}&deviceId=eksport-3`).expect(200)
    expect(response.body).toEqual([])
  })

  it('błąd bazy przed pierwszym rekordem daje 500', async () => {
    const find = vi.spyOn(HpEntryModel, 'find').mockImplementationOnce(() => { throw new Error('baza niedostępna') })
    const response = await request(app).get(`/api/hp/all?rootId=${rootId}&deviceId=eksport-1`).expect(500)
    expect(response.body.message).toContain('baza niedostępna')
    find.mockRestore()
  })

  it('składa poprawny JSON z kawałków niezależnie od ich wielkości', async () => {
    async function* rest() { yield { a: 2 }; yield { a: 3 }; yield { a: 4 } }
    const parts: string[] = []
    for await (const part of jsonArrayChunks({ a: 1 }, rest(), 2)) parts.push(part)
    expect(parts.length).toBeGreaterThan(1)
    expect(JSON.parse(parts.join(''))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])
  })
})
