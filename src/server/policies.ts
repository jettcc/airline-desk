import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { policy, type RuleSet } from '../domain/rules.js';
import type { Airline } from '../domain/types.js';
import { timestamp } from '../domain/time.js';
import { Store, hash, canonical } from './db.js';
import { ensure } from './errors.js';
import { z } from 'zod';
const nonnegative = z.number().int().nonnegative().safe();
const fareTable = <T extends z.ZodType>(cell: T) =>
  z.object({ Basic: cell, Standard: cell, Flex: cell }).strict();
const routeTable = <T extends z.ZodType>(cell: T) =>
  z.object({ NSA: cell, BHA: cell, STA_DOM: cell, STA_INT: cell }).strict();
const airlineTable = <T extends z.ZodType>(cell: T) =>
  z.object({ NSA: cell, BHA: cell, STA: cell }).strict();
const cancelCell = z.tuple([z.enum(['NONE', 'REFUND', 'CREDIT']), nonnegative]);
const ruleSchema = z
  .object({
    version: z.string().min(1),
    contract_version: z.literal('1'),
    knowledge_release: z.string().regex(/^[a-f0-9]{24}$/),
    effective_from: airlineTable(z.string().datetime()),
    change: routeTable(fareTable(z.tuple([nonnegative.nullable(), nonnegative.nullable()]))),
    cancel: routeTable(fareTable(z.tuple([cancelCell, cancelCell]))),
    disruption_minutes: airlineTable(nonnegative),
    baggage: routeTable(fareTable(z.tuple([nonnegative, nonnegative, nonnegative]))),
    extra_bag: airlineTable(z.tuple([nonnegative, nonnegative])),
  })
  .strict();
