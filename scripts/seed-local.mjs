// Dane demonstracyjne w lokalnej bazie (npm run local): czyści bazę, wczytuje
// z produkcji telemetrię pompy ciepła i PV z ostatnich dni oraz generuje
// kilka miesięcy danych hydroforu. Służy do pokazania aplikacji i do zrzutów
// ekranu w dokumentacji (docs/).
//
//   node scripts/seed-local.mjs              7 dni pompy z produkcji + hydrofor
//   node scripts/seed-local.mjs --days 14    więcej dni pompy
//   node scripts/seed-local.mjs --no-prod    bez produkcji: tylko hydrofor
//
// Bezpieczeństwo:
// - zapis tylko do bazy lokalnej (LOCAL_DB_URI); inny adres przerywa skrypt;
// - produkcja jest tylko czytana (publiczne GET API, bez haseł do Atlasa);
// - identyfikatory z produkcji (rootId, SN sterownika, numery seryjne
//   mikrofalowników) są zastępowane zmyślonymi. API serwera nie wymaga klucza,
//   więc prawdziwy rootId na zrzucie w publicznym repozytorium pozwoliłby
//   sterować pompą; pomiary (temperatury, moc) zostają prawdziwe.
//
// Po wczytaniu trzeba zrestartować lokalny serwer (trzyma w pamięci ostatnią
// telemetrię i dane urządzeń), np. zatrzymać i uruchomić npm run local.
import mongoose from 'mongoose';
import { LOCAL_DB_URI } from './local-dev.mjs';

const PRODUCTION_API = 'https://chpc-web.onrender.com/api';
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 7;
const WITH_PRODUCTION = !args.includes('--no-prod');

// zmyślone identyfikatory demo (SN = 12 znaków hex jak MAC ESP32)
const DEMO_HEAT_PUMP = { deviceId: 'A0B1C2D3E4F5', name: 'Pompa ciepła' };
const DEMO_TANK = { deviceId: 'C3A0B1C2D3E4', name: 'Hydrofor' };

if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27027\//.test(LOCAL_DB_URI)) {
  throw new Error(`To nie jest baza lokalna: ${LOCAL_DB_URI}`);
}

const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};
const toDates = (doc) => ({
  ...doc,
  ...(doc.createdAt ? { createdAt: new Date(doc.createdAt) } : {}),
  ...(doc.updatedAt ? { updatedAt: new Date(doc.updatedAt) } : {}),
});
const withoutIds = ({ _id, __v, ...rest }) => rest;

