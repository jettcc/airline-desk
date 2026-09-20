import policy from '../../data/rules/policy-v1.json' with { type: 'json' };
import { add, sub, positive, nano, usd, settlement, ZERO } from './money.js';
import type { Money } from './money.js';
import { DAY, timestamp, utcDay, windowFor } from './time.js';
import type {
  Airline,
  Fare,
  Ticket,
  Offer,
  Target,
  Action,
  Decision,
  DecisionStatus,
  Line,
  SourceRef,
} from './types.js';
export { policy };
export type RuleSet = typeof policy;
const ranks: Fare[] = ['Basic', 'Standard', 'Flex'];
const fareKey = (airline: Airline, domestic: boolean) =>
  airline === 'STA' ? (domestic ? 'STA_DOM' : 'STA_INT') : airline;
const sources = (a: Airline, action: Action): SourceRef[] => {
  const parts: [string, number][] =
    action === 'CHANGE'
      ? [
          ['2.1', 2],
          ['2.2', 2],
          ['2.3', 2],
          ['3.2', 3],
        ]
      : action.startsWith('DISRUPTION')
        ? [
            ['6', 4],
            ['6.1', 4],
            ['6.2', 4],
            ['6.3', 4],
          ]
        : [
            ['3', 3],
            ['3.1', 3],
            ['3.2', 3],
            ['5', 3],
          ];
  return [...parts, ['1.1', 1] as [string, number], ['8', 6] as [string, number]].map(
    ([section, page]) => ({ airline: a, section, page, rule_id: `${a}:${section}` }),
  );
};
export function emptyDecision(status: DecisionStatus = 'ALLOWED', reason?: string): Decision {
  return {
    status,
    reasons: reason ? [reason] : [],
    known_rights: [],
    lines: [],
    totals: { collect: ZERO, refund: ZERO, credit: ZERO, forfeit: ZERO },
    sources: [],
  };
}
export function totalLines(lines: Line[]): Decision['totals'] {
  return {
    collect: add(...lines.filter((x) => x.direction === 'COLLECT').map((x) => x.amount)),
    refund: add(...lines.filter((x) => x.direction === 'REFUND').map((x) => x.amount)),
    credit: add(...lines.filter((x) => x.direction === 'CREDIT').map((x) => x.amount)),
    forfeit: add(...lines.filter((x) => x.direction === 'FORFEIT').map((x) => x.amount)),
  };
}
export function changeFee(
  airline: Airline,
  fare: Fare,
  domestic: boolean,
  issued: number,
  departure: number,
  at: number,
  rules: RuleSet = policy,
): Money | null {
  const w = windowFor(departure, at);
  if (w === 'DEPARTED') return null;
  let fee = rules.change[fareKey(airline, domestic)][fare][w === 'EARLY' ? 0 : 1];
  if (
    airline === 'BHA' &&
    fare === 'Standard' &&
    w === 'EARLY' &&
    timestamp(issued) < Date.parse('2026-07-01T00:00:00Z')
  )
    fee = 85;
  return fee === null ? null : usd(fee);
}
export function cancellation(
  airline: Airline,
  fare: Fare,
  domestic: boolean,
  departure: number,
  at: number,
  rules: RuleSet = policy,
): { direction: 'NONE' | 'REFUND' | 'CREDIT'; fee: Money } {
  const w = windowFor(departure, at);
  if (w === 'DEPARTED') return { direction: 'NONE', fee: ZERO };
  const [direction, fee] = rules.cancel[fareKey(airline, domestic)][fare][w === 'EARLY' ? 0 : 1];
  return { direction: direction as 'NONE' | 'REFUND' | 'CREDIT', fee: usd(fee as number) };
}
export function protection(
  ticket: Ticket,
  at: number,
  rules: RuleSet = policy,
): 'NONE' | 'ELIGIBLE' | 'EXPIRED' | 'CONSUMED' | 'INVALID' {
  const d = ticket.disruption;
  if (!d) return 'NONE';
  const s = ticket.segments.find((s) => s.id === d.segment_id);
  if (!s || d.notified_at_ms > at) return 'INVALID';
  timestamp(d.notified_at_ms);
  timestamp(d.new_departure_at_ms);
  const qualifies =
    d.kind === 'CANCELLED' ||
    Math.abs(d.new_departure_at_ms - s.original_departure_at_ms) >=
      rules.disruption_minutes[ticket.airline] * 60_000;
  if (!qualifies) return 'NONE';
  if (d.consumed) return 'CONSUMED';
  return at - d.notified_at_ms <= 30 * DAY ? 'ELIGIBLE' : 'EXPIRED';
}
export function evaluateTicket(
  ticket: Ticket,
  action: Action,
  target: Target,
  offers: Offer[],
  at: number,
  rules: RuleSet = policy,
): Decision {
  const result = emptyDecision();
  result.sources = sources(ticket.airline, action);
  const stop = (status: DecisionStatus, reason: string, rights: string[] = []): Decision => ({
    ...result,
    status,
    reasons: [reason],
    known_rights: rights,
    lines: [],
    totals: emptyDecision().totals,
  });
  try {
    timestamp(at);
    timestamp(ticket.original_issued_at_ms);
    if (at < Date.parse(rules.effective_from[ticket.airline]))
      return stop('NOT_COVERED', 'POLICY_DATE_NOT_COVERED');
    if (
      !ticket.segments.length ||
      new Set(ticket.segments.map((s) => s.id)).size !== ticket.segments.length ||
      target.ticket_id !== ticket.id ||
      !ranks.includes(ticket.fare_type)
    )
      return stop('CONFLICT', 'INVALID_TICKET_FACTS');
    for (const s of ticket.segments) {
      timestamp(s.departure_at_ms);
      timestamp(s.original_departure_at_ms);
      timestamp(s.arrival_at_ms);
      if (
        s.arrival_at_ms <= s.departure_at_ms ||
        !['UNUSED', 'USED', 'NO_SHOW', 'SUSPENDED'].includes(s.state)
      )
        return stop('CONFLICT', 'INVALID_TICKET_FACTS');
      if (s.fare) settlement(s.fare);
      if (s.tax) settlement(s.tax);
    }
    for (const e of ticket.extras) settlement(e.amount);
    if (ticket.disruption) {
      timestamp(ticket.disruption.notified_at_ms);
      timestamp(ticket.disruption.new_departure_at_ms);
    }
  } catch {
    return stop('CONFLICT', 'INVALID_FINANCIAL_OR_TIME_FACTS');
  }
  const protectedState = protection(ticket, at, rules);
  const isProtected = action.startsWith('DISRUPTION');
  if (isProtected && protectedState !== 'ELIGIBLE') {
    if (protectedState === 'EXPIRED') return stop('MANUAL_REVIEW', 'DISRUPTION_WINDOW_REVIEW');
    return stop(protectedState === 'INVALID' ? 'CONFLICT' : 'DENIED', 'NO_UNUSED_DISRUPTION_RIGHT');
  }
  if (!isProtected && protectedState === 'ELIGIBLE' && action !== 'TAX_REFUND')
    return stop('NEEDS_INFO', 'CHOOSE_DISRUPTION_OPTION', ['FREE_REBOOK_OR_REFUND']);
  if (ticket.state === 'CANCELLED' && action !== 'TAX_REFUND')
    return stop('DENIED', 'TICKET_ALREADY_CANCELLED');
  const selectedIds = target.segment_ids;
  const changing = action === 'CHANGE' || action === 'DISRUPTION_CHANGE';
  if (
    (!changing && target.replacements.length) ||
    (changing &&
      selectedIds.length &&
      (selectedIds.length !== target.replacements.length ||
        target.replacements.some((r) => !selectedIds.includes(r.segment_id))))
  )
    return stop('CONFLICT', 'INVALID_SEGMENT_SELECTION');
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !ticket.segments.some((s) => s.id === id))
  )
    return stop('CONFLICT', 'INVALID_SEGMENT_SELECTION');
  const line = (
    kind: Line['kind'],
    direction: Line['direction'],
    amount: Money,
    segmentId: string | null,
    entitlementId: string,
    rule: string,
    payment: string | null,
  ) => {
    settlement(amount);
    result.lines.push({
      ticket_id: ticket.id,
      segment_id: segmentId,
      entitlement_id: entitlementId,
      kind,
      direction,
      amount,
      rule_id: `${ticket.airline}:${rule}`,
      payment_ref: payment,
    });
  };
  const used = ticket.segments.some((s) => s.state === 'USED');
  const noShow =
    ticket.state === 'SUSPENDED' ||
    ticket.segments.some(
      (s) =>
        s.state === 'NO_SHOW' ||
        s.state === 'SUSPENDED' ||
        (s.state === 'UNUSED' && s.departure_at_ms <= at),
    );
  const refundChannel =
    action === 'CANCEL' || action === 'TAX_REFUND' || action === 'DISRUPTION_REFUND';
  if (refundChannel && ticket.channel === 'AGENT')
    return stop('MANUAL_REVIEW', 'REFUND_THROUGH_TICKETING_AGENT');
  if (action === 'TAX_REFUND') {
    const segments = ticket.segments.filter(
      (s) => !selectedIds.length || selectedIds.includes(s.id),
    );
    if (
      ticket.state === 'ACTIVE' &&
      segments.some((s) => s.state === 'UNUSED' && s.departure_at_ms > at)
    )
      return stop('MANUAL_REVIEW', 'TAX_AND_ACTIVE_TRAVEL_CONFLICT', [
        'UNUSED_TAX_REFUND_ELIGIBILITY',
      ]);
    const eligible = segments.filter((s) => s.state !== 'USED' && !s.tax_refunded);
    if (!eligible.length) return stop('DENIED', 'NO_REMAINING_UNUSED_TAX');
    for (const s of eligible) {
      if (!s.tax) return stop('NEEDS_INFO', 'MISSING_TAX_AMOUNT');
      line('TAX', 'REFUND', s.tax, s.id, `${s.id}:tax`, '3.2', s.payment_ref);
    }
  } else if (action === 'CANCEL' || action === 'DISRUPTION_REFUND') {
    const selected = ticket.segments.filter(
      (s) => !selectedIds.length || selectedIds.includes(s.id),
    );
    if (selected.every((s) => s.state === 'USED')) return stop('DENIED', 'NO_UNUSED_SEGMENTS');
    // A user explicitly selecting the unused affected segment does not lose the
    // established disruption right just because valuation requires manual review.
    if (used)
      return stop(
        'MANUAL_REVIEW',
        'PARTIALLY_USED_REFUND_REVIEW',
        isProtected ? ['UNUSED_AFFECTED_PORTION_REFUND_RIGHT'] : [],
      );
    if (
      selectedIds.length &&
      (selectedIds.length !== ticket.segments.length ||
        ticket.segments.some((s) => !selectedIds.includes(s.id)))
    )
      return stop(
        'MANUAL_REVIEW',
        'PARTIAL_CANCELLATION_REVIEW',
        isProtected ? ['UNUSED_AFFECTED_PORTION_REFUND_RIGHT'] : [],
      );
    if (ticket.historical_value_unclear)
      return stop(
        'MANUAL_REVIEW',
        'HISTORICAL_VALUE_REVIEW',
        isProtected ? ['UNUSED_AFFECTED_PORTION_REFUND_RIGHT'] : [],
      );
    const first = Math.min(...ticket.segments.map((s) => s.departure_at_ms));
    if (!isProtected && (noShow || windowFor(first, at) === 'DEPARTED'))
      return stop('DENIED', 'NO_SHOW_FARE_NOT_REFUNDABLE', ['UNUSED_TAX_REFUND_ELIGIBILITY']);
    if (ticket.segments.some((s) => !s.fare || !s.tax))
      return stop('NEEDS_INFO', 'MISSING_PRICE_OR_TAX');
    const fare = add(...ticket.segments.map((s) => s.fare!));
    const paymentRefs = new Set(ticket.segments.map((s) => s.payment_ref));
    if (paymentRefs.size !== 1) return stop('MANUAL_REVIEW', 'MULTI_PAYMENT_ALLOCATION_REVIEW');
    const payment = ticket.segments[0].payment_ref;
    const c = isProtected
      ? { direction: 'REFUND' as const, fee: ZERO }
      : cancellation(
          ticket.airline,
          ticket.fare_type,
          ticket.segments.every((s) => s.domestic),
          first,
          at,
          rules,
        );
    const refundable = c.direction === 'NONE' ? ZERO : positive(sub(fare, c.fee));
    if (c.direction !== 'NONE')
      line(
        'FARE',
        c.direction,
        refundable,
        null,
        `${ticket.id}:fare`,
        isProtected ? '6.2' : '3',
        c.direction === 'CREDIT' ? null : payment,
      );
    const loss = sub(fare, refundable);
    if (nano(loss) > 0n)
      line(
        c.direction === 'NONE' ? 'FARE' : 'CANCELLATION_FEE',
        'FORFEIT',
        loss,
        null,
        `${ticket.id}:fare-loss`,
        '3',
        payment,
      );
    for (const s of ticket.segments)
      if (!s.tax_refunded)
        line(
          'TAX',
          'REFUND',
          s.tax!,
          s.id,
          `${s.id}:tax`,
          isProtected ? '6.2' : '3.2',
          s.payment_ref,
        );
    for (const e of ticket.extras)
      if (!e.used && !e.refunded)
        line(
          'EXTRA',
          isProtected ? 'REFUND' : 'FORFEIT',
          e.amount,
          e.segment_id,
          e.id,
          isProtected ? '6.2' : '3.2',
          payment,
        );
  } else {
    if (!isProtected && noShow)
      return stop('DENIED', 'NO_SHOW_REMAINING_SEGMENTS_SUSPENDED', [
        'UNUSED_TAX_REFUND_ELIGIBILITY',
      ]);
    if (
      !target.replacements.length ||
      new Set(target.replacements.map((r) => r.segment_id)).size !== target.replacements.length
    )
      return stop('NEEDS_INFO', 'SELECT_REPLACEMENT_FLIGHTS');
    const replacementFares = new Set<Fare>();
    for (const replace of target.replacements) {
      const s = ticket.segments.find((s) => s.id === replace.segment_id),
        o = offers.find((o) => o.id === replace.offer_id);
      if (!s || !o) return stop('CONFLICT', 'REPLACEMENT_NOT_FOUND');
      if (s.state === 'USED') return stop('DENIED', 'SEGMENT_ALREADY_USED');
      if (
        o.airline !== ticket.airline ||
        o.origin !== s.origin ||
        o.destination !== s.destination ||
        o.domestic !== s.domestic
      )
        return stop('MANUAL_REVIEW', 'ROUTE_CHANGE_REVIEW');
      if (o.departure_at_ms <= at || o.arrival_at_ms <= o.departure_at_ms)
        return stop('DENIED', 'REPLACEMENT_ALREADY_DEPARTED');
      replacementFares.add(o.fare_type);
      if (ranks.indexOf(o.fare_type) < ranks.indexOf(ticket.fare_type))
        return stop('DENIED', 'DOWNGRADE_NOT_ALLOWED');
      if (!s.fare || !s.tax || s.tax_refunded)
        return stop('MANUAL_REVIEW', 'MISSING_OR_CONSUMED_PRICE_ENTITLEMENT');
      try {
        settlement(o.fare);
        settlement(o.tax);
        timestamp(o.departure_at_ms);
        timestamp(o.arrival_at_ms);
      } catch {
        return stop('CONFLICT', 'INVALID_OFFER');
      }
      if (
        ticket.extras.some((e) => e.segment_id === s.id && !e.used && !e.refunded) &&
        !o.services_available
      )
        return stop('MANUAL_REVIEW', 'EXTRA_SERVICE_UNAVAILABLE');
      if (isProtected) {
        if (
          o.fare_type !== ticket.fare_type ||
          Math.abs(utcDay(o.departure_at_ms) - utcDay(s.original_departure_at_ms)) > 7
        )
          return stop('DENIED', 'DISRUPTION_REPLACEMENT_OUTSIDE_TERMS');
      } else {
        const fee = changeFee(
          ticket.airline,
          ticket.fare_type,
          s.domestic,
          ticket.original_issued_at_ms,
          s.departure_at_ms,
          at,
          rules,
        );
        if (fee === null) return stop('DENIED', 'CHANGE_NOT_ALLOWED_IN_WINDOW');
        line('CHANGE_FEE', 'COLLECT', fee, s.id, `${s.id}:change-fee`, '2.1', s.payment_ref);
        line(
          'FARE_DIFFERENCE',
          'COLLECT',
          positive(sub(o.fare, s.fare)),
          s.id,
          `${s.id}:fare-difference`,
          '2.2',
          s.payment_ref,
        );
        const delta = sub(o.tax, s.tax);
        if (nano(delta) > 0n)
          line('TAX', 'COLLECT', delta, s.id, `${s.id}:tax-adjustment`, '2.2', s.payment_ref);
        if (nano(delta) < 0n)
          line(
            'TAX',
            'REFUND',
            sub(s.tax, o.tax),
            s.id,
            `${s.id}:tax-adjustment`,
            '2.2',
            s.payment_ref,
          );
      }
    }
    if (
      replacementFares.size > 1 ||
      (replacementFares.values().next().value !== ticket.fare_type &&
        target.replacements.length !== ticket.segments.length)
    )
      return stop('MANUAL_REVIEW', 'MIXED_FARE_UPGRADE_REVIEW');
    const ordered = ticket.segments.map((s) => {
      const r = target.replacements.find((r) => r.segment_id === s.id);
      return r ? offers.find((o) => o.id === r.offer_id)! : s;
    });
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i].departure_at_ms <= ordered[i - 1].arrival_at_ms)
        return stop('DENIED', 'ITINERARY_TIME_CONFLICT');
  }
  result.totals = totalLines(result.lines);
  result.reasons.push(isProtected ? 'DISRUPTION_PROTECTION' : 'POLICY_APPLIED');
  return result;
}
export function combineDecisions(ds: Decision[]): Decision {
  const failed = ds.filter((d) => d.status !== 'ALLOWED');
  if (failed.length) {
    const order: DecisionStatus[] = [
      'CONFLICT',
      'NOT_COVERED',
      'MANUAL_REVIEW',
      'NEEDS_INFO',
      'DENIED',
    ];
    return {
      ...emptyDecision(order.find((s) => failed.some((d) => d.status === s))!),
      reasons: [...new Set(failed.flatMap((d) => d.reasons))],
      known_rights: [...new Set(ds.flatMap((d) => d.known_rights))],
      sources: ds.flatMap((d) => d.sources),
    };
  }
  const lines = ds.flatMap((d) => d.lines);
  return {
    ...emptyDecision(),
    lines,
    totals: totalLines(lines),
    sources: ds.flatMap((d) => d.sources),
    reasons: [...new Set(ds.flatMap((d) => d.reasons))],
  };
}
export interface Bag {
  type: 'PERSONAL' | 'CABIN' | 'CHECKED';
  weight_kg: number;
  dimensions_cm: [number, number, number];
}
export function baggage(
  airline: Airline,
  fare: Fare,
  domestic: boolean,
  bags: Bag[] = [],
  rules: RuleSet = policy,
) {
  const [cabinKg, checkedCount, checkedKg] = rules.baggage[fareKey(airline, domestic)][fare];
  const [extraPrice, extraKg] = rules.extra_bag[airline];
  let extra = ZERO,
    status: DecisionStatus = 'ALLOWED',
    reason = 'WITHIN_ALLOWANCE';
  const counts = { PERSONAL: 0, CABIN: 0, CHECKED: 0 };
  // Assign the smaller checked bags to the included allowance first. The same
  // physical bag set must not fail solely because the user listed its 23kg extra first.
  const orderedBags = [...bags].sort((a, b) =>
    a.type === 'CHECKED' && b.type === 'CHECKED'
      ? a.weight_kg - b.weight_kg
      : a.type.localeCompare(b.type),
  );
  for (const bag of orderedBags) {
    counts[bag.type]++;
    if (
      !Number.isFinite(bag.weight_kg) ||
      bag.weight_kg <= 0 ||
      bag.dimensions_cm.some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error('INVALID_BAG');
    const dims = [...bag.dimensions_cm].sort((a, b) => b - a);
    let allowed = true;
    if (bag.type === 'PERSONAL')
      allowed =
        counts.PERSONAL <= 1 && bag.weight_kg <= 3 && dims.every((x, i) => x <= [40, 30, 15][i]);
    if (bag.type === 'CABIN') {
      const paid = airline === 'BHA' && fare === 'Basic';
      allowed =
        counts.CABIN <= 1 &&
        bag.weight_kg <= (paid ? 7 : cabinKg) &&
        dims.every((x, i) => x <= [55, 35, 25][i]);
      if (paid && allowed) extra = add(extra, usd(25));
    }
    if (bag.type === 'CHECKED') {
      const paid = counts.CHECKED > checkedCount;
      allowed =
        counts.CHECKED <= checkedCount + 1 &&
        bag.weight_kg <= (paid ? extraKg : checkedKg) &&
        dims.reduce((a, b) => a + b, 0) <= 158;
      if (paid && allowed) extra = add(extra, usd(extraPrice));
    }
    if (!allowed) {
      status = 'MANUAL_REVIEW';
      reason = 'BAG_OUTSIDE_PUBLISHED_ALLOWANCE';
    }
  }
  return {
    airline,
    fare_type: fare,
    domestic,
    status,
    reason,
    evaluated_bag_count: bags.length,
    extra_fee_per_person_per_segment: status === 'ALLOWED' ? extra : null,
    personal: { count: 1, kg: 3, dimensions: [40, 30, 15] },
    cabin: { count: cabinKg ? 1 : 0, kg: cabinKg, dimensions: [55, 35, 25] },
    checked: { count: checkedCount, kg_each: checkedKg, sum_cm: 158 },
    extra_checked: { count: 1, kg: extraKg, sum_cm: 158, fee: usd(extraPrice) },
    paid_cabin: airline === 'BHA' && fare === 'Basic' ? { count: 1, kg: 7, fee: usd(25) } : null,
    sources: [{ airline, section: '7', page: 5, rule_id: `${airline}:7` }],
    purchase_supported: false,
  };
}
