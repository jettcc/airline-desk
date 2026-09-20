import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, BASE, cancelRequest, changeRequest, editTicket } from './helpers.js';
import { DAY, HOUR, FixedClock, creditUsable } from '../src/domain/time.js';
import { baggage, evaluateTicket, protection, policy } from '../src/domain/rules.js';
import { usd, moneyText, add, sub, fromNano, nano } from '../src/domain/money.js';
import { Store } from '../src/server/db.js';
import { PolicyRegistry } from '../src/server/policies.js';
import { createApp } from '../src/server/app.js';
import { sampleTicket } from '../src/server/seed.js';
import { ScriptedModel, RightCodesModel } from '../src/assistant/model.js';
import { KnowledgeAdapter } from '../src/assistant/knowledge.js';
import { exportConversation } from '../src/server/trace.js';
import type { Offer, Target } from '../src/domain/types.js';
const count = (h: any, table: string) => h.store.get(`SELECT COUNT(*) n FROM ${table}`).n;
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const confirm = (h: any, a: any, q: any, key = 'audit-confirm') =>
  h.booking.confirm(a.ctx, q.id, q.confirmation_token, key);
function offerFor(t: ReturnType<typeof sampleTicket>, at: number, fare = t.fare_type): Offer {
  const s = t.segments[0];
  return {
    id: 'O',
    airline: t.airline,
    flight_id: 'new-flight',
    origin: s.origin,
    destination: s.destination,
    domestic: s.domestic,
    departure_at_ms: at,
    arrival_at_ms: at + HOUR,
    fare_type: fare,
    fare: usd(150),
    tax: usd(25),
    version: 1,
    services_available: true,
  };
}
const replacement = (t: ReturnType<typeof sampleTicket>): Target => ({
  ticket_id: t.id,
  segment_ids: [],
  replacements: [{ segment_id: t.segments[0].id, offer_id: 'O' }],
});

test('R01: ±7 UTC calendar dates inclusive, both eighth dates rejected; successive notices use original issuance', () => {
  const t = sampleTicket('D', 'NSA', 'Basic', BASE);
  t.segments[0].original_departure_at_ms = BASE + 10 * DAY + 23 * HOUR;
  t.segments[0].departure_at_ms = BASE + 11 * DAY + HOUR;
  t.segments[0].arrival_at_ms = BASE + 11 * DAY + 3 * HOUR;
  t.disruption = {
    id: 'D1',
    segment_id: t.segments[0].id,
    kind: 'SCHEDULE_CHANGE',
    notified_at_ms: BASE,
    new_departure_at_ms: t.segments[0].original_departure_at_ms + 120 * 60000,
    consumed: false,
  };
  assert.equal(protection(t, BASE), 'ELIGIBLE');
  // Original-to-latest is 120 minutes despite a previous notice only 60 minutes away.
  t.segments[0].departure_at_ms = t.segments[0].original_departure_at_ms + 60 * 60000;
  for (const [offset, expected] of [
    [-8, 'DENIED'],
    [-7, 'ALLOWED'],
    [7, 'ALLOWED'],
    [8, 'DENIED'],
  ] as const) {
    const o = offerFor(t, BASE + (10 + offset) * DAY + (offset < 0 ? 0 : 23 * HOUR));
    assert.equal(
      evaluateTicket(t, 'DISRUPTION_CHANGE', replacement(t), [o], BASE).status,
      expected,
    );
  }
  t.disruption.notified_at_ms = BASE + 1;
  assert.equal(protection(t, BASE), 'INVALID');
});

test('R02: upgrade fees use old fare; downgrade/partial mixed fare/route/service/used segment are distinct', () => {
  const t = sampleTicket('T', 'NSA', 'Standard', BASE);
  let o = offerFor(t, BASE + 2 * DAY, 'Flex');
  let r = evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE);
  assert.equal(r.status, 'ALLOWED');
  assert.equal(moneyText(r.totals.collect), '80.00');
  o.fare_type = 'Basic';
  assert.equal(
    evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE).reasons[0],
    'DOWNGRADE_NOT_ALLOWED',
  );
  o.fare_type = 'Standard';
  o.destination = 'ELSE';
  assert.equal(evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE).status, 'MANUAL_REVIEW');
  o.destination = 'BAY';
  t.extras.push({
    id: 'E',
    segment_id: t.segments[0].id,
    type: 'SEAT',
    amount: usd(10),
    used: false,
    refunded: false,
  });
  o.services_available = false;
  assert.equal(
    evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE).reasons[0],
    'EXTRA_SERVICE_UNAVAILABLE',
  );
  o.services_available = true;
  o.fare_type = 'Flex';
  t.segments.push({
    ...t.segments[0],
    id: 'S2',
    departure_at_ms: BASE + 4 * DAY,
    arrival_at_ms: BASE + 4 * DAY + HOUR,
  });
  assert.equal(
    evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE).reasons[0],
    'MIXED_FARE_UPGRADE_REVIEW',
  );
  t.segments[0].state = 'USED';
  assert.equal(
    evaluateTicket(t, 'CHANGE', replacement(t), [o], BASE).reasons[0],
    'SEGMENT_ALREADY_USED',
  );
});

