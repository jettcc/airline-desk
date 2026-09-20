import { Store, id, hash, canonical } from './db.js';
import { Identity } from './identity.js';
import { BookingService } from './booking.js';
import { ensure, unavailable } from './errors.js';
import { SESSION_TTL, HOUR, type Clock } from '../domain/time.js';
import { nano, usd } from '../domain/money.js';
import { totalLines } from '../domain/rules.js';
import type { Context, Ticket, Offer, OperationRequest } from '../domain/types.js';

export const DESK_ACTORS = ['demo-desk-1', 'demo-desk-2'] as const;
export const SAMPLE_ACCESS = [
  { ticket_id: 'CANCEL-NSA-A', code: 'DEMO-CANCEL-42', description: 'Northstar 取消与退款样例' },
  { ticket_id: 'BHA-NEW-A', code: 'DEMO-CHANGE-42', description: 'Bluehaven 改签样例' },
];
export const SERVICE_ACTIONS = [
  'READ',
  'CHANGE',
  'CANCEL',
  'TAX_REFUND',
  'DISRUPTION_CHANGE',
  'DISRUPTION_REFUND',
] as const;
export type CaseAction =
  | 'CLAIM'
  | 'REQUEST_INFO'
  | 'REPLY'
  | 'HANDOFF'
  | 'CHANNEL_REPLY'
  | 'RESOLVE'
  | 'REJECT'
  | 'APPROVE_ACCESS'
  | 'REVOKE_ACCESS';
export type TaskAction = 'ACCEPT' | 'CONFIRM' | 'FAIL' | 'LOSE_REPLY' | 'RECONCILE';

