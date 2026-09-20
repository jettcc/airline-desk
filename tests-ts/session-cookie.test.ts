import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { FixedClock, IDLE_TTL } from '../src/domain/time.js';
import { BASE } from './helpers.js';

const build = (filename = ':memory:', clock = new FixedClock(BASE)) =>
  createApp({ filename, clock, static: false });
const cookieHeader = (cookies: Array<{ name: string; value: string }>) =>
  cookies.map((c) => `${c.name}=${c.value}`).join('; ');

test('Local instances keep independent cookie identities through bootstrap, login and logout', async () => {
  const a = await build(),
    b = await build();
  try {
    const first = await a.app.inject('/api/bootstrap');
    const second = await b.app.inject({
      url: '/api/bootstrap',
      headers: { cookie: cookieHeader(first.cookies) },
    });
    assert.notEqual(first.cookies[0].name, second.cookies[0].name);
    let cookies = [...first.cookies, ...second.cookies];
    for (const h of [a, b, a, b]) {
      const response = await h.app.inject({
        url: '/api/bootstrap',
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(response.json().session_id, (h === a ? first : second).json().session_id);
      assert.equal(response.cookies.length, 0);
    }
    const login = await a.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': first.json().csrf },
      payload: { actor_id: 'alice' },
    });
    assert.equal(login.statusCode, 200);
    cookies = [...second.cookies, ...login.cookies];
    const active = (
      await a.app.inject({ url: '/api/bootstrap', headers: { cookie: cookieHeader(cookies) } })
    ).json();
    assert.equal(active.actor.id, 'alice');
    assert.equal(
      (
        await b.app.inject({ url: '/api/bootstrap', headers: { cookie: cookieHeader(cookies) } })
      ).json().actor,
      null,
    );
    const logout = await a.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': active.csrf },
      payload: {},
    });
    assert.equal(logout.cookies[0].name, first.cookies[0].name);
    assert.equal(logout.statusCode, 200);
    assert.equal(
      (
        await b.app.inject({
          url: '/api/bootstrap',
          headers: { cookie: cookieHeader([...second.cookies, ...logout.cookies]) },
        })
      ).json().session_id,
      second.json().session_id,
    );
    // Possessing only the other app's cookie cannot authorize even a read.
    assert.equal(
      (
        await b.app.inject({
          url: '/api/conversations',
          headers: { cookie: cookieHeader(login.cookies) },
        })
      ).statusCode,
      401,
    );
  } finally {
    await a.app.close();
    await b.app.close();
  }
});

test('Cookie namespace survives restart with the existing database and conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airline-session-'));
  const filename = join(dir, 'test.sqlite');
  let h = await build(filename);
  try {
    const boot = await h.app.inject('/api/bootstrap');
    const headers = { cookie: cookieHeader(boot.cookies), 'x-csrf-token': boot.json().csrf };
    const conversation = (
      await h.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} })
    ).json();
    const namespace = h.sessionCookieName;
    await h.app.close();
    h = await build(filename);
    assert.equal(h.sessionCookieName, namespace);
    const resumed = await h.app.inject({ url: '/api/bootstrap', headers });
    assert.equal(resumed.json().session_id, boot.json().session_id);
    assert.equal(resumed.cookies.length, 0);
    assert.equal(
      (await h.app.inject({ url: '/api/conversations', headers })).json()[0].id,
      conversation.id,
    );
  } finally {
    await h.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Legacy cookie migration preserves only a valid local session and ignores later legacy interference', async () => {
  const clock = new FixedClock(BASE),
    h = await build(':memory:', clock);
  try {
    const legacy = h.identity.createSession('alice');
    const conversation = h.identity.createConversation(legacy.context);
    clock.advance(IDLE_TTL - 10);
    const boot = await h.app.inject({
      url: '/api/bootstrap',
      headers: { cookie: `airline_session=${legacy.token}` },
    });
    assert.equal(boot.json().session_id, legacy.context.session_id);
    assert.equal(boot.cookies[0].name, h.sessionCookieName);
    assert.equal(boot.cookies[0].httpOnly, true);
    assert.equal(boot.cookies[0].sameSite, 'Strict');
    const header = cookieHeader(boot.cookies) + '; airline_session=from-another-local-app';
    assert.equal(
      (await h.app.inject({ url: '/api/bootstrap', headers: { cookie: header } })).json()
        .session_id,
      legacy.context.session_id,
    );
    assert.equal(
      (
        await h.app.inject({
          url: `/api/conversations/${conversation.id}`,
          headers: { cookie: header },
        })
      ).statusCode,
      200,
    );
    clock.advance(10);
    const expired = await h.app.inject({ url: '/api/bootstrap', headers: { cookie: header } });
    assert.equal(expired.json().actor, null);
    assert.notEqual(expired.json().session_id, legacy.context.session_id);
  } finally {
    await h.app.close();
  }
});

test('An invalid scoped cookie never rolls identity back to a valid legacy cookie', async () => {
  const h = await build(),
    other = await build();
  try {
    const local = h.identity.createSession('alice'),
      foreign = other.identity.createSession('bob');
    const rejectedForeign = await h.app.inject({
      url: '/api/bootstrap',
      headers: { cookie: `airline_session=${foreign.token}` },
    });
    assert.equal(rejectedForeign.json().actor, null);
    const invalid = await h.app.inject({
      url: '/api/bootstrap',
      headers: { cookie: `${h.sessionCookieName}=invalid; airline_session=${local.token}` },
    });
    assert.equal(invalid.json().actor, null);
    const legacyWrite = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: `airline_session=${local.token}`, 'x-csrf-token': local.context.csrf },
      payload: {},
    });
    assert.equal(legacyWrite.statusCode, 401);
  } finally {
    await h.app.close();
    await other.app.close();
  }
});