test('R03: invalid facts and contradictory selected segments fail closed', () => {
  const t = sampleTicket('T', 'NSA', 'Flex', BASE),
    o = offerFor(t, BASE + 2 * DAY);
  const selected = { ...replacement(t), segment_ids: ['not-selected'] };
  assert.equal(evaluateTicket(t, 'CHANGE', selected, [o], BASE).status, 'CONFLICT');
  assert.equal(evaluateTicket(t, 'CANCEL', replacement(t), [o], BASE).status, 'CONFLICT');
  t.segments[0].arrival_at_ms = t.segments[0].departure_at_ms;
  assert.equal(
    evaluateTicket(t, 'CANCEL', { ticket_id: 'T', segment_ids: [], replacements: [] }, [], BASE)
      .status,
    'CONFLICT',
  );
});

test('R04: bag allocation is independent of input order; exact dimensions, paid cabin and excess piece boundaries', () => {
  const bags = [20, 23].map((weight_kg) => ({
    type: 'CHECKED' as const,
    weight_kg,
    dimensions_cm: [50, 50, 58] as [number, number, number],
  }));
  for (const b of [bags, [...bags].reverse()]) {
    const result = baggage('STA', 'Standard', true, b);
    assert.equal(result.status, 'ALLOWED');
    assert.equal(moneyText(result.extra_fee_per_person_per_segment!), '50.00');
  }
  assert.equal(
    baggage('BHA', 'Basic', true, [{ type: 'CABIN', weight_kg: 7, dimensions_cm: [25, 55, 35] }])
      .extra_fee_per_person_per_segment?.units,
    '25',
  );
  assert.equal(baggage('STA', 'Standard', true, [...bags, bags[0]]).status, 'MANUAL_REVIEW');
  assert.equal(
    baggage('NSA', 'Basic', true, [{ ...bags[0], dimensions_cm: [50, 50, 58.01] }]).status,
    'MANUAL_REVIEW',
  );
});

test('R05: every baggage allowance matches independently transcribed PDF rows', () => {
  for (const [airline, domestic, rows] of [
    [
      'NSA',
      true,
      [
        [8, 1, 23],
        [8, 1, 23],
        [12, 2, 23],
      ],
    ],
    [
      'BHA',
      true,
      [
        [0, 0, 20],
        [7, 0, 20],
        [10, 1, 20],
      ],
    ],
    [
      'STA',
      true,
      [
        [7, 0, 20],
        [10, 1, 20],
        [12, 2, 20],
      ],
    ],
    [
      'STA',
      false,
      [
        [7, 1, 20],
        [10, 1, 23],
        [12, 2, 23],
      ],
    ],
  ] as const)
    for (const [i, fare] of (['Basic', 'Standard', 'Flex'] as const).entries()) {
      const b = baggage(airline, fare, domestic);
      assert.deepEqual([b.cabin.kg, b.checked.count, b.checked.kg_each], rows[i]);
    }
});

test('R06: signed lower int64, carry and JSON preserve nanos; credit redemption and departure checked independently', () => {
  const low = usd('-9223372036854775808.999999999');
  assert.deepEqual(fromNano(nano(low)), low);
  assert.throws(() => sub(low, usd('0.000000001')));
  assert.equal(moneyText(add(usd('0.99'), usd('0.01'))), '1.00');
  assert.deepEqual(JSON.parse(JSON.stringify(low)), low);
  assert.throws(() => nano({ currencyCode: 'USD', units: '0', nanos: 1000000000 }));
  assert.equal(creditUsable(BASE, BASE - 1, BASE + DAY), false);
  assert.equal(creditUsable(BASE, BASE + 365 * DAY - 1, BASE + 365 * DAY - 1), true);
  assert.equal(creditUsable(BASE, BASE + DAY, BASE + 365 * DAY), false);
  assert.equal(creditUsable(BASE, BASE + 365 * DAY, BASE + 365 * DAY + 1), false);
});

test('B01: standalone tax refund never cancels ticket or repeats; active travel requires review', async () => {
  const h = harness();
  try {
    const a = h.user();
    const request = { ...cancelRequest('STA-MISSED-A'), action: 'TAX_REFUND' as const };
    const q = h.booking.quote(a.ctx, a.conv, request).quote!;
    assert.equal(moneyText(q.decision.totals.refund), '20.00');
    assert.equal((await confirm(h, a, q)).state, 'SUCCEEDED');
    assert.equal(h.identity.ticket(a.ctx, 'STA-MISSED-A').state, 'SUSPENDED');
    assert.equal(h.booking.quote(a.ctx, a.conv, request).decision.status, 'DENIED');
    assert.equal(
      h.booking.quote(a.ctx, a.conv, { ...cancelRequest(), action: 'TAX_REFUND' }).decision.status,
      'MANUAL_REVIEW',
    );
    assert.equal(count(h, 'operations'), 1);
  } finally {
    h.close();
  }
});

