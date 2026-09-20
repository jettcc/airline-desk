import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Accounts } from '../src/server/accounts.js';
import { FixedClock } from '../src/domain/time.js';
import { BASE } from './helpers.js';
const build = (filename = ':memory:') =>
  createApp({ filename, clock: new FixedClock(BASE), static: false });
type App = Awaited<ReturnType<typeof build>>;
async function guest(h: App) {
  const r = await h.app.inject('/api/bootstrap');
  return { cookie: `${r.cookies[0].name}=${r.cookies[0].value}`, 'x-csrf-token': r.json().csrf };
}
async function after(h: App, response: any) {
  const cookie = `${response.cookies[0].name}=${response.cookies[0].value}`;
  const boot = await h.app.inject({ url: '/api/bootstrap', headers: { cookie } });
  return { headers: { cookie, 'x-csrf-token': boot.json().csrf }, boot: boot.json() };
}
const register = (h: App, headers: any, username = 'new_user', extra = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: { username, password: 'Test-only-pass-42', ...extra },
  });
const count = (h: App, table: string) => h.store.get<any>(`SELECT COUNT(*) n FROM ${table}`)!.n;

test('Accounts: register, rotate session, hashed storage, no implicit ticket ownership, logout and login', async () => {
  const h = await build();
  try {
    const g = await guest(h),
      response = await register(h, g, 'New_User', { display_name: '林怡' });
    assert.equal(response.statusCode, 200);
    const user = await after(h, response);
    assert.equal(user.boot.actor.name, '林怡');
    assert.notEqual(user.boot.actor.id, 'alice');
    assert.equal((await h.app.inject({ url: '/api/conversations', headers: g })).statusCode, 401);
    assert.deepEqual(
      (await h.app.inject({ url: '/api/tickets', headers: user.headers })).json(),
      [],
    );
    assert.equal(
      (await h.app.inject({ url: '/api/tickets/NSA-A', headers: user.headers })).statusCode,
      404,
    );
    const stored = h.store.get<any>('SELECT * FROM accounts');
    assert.equal(stored.username, 'new_user');
    assert.equal(stored.password_scheme, 'scrypt-v1');
    assert.equal(stored.password_salt.length, 32);
    assert.equal(stored.password_hash.length, 128);
    assert.equal(JSON.stringify(stored).includes('Test-only-pass-42'), false);
    assert.equal(JSON.stringify(user.boot).includes('password'), false);
    const logout = await h.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: user.headers,
      payload: {},
    });
    const loggedOut = await after(h, logout);
    assert.equal(loggedOut.boot.actor, null);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: loggedOut.headers,
      payload: { username: 'NEW_USER', password: 'Test-only-pass-42' },
    });
    assert.equal(login.statusCode, 200);
    assert.equal((await after(h, login)).boot.actor.id, user.boot.actor.id);
  } finally {
    await h.app.close();
  }
});

test('Accounts: wrong password and unknown account are indistinguishable and never rotate current identity', async () => {
  const h = await build();
  try {
    const registered = await register(h, await guest(h));
    const user = await after(h, registered);
    for (const payload of [
      { username: 'new_user', password: 'wrong-pass' },
      { username: 'missing_user', password: 'wrong-pass' },
    ]) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: user.headers,
        payload,
      });
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: 'AUTH_INVALID' });
      assert.equal(r.cookies.length, 0);
    }
    assert.equal(
      (await h.app.inject({ url: '/api/bootstrap', headers: user.headers })).json().actor.id,
      user.boot.actor.id,
    );
    assert.equal(count(h, 'accounts'), 1);
  } finally {
    await h.app.close();
  }
});

test('Accounts: duplicate concurrent usernames are atomic and each account gets its own salt', async () => {
  const h = await build();
  try {
    const a = await guest(h),
      b = await guest(h);
    const both = await Promise.all([register(h, a, 'Same_Name'), register(h, b, 'same_name')]);
    assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(count(h, 'accounts'), 1);
    assert.equal(count(h, 'actors'), 4);
    const r = await register(h, await guest(h), 'different');
    assert.equal(r.statusCode, 200);
    const rows = h.store.all<any>('SELECT * FROM accounts');
    assert.notEqual(rows[0].password_salt, rows[1].password_salt);
    assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  } finally {
    await h.app.close();
  }
});

