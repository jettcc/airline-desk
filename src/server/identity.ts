import { randomBytes } from 'node:crypto';
import { Store, hash, id } from './db.js';
import { ensure, unavailable } from './errors.js';
import { type Clock, IDLE_TTL, SESSION_TTL } from '../domain/time.js';
import type { Context, Actor, Action, Ticket } from '../domain/types.js';
export interface SessionRow {
  id: string;
  token_hash: string;
  actor_id: string | null;
  csrf: string;
  created_at_ms: number;
  last_active_at_ms: number;
  revoked: number;
}
export class Identity {
  constructor(
    public store: Store,
    public clock: Clock,
  ) {}
  createSession(actor: string | null = null) {
    if (actor)
      ensure(this.store.get('SELECT id FROM actors WHERE id=?', actor), 'INVALID_DEMO_ACCOUNT');
    const token = randomBytes(32).toString('hex'),
      sid = id('session'),
      csrf = randomBytes(24).toString('hex'),
      now = this.clock.now();
    this.store.run(
      'INSERT INTO sessions VALUES (?,?,?,?,?,?,0)',
      sid,
      hash(token),
      actor,
      csrf,
      now,
      now,
    );
    return { token, context: { session_id: sid, actor_id: actor, csrf } satisfies Context };
  }
  fromToken(token?: string, active = false): Context | null {
    if (!token) return null;
    const s = this.store.get<SessionRow>('SELECT * FROM sessions WHERE token_hash=?', hash(token));
    if (!s || !this.valid(s)) return null;
    if (active)
      this.store.run('UPDATE sessions SET last_active_at_ms=? WHERE id=?', this.clock.now(), s.id);
    return { session_id: s.id, actor_id: s.actor_id, csrf: s.csrf };
  }
  valid(s: SessionRow) {
    const now = this.clock.now();
    return (
      !s.revoked && now < s.created_at_ms + SESSION_TTL && now < s.last_active_at_ms + IDLE_TTL
    );
  }
  assertContext(ctx: Context, privateAccess = false) {
    const s = this.store.get<SessionRow>('SELECT * FROM sessions WHERE id=?', ctx.session_id);
    ensure(s && this.valid(s) && s.actor_id === ctx.actor_id, 'SESSION_EXPIRED', 401);
    if (privateAccess) ensure(ctx.actor_id, 'LOGIN_REQUIRED', 401);
    return s;
  }
  logout(ctx: Context) {
    this.store.tx(() => this.store.run('UPDATE sessions SET revoked=1 WHERE id=?', ctx.session_id));
  }
  actor(ctx: Context) {
    this.assertContext(ctx);
    return ctx.actor_id
      ? this.store.get<Actor>('SELECT * FROM actors WHERE id=?', ctx.actor_id)!
      : null;
  }
  authorized(ctx: Context, t: Ticket, action: Action | 'READ') {
    this.assertContext(ctx, true);
    const actor = this.actor(ctx)!;
    if (actor.traveler_id === t.traveler_id) return { kind: 'OWNER' as const, grant_id: null };
    const now = this.clock.now();
    const grants = this.store.all<any>(
      'SELECT * FROM grants WHERE actor_id=? AND ticket_id=? AND revoked=0 AND starts_at_ms<=? AND expires_at_ms>?',
      actor.id,
      t.id,
      now,
      now,
    );
    const grant = grants.find((g) => {
      const actions: string[] = JSON.parse(g.actions);
      return action === 'READ' ? actions.length > 0 : actions.includes(action);
    });
    return grant ? { kind: 'GRANT' as const, grant_id: grant.id } : null;
  }
  ticket(ctx: Context, ticketId: string, action: Action | 'READ' = 'READ'): Ticket {
    this.assertContext(ctx, true);
    const row = this.store.get<any>('SELECT data FROM tickets WHERE id=?', ticketId);
    if (!row) throw unavailable();
    const t: Ticket = JSON.parse(row.data);
    if (!this.authorized(ctx, t, action)) throw unavailable();
    return t;
  }
  scope(ctx: Context, t: Ticket): string[] {
    return (
      ['READ', 'CHANGE', 'CANCEL', 'TAX_REFUND', 'DISRUPTION_CHANGE', 'DISRUPTION_REFUND'] as const
    ).filter((a) => this.authorized(ctx, t, a));
  }
  owner(ctx: Context) {
    return ctx.actor_id ? `actor:${ctx.actor_id}` : `session:${ctx.session_id}`;
  }
  conversation(ctx: Context, conversationId: string) {
    this.assertContext(ctx);
    const c = this.store.get<any>(
      'SELECT * FROM conversations WHERE id=? AND owner=?',
      conversationId,
      this.owner(ctx),
    );
    if (!c) throw unavailable();
    const deps: { ticket_id: string; action: string; grant_id: string; grant_version?: number }[] =
      JSON.parse(c.dependencies);
    for (const dep of deps) {
      const g = this.store.get<any>('SELECT * FROM grants WHERE id=?', dep.grant_id),
        now = this.clock.now();
      if (
        !g ||
        g.version !== (dep.grant_version ?? 1) ||
        g.actor_id !== ctx.actor_id ||
        g.ticket_id !== dep.ticket_id ||
        g.revoked ||
        g.starts_at_ms > now ||
        g.expires_at_ms <= now ||
        !JSON.parse(g.actions).includes(dep.action)
      ) {
        this.store.run('UPDATE conversations SET frozen=1,active_quote_id=NULL WHERE id=?', c.id);
        c.frozen = 1;
      }
    }
    ensure(!c.frozen, 'BUSINESS_HISTORY_RESTRICTED', 403);
    return c;
  }
  createConversation(ctx: Context) {
    this.assertContext(ctx);
    const cid = id('conversation');
    this.store.run(
      'INSERT INTO conversations(id,owner,created_at_ms) VALUES (?,?,?)',
      cid,
      this.owner(ctx),
      this.clock.now(),
    );
    return this.conversation(ctx, cid);
  }
  bindTicket(ctx: Context, conversationId: string, t: Ticket, action: Action | 'READ') {
    const c = this.conversation(ctx, conversationId),
      access = this.authorized(ctx, t, action);
    ensure(access, 'TARGET_UNAVAILABLE', 404);
    if (access.grant_id) {
      const deps: {
        ticket_id: string;
        action: string;
        grant_id: string;
        grant_version?: number;
      }[] = JSON.parse(c.dependencies);
      // READ dependencies retain the actual task grant; losing any relied-on grant freezes mixed history.
      const grant = this.store.get<any>(
        'SELECT actions,version FROM grants WHERE id=?',
        access.grant_id,
      )!;
      const dependedAction = action === 'READ' ? JSON.parse(grant.actions)[0] : action;
      if (!deps.some((x) => x.grant_id === access.grant_id && x.action === dependedAction))
        deps.push({
          ticket_id: t.id,
          action: dependedAction,
          grant_id: access.grant_id,
          grant_version: grant.version,
        });
      this.store.run(
        'UPDATE conversations SET dependencies=? WHERE id=?',
        JSON.stringify(deps),
        c.id,
      );
    }
  }
}