test('B02: tax already refunded is not refunded again during cancellation; extras/fare stay separate', async () => {
  const h = harness();
  try {
    const a = h.user();
    editTicket(h, 'CANCEL-NSA-A', (t) => {
      t.segments[0].tax_refunded = true;
    });
    const q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    assert.equal(moneyText(q.decision.totals.refund), '0.00');
    assert.equal(moneyText(q.decision.totals.credit), '60.00');
    await confirm(h, a, q);
    assert.equal(h.store.get<any>("SELECT COUNT(*) n FROM ledger WHERE kind='TAX'")!.n, 0);
  } finally {
    h.close();
  }
});

test('B03: accepted disruption rebooking uses normal later rules and a distinct new event has one new right', async () => {
  const h = harness();
  try {
    const a = h.user();
    const request = changeRequest(h, a.ctx, ['BHA-DISRUPT-A']);
    request.action = 'DISRUPTION_CHANGE';
    const q = h.booking.quote(a.ctx, a.conv, request).quote!;
    assert.equal(moneyText(q.decision.totals.collect), '0.00');
    await confirm(h, a, q);
    const t = h.identity.ticket(a.ctx, 'BHA-DISRUPT-A');
    assert.equal(t.disruption!.consumed, true);
    assert.equal(moneyText(t.segments[0].fare!), '200.00');
    const voluntary = { ...request, action: 'CHANGE' as const };
    assert.equal(h.booking.quote(a.ctx, a.conv, voluntary).decision.status, 'DENIED');
    editTicket(h, t.id, (t) => {
      t.version++;
      t.disruption = {
        ...t.disruption!,
        id: 'NEW-EVENT',
        kind: 'CANCELLED',
        notified_at_ms: BASE,
        consumed: false,
      };
    });
    const rq = h.booking.quote(a.ctx, a.conv, {
      ...cancelRequest(t.id),
      action: 'DISRUPTION_REFUND',
    }).quote!;
    assert.equal(moneyText(rq.decision.totals.refund), '280.00');
    await confirm(h, a, rq, 'new-event-refund');
    assert.equal(
      h.store.get<any>("SELECT COUNT(*) n FROM consumptions WHERE kind='DISRUPTION_CHOICE'")!.n,
      2,
    );
  } finally {
    h.close();
  }
});

test('B04: completed upgrade changes later fee but preserves original issuance; lower price forces historical refund review', async () => {
  const h = harness();
  try {
    const a = h.user();
    const request = changeRequest(h, a.ctx, ['NSA-STANDARD-A']);
    request.targets[0].replacements[0].offer_id = 'NSA-STANDARD-A-S1-Flex-1';
    const before = h.identity.ticket(a.ctx, 'NSA-STANDARD-A');
    const q = h.booking.quote(a.ctx, a.conv, request).quote!;
    await confirm(h, a, q);
    const after = h.identity.ticket(a.ctx, 'NSA-STANDARD-A');
    assert.equal(after.fare_type, 'Flex');
    assert.equal(after.original_issued_at_ms, before.original_issued_at_ms);
    const next = h.booking.quote(
      a.ctx,
      a.conv,
      changeRequest(h, a.ctx, ['NSA-STANDARD-A'], 2),
    ).quote!;
    assert.equal(next.decision.lines.find((l) => l.kind === 'CHANGE_FEE')!.amount.units, '0');
    const low = changeRequest(h, a.ctx, ['NSA-BASIC-A']);
    const oid = low.targets[0].replacements[0].offer_id;
    const o = JSON.parse(h.store.get<any>('SELECT data FROM offers WHERE id=?', oid)!.data);
    o.fare = usd(50);
    h.store.run('UPDATE offers SET data=? WHERE id=?', JSON.stringify(o), oid);
    const lq = h.booking.quote(a.ctx, a.conv, low).quote!;
    await confirm(h, a, lq, 'lower-fare');
    assert.equal(
      h.booking.quote(a.ctx, a.conv, cancelRequest('NSA-BASIC-A')).decision.reasons[0],
      'HISTORICAL_VALUE_REVIEW',
    );
  } finally {
    h.close();
  }
});

test('B05: group candidates are all-or-nothing for scope, booking and duplicates', () => {
  const h = harness();
  try {
    const a = h.user('agent'),
      b = h.user();
    assert.equal(
      h.booking.groupOptions(a.ctx, ['NSA-A', 'NSA-B'], undefined, a.conv, 'CHANGE').tickets.length,
      2,
    );
    assert.throws(
      () => h.booking.groupOptions(b.ctx, ['NSA-A', 'NSA-B'], undefined, b.conv, 'CHANGE'),
      /TARGET_UNAVAILABLE/,
    );
    assert.throws(
      () => h.booking.groupOptions(a.ctx, ['NSA-A', 'CANCEL-NSA-A'], undefined, a.conv, 'CHANGE'),
      /ONE_BOOKING/,
    );
    assert.throws(
      () => h.booking.groupOptions(a.ctx, ['NSA-A', 'NSA-A'], undefined, a.conv, 'CHANGE'),
      /INVALID_TARGETS/,
    );
  } finally {
    h.close();
  }
});

