import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Store, id } from './db.js';
import { ensure } from './errors.js';
import type { Clock } from '../domain/time.js';

const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export class Accounts {
  private attempts = new Map<string, { start: number; count: number }>();
  private inflight = 0;
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  async attempt<T>(address: string, work: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    for (const [key, value] of this.attempts)
      if (now >= value.start + 60000) this.attempts.delete(key);
    const bucket = this.attempts.get(address) ?? { start: now, count: 0 };
    ensure(bucket.count < 20 && this.inflight < 4, 'AUTH_RATE_LIMITED', 429);
    bucket.count++;
    this.attempts.set(address, bucket);
    this.inflight++;
    try {
      return await work();
    } finally {
      this.inflight--;
    }
  }

  async prepare(username: string, password: string, displayName?: string) {
    const salt = randomBytes(16).toString('hex');
    const digest = await derive(password, salt);
    return {
      username: normalizeUsername(username),
      actorId: id('account'),
      travelerId: id('traveler'),
      name: displayName?.trim() || username.trim(),
      salt,
      digest: digest.toString('hex'),
    };
  }
  insert(draft: Awaited<ReturnType<Accounts['prepare']>>) {
    // Call inside the same transaction as session rotation. Unique username is
    // checked after asynchronous hashing so concurrent registrations cannot win twice.
    ensure(
      !this.store.get('SELECT 1 FROM accounts WHERE username=?', draft.username),
      'USERNAME_TAKEN',
      409,
    );
    this.store.run(
      'INSERT INTO actors VALUES (?,?,?)',
      draft.actorId,
      draft.name,
      draft.travelerId,
    );
    this.store.run(
      'INSERT INTO accounts VALUES (?,?,?,?,?,?)',
      draft.username,
      draft.actorId,
      draft.salt,
      draft.digest,
      'scrypt-v1',
      this.clock.now(),
    );
  }
  async authenticate(username: string, password: string) {
    const row = this.store.get<{ actor_id: string; password_salt: string; password_hash: string }>(
      'SELECT actor_id,password_salt,password_hash FROM accounts WHERE username=?',
      normalizeUsername(username),
    );
    // Unknown usernames pay the same hashing cost and receive the same error.
    const digest = await derive(password, row?.password_salt ?? '0'.repeat(32));
    const expected = Buffer.from(row?.password_hash ?? '0'.repeat(128), 'hex');
    ensure(
      row && expected.length === digest.length && timingSafeEqual(expected, digest),
      'AUTH_INVALID',
      401,
    );
    return row.actor_id;
  }
}
