// Lokalne środowisko bez bazy produkcyjnej: trwała baza MongoDB w .local-db/ (poza gitem),
// serwer na porcie 4001 i klient Vite na porcie 5173 (klient w trybie dev łączy się z portem 4001
// na tym samym hoście, z którego otwarto stronę).
//
//   npm run local            uruchamia bazę, serwer i klienta; Ctrl+C zatrzymuje wszystko
//   npm run local -- --host  jak wyżej, klient dostępny też z sieci lokalnej (np. z telefonu)
//   npm run local -- --db    tylko baza (np. dla testów E2E, które same uruchamiają serwer)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, '.local-db');
export const LOCAL_DB_PORT = 27027;
export const LOCAL_DB_URI = `mongodb://127.0.0.1:${LOCAL_DB_PORT}/chpc-local`;

export async function startLocalDb() {
  mkdirSync(dbPath, { recursive: true });
  return MongoMemoryServer.create({
    instance: { dbPath, port: LOCAL_DB_PORT, storageEngine: 'wiredTiger' },
  });
}

export function startServer(extraEnv = {}) {
  return spawn('npm', ['run', 'dev', '-w', 'server'], {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, MONGODB_URI: LOCAL_DB_URI, PORT: '4001', BACKGROUND_JOBS: 'on', ...extraEnv },
  });
}

export function startClient(port = 5173, host = false) {
  const hostArgs = host ? ['--host'] : [];
  return spawn('npm', ['run', 'dev', '-w', 'client', '--', '--port', String(port), '--strictPort', ...hostArgs], {
    cwd: root,
    shell: true,
    stdio: 'inherit',
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mongo = await startLocalDb();
  console.log(`[local] MongoDB: ${LOCAL_DB_URI} (dane w ${dbPath})`);
  const children = [];
  if (!process.argv.includes('--db')) {
    const host = process.argv.includes('--host');
    children.push(startServer(), startClient(5173, host));
    console.log('[local] serwer: http://localhost:4001  klient: http://localhost:5173');
    if (host) console.log('[local] z sieci lokalnej: http://<IP tego komputera>:5173 (adres wypisze Vite jako Network)');
  }
  const stop = async () => {
    for (const child of children) child.kill();
    await mongo.stop({ doCleanup: false, force: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