for (const [name, actions, starts, expires, revoked, allowed] of [
  ['read-only', ['READ'], BASE - 1, BASE + 1, 0, false],
  ['change-only', ['CHANGE'], BASE, BASE + 1, 0, true],
  ['not-yet', ['CHANGE'], BASE + 1, BASE + DAY, 0, false],
  ['expired', ['CHANGE'], BASE - 1, BASE, 0, false],
  ['revoked', ['CHANGE'], BASE - 1, BASE + DAY, 1, false],
] as const)
  test(`I01 ${name}: action/time grant boundaries are server enforced`, () => {
    const h = harness();
    try {
      const a = h.user('agent');
      h.store.run(
        'UPDATE grants SET actions=?,starts_at_ms=?,expires_at_ms=?,revoked=? WHERE id=?',
        JSON.stringify(actions),
        starts,
        expires,
        revoked,
        'G-NSA-A',
      );
      const t = JSON.parse(h.store.get<any>("SELECT data FROM tickets WHERE id='NSA-A'")!.data);
      assert.equal(!!h.identity.authorized(a.ctx, t, 'CHANGE'), allowed);
      assert.equal(!!h.identity.authorized(a.ctx, t, 'CANCEL'), false);
    } finally {
      h.close();
    }
  });

test('I02: operation after mixed-target grant revocation shows only visible lines/subtotal; prior successful commit is retained', async () => {
  const h = harness();
  try {
    const a = h.user('agent'),
      q = h.booking.quote(a.ctx, a.conv, changeRequest(h, a.ctx, ['NSA-A', 'NSA-B'])).quote!;
    const result = await confirm(h, a, q);
    assert.equal(result.state, 'SUCCEEDED');
    h.store.run("UPDATE grants SET revoked=1 WHERE id='G-NSA-B'");
    const view = h.booking.operation(a.ctx, result.operation.id);
    assert.equal(view.tickets.length, 1);
    assert.equal(moneyText(view.totals.collect), '110.00');
    assert.ok(view.tickets.every((t: any) => t.id === 'NSA-A'));
    assert.ok(view.lines.every((l: any) => l.ticket_id === 'NSA-A'));
    assert.equal(count(h, 'operations'), 1);
  } finally {
    h.close();
  }
});

test('I03: logout before final transaction rejects; logout after commit and relogin recovers one operation', async () => {
  const wait = gate(),
    h = harness({ afterReceipt: () => wait.promise });
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const pending = confirm(h, a, q);
    h.identity.logout(a.ctx);
    wait.release();
    assert.equal((await pending).state, 'REJECTED');
    assert.equal(count(h, 'operations'), 0);
    const b = h.user(),
      q2 = h.booking.quote(b.ctx, b.conv, cancelRequest()).quote!;
    const result = await confirm(h, b, q2, 'logout-after');
    h.identity.logout(b.ctx);
    const c = h.user();
    assert.equal(h.booking.operation(c.ctx, result.operation.id).id, result.operation.id);
    assert.equal(count(h, 'operations'), 1);
  } finally {
    h.close();
  }
});

test('P01: all required policy tables validated; failed activation cannot publish an in-memory bundle', () => {
  const h = harness();
  try {
    for (const mutate of [
      (r: any) => delete r.change.BHA,
      (r: any) => (r.baggage.NSA.Basic = [8, -1, 23]),
      (r: any) => (r.cancel.NSA.Basic = [['REFUND', 0]]),
      (r: any) => (r.extra_bag.STA = [NaN, 23]),
    ]) {
      const r = structuredClone(policy);
      mutate(r);
      assert.throws(() => h.policies.activate(r), /INVALID_POLICY/);
    }
    const before = h.policies.bundles.size;
    h.store.db.exec(
      "CREATE TRIGGER reject_policy BEFORE INSERT ON policy_bundles BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(() =>
      h.policies.activate({ ...structuredClone(policy), version: 'not-published' }),
    );
    assert.equal(h.policies.bundles.size, before);
  } finally {
    h.close();
  }
});

test('P02: policy activation between receipt and commit rejects old quote; committed history keeps original source', async () => {
  const wait = gate(),
    h = harness({ afterReceipt: () => wait.promise });
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const pending = confirm(h, a, q);
    const r = structuredClone(policy);
    r.version = 'new';
    for (const a of ['NSA', 'BHA', 'STA'] as const)
      r.effective_from[a] = new Date(BASE).toISOString();
    h.policies.activate(r);
    wait.release();
    assert.equal((await pending).error, 'POLICY_CHANGED');
    const q2 = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const success = await confirm(h, a, q2, 'policy-after');
    h.policies.activate({ ...r, version: 'newer' });
    assert.equal(h.booking.operation(a.ctx, success.operation.id).bundle_id, q2.bundle_id);
    h.store.run(
      "UPDATE policy_assignments SET to_at_ms=? WHERE airline='NSA' AND from_at_ms=?",
      BASE + 1,
      BASE,
    );
    assert.throws(() => h.policies.select('NSA', BASE + 1), /POLICY_NOT_AVAILABLE/);
  } finally {
    h.close();
  }
});

