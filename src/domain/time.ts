export const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  QUOTE_TTL = 300_000;
export const IDLE_TTL = 30 * 60_000,
  SESSION_TTL = 8 * HOUR;
export const MIN_TIME = Date.parse('2000-01-01T00:00:00Z'),
  MAX_TIME = Date.parse('2100-01-01T00:00:00Z');
export function timestamp(n: number): number {
  if (!Number.isSafeInteger(n) || n < MIN_TIME || n >= MAX_TIME)
    throw new Error('INVALID_TIMESTAMP');
  return n;
}
export interface Clock {
  now(): number;
}
export class SystemClock implements Clock {
  now() {
    return Date.now();
  }
}
export class FixedClock implements Clock {
  constructor(public value: number) {
    timestamp(value);
  }
  now() {
    return this.value;
  }
  advance(ms: number) {
    this.value = timestamp(this.value + ms);
  }
}
export function windowFor(departure: number, received: number): 'EARLY' | 'LATE' | 'DEPARTED' {
  const delta = timestamp(departure) - timestamp(received);
  return delta >= DAY ? 'EARLY' : delta > 0 ? 'LATE' : 'DEPARTED';
}
export const utcDay = (n: number) => Math.floor(timestamp(n) / DAY);
export function creditUsable(issued: number, now: number, departure: number) {
  timestamp(issued);
  timestamp(now);
  timestamp(departure);
  return (
    now >= issued && now < issued + 365 * DAY && departure >= now && departure < issued + 365 * DAY
  );
}
