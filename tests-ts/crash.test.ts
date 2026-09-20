import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, cancelRequest, changeRequest } from './helpers.js';
for (const point of ['after_receipt', 'before_commit', 'after_commit'])
  test(`Real process SIGKILL ${point}: restart reads atomic state`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airline-kill-'));
    try {
      const filename = join(dir, 'db.sqlite'),
        h = harness({}, filename),
        a = h.user();
      h.booking.quote(a.ctx, a.conv, cancelRequest());
      h.close();
      const signal = await new Promise<string | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests-ts/fixtures/crash-worker.ts', filename, point],
          { cwd: process.cwd(), stdio: 'pipe' },
        );
        let output = '';
        child.stderr.on('data', (d) => (output += d.toString()));
        child.on('error', reject);
        child.on('exit', (code, signal) =>
          signal ? resolve(signal) : reject(new Error(output || 'Expected SIGKILL, got ' + code)),
        );
      });
      assert.equal(signal, 'SIGKILL');
      const restored = harness({}, filename);
      try {
        const committed = point === 'after_commit';
        assert.equal(
          restored.store.get<any>('SELECT COUNT(*) n FROM operations')!.n,
          committed ? 1 : 0,
        );
        assert.equal(
          restored.store.get<any>('SELECT COUNT(*) n FROM credits')!.n,
          committed ? 1 : 0,
        );
        assert.equal(restored.identity.ticket(a.ctx, 'CANCEL-NSA-A').version, committed ? 2 : 1);
        assert.equal(
          restored.booking.submission(a.ctx, 'killed-process').state,
          committed ? 'SUCCEEDED' : 'INTERRUPTED',
        );
        assert.equal(
          restored.store.get<any>('SELECT COUNT(*) n FROM ledger')!.n,
          committed ? 4 : 0,
        );
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('Two tickets compete for final seat: at most one consumes inventory', async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    h = harness({ afterReceipt: () => wait });
  try {
    const a = h.user('agent'),
      b = h.user('agent'),
      ra = changeRequest(h, a.ctx, ['NSA-A']),
      rb = changeRequest(h, b.ctx, ['NSA-B']);
    ra.targets[0].replacements = ra.targets[0].replacements.slice(0, 1);
    rb.targets[0].replacements = rb.targets[0].replacements.slice(0, 1);
    const offer = JSON.parse(
      h.store.get<any>(
        'SELECT data FROM offers WHERE id=?',
        ra.targets[0].replacements[0].offer_id,
      )!.data,
    );
    h.store.run('UPDATE inventory SET capacity=1 WHERE flight_id=?', offer.flight_id);
    const qa = h.booking.quote(a.ctx, a.conv, ra).quote!,
      qb = h.booking.quote(b.ctx, b.conv, rb).quote!;
    const p1 = h.booking.confirm(a.ctx, qa.id, qa.confirmation_token, 'last-seat-a'),
      p2 = h.booking.confirm(b.ctx, qb.id, qb.confirmation_token, 'last-seat-b');
    release();
    const results = await Promise.all([p1, p2]);
    assert.deepEqual(results.map((x) => x.state).sort(), ['REJECTED', 'SUCCEEDED']);
    assert.equal(
      h.store.get<any>('SELECT occupied FROM inventory WHERE flight_id=?', offer.flight_id)!
        .occupied,
      1,
    );
    assert.equal(h.store.get<any>('SELECT COUNT(*) n FROM operations')!.n, 1);
  } finally {
    h.close();
  }
});