test('P03: mixed evidence releases only emit each airline assigned to that exact release; child gets no credentials', async () => {
  const h = harness();
  try {
    const current = h.policies.select('NSA', BASE),
      other = {
        ...current,
        id: 'other',
        release_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        rules: { ...current.rules, knowledge_release: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      };
    const policies = { select: (a: string) => (a === 'BHA' ? other : current) };
    const exec: any = async (_: any, args: string[], options: any) => {
      assert.equal(options.shell, false);
      assert.equal('AIRLINE_MODEL_API_KEY' in options.env, false);
      const release = args[args.indexOf('--release') + 1];
      return {
        stdout: JSON.stringify({
          status: 'FOUND',
          release_id: release,
          topics: ['change'],
          evidence: ['NSA', 'BHA', 'STA'].map((airline) => ({
            airline,
            id: `${airline}:2`,
            pages: [2],
            text: 'reviewed fixture',
          })),
        }),
      };
    };
    const k = new KnowledgeAdapter(process.cwd(), policies as any, exec);
    const result = await k.search('compare changes', null, true, BASE);
    assert.deepEqual(
      result.parts[0].evidence.map((e: any) => e.airline),
      ['NSA', 'STA'],
    );
    assert.deepEqual(
      result.parts[1].evidence.map((e: any) => e.airline),
      ['BHA'],
    );
    assert.equal(result.parts[1].summaries[0].zh.length, 0);
  } finally {
    h.close();
  }
});

test('M01: actual policy retrieval has bilingual conditions and source-bound airline tables; unknown stays unknown', async () => {
  const h = harness();
  try {
    const k = new KnowledgeAdapter(process.cwd(), h.policies);
    const r = await k.search('Bluehaven change fee', 'BHA', false, BASE);
    const summary = r.parts[0].summaries[0];
    assert.ok(summary.zh.join(' ').includes('USD 85'));
    assert.ok(summary.en.join(' ').includes('original issuance'));
    assert.equal(
      r.parts[0].evidence.every((e: any) => e.airline === 'BHA'),
      true,
    );
    const unknown = await k.search('NSA 宠物', 'NSA', false, BASE);
    assert.notEqual(unknown.parts[0].status, 'FOUND');
    assert.equal(unknown.parts[0].summaries.length, 0);
  } finally {
    h.close();
  }
});

test('V01: review dedup, parameter mismatch, changed-fact linkage, insertion failure and restricted view', async () => {
  const h = harness();
  try {
    const a = h.user('agent'),
      request = { ...cancelRequest('NSA-PARTIAL-A'), action: 'DISRUPTION_REFUND' as const };
    const rows = await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => h.booking.createReview(a.ctx, a.conv, 'same-review', request)),
      ),
    );
    assert.equal(new Set(rows.map((r) => r.id)).size, 1);
    assert.equal(count(h, 'review_cases'), 1);
    assert.equal(rows[0].conversation_id, a.conv);
    assert.equal(rows[0].ticket_versions['NSA-PARTIAL-A'], 1);
    assert.throws(
      () => h.booking.createReview(a.ctx, a.conv, 'same-review', null, 'different'),
      /IDEMPOTENCY/,
    );
    editTicket(h, 'NSA-PARTIAL-A', (t) => {
      t.version++;
    });
    const next = h.booking.createReview(a.ctx, a.conv, 'new-fact-review', request);
    assert.equal(next.previous_case_id, rows[0].id);
    assert.equal(next.ticket_versions['NSA-PARTIAL-A'], 2);
    h.store.db.exec(
      "CREATE TRIGGER fail_review BEFORE INSERT ON review_cases BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(() => h.booking.createReview(a.ctx, a.conv, 'failed-review', null, 'authority'));
    assert.equal(count(h, 'review_cases'), 2);
    h.store.run("UPDATE grants SET revoked=1 WHERE id='G-NSA-PARTIAL-A'");
    const view = h.booking.review(a.ctx, next.id);
    assert.equal(view.restricted, true);
    assert.equal('decision' in view, false);
    assert.equal(count(h, 'operations'), 0);
    assert.equal(count(h, 'ledger'), 0);
  } finally {
    h.close();
  }
});

test('V02: medical review is unverified with unknown amount; guardianship never grants access or looks up targets', () => {
  const h = harness();
  try {
    const a = h.user();
    const r = h.booking.createExceptionReview(a.ctx, a.conv, 'medical-claim', 'MEDICAL', [
      'CANCEL-NSA-A',
    ]);
    assert.equal(r.amount.value, null);
    assert.equal(r.declaration_verified, false);
    assert.equal(r.decision.status, 'MANUAL_REVIEW');
    assert.equal(r.bundle_id, h.policies.select('NSA', BASE).id);
    assert.equal(
      h.booking.createExceptionReview(a.ctx, a.conv, 'medical-claim', 'MEDICAL', ['CANCEL-NSA-A'])
        .id,
      r.id,
    );
    assert.throws(
      () => h.booking.createExceptionReview(a.ctx, a.conv, 'medical-other', 'MEDICAL', ['NSA-B']),
      /TARGET_UNAVAILABLE/,
    );
    const g = h.booking.createExceptionReview(a.ctx, a.conv, 'guardian-claim', 'GUARDIANSHIP', []);
    assert.equal(g.protected_ticket_ids.length, 0);
    assert.throws(() => h.identity.ticket(a.ctx, 'NSA-B'));
    assert.equal(count(h, 'operations'), 0);
  } finally {
    h.close();
  }
});

