import { Store } from '../src/server/db.js';
import { Identity } from '../src/server/identity.js';
import { PolicyRegistry } from '../src/server/policies.js';
import { BookingService, type Hooks } from '../src/server/booking.js';
import { seed } from '../src/server/seed.js';
import { FixedClock } from '../src/domain/time.js';
import type { Context, OperationRequest, Ticket } from '../src/domain/types.js';
export const BASE = Date.parse('2026-09-18T00:00:00Z');
export function harness(hooks: Hooks = {}, filename = ':memory:') {
  const clock = new FixedClock(BASE),
    store = new Store(filename);
  seed(store, clock.now());
  const policies = new PolicyRegistry(store, process.cwd()),
    identity = new Identity(store, clock),
    booking = new BookingService(store, identity, policies, clock, hooks);
  const user = (actor = 'alice') => {
    const { context } = identity.createSession(actor);
    return { ctx: context, conv: identity.createConversation(context).id as string };
  };
  return { clock, store, policies, identity, booking, user, close: () => store.close() };
}
export const cancelRequest = (ticket = 'CANCEL-NSA-A'): OperationRequest => ({
  action: 'CANCEL',
  targets: [{ ticket_id: ticket, replacements: [], segment_ids: [] }],
});
export function changeRequest(
  h: ReturnType<typeof harness>,
  ctx: Context,
  ids = ['NSA-A'],
  offset = 1,
): OperationRequest {
  return {
    action: 'CHANGE',
    targets: ids.map((ticketId) => {
      const t = h.identity.ticket(ctx, ticketId);
      return {
        ticket_id: ticketId,
        segment_ids: [],
        replacements: t.segments
          .filter((s) => s.state !== 'USED')
          .map((s) => ({ segment_id: s.id, offer_id: `${s.id}-${t.fare_type}-${offset}` })),
      };
    }),
  };
}
export function editTicket(h: ReturnType<typeof harness>, id: string, fn: (t: Ticket) => void) {
  const t: Ticket = JSON.parse(h.store.get<any>('SELECT data FROM tickets WHERE id=?', id)!.data);
  fn(t);
  h.store.run('UPDATE tickets SET version=?,data=? WHERE id=?', t.version, JSON.stringify(t), id);
  return t;
}
