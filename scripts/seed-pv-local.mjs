// Dane demonstracyjne fotowoltaiki w lokalnej bazie (npm run local): czyści bazę i wczytuje z
// produkcji historię PV — podsumowanie PV z rekordów hp (moc, produkcja dziś, licznik, temperatura)
// i odczyty pv z panelami — dla urządzeń pompy ciepła i fotowoltaiki o zmyślonym SN.
//
//   node scripts/seed-pv-local.mjs                    wszystkie dni z danymi na produkcji
//   node scripts/seed-pv-local.mjs --from 2026-09-01  od podanego dnia
//   node scripts/seed-pv-local.mjs --keep             bez czyszczenia bazy: po seed-local.mjs dopisuje
//                                                     historię PV do jego pompy ciepła (dni, których
//                                                     pompa nie ma) i podmienia jego odczyty pv
//
// Bezpieczeństwo jak w seed-local.mjs: zapis tylko do bazy lokalnej, produkcja tylko czytana
// (publiczne GET API), rootId, SN sterownika i numery seryjne mikrofalowników zastąpione
// zmyślonymi (numer mikrofalownika zachowuje pierwsze 4 cyfry — z nich aplikacja zgaduje model).
// Rekordy hp dostają tylko pola PV (bez telemetrii pompy). Po wczytaniu zrestartować serwer.
import mongoose from 'mongoose';
import { LOCAL_DB_URI } from './local-dev.mjs';

const PRODUCTION_API = 'https://chpc-web.onrender.com/api';
const args = process.argv.slice(2);
const FROM = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
const KEEP = args.includes('--keep');
const DEMO_SN = 'A0B1C2D3E4F5';
const CONCURRENCY = 3;

if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27027\//.test(LOCAL_DB_URI)) {
  throw new Error(`To nie jest baza lokalna: ${LOCAL_DB_URI}`);
}

async function getJson(path) {
  const response = await fetch(`${PRODUCTION_API}${path}`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const serials = new Map();
const demoSerial = (serial) => {
  if (!serials.has(serial)) serials.set(serial, `${serial.slice(0, 4)}000000${String(serials.size + 1).padStart(2, '0')}`);
  return serials.get(serial);
};

await mongoose.connect(LOCAL_DB_URI);
const db = mongoose.connection.db;
if (!KEEP) {
  for (const { name } of await db.listCollections().toArray()) await db.collection(name).drop();
  console.log(`Wyczyszczono bazę ${db.databaseName}`);
}

const devices = await getJson('/devices');
const source = devices.find((device) => device.deviceType === 'heat_pump');
if (!source) throw new Error('Na produkcji nie ma pompy ciepła');
const dates = (await getJson(`/hp/dates?rootId=${source.rootId}`))
  .map((d) => d.replace(/\./g, '-'))
  .filter((d) => !FROM || d >= FROM)
  .sort();
console.log(`Dni z danymi: ${dates.length} (${dates[0]} – ${dates[dates.length - 1]}), pobieranie (tylko odczyt)…`);

const now = new Date();
// --keep: pompa ciepła z seed-local.mjs (ten sam zmyślony SN), dni z jej telemetrią zostają
const existing = KEEP ? await db.collection('devices').findOne({ deviceType: 'heat_pump', deviceId: DEMO_SN }) : null;
const hpRoot = existing?._id ?? new mongoose.Types.ObjectId();
const pvRoot = new mongoose.Types.ObjectId();
if (!existing) {
  await db.collection('devices').insertOne(
    { _id: hpRoot, deviceType: 'heat_pump', deviceId: DEMO_SN, name: 'Pompa ciepła', schedules: [], createdAt: now, updatedAt: now });
}
await db.collection('devices').deleteMany({ deviceType: 'photovoltaic', deviceId: DEMO_SN });
await db.collection('devices').insertOne(
  { _id: pvRoot, deviceType: 'photovoltaic', deviceId: DEMO_SN, name: 'Fotowoltaika', schedules: [], createdAt: now, updatedAt: now });
const identity = { rootId: String(hpRoot), deviceType: 'heat_pump', deviceId: DEMO_SN };
const daysWithTelemetry = new Set();
if (KEEP) {
  const rows = await db.collection('hp').aggregate([
    { $match: { rootId: String(hpRoot) } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Europe/Warsaw' } } } },
  ]).toArray();
  rows.forEach((row) => daysWithTelemetry.add(row._id));
  await db.collection('pv').deleteMany({ rootId: String(hpRoot) });
}

let hpCount = 0;
let pvCount = 0;
let done = 0;
async function loadDay(date) {
  const [hp, pv] = await Promise.all([
    getJson(`/hp/4day?rootId=${source.rootId}&date=${date}`),
    getJson(`/pv/range?rootId=${source.rootId}&date=${date}`),
  ]);
  const hpPv = hp.filter((record) => record.PV).map((record) => ({
    ...identity, time: record.time, PV: record.PV,
    createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt ?? record.createdAt),
  }));
  if (hpPv.length && !daysWithTelemetry.has(date)) await db.collection('hp').insertMany(hpPv);
  if (pv.length) {
    await db.collection('pv').insertMany(pv.map(({ _id, __v, ...record }) => ({
      ...record, ...identity,
      createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt ?? record.createdAt),
      ...(record.panels ? { panels: record.panels.map((panel) => ({ ...panel, serial: demoSerial(panel.serial) })) } : {}),
    })));
  }
  hpCount += hpPv.length;
  pvCount += pv.length;
  done += 1;
  if (done % 10 === 0) console.log(`  ${done}/${dates.length} dni`);
}

const queue = [...dates];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await loadDay(queue.shift());
}));
console.log(`Fotowoltaika: ${hpCount} podsumowań PV z hp, ${pvCount} odczytów pv, mikrofalowniki: ${serials.size}`);
console.log(`Urządzenie fotowoltaiki: rootId ${pvRoot}${KEEP ? '' : ' (domyślne)'}`);
await mongoose.disconnect();