test('V03: failed tool name recorded; missing interior diagnostics cannot claim COMPLETE or affect business result', async () => {
  const h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    model: new ScriptedModel(() => ({
      name: 'quote_operation',
      args: { request: cancelRequest(), record_review: false },
    })),
  });
  try {
    const ctx = h.identity.createSession('alice').context,
      c = h.identity.createConversation(ctx);
    const original = h.store.run.bind(h.store);
    h.store.run = ((sql: string, ...args: any[]) => {
      if (sql.startsWith('INSERT INTO traces') && String(args[4]).includes('tool_result'))
        throw Error('diagnostic loss');
      return original(sql, ...args);
    }) as any;
    const turn = h.conversations.start(ctx, c.id, 'trace-loss-key', 'cancel');
    await h.conversations.wait(turn.id);
    const completed = h.conversations.turn(ctx, turn.id);
    assert.equal(completed.state, 'COMPLETED');
    const q = completed.response.cards[0].data;
    await h.booking.confirm(ctx, q.id, q.confirmation_token, 'trace-loss-confirm');
    let exported = exportConversation(h.store.db, c.id);
    assert.equal(exported.status, 'INCOMPLETE');
    assert.equal(exported.operations.length, 1);
    assert.equal(exported.submissions[0] && count(h, 'credits'), 1);
    assert.equal(
      /confirmation_token|token_hash|encrypted_content|csrf/.test(JSON.stringify(exported)),
      false,
    );
    h.store.run = original;
    const bob = h.identity.createSession('bob').context,
      bc = h.identity.createConversation(bob);
    const fail = h.conversations.start(bob, bc.id, 'failed-tool-key', 'cancel another ticket');
    await h.conversations.wait(fail.id);
    exported = exportConversation(h.store.db, bc.id);
    assert.equal(exported.status, 'COMPLETE');
    assert.ok(
      exported.traces.some(
        (e) =>
          e.event === 'tool_error' &&
          e.tool === 'quote_operation' &&
          e.error === 'TARGET_UNAVAILABLE',
      ),
    );
  } finally {
    await h.app.close();
  }
});

test('F01: actual SQLite busy after receipt never duplicates; restart interrupts uncommitted receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-busy-'));
  const file = join(dir, 'test.sqlite');
  const wait = gate(),
    h = harness({ afterReceipt: () => wait.promise }, file);
  let lock: Store | undefined;
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const p = confirm(h, a, q, 'busy-receipt');
    lock = new Store(file, false);
    lock.db.exec('BEGIN IMMEDIATE');
    h.store.db.pragma('busy_timeout=10');
    wait.release();
    await assert.rejects(p, /locked/);
    lock.db.exec('ROLLBACK');
    assert.equal(count(h, 'operations'), 0);
    assert.equal(h.booking.submission(a.ctx, 'busy-receipt').state, 'RECEIVED');
    const next = new Store(file);
    assert.equal(next.get<any>('SELECT state FROM submissions')!.state, 'INTERRUPTED');
    next.close();
    assert.equal(count(h, 'credits'), 0);
  } finally {
    lock?.close();
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F02: actual SQLite page exhaustion rolls back ticket, ledger and credit', async () => {
  const h = harness({
    fault: (p) => {
      if (p === 'before_ledger')
        h.store.run('INSERT INTO meta VALUES (?,?)', 'fill-disk', 'x'.repeat(2000000));
    },
  });
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const pages = h.store.db.pragma('page_count', { simple: true });
    h.store.db.pragma(`max_page_count=${Number(pages) + 8}`);
    const result = await confirm(h, a, q, 'disk-full');
    assert.equal(result.state, 'REJECTED');
    assert.equal(h.identity.ticket(a.ctx, 'CANCEL-NSA-A').version, 1);
    assert.equal(count(h, 'operations'), 0);
    assert.equal(count(h, 'ledger'), 0);
    assert.equal(count(h, 'credits'), 0);
    assert.equal(h.store.get('SELECT value FROM meta WHERE key=?', 'fill-disk'), undefined);
  } finally {
    h.close();
  }
});

