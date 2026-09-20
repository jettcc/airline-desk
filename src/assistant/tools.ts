import { z } from 'zod';
import { BookingService } from '../server/booking.js';
import { KnowledgeAdapter } from './knowledge.js';
import { baggage } from '../domain/rules.js';
import type { Card, Context } from '../domain/types.js';
import { ensure, AppError } from '../server/errors.js';
import { hash, canonical } from '../server/db.js';
import type { ServiceDesk } from '../server/service-desk.js';
export const airlineSchema = z.enum(['NSA', 'BHA', 'STA']);
export const actionSchema = z.enum([
  'CHANGE',
  'CANCEL',
  'TAX_REFUND',
  'DISRUPTION_CHANGE',
  'DISRUPTION_REFUND',
]);
const ident = z.string().min(1).max(160);
export const operationSchema = z
  .object({
    action: actionSchema,
    targets: z
      .array(
        z
          .object({
            ticket_id: ident,
            replacements: z
              .array(z.object({ segment_id: ident, offer_id: ident }).strict())
              .max(12),
            segment_ids: z.array(ident).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
const definitions = {
  get_service_status: {
    description:
      'Read the signed-in traveler’s service progress, channel receipts, own review workflow and flight alerts. Local simulation only. Use when asking whether a refund arrived, processing progress or who is handling a case. Never confirms, advances, approves or impersonates an operator. If the trial is disabled, the tool returns the existing operation/review records.',
    schema: z.object({}).strict(),
  },
  search_policy: {
    description:
      'Search only reviewed public airline policy. Never include passenger names, ticket IDs or private messages. Terminal public evidence card.',
    schema: z
      .object({
        question: z.string().min(1).max(2000),
        airline: airlineSchema.nullable(),
        compare: z.boolean(),
      })
      .strict(),
  },
  check_baggage: {
    description:
      'Return verified baggage allowances and bag evaluation. For CHECKED accept either three dimensions_cm or the user-provided linear_cm sum; never invent dimensions. PERSONAL/CABIN require all three dimensions. Preserve every bag and its count. bags=[] is only an allowance question, never a substitute for missing measurements. Does not sell extras. For NSA/BHA domestic is irrelevant; for STA it must be known.',
    schema: z
      .object({
        airline: airlineSchema,
        fare: z.enum(['Basic', 'Standard', 'Flex']),
        domestic: z.boolean(),
        bags: z
          .array(
            z.union([
              z
                .object({
                  type: z.enum(['PERSONAL', 'CABIN', 'CHECKED']),
                  weight_kg: z.number().positive().max(1000),
                  dimensions_cm: z.array(z.number().positive().max(1000)).length(3),
                })
                .strict(),
              z
                .object({
                  type: z.literal('CHECKED'),
                  weight_kg: z.number().positive().max(1000),
                  linear_cm: z.number().positive().max(3000),
                })
                .strict(),
            ]),
          )
          .max(10),
      })
      .strict(),
  },
  get_booking: {
    description:
      'Read only currently authorized tickets. Empty IDs lists visible tickets. present=true displays selection and ends turn; false supplies verified facts for further tool calls.',
    schema: z.object({ ticket_ids: z.array(ident).max(10), present: z.boolean() }).strict(),
  },
  search_change_options: {
    description:
      'Read candidate flights for an authorized ticket. UTC date YYYY-MM-DD or null. present=true ends turn to let user select; false only when user already specified an exact replacement or unambiguous date/time selection.',
    schema: z
      .object({
        ticket_id: ident,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        action: z.enum(['CHANGE', 'DISRUPTION_CHANGE']),
        present: z.boolean(),
      })
      .strict(),
  },
  quote_operation: {
    description:
      'Evaluate trusted ticket/offer facts and persist a confirmable quote. Never executes it. record_review=true only when user explicitly asks to apply/handle a refund, and server decision requires review.',
    schema: z.object({ request: operationSchema, record_review: z.boolean() }).strict(),
  },
  search_group_change_options: {
    description:
      'Return one combined selection card for ALL explicitly selected tickets in one booking. Use for multi-traveler changes, never silently reduce the group. Terminal.',
    schema: z
      .object({
        ticket_ids: z.array(ident).min(1).max(10),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        action: z.enum(['CHANGE', 'DISRUPTION_CHANGE']),
      })
      .strict(),
  },
  request_exception_review: {
    description:
      'Record an explicit request for medical, guardianship or disputed-ownership review. No approval, waiver or refund. MEDICAL needs accessible ticket IDs; GUARDIANSHIP/OWNERSHIP must use empty ticket_ids and do not look up another person. Do not collect medical records or IDs.',
    schema: z
      .object({
        reason: z.enum(['MEDICAL', 'GUARDIANSHIP', 'OWNERSHIP']),
        ticket_ids: z.array(ident).max(10),
      })
      .strict(),
  },
  create_review_case: {
    description:
      'Record explicit application for a business review or access verification. No refund/payment/permission is granted. request=null only for an access claim; no private target lookup.',
    schema: z
      .object({ request: operationSchema.nullable(), claim: z.string().min(1).max(500).nullable() })
      .strict(),
  },
  get_review_case: {
    description: 'Read current applicant review status.',
    schema: z.object({ case_id: ident }).strict(),
  },
  get_submission: {
    description: 'Recover existing submitted request. Do not create a new quote or submit again.',
    schema: z.object({ request_key: ident }).strict(),
  },
  get_operation: {
    description:
      'Read persisted operations in current authorized scope. operation_id=null lists recent records.',
    schema: z.object({ operation_id: ident.nullable() }).strict(),
  },
  check_credit: {
    description:
      'Check an existing personal credit for its named traveler and a proposed airline/departure, without redeeming it. Obtain the credit ID from get_operation and clarify ambiguous departure/timezone. Server supplies current time.',
    schema: z
      .object({
        credit_id: ident,
        airline: airlineSchema,
        departure_at_ms: z.number().int().safe(),
      })
      .strict(),
  },
  explain_quote: {
    description:
      'Explain current quote or respond to chat confirmation by displaying its trusted confirmation card. Does not invalidate or execute it.',
    schema: z.object({}).strict(),
  },
  clarify: {
    description:
      'Ask for missing information using an approved question; do not invent policy or amounts.',
    schema: z
      .object({
        reason: z.enum([
          'AIRLINE',
          'FARE',
          'ROUTE',
          'TICKET',
          'FLIGHT',
          'DATE_TIME',
          'DISRUPTION_CHOICE',
          'LOGIN',
          'UNSUPPORTED',
          'GREETING',
          'DETAILS',
          'BAG_TYPE',
          'BAG_WEIGHT',
          'BAG_DIMENSIONS',
          'BAG_LINEAR_SIZE',
          'BAG_CONFLICT',
        ]),
      })
      .strict(),
  },
} as const;
export const modelTools = Object.entries(definitions).map(([name, d]) => ({
  type: 'function',
  name,
  description: d.description,
  strict: true,
  parameters: z.toJSONSchema(d.schema, { target: 'draft-7' }),
}));
export const prompts: Record<string, [string, string]> = {
  BAG_TYPE: [
    '这件行李是随身小件、客舱行李，还是托运行李？',
    'Is this a personal item, a cabin bag or a checked bag?',
  ],
  BAG_WEIGHT: ['请补充每件行李的重量（kg）。', 'What is the weight in kg of each bag?'],
  BAG_DIMENSIONS: [
    '请补充这件随身或客舱行李的长、宽、高（cm，含把手和轮子）；仅三边合计无法核对单边限制。',
    'Please provide length, width and height in cm, including handles and wheels. A total alone cannot establish cabin/personal-item limits.',
  ],
  BAG_LINEAR_SIZE: [
    '请补充每件托运行李的三边合计，或长、宽、高（cm，含把手和轮子）。',
    'Please provide the dimensions sum, or length, width and height, in cm for each checked bag, including handles and wheels.',
  ],
  BAG_CONFLICT: [
    '行李条件中有不一致的信息。请确认每件行李的类型、重量和尺寸，以更正后的信息为准。',
    'The baggage details conflict. Please confirm each bag’s type, weight and size using the corrected information.',
  ],
  AIRLINE: [
    '请问是哪家航司：Northstar (NSA)、Bluehaven (BHA) 还是 Suntrail (STA)？如果要比较，也请告诉我。',
    'Which airline: Northstar (NSA), Bluehaven (BHA), or Suntrail (STA)? You can also request a comparison.',
  ],
  FARE: ['请补充票价类型：Basic、Standard 或 Flex。', 'Which fare: Basic, Standard, or Flex?'],
  ROUTE: [
    '请说明这是国内段还是国际段；Suntrail 的行李规则按每段路线判断。',
    'Is this a domestic or international segment? Suntrail baggage rules depend on each segment.',
  ],
  TICKET: [
    '请从“我的客票”选择本次要处理的客票。多人出行也只能办理当前身份有权操作的范围。',
    'Select the tickets to handle from My tickets. Each traveler requires authorization.',
  ],
  FLIGHT: [
    '请选择要变更的航段和新的航班；我会按明确的选择重新报价。',
    'Choose the affected segments and replacement flights for a new quotation.',
  ],
  DATE_TIME: [
    '请补充明确日期、时间及所用时区。页面候选航班默认标注 UTC。',
    'Please specify the date, time and timezone. Flight options are labeled UTC.',
  ],
  DISRUPTION_CHOICE: [
    '这张票有航变信息。你希望评估免费改签，还是申请航变退款？',
    'This ticket has disruption information. Would you like a free rebooking assessment or a disruption refund?',
  ],
  LOGIN: [
    '查看和办理个人客票需要先选择演示身份登录。公开政策咨询无需登录。',
    'Sign in with a demo identity to view or handle private tickets. Public policy questions do not require sign-in.',
  ],
  UNSUPPORTED: [
    '提供的三份政策没有足够依据回答这一点，我暂时无法确认。请查看原文适用范围，或提出具体政策问题。',
    'The three supplied policies do not provide enough evidence to answer this. I cannot confirm it.',
  ],
  GREETING: [
    '你好，我可以帮你查三家航司的政策、行李规定，以及已授权客票的退改方案。所有订单与资金处理均为本地模拟。',
    'Hello. I can help with the three airlines’ policies, baggage rules and authorized ticket changes/refunds. All booking and financial operations are local simulations.',
  ],
  DETAILS: [
    '请补充要咨询或办理的具体事项。我不会在事实不完整时猜测费用或办理结果。',
    'Please clarify the question or operation. I will not guess amounts or outcomes from incomplete facts.',
  ],
};
export type ToolExecution = { cards: Card[]; data: any; terminal: boolean };
export class ToolGateway {
  constructor(
    public booking: BookingService,
    public knowledge: KnowledgeAdapter,
    public serviceDesk?: ServiceDesk,
  ) {}
  async execute(
    ctx: Context,
    conversationId: string,
    turnId: string,
    name: string,
    args: unknown,
  ): Promise<ToolExecution> {
    const b = this.booking,
      i = b.identity;
    i.assertContext(ctx);
    i.conversation(ctx, conversationId);
    ensure(Object.hasOwn(definitions, name), 'TOOL_NOT_ALLOWED');
    const parsed = (definitions as any)[name].schema.safeParse(args);
    ensure(parsed.success, 'INVALID_TOOL_ARGUMENTS');
    const a = parsed.data;
    const result = (kind: string, data: any, terminal = true) => ({
      cards: [{ kind, data }],
      data,
      terminal,
    });
    if (name !== 'explain_quote') b.invalidate(ctx, conversationId, turnId);
    switch (name) {
      case 'get_service_status':
        if (this.serviceDesk) {
          const service = this.serviceDesk.center(ctx);
          const ids = new Set([
            ...service.tasks.map((t) => t.ticket_id),
            ...service.alerts.map((t) => t.ticket_id),
            ...service.cases.flatMap((c: any) => c.protected_ticket_ids ?? []),
          ]);
          for (const tid of ids) i.bindTicket(ctx, conversationId, i.ticket(ctx, tid), 'READ');
          return result('service', service);
        }
        const operations = b.records(ctx),
          reviews = b.reviews(ctx);
        const privateIds = new Set([
          ...operations.flatMap((o) => o.tickets.map((t) => t.id)),
          ...reviews
            .filter((r: any) => !r.restricted)
            .flatMap(
              (r: any) =>
                r.protected_ticket_ids ?? r.request?.targets?.map((t: any) => t.ticket_id) ?? [],
            ),
        ]);
        for (const tid of privateIds) i.bindTicket(ctx, conversationId, i.ticket(ctx, tid), 'READ');
        return {
          terminal: true,
          data: { operations, reviews },
          cards: [
            { kind: 'operations', data: operations },
            ...reviews.map((data) => ({ kind: 'review', data })),
          ],
        };
      case 'clarify':
        return result('clarification', {
          reason: a.reason,
          zh: prompts[a.reason][0],
          en: prompts[a.reason][1],
        });
      case 'search_policy':
        return result(
          'policy',
          await this.knowledge.search(a.question, a.airline, a.compare, b.clock.now()),
        );
      case 'check_baggage': {
        const bundle = b.policies.select(a.airline, b.clock.now());
        return result('baggage', {
          ...baggage(a.airline, a.fare, a.domestic, a.bags, bundle.rules),
          bundle_id: bundle.id,
          release_id: bundle.release_id,
        });
      }
      case 'get_booking': {
        const tickets = a.ticket_ids.length
          ? a.ticket_ids.map((id: string) => {
              const t = i.ticket(ctx, id);
              i.bindTicket(ctx, conversationId, t, 'READ');
              return { ...t, allowed_actions: i.scope(ctx, t) };
            })
          : b.list(ctx, conversationId);
        return result('tickets', tickets, a.present);
      }
      case 'search_change_options':
        return result(
          'options',
          b.options(ctx, a.ticket_id, a.date ?? undefined, conversationId, a.action),
          a.present,
        );
      case 'search_group_change_options':
        return result(
          'group_options',
          b.groupOptions(ctx, a.ticket_ids, a.date ?? undefined, conversationId, a.action),
        );
      case 'request_exception_review':
        return result(
          'review',
          b.createExceptionReview(
            ctx,
            conversationId,
            `${turnId}:${hash(canonical(a))}`,
            a.reason,
            a.ticket_ids,
          ),
        );
      case 'quote_operation': {
        const value = b.quote(ctx, conversationId, a.request, turnId);
        if (value.decision.status === 'MANUAL_REVIEW' && a.record_review) {
          const review = b.createReview(
            ctx,
            conversationId,
            `${turnId}:${hash(canonical(a.request))}`,
            a.request,
          );
          return result('review', review);
        }
        const card = result(
          value.quote ? 'quote' : 'decision',
          value.quote ?? { ...value.decision, bundle_id: value.bundle_id },
        );
        // Confirmation credentials belong only to the authenticated browser response, never to model context.
        card.data = {
          decision: value.decision,
          quote_id: value.quote?.id,
          status: value.quote ? 'AWAITING_CONFIRMATION' : value.decision.status,
        };
        return card;
      }
      case 'create_review_case':
        return result(
          'review',
          b.createReview(
            ctx,
            conversationId,
            `${turnId}:${hash(canonical(a))}`,
            a.request,
            a.claim ?? undefined,
          ),
        );
      case 'get_review_case': {
        const review = b.review(ctx, a.case_id);
        if (!review.restricted)
          for (const t of review.request?.targets ??
            (review.protected_ticket_ids ?? []).map((ticket_id: string) => ({ ticket_id })))
            i.bindTicket(ctx, conversationId, i.ticket(ctx, t.ticket_id), 'READ');
        return result('review', review);
      }
      case 'get_submission': {
        const submission = b.submission(ctx, a.request_key);
        for (const t of submission.operation?.tickets ?? [])
          i.bindTicket(ctx, conversationId, i.ticket(ctx, t.id), 'READ');
        return result('submission', submission);
      }
      case 'get_operation': {
        const ops = a.operation_id ? [b.operation(ctx, a.operation_id)] : b.records(ctx);
        for (const op of ops)
          for (const t of op.tickets)
            i.bindTicket(ctx, conversationId, i.ticket(ctx, t.id), 'READ');
        return result('operations', ops);
      }
      case 'check_credit': {
        const credit = b.checkCredit(ctx, a.credit_id, a.airline, a.departure_at_ms);
        i.bindTicket(ctx, conversationId, i.ticket(ctx, credit.ticket_id), 'READ');
        return result('credit_check', credit);
      }
      case 'explain_quote': {
        const c = i.conversation(ctx, conversationId);
        if (!c.active_quote_id)
          return result('clarification', {
            reason: 'DETAILS',
            zh: '当前没有可确认的报价。请先选择客票并获取方案。',
            en: 'There is no current quote. Select a ticket and request a quotation.',
          });
        const q = b.getQuote(ctx, c.active_quote_id);
        const r = result('quote', q);
        r.data = { decision: q.decision, quote_id: q.id, status: 'AWAITING_CONFIRMATION' };
        return r;
      }
      default:
        throw new AppError('TOOL_NOT_ALLOWED');
    }
  }
}
