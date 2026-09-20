import test from 'node:test';
import assert from 'node:assert/strict';
import { baggage, policy } from '../src/domain/rules.js';
import { baggage as baggageV1 } from '../src/domain/rules-v1.js';
import { moneyText } from '../src/domain/money.js';
import { PolicyRegistry } from '../src/server/policies.js';
import { BookingService } from '../src/server/booking.js';
import { harness, cancelRequest, changeRequest, BASE } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { ScriptedModel } from '../src/assistant/model.js';
import { FixedClock } from '../src/domain/time.js';

test('Checked bags accept the supplied sum at 158cm; missing sides never become invented measurements', () => {
  const bag = { type: 'CHECKED' as const, weight_kg: 15, linear_cm: 140 };
  const r = baggage('BHA', 'Basic', true, [bag]);
  assert.equal(moneyText(r.extra_fee_per_person_per_segment!), '40.00');
  assert.deepEqual(r.evaluated_bags, [bag]);
  assert.equal(baggage('BHA', 'Basic', true, [{ ...bag, linear_cm: 158 }]).status, 'ALLOWED');
  const over = baggage('BHA', 'Basic', true, [{ ...bag, linear_cm: 158.01 }]);
  assert.equal(over.status, 'MANUAL_REVIEW');
  assert.equal(over.extra_fee_per_person_per_segment, null);
  assert.throws(
    () => baggage('BHA', 'Basic', true, [{ ...bag, type: 'CABIN' } as any]),
    /INVALID_BAG/,
  );
});

test('New baggage representation preserves existing fee and allowance decisions across every fare/route', () => {
  for (const airline of ['NSA', 'BHA', 'STA'] as const)
    for (const fare of ['Basic', 'Standard', 'Flex'] as const)
      for (const domestic of [true, false])
        for (const weight of [3, 7, 15, 20, 23, 32])
          for (const side of [30, 70]) {
            const bag = {
              type: 'CHECKED' as const,
              weight_kg: weight,
              dimensions_cm: [side, 40, 50] as [number, number, number],
            };
            const { evaluated_bags, ...newResult } = baggage(airline, fare, domestic, [bag, bag]);
            assert.deepEqual(newResult, baggageV1(airline, fare, domestic, [bag, bag]));
            const { evaluated_bags: sums, ...sumResult } = baggage(airline, fare, domestic, [
              { type: 'CHECKED', weight_kg: weight, linear_cm: side + 90 },
              { type: 'CHECKED', weight_kg: weight, linear_cm: side + 90 },
            ]);
            assert.deepEqual(sumResult, newResult);
          }
});

test('Pinned v1 upgrade preserves historical operations and identities, changes only active bundle pointers, and rejects an old quote', async () => {
  const h = harness();
  try {
    const legacy = h.policies.verify(
      policy,
      'ce3f918532602d278b740e63b1918a96eb322da9955e408965adf4bcb6db6250',
    );
    h.store.run(
      'INSERT INTO policy_bundles VALUES (?,?,?,?,?,?)',
      legacy.id,
      legacy.release_id,
      legacy.rules_hash,
      legacy.code_hash,
      JSON.stringify(legacy.rules),
      JSON.stringify(legacy.sources),
    );
    h.policies.bundles.set(legacy.id, legacy);
    h.store.run('UPDATE policy_assignments SET bundle_id=?', legacy.id);
    const a = h.user();
    const q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const receipt = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'legacy-cancel-key');
    assert.equal(receipt.state, 'SUCCEEDED');
    const b = h.user();
    const oldQuote = h.booking.quote(b.ctx, b.conv, changeRequest(h, b.ctx)).quote!;
    const before = [
      'actors',
      'accounts',
      'tickets',
      'operations',
      'ledger',
      'credits',
      'sessions',
    ].map((table) => h.store.all(`SELECT * FROM ${table}`));
    const beforeWindows = h.store.all<any>(
      'SELECT airline,from_at_ms,to_at_ms FROM policy_assignments',
    );
    const upgraded = new PolicyRegistry(h.store, process.cwd());
    const booking = new BookingService(h.store, h.identity, upgraded, h.clock);
    assert.notEqual(upgraded.select('NSA', BASE).id, legacy.id);
    assert.ok(upgraded.get(legacy.id));
    assert.deepEqual(
      beforeWindows,
      h.store.all('SELECT airline,from_at_ms,to_at_ms FROM policy_assignments'),
    );
    assert.deepEqual(
      before,
      ['actors', 'accounts', 'tickets', 'operations', 'ledger', 'credits', 'sessions'].map(
        (table) => h.store.all(`SELECT * FROM ${table}`),
      ),
    );
    assert.equal(booking.operation(a.ctx, receipt.operation!.id).bundle_id, legacy.id);
    assert.equal(
      (await booking.confirm(b.ctx, oldQuote.id, oldQuote.confirmation_token, 'legacy-stale-key'))
        .state,
      'REJECTED',
    );
    assert.equal(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n, 1);
    assert.equal(
      new PolicyRegistry(h.store, process.cwd()).select('NSA', BASE).id,
      upgraded.select('NSA', BASE).id,
    );
    assert.throws(() => upgraded.verify(policy, 'a'.repeat(64)), /POLICY_BUNDLE_CHANGED/);
  } finally {
    h.close();
  }
});

test('Follow-up context contains verified baggage measurements and rejects cabin sums at the gateway', async () => {
  let n = 0;
  const h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    static: false,
    model: new ScriptedModel((input) => {
      if (n++ === 0)
        return {
          name: 'check_baggage',
          args: {
            airline: 'BHA',
            fare: 'Basic',
            domestic: true,
            bags: [{ type: 'CHECKED', weight_kg: 15, linear_cm: 140 }],
          },
        };
      if (n === 2) return { name: 'clarify', args: { reason: 'DETAILS' } };
      const current = JSON.parse(input.filter((x) => x.role === 'user').at(-1).content);
      assert.equal(current.recent_baggage_context.airline, 'BHA');
      assert.equal(current.recent_baggage_context.evaluated_bags[0].linear_cm, 140);
      assert.equal(input.at(-1).type, 'function_call_output');
      return {
        name: 'check_baggage',
        args: {
          airline: 'BHA',
          fare: 'Basic',
          domestic: true,
          bags: [{ type: 'CHECKED', weight_kg: 16, linear_cm: 140 }],
        },
      };
    }),
  });
  try {
    const ctx = h.identity.createSession().context,
      c = h.identity.createConversation(ctx);
    for (const message of [
      'Bluehaven Basic，一件15kg三边合计140cm的托运行李多少钱',
      '改成16kg，其他不变',
    ]) {
      const t = h.conversations.start(ctx, c.id, crypto.randomUUID(), message);
      await h.conversations.wait(t.id);
      assert.equal(h.conversations.turn(ctx, t.id).state, 'COMPLETED');
    }
    assert.equal(n, 3);
    await assert.rejects(
      h.conversations.gateway.execute(ctx, c.id, 'bad-measurement', 'check_baggage', {
        airline: 'BHA',
        fare: 'Basic',
        domestic: true,
        bags: [{ type: 'CABIN', weight_kg: 7, linear_cm: 110 }],
      }),
      /INVALID_TOOL_ARGUMENTS/,
    );
  } finally {
    await h.app.close();
  }
});
