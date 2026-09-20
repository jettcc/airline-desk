import type { Store } from './db.js';
import type { Ticket, Offer, Airline, Fare } from '../domain/types.js';
import { DAY, HOUR } from '../domain/time.js';
import { usd, add } from '../domain/money.js';
export const DEMO_ACTORS = [
  { id: 'alice', name: '林怡 · 旅客', traveler_id: 'traveler-alice' },
  { id: 'bob', name: '陈平 · 同行旅客', traveler_id: 'traveler-bob' },
  { id: 'agent', name: '许悦 · 已授权代理', traveler_id: 'traveler-agent' },
];
export function sampleTicket(
  id: string,
  airline: Airline,
  fare: Fare,
  at: number,
  options: Partial<Ticket> = {},
): Ticket {
  return {
    id,
    booking_id: id.split('-').slice(0, -1).join('-') || id,
    traveler_id: 'traveler-alice',
    traveler_name: '林怡',
    airline,
    fare_type: fare,
    original_issued_at_ms: Date.parse('2026-07-01T00:00:00Z'),
    version: 1,
    channel: 'DIRECT',
    state: 'ACTIVE',
    historical_value_unclear: false,
    disruption: null,
    extras: [],
    segments: [
      {
        id: `${id}-S1`,
        flight_id: `${id}-F1`,
        origin: 'AST',
        destination: 'BAY',
        domestic: true,
        original_departure_at_ms: at + 30 * HOUR,
        departure_at_ms: at + 30 * HOUR,
        arrival_at_ms: at + 32 * HOUR,
        state: 'UNUSED',
        fare: usd(100),
        tax: usd(20),
        tax_refunded: false,
        payment_ref: `PAY-${id}`,
      },
    ],
    ...options,
  };
}
export function seed(store: Store, at: number) {
  if (store.get('SELECT id FROM actors LIMIT 1')) return;
  store.tx(() => {
    store.run("INSERT OR REPLACE INTO meta VALUES ('seed_at_ms',?)", String(at));
    for (const a of DEMO_ACTORS)
      store.run('INSERT INTO actors VALUES (?,?,?)', a.id, a.name, a.traveler_id);
    const tickets: Ticket[] = [];
    for (const [suffix, traveler, name] of [
      ['A', 'traveler-alice', '林怡'],
      ['B', 'traveler-bob', '陈平'],
    ]) {
      const t = sampleTicket(`NSA-${suffix}`, 'NSA', 'Standard', at, {
        booking_id: 'DEMO-NSA',
        traveler_id: traveler,
        traveler_name: name,
      });
      t.segments[0].flight_id = 'NSA-ORIGINAL-1';
      t.segments.push({
        ...t.segments[0],
        id: `${t.id}-S2`,
        flight_id: 'NSA-ORIGINAL-2',
        origin: 'BAY',
        destination: 'AST',
        original_departure_at_ms: at + 4 * DAY,
        departure_at_ms: at + 4 * DAY,
        arrival_at_ms: at + 4 * DAY + 2 * HOUR,
      });
      tickets.push(t);
    }
    const cancel = sampleTicket('CANCEL-NSA-A', 'NSA', 'Standard', at, {
      booking_id: 'CANCEL-NSA',
    });
    cancel.extras = [
      {
        id: 'CANCEL-SEAT',
        segment_id: cancel.segments[0].id,
        type: 'SEAT',
        amount: usd(10),
        used: false,
        refunded: false,
      },
    ];
    tickets.push(cancel);
    for (const [suffix, date] of [
      ['OLD', '2026-06-30T23:59:59.999Z'],
      ['NEW', '2026-07-01T00:00:00Z'],
    ])
      tickets.push(
        sampleTicket(`BHA-${suffix}-A`, 'BHA', 'Standard', at, {
          booking_id: `BHA-${suffix}`,
          original_issued_at_ms: Date.parse(date),
        }),
      );
    const mix = sampleTicket('STA-MIX-A', 'STA', 'Standard', at, { booking_id: 'STA-MIX' });
    mix.segments.push({
      ...mix.segments[0],
      id: 'STA-MIX-A-S2',
      flight_id: 'STA-MIX-A-F2',
      origin: 'BAY',
      destination: 'LUM',
      domestic: false,
      original_departure_at_ms: at + 36 * HOUR,
      departure_at_ms: at + 36 * HOUR,
      arrival_at_ms: at + 39 * HOUR,
    });
    tickets.push(mix);
    const disrupt = sampleTicket('BHA-DISRUPT-A', 'BHA', 'Basic', at, {
      booking_id: 'BHA-DISRUPT',
    });
    Object.assign(disrupt.segments[0], { fare: usd(200), tax: usd(30) });
    disrupt.disruption = {
      id: 'EVENT-BHA-180',
      segment_id: disrupt.segments[0].id,
      kind: 'SCHEDULE_CHANGE',
      notified_at_ms: at - HOUR,
      new_departure_at_ms: disrupt.segments[0].original_departure_at_ms + 3 * HOUR,
      consumed: false,
    };
    disrupt.segments[0].departure_at_ms += 3 * HOUR;
    disrupt.segments[0].arrival_at_ms += 3 * HOUR;
    disrupt.extras = [
      {
        id: 'DISRUPT-BAG',
        segment_id: disrupt.segments[0].id,
        type: 'BAG',
        amount: usd(40),
        used: false,
        refunded: false,
      },
      {
        id: 'DISRUPT-SEAT',
        segment_id: disrupt.segments[0].id,
        type: 'SEAT',
        amount: usd(10),
        used: false,
        refunded: false,
      },
    ];
    tickets.push(disrupt);
    const partial = sampleTicket('NSA-PARTIAL-A', 'NSA', 'Standard', at, {
      booking_id: 'NSA-PARTIAL',
    });
    partial.segments[0].state = 'USED';
    partial.segments[0].departure_at_ms = at - DAY;
    partial.segments[0].original_departure_at_ms = at - DAY;
    partial.segments[0].arrival_at_ms = at - DAY + 2 * HOUR;
    partial.segments.push({
      ...sampleTicket('PART-RETURN', 'NSA', 'Standard', at).segments[0],
      id: 'NSA-PARTIAL-A-S2',
      origin: 'BAY',
      destination: 'AST',
    });
    partial.disruption = {
      id: 'EVENT-PARTIAL',
      segment_id: 'NSA-PARTIAL-A-S2',
      kind: 'CANCELLED',
      notified_at_ms: at - HOUR,
      new_departure_at_ms: at + 32 * HOUR,
      consumed: false,
    };
    tickets.push(partial);
    const missed = sampleTicket('STA-MISSED-A', 'STA', 'Flex', at, {
      booking_id: 'STA-MISSED',
      state: 'SUSPENDED',
    });
    missed.segments[0].state = 'NO_SHOW';
    missed.segments[0].departure_at_ms = at - HOUR;
    missed.segments[0].original_departure_at_ms = at - HOUR;
    missed.segments[0].arrival_at_ms = at + HOUR;
    tickets.push(missed);
    const agency = sampleTicket('AGENT-NSA-A', 'NSA', 'Flex', at, {
      booking_id: 'AGENCY-NSA',
      channel: 'AGENT',
    });
    tickets.push(agency);
    for (const airline of ['NSA', 'BHA', 'STA'] as Airline[])
      for (const fare of ['Basic', 'Standard', 'Flex'] as Fare[])
        tickets.push(
          sampleTicket(`${airline}-${fare.toUpperCase()}-A`, airline, fare, at, {
            booking_id: `${airline}-${fare.toUpperCase()}`,
          }),
        );
    for (const t of tickets) {
      store.run(
        'INSERT INTO tickets VALUES (?,?,?,?,?)',
        t.id,
        t.booking_id,
        t.traveler_id,
        t.version,
        JSON.stringify(t),
      );
      for (const s of t.segments) {
        store.run('INSERT OR IGNORE INTO inventory VALUES (?,20,0)', s.flight_id);
        if (s.state === 'UNUSED') {
          store.run('INSERT INTO reservations VALUES (?,?,?)', t.id, s.id, s.flight_id);
          store.run('UPDATE inventory SET occupied=occupied+1 WHERE flight_id=?', s.flight_id);
        }
        if (s.state === 'USED') continue;
        for (const offset of [0, 1, 2, 3])
          for (const fare of ['Basic', 'Standard', 'Flex'] as Fare[]) {
            const departure = s.departure_at_ms + offset * DAY + 4 * HOUR;
            const flightId = `${t.airline}-${s.origin}-${s.destination}-${departure}`;
            const increment =
              t.booking_id === 'STA-MIX' ? 0 : t.booking_id === 'DEMO-NSA' ? 30 : 20;
            const tier =
              ['Basic', 'Standard', 'Flex'].indexOf(fare) -
              ['Basic', 'Standard', 'Flex'].indexOf(t.fare_type);
            const o: Offer = {
              id: `${s.id}-${fare}-${offset}`,
              airline: t.airline,
              flight_id: flightId,
              origin: s.origin,
              destination: s.destination,
              domestic: s.domestic,
              departure_at_ms: departure,
              arrival_at_ms: departure + (s.arrival_at_ms - s.departure_at_ms),
              fare_type: fare,
              fare: add(s.fare!, usd(increment + Math.max(tier, 0) * 50)),
              tax: s.tax!,
              services_available: true,
              version: 1,
            };
            store.run('INSERT OR IGNORE INTO inventory VALUES (?,12,0)', flightId);
            store.run(
              'INSERT INTO offers VALUES (?,?,?,?)',
              o.id,
              o.flight_id,
              o.version,
              JSON.stringify(o),
            );
          }
      }
      store.run(
        'INSERT INTO grants VALUES (?,?,?,?,?,?,0,1)',
        `G-${t.id}`,
        'agent',
        t.id,
        JSON.stringify([
          'READ',
          'CHANGE',
          'CANCEL',
          'TAX_REFUND',
          'DISRUPTION_CHANGE',
          'DISRUPTION_REFUND',
        ]),
        at - DAY,
        at + 365 * DAY,
      );
    }
  });
}
