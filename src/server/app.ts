import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, id, hash } from './db.js';
import { Identity } from './identity.js';
import { Accounts } from './accounts.js';
import { PolicyRegistry } from './policies.js';
import { BookingService, type Hooks } from './booking.js';
import { seed, DEMO_ACTORS } from './seed.js';
import { SystemClock, type Clock } from '../domain/time.js';
import { AppError, ensure } from './errors.js';
import type { Context } from '../domain/types.js';
import { ConversationService } from '../assistant/conversation.js';
import { ToolGateway, operationSchema } from '../assistant/tools.js';
import { KnowledgeAdapter } from '../assistant/knowledge.js';
import { SkillRegistry } from '../assistant/skills.js';
import { type Model, UnconfiguredModel } from '../assistant/model.js';
import { ServiceDesk, DESK_ACTORS, SAMPLE_ACCESS, SERVICE_ACTIONS } from './service-desk.js';
export interface AppOptions {
  root?: string;
  filename?: string;
  clock?: Clock;
  model?: Model;
  hooks?: Hooks;
  frozenClock?: boolean;
  static?: boolean;
  serviceTrial?: boolean;
}
export async function createApp(options: AppOptions = {}) {
  const root = options.root ?? process.cwd(),
    clock = options.clock ?? new SystemClock(),
    store = new Store(options.filename ?? join(root, 'var/airline.sqlite'));
  seed(store, clock.now());
  // An environment switch must not bypass unresolved channel results in an existing trial DB.
  if (
    !options.serviceTrial &&
    store.get("SELECT 1 FROM service_tasks WHERE state<>'COMPLETED' LIMIT 1")
  ) {
    store.close();
    throw new AppError('SERVICE_TRIAL_REQUIRED_FOR_PENDING_RESULTS', 503);
  }
  const identity = new Identity(store, clock),
    accounts = new Accounts(store, clock),
    policies = new PolicyRegistry(store, root),
    booking = new BookingService(store, identity, policies, clock, options.hooks),
    model = options.model ?? new UnconfiguredModel();
  const serviceDesk = options.serviceTrial
    ? new ServiceDesk(store, identity, booking, clock)
    : undefined;
  booking.lifecycle = serviceDesk;
  const gateway = new ToolGateway(booking, new KnowledgeAdapter(root, policies), serviceDesk),
    conversations = new ConversationService(
      store,
      identity,
      gateway,
      model,
      new SkillRegistry(root),
    );
  const app = Fastify({ logger: false, bodyLimit: 16000 });
  await app.register(cookie);
  // Cookies are shared across ports. Give each persistent demo database its own
  // namespace so another localhost instance cannot overwrite this session.
  const sessionCookieName = store.tx(() => {
    store.run(
      "INSERT OR IGNORE INTO meta(key,value) VALUES ('session_cookie_namespace',?)",
      hash(id('cookie')).slice(0, 24),
    );
    const namespace = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='session_cookie_namespace'",
    )!.value;
    ensure(/^[a-f0-9]{24}$/.test(namespace), 'INVALID_SESSION_NAMESPACE', 503);
    return `airline_session_${namespace}`;
  });
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: false,
    maxAge: 8 * 60 * 60,
  };
  function ctx(req: any, active = false): Context {
    const context = identity.fromToken(req.cookies[sessionCookieName], active);
    ensure(context, 'SESSION_EXPIRED', 401);
    return context;
  }
  function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const r = schema.safeParse(value);
    ensure(r.success, 'INVALID_INPUT');
    return r.data;
  }
  const sid = z.string().min(1).max(160),
    key = z.string().min(8).max(160),
    empty = z.object({}).strict();
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'",
      );
    // Local demo service: reject cross-site, including DNS-rebinding hosts. Test injection uses localhost.
    const hostname = req.hostname;
    ensure(['localhost', '127.0.0.1', '[::1]'].includes(hostname), 'HOST_NOT_ALLOWED', 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let u: URL;
        try {
          u = new URL(origin);
        } catch {
          throw new AppError('ORIGIN_NOT_ALLOWED', 403);
        }
        ensure(
          u.host === req.headers.host && ['http:', 'https:'].includes(u.protocol),
          'ORIGIN_NOT_ALLOWED',
          403,
        );
      }
      ensure(req.headers['sec-fetch-site'] !== 'cross-site', 'ORIGIN_NOT_ALLOWED', 403);
      const c = ctx(req);
      ensure(
        typeof req.headers['x-csrf-token'] === 'string' && req.headers['x-csrf-token'] === c.csrf,
        'CSRF_REQUIRED',
        403,
      );
    }
  });
  app.addHook('preValidation', async (req) => {
    (req as any).received_at_ms = clock.now();
  });
  app.setErrorHandler((error: any, req, reply) => {
    const code =
      error instanceof AppError
        ? error.code
        : error.statusCode === 413
          ? 'MESSAGE_TOO_LONG'
          : 'SERVICE_UNAVAILABLE';
    reply
      .code(error instanceof AppError ? error.statusCode : error.statusCode === 413 ? 413 : 500)
      .send({ error: code });
  });
  app.get('/api/bootstrap', async (req, reply) => {
    const scopedToken = req.cookies[sessionCookieName];
    let c = identity.fromToken(scopedToken);
    // Migrate only a still-valid legacy session belonging to this database.
    // A present but invalid scoped cookie must never fall back to an old identity.
    if (!scopedToken && req.cookies.airline_session) {
      c = identity.fromToken(req.cookies.airline_session);
      if (c) reply.setCookie(sessionCookieName, req.cookies.airline_session, cookieOptions);
    }
    if (!c) {
      const s = identity.createSession();
      c = s.context;
      reply.setCookie(sessionCookieName, s.token, cookieOptions);
    }
    let releaseId: string | null = null;
    try {
      releaseId = policies.select('NSA', clock.now()).release_id;
    } catch {
      /* Missing current policy must not block recovery of completed records. */
    }
    return {
      actor: identity.actor(c),
      csrf: c.csrf,
      session_id: c.session_id,
      accounts: DEMO_ACTORS.map(({ id, name }) => ({ id, name })),
      model: { mode: model.mode, name: model.name },
      now_ms: clock.now(),
      frozen_clock: !!options.frozenClock,
      simulated: true,
      release_id: releaseId,
      service_trial: !!serviceDesk,
      service_operator: serviceDesk?.isDesk(c) ?? false,
      sample_access: serviceDesk ? SAMPLE_ACCESS : [],
    };
  });
  function beginAccountSession(old: Context, actorId: string, previousConversation?: string) {
    return store.tx(() => {
      identity.assertContext(old);
      const publicResponses: any[] = [];
      if (!old.actor_id && previousConversation) {
        identity.conversation(old, previousConversation);
        for (const row of store.all<any>(
          "SELECT response FROM turns WHERE conversation_id=? AND state='COMPLETED' ORDER BY rowid",
          previousConversation,
        )) {
          const response = JSON.parse(row.response);
          if (
            response.cards?.length &&
            response.cards.every((c: any) => ['policy', 'baggage'].includes(c.kind))
          )
            publicResponses.push({ ...response, imported_public: true });
        }
      }
      identity.logout(old);
      const s = identity.createSession(actorId);
      const conversation = identity.createConversation(s.context);
      store.tx(() => {
        for (const response of publicResponses.slice(-6)) {
          const tid = id('turn'),
            message = '此前公开政策咨询 / Earlier public policy consultation';
          store.run(
            'INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?)',
            tid,
            conversation.id,
            id('public-copy'),
            hash(message),
            s.context.session_id,
            'COMPLETED',
            JSON.stringify({ message }),
            JSON.stringify(response),
            clock.now(),
          );
          for (const [index, event] of ['turn_started', 'turn_finished'].entries())
            store.run(
              'INSERT INTO traces VALUES (?,?,?,?,?)',
              id('trace'),
              conversation.id,
              tid,
              clock.now(),
              JSON.stringify({
                event,
                sequence: index + 1,
                state: 'COMPLETED',
                public_import: true,
              }),
            );
        }
      });
      return { session: s, conversation_id: conversation.id };
    });
  }
  function signedIn(reply: any, result: ReturnType<typeof beginAccountSession>) {
    reply.setCookie(sessionCookieName, result.session.token, cookieOptions);
    return { ok: true, conversation_id: result.conversation_id };
  }
  // Explicit fictional examples remain separate from password-based local accounts.
  app.post('/api/login', async (req, reply) => {
    const a = parse(
      z
        .object({ actor_id: z.enum(['alice', 'bob', 'agent']), conversation_id: sid.optional() })
        .strict(),
      req.body,
    );
    return signedIn(reply, beginAccountSession(ctx(req, true), a.actor_id, a.conversation_id));
  });
  const username = z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9_]+$/),
    password = z.string().min(8).max(128);
  app.post('/api/auth/register', async (req, reply) => {
    const a = parse(
      z
        .object({
          username,
          password,
          display_name: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .regex(/^[^\u0000-\u001f\u007f]+$/)
            .optional(),
          conversation_id: sid.optional(),
        })
        .strict(),
      req.body,
    );
    const old = ctx(req, true);
    return accounts.attempt(req.ip, async () => {
      const draft = await accounts.prepare(a.username, a.password, a.display_name);
      const result = store.tx(() => {
        identity.assertContext(old);
        accounts.insert(draft);
        return beginAccountSession(old, draft.actorId, a.conversation_id);
      });
      return signedIn(reply, result);
    });
  });
  app.post('/api/auth/login', async (req, reply) => {
    const a = parse(
      z
        .object({ username, password: z.string().min(1).max(128), conversation_id: sid.optional() })
        .strict(),
      req.body,
    );
    const old = ctx(req, true);
    return accounts.attempt(req.ip, async () => {
      const actorId = await accounts.authenticate(a.username, a.password);
      return signedIn(reply, beginAccountSession(old, actorId, a.conversation_id));
    });
  });
  app.post('/api/logout', async (req, reply) => {
    parse(empty, req.body);
    identity.logout(ctx(req, true));
    const s = identity.createSession();
    reply.setCookie(sessionCookieName, s.token, cookieOptions);
    return { ok: true };
  });
  if (serviceDesk) {
    app.post('/api/demo/service-desk', async (req, reply) => {
      const a = parse(z.object({ operator: z.enum(DESK_ACTORS) }).strict(), req.body);
      const old = ctx(req, true);
      const signed = store.tx(() => {
        store.run(
          'INSERT OR IGNORE INTO actors VALUES (?,?,?)',
          a.operator,
          '模拟客服 ' + a.operator.slice(-1),
          a.operator,
        );
        return beginAccountSession(old, a.operator);
      });
      return signedIn(reply, signed);
    });
    app.get('/api/service', async (req) => serviceDesk.center(ctx(req)));
    app.get('/api/service/desk', async (req) => serviceDesk.dashboard(ctx(req)));
    app.post('/api/service/help', async (req) => {
      const a = parse(
        z.object({ request_key: key, note: z.string().min(1).max(500) }).strict(),
        req.body,
      );
      return serviceDesk.requestHelp(ctx(req, true), a.request_key, a.note);
    });
    app.post('/api/service/access', async (req) => {
      const a = parse(
        z
          .object({
            request_key: key,
            ticket_id: sid,
            code: z.string().min(1).max(100),
            actions: z.array(z.enum(SERVICE_ACTIONS)).min(1).max(6),
          })
          .strict(),
        req.body,
      );
      return serviceDesk.requestAccess(
        ctx(req, true),
        a.request_key,
        a.ticket_id,
        a.code,
        a.actions,
      );
    });
    app.post('/api/service/case-action', async (req) => {
      const a = parse(
        z
          .object({
            request_key: key,
            case_id: sid,
            version: z.number().int().positive(),
            action: z.enum([
              'CLAIM',
              'REQUEST_INFO',
              'REPLY',
              'HANDOFF',
              'CHANNEL_REPLY',
              'RESOLVE',
              'REJECT',
              'APPROVE_ACCESS',
              'REVOKE_ACCESS',
            ]),
            note: z.string().max(500),
          })
          .strict(),
        req.body,
      );
      return serviceDesk.actCase(
        ctx(req, true),
        a.request_key,
        a.case_id,
        a.version,
        a.action,
        a.note,
      );
    });
    app.post('/api/service/task-action', async (req) => {
      const a = parse(
        z
          .object({
            request_key: key,
            task_id: sid,
            version: z.number().int().positive(),
            action: z.enum(['ACCEPT', 'CONFIRM', 'FAIL', 'LOSE_REPLY', 'RECONCILE']),
          })
          .strict(),
        req.body,
      );
      return serviceDesk.actTask(ctx(req, true), a.request_key, a.task_id, a.version, a.action);
    });
    app.post('/api/service/flight-event', async (req) => {
      const a = parse(
        z
          .object({
            request_key: key,
            ticket_id: sid,
            segment_id: sid,
            version: z.number().int().positive(),
          })
          .strict(),
        req.body,
      );
      return serviceDesk.flightEvent(
        ctx(req, true),
        a.request_key,
        a.ticket_id,
        a.segment_id,
        a.version,
      );
    });
    app.post('/api/service/compare', async (req) => {
      const a = parse(
        z
          .object({
            ticket_ids: z.array(sid).min(1).max(10),
            arrive_by_ms: z.number().int().safe().nullable(),
            max_collect_usd: z
              .string()
              .regex(/^\d{1,12}(\.\d{1,2})?$/)
              .nullable(),
          })
          .strict(),
        req.body,
      );
      return serviceDesk.compare(ctx(req, true), a.ticket_ids, a.arrive_by_ms, a.max_collect_usd);
    });
  }
  app.get('/api/conversations', async (req) => {
    const c = ctx(req);
    return store.all<any>(
      'SELECT id,created_at_ms,frozen FROM conversations WHERE owner=? ORDER BY created_at_ms DESC LIMIT 30',
      identity.owner(c),
    );
  });
  app.post('/api/conversations', async (req) => {
    parse(empty, req.body);
    return identity.createConversation(ctx(req, true));
  });
  app.get('/api/conversations/:id', async (req) =>
    conversations.history(ctx(req), parse(z.object({ id: sid }), req.params).id),
  );
  app.post('/api/conversations/:id/turns', async (req) => {
    const a = parse(
      z.object({ message: z.string().min(1).max(4000), message_key: key }).strict(),
      req.body,
    );
    return conversations.start(
      ctx(req, true),
      parse(z.object({ id: sid }), req.params).id,
      a.message_key,
      a.message,
    );
  });
  app.get('/api/turns/:id', async (req) =>
    conversations.turn(ctx(req), parse(z.object({ id: sid }), req.params).id),
  );
  app.get('/api/tickets', async (req) => booking.list(ctx(req)));
  app.post('/api/options', async (req) => {
    const a = parse(
      z
        .object({
          conversation_id: sid,
          ticket_id: sid,
          date: z.string().nullable(),
          action: z.enum(['CHANGE', 'DISRUPTION_CHANGE']),
        })
        .strict(),
      req.body,
    );
    const c = ctx(req, true);
    booking.invalidate(c, a.conversation_id);
    return booking.options(c, a.ticket_id, a.date ?? undefined, a.conversation_id, a.action);
  });
  app.post('/api/quotes', async (req) => {
    const a = parse(
      z.object({ conversation_id: sid, request: operationSchema }).strict(),
      req.body,
    );
    return booking.quote(ctx(req, true), a.conversation_id, a.request);
  });
  app.get('/api/quotes/:id', async (req) =>
    booking.getQuote(ctx(req), parse(z.object({ id: sid }), req.params).id),
  );
  app.post('/api/confirm', async (req) => {
    const a = parse(
      z.object({ quote_id: sid, confirmation_token: sid, request_key: key }).strict(),
      req.body,
    );
    return booking.confirm(
      ctx(req, true),
      a.quote_id,
      a.confirmation_token,
      a.request_key,
      (req as any).received_at_ms,
    );
  });
  app.get('/api/submissions/:key', async (req) =>
    booking.submission(ctx(req), parse(z.object({ key: sid }), req.params).key),
  );
  app.get('/api/operations', async (req) => booking.records(ctx(req)));
  app.get('/api/reviews', async (req) => booking.reviews(ctx(req)));
  app.post('/api/reviews', async (req) => {
    const a = parse(
      z
        .object({
          conversation_id: sid,
          request_key: key,
          request: operationSchema.nullable(),
          claim: z.string().max(500).nullable(),
        })
        .strict(),
      req.body,
    );
    return booking.createReview(
      ctx(req, true),
      a.conversation_id,
      a.request_key,
      a.request,
      a.claim ?? undefined,
    );
  });
  app.get('/api/bundle-source/:bundle/:document', async (req, reply) => {
    const p = parse(
      z
        .object({
          bundle: z.string().regex(/^[a-f0-9]{24}$/),
          document: z.enum(['NSA.pdf', 'BHA.pdf', 'STA.pdf']),
        })
        .strict(),
      req.params,
    );
    const bundle = policies.get(p.bundle);
    return reply.redirect(`/api/policies/${bundle.release_id}/${p.document}`);
  });
  app.get('/api/policies/:release/:document', async (req, reply) => {
    const p = parse(
      z
        .object({
          release: z.string().regex(/^[a-f0-9]{24}$/),
          document: z.enum(['NSA.pdf', 'BHA.pdf', 'STA.pdf']),
        })
        .strict(),
      req.params,
    );
    ensure(
      [...policies.bundles.values()].some((b) => b.release_id === p.release),
      'SOURCE_NOT_AVAILABLE',
      404,
    );
    const pdf = join(root, 'data/knowledge/releases', p.release, 'sources', p.document);
    ensure(existsSync(pdf), 'SOURCE_NOT_AVAILABLE', 404);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${p.document}"`)
      .send(readFileSync(pdf));
  });
  if (options.static !== false && existsSync(join(root, 'dist/web/index.html'))) {
    await app.register(staticFiles, {
      root: join(root, 'dist/web'),
      prefix: '/',
      cacheControl: false,
    });
  }
  app.addHook('onClose', async () => {
    for (const row of store.all<any>("SELECT id FROM turns WHERE state='RUNNING'"))
      await conversations.wait(row.id);
    store.close();
  });
  return {
    app,
    store,
    clock,
    identity,
    policies,
    booking,
    serviceDesk,
    gateway,
    conversations,
    model,
    sessionCookieName,
  };
}