export class ServiceDesk {
  constructor(
    public store: Store,
    public identity: Identity,
    public booking: BookingService,
    public clock: Clock,
  ) {
    store.tx(() => {
      for (const r of store.all<any>('SELECT data FROM review_cases'))
        this.reviewCreated(JSON.parse(r.data));
    });
  }
  isDesk(ctx: Context) {
    return DESK_ACTORS.includes(ctx.actor_id as any);
  }
  operator(ctx: Context) {
    this.identity.assertContext(ctx, true);
    ensure(this.isDesk(ctx), 'SERVICE_OPERATOR_REQUIRED', 403);
  }
  private customer(ctx: Context) {
    this.identity.assertContext(ctx, true);
    ensure(!this.isDesk(ctx), 'TRAVELER_ROLE_REQUIRED', 403);
  }
  private command<T>(ctx: Context, key: string, input: unknown, apply: () => T): T {
    this.identity.assertContext(ctx, true);
    ensure(key.length >= 8 && key.length <= 160, 'INVALID_REQUEST_KEY');
    return this.store.tx(() => {
      const digest = hash(canonical(input));
      const previous = this.store.get<any>(
        'SELECT * FROM service_requests WHERE actor_id=? AND request_key=?',
        ctx.actor_id,
        key,
      );
      if (previous) {
        ensure(previous.content_hash === digest, 'IDEMPOTENCY_KEY_REUSED', 409);
        return JSON.parse(previous.result);
      }
      const result = apply();
      this.store.run(
        'INSERT INTO service_requests VALUES (?,?,?,?)',
        ctx.actor_id,
        key,
        digest,
        JSON.stringify(result),
      );
      return result;
    });
  }
  private event(subject: string, version: number, actor: string | null, code: string, note = '') {
    this.store.run(
      'INSERT INTO service_events VALUES (?,?,?,?,?,?)',
      id('event'),
      subject,
      version,
      this.clock.now(),
      actor,
      JSON.stringify({ code, note, simulated: true }),
    );
  }
  private timeline(subject: string) {
    return this.store
      .all<any>(
        'SELECT version,created_at_ms,actor_id,data FROM service_events WHERE subject_id=? ORDER BY version',
        subject,
      )
      .map((r) => ({
        version: r.version,
        at_ms: r.created_at_ms,
        actor:
          r.actor_id && DESK_ACTORS.includes(r.actor_id)
            ? '模拟客服'
            : r.actor_id
              ? '旅客'
              : '模拟渠道',
        ...JSON.parse(r.data),
      }));
  }
  assertReady(tickets: Ticket[]) {
    for (const t of tickets) {
      ensure(t.channel === 'DIRECT', 'CHANNEL_HANDOFF_REQUIRED', 409);
      ensure(
        !this.store.get(
          "SELECT 1 FROM service_tasks WHERE ticket_id=? AND state<>'COMPLETED'",
          t.id,
        ),
        'SERVICE_RESULT_PENDING',
        409,
      );
    }
  }
  committed(operation: any) {
    // Called inside the booking transaction. No network call and no second ledger.
    for (const ticket of operation.tickets as Ticket[]) {
      const totals = totalLines(operation.lines.filter((l: any) => l.ticket_id === ticket.id));
      for (const kind of ['ORDER', ...(nano(totals.refund) > 0n ? ['REFUND'] : [])]) {
        const tid = id('service');
        this.store.run(
          'INSERT INTO service_tasks VALUES (?,?,?,?,?,?,?)',
          tid,
          operation.id,
          ticket.id,
          kind,
          'QUEUED',
          1,
          JSON.stringify({
            created_at_ms: this.clock.now(),
            amount: kind === 'REFUND' ? totals.refund : null,
            receipt: null,
            operation_action: operation.action,
            simulated: true,
          }),
        );
        this.event(tid, 1, null, 'QUEUED');
      }
    }
  }
  private visible(ctx: Context, ticketId: string) {
    try {
      this.identity.ticket(ctx, ticketId, 'READ');
      return true;
    } catch {
      return false;
    }
  }
  private taskView(row: any) {
    return {
      id: row.id,
      operation_id: row.operation_id,
      ticket_id: row.ticket_id,
      kind: row.kind,
      state: row.state,
      version: row.version,
      ...JSON.parse(row.data),
      owner: '模拟出票渠道 / 模拟客服',
      next_step:
        row.state === 'COMPLETED'
          ? '已收到模拟完成回执，可核对凭证。'
          : ['UNKNOWN', 'FAILED'].includes(row.state)
            ? '客服需查询原请求并核对渠道结果；不要再次办理或重复退款。'
            : row.kind === 'REFUND'
              ? '等待订单处理完成，再由模拟渠道受理并确认退款结果；未承诺到账时间。'
              : '等待模拟渠道受理和完成回执；本地账目登记不代表真实出票。',
      timeline: this.timeline(row.id),
    };
  }
  operationView(ctx: Context, operationId: string) {
    this.identity.assertContext(ctx, true);
    const tasks = this.store
      .all<any>('SELECT * FROM service_tasks WHERE operation_id=? ORDER BY rowid', operationId)
      .filter((t) => this.visible(ctx, t.ticket_id))
      .map((t) => this.taskView(t));
    return {
      mode: 'SIMULATION',
      state: !tasks.length
        ? 'LEGACY_LOCAL_ONLY'
        : tasks.every((t) => t.state === 'COMPLETED')
          ? 'COMPLETED'
          : 'PENDING',
      tasks,
    };
  }
  reviewCreated(review: any) {
    if (this.store.get('SELECT 1 FROM service_cases WHERE case_id=?', review.id)) return;
    this.store.run(
      'INSERT INTO service_cases VALUES (?,?,?,?,?)',
      review.id,
      'NEW',
      1,
      null,
      JSON.stringify({ created_at_ms: this.clock.now(), resolution: null, simulated: true }),
    );
    this.event(review.id, 1, null, 'NEW', '已进入本地模拟服务队列，尚未接单。');
  }
  private accessibleCase(ctx: Context, caseId: string) {
    this.identity.assertContext(ctx, true);
    const r = this.store.get<any>(
      'SELECT r.*,c.state AS workflow_state,c.version,c.owner,c.data AS workflow FROM review_cases r JOIN service_cases c ON c.case_id=r.id WHERE r.id=?',
      caseId,
    );
    if (!r || (!this.isDesk(ctx) && r.applicant_id !== ctx.actor_id)) throw unavailable();
    if (!this.isDesk(ctx)) {
      const original = JSON.parse(r.data);
      for (const t of original.request?.targets ??
        (original.protected_ticket_ids ?? []).map((ticket_id: string) => ({ ticket_id })))
        this.identity.ticket(ctx, t.ticket_id, original.request?.action ?? 'READ');
    }
    return r;
  }
  caseView(ctx: Context, caseId: string): any {
    const r = this.accessibleCase(ctx, caseId),
      original = JSON.parse(r.data);
    const access = this.store.get<any>(
      'SELECT ticket_id,actions,expires_at_ms,grant_id FROM service_access WHERE case_id=?',
      caseId,
    );
    return {
      id: r.id,
      type: original.type,
      state: r.workflow_state,
      version: r.version,
      owner: r.owner ? '模拟客服 ' + r.owner.slice(-1) : '待接单',
      created_at_ms: original.created_at_ms,
      amount: original.amount,
      summary: original.claim ?? original.decision?.reasons?.join(' / ') ?? original.type,
      protected_ticket_ids:
        original.protected_ticket_ids ??
        original.request?.targets?.map((t: any) => t.ticket_id) ??
        [],
      ...(access
        ? {
            access: {
              ...access,
              actions: JSON.parse(access.actions),
              currently_authorized: this.visible(ctx, access.ticket_id),
            },
          }
        : {}),
      ...JSON.parse(r.workflow),
      timeline: this.timeline(caseId),
      next_step: (
        {
          NEW: '等待模拟客服接单。',
          IN_REVIEW: '客服正在核对；金额和办理资格仍以政策和已核验事实为准。',
          NEEDS_INFO: '请通过此处补充非敏感说明；不要提交证件或医疗原件。',
          WAITING_CHANNEL: '已转交模拟出票渠道，等待回复；尚未批准或退款。',
          RESOLVED: access
            ? this.clock.now() >= access.expires_at_ms
              ? '样例授权已到期，请重新提交核验申请；旧授权不能继续办理。'
              : '样例客票授权已建立，先查票，再获取新报价并另行确认。'
            : '咨询已答复；此状态不表示批准退款或免除费用。',
          REJECTED: '申请未通过；查看时间线中的理由，需要时可重新申请。',
          ACCESS_REVOKED: '样例授权已撤销，旧报价和相关业务历史不可继续使用。',
        } as Record<string, string>
      )[r.workflow_state],
    };
  }
  tasks(ctx: Context) {
    this.identity.assertContext(ctx, true);
    return this.store
      .all<any>("SELECT * FROM service_tasks ORDER BY (state='COMPLETED'), rowid DESC")
      .filter((t) => this.isDesk(ctx) || this.visible(ctx, t.ticket_id))
      .slice(0, 300)
      .map((t) => this.taskView(t));
  }
  center(ctx: Context) {
    this.customer(ctx);
    const cases = this.store
      .all<any>(
        'SELECT id FROM review_cases WHERE applicant_id=? ORDER BY created_at_ms DESC LIMIT 100',
        ctx.actor_id,
      )
      .flatMap((r) => {
        try {
          return [this.caseView(ctx, r.id)];
        } catch {
          return [{ id: r.id, restricted: true }];
        }
      });
    const alerts = this.store
      .all<any>('SELECT * FROM service_alerts ORDER BY created_at_ms DESC')
      .filter((r) => this.visible(ctx, r.ticket_id))
      .slice(0, 100)
      .map((r) => ({
        id: r.id,
        ticket_id: r.ticket_id,
        at_ms: r.created_at_ms,
        ...JSON.parse(r.data),
      }));
    return {
      simulated: true,
      scope: 'DIRECT_SAMPLE_CHANNEL',
      tasks: this.tasks(ctx),
      cases,
      alerts,
    };
  }
  dashboard(ctx: Context) {
    this.operator(ctx);
    return {
      simulated: true,
      tasks: this.tasks(ctx),
      cases: this.store
        .all<any>('SELECT case_id FROM service_cases ORDER BY rowid DESC LIMIT 100')
        .map((r) => this.caseView(ctx, r.case_id)),
      tickets: this.store.all<any>('SELECT id,version,data FROM tickets').map((r) => {
        const t = JSON.parse(r.data);
        return {
          id: t.id,
          version: t.version,
          channel: t.channel,
          state: t.state,
          can_simulate_delay: !t.disruption,
          segments: t.segments.map((s: any) => ({
            id: s.id,
            state: s.state,
            departure_at_ms: s.departure_at_ms,
            can_simulate_delay: s.departure_at_ms > this.clock.now(),
          })),
        };
      }),
    };
  }
  requestAccess(ctx: Context, key: string, ticketId: string, code: string, actions: string[]) {
    this.customer(ctx);
    ensure(
      this.store.get('SELECT 1 FROM accounts WHERE actor_id=?', ctx.actor_id),
      'REGISTERED_ACCOUNT_REQUIRED',
      403,
    );
    const result = this.command(
      ctx,
      key,
      { action: 'ACCESS_REQUEST', ticketId, code_hash: hash(code), actions },
      () => {
        const sample = SAMPLE_ACCESS.find((t) => t.ticket_id === ticketId);
        ensure(
          sample &&
            hash(sample.code) === hash(code) &&
            actions.includes('READ') &&
            actions.length &&
            actions.every((a) => SERVICE_ACTIONS.includes(a as any)),
          'ACCESS_PROOF_INVALID',
        );
        const existing = this.store.get<any>(
          "SELECT a.case_id,a.actions FROM service_access a JOIN review_cases r ON r.id=a.case_id JOIN service_cases c ON c.case_id=a.case_id WHERE r.applicant_id=? AND a.ticket_id=? AND a.expires_at_ms>? AND c.state NOT IN ('REJECTED','ACCESS_REVOKED') ORDER BY r.created_at_ms DESC LIMIT 1",
          ctx.actor_id,
          ticketId,
          this.clock.now(),
        );
        if (
          existing &&
          canonical(JSON.parse(existing.actions).sort()) === canonical([...new Set(actions)].sort())
        )
          return { id: existing.case_id };
        const rid = id('review'),
          now = this.clock.now();
        const data = {
          id: rid,
          status: 'RECORDED_AWAITING_REVIEW',
          type: 'SAMPLE_ACCESS',
          amount: { status: 'UNKNOWN', value: null },
          request: null,
          created_at_ms: now,
          simulated: true,
        };
        this.store.run(
          'INSERT INTO review_cases VALUES (?,?,?,?,?,?)',
          rid,
          ctx.actor_id,
          key,
          hash(canonical({ ticketId, actions })),
          now,
          JSON.stringify(data),
        );
        this.store.run(
          'INSERT INTO service_access VALUES (?,?,?,?,?,NULL)',
          rid,
          ticketId,
          JSON.stringify([...new Set(actions)]),
          hash(code),
          now + SESSION_TTL,
        );
        this.reviewCreated(data);
        return { id: rid };
      },
    );
    return this.caseView(ctx, result.id);
  }
  requestHelp(ctx: Context, key: string, note: string) {
    this.customer(ctx);
    ensure(note.trim().length > 0 && note.length <= 500, 'SERVICE_NOTE_REQUIRED');
    const result = this.command(ctx, key, { action: 'HELP', note }, () => {
      const rid = id('review'),
        now = this.clock.now();
      const data = {
        id: rid,
        status: 'RECORDED_AWAITING_REVIEW',
        type: 'CONSULTATION',
        request: null,
        amount: { status: 'UNKNOWN', value: null },
        claim: note,
        created_at_ms: now,
        simulated: true,
      };
      this.store.run(
        'INSERT INTO review_cases VALUES (?,?,?,?,?,?)',
        rid,
        ctx.actor_id,
        key,
        hash(note),
        now,
        JSON.stringify(data),
      );
      this.reviewCreated(data);
      return { id: rid };
    });
    return this.caseView(ctx, result.id);
  }
  actCase(
    ctx: Context,
    key: string,
    caseId: string,
    version: number,
    action: CaseAction,
    note: string,
  ) {
    if (action === 'REPLY' || action === 'REVOKE_ACCESS') this.customer(ctx);
    else this.operator(ctx);
    const result = this.command(ctx, key, { caseId, version, action, note }, () => {
      const r = this.accessibleCase(ctx, caseId);
      ensure(r.version === version, 'SERVICE_VERSION_CHANGED', 409);
      let next = r.workflow_state,
        owner = r.owner;
      const workflow = JSON.parse(r.workflow),
        original = JSON.parse(r.data);
      if (action === 'CLAIM') {
        ensure(next === 'NEW' && !owner, 'INVALID_SERVICE_TRANSITION', 409);
        next = 'IN_REVIEW';
        owner = ctx.actor_id;
      } else if (action === 'REPLY') {
        ensure(
          r.applicant_id === ctx.actor_id && next === 'NEEDS_INFO' && note.trim().length > 0,
          'INVALID_SERVICE_TRANSITION',
          409,
        );
        next = 'IN_REVIEW';
      } else if (action === 'REVOKE_ACCESS') {
        ensure(
          r.applicant_id === ctx.actor_id &&
            next === 'RESOLVED' &&
            original.type === 'SAMPLE_ACCESS',
          'INVALID_SERVICE_TRANSITION',
          409,
        );
        const access = this.store.get<any>('SELECT * FROM service_access WHERE case_id=?', caseId)!;
        this.store.run(
          'UPDATE grants SET revoked=1 WHERE id=? AND actor_id=?',
          access.grant_id,
          ctx.actor_id,
        );
        next = 'ACCESS_REVOKED';
      } else {
        ensure(owner === ctx.actor_id, 'CASE_OWNED_BY_ANOTHER_OPERATOR', 409);
        if (action === 'CHANNEL_REPLY') {
          ensure(
            next === 'WAITING_CHANNEL' && note.trim().length > 0,
            'INVALID_SERVICE_TRANSITION',
            409,
          );
          next = 'IN_REVIEW';
        } else {
          ensure(next === 'IN_REVIEW', 'INVALID_SERVICE_TRANSITION', 409);
          if (action === 'APPROVE_ACCESS') {
            ensure(original.type === 'SAMPLE_ACCESS', 'ACCESS_APPROVAL_NOT_APPLICABLE');
            const access = this.store.get<any>(
              'SELECT * FROM service_access WHERE case_id=?',
              caseId,
            )!;
            const sample = SAMPLE_ACCESS.find((t) => t.ticket_id === access.ticket_id);
            ensure(
              sample &&
                access.proof_hash === hash(sample.code) &&
                this.clock.now() < access.expires_at_ms,
              'ACCESS_REQUEST_EXPIRED',
              409,
            );
            const grantId = 'service-grant-' + caseId;
            this.store.run(
              'INSERT INTO grants VALUES (?,?,?,?,?,?,0,1)',
              grantId,
              r.applicant_id,
              access.ticket_id,
              access.actions,
              this.clock.now(),
              access.expires_at_ms,
            );
            this.store.run('UPDATE service_access SET grant_id=? WHERE case_id=?', grantId, caseId);
            next = 'RESOLVED';
            workflow.resolution = 'SAMPLE_ACCESS_GRANTED';
          } else {
            ensure(note.trim().length > 0, 'SERVICE_NOTE_REQUIRED');
            const mapping = {
              REQUEST_INFO: 'NEEDS_INFO',
              HANDOFF: 'WAITING_CHANNEL',
              RESOLVE: 'RESOLVED',
              REJECT: 'REJECTED',
            } as Record<string, string>;
            ensure(mapping[action], 'INVALID_SERVICE_TRANSITION');
            ensure(
              action !== 'RESOLVE' || original.type !== 'SAMPLE_ACCESS',
              'ACCESS_APPROVAL_NOT_APPLICABLE',
            );
            next = mapping[action];
            workflow.resolution =
              action === 'RESOLVE' ? 'GUIDANCE_ONLY_NO_PAYMENT_APPROVAL' : action;
          }
        }
      }
      this.store.run(
        'UPDATE service_cases SET state=?,version=version+1,owner=?,data=? WHERE case_id=?',
        next,
        owner,
        JSON.stringify(workflow),
        caseId,
      );
      this.event(caseId, version + 1, ctx.actor_id, action, note);
      return { id: caseId };
    });
    return this.caseView(ctx, result.id);
  }
  actTask(ctx: Context, key: string, taskId: string, version: number, action: TaskAction) {
    this.operator(ctx);
    const result = this.command(ctx, key, { taskId, version, action }, () => {
      const r = this.store.get<any>('SELECT * FROM service_tasks WHERE id=?', taskId);
      if (!r) throw unavailable();
      ensure(r.version === version, 'SERVICE_VERSION_CHANGED', 409);
      if (r.kind === 'REFUND')
        ensure(
          this.store.get(
            "SELECT 1 FROM service_tasks WHERE operation_id=? AND ticket_id=? AND kind='ORDER' AND state='COMPLETED'",
            r.operation_id,
            r.ticket_id,
          ),
          'ORDER_RECEIPT_REQUIRED',
          409,
        );
      const expected: Record<TaskAction, string[]> = {
        ACCEPT: ['QUEUED'],
        CONFIRM: ['PROCESSING'],
        FAIL: ['QUEUED', 'PROCESSING'],
        LOSE_REPLY: ['QUEUED', 'PROCESSING'],
        RECONCILE: ['UNKNOWN', 'FAILED'],
      };
      ensure(expected[action].includes(r.state), 'INVALID_SERVICE_TRANSITION', 409);
      const next = {
        ACCEPT: 'PROCESSING',
        CONFIRM: 'COMPLETED',
        FAIL: 'FAILED',
        LOSE_REPLY: 'UNKNOWN',
        RECONCILE: 'PROCESSING',
      }[action];
      const data = JSON.parse(r.data);
      if (next === 'COMPLETED')
        data.receipt = {
          reference: 'DEMO-RECEIPT-' + taskId,
          confirmed_at_ms: this.clock.now(),
          kind: r.kind,
          simulated: true,
        };
      this.store.run(
        'UPDATE service_tasks SET state=?,version=version+1,data=? WHERE id=?',
        next,
        JSON.stringify(data),
        taskId,
      );
      this.event(
        taskId,
        version + 1,
        ctx.actor_id,
        action,
        action === 'RECONCILE'
          ? '查询原请求核对结果，不重新提交订单或退款。'
          : '由工作台明确模拟渠道事件，未联系真实航司或银行。',
      );
      return { id: taskId };
    });
    return this.taskView(this.store.get('SELECT * FROM service_tasks WHERE id=?', result.id));
  }
  flightEvent(ctx: Context, key: string, ticketId: string, segmentId: string, version: number) {
    this.operator(ctx);
    return this.command(
      ctx,
      key,
      { action: 'DELAY_180_MINUTES', ticketId, segmentId, version },
      () => {
        const row = this.store.get<any>('SELECT data FROM tickets WHERE id=?', ticketId);
        if (!row) throw unavailable();
        const t: Ticket = JSON.parse(row.data),
          segment = t.segments.find((s) => s.id === segmentId);
        ensure(t.version === version, 'SERVICE_VERSION_CHANGED', 409);
        ensure(
          t.channel === 'DIRECT' &&
            t.state === 'ACTIVE' &&
            segment?.state === 'UNUSED' &&
            segment.departure_at_ms > this.clock.now() &&
            !t.disruption,
          'FLIGHT_EVENT_NOT_APPLICABLE',
          409,
        );
        this.assertReady([t]);
        const eventId = id('flight-event'),
          now = this.clock.now();
        segment.departure_at_ms += 3 * HOUR;
        segment.arrival_at_ms += 3 * HOUR;
        t.disruption = {
          id: eventId,
          segment_id: segmentId,
          kind: 'SCHEDULE_CHANGE',
          notified_at_ms: now,
          new_departure_at_ms: segment.departure_at_ms,
          consumed: false,
        };
        t.version++;
        this.store.run(
          'UPDATE tickets SET version=?,data=? WHERE id=?',
          t.version,
          JSON.stringify(t),
          t.id,
        );
        this.store.run(
          'INSERT INTO service_alerts VALUES (?,?,?,?)',
          eventId,
          t.id,
          now,
          JSON.stringify({
            kind: 'SCHEDULE_CHANGE',
            segment_id: segmentId,
            departure_at_ms: segment.departure_at_ms,
            simulated: true,
            message:
              '模拟渠道报告该航段延后180分钟。原报价不可继续确认，请重新查票，核对航变选择并另行确认。',
          }),
        );
        return { id: eventId, ticket_id: t.id, version: t.version };
      },
    );
  }
  compare(ctx: Context, ticketIds: string[], arriveBy: number | null, maxCollect: string | null) {
    this.customer(ctx);
    ensure(
      ticketIds.length > 0 &&
        ticketIds.length <= 10 &&
        new Set(ticketIds).size === ticketIds.length,
      'INVALID_TARGETS',
    );
    ensure(
      arriveBy === null || (Number.isSafeInteger(arriveBy) && arriveBy > this.clock.now()),
      'INVALID_ARRIVAL_DEADLINE',
    );
    ensure(maxCollect === null || /^\d{1,12}(\.\d{1,2})?$/.test(maxCollect), 'INVALID_BUDGET');
    const budget = maxCollect === null ? null : nano(usd(maxCollect));
    ensure(budget === null || budget >= 0n, 'INVALID_BUDGET');
    const base: OperationRequest = {
      action: 'CHANGE',
      targets: ticketIds.map((ticket_id) => ({ ticket_id, replacements: [], segment_ids: [] })),
    };
    const { tickets } = this.booking.facts(ctx, base);
    this.assertReady(tickets);
    const segments = tickets.map((t) => t.segments.filter((s) => s.state !== 'USED'));
    ensure(
      segments[0].length > 0 &&
        segments[0].length <= 4 &&
        segments.every(
          (ss) =>
            ss.length === segments[0].length &&
            ss.every(
              (s, i) =>
                s.origin === segments[0][i].origin && s.destination === segments[0][i].destination,
            ),
        ),
      'COMPLEX_ITINERARY_REQUIRES_REVIEW',
    );
    const catalogs = tickets.map((t) => this.booking.options(ctx, t.id));
    const candidates = segments[0].map((_, leg) => {
      const byTraveler: Offer[][] = tickets.map((t, j) =>
        catalogs[j].segments[leg].offers
          .filter((o) => o.fare_type === t.fare_type && o.services_available)
          .sort((a, b) =>
            nano(a.fare) < nano(b.fare)
              ? -1
              : nano(a.fare) > nano(b.fare)
                ? 1
                : a.id.localeCompare(b.id),
          ),
      );
      return [...new Set(byTraveler[0].map((o) => o.flight_id))]
        .map((f) => byTraveler.map((os) => os.find((o) => o.flight_id === f)))
        .filter((group): group is Offer[] => group.every(Boolean))
        .sort((a, b) => a[0].departure_at_ms - b[0].departure_at_ms);
    });
    const found: any[] = [];
    let examined = 0,
      truncated = false;
    const visit = (legs: Offer[][]) => {
      if (examined >= 256) {
        truncated = true;
        return;
      }
      if (legs.length < candidates.length) {
        for (const next of candidates[legs.length]) {
          if (legs.length && next[0].departure_at_ms <= legs.at(-1)![0].arrival_at_ms) continue;
          visit([...legs, next]);
          if (truncated) break;
        }
        return;
      }
      examined++;
      const arrival = legs.at(-1)![0].arrival_at_ms;
      if (arriveBy !== null && arrival > arriveBy) return;
      const request: OperationRequest = {
        action: 'CHANGE',
        targets: tickets.map((t, j) => ({
          ticket_id: t.id,
          segment_ids: [],
          replacements: legs.map((os, i) => ({
            segment_id: segments[j][i].id,
            offer_id: os[j].id,
          })),
        })),
      };
      const { offers, decision } = this.booking.decide(ctx, request, this.clock.now());
      if (
        decision.status !== 'ALLOWED' ||
        (budget !== null && nano(decision.totals.collect) > budget)
      )
        return;
      try {
        this.booking.checkInventory(tickets, request, offers);
      } catch {
        return;
      }
      found.push({
        request,
        arrival_at_ms: arrival,
        totals: decision.totals,
        sources: decision.sources,
        legs: legs.map((os) => ({
          flight_id: os[0].flight_id,
          origin: os[0].origin,
          destination: os[0].destination,
          departure_at_ms: os[0].departure_at_ms,
          arrival_at_ms: os[0].arrival_at_ms,
        })),
        together: true,
      });
    };
    visit([]);
    found.sort((a, b) =>
      nano(a.totals.collect) < nano(b.totals.collect)
        ? -1
        : nano(a.totals.collect) > nano(b.totals.collect)
          ? 1
          : a.arrival_at_ms - b.arrival_at_ms,
    );
    return {
      candidates: found.slice(0, 3),
      considered: examined,
      search_truncated: truncated,
      constraints: {
        ticket_ids: ticketIds,
        arrive_by_ms: arriveBy,
        max_collect_usd: maxCollect,
        keep_together: true,
      },
      scope: 'CURRENT_SAMPLE_CATALOG',
      simulated: true,
      message: found.length
        ? '当前样例候选按总补款、到达时间排序；不锁座，选择后须重新报价并明确确认。'
        : '在本次检查的样例候选中没有满足全部条件且政策允许的方案。可调整预算/时间，或申请人工咨询；未自动放宽条件。',
    };
  }
}
