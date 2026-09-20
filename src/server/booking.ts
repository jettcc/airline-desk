import { timingSafeEqual } from 'node:crypto';
import { Store, id, hash, canonical } from './db.js';
import { Identity } from './identity.js';
import { PolicyRegistry } from './policies.js';
import { AppError, ensure, unavailable } from './errors.js';
import { type Clock, DAY, QUOTE_TTL, creditUsable, timestamp } from '../domain/time.js';
import { nano } from '../domain/money.js';
import { combineDecisions, evaluateTicket, totalLines, emptyDecision } from '../domain/rules.js';
import type {
  Action,
  Context,
  Decision,
  Offer,
  OperationRequest,
  Quote,
  Ticket,
} from '../domain/types.js';
export interface Hooks {
  afterReceipt?: () => Promise<void>;
  fault?: (point: string) => void;
}
export class BookingService {
  lifecycle?: {
    assertReady(tickets: Ticket[]): void;
    committed(operation: any): void;
    reviewCreated(review: any): void;
    operationView(ctx: Context, operationId: string): any;
    caseView(ctx: Context, caseId: string): any;
  };
  constructor(
    public store: Store,
    public identity: Identity,
    public policies: PolicyRegistry,
    public clock: Clock,
    private hooks: Hooks = {},
  ) {}
  list(ctx: Context, conversationId?: string) {
    this.identity.assertContext(ctx, true);
    if (conversationId) this.identity.conversation(ctx, conversationId);
    const tickets = this.store
      .all<any>('SELECT data FROM tickets ORDER BY booking_id,id')
      .map((r) => JSON.parse(r.data) as Ticket)
      .filter((t) => this.identity.authorized(ctx, t, 'READ'));
    if (conversationId)
      for (const t of tickets) this.identity.bindTicket(ctx, conversationId, t, 'READ');
    return tickets.map((t) => ({ ...t, allowed_actions: this.identity.scope(ctx, t) }));
  }
  options(
    ctx: Context,
    ticketId: string,
    date?: string,
    conversationId?: string,
    action: Action = 'CHANGE',
  ) {
    ensure(action === 'CHANGE' || action === 'DISRUPTION_CHANGE', 'INVALID_ACTION');
    const t = this.identity.ticket(ctx, ticketId, action);
    if (conversationId) this.identity.bindTicket(ctx, conversationId, t, action);
    if (date) ensure(/^\d{4}-\d{2}-\d{2}$/.test(date), 'DATE_MUST_BE_UTC_DAY');
    const offers = this.store
      .all<any>('SELECT data FROM offers')
      .map((r) => JSON.parse(r.data) as Offer)
      .filter(
        (o) =>
          o.airline === t.airline &&
          o.departure_at_ms > this.clock.now() &&
          (!date || new Date(o.departure_at_ms).toISOString().slice(0, 10) === date),
      );
    return {
      ticket_id: t.id,
      action,
      segments: t.segments
        .filter((s) => s.state !== 'USED')
        .map((s) => ({
          segment_id: s.id,
          offers: offers
            .filter((o) => o.origin === s.origin && o.destination === s.destination)
            .map((o) => ({
              ...o,
              seats_available:
                this.store.get<any>(
                  'SELECT capacity-occupied AS seats FROM inventory WHERE flight_id=?',
                  o.flight_id,
                )?.seats ?? 0,
            })),
        })),
    };
  }
  groupOptions(
    ctx: Context,
    ticketIds: string[],
    date: string | undefined,
    conversationId: string,
    action: Action,
  ) {
    return this.store.tx(() => {
      this.facts(ctx, {
        action,
        targets: ticketIds.map((ticket_id) => ({ ticket_id, replacements: [], segment_ids: [] })),
      });
      return {
        action,
        tickets: ticketIds.map((id) => this.options(ctx, id, date, conversationId, action)),
      };
    });
  }
  facts(ctx: Context, request: OperationRequest) {
    ensure(
      request.targets.length > 0 &&
        request.targets.length <= 10 &&
        new Set(request.targets.map((t) => t.ticket_id)).size === request.targets.length,
      'INVALID_TARGETS',
    );
    const tickets = request.targets.map((t) =>
      this.identity.ticket(ctx, t.ticket_id, request.action),
    );
    ensure(
      new Set(tickets.map((t) => t.booking_id)).size === 1 &&
        new Set(tickets.map((t) => t.airline)).size === 1,
      'ONE_BOOKING_PER_OPERATION',
    );
    const offerIds = [
      ...new Set(request.targets.flatMap((t) => t.replacements.map((r) => r.offer_id))),
    ];
    const offers = offerIds.map((offerId) => {
      const row = this.store.get<any>('SELECT data FROM offers WHERE id=?', offerId);
      ensure(row, 'OFFER_NOT_FOUND', 409);
      return JSON.parse(row.data) as Offer;
    });
    return { tickets, offers };
  }
  decide(ctx: Context, request: OperationRequest, at: number) {
    const { tickets, offers } = this.facts(ctx, request),
      bundle = this.policies.select(tickets[0].airline, at);
    this.lifecycle?.assertReady(tickets);
    const decision = combineDecisions(
      tickets.map((t) =>
        evaluateTicket(
          t,
          request.action,
          request.targets.find((x) => x.ticket_id === t.id)!,
          offers,
          at,
          bundle.rules,
        ),
      ),
    );
    return { tickets, offers, bundle, decision };
  }
  invalidate(ctx: Context, conversationId: string, ownTurn?: string) {
    this.store.tx(() => {
      const c = this.identity.conversation(ctx, conversationId);
      ensure(!c.busy_turn_id || c.busy_turn_id === ownTurn, 'CONVERSATION_BUSY', 409);
      this.store.run(
        "UPDATE quotes SET status='SUPERSEDED' WHERE conversation_id=? AND status='ACTIVE'",
        c.id,
      );
      this.store.run(
        'UPDATE conversations SET active_quote_id=NULL,intent_version=intent_version+1 WHERE id=?',
        c.id,
      );
    });
  }
  quote(
    ctx: Context,
    conversationId: string,
    request: OperationRequest,
    ownTurn?: string,
  ): { decision: Decision; quote?: Quote; bundle_id: string } {
    return this.store.tx(() => {
      this.identity.assertContext(ctx, true);
      const c = this.identity.conversation(ctx, conversationId);
      ensure(!c.busy_turn_id || c.busy_turn_id === ownTurn, 'CONVERSATION_BUSY', 409);
      const now = this.clock.now(),
        { tickets, offers, bundle, decision } = this.decide(ctx, request, now);
      for (const t of tickets) this.identity.bindTicket(ctx, conversationId, t, request.action);
      // A newly chosen business target replaces the previous confirmable intent, including rejected replacements.
      this.invalidate(ctx, conversationId, ownTurn);
      if (decision.status !== 'ALLOWED') return { decision, bundle_id: bundle.id };
      this.checkInventory(tickets, request, offers);
      const c2 = this.identity.conversation(ctx, conversationId);
      const q: Quote = {
        id: id('quote'),
        actor_id: ctx.actor_id!,
        session_id: ctx.session_id,
        conversation_id: conversationId,
        intent_version: c2.intent_version,
        request,
        decision,
        ticket_versions: Object.fromEntries(tickets.map((t) => [t.id, t.version])),
        offer_versions: Object.fromEntries(offers.map((o) => [o.id, o.version])),
        bundle_id: bundle.id,
        created_at_ms: now,
        expires_at_ms: now + QUOTE_TTL,
        confirmation_token: id('confirm'),
        status: 'ACTIVE',
        display: { tickets, offers },
      };
      this.store.run(
        'INSERT INTO quotes VALUES (?,?,?,?,?,?)',
        q.id,
        q.actor_id,
        q.session_id,
        conversationId,
        q.status,
        JSON.stringify(q),
      );
      this.store.run('UPDATE conversations SET active_quote_id=? WHERE id=?', q.id, conversationId);
      return { decision, quote: q, bundle_id: bundle.id };
    });
  }
  getQuote(ctx: Context, quoteId: string, requireSession = true): Quote {
    this.identity.assertContext(ctx, true);
    const row = this.store.get<any>('SELECT * FROM quotes WHERE id=?', quoteId);
    if (!row || row.actor_id !== ctx.actor_id) throw unavailable();
    const q: Quote = { ...JSON.parse(row.data), status: row.status };
    this.identity.conversation(ctx, q.conversation_id);
    if (requireSession) ensure(q.session_id === ctx.session_id, 'QUOTE_SESSION_CHANGED', 409);
    for (const t of q.request.targets) this.identity.ticket(ctx, t.ticket_id, q.request.action);
    return q;
  }
  checkInventory(tickets: Ticket[], request: OperationRequest, offers: Offer[]) {
    const deltas = new Map<string, number>();
    const delta = (flight: string, n: number) => deltas.set(flight, (deltas.get(flight) ?? 0) + n);
    if (request.action === 'CHANGE' || request.action === 'DISRUPTION_CHANGE')
      for (const target of request.targets)
        for (const r of target.replacements) {
          const old = this.store.get<any>(
            'SELECT flight_id FROM reservations WHERE ticket_id=? AND segment_id=?',
            target.ticket_id,
            r.segment_id,
          );
          if (old) delta(old.flight_id, -1);
          const offer = offers.find((o) => o.id === r.offer_id);
          ensure(offer, 'OFFER_NOT_FOUND', 409);
          delta(offer.flight_id, 1);
        }
    if (request.action === 'CANCEL' || request.action === 'DISRUPTION_REFUND')
      for (const t of tickets)
        for (const row of this.store.all<any>(
          'SELECT flight_id FROM reservations WHERE ticket_id=?',
          t.id,
        ))
          delta(row.flight_id, -1);
    for (const [flight, n] of deltas) {
      const inv = this.store.get<any>('SELECT * FROM inventory WHERE flight_id=?', flight);
      ensure(
        inv && inv.occupied + n >= 0 && inv.occupied + n <= inv.capacity,
        'SEATS_UNAVAILABLE',
        409,
      );
    }
    return deltas;
  }
  async confirm(
    ctx: Context,
    quoteId: string,
    token: string,
    key: string,
    receivedAt = this.clock.now(),
  ) {
    ensure(
      typeof key === 'string' && key.length >= 8 && key.length <= 160,
      'INVALID_IDEMPOTENCY_KEY',
    );
    const contentHash = hash(canonical({ quoteId, token }));
    const admission = this.store.tx(() => {
      this.identity.assertContext(ctx, true);
      const existing = this.store.get<any>(
        'SELECT * FROM submissions WHERE actor_id=? AND idempotency_key=?',
        ctx.actor_id,
        key,
      );
      if (existing) {
        ensure(existing.content_hash === contentHash, 'IDEMPOTENCY_KEY_REUSED', 409);
        this.getQuote(ctx, existing.quote_id, false);
        return { existing: true, submission: existing };
      }
      const q = this.getQuote(ctx, quoteId),
        c = this.identity.conversation(ctx, q.conversation_id);
      ensure(!c.busy_turn_id, 'CONVERSATION_BUSY', 409);
      ensure(
        Buffer.byteLength(token) === Buffer.byteLength(q.confirmation_token) &&
          timingSafeEqual(Buffer.from(token), Buffer.from(q.confirmation_token)),
        'CONFIRMATION_REQUIRED',
        403,
      );
      const done = this.store.get<any>('SELECT id FROM operations WHERE quote_id=?', q.id);
      if (done) return { existing: true, operationId: done.id };
      const pending = this.store.get<any>(
        "SELECT * FROM submissions WHERE quote_id=? AND state='RECEIVED'",
        q.id,
      );
      if (pending) return { existing: true, submission: pending };
      ensure(
        q.status === 'ACTIVE' &&
          c.active_quote_id === q.id &&
          c.intent_version === q.intent_version,
        'QUOTE_SUPERSEDED',
        409,
      );
      ensure(receivedAt >= q.created_at_ms && receivedAt < q.expires_at_ms, 'QUOTE_EXPIRED', 409);
      ensure(
        this.store.get<any>("SELECT value FROM meta WHERE key='generation'")?.value ===
          this.store.generation,
        'SERVICE_GENERATION_CHANGED',
        409,
      );
      const s = {
        id: id('submission'),
        actor_id: ctx.actor_id!,
        idempotency_key: key,
        content_hash: contentHash,
        quote_id: q.id,
        received_at_ms: receivedAt,
        generation: this.store.generation,
        state: 'RECEIVED',
        operation_id: null,
        error_code: null,
      };
      this.store.run(
        'INSERT INTO submissions VALUES (?,?,?,?,?,?,?,?,?,?)',
        s.id,
        s.actor_id,
        s.idempotency_key,
        s.content_hash,
        s.quote_id,
        s.received_at_ms,
        s.generation,
        s.state,
        null,
        null,
      );
      return { existing: false, submission: s };
    });
    if (admission.operationId)
      return { state: 'SUCCEEDED', operation: this.operation(ctx, admission.operationId) };
    const s = admission.submission!;
    if (admission.existing) return this.submissionView(ctx, s);
    // Test barriers are injected only by trusted test constructors; no network endpoint can supply them.
    if (this.hooks.afterReceipt) await this.hooks.afterReceipt();
    this.hooks.fault?.('after_receipt');
    let operationId: string;
    try {
      operationId = this.store.tx(() => {
        ensure(
          this.store.get<any>("SELECT value FROM meta WHERE key='generation'")?.value ===
            s.generation,
          'SERVICE_GENERATION_CHANGED',
          409,
        );
        const current = this.store.get<any>('SELECT * FROM submissions WHERE id=?', s.id);
        ensure(current?.state === 'RECEIVED', 'SUBMISSION_TERMINAL', 409);
        const q = this.getQuote(ctx, quoteId),
          c = this.identity.conversation(ctx, q.conversation_id);
        ensure(!c.busy_turn_id, 'CONVERSATION_BUSY', 409);
        ensure(
          q.status === 'ACTIVE' &&
            c.active_quote_id === q.id &&
            c.intent_version === q.intent_version,
          'QUOTE_SUPERSEDED',
          409,
        );
        const { tickets, offers, bundle, decision } = this.decide(ctx, q.request, s.received_at_ms);
        ensure(bundle.id === q.bundle_id, 'POLICY_CHANGED', 409);
        ensure(
          tickets.every((t) => q.ticket_versions[t.id] === t.version) &&
            offers.every((o) => q.offer_versions[o.id] === o.version),
          'FACTS_CHANGED',
          409,
        );
        ensure(
          decision.status === 'ALLOWED' && canonical(decision) === canonical(q.decision),
          'QUOTE_REQUIRES_REFRESH',
          409,
        );
        const inventory = this.checkInventory(tickets, q.request, offers),
          opId = id('operation'),
          committedAt = this.clock.now();
        // Recheck expiry at the transaction decision point, after pure calculation and before writes.
        this.identity.assertContext(ctx, true);
        for (const t of tickets)
          ensure(this.identity.authorized(ctx, t, q.request.action), 'AUTHORIZATION_CHANGED', 403);
        const operation = {
          id: opId,
          actor_id: ctx.actor_id,
          quote_id: q.id,
          action: q.request.action,
          bundle_id: bundle.id,
          created_at_ms: committedAt,
          received_at_ms: s.received_at_ms,
          lines: decision.lines,
          totals: decision.totals,
          tickets: [] as Ticket[],
          before_versions: q.ticket_versions,
          sources: decision.sources,
          simulated: true,
        };
        this.store.run(
          'INSERT INTO operations VALUES (?,?,?,?,?)',
          opId,
          ctx.actor_id,
          q.id,
          committedAt,
          JSON.stringify(operation),
        );
        for (const [flight, n] of inventory)
          this.store.run('UPDATE inventory SET occupied=occupied+? WHERE flight_id=?', n, flight);
        for (const t of tickets) {
          const target = q.request.targets.find((x) => x.ticket_id === t.id)!;
          if (q.request.action === 'CHANGE' || q.request.action === 'DISRUPTION_CHANGE') {
            for (const r of target.replacements) {
              const seg = t.segments.find((x) => x.id === r.segment_id)!,
                o = offers.find((x) => x.id === r.offer_id)!;
              this.store.run(
                'INSERT OR REPLACE INTO reservations VALUES (?,?,?)',
                t.id,
                seg.id,
                o.flight_id,
              );
              // Free protection retains the paid entitlement; the replacement's retail price is not a new payment.
              if (q.request.action === 'CHANGE') {
                if (nano(o.fare) < nano(seg.fare!)) t.historical_value_unclear = true;
                seg.fare = o.fare;
                seg.tax = o.tax;
              }
              seg.flight_id = o.flight_id;
              seg.departure_at_ms = o.departure_at_ms;
              seg.arrival_at_ms = o.arrival_at_ms;
              seg.state = 'UNUSED';
              t.fare_type = o.fare_type;
            }
            t.state = 'ACTIVE';
          } else if (q.request.action === 'CANCEL' || q.request.action === 'DISRUPTION_REFUND') {
            t.state = 'CANCELLED';
            this.store.run('DELETE FROM reservations WHERE ticket_id=?', t.id);
            this.consume(`${t.id}:fare`, t.id, 'CLOSE_TICKET', opId);
          }
          for (const l of decision.lines.filter((l) => l.ticket_id === t.id)) {
            if (
              l.kind === 'TAX' &&
              l.direction === 'REFUND' &&
              !l.entitlement_id.endsWith(':tax-adjustment')
            ) {
              const segment = t.segments.find((s) => s.id === l.segment_id)!;
              ensure(!segment.tax_refunded, 'ENTITLEMENT_ALREADY_CONSUMED', 409);
              segment.tax_refunded = true;
              this.consume(l.entitlement_id, t.id, 'REFUND', opId);
            }
            if (l.kind === 'EXTRA') {
              const e = t.extras.find((e) => e.id === l.entitlement_id)!;
              if (l.direction === 'REFUND') e.refunded = true;
              this.consume(e.id, t.id, 'CLOSE_EXTRA', opId);
            }
          }
          if (q.request.action.startsWith('DISRUPTION')) {
            ensure(t.disruption && !t.disruption.consumed, 'ENTITLEMENT_ALREADY_CONSUMED', 409);
            this.consume(t.disruption.id, t.id, 'DISRUPTION_CHOICE', opId);
            t.disruption.consumed = true;
          }
          t.version++;
          ensure(
            this.store.run(
              'UPDATE tickets SET version=?,data=? WHERE id=? AND version=?',
              t.version,
              JSON.stringify(t),
              t.id,
              q.ticket_versions[t.id],
            ).changes === 1,
            'FACTS_CHANGED',
            409,
          );
          operation.tickets.push(t);
          this.hooks.fault?.('after_ticket');
        }
        this.hooks.fault?.('before_ledger');
        for (const line of decision.lines) {
          this.store.run(
            'INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?)',
            id('ledger'),
            opId,
            line.ticket_id,
            line.kind,
            line.direction,
            line.amount.currencyCode,
            line.amount.units,
            line.amount.nanos,
            JSON.stringify(line),
          );
          if (line.direction === 'CREDIT' && nano(line.amount) > 0n) {
            const t = tickets.find((t) => t.id === line.ticket_id)!;
            this.store.run(
              'INSERT INTO credits VALUES (?,?,?,?,?,?,?,?,?,?)',
              id('credit'),
              opId,
              t.id,
              t.traveler_id,
              t.airline,
              committedAt,
              committedAt + 365 * DAY,
              line.amount.currencyCode,
              line.amount.units,
              line.amount.nanos,
            );
          }
        }
        this.hooks.fault?.('necessary_record');
        this.store.run('UPDATE operations SET data=? WHERE id=?', JSON.stringify(operation), opId);
        this.lifecycle?.committed(operation);
        this.store.run("UPDATE quotes SET status='CONSUMED' WHERE id=?", q.id);
        this.store.run(
          'UPDATE conversations SET active_quote_id=NULL WHERE id=?',
          q.conversation_id,
        );
        this.store.run(
          "UPDATE submissions SET state='SUCCEEDED',operation_id=? WHERE id=?",
          opId,
          s.id,
        );
        this.hooks.fault?.('before_commit');
        return opId;
      });
    } catch (error) {
      // A COMMIT-side fault is resolved from the authoritative operation, never guessed from the exception.
      const op = this.store.get<any>('SELECT id FROM operations WHERE quote_id=?', quoteId);
      if (op) {
        this.store.tx(() =>
          this.store.run(
            "UPDATE submissions SET state='SUCCEEDED',operation_id=? WHERE id=?",
            op.id,
            s.id,
          ),
        );
        return { state: 'SUCCEEDED', submission_id: s.id, operation: this.operation(ctx, op.id) };
      }
      const code = error instanceof AppError ? error.code : 'SUBMISSION_FAILED';
      this.store.tx(() => {
        this.store.run(
          "UPDATE submissions SET state='REJECTED',error_code=? WHERE id=? AND state='RECEIVED' AND generation=?",
          code,
          s.id,
          this.store.generation,
        );
        this.store.run(
          "UPDATE quotes SET status='SUPERSEDED' WHERE id=? AND status='ACTIVE'",
          quoteId,
        );
        this.store.run(
          'UPDATE conversations SET active_quote_id=NULL WHERE active_quote_id=?',
          quoteId,
        );
      });
      return { state: 'REJECTED', submission_id: s.id, error: code };
    }
    this.hooks.fault?.('after_commit');
    return { state: 'SUCCEEDED', submission_id: s.id, operation: this.operation(ctx, operationId) };
  }
  private consume(entitlement: string, ticketId: string, kind: string, opId: string) {
    ensure(
      !this.store.get(
        'SELECT 1 FROM consumptions WHERE entitlement_id=? AND kind=?',
        entitlement,
        kind,
      ),
      'ENTITLEMENT_ALREADY_CONSUMED',
      409,
    );
    this.store.run('INSERT INTO consumptions VALUES (?,?,?,?)', entitlement, ticketId, kind, opId);
  }
  submissionView(ctx: Context, s: any): any {
    this.identity.assertContext(ctx, true);
    if (s.actor_id !== ctx.actor_id) throw unavailable();
    if (s.operation_id)
      return {
        state: 'SUCCEEDED',
        submission_id: s.id,
        operation: this.operation(ctx, s.operation_id),
      };
    this.getQuote(ctx, s.quote_id, false);
    return { state: s.state, submission_id: s.id, error: s.error_code ?? null };
  }
  submission(ctx: Context, key: string) {
    this.identity.assertContext(ctx, true);
    const s = this.store.get<any>(
      'SELECT * FROM submissions WHERE actor_id=? AND (id=? OR idempotency_key=?)',
      ctx.actor_id,
      key,
      key,
    );
    if (!s) return { state: 'UNKNOWN', message: '尚未核实，请使用原请求编号继续查询。' };
    return this.submissionView(ctx, s);
  }
  operation(ctx: Context, operationId: string) {
    this.identity.assertContext(ctx, true);
    const row = this.store.get<any>('SELECT data FROM operations WHERE id=?', operationId);
    if (!row) throw unavailable();
    const op = JSON.parse(row.data),
      visible = (op.tickets as Ticket[]).filter((t) => {
        try {
          return !!this.identity.ticket(ctx, t.id, 'READ');
        } catch {
          return false;
        }
      });
    if (!visible.length) throw unavailable();
    const ids = new Set(visible.map((t) => t.id)),
      lines = op.lines.filter((l: any) => ids.has(l.ticket_id));
    return {
      id: op.id,
      action: op.action,
      created_at_ms: op.created_at_ms,
      received_at_ms: op.received_at_ms,
      bundle_id: op.bundle_id,
      tickets: visible,
      lines,
      totals: totalLines(lines),
      simulated: true,
      credits: this.store
        .all<any>('SELECT * FROM credits WHERE operation_id=?', op.id)
        .filter((c) => ids.has(c.ticket_id))
        .map(({ id, ticket_id, airline, issued_at_ms, expires_at_ms, currency, units, nanos }) => ({
          id,
          ticket_id,
          airline,
          issued_at_ms,
          expires_at_ms,
          amount: { currencyCode: currency, units, nanos },
        })),
      sources: [...new Map(op.sources.map((s: any) => [canonical(s), s])).values()],
      service_tracking: this.lifecycle?.operationView(ctx, op.id),
    };
  }
  records(ctx: Context) {
    this.identity.assertContext(ctx, true);
    const ops = [];
    for (const row of this.store.all<any>(
      'SELECT id FROM operations ORDER BY created_at_ms DESC LIMIT 100',
    ))
      try {
        ops.push(this.operation(ctx, row.id));
      } catch {}
    return ops;
  }
  checkCredit(ctx: Context, creditId: string, airline: string, departure: number) {
    this.identity.assertContext(ctx, true);
    timestamp(departure);
    const credit = this.store.get<any>('SELECT * FROM credits WHERE id=?', creditId);
    if (!credit) throw unavailable();
    this.identity.ticket(ctx, credit.ticket_id, 'READ');
    return {
      id: credit.id,
      ticket_id: credit.ticket_id,
      airline: credit.airline,
      issued_at_ms: credit.issued_at_ms,
      expires_at_ms: credit.expires_at_ms,
      requested_airline: airline,
      requested_departure_at_ms: departure,
      usable_for_named_traveler:
        airline === credit.airline &&
        creditUsable(credit.issued_at_ms, this.clock.now(), departure),
      amount: { currencyCode: credit.currency, units: credit.units, nanos: credit.nanos },
      redemption_supported: false,
    };
  }
  createReview(
    ctx: Context,
    conversationId: string,
    key: string,
    request: OperationRequest | null,
    claim?: string,
  ) {
    return this.store.tx(() => {
      this.identity.assertContext(ctx, true);
      this.identity.conversation(ctx, conversationId);
      ensure(key.length >= 8 && key.length <= 160, 'INVALID_REQUEST_KEY');
      const digest = hash(canonical({ request, claim: claim ?? null }));
      const old = this.store.get<any>(
        'SELECT * FROM review_cases WHERE applicant_id=? AND request_key=?',
        ctx.actor_id,
        key,
      );
      if (old) {
        ensure(old.content_hash === digest, 'IDEMPOTENCY_KEY_REUSED', 409);
        return this.review(ctx, old.id);
      }
      let decision: Decision | undefined, bundleId: string | undefined;
      let ticketVersions: Record<string, number> = {};
      if (request) {
        const d = this.decide(ctx, request, this.clock.now());
        decision = d.decision;
        bundleId = d.bundle.id;
        ticketVersions = Object.fromEntries(d.tickets.map((t) => [t.id, t.version]));
        ensure(decision.status === 'MANUAL_REVIEW', 'REVIEW_NOT_REQUIRED');
        for (const t of d.tickets) this.identity.bindTicket(ctx, conversationId, t, request.action);
      } else
        ensure(
          typeof claim === 'string' && claim.length >= 1 && claim.length <= 500,
          'REVIEW_REASON_REQUIRED',
        );
      const data = {
        id: id('review'),
        status: 'RECORDED_AWAITING_REVIEW',
        type: request ? 'BUSINESS' : 'AUTHORIZATION',
        amount: { status: 'UNKNOWN', value: null },
        request,
        claim: request ? null : claim,
        decision,
        bundle_id: bundleId,
        conversation_id: conversationId,
        turn_id: this.identity.conversation(ctx, conversationId).busy_turn_id ?? null,
        ticket_versions: ticketVersions,
        previous_case_id:
          this.store.get<any>(
            'SELECT id FROM review_cases WHERE applicant_id=? AND content_hash=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 1',
            ctx.actor_id,
            digest,
          )?.id ?? null,
        created_at_ms: this.clock.now(),
        simulated: true,
      };
      this.store.run(
        'INSERT INTO review_cases VALUES (?,?,?,?,?,?)',
        data.id,
        ctx.actor_id,
        key,
        digest,
        data.created_at_ms,
        JSON.stringify(data),
      );
      this.lifecycle?.reviewCreated(data);
      return this.review(ctx, data.id);
    });
  }
  createExceptionReview(
    ctx: Context,
    conversationId: string,
    key: string,
    reason: 'MEDICAL' | 'GUARDIANSHIP' | 'OWNERSHIP',
    ticketIds: string[],
  ) {
    return this.store.tx(() => {
      this.identity.assertContext(ctx, true);
      const conversation = this.identity.conversation(ctx, conversationId);
      ensure(
        ['MEDICAL', 'GUARDIANSHIP', 'OWNERSHIP'].includes(reason) &&
          key.length >= 8 &&
          key.length <= 160,
        'INVALID_INPUT',
      );
      ensure(
        reason === 'MEDICAL'
          ? ticketIds.length > 0 && ticketIds.length <= 10
          : ticketIds.length === 0,
        'INVALID_TARGETS',
      );
      const digest = hash(canonical({ reason, ticketIds }));
      const old = this.store.get<any>(
        'SELECT * FROM review_cases WHERE applicant_id=? AND request_key=?',
        ctx.actor_id,
        key,
      );
      if (old) {
        ensure(old.content_hash === digest, 'IDEMPOTENCY_KEY_REUSED', 409);
        return this.review(ctx, old.id);
      }
      // A self-declared exception is never an approved policy fact. Guardianship
      // and disputed authority records deliberately do not look up private tickets.
      const tickets = ticketIds.map((tid) => this.identity.ticket(ctx, tid));
      const bundles = tickets.map((t) => this.policies.select(t.airline, this.clock.now()));
      for (const t of tickets) this.identity.bindTicket(ctx, conversationId, t, 'READ');
      const decision = emptyDecision('MANUAL_REVIEW', `${reason}_EVIDENCE_REVIEW`);
      decision.sources = tickets.map((t) => ({
        airline: t.airline,
        section: '9',
        page: 6,
        rule_id: `${t.airline}:9`,
      }));
      const data = {
        id: id('review'),
        status: 'RECORDED_AWAITING_REVIEW',
        type: reason,
        amount: { status: 'UNKNOWN', value: null },
        decision,
        request: null,
        protected_ticket_ids: ticketIds,
        declaration_verified: false,
        conversation_id: conversationId,
        turn_id: conversation.busy_turn_id ?? null,
        ticket_versions: Object.fromEntries(tickets.map((t) => [t.id, t.version])),
        bundle_id:
          bundles.length && new Set(bundles.map((b) => b.id)).size === 1
            ? bundles[0].id
            : undefined,
        required_information:
          reason === 'MEDICAL'
            ? ['SECURE_CHANNEL_BEFORE_DATED_MEDICAL_EVIDENCE']
            : ['SECURE_MANUAL_IDENTITY_AND_AUTHORITY_VERIFICATION'],
        created_at_ms: this.clock.now(),
        simulated: true,
      };
      this.store.run(
        'INSERT INTO review_cases VALUES (?,?,?,?,?,?)',
        data.id,
        ctx.actor_id,
        key,
        digest,
        data.created_at_ms,
        JSON.stringify(data),
      );
      this.lifecycle?.reviewCreated(data);
      return this.review(ctx, data.id);
    });
  }
  review(ctx: Context, reviewId: string): any {
    this.identity.assertContext(ctx, true);
    const row = this.store.get<any>(
      'SELECT * FROM review_cases WHERE id=? AND applicant_id=?',
      reviewId,
      ctx.actor_id,
    );
    if (!row) throw unavailable();
    const data = JSON.parse(row.data);
    const targets =
      data.request?.targets ??
      (data.protected_ticket_ids ?? []).map((ticket_id: string) => ({ ticket_id }));
    for (const t of targets)
      try {
        this.identity.ticket(ctx, t.ticket_id, data.request?.action ?? 'READ');
      } catch {
        return {
          id: data.id,
          status: data.status,
          created_at_ms: data.created_at_ms,
          restricted: true,
        };
      }
    return { ...data, workflow: this.lifecycle?.caseView(ctx, reviewId) };
  }
  reviews(ctx: Context) {
    this.identity.assertContext(ctx, true);
    return this.store
      .all<any>(
        'SELECT id FROM review_cases WHERE applicant_id=? ORDER BY created_at_ms DESC',
        ctx.actor_id,
      )
      .map((r) => this.review(ctx, r.id));
  }
}
