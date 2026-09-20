import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usd,
  nano,
  add,
  sub,
  multiply,
  moneyText,
  fromNano,
  settlement,
} from '../src/domain/money.js';
import { DAY, HOUR, windowFor, creditUsable, timestamp } from '../src/domain/time.js';
import {
  changeFee,
  cancellation,
  evaluateTicket,
  baggage,
  protection,
} from '../src/domain/rules.js';
import { sampleTicket } from '../src/server/seed.js';
import type { Airline, Fare, Offer, Target } from '../src/domain/types.js';
import { BASE } from './helpers.js';
test('Money exact decimals, signed nanos, large int64 and settlement boundaries', () => {
  assert.equal(moneyText(add(usd('0.10'), usd('0.20'))), '0.30');
  assert.equal(moneyText(sub(usd('1'), usd('1.01'))), '-0.01');
  assert.equal(nano(usd('123.123456789')), 123123456789n);
  const big = usd('9223372036854775807.999999999');
  assert.deepEqual(fromNano(nano(big)), big);
  assert.throws(() => add(big, usd('0.000000001')));
  assert.throws(() => nano({ currencyCode: 'USD', units: '1', nanos: -1 }));
  assert.throws(() => settlement(usd('0.001')));
  assert.throws(() => usd(0.1));
  assert.throws(() => multiply(usd(1), 1.1));
  assert.throws(() => nano({ currencyCode: 'EUR', units: '1', nanos: 0 } as any));
  assert.throws(() => usd('01.00'));
});
test('UTC milliseconds and exact duration boundaries', () => {
  assert.equal(windowFor(BASE + DAY, BASE), 'EARLY');
  assert.equal(windowFor(BASE + DAY - 1, BASE), 'LATE');
  assert.equal(windowFor(BASE, BASE), 'DEPARTED');
  assert.throws(() => timestamp(Math.floor(BASE / 1000)));
  assert.equal(Date.parse('2026-09-18T08:00:00+08:00'), BASE);
  assert.ok(creditUsable(BASE, BASE + DAY, BASE + 365 * DAY - 1));
  assert.equal(creditUsable(BASE, BASE + 365 * DAY, BASE + 365 * DAY), false);
});
const feeCases: [Airline, Fare, boolean, number | null, number | null][] = [
  ['NSA', 'Basic', true, 70, null],
  ['NSA', 'Standard', true, 25, 60],
  ['NSA', 'Flex', true, 0, 0],
  ['BHA', 'Basic', true, null, null],
  ['BHA', 'Standard', true, 55, null],
  ['BHA', 'Flex', true, 15, 45],
  ['STA', 'Basic', true, 40, null],
  ['STA', 'Basic', false, null, null],
  ['STA', 'Standard', true, 20, 50],
  ['STA', 'Standard', false, 65, 100],
  ['STA', 'Flex', true, 0, 0],
  ['STA', 'Flex', false, 0, 25],
];
for (const [a, f, dom, early, late] of feeCases)
  test(`Independent change-fee table ${a}/${f}/${dom}`, () => {
    for (const [depart, expected] of [
      [BASE + DAY, early],
      [BASE + DAY - 1, late],
      [BASE, null],
    ] as const) {
      const got = changeFee(a, f, dom, Date.parse('2026-07-01T00:00:00Z'), depart, BASE);
      assert.equal(
        got === null ? null : moneyText(got),
        expected === null ? null : `${expected}.00`,
      );
    }
  });
