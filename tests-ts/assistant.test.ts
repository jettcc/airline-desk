import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { ScriptedModel, RightCodesModel, ModelPool } from '../src/assistant/model.js';
import { FixedClock } from '../src/domain/time.js';
import { BASE, cancelRequest } from './helpers.js';
const build = (model: any) =>
  createApp({
    filename: ':memory:',
    clock: new FixedClock(BASE),
    frozenClock: true,
    model,
    static: false,
  });
test('HTTP same-origin CSRF, private scope, forged amounts, sources and quote confirmation', async () => {
  const h = await build(
    new ScriptedModel(() => ({ name: 'clarify', args: { reason: 'GREETING' } })),
  );
  try {
    const boot = await h.app.inject('/api/bootstrap');
    assert.equal(boot.statusCode, 200);
    const b = boot.json(),
      cookie = boot.cookies[0].name + '=' + boot.cookies[0].value;
    let r = await h.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { cookie },
      payload: { actor_id: 'alice' },
    });
    assert.equal(r.statusCode, 403);
    r = await h.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { cookie, 'x-csrf-token': b.csrf, origin: 'https://evil.test' },
      payload: { actor_id: 'alice' },
    });
    assert.equal(r.statusCode, 403);
    r = await h.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { cookie, 'x-csrf-token': b.csrf },
      payload: { actor_id: 'alice' },
    });
    assert.equal(r.statusCode, 200);
    const c = r.cookies[0].name + '=' + r.cookies[0].value;
    const b2 = (await h.app.inject({ url: '/api/bootstrap', headers: { cookie: c } })).json(),
      headers = { cookie: c, 'x-csrf-token': b2.csrf };
    const conv = (
      await h.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} })
    ).json();
    r = await h.app.inject({ url: '/api/tickets', headers });
    assert.equal(r.statusCode, 200);
    assert.equal(
      r.json().some((t: any) => t.id === 'NSA-B'),
      false,
    );
    r = await h.app.inject({
      method: 'POST',
      url: '/api/quotes',
      headers,
      payload: { conversation_id: conv.id, request: { ...cancelRequest(), amount: 0 } },
    });
    assert.equal(r.statusCode, 400);
    r = await h.app.inject({
      method: 'POST',
      url: '/api/quotes',
      headers,
      payload: { conversation_id: conv.id, request: cancelRequest() },
    });
    assert.equal(r.statusCode, 200);
    const q = r.json().quote;
    r = await h.app.inject({
      method: 'POST',
      url: '/api/confirm',
      headers,
      payload: {
        quote_id: q.id,
        confirmation_token: q.confirmation_token,
        request_key: 'http-submit-1',
      },
    });
    assert.equal(r.json().state, 'SUCCEEDED');
    assert.equal(r.json().operation.totals.credit.units, '60');
    assert.equal(
      (await h.app.inject(`/api/policies/${h.policies.select('NSA', BASE).release_id}/NSA.pdf`))
        .headers['content-type'],
      'application/pdf',
    );
    assert.notEqual(
      (await h.app.inject('/api/policies/../../.env.rightcodes.local')).statusCode,
      200,
    );
    assert.equal(
      (await h.app.inject({ url: '/api/bootstrap', headers: { host: 'evil.test' } })).statusCode,
      403,
    );
  } finally {
    await h.app.close();
  }
});
test('Conversation tools perform real KB search; message idempotency, repair and no free-text business facts', async () => {
  let count = 0;
  const model = new ScriptedModel(() => {
    count++;
    return {
      name: 'search_policy',
      args: { question: 'Bluehaven baggage', airline: 'BHA', compare: false },
    };
  });
  const h = await build(model);
  try {
    const ctx = h.identity.createSession().context,
      c = h.identity.createConversation(ctx);
    const t = h.conversations.start(ctx, c.id, 'message-one', 'Bluehaven baggage');
    await h.conversations.wait(t.id);
    const done = h.conversations.turn(ctx, t.id);
    assert.equal(done.state, 'COMPLETED');
    assert.ok(done.response.cards[0].data.parts[0].evidence.some((e: any) => e.id === 'BHA:7'));
    assert.equal(JSON.stringify(done.response).includes('/Users/'), false);
    assert.equal(h.conversations.start(ctx, c.id, 'message-one', 'Bluehaven baggage').id, t.id);
    assert.equal(count, 1);
    assert.throws(() => h.conversations.start(ctx, c.id, 'message-one', 'different'));
  } finally {
    await h.app.close();
  }
  const rawModel = {
    mode: 'mock',
    name: 'malicious',
    respond: async () => ({
      output: [{ type: 'message', content: [{ text: 'Refund complete! $999999' }] }],
      model: 'malicious',
      elapsed_ms: 0,
    }),
  };
  const h2 = await build(rawModel);
  try {
    const ctx = h2.identity.createSession().context,
      c = h2.identity.createConversation(ctx),
      t = h2.conversations.start(ctx, c.id, 'message-two', 'hello');
    await h2.conversations.wait(t.id);
    assert.equal(h2.conversations.turn(ctx, t.id).state, 'FAILED');
    assert.ok(!JSON.stringify(h2.conversations.turn(ctx, t.id)).includes('999999'));
  } finally {
    await h2.app.close();
  }
});
test('Busy conversation prevents old confirmation; explanation preserves quote; logout discards late output', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const h = await build(
    new ScriptedModel(async () => {
      await barrier;
      return { name: 'explain_quote', args: {} };
    }),
  );
  try {
    const ctx = h.identity.createSession('alice').context,
      c = h.identity.createConversation(ctx),
      q = h.booking.quote(ctx, c.id, cancelRequest()).quote!;
    const t = h.conversations.start(ctx, c.id, 'message-explain', 'Explain this quote');
    await assert.rejects(
      () => h.booking.confirm(ctx, q.id, q.confirmation_token, 'confirm-busy'),
      /CONVERSATION_BUSY/,
    );
    assert.throws(
      () => h.conversations.start(ctx, c.id, 'message-duplicate', 'new message'),
      /CONVERSATION_BUSY/,
    );
    release();
    await h.conversations.wait(t.id);
    assert.equal(h.identity.conversation(ctx, c.id).active_quote_id, q.id);
    assert.equal(h.conversations.turn(ctx, t.id).response.cards[0].kind, 'quote');
  } finally {
    await h.app.close();
  }
  let done!: () => void;
  const slow = new Promise<void>((r) => (done = r));
  const h2 = await build(
    new ScriptedModel(async () => {
      await slow;
      return { name: 'get_booking', args: { ticket_ids: [], present: true } };
    }),
  );
  try {
    const ctx = h2.identity.createSession('alice').context,
      c = h2.identity.createConversation(ctx),
      t = h2.conversations.start(ctx, c.id, 'logout-late', 'my tickets');
    h2.identity.logout(ctx);
    done();
    await h2.conversations.wait(t.id);
    const row = h2.store.get<any>('SELECT * FROM turns WHERE id=?', t.id)!;
    assert.equal(row.state, 'RESTRICTED');
    assert.deepEqual(JSON.parse(row.response).cards, []);
    assert.throws(() => h2.conversations.turn(ctx, t.id));
  } finally {
    await h2.app.close();
  }
});
test('Revoked grant is checked before historical model context; unrelated user context never included', async () => {
  let calls = 0;
  const h = await build(
    new ScriptedModel((input) => {
      calls++;
      assert.ok(!JSON.stringify(input).includes('OTHER_USER_SECRET'));
      return { name: 'get_booking', args: { ticket_ids: ['NSA-B'], present: true } };
    }),
  );
  try {
    const ctx = h.identity.createSession('agent').context,
      c = h.identity.createConversation(ctx);
    const t = h.conversations.start(ctx, c.id, 'grant-before', 'View NSA-B');
    await h.conversations.wait(t.id);
    assert.equal(calls, 1);
    h.store.run("UPDATE grants SET revoked=1 WHERE actor_id='agent' AND ticket_id='NSA-B'");
    assert.throws(
      () => h.conversations.start(ctx, c.id, 'grant-after', 'Again'),
      /BUSINESS_HISTORY_RESTRICTED/,
    );
    assert.equal(calls, 1);
  } finally {
    await h.app.close();
  }
});
test('Model SSE requires a complete matching response; errors do not expose provider messages or keys', async () => {
  const run = (events: any[], model = 'gpt-5.6-sol') =>
    new RightCodesModel(
      'SECRET_FOR_TEST',
      'https://www.right.codes/codex/v1',
      async () =>
        new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        }) as any,
    ).respond([], 'test', []);
  const result = await run([
    {
      type: 'response.completed',
      response: {
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ]);
  assert.equal(result.usage?.total_tokens, 3);
  await assert.rejects(
    () => run([{ type: 'response.output_text.delta', delta: 'Refund done' }]),
    /MODEL_INCOMPLETE/,
  );
  await assert.rejects(
    () =>
      run([
        {
          type: 'response.completed',
          response: { model: 'other', status: 'completed', output: [] },
        },
      ]),
    /MODEL_MISMATCH/,
  );
  await assert.rejects(
    () => run([{ type: 'error', message: 'SECRET_FOR_TEST' }]),
    (e) => !String(e).includes('SECRET_FOR_TEST'),
  );
});
test('Bounded pool admits only configured workers and rejects excess queue', async () => {
  const pool = new ModelPool(1, 1, 1000);
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  let active = 0,
    max = 0;
  const work = () =>
    pool.run(async () => {
      active++;
      max = Math.max(max, active);
      await barrier;
      active--;
      return true;
    });
  const first = work(),
    second = work();
  await assert.rejects(() => work(), /MODEL_BUSY/);
  release();
  await Promise.all([first, second]);
  assert.equal(max, 1);
});
test('Ten independent conversations retain separate histories with deterministic model', async () => {
  const h = await build(
    new ScriptedModel(() => ({ name: 'clarify', args: { reason: 'GREETING' } })),
  );
  try {
    const turns = Array.from({ length: 10 }, (_, i) => {
      const ctx = h.identity.createSession(i % 2 ? 'alice' : 'bob').context,
        c = h.identity.createConversation(ctx),
        t = h.conversations.start(ctx, c.id, 'parallel-' + i, 'unique-user-' + i);
      return { ctx, c, t, i };
    });
    await Promise.all(turns.map((x) => h.conversations.wait(x.t.id)));
    for (const x of turns) {
      const hist = h.conversations.history(x.ctx, x.c.id);
      assert.equal(hist.turns.length, 1);
      assert.equal(hist.turns[0].request.message, 'unique-user-' + x.i);
      assert.equal(hist.turns[0].state, 'COMPLETED');
    }
  } finally {
    await h.app.close();
  }
});
test('Clarification continuation keeps the prior task and repairs a generic repeated question once', async () => {
  let calls = 0;
  const h = await build(
    new ScriptedModel((input) => {
      calls++;
      const current = JSON.parse(input.filter((x) => x.role === 'user').at(-1).content);
      if (calls === 1) return { name: 'clarify', args: { reason: 'AIRLINE' } };
      assert.equal(current.previous_user_request, '行李能带多少？');
      assert.equal(current.reply_to_clarification, 'AIRLINE');
      assert.equal(current.message, 'Bluehaven Basic');
      if (calls === 2) return { name: 'clarify', args: { reason: 'DETAILS' } };
      return {
        name: 'check_baggage',
        args: { airline: 'BHA', fare: 'Basic', domestic: true, bags: [] },
      };
    }),
  );
  try {
    const ctx = h.identity.createSession().context,
      c = h.identity.createConversation(ctx);
    const first = h.conversations.start(ctx, c.id, 'continuation-one', '行李能带多少？');
    await h.conversations.wait(first.id);
    const next = h.conversations.start(ctx, c.id, 'continuation-two', 'Bluehaven Basic');
    await h.conversations.wait(next.id);
    assert.equal(h.conversations.turn(ctx, next.id).response.cards[0].kind, 'baggage');
    assert.equal(calls, 3);
  } finally {
    await h.app.close();
  }
});