test('F03: old process generation cannot commit after restart; busy turn is released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-gen-')),
    file = join(dir, 'test.sqlite'),
    wait = gate(),
    h = harness({ afterReceipt: () => wait.promise }, file);
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const p = confirm(h, a, q, 'old-handler');
    const next = new Store(file);
    wait.release();
    assert.equal((await p).state, 'REJECTED');
    assert.equal(count(h, 'operations'), 0);
    assert.equal(next.get<any>('SELECT state FROM submissions')!.state, 'INTERRUPTED');
    next.close();
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M02: tool loop hits exact limit and unblocks conversation; forged quote arguments cannot execute', async () => {
  let n = 0;
  const h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    model: new ScriptedModel(() => {
      n++;
      return { name: 'get_booking', args: { ticket_ids: ['NSA-A'], present: false } };
    }),
  });
  try {
    const ctx = h.identity.createSession('alice').context,
      c = h.identity.createConversation(ctx),
      t = h.conversations.start(ctx, c.id, 'loop-bound', 'show');
    await h.conversations.wait(t.id);
    assert.equal(n, 8);
    assert.equal(h.conversations.turn(ctx, t.id).response.error, 'TOOL_ROUND_LIMIT');
    assert.equal(h.identity.conversation(ctx, c.id).busy_turn_id, null);
    await assert.rejects(
      h.gateway.execute(ctx, c.id, 'bad', 'quote_operation', {
        request: cancelRequest(),
        record_review: false,
        amount: 0,
        confirmed: true,
      }),
      /INVALID_TOOL_ARGUMENTS/,
    );
    assert.equal(count(h, 'operations'), 0);
  } finally {
    await h.app.close();
  }
});

test('M03: streamed quota failure and aborted request do not consume an automatic retry', async () => {
  let calls = 0;
  const m = new RightCodesModel('test-key', 'https://www.right.codes/codex/v1', (async () => {
    calls++;
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'response.failed',
          response: { error: { code: 'insufficient_quota' } },
        }) +
        '\n\n',
    );
  }) as any);
  await assert.rejects(m.respond([], '', []), /MODEL_QUOTA_OR_RATE_LIMIT/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(m.respond([], '', [], controller.signal), /MODEL_TIMEOUT/);
  assert.equal(calls, 1);
});

test('B06: credit usability requires current authorization, named credit airline and strict departure expiry', async () => {
  const h = harness();
  try {
    const a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    const result = await confirm(h, a, q);
    const cid = result.operation.credits[0].id;
    assert.equal(
      h.booking.checkCredit(a.ctx, cid, 'NSA', BASE + DAY).usable_for_named_traveler,
      true,
    );
    assert.equal(
      h.booking.checkCredit(a.ctx, cid, 'BHA', BASE + DAY).usable_for_named_traveler,
      false,
    );
    assert.equal(
      h.booking.checkCredit(a.ctx, cid, 'NSA', BASE + 365 * DAY).usable_for_named_traveler,
      false,
    );
    assert.throws(
      () => h.booking.checkCredit(h.user('bob').ctx, cid, 'NSA', BASE + DAY),
      /TARGET_UNAVAILABLE/,
    );
    assert.equal(count(h, 'credits'), 1);
    assert.equal(count(h, 'operations'), 1);
  } finally {
    h.close();
  }
});

test('P04: missing current policy pauses quotes but keeps bootstrap and completed records available', async () => {
  const h = await createApp({ filename: ':memory:', clock: new FixedClock(BASE) });
  try {
    const ctx = h.identity.createSession('alice').context,
      c = h.identity.createConversation(ctx),
      q = h.booking.quote(ctx, c.id, cancelRequest()).quote!;
    const success = await h.booking.confirm(ctx, q.id, q.confirmation_token, 'policy-recovery');
    h.store.run("DELETE FROM policy_assignments WHERE airline='NSA'");
    const boot = await h.app.inject('/api/bootstrap');
    assert.equal(boot.statusCode, 200);
    assert.equal(boot.json().release_id, null);
    assert.equal(h.booking.operation(ctx, success.operation.id).id, success.operation.id);
    assert.throws(() => h.booking.quote(ctx, c.id, cancelRequest('NSA-A')), /POLICY_NOT_AVAILABLE/);
  } finally {
    await h.app.close();
  }
});

test('B07: schema initialization is versioned and repeatable; a newer unsupported schema fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-schema-')),
    file = join(dir, 'db.sqlite');
  try {
    const h = harness({}, file);
    assert.equal(h.store.db.pragma('user_version', { simple: true }), 3);
    const tickets = count(h, 'tickets');
    h.close();
    const next = harness({}, file);
    assert.equal(count(next, 'tickets'), tickets);
    next.store.db.pragma('user_version=99');
    next.close();
    assert.throws(() => new Store(file), /UNSUPPORTED_DATABASE_SCHEMA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M04: large group candidate card is compacted before the selected-flight turn enters model context', async () => {
  let calls = 0;
  const h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    model: new ScriptedModel((input) => {
      calls++;
      if (calls === 1)
        return {
          name: 'search_group_change_options',
          args: { ticket_ids: ['NSA-A', 'NSA-B'], date: null, action: 'CHANGE' },
        };
      assert.ok(
        JSON.stringify(input).length < 80000,
        'large catalog must not exhaust model context',
      );
      const current = JSON.parse(
        input.filter((m: any) => m.role === 'user').at(-1).content,
      ).message;
      return {
        name: 'quote_operation',
        args: { request: JSON.parse(current), record_review: false },
      };
    }),
  });
  try {
    const ctx = h.identity.createSession('agent').context,
      c = h.identity.createConversation(ctx);
    const t = h.conversations.start(ctx, c.id, 'group-options-request', '两人选择航班');
    await h.conversations.wait(t.id);
    assert.ok(
      JSON.stringify(h.conversations.turn(ctx, t.id).response).length > 80000,
      'test must exercise a genuinely large displayed catalog',
    );
    const request = {
      action: 'CHANGE',
      targets: ['NSA-A', 'NSA-B'].map((ticket_id) => ({
        ticket_id,
        segment_ids: [],
        replacements: ['S1', 'S2'].map((s) => ({
          segment_id: `${ticket_id}-${s}`,
          offer_id: `${ticket_id}-${s}-Standard-1`,
        })),
      })),
    };
    const next = h.conversations.start(
      ctx,
      c.id,
      'group-selected-request',
      JSON.stringify(request),
    );
    await h.conversations.wait(next.id);
    const result = h.conversations.turn(ctx, next.id);
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.response.cards[0].data.decision.totals.collect.units, '220');
    assert.equal(count(h, 'operations'), 0);
  } finally {
    await h.app.close();
  }
});