test('Accounts: input validation, CSRF and origin guards reject before writing account state', async () => {
  const h = await build();
  try {
    const g = await guest(h);
    for (const extra of [
      { username: 'a' },
      { username: '../alice' },
      { password: 'short' },
      { password: 'a'.repeat(129) },
      { display_name: 'x\u0000y' },
      { actor_id: 'alice' },
      { traveler_id: 'traveler-alice' },
    ]) {
      const r = await register(h, g, 'new_user', extra);
      assert.equal(r.statusCode, 400);
    }
    assert.equal((await register(h, { cookie: g.cookie })).statusCode, 403);
    assert.equal((await register(h, { ...g, origin: 'https://evil.test' })).statusCode, 403);
    assert.equal(count(h, 'accounts'), 0);
    assert.equal(count(h, 'actors'), 3);
  } finally {
    await h.app.close();
  }
});

test('Accounts: failed session creation rolls back account and preserves guest session', async () => {
  const h = await build();
  try {
    const g = await guest(h);
    h.store.db.exec(
      "CREATE TRIGGER fail_registered_session BEFORE INSERT ON sessions WHEN NEW.actor_id LIKE 'account_%' BEGIN SELECT RAISE(ABORT,'test session write failure'); END",
    );
    const r = await register(h, g);
    assert.equal(r.statusCode, 500);
    assert.equal(count(h, 'accounts'), 0);
    assert.equal(count(h, 'actors'), 3);
    assert.equal((await h.app.inject({ url: '/api/conversations', headers: g })).statusCode, 200);
  } finally {
    await h.app.close();
  }
});

test('Accounts: concurrent hashing is bounded and request rate resets without changing login TTL', async () => {
  const h = await build();
  try {
    const guests = await Promise.all(Array.from({ length: 5 }, () => guest(h)));
    const r = await Promise.all(guests.map((g, i) => register(h, g, `user_${i}`)));
    assert.equal(r.filter((x) => x.statusCode === 200).length, 4);
    assert.equal(r.filter((x) => x.statusCode === 429).length, 1);
    const g = await guest(h);
    for (let i = 4; i < 20; i++)
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: g,
        payload: { username: 'missing_user', password: 'wrong-pass' },
      });
    const denied = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: g,
      payload: { username: 'missing_user', password: 'wrong-pass' },
    });
    assert.equal(denied.statusCode, 429);
    (h.clock as FixedClock).advance(60000);
    assert.equal(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: g,
          payload: { username: 'missing_user', password: 'wrong-pass' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await h.app.close();
  }
});

test('Accounts: file persistence and v1 to v2 migration preserve tickets, sessions and credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'airline-account-')),
    filename = join(directory, 'users.sqlite');
  let h = await build(filename);
  try {
    const g = await guest(h),
      initialTickets = count(h, 'tickets');
    // Recreate a genuine old schema shape before reopening for migration.
    h.store.db.exec('DROP TABLE accounts; PRAGMA user_version=1');
    h.store.run("UPDATE meta SET value='1' WHERE key='schema_version'");
    await h.app.close();
    h = await build(filename);
    assert.equal(h.store.db.pragma('user_version', { simple: true }), 3);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.equal(count(h, 'tickets'), initialTickets);
    assert.equal((await h.app.inject({ url: '/api/conversations', headers: g })).statusCode, 200);
    const registration = await register(h, g);
    const original = await after(h, registration);
    await h.app.close();
    h = await build(filename);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: await guest(h),
      payload: { username: 'new_user', password: 'Test-only-pass-42' },
    });
    assert.equal(login.statusCode, 200);
    assert.equal((await after(h, login)).boot.actor.id, original.boot.actor.id);
    assert.equal(count(h, 'tickets'), initialTickets);
  } finally {
    await h.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'Accounts: logout while registration hashes a password cannot create an account or restore the session',
  { timeout: 5000 },
  async () => {
    const h = await build();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const original = Accounts.prototype.prepare;
    Accounts.prototype.prepare = async function (...args: Parameters<Accounts['prepare']>) {
      const draft = await original.apply(this, args);
      started();
      await gate;
      return draft;
    };
    try {
      const g = await guest(h);
      const pending = register(h, g, 'delayed_user').then((r) => r);
      await ready;
      h.identity.logout(h.identity.fromToken(g.cookie.split('=')[1])!);
      release();
      const result = await pending;
      assert.equal(result.statusCode, 401);
      assert.equal(result.json().error, 'SESSION_EXPIRED');
      assert.equal(result.cookies.length, 0);
      assert.equal(count(h, 'accounts'), 0);
      assert.equal(count(h, 'actors'), 3);
    } finally {
      release();
      Accounts.prototype.prepare = original;
      await h.app.close();
    }
  },
);
