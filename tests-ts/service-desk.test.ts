import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, cancelRequest, changeRequest, editTicket, BASE } from './helpers.js';
import {
  ServiceDesk,
  SERVICE_ACTIONS,
  type CaseAction,
  type TaskAction,
} from '../src/server/service-desk.js';
import { Accounts } from '../src/server/accounts.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/db.js';
import { FixedClock, HOUR, SESSION_TTL } from '../src/domain/time.js';
import { moneyText } from '../src/domain/money.js';
import { ToolGateway } from '../src/assistant/tools.js';
import { KnowledgeAdapter } from '../src/assistant/knowledge.js';

function pilot(filename = ':memory:') {
  const h = harness({}, filename);
  const desk = new ServiceDesk(h.store, h.identity, h.booking, h.clock);
  h.booking.lifecycle = desk;
  for (const name of ['demo-desk-1', 'demo-desk-2'])
    h.store.run('INSERT OR IGNORE INTO actors VALUES (?,?,?)', name, name, name);
  return { ...h, desk, operator: h.user('demo-desk-1'), other: h.user('demo-desk-2') };
}
type H = ReturnType<typeof pilot>;
const count = (h: H, table: string) => h.store.get<any>(`SELECT count(*) n FROM ${table}`)!.n;
async function registered(h: H, name = 'service_user') {
  const accounts = new Accounts(h.store, h.clock);
  const draft = await accounts.prepare(name, 'Service-test-pass-42');
  h.store.tx(() => accounts.insert(draft));
  return h.user(draft.actorId);
}
function caseAct(h: H, c: any, action: CaseAction, ctx = h.operator.ctx, note = '非敏感测试说明') {
  return h.desk.actCase(ctx, `case-${c.id}-${c.version}-${action}`, c.id, c.version, action, note);
}
function taskAct(h: H, t: any, action: TaskAction) {
  return h.desk.actTask(
    h.operator.ctx,
    `task-${t.id}-${t.version}-${action}`,
    t.id,
    t.version,
    action,
  );
}
async function cancel(h: H, a = h.user()) {
  const q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
  return {
    a,
    q,
    result: await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'pilot-cancel-key'),
  };
}

