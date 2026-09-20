import { Store } from '../../src/server/db.js';
import { Identity } from '../../src/server/identity.js';
import { PolicyRegistry } from '../../src/server/policies.js';
import { BookingService } from '../../src/server/booking.js';
import { FixedClock } from '../../src/domain/time.js';
const [filename, point] = process.argv.slice(2);
const store = new Store(filename, false),
  clock = new FixedClock(Date.parse('2026-09-18T00:00:00Z')),
  identity = new Identity(store, clock),
  policies = new PolicyRegistry(store, process.cwd());
const booking = new BookingService(store, identity, policies, clock, {
  fault: (p) => {
    if (p === point) process.kill(process.pid, 'SIGKILL');
  },
});
const s = store.get<any>('SELECT * FROM sessions LIMIT 1')!,
  q = JSON.parse(store.get<any>('SELECT data FROM quotes LIMIT 1')!.data);
await booking.confirm(
  { session_id: s.id, actor_id: s.actor_id, csrf: s.csrf },
  q.id,
  q.confirmation_token,
  'killed-process',
);
throw new Error('Crash hook did not fire');