export interface Bundle {
  id: string;
  release_id: string;
  rules: RuleSet;
  sources: Record<string, string>;
  rules_hash: string;
  code_hash: string;
}
export class PolicyRegistry {
  bundles = new Map<string, Bundle>();
  constructor(
    private store: Store,
    public root: string,
  ) {
    const replacements: Array<{ old: string; bundle: Bundle }> = [];
    for (const row of store.all<any>('SELECT * FROM policy_bundles')) {
      const rules = JSON.parse(row.rules_json);
      const bundle = this.verify(rules, row.code_hash);
      ensure(
        bundle.id === row.id &&
          bundle.rules_hash === row.rules_hash &&
          bundle.code_hash === row.code_hash,
        'POLICY_BUNDLE_CHANGED',
        503,
      );
      this.bundles.set(bundle.id, bundle);
      const current = this.verify(rules);
      if (current.id !== bundle.id) replacements.push({ old: bundle.id, bundle: current });
    }
    // One explicitly supported compatibility upgrade: booking arithmetic is still
    // the byte-identical v1 executor. Keep old bundles/receipts; new quotations
    // use the extended baggage executor. An old active quote must be refreshed.
    store.tx(() => {
      for (const { old, bundle: b } of replacements) {
        store.run(
          'INSERT OR IGNORE INTO policy_bundles VALUES (?,?,?,?,?,?)',
          b.id,
          b.release_id,
          b.rules_hash,
          b.code_hash,
          JSON.stringify(b.rules),
          JSON.stringify(b.sources),
        );
        store.run('UPDATE policy_assignments SET bundle_id=? WHERE bundle_id=?', b.id, old);
      }
    });
    for (const { bundle } of replacements) this.bundles.set(bundle.id, bundle);
    if (!this.bundles.size) this.activate(policy);
  }
  verify(rules: RuleSet, recordedCodeHash?: string): Bundle {
    ensure(ruleSchema.safeParse(rules).success, 'INVALID_POLICY_BUNDLE');
    ensure(
      rules.contract_version === '1' && /^[a-f0-9]{24}$/.test(rules.knowledge_release),
      'INVALID_POLICY_BUNDLE',
    );
    const directory = join(this.root, 'data/knowledge/releases', rules.knowledge_release);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    ensure(
      manifest.schema === 1 &&
        manifest.purpose === 'evidence_only' &&
        manifest.release_id === rules.knowledge_release &&
        manifest.files &&
        manifest.reviewed_sources,
      'INVALID_POLICY_MANIFEST',
      503,
    );
    for (const file of ['chunks.json', 'documents.json', 'index.sqlite', 'retrieval.json'])
      ensure(/^[a-f0-9]{64}$/.test(manifest.files[file] ?? ''), 'INVALID_POLICY_MANIFEST', 503);
    for (const airline of ['NSA', 'BHA', 'STA'])
      ensure(
        /^[a-f0-9]{64}$/.test(manifest.reviewed_sources[airline] ?? '') &&
          manifest.files[`sources/${airline}.pdf`] === manifest.reviewed_sources[airline],
        'INVALID_POLICY_MANIFEST',
        503,
      );
    for (const [name, digest] of Object.entries(manifest.files)) {
      const path = resolve(directory, name);
      ensure(path.startsWith(resolve(directory) + '/'), 'INVALID_POLICY_FILE');
      ensure(hash(readFileSync(path)) === digest, 'POLICY_CHECKSUM_FAILED', 503);
    }
    for (const a of ['NSA', 'BHA', 'STA'] as Airline[]) {
      timestamp(Date.parse(rules.effective_from[a]));
      ensure(
        Number.isInteger(rules.disruption_minutes[a]) && rules.disruption_minutes[a] >= 0,
        'INVALID_POLICY_RULE',
      );
    }
    for (const table of Object.values(rules.change))
      for (const fees of Object.values(table))
        ensure(
          fees.length === 2 && fees.every((f) => f === null || (Number.isSafeInteger(f) && f >= 0)),
          'INVALID_POLICY_FEE',
        );
    for (const table of Object.values(rules.cancel))
      for (const entries of Object.values(table))
        for (const [d, f] of entries)
          ensure(
            ['REFUND', 'CREDIT', 'NONE'].includes(String(d)) &&
              Number.isSafeInteger(f) &&
              Number(f) >= 0,
            'INVALID_POLICY_FEE',
          );
    const currentCodeHash = hash(
      ['rules.ts', 'rules-v1.ts', 'money.ts', 'time.ts']
        .map((f) => readFileSync(join(this.root, 'src/domain', f), 'utf8'))
        .join('\n'),
    );
    const originalCodeHash = 'ce3f918532602d278b740e63b1918a96eb322da9955e408965adf4bcb6db6250';
    const retainedCodeHash = hash(
      ['rules-v1.ts', 'money.ts', 'time.ts']
        .map((f) => readFileSync(join(this.root, 'src/domain', f), 'utf8'))
        .join('\n'),
    );
    ensure(retainedCodeHash === originalCodeHash, 'POLICY_BUNDLE_CHANGED', 503);
    ensure(
      !recordedCodeHash ||
        recordedCodeHash === currentCodeHash ||
        recordedCodeHash === originalCodeHash,
      'POLICY_BUNDLE_CHANGED',
      503,
    );
    const codeHash = recordedCodeHash ?? currentCodeHash;
    const rulesHash = hash(canonical(rules));
    const bundleId = hash(
      canonical({
        rulesHash,
        codeHash,
        release: rules.knowledge_release,
        sources: manifest.reviewed_sources,
      }),
    ).slice(0, 24);
    return {
      id: bundleId,
      release_id: rules.knowledge_release,
      rules: structuredClone(rules),
      sources: manifest.reviewed_sources,
      rules_hash: rulesHash,
      code_hash: codeHash,
    };
  }
  activate(rules: RuleSet) {
    const b = this.verify(rules);
    this.store.tx(() => {
      this.store.run(
        'INSERT OR IGNORE INTO policy_bundles VALUES (?,?,?,?,?,?)',
        b.id,
        b.release_id,
        b.rules_hash,
        b.code_hash,
        JSON.stringify(b.rules),
        JSON.stringify(b.sources),
      );
      for (const airline of ['NSA', 'BHA', 'STA'] as Airline[]) {
        const start = Date.parse(rules.effective_from[airline]);
        const next = this.store.get<any>(
          'SELECT from_at_ms FROM policy_assignments WHERE airline=? AND from_at_ms>? ORDER BY from_at_ms LIMIT 1',
          airline,
          start,
        );
        this.store.run(
          'UPDATE policy_assignments SET to_at_ms=? WHERE airline=? AND from_at_ms<? AND (to_at_ms IS NULL OR to_at_ms>?)',
          start,
          airline,
          start,
          start,
        );
        this.store.run(
          'INSERT OR REPLACE INTO policy_assignments VALUES (?,?,?,?)',
          airline,
          start,
          next?.from_at_ms ?? null,
          b.id,
        );
      }
    });
    this.bundles.set(b.id, b);
    return b;
  }
  select(airline: Airline, at: number): Bundle {
    timestamp(at);
    const row = this.store.get<any>(
      'SELECT bundle_id FROM policy_assignments WHERE airline=? AND from_at_ms<=? AND (to_at_ms IS NULL OR to_at_ms>?) ORDER BY from_at_ms DESC LIMIT 1',
      airline,
      at,
      at,
    );
    ensure(row && this.bundles.has(row.bundle_id), 'POLICY_NOT_AVAILABLE', 409);
    return this.bundles.get(row.bundle_id)!;
  }
  get(id: string) {
    const b = this.bundles.get(id);
    ensure(b, 'POLICY_NOT_AVAILABLE', 409);
    return b;
  }
  sourceUrl(bundle: Bundle, airline: Airline, page: number) {
    return `/api/policies/${bundle.release_id}/${airline}.pdf#page=${page}`;
  }
}