test('S01: guest/customer cannot operate desk; demo entry is absent in default mode; CSRF and strict payload remain enforced', async () => {
  for (const serviceTrial of [false, true]) {
    const h = await createApp({
      filename: ':memory:',
      clock: new FixedClock(BASE),
      static: false,
      serviceTrial,
    });
    try {
      const boot = await h.app.inject('/api/bootstrap');
      const headers = {
        cookie: `${boot.cookies[0].name}=${boot.cookies[0].value}`,
        'x-csrf-token': boot.json().csrf,
      };
      const desk = await h.app.inject({ url: '/api/service/desk', headers });
      assert.equal(desk.statusCode, serviceTrial ? 401 : 404);
      assert.equal(
        (
          await h.app.inject({
            method: 'POST',
            url: '/api/demo/service-desk',
            headers,
            payload: { operator: 'demo-desk-1' },
          })
        ).statusCode,
        serviceTrial ? 200 : 404,
      );
      if (!serviceTrial) continue;
      const guest = h.identity.createSession(null);
      const plain = { cookie: `${h.sessionCookieName}=${guest.token}` };
      assert.equal(
        (
          await h.app.inject({
            method: 'POST',
            url: '/api/service/help',
            headers: plain,
            payload: { request_key: 'test-help', note: 'test' },
          })
        ).statusCode,
        403,
      );
      const a = h.identity.createSession('alice');
      const privateHeaders = {
        cookie: `${h.sessionCookieName}=${a.token}`,
        'x-csrf-token': a.context.csrf,
      };
      assert.equal(
        (await h.app.inject({ url: '/api/service/desk', headers: privateHeaders })).statusCode,
        403,
      );
      assert.equal(
        (
          await h.app.inject({
            method: 'POST',
            url: '/api/service/help',
            headers: { ...privateHeaders, origin: 'https://evil.test' },
            payload: { request_key: 'test-help', note: 'test' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await h.app.inject({
            method: 'POST',
            url: '/api/service/help',
            headers: privateHeaders,
            payload: { request_key: 'test-help', note: 'test', amount: '100' },
          })
        ).statusCode,
        400,
      );
    } finally {
      await h.app.close();
    }
  }
});

test('S02: find-ticket proof fails closed; separate approval grants exactly one ticket and requested actions; repeated approval is idempotent', async () => {
  const h = pilot();
  try {
    const a = await registered(h);
    for (const [tid, code] of [
      ['CANCEL-NSA-A', 'bad'],
      ['NSA-B', 'DEMO-CANCEL-42'],
    ])
      assert.throws(
        () => h.desk.requestAccess(a.ctx, 'bad-' + tid, tid, code, ['READ']),
        /ACCESS_PROOF_INVALID/,
      );
    assert.throws(
      () =>
        h.desk.requestAccess(h.user().ctx, 'demo-claim', 'CANCEL-NSA-A', 'DEMO-CANCEL-42', [
          'READ',
        ]),
      /REGISTERED_ACCOUNT_REQUIRED/,
    );
    const c = h.desk.requestAccess(a.ctx, 'claim-key', 'CANCEL-NSA-A', 'DEMO-CANCEL-42', ['READ']);
    assert.equal(
      h.desk.requestAccess(a.ctx, 'another-claim', 'CANCEL-NSA-A', 'DEMO-CANCEL-42', ['READ']).id,
      c.id,
    );
    assert.throws(() => h.identity.ticket(a.ctx, 'CANCEL-NSA-A'), /TARGET_UNAVAILABLE/);
    assert.throws(() => caseAct(h, c, 'APPROVE_ACCESS', a.ctx), /SERVICE_OPERATOR_REQUIRED/);
    const claimed = caseAct(h, c, 'CLAIM');
    const approved = caseAct(h, claimed, 'APPROVE_ACCESS');
    assert.equal(caseAct(h, claimed, 'APPROVE_ACCESS').version, approved.version);
    assert.equal(count(h, 'service_access'), 1);
    assert.deepEqual(h.identity.scope(a.ctx, h.identity.ticket(a.ctx, 'CANCEL-NSA-A')), ['READ']);
    assert.throws(() => h.identity.ticket(a.ctx, 'NSA-A'), /TARGET_UNAVAILABLE/);
    assert.throws(() => h.booking.quote(a.ctx, a.conv, cancelRequest()), /TARGET_UNAVAILABLE/);
    assert.equal(count(h, 'operations'), 0);
  } finally {
    h.close();
  }
});

test('S03: sample grant expires exactly at eight hours; an expired pending proof cannot be approved', async () => {
  const h = pilot();
  try {
    const a = await registered(h);
    let c = h.desk.requestAccess(a.ctx, 'expiry-claim', 'CANCEL-NSA-A', 'DEMO-CANCEL-42', [
      ...SERVICE_ACTIONS,
    ]);
    c = caseAct(h, caseAct(h, c, 'CLAIM'), 'APPROVE_ACCESS');
    let pending = h.desk.requestAccess(a.ctx, 'pending-claim', 'BHA-NEW-A', 'DEMO-CHANGE-42', [
      'READ',
    ]);
    pending = caseAct(h, pending, 'CLAIM');
    h.clock.advance(SESSION_TTL - 1);
    assert.ok(h.identity.ticket(h.user(a.ctx.actor_id!).ctx, 'CANCEL-NSA-A'));
    h.clock.advance(1);
    const fresh = h.user(a.ctx.actor_id!);
    assert.throws(() => h.identity.ticket(fresh.ctx, 'CANCEL-NSA-A'), /TARGET_UNAVAILABLE/);
    assert.match(h.desk.caseView(fresh.ctx, c.id).next_step, /到期/);
    assert.throws(
      () => caseAct(h, pending, 'APPROVE_ACCESS', h.user('demo-desk-1').ctx),
      /ACCESS_REQUEST_EXPIRED/,
    );
  } finally {
    h.close();
  }
});

test('S04: revoking a sample grant freezes existing private history and confirmation; new conversation sees no tasks', async () => {
  const h = pilot();
  try {
    const a = await registered(h);
    let c = h.desk.requestAccess(a.ctx, 'revoke-claim', 'CANCEL-NSA-A', 'DEMO-CANCEL-42', [
      ...SERVICE_ACTIONS,
    ]);
    c = caseAct(h, caseAct(h, c, 'CLAIM'), 'APPROVE_ACCESS');
    const q = h.booking.quote(a.ctx, a.conv, cancelRequest()).quote!;
    caseAct(h, c, 'REVOKE_ACCESS', a.ctx);
    assert.throws(() => h.identity.conversation(a.ctx, a.conv), /BUSINESS_HISTORY_RESTRICTED/);
    await assert.rejects(
      h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'revoked-confirm'),
      /BUSINESS_HISTORY_RESTRICTED/,
    );
    assert.equal(h.desk.center(a.ctx).tasks.length, 0);
    assert.equal(count(h, 'operations'), 0);
  } finally {
    h.close();
  }
});

test('S05: operation, ledger, ticket mutation and service tasks roll back together on task persistence failure', async () => {
  const h = pilot();
  try {
    h.store.db.exec(
      "CREATE TRIGGER fail_task BEFORE INSERT ON service_tasks BEGIN SELECT RAISE(ABORT,'test task failure'); END",
    );
    const { result } = await cancel(h);
    assert.notEqual(result.state, 'SUCCEEDED');
    for (const t of ['operations', 'ledger', 'credits', 'service_tasks', 'service_events'])
      assert.equal(count(h, t), 0);
    assert.equal(h.identity.ticket(h.user().ctx, 'CANCEL-NSA-A').version, 1);
  } finally {
    h.close();
  }
});

test('S06: order and refund are separate, refund waits for order; unknown/failed recovery and duplicate callbacks never duplicate money', async () => {
  const h = pilot();
  try {
    const { a, q, result } = await cancel(h);
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal(result.operation.service_tracking.state, 'PENDING');
    let [order, refund] = result.operation.service_tracking.tasks;
    assert.equal(order.kind, 'ORDER');
    assert.equal(refund.kind, 'REFUND');
    assert.equal(moneyText(refund.amount), '20.00');
    const ledger = h.store.all('SELECT * FROM ledger');
    assert.throws(() => taskAct(h, refund, 'ACCEPT'), /ORDER_RECEIPT_REQUIRED/);
    assert.throws(() => h.booking.quote(a.ctx, a.conv, cancelRequest()), /SERVICE_RESULT_PENDING/);
    assert.equal(
      (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'pilot-cancel-key')).operation.id,
      result.operation.id,
    );
    order = taskAct(h, taskAct(h, order, 'ACCEPT'), 'CONFIRM');
    refund = taskAct(h, refund, 'LOSE_REPLY');
    assert.equal(refund.state, 'UNKNOWN');
    refund = taskAct(h, refund, 'RECONCILE');
    refund = taskAct(h, refund, 'FAIL');
    refund = taskAct(h, refund, 'RECONCILE');
    const before = refund;
    refund = taskAct(h, refund, 'CONFIRM');
    assert.deepEqual(taskAct(h, before, 'CONFIRM'), refund);
    assert.throws(
      () => h.desk.actTask(h.other.ctx, 'stale-task', refund.id, before.version, 'FAIL'),
      /SERVICE_VERSION_CHANGED/,
    );
    assert.equal(
      h.booking.operation(a.ctx, result.operation.id).service_tracking.state,
      'COMPLETED',
    );
    assert.deepEqual(h.store.all('SELECT * FROM ledger'), ledger);
    assert.equal(count(h, 'operations'), 1);
    assert.equal(count(h, 'credits'), 1);
    assert.equal(refund.receipt.simulated, true);
  } finally {
    h.close();
  }
});

test('S07: group task and operation views are clipped to each traveler; revoked agent history cannot be reused by status tool', async () => {
  const h = pilot();
  try {
    const agent = h.user('agent'),
      a = h.user(),
      b = h.user('bob');
    const q = h.booking.quote(
      agent.ctx,
      agent.conv,
      changeRequest(h, agent.ctx, ['NSA-A', 'NSA-B']),
    ).quote!;
    const r = await h.booking.confirm(agent.ctx, q.id, q.confirmation_token, 'group-pilot');
    assert.equal(r.state, 'SUCCEEDED');
    assert.deepEqual(
      h.desk.center(a.ctx).tasks.map((t) => t.ticket_id),
      ['NSA-A'],
    );
    assert.deepEqual(
      h.booking
        .operation(b.ctx, r.operation.id)
        .service_tracking.tasks.map((t: any) => t.ticket_id),
      ['NSA-B'],
    );
    const gateway = new ToolGateway(
      h.booking,
      new KnowledgeAdapter(process.cwd(), h.policies),
      h.desk,
    );
    const fresh = h.identity.createConversation(agent.ctx).id;
    await gateway.execute(agent.ctx, fresh, 'service-status-turn', 'get_service_status', {});
    h.store.run("UPDATE grants SET revoked=1 WHERE actor_id='agent' AND ticket_id='NSA-B'");
    assert.throws(() => h.identity.conversation(agent.ctx, fresh), /BUSINESS_HISTORY_RESTRICTED/);
    assert.deepEqual(
      h.desk.center(agent.ctx).tasks.map((t) => t.ticket_id),
      ['NSA-A'],
    );
    await assert.rejects(
      gateway.execute(a.ctx, a.conv, 'no-desk-tools', 'act_task', {}),
      /TOOL_NOT_ALLOWED/,
    );
  } finally {
    h.close();
  }
});

test('S08: competing desk claims, idempotency payload mismatch, info exchange and handoff retain truthful unknown amounts', () => {
  const h = pilot();
  try {
    const a = h.user(),
      b = h.user('bob');
    const initial = h.desk.requestHelp(a.ctx, 'help-first', '请原出票渠道核对例外申请');
    assert.throws(
      () => h.desk.requestHelp(a.ctx, 'help-first', '不同内容'),
      /IDEMPOTENCY_KEY_REUSED/,
    );
    assert.throws(() => h.desk.caseView(b.ctx, initial.id), /TARGET_UNAVAILABLE/);
    let c = caseAct(h, initial, 'CLAIM');
    assert.throws(() => caseAct(h, initial, 'CLAIM', h.other.ctx), /SERVICE_VERSION_CHANGED/);
    assert.throws(() => caseAct(h, c, 'RESOLVE', h.other.ctx), /CASE_OWNED_BY_ANOTHER_OPERATOR/);
    assert.throws(() => caseAct(h, c, 'APPROVE_ACCESS'), /ACCESS_APPROVAL_NOT_APPLICABLE/);
    c = caseAct(h, c, 'REQUEST_INFO');
    c = caseAct(h, c, 'REPLY', a.ctx, '<script>not trusted</script>');
    c = caseAct(h, c, 'HANDOFF');
    assert.equal(c.state, 'WAITING_CHANNEL');
    c = caseAct(h, c, 'CHANNEL_REPLY');
    c = caseAct(h, c, 'RESOLVE');
    assert.equal(c.resolution, 'GUIDANCE_ONLY_NO_PAYMENT_APPROVAL');
    assert.deepEqual(c.amount, { status: 'UNKNOWN', value: null });
    assert.equal(c.timeline.length, 7);
    assert.equal(count(h, 'ledger'), 0);
    assert.equal(count(h, 'service_access'), 0);
    assert.throws(() => caseAct(h, c, 'RESOLVE'), /INVALID_SERVICE_TRANSITION/);
    const denied = caseAct(
      h,
      caseAct(h, h.desk.requestHelp(a.ctx, 'help-second', '再次询问'), 'CLAIM'),
      'REJECT',
    );
    assert.equal(denied.state, 'REJECTED');
  } finally {
    h.close();
  }
});

test('S09: budget/deadline exact boundaries, same-flight group and empty results preserve constraints without a quote or mutation', () => {
  const h = pilot();
  try {
    const a = h.user('agent');
    const result = h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], null, null);
    assert.ok(result.candidates.length > 0);
    const first = result.candidates[0];
    assert.equal(first.together, true);
    const amount = moneyText(first.totals.collect);
    assert.ok(
      h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], first.arrival_at_ms, amount).candidates.length > 0,
    );
    assert.equal(
      h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], BASE + HOUR, '0.00').candidates.length,
      0,
    );
    for (let leg = 0; leg < first.legs.length; leg++) {
      const flights = first.request.targets.map(
        (t: any) =>
          JSON.parse(
            h.store.get<any>('SELECT data FROM offers WHERE id=?', t.replacements[leg].offer_id)
              .data,
          ).flight_id,
      );
      assert.equal(new Set(flights).size, 1);
    }
    assert.throws(() => h.desk.compare(a.ctx, ['NSA-A'], null, '0.001'), /INVALID_BUDGET/);
    assert.throws(() => h.desk.compare(a.ctx, ['NSA-A'], BASE, null), /INVALID_ARRIVAL_DEADLINE/);
    assert.throws(
      () => h.desk.compare(h.user().ctx, ['NSA-A', 'NSA-B'], null, null),
      /TARGET_UNAVAILABLE/,
    );
    assert.equal(count(h, 'quotes'), 0);
    assert.equal(count(h, 'operations'), 0);
  } finally {
    h.close();
  }
});