test('Bluehaven original issuance, including exact cutoff and retained old issuance', () => {
  for (const [issued, expected] of [
    [Date.parse('2026-07-01T00:00:00Z') - 1, '85.00'],
    [Date.parse('2026-07-01T00:00:00Z'), '55.00'],
  ] as const)
    assert.equal(
      moneyText(changeFee('BHA', 'Standard', true, issued, BASE + DAY, BASE)!),
      expected,
    );
});
const cancellationCases: [Airline, Fare, boolean, string, number, string, number][] = [
  ['NSA', 'Basic', true, 'NONE', 0, 'NONE', 0],
  ['NSA', 'Standard', true, 'CREDIT', 40, 'CREDIT', 80],
  ['NSA', 'Flex', true, 'REFUND', 0, 'REFUND', 0],
  ['BHA', 'Basic', true, 'NONE', 0, 'NONE', 0],
  ['BHA', 'Standard', true, 'NONE', 0, 'NONE', 0],
  ['BHA', 'Flex', true, 'CREDIT', 30, 'NONE', 0],
  ['STA', 'Basic', true, 'NONE', 0, 'NONE', 0],
  ['STA', 'Basic', false, 'NONE', 0, 'NONE', 0],
  ['STA', 'Standard', true, 'CREDIT', 25, 'NONE', 0],
  ['STA', 'Standard', false, 'NONE', 0, 'NONE', 0],
  ['STA', 'Flex', true, 'REFUND', 0, 'REFUND', 20],
  ['STA', 'Flex', false, 'REFUND', 50, 'CREDIT', 75],
];
for (const [a, f, dom, ed, ef, ld, lf] of cancellationCases)
  test(`Independent cancellation table ${a}/${f}/${dom}`, () => {
    for (const [depart, dir, fee] of [
      [BASE + DAY, ed, ef],
      [BASE + DAY - 1, ld, lf],
    ] as const) {
      const c = cancellation(a, f, dom, depart, BASE);
      assert.equal(c.direction, dir);
      assert.equal(moneyText(c.fee), `${fee}.00`);
    }
  });
