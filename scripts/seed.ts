import { resolve, relative } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { Store } from '../src/server/db.js';
import { seed } from '../src/server/seed.js';
import { PolicyRegistry } from '../src/server/policies.js';
import { timestamp } from '../src/domain/time.js';
const database = process.env.AIRLINE_DB ?? 'var/airline.sqlite',
  path = resolve(database),
  rel = relative(resolve('var'), path);
if (!rel || rel.startsWith('..') || rel.includes('/') || !rel.endsWith('.sqlite'))
  throw new Error('Seed/reset requires a dedicated var/*.sqlite database. Stop the service first.');
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm'])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}
const at = process.env.AIRLINE_FIXED_TIME
  ? timestamp(Date.parse(process.env.AIRLINE_FIXED_TIME))
  : Date.now();
const store = new Store(path);
try {
  seed(store, at);
  new PolicyRegistry(store, process.cwd());
  console.log(
    JSON.stringify({
      database: rel,
      tickets: store.get<any>('SELECT COUNT(*) n FROM tickets')!.n,
      seed_at_ms: store.get<any>("SELECT value FROM meta WHERE key='seed_at_ms'")!.value,
      reset: process.argv.includes('--reset'),
    }),
  );
} finally {
  store.close();
}