test('S10: comparison does not bypass inventory, final confirmation, unsupported routes or channel boundary', async () => {
  const h = pilot();
  try {
    const a = h.user('agent');
    const c = h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], null, null).candidates[0];
    const q = h.booking.quote(a.ctx, a.conv, c.request).quote!;
    h.store.run('UPDATE inventory SET capacity=occupied');
    assert.equal(h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], null, null).candidates.length, 0);
    assert.equal(
      (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'inventory-change')).state,
      'REJECTED',
    );
    editTicket(h, 'NSA-B', (t) => {
      t.segments[0].destination = 'DIFFERENT';
    });
    assert.throws(
      () => h.desk.compare(a.ctx, ['NSA-A', 'NSA-B'], null, null),
      /COMPLEX_ITINERARY_REQUIRES_REVIEW/,
    );
    const owner = h.user();
    assert.throws(
      () => h.booking.quote(owner.ctx, owner.conv, cancelRequest('AGENT-NSA-A')),
      /CHANNEL_HANDOFF_REQUIRED/,
    );
    assert.equal(count(h, 'operations'), 0);
  } finally {
    h.close();
  }
});

test('S11: flight event preserves original time, is idempotent, clips alerts, rejects stale quotes and allows fresh policy evaluation', async () => {
  const h = pilot();
  try {
    const a = h.user(),
      ticket = h.identity.ticket(a.ctx, 'BHA-NEW-A');
    const q = h.booking.quote(a.ctx, a.conv, changeRequest(h, a.ctx, [ticket.id])).quote!;
    const s = ticket.segments[0];
    const event = h.desk.flightEvent(
      h.operator.ctx,
      'flight-event-key',
      ticket.id,
      s.id,
      ticket.version,
    );
    assert.deepEqual(
      h.desk.flightEvent(h.operator.ctx, 'flight-event-key', ticket.id, s.id, ticket.version),
      event,
    );
    const updated = h.identity.ticket(a.ctx, ticket.id);
    assert.equal(updated.segments[0].original_departure_at_ms, s.original_departure_at_ms);
    assert.equal(updated.segments[0].departure_at_ms, s.departure_at_ms + 3 * HOUR);
    assert.equal(h.desk.center(a.ctx).alerts.length, 1);
    assert.equal(h.desk.center(h.user('bob').ctx).alerts.length, 0);
    assert.equal(
      (await h.booking.confirm(a.ctx, q.id, q.confirmation_token, 'flight-old-quote')).state,
      'REJECTED',
    );
    const newQuote = h.booking.quote(a.ctx, a.conv, {
      ...cancelRequest(ticket.id),
      action: 'DISRUPTION_REFUND',
    });
    assert.equal(newQuote.decision.status, 'ALLOWED');
    assert.equal(count(h, 'operations'), 0);
    assert.throws(
      () => h.desk.flightEvent(h.operator.ctx, 'flight-second', ticket.id, s.id, updated.version),
      /FLIGHT_EVENT_NOT_APPLICABLE/,
    );
    editTicket(h, 'CANCEL-NSA-A', (t) => {
      t.segments[0].departure_at_ms = BASE;
    });
    const departed = h.identity.ticket(a.ctx, 'CANCEL-NSA-A');
    assert.throws(
      () =>
        h.desk.flightEvent(
          h.operator.ctx,
          'departed-flight',
          departed.id,
          departed.segments[0].id,
          departed.version,
        ),
      /FLIGHT_EVENT_NOT_APPLICABLE/,
    );
  } finally {
    h.close();
  }
});