async function getJson(path) {
  const response = await fetch(`${PRODUCTION_API}${path}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

await mongoose.connect(LOCAL_DB_URI);
const db = mongoose.connection.db;
for (const { name } of await db.listCollections().toArray()) await db.collection(name).drop();
console.log(`Wyczyszczono bazę ${db.databaseName}`);

// --- pompa ciepła z produkcji ---
if (WITH_PRODUCTION) {
  const devices = await getJson('/devices');
  const source = devices.find((device) => device.deviceType === 'heat_pump');
  if (!source) throw new Error('Na produkcji nie ma pompy ciepła');
  const query = (extra) => `?rootId=${source.rootId}${extra}`;
  const range = `&startDate=${day(-(DAYS - 1))}&endDate=${day(0)}`;
  console.log(`Pobieranie ${DAYS} dni z produkcji (tylko odczyt)…`);
  const [properties, schedules, hp, pv] = await Promise.all([
    getJson(`/device/properties${query('')}`),
    getJson(`/schedules${query('')}`),
    getJson(`/hp/4day${query(range)}`),
    getJson(`/pv/range${query(range)}`),
  ]);

  const rootId = new mongoose.Types.ObjectId();
  const now = new Date();
  await db.collection('devices').insertOne({
    _id: rootId,
    deviceType: 'heat_pump',
    ...DEMO_HEAT_PUMP,
    properties,
    schedules: schedules.map((schedule) => ({
      ...toDates(withoutIds(schedule)),
      _id: new mongoose.Types.ObjectId(),
      ...(schedule.date ? { date: new Date(schedule.date) } : {}),
    })),
    createdAt: now,
    updatedAt: now,
  });

  const identity = { rootId: String(rootId), deviceType: 'heat_pump', deviceId: DEMO_HEAT_PUMP.deviceId };
  await db.collection('hp').insertMany(hp.map((record) => ({ ...toDates(withoutIds(record)), ...identity })));

  // numery seryjne mikrofalowników zastąpione kolejnymi zmyślonymi
  const serials = new Map();
  const demoSerial = (serial) => {
    if (!serials.has(serial)) serials.set(serial, `1164000000${String(serials.size + 1).padStart(2, '0')}`);
    return serials.get(serial);
  };
  if (pv.length) {
    await db.collection('pv').insertMany(pv.map((record) => ({
      ...toDates(withoutIds(record)),
      ...identity,
      ...(record.panels ? { panels: record.panels.map((panel) => ({ ...panel, serial: demoSerial(panel.serial) })) } : {}),
    })));
  }
  console.log(`Pompa ciepła: ${hp.length} odczytów, ${pv.length} odczytów PV, ${schedules.length} harmonogramy`);
}

// --- hydrofor: dane wygenerowane ---
// Generator z ziarnem: przy każdym uruchomieniu skryptu te same dane.
let seed = 20260601;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const TANK_PROPERTIES = { compressor_seconds: 30, work_mode: 'CWU' };
// „rzeczywisty” przepływ pompy [l/s]; serwer wyliczy go z odczytów wodomierza (ok. 60 l/min)
const REAL_FLOW = 1.0;

const tankRootId = new mongoose.Types.ObjectId();
await db.collection('devices').insertOne({
  _id: tankRootId,
  deviceType: 'water-pressure-tank',
  ...DEMO_TANK,
  properties: TANK_PROPERTIES,
  schedules: [],
  createdAt: new Date('2026-06-01T08:00:00Z'),
  updatedAt: new Date(),
});

const runs = [];
const realWaterByDay = new Map();
let runId = 481205;
const start = new Date('2026-06-01T00:00:00');
const now = new Date();
for (const date = new Date(start); date <= now; date.setDate(date.getDate() + 1)) {
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const count = Math.round((weekend ? 4 : 2.5) + random() * 3);
  for (let index = 0; index < count; index++) {
    const hour = 6 + Math.floor(random() * 16);
    const pumpStart = new Date(date);
    pumpStart.setHours(hour, Math.floor(random() * 60), Math.floor(random() * 60), 0);
    if (pumpStart > now) continue;
    const pumpSeconds = Math.round(55 + random() * 110);
    const restarts = random() < 0.04 ? 1 : 0;
    const compressorEnd = 31 + restarts * 45;
    const approximate = random() < 0.02;
    runs.push({
      rootId: String(tankRootId), deviceType: 'water-pressure-tank', deviceId: DEMO_TANK.deviceId, runId: runId++,
      pumpStart, pumpEnd: new Date(pumpStart.getTime() + pumpSeconds * 1000),
      compressorStart: new Date(pumpStart.getTime() + 1000),
      compressorEnd: new Date(pumpStart.getTime() + Math.min(compressorEnd, pumpSeconds) * 1000),
      restarts, manualSeconds: 0, timeApproximate: approximate,
      lastSeenAt: new Date(pumpStart.getTime() + pumpSeconds * 1000),
      createdAt: pumpStart, updatedAt: new Date(pumpStart.getTime() + pumpSeconds * 1000),
    });
    const key = pumpStart.toISOString().slice(0, 10);
    const real = pumpSeconds * REAL_FLOW * (0.95 + random() * 0.1);
    realWaterByDay.set(key, (realWaterByDay.get(key) ?? 0) + real);
  }
}
runs.sort((a, b) => a.pumpStart - b.pumpStart);
await db.collection('water_pressure_tank').insertMany(runs);

// odczyty wodomierza: stan narasta o „rzeczywistą” wodę z uruchomień
const readingDates = ['2026-06-01', '2026-07-01', '2026-07-16', '2026-08-01', '2026-09-01', '2026-09-15', day(-1)];
let meter = 187.25;
let previous = '2026-06-01';
const readings = readingDates.filter((date, index, list) => list.indexOf(date) === index).map((date, index) => {
  if (index > 0) {
    for (const [key, liters] of realWaterByDay) if (key >= previous && key < date) meter += liters / 1000;
    previous = date;
  }
  return {
    rootId: String(tankRootId), readAt: new Date(`${date}T12:00:00`), valueM3: Math.round(meter * 1000) / 1000,
    note: index === 0 ? 'stan początkowy' : '', createdAt: new Date(`${date}T12:00:00`), updatedAt: new Date(`${date}T12:00:00`),
  };
});
await db.collection('water_meter').insertMany(readings);
console.log(`Hydrofor: ${runs.length} uruchomień od 2026-06-01, ${readings.length} odczytów wodomierza (k ≈ ${REAL_K})`);

await mongoose.disconnect();
console.log('Gotowe. Zrestartuj lokalny serwer (npm run local), żeby odświeżył pamięć podręczną.');
