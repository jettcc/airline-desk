/** google.type.Money semantics; no floating-point money arithmetic. */
export interface Money {
  currencyCode: 'USD';
  units: string;
  nanos: number;
}
const BILLION = 1_000_000_000n;
const MAX = 9_223_372_036_854_775_807n;
const MIN = -9_223_372_036_854_775_808n;
export function nano(value: Money): bigint {
  if (
    !value ||
    value.currencyCode !== 'USD' ||
    typeof value.units !== 'string' ||
    !/^-?(0|[1-9]\d*)$/.test(value.units) ||
    value.units === '-0'
  )
    throw new Error('INVALID_MONEY');
  const u = BigInt(value.units),
    n = value.nanos;
  if (
    u < MIN ||
    u > MAX ||
    !Number.isInteger(n) ||
    Math.abs(n) > 999_999_999 ||
    (u > 0n && n < 0) ||
    (u < 0n && n > 0)
  )
    throw new Error('INVALID_MONEY');
  return u * BILLION + BigInt(n);
}
export function fromNano(n: bigint): Money {
  const m: Money = {
    currencyCode: 'USD',
    units: (n / BILLION).toString(),
    nanos: Number(n % BILLION),
  };
  nano(m);
  return m;
}
export function usd(value: string | number): Money {
  // Numeric input is permitted only for whole-dollar constants, never decimal JS numbers.
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('USE_DECIMAL_STRING');
  const match = String(value).match(/^(-?)(0|[1-9]\d*)(?:\.(\d{1,9}))?$/);
  if (!match) throw new Error('INVALID_MONEY');
  return fromNano(
    (match[1] ? -1n : 1n) * (BigInt(match[2]) * BILLION + BigInt((match[3] ?? '').padEnd(9, '0'))),
  );
}
export const ZERO = usd(0);
export const add = (...xs: Money[]) => fromNano(xs.reduce((n, x) => n + nano(x), 0n));
export const sub = (a: Money, b: Money) => fromNano(nano(a) - nano(b));
export const positive = (m: Money) => (nano(m) > 0n ? m : ZERO);
export function multiply(m: Money, count: number): Money {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('INVALID_MULTIPLIER');
  return fromNano(nano(m) * BigInt(count));
}
export function settlement(m: Money, nonnegative = true): Money {
  const n = nano(m);
  if (n % 10_000_000n || (nonnegative && n < 0n)) throw new Error('INVALID_SETTLEMENT');
  return m;
}
export function moneyText(m: Money): string {
  const n = nano(m),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${a / BILLION}.${((a % BILLION) / 10_000_000n).toString().padStart(2, '0')}`;
}