test('Per-segment positive difference: collect 88, tax refund 5, no 40 offset', () => {
  const t = sampleTicket('T', 'NSA', 'Standard', BASE);
  t.segments.push({
    ...t.segments[0],
    id: 'S2',
    origin: 'BAY',
    destination: 'AST',
    departure_at_ms: BASE + 4 * DAY,
    arrival_at_ms: BASE + 4 * DAY + HOUR,
  });
  const os = t.segments.map((s, i): Offer => ({
    id: `O${i}`,
    airline: 'NSA',
    flight_id: `F${i}`,
    origin: s.origin,
    destination: s.destination,
    domestic: true,
    departure_at_ms: s.departure_at_ms + DAY,
    arrival_at_ms: s.arrival_at_ms + DAY,
    fare_type: 'Standard',
    fare: usd(i ? 60 : 130),
    tax: usd(i ? 15 : 28),
    services_available: true,
    version: 1,
  }));
  const target: Target = {
    ticket_id: t.id,
    segment_ids: [],
    replacements: t.segments.map((s, i) => ({ segment_id: s.id, offer_id: `O${i}` })),
  };
  const r = evaluateTicket(t, 'CHANGE', target, os, BASE);
  assert.equal(r.status, 'ALLOWED');
  assert.equal(moneyText(r.totals.collect), '88.00');
  assert.equal(moneyText(r.totals.refund), '5.00');
});
test('Nonrefundable fare still permits cancellation/tax; floor at zero; no tax guessing', () => {
  const t = sampleTicket('T', 'NSA', 'Basic', BASE),
    target = { ticket_id: 'T', replacements: [], segment_ids: [] };
  let r = evaluateTicket(t, 'CANCEL', target, [], BASE);
  assert.equal(r.status, 'ALLOWED');
  assert.equal(moneyText(r.totals.refund), '20.00');
  assert.equal(moneyText(r.totals.credit), '0.00');
  t.fare_type = 'Standard';
  t.segments[0].fare = usd(20);
  r = evaluateTicket(t, 'CANCEL', target, [], BASE);
  assert.equal(moneyText(r.totals.credit), '0.00');
  assert.equal(moneyText(r.totals.collect), '0.00');
  t.segments[0].tax = null;
  assert.equal(evaluateTicket(t, 'CANCEL', target, [], BASE).status, 'NEEDS_INFO');
});
test('Disruption thresholds, notice period, used portion, no-show priority', () => {
  for (const [a, threshold] of [
    ['NSA', 120],
    ['STA', 120],
    ['BHA', 180],
  ] as const) {
    const t = sampleTicket('T', a, 'Basic', BASE);
    t.disruption = {
      id: 'D',
      segment_id: t.segments[0].id,
      kind: 'SCHEDULE_CHANGE',
      notified_at_ms: BASE - 30 * DAY,
      new_departure_at_ms: t.segments[0].original_departure_at_ms + threshold * 60000,
      consumed: false,
    };
    assert.equal(protection(t, BASE), 'ELIGIBLE');
    assert.equal(protection(t, BASE + 1), 'EXPIRED');
    t.disruption.new_departure_at_ms--;
    assert.equal(protection(t, BASE), 'NONE');
    t.disruption.new_departure_at_ms = t.segments[0].original_departure_at_ms - threshold * 60000;
    assert.equal(protection(t, BASE), 'ELIGIBLE');
    t.state = 'SUSPENDED';
    t.segments[0].state = 'NO_SHOW';
    assert.equal(
      evaluateTicket(
        t,
        'DISRUPTION_REFUND',
        { ticket_id: 'T', replacements: [], segment_ids: [] },
        [],
        BASE,
      ).status,
      'ALLOWED',
    );
    t.segments[0].state = 'USED';
    assert.equal(
      evaluateTicket(
        t,
        'DISRUPTION_REFUND',
        { ticket_id: 'T', replacements: [], segment_ids: [] },
        [],
        BASE,
      ).status,
      'DENIED',
    );
    t.segments.push({ ...t.segments[0], id: 'UNUSED', state: 'UNUSED' });
    t.disruption.segment_id = 'UNUSED';
    const r = evaluateTicket(
      t,
      'DISRUPTION_REFUND',
      { ticket_id: 'T', replacements: [], segment_ids: [] },
      [],
      BASE,
    );
    assert.equal(r.status, 'MANUAL_REVIEW');
    assert.ok(r.known_rights.includes('UNUSED_AFFECTED_PORTION_REFUND_RIGHT'));
  }
});
test('Baggage purchase weight separate from free weight and no pooling', () => {
  const b = baggage('BHA', 'Basic', true);
  assert.equal(b.cabin.count, 0);
  assert.equal(b.checked.count, 0);
  assert.equal(moneyText(b.paid_cabin!.fee), '25.00');
  const sta = baggage('STA', 'Standard', true, [
    { type: 'CHECKED', weight_kg: 20, dimensions_cm: [50, 50, 58] },
    { type: 'CHECKED', weight_kg: 23, dimensions_cm: [50, 50, 58] },
  ]);
  assert.equal(sta.status, 'ALLOWED');
  assert.equal(moneyText(sta.extra_fee_per_person_per_segment!), '50.00');
  assert.equal(
    baggage('NSA', 'Flex', true, [{ type: 'CHECKED', weight_kg: 46, dimensions_cm: [50, 50, 58] }])
      .status,
    'MANUAL_REVIEW',
  );
  assert.equal(
    baggage('BHA', 'Basic', true, [{ type: 'CABIN', weight_kg: 7.01, dimensions_cm: [55, 35, 25] }])
      .status,
    'MANUAL_REVIEW',
  );
});
test('Missed earlier unused segment blocks changing a future segment; used segment does not', () => {
  const t = sampleTicket('T', 'NSA', 'Flex', BASE);
  const future = { ...t.segments[0], id: 'future', origin: 'BAY', destination: 'AST' };
  t.segments[0].departure_at_ms = BASE;
  t.segments[0].arrival_at_ms = BASE + HOUR;
  t.segments.push(future);
  const o: Offer = {
    id: 'new',
    airline: 'NSA',
    flight_id: 'new-flight',
    origin: 'BAY',
    destination: 'AST',
    domestic: true,
    departure_at_ms: BASE + 3 * DAY,
    arrival_at_ms: BASE + 3 * DAY + HOUR,
    fare_type: 'Flex',
    fare: usd(100),
    tax: usd(20),
    services_available: true,
    version: 1,
  };
  const target = {
    ticket_id: 'T',
    segment_ids: [],
    replacements: [{ segment_id: 'future', offer_id: 'new' }],
  };
  assert.equal(evaluateTicket(t, 'CHANGE', target, [o], BASE).status, 'DENIED');
  t.segments[0].state = 'USED';
  assert.equal(evaluateTicket(t, 'CHANGE', target, [o], BASE).status, 'ALLOWED');
});
