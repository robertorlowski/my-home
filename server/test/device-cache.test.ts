// Pamięć dokumentów urządzeń (core/services/device-cache.service.ts): każdy rodzaj zapisu do devices ją kasuje.
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceModel } from '../src/core/models/device.model'
import { cachedDeviceById, cachedDeviceBySn, DEVICE_CACHE_TTL_MS } from '../src/core/services/device-cache.service'
import { DeviceType } from '../src/core/types'

describe('Pamięć dokumentów urządzeń', () => {
  let mongoServer: MongoMemoryServer

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
  })

  afterAll(async () => {
    await mongoose.disconnect()
    await mongoServer.stop()
  })

  it('zwraca dokument z pamięci i kasuje ją przy każdym zapisie', async () => {
    const device = await DeviceModel.create({ deviceType: DeviceType.SWITCH, deviceId: 'C0FFEE000001', name: 'a' })
    const id = String(device._id)
    const name = async () => (await cachedDeviceById(id))?.name

    expect(await name()).toBe('a')
    // zapis z pominięciem modelu nie kasuje pamięci: dokument zostaje do końca czasu ważności
    await DeviceModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { name: 'raw' } })
    expect(await name()).toBe('a')
    expect((await cachedDeviceById(id, Date.now() + DEVICE_CACHE_TTL_MS))?.name).toBe('raw')

    await DeviceModel.updateOne({ _id: id }, { $set: { name: 'b' } })
    expect(await name()).toBe('b')
    await DeviceModel.findByIdAndUpdate(id, { $set: { name: 'c' } })
    expect(await name()).toBe('c')
    await DeviceModel.updateMany({ _id: id }, { $set: { name: 'd' } })
    expect(await name()).toBe('d')
    await DeviceModel.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { name: 'e' } } } }])
    expect(await name()).toBe('e')
    const doc = await DeviceModel.findById(id)
    doc!.set('name', 'f')
    await doc!.save()
    expect(await name()).toBe('f')

    expect((await cachedDeviceBySn('C0FFEE000001', DeviceType.SWITCH))?.name).toBe('f')
    expect(await cachedDeviceBySn('C0FFEE000001', DeviceType.HP)).toBeNull()
    await DeviceModel.deleteMany({ _id: id })
    expect(await cachedDeviceById(id)).toBeNull()
    expect(await cachedDeviceBySn('C0FFEE000001', DeviceType.SWITCH)).toBeNull()
  })
})
