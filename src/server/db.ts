import Database from 'better-sqlite3';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export class Store {
  db: Database.Database;
  generation: string;
  constructor(
    public filename: string,
    recover = true,
  ) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      if (existsSync(filename)) chmodSync(filename, 0o600);
    }
    this.db = new Database(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 1000');
    const schemaVersion = Number(this.db.pragma('user_version', { simple: true }));
    if (schemaVersion > 3) {
      this.db.close();
      throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
    }
    this.db
      .transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY, name TEXT NOT NULL, traveler_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(username TEXT PRIMARY KEY, actor_id TEXT UNIQUE NOT NULL REFERENCES actors(id), password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_scheme TEXT NOT NULL CHECK(password_scheme='scrypt-v1'), created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, actor_id TEXT REFERENCES actors(id), csrf TEXT NOT NULL, created_at_ms INTEGER NOT NULL, last_active_at_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, traveler_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, actor_id TEXT REFERENCES actors(id), ticket_id TEXT REFERENCES tickets(id), actions TEXT NOT NULL, starts_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
      CREATE TRIGGER IF NOT EXISTS grant_security_revision AFTER UPDATE OF actor_id,ticket_id,actions,starts_at_ms,expires_at_ms,revoked ON grants
      WHEN NEW.version<=OLD.version AND (NEW.actor_id IS NOT OLD.actor_id OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.actions IS NOT OLD.actions OR NEW.starts_at_ms IS NOT OLD.starts_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.revoked IS NOT OLD.revoked)
      BEGIN UPDATE grants SET version=OLD.version+1 WHERE id=NEW.id; END;
      CREATE TABLE IF NOT EXISTS inventory(flight_id TEXT PRIMARY KEY, capacity INTEGER NOT NULL CHECK(capacity>=0), occupied INTEGER NOT NULL CHECK(occupied>=0 AND occupied<=capacity));
      CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY, flight_id TEXT NOT NULL REFERENCES inventory(flight_id), version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS reservations(ticket_id TEXT NOT NULL REFERENCES tickets(id), segment_id TEXT NOT NULL, flight_id TEXT NOT NULL REFERENCES inventory(flight_id), PRIMARY KEY(ticket_id,segment_id));
      CREATE TABLE IF NOT EXISTS policy_bundles(id TEXT PRIMARY KEY, release_id TEXT NOT NULL, rules_hash TEXT NOT NULL, code_hash TEXT NOT NULL, rules_json TEXT NOT NULL, manifest_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_assignments(airline TEXT NOT NULL, from_at_ms INTEGER NOT NULL, to_at_ms INTEGER, bundle_id TEXT NOT NULL REFERENCES policy_bundles(id), PRIMARY KEY(airline,from_at_ms), CHECK(to_at_ms IS NULL OR to_at_ms>from_at_ms));
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, intent_version INTEGER NOT NULL DEFAULT 0, active_quote_id TEXT, busy_turn_id TEXT, dependencies TEXT NOT NULL DEFAULT '[]', frozen INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_key TEXT NOT NULL, content_hash TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, response TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(conversation_id,message_key));
      CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), session_id TEXT NOT NULL REFERENCES sessions(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), idempotency_key TEXT NOT NULL, content_hash TEXT NOT NULL, quote_id TEXT NOT NULL REFERENCES quotes(id), received_at_ms INTEGER NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL, operation_id TEXT, error_code TEXT, UNIQUE(actor_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), quote_id TEXT UNIQUE NOT NULL REFERENCES quotes(id), created_at_ms INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, direction TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'), units TEXT NOT NULL, nanos INTEGER NOT NULL CHECK(nanos BETWEEN 0 AND 999999999), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumptions(entitlement_id TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES operations(id), PRIMARY KEY(entitlement_id,kind));
      CREATE TABLE IF NOT EXISTS credits(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), ticket_id TEXT NOT NULL, traveler_id TEXT NOT NULL, airline TEXT NOT NULL, issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, currency TEXT NOT NULL, units TEXT NOT NULL, nanos INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_cases(id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL REFERENCES actors(id), request_key TEXT NOT NULL, content_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(applicant_id,request_key));
      CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, created_at_ms INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_tasks(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL CHECK(kind IN ('ORDER','REFUND')), state TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(operation_id,ticket_id,kind));
      CREATE TABLE IF NOT EXISTS service_cases(case_id TEXT PRIMARY KEY REFERENCES review_cases(id), state TEXT NOT NULL, version INTEGER NOT NULL, owner TEXT, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS service_events(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, actor_id TEXT, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(subject_id,version));
      CREATE TABLE IF NOT EXISTS service_requests(actor_id TEXT NOT NULL REFERENCES actors(id), request_key TEXT NOT NULL, content_hash TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor_id,request_key));
      CREATE TABLE IF NOT EXISTS service_access(case_id TEXT PRIMARY KEY REFERENCES review_cases(id), ticket_id TEXT NOT NULL REFERENCES tickets(id), actions TEXT NOT NULL, proof_hash TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, grant_id TEXT);
      CREATE TABLE IF NOT EXISTS service_alerts(id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), created_at_ms INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS ticket_booking ON tickets(booking_id);
      CREATE INDEX IF NOT EXISTS session_token ON sessions(token_hash);
    `);
        this.db.pragma('user_version = 3');
        this.run("INSERT OR REPLACE INTO meta VALUES ('schema_version','3')");
      })
      .immediate();
    this.generation = recover
      ? id('run')
      : (this.get<any>("SELECT value FROM meta WHERE key='generation'")?.value ?? id('run'));
    if (recover)
      this.tx(() => {
        this.run("INSERT OR REPLACE INTO meta VALUES ('generation',?)", this.generation);
        const pending = this.all<any>("SELECT * FROM submissions WHERE state='RECEIVED'");
        for (const s of pending) {
          const operation = this.get<any>('SELECT id FROM operations WHERE quote_id=?', s.quote_id);
          this.run(
            'UPDATE submissions SET state=?,operation_id=?,error_code=? WHERE id=?',
            operation ? 'SUCCEEDED' : 'INTERRUPTED',
            operation?.id ?? null,
            operation ? null : 'SERVICE_RESTARTED',
            s.id,
          );
        }
        this.run("UPDATE turns SET state='INTERRUPTED' WHERE state='RUNNING'");
        this.run('UPDATE conversations SET busy_turn_id=NULL');
      });
  }
  get<T>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  close() {
    this.db.close();
  }
}
