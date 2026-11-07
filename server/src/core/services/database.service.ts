// Rozmiar bazy MongoDB dla stopki strony /devices (GET /api/devices/db-stats): miejsce na dysku po kompresji,
// czyli storageSize + indexSize z db.stats(), a „działa” = odpowiedź na ping (z czasem odpowiedzi).
// Do 2026-11-07 procent limitu 512 MB planu Atlas M0; na Oracle ten limit nie obowiązuje.
import mongoose from 'mongoose';

export type DatabaseStats = {
  ok: boolean;
  usedBytes: number;
  dataBytes: number;
  indexBytes: number;
  collections: number;
  documents: number;
  pingMs: number;
};

export async function getDatabaseStats(): Promise<DatabaseStats> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) throw new Error('Brak połączenia z bazą danych.');
  const started = Date.now();
  const ping = await db.command({ ping: 1 });
  const pingMs = Date.now() - started;
  const stats = await db.stats();
  const dataBytes = Number(stats.storageSize ?? 0);
  const indexBytes = Number(stats.indexSize ?? 0);
  return {
    ok: ping?.ok === 1,
    usedBytes: dataBytes + indexBytes,
    dataBytes,
    indexBytes,
    collections: Number(stats.collections ?? 0),
    documents: Number(stats.objects ?? 0),
    pingMs,
  };
}
