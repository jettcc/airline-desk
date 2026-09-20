// Booking/refund arithmetic remains the pinned v1 executor. Only public baggage
// measurement input is extended; never fabricate length/width/height from a sum.
export * from './rules-v1.js';
import { policy, type RuleSet } from './rules-v1.js';
import { add, usd, ZERO } from './money.js';
import type { Airline, Fare, DecisionStatus } from './types.js';
const fareKey = (airline: Airline, domestic: boolean) =>
  airline === 'STA' ? (domestic ? 'STA_DOM' : 'STA_INT') : airline;
export type Bag =
  | {
      type: 'PERSONAL' | 'CABIN' | 'CHECKED';
      weight_kg: number;
      dimensions_cm: [number, number, number];
    }
  | {
      type: 'CHECKED';
      weight_kg: number;
      linear_cm: number;
    };
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
      ('dimensions_cm' in bag
        ? bag.dimensions_cm.length !== 3 ||
          bag.dimensions_cm.some((n) => !Number.isFinite(n) || n <= 0)
        : bag.type !== 'CHECKED' || !Number.isFinite(bag.linear_cm) || bag.linear_cm <= 0)
    )
      throw new Error('INVALID_BAG');
    const dims = 'dimensions_cm' in bag ? [...bag.dimensions_cm].sort((a, b) => b - a) : [];
    const linear = 'linear_cm' in bag ? bag.linear_cm : dims.reduce((a, b) => a + b, 0);
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
        linear <= 158;
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
    evaluated_bags: bags,
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
