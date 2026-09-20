import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, cancelRequest, changeRequest, editTicket, BASE } from './helpers.js';
import { moneyText, usd } from '../src/domain/money.js';
import { DAY, IDLE_TTL, SESSION_TTL } from '../src/domain/time.js';
import type { Context, OperationRequest } from '../src/domain/types.js';
const count = (h: ReturnType<typeof harness>, table: string) =>
  h.store.get<any>(`SELECT count(*) n FROM ${table}`)!.n;
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
test('A02: actor object permissions, agent scope and no access through payer/name', () => {
  const h = harness(),
    a = h.user(),
    agent = h.user('agent');
  assert.throws(() => h.identity.ticket(a.ctx, 'NSA-B'), /TARGET_UNAVAILABLE/);
  assert.ok(h.booking.list(a.ctx).every((t) => t.traveler_id === 'traveler-alice'));
  assert.ok(h.identity.ticket(agent.ctx, 'NSA-B'));
  h.store.run(
    'UPDATE grants SET actions=? WHERE actor_id=? AND ticket_id=?',
    JSON.stringify(['CHANGE']),
    'agent',
    'NSA-B',
  );
  assert.throws(
    () => h.booking.quote(agent.ctx, agent.conv, cancelRequest('NSA-B')),
    /TARGET_UNAVAILABLE/,
  );
  h.close();
});
test('A03: two people/two segments collect 220; mutation only after confirmation', async () => {
  const h = harness(),
    a = h.user('agent'),
    req = changeRequest(h, a.ctx, ['NSA-A', 'NSA-B']);
  const q = h.booking.quote(a.ctx, a.conv, req).quote!;
  assert.equal(moneyText(q.decision.totals.collect), '220.00');
  assert.equal(h.identity.ticket(a.ctx, 'NSA-A').version, 1);
  const result = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'request-a03');
  assert.equal(result.state, 'SUCCEEDED');
  assert.equal(h.identity.ticket(a.ctx, 'NSA-A').version, 2);
  assert.equal(h.identity.ticket(a.ctx, 'NSA-B').version, 2);
  assert.equal(count(h, 'operations'), 1);
  assert.equal(
    h.identity.ticket(a.ctx, 'NSA-A').original_issued_at_ms,
    Date.parse('2026-07-01T00:00:00Z'),
  );
  h.close();
});
test('A04: original issuance 85/55 and crossing 24h does not reserve early eligibility', async () => {
  const h = harness();
  for (const [ticket, expected] of [
    ['BHA-OLD-A', '85.00'],
    ['BHA-NEW-A', '55.00'],
  ]) {
    const a = h.user();
    editTicket(h, ticket, (t) => {
      t.segments[0].departure_at_ms = BASE + DAY + 1;
    });
    const q = h.booking.quote(a.ctx, a.conv, changeRequest(h, a.ctx, [ticket])).quote!;
    assert.equal(
      moneyText(q.decision.lines.find((l) => l.kind === 'CHANGE_FEE')!.amount),
      expected,
    );
    h.clock.advance(2);
    const r = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, `request-${ticket}`);
    assert.equal(r.state, 'REJECTED');
    h.clock.value = BASE;
  }
  assert.equal(count(h, 'operations'), 0);
  h.close();
});
test('A05: Suntrail mixed route fee 85, not full-itinerary fee', async () => {
  const h = harness(),
    a = h.user(),
    q = h.booking.quote(a.ctx, a.conv, changeRequest(h, a.ctx, ['STA-MIX-A'])).quote!;
  assert.equal(moneyText(q.decision.totals.collect), '85.00');
  assert.equal(
    (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'request-a05')).state,
    'SUCCEEDED',
  );
  h.close();
});
test('A06/A10: credit 60 + tax 20; retries, expiry, new key and login do not duplicate', async () => {
  const h = harness(),
    a = h.user(),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  assert.equal(moneyText(q.decision.totals.credit), '60.00');
  assert.equal(moneyText(q.decision.totals.refund), '20.00');
  const first = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'request-a06');
  assert.equal(first.state, 'SUCCEEDED');
  h.clock.advance(300001);
  const again = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'request-a06');
  assert.equal(again.operation.id, first.operation.id);
  const newkey = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'another-key');
  assert.equal(newkey.operation.id, first.operation.id);
  const c = h.store.get<any>('SELECT * FROM credits')!;
  assert.equal(c.expires_at_ms - c.issued_at_ms, 365 * DAY);
  assert.equal(c.traveler_id, 'traveler-alice');
  h.identity.logout(a.ctx);
  const fresh = h.user();
  assert.equal(h.booking.submission(fresh.ctx, 'request-a06').operation.id, first.operation.id);
  assert.equal(count(h, 'operations'), 1);
  assert.equal(count(h, 'credits'), 1);
  assert.equal(
    h.booking.quote(fresh.ctx, fresh.conv, {
      action: 'TAX_REFUND',
      targets: cancelRequest().targets,
    }).decision.status,
    'DENIED',
  );
  h.close();
});
test('A07: Basic disruption pays 280; consumed protection cannot be spent twice', async () => {
  const h = harness(),
    a = h.user(),
    req: OperationRequest = { ...cancelRequest('BHA-DISRUPT-A'), action: 'DISRUPTION_REFUND' };
  const q = h.booking.quote(a.ctx, a.conv, req).quote!;
  assert.equal(moneyText(q.decision.totals.refund), '280.00');
  assert.equal(
    (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'request-a07')).state,
    'SUCCEEDED',
  );
  assert.equal(h.booking.quote(a.ctx, a.conv, req).decision.status, 'DENIED');
  assert.equal(count(h, 'operations'), 1);
  h.close();
});
test('A08 and authorization review: local case preserves rights, does not grant access or mutate tickets', () => {
  const h = harness(),
    a = h.user(),
    req: OperationRequest = { ...cancelRequest('NSA-PARTIAL-A'), action: 'DISRUPTION_REFUND' };
  const d = h.booking.quote(a.ctx, a.conv, req).decision;
  assert.equal(d.status, 'MANUAL_REVIEW');
  assert.ok(d.known_rights.length);
  const c = h.booking.createReview(a.ctx, a.conv, 'review-a08', req);
  assert.equal(c.status, 'RECORDED_AWAITING_REVIEW');
  assert.equal(h.booking.createReview(a.ctx, a.conv, 'review-a08', req).id, c.id);
  const other = h.booking.createReview(
    a.ctx,
    a.conv,
    'review-auth',
    null,
    '请求核验对同行客票的改签授权',
  );
  assert.equal(other.type, 'AUTHORIZATION');
  assert.throws(() => h.identity.ticket(a.ctx, 'NSA-B'));
  assert.equal(count(h, 'operations'), 0);
  assert.equal(h.identity.ticket(a.ctx, 'NSA-PARTIAL-A').version, 1);
  h.close();
});
test('A09: same-ticket race conflicts, unrelated tickets can both succeed', async () => {
  const gate = barrier(),
    h = harness({ afterReceipt: () => gate.promise }),
    a = h.user(),
    b = h.user();
  const qa = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!,
    qb = h.booking.quote(b.ctx, b.conv, cancelRequest()).quote!;
  const pa = h.booking.confirm(a.ctx, qa.id, qa.confirmation_token, 'race-key-a'),
    pb = h.booking.confirm(b.ctx, qb.id, qb.confirmation_token, 'race-key-b');
  gate.release();
  const results = await Promise.all([pa, pb]);
  assert.deepEqual(results.map((x) => x.state).sort(), ['REJECTED', 'SUCCEEDED']);
  assert.equal(count(h, 'operations'), 1);
  h.close();
  const g = harness(),
    x = g.user(),
    y = g.user(),
    q1 = g.booking.quote(x.ctx, x.conv, cancelRequest('NSA-A')).quote!,
    q2 = g.booking.quote(y.ctx, y.conv, cancelRequest('CANCEL-NSA-A')).quote!;
  assert.ok(
    (
      await Promise.all([
        g.booking.confirm(x.ctx, q1.id, q1.confirmation_token, 'other-a1'),
        g.booking.confirm(y.ctx, q2.id, q2.confirmation_token, 'other-a2'),
      ])
    ).every((r) => r.state === 'SUCCEEDED'),
  );
  g.close();
});
test('All-or-nothing after second-ticket fault; necessary financial record failure rolls back', async () => {
  for (const point of ['after_ticket', 'before_ledger', 'necessary_record', 'before_commit']) {
    let seen = 0;
    const h = harness({
        fault: (p) => {
          if (p === point && (point !== 'after_ticket' || ++seen === 2)) throw Error('injected');
        },
      }),
      a = h.user('agent');
    const q = h.booking.quote(a.ctx, a.conv, changeRequest(h, a.ctx, ['NSA-A', 'NSA-B'])).quote!;
    const before = JSON.stringify(h.store.all('SELECT * FROM inventory ORDER BY flight_id'));
    const result = await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'atomic-' + point);
    assert.equal(result.state, 'REJECTED');
    assert.equal(count(h, 'operations'), 0);
    assert.equal(count(h, 'ledger'), 0);
    assert.equal(h.identity.ticket(a.ctx, 'NSA-A').version, 1);
    assert.equal(h.identity.ticket(a.ctx, 'NSA-B').version, 1);
    assert.equal(JSON.stringify(h.store.all('SELECT * FROM inventory ORDER BY flight_id')), before);
    h.close();
  }
});
test('Lost response after COMMIT is recoverable and repeat is safe', async () => {
  const h = harness({
      fault: (p) => {
        if (p === 'after_commit') throw Error('lost response');
      },
    }),
    a = h.user(),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  await assert.rejects(h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'lost-response'));
  assert.equal(h.booking.submission(a.ctx, 'lost-response').state, 'SUCCEEDED');
  assert.equal(
    (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'lost-response')).state,
    'SUCCEEDED',
  );
  assert.equal(count(h, 'operations'), 1);
  h.close();
});
test('Quote TTL before/equal/after; valid receive time preserved through queue', async () => {
  for (const [advance, allowed] of [
    [299999, true],
    [300000, false],
    [300001, false],
  ] as const) {
    const h = harness(),
      a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    h.clock.advance(advance);
    if (allowed)
      assert.equal(
        (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'ttl-check')).state,
        'SUCCEEDED',
      );
    else
      await assert.rejects(
        h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'ttl-check'),
        /QUOTE_EXPIRED/,
      );
    h.close();
  }
  const gate = barrier(),
    h = harness({ afterReceipt: () => gate.promise }),
    a = h.user(),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  h.clock.advance(299999);
  const pending = h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'queue-check');
  h.clock.advance(10000);
  gate.release();
  assert.equal((await pending).state, 'SUCCEEDED');
  h.close();
});
test('Revocation before commit blocks all targets, revocation after commit does not undo it', async () => {
  const gate = barrier(),
    h = harness({ afterReceipt: () => gate.promise }),
    a = h.user('agent'),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  const pending = h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'revoke-key');
  h.store.tx(() => h.store.run("UPDATE grants SET revoked=1 WHERE id='G-CANCEL-NSA-A'"));
  gate.release();
  assert.equal((await pending).state, 'REJECTED');
  assert.equal(count(h, 'operations'), 0);
  assert.throws(() => h.identity.conversation(a.ctx, a.conv), /BUSINESS_HISTORY_RESTRICTED/);
  h.close();
});
test('New quote supersedes old server-side; wrong session, wrong token and different key payload reject', async () => {
  const h = harness(),
    a = h.user(),
    b = h.user(),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  await assert.rejects(
    h.booking.confirm(b.ctx, q.id, q.confirmation_token, 'wrong-session'),
    /QUOTE_SESSION_CHANGED/,
  );
  await assert.rejects(
    h.booking.confirm(a.ctx, q.id, 'fake', 'wrong-token'),
    /CONFIRMATION_REQUIRED/,
  );
  const q2 = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  await assert.rejects(
    h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'superseded-key'),
    /QUOTE_SUPERSEDED/,
  );
  assert.equal(
    (await h.booking.confirm(a.ctx, q2.id, q2.confirmation_token, 'good-key')).state,
    'SUCCEEDED',
  );
  await assert.rejects(
    h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'good-key'),
    /IDEMPOTENCY_KEY_REUSED/,
  );
  h.close();
});
test('Sessions expire exactly at idle/absolute boundaries and polling does not renew', () => {
  const h = harness(),
    a = h.identity.createSession('alice');
  h.clock.advance(IDLE_TTL - 1);
  assert.ok(h.identity.fromToken(a.token));
  h.clock.advance(1);
  assert.equal(h.identity.fromToken(a.token), null);
  const b = h.identity.createSession('alice'),
    start = h.clock.now();
  for (let i = 1; i < 16; i++) {
    h.clock.value = start + i * (IDLE_TTL - 1);
    assert.ok(h.identity.fromToken(b.token, true));
  }
  h.clock.value = start + SESSION_TTL;
  assert.equal(h.identity.fromToken(b.token, true), null);
  h.close();
});
test('Future policy activation does not invalidate a still-applicable quote; effective change does', async () => {
  const h = harness(),
    a = h.user(),
    q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!,
    rules = structuredClone(h.policies.get(q.bundle_id).rules);
  rules.version = 'rules-future';
  for (const airline of ['NSA', 'BHA', 'STA'] as const)
    rules.effective_from[airline] = new Date(BASE + DAY).toISOString();
  h.policies.activate(rules);
  assert.equal(
    (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'before-policy')).state,
    'SUCCEEDED',
  );
  h.close();
  const g = harness(),
    b = g.user(),
    q2 = g.booking.quote(b.ctx, b.conv, cancelRequest()).quote!,
    r = structuredClone(g.policies.get(q2.bundle_id).rules);
  r.version = 'rules-now';
  for (const airline of ['NSA', 'BHA', 'STA'] as const)
    r.effective_from[airline] = new Date(BASE).toISOString();
  g.policies.activate(r);
  assert.equal(
    (await g.booking.confirm(b.ctx, q2.id, q2.confirmation_token, 'changed-policy')).state,
    'REJECTED',
  );
  assert.equal(count(g, 'operations'), 0);
  g.close();
});
test('Restart recovers a committed result and interrupts an uncommitted receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-restart-')),
    path = join(dir, 'demo.sqlite');
  try {
    const h = harness(
        {
          fault: (p) => {
            if (p === 'after_receipt') throw Error('crash');
          },
        },
        path,
      ),
      a = h.user(),
      q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    await assert.rejects(h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'restart-key'));
    assert.equal(count(h, 'operations'), 0);
    h.close();
    const restored = harness({}, path);
    assert.equal(restored.booking.submission(a.ctx, 'restart-key').state, 'INTERRUPTED');
    assert.equal(
      (await restored.booking.confirm(a.ctx, q.id, q.confirmation_token, 'restart-key')).state,
      'INTERRUPTED',
    );
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Partial disruption refund selected by unused segment retains established rights and unknown amount', () => {
  const h = harness();
  try {
    const a = h.user(),
      request = {
        action: 'DISRUPTION_REFUND' as const,
        targets: [
          { ticket_id: 'NSA-PARTIAL-A', segment_ids: ['NSA-PARTIAL-A-S2'], replacements: [] },
        ],
      };
    const q = h.booking.quote(a.ctx, a.conv, request);
    assert.equal(q.decision.status, 'MANUAL_REVIEW');
    assert.deepEqual(q.decision.known_rights, ['UNUSED_AFFECTED_PORTION_REFUND_RIGHT']);
    const r = h.booking.createReview(a.ctx, a.conv, 'explicit-unused-part', request);
    assert.deepEqual(r.amount, { status: 'UNKNOWN', value: null });
    assert.equal(count(h, 'operations'), 0);
    request.targets[0].segment_ids = ['NSA-PARTIAL-A-S1'];
    assert.equal(h.booking.quote(a.ctx, a.conv, request).decision.status, 'DENIED');
  } finally {
    h.close();
  }
});