test('P05: missing source declarations cannot form a joint bundle even with a valid release identifier', () => {
  const h = harness(),
    dir = mkdtempSync(join(tmpdir(), 'airline-manifest-'));
  try {
    const location = join(dir, 'data/knowledge/releases', policy.knowledge_release);
    mkdirSync(location, { recursive: true });
    const original = JSON.parse(
      readFileSync(
        join(process.cwd(), 'data/knowledge/releases', policy.knowledge_release, 'manifest.json'),
        'utf8',
      ),
    );
    for (const mutate of [
      (m: any) => (m.files = {}),
      (m: any) => (m.release_id = 'wrong'),
      (m: any) => delete m.reviewed_sources.BHA,
    ]) {
      const m = structuredClone(original);
      mutate(m);
      writeFileSync(join(location, 'manifest.json'), JSON.stringify(m));
      assert.throws(() => new PolicyRegistry(h.store, dir), /INVALID_POLICY_MANIFEST/);
    }
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('I04: revoke then restore a grant cannot revive its old quote even without an intervening read', async () => {
  const h = harness();
  try {
    const a = h.user('agent'),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    h.store.run("UPDATE grants SET revoked=1 WHERE id='G-CANCEL-NSA-A'");
    h.store.run("UPDATE grants SET revoked=0 WHERE id='G-CANCEL-NSA-A'");
    await assert.rejects(confirm(h, a, q, 'restored-old-quote'), /BUSINESS_HISTORY_RESTRICTED/);
    assert.equal(count(h, 'operations'), 0);
    const fresh = h.user('agent'),
      q2 = h.booking.quote(fresh.ctx, fresh.conv, cancelRequest()).quote!;
    assert.equal((await confirm(h, fresh, q2, 'restored-new-quote')).state, 'SUCCEEDED');
  } finally {
    h.close();
  }
});

test('I05: grant revision during model wait discards output before another tool or history replay', async () => {
  const wait = gate();
  let called!: () => void;
  const ready = new Promise<void>((r) => (called = r));
  const h = await createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    model: new ScriptedModel(async () => {
      called();
      await wait.promise;
      return { name: 'get_booking', args: { ticket_ids: ['NSA-A'], present: true } };
    }),
  });
  try {
    const ctx = h.identity.createSession('agent').context,
      c = h.identity.createConversation(ctx);
    h.identity.bindTicket(ctx, c.id, h.identity.ticket(ctx, 'NSA-A'), 'READ');
    const turn = h.conversations.start(ctx, c.id, 'revoke-during-model', '查询原客票');
    await ready;
    h.store.run("UPDATE grants SET revoked=1 WHERE id='G-NSA-A'");
    wait.release();
    await h.conversations.wait(turn.id);
    const row = h.store.get<any>('SELECT state,response FROM turns WHERE id=?', turn.id)!;
    assert.equal(row.state, 'RESTRICTED');
    assert.deepEqual(JSON.parse(row.response).cards, []);
    assert.throws(() => h.conversations.history(ctx, c.id), /BUSINESS_HISTORY_RESTRICTED/);
    assert.equal(
      h.store
        .all<any>('SELECT data FROM traces')
        .some((r) => JSON.parse(r.data).event === 'tool_started'),
      false,
    );
  } finally {
    wait.release();
    await h.app.close();
  }
});

test('M05: generic baggage retrieval also supplies complete translated allowances without re-asking known fare', async () => {
  const h = harness();
  try {
    const k = new KnowledgeAdapter(process.cwd(), h.policies),
      r = await k.search('Bluehaven Basic 行李', 'BHA', false, BASE);
    const s = r.parts[0].summaries[0],
      b = s.baggage_allowances.find((b: any) => b.fare_type === 'Basic')!;
    assert.equal(b.personal.kg, 3);
    assert.equal(b.cabin.count, 0);
    assert.equal(b.checked.count, 0);
    assert.equal(moneyText(b.paid_cabin!.fee), '25.00');
    assert.equal(moneyText(b.extra_checked.fee), '40.00');
    const zh = s.zh.join(' ');
    assert.ok(zh.includes('Basic：无免费登机行李；无免费托运行李'));
    assert.ok(zh.includes('40 × 30 × 15'));
    assert.ok(zh.includes('USD 25.00'));
    assert.equal(zh.includes('请补充'), false);
  } finally {
    h.close();
  }
});