test('S12: schema v2 upgrades without changing old business rows; service receipts survive restart; legacy results are not fabricated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-service-')),
    filename = join(dir, 'sample.sqlite');
  try {
    let h = pilot(filename);
    const { a, result } = await cancel(h);
    const order = taskAct(
      h,
      taskAct(h, result.operation.service_tracking.tasks[0], 'ACCEPT'),
      'CONFIRM',
    );
    const before = h.store.all('SELECT * FROM ledger');
    h.store.db.pragma('user_version = 2');
    h.close();
    h = pilot(filename);
    assert.equal(h.store.db.pragma('user_version', { simple: true }), 3);
    assert.deepEqual(h.store.all('SELECT * FROM ledger'), before);
    assert.deepEqual(
      h.desk.tasks(h.user().ctx).find((t) => t.id === order.id).receipt,
      order.receipt,
    );
    h.close();
    const original = harness({}, join(dir, 'legacy.sqlite'));
    const old = original.user(),
      q = original.booking.quote(old.ctx, old.conv, cancelRequest()).quote!;
    const op = await original.booking.confirm(old.ctx, q.id, q.confirmation_token, 'old-operation');
    for (const table of [
      'service_access',
      'service_events',
      'service_requests',
      'service_alerts',
      'service_tasks',
      'service_cases',
    ])
      original.store.db.exec(`DROP TABLE ${table}`);
    original.store.db.pragma('user_version = 2');
    original.close();
    const migrated = pilot(join(dir, 'legacy.sqlite'));
    assert.equal(
      migrated.booking.operation(migrated.user().ctx, op.operation.id).service_tracking.state,
      'LEGACY_LOCAL_ONLY',
    );
    assert.equal(count(migrated, 'service_tasks'), 0);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S13: disabling trial on a database with unresolved channel results fails instead of bypassing its business guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-mode-')),
    filename = join(dir, 'sample.sqlite');
  try {
    const h = pilot(filename);
    await cancel(h);
    h.close();
    await assert.rejects(
      createApp({ filename, static: false, clock: new FixedClock(BASE) }),
      /SERVICE_TRIAL_REQUIRED_FOR_PENDING_RESULTS/,
    );
    const resumed = await createApp({
      filename,
      static: false,
      clock: new FixedClock(BASE),
      serviceTrial: true,
    });
    assert.equal(resumed.store.get<any>('SELECT count(*) n FROM service_tasks')!.n, 2);
    await resumed.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S14: a failed service event write rolls back status, receipt and idempotency record; original request can be retried', async () => {
  const h = pilot();
  try {
    const { result } = await cancel(h);
    const order = taskAct(h, result.operation.service_tracking.tasks[0], 'ACCEPT');
    const before = h.store.all('SELECT * FROM service_requests');
    h.store.db.exec(
      "CREATE TRIGGER fail_service_event BEFORE INSERT ON service_events BEGIN SELECT RAISE(ABORT,'test event failure'); END",
    );
    assert.throws(() => taskAct(h, order, 'CONFIRM'), /test event failure/);
    const current = h.desk.tasks(h.operator.ctx).find((t) => t.id === order.id)!;
    assert.equal(current.state, 'PROCESSING');
    assert.equal(current.receipt, null);
    assert.deepEqual(h.store.all('SELECT * FROM service_requests'), before);
    h.store.db.exec('DROP TRIGGER fail_service_event');
    assert.equal(taskAct(h, order, 'CONFIRM').state, 'COMPLETED');
  } finally {
    h.close();
  }
});
