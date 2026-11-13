// Testy pogody pobieranej przez serwer (od 2026-11-07, core/services/weather-fetch.service.ts; baza
// w mongodb-memory-server): zapytanie do Open-Meteo jak w firmware, odczyt jednego i wielu miejsc, zapis pogody
// kafelków; sterowniki nie dostają miejsc i nie dostarczają pogody (zapas z włącznika i co usunięty 2026-11-13).
import request from 'supertest'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import app from '../src/core/app'
import { DeviceModel } from '../src/core/models/device.model'
import { WeatherTileModel } from '../src/core/models/weather-tile.model'
import { weatherQueries } from '../src/core/services/weather-tile.service'
import { fetchServerWeather, openMeteoUrl, parseOpenMeteo } from '../src/core/services/weather-fetch.service'

const current = (temperature: number) => ({
  current: {
    time: '2026-11-07T23:30', interval: 900, temperature_2m: temperature, weather_code: 3, cloud_cover: 90,
    precipitation: 0.2, rain: 0.2, snowfall: 0, wind_speed_10m: 6.2, is_day: 0,
  },
})
const reading = (temp: number) => ({ temp, code: 3, cloud: 100, precip: 0, rain: 0, snow: 0, wind: 6, day: 1, age_s: 10 })

describe('Pogoda pobierana przez serwer', () => {
  let mongoServer: MongoMemoryServer

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
  })
  afterAll(async () => {
    await mongoose.disconnect()
    await mongoServer.stop()
  })
  beforeEach(async () => {
    await WeatherTileModel.deleteMany({})
    await DeviceModel.deleteMany({})
  })

  it('pyta Open-Meteo jak firmware (model ICON, czas Warszawy) o wszystkie miejsca naraz', () => {
    const url = openMeteoUrl([{ id: 'a', lat: 49.374298, lon: 20.007237 }, { id: 'b', lat: 50.06, lon: 19.94 }])
    expect(url).toBe('https://api.open-meteo.com/v1/forecast?latitude=49.3743,50.0600&longitude=20.0072,19.9400'
      + '&current=temperature_2m,weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,is_day'
      + '&timezone=Europe%2FWarsaw&models=icon_seamless')
  })

  it('czyta odpowiedź dla jednego miejsca (obiekt) i wielu (tablica), pomija niepełne', () => {
    const one = [{ id: 'a', lat: 49, lon: 20 }]
    expect(parseOpenMeteo(current(-2.1), one)).toEqual([
      { id: 'a', temp: -2.1, code: 3, cloud: 90, precip: 0.2, rain: 0.2, snow: 0, wind: 6.2, day: 0, age_s: 0 },
    ])
    const two = [...one, { id: 'b', lat: 50, lon: 19 }]
    const broken = { current: { ...current(1).current, wind_speed_10m: null } }
    expect(parseOpenMeteo([current(1), broken], two).map((item) => item.id)).toEqual(['a'])
    // inna liczba miejsc niż w zapytaniu: nic, bo kolejność nie jest pewna
    expect(parseOpenMeteo([current(1)], two)).toEqual([])
    expect(parseOpenMeteo({ error: true, reason: 'x' }, one)).toEqual([])
  })

  it('zapisuje pogodę kafelków; przy błędzie HTTP zgłasza wyjątek', async () => {
    const krakow = (await request(app).post('/api/weather-tiles').send({ name: 'Kraków', lat: 50.06, lon: 19.94 }).expect(201)).body
    const places = await weatherQueries()
    let asked = ''
    const ok = await fetchServerWeather(places, new Date(), async (url) => {
      asked = url
      return { ok: true, status: 200, json: async () => [current(-2.1), current(4.5)] }
    })
    expect(ok).toBe(true)
    expect(asked).toContain('latitude=49.3743,50.0600')
    const tiles = (await request(app).get('/api/weather-tiles')).body
    expect(tiles[0].weather).toMatchObject({ temperature: -2.1, code: 3, cloudCover: 90, isDay: false })
    expect(tiles.find((tile: { id: string }) => tile.id === krakow.id).weather.temperature).toBe(4.5)
    expect((await request(app).get('/api/temperature')).body).toMatchObject({ temperature: -2.1, temperatureSource: 'forecast' })

    await expect(fetchServerWeather(places, new Date(), async () => ({ ok: false, status: 429, json: async () => ({}) })))
      .rejects.toThrow('Open-Meteo HTTP 429')
  })

  it('włącznik nie dostaje miejsc pogody, a jego pole weather (firmware do 1.3.7) jest pomijane', async () => {
    const device = (await request(app).post('/api/devices/register').send({ deviceId: 'AABBCCDDEE01', deviceType: 'switch' })).body
    const krakow = (await request(app).post('/api/weather-tiles').send({ name: 'Kraków', lat: 50.06, lon: 19.94 }).expect(201)).body
    expect((await weatherQueries()).map((query) => query.id)).toContain(krakow.id)

    const answer = await request(app).post(`/api/switch/state?rootId=${device.rootId}`)
      .send({ uptimeS: 60, relays: [{ on: false, changedS: 60 }], weather: [{ id: krakow.id, ...reading(9.5) }] }).expect(200)
    expect(answer.body.weather_queries).toBeUndefined()
    expect(answer.body.weather_query).toBeUndefined()
    expect(answer.body.relays).toHaveLength(1)
    expect((await request(app).get('/api/weather-tiles')).body.find((t: { id: string }) => t.id === krakow.id).weather).toBeNull()
  })
})
