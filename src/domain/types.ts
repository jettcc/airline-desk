import type { Money } from './money.js';
export type Airline = 'NSA' | 'BHA' | 'STA';
export type Fare = 'Basic' | 'Standard' | 'Flex';
export type Action = 'CHANGE' | 'CANCEL' | 'TAX_REFUND' | 'DISRUPTION_CHANGE' | 'DISRUPTION_REFUND';
export type DecisionStatus =
  'ALLOWED' | 'DENIED' | 'NEEDS_INFO' | 'MANUAL_REVIEW' | 'CONFLICT' | 'NOT_COVERED';
export interface Segment {
  id: string;
  flight_id: string;
  origin: string;
  destination: string;
  domestic: boolean;
  original_departure_at_ms: number;
  departure_at_ms: number;
  arrival_at_ms: number;
  state: 'UNUSED' | 'USED' | 'NO_SHOW' | 'SUSPENDED';
  fare: Money | null;
  tax: Money | null;
  tax_refunded: boolean;
  payment_ref: string;
}
export interface Extra {
  id: string;
  segment_id: string;
  type: 'SEAT' | 'BAG';
  amount: Money;
  used: boolean;
  refunded: boolean;
}
export interface Disruption {
  id: string;
  segment_id: string;
  kind: 'CANCELLED' | 'SCHEDULE_CHANGE';
  notified_at_ms: number;
  new_departure_at_ms: number;
  consumed: boolean;
}
export interface Ticket {
  id: string;
  booking_id: string;
  traveler_id: string;
  traveler_name: string;
  airline: Airline;
  fare_type: Fare;
  original_issued_at_ms: number;
  version: number;
  channel: 'DIRECT' | 'AGENT';
  state: 'ACTIVE' | 'CANCELLED' | 'SUSPENDED';
  segments: Segment[];
  extras: Extra[];
  disruption: Disruption | null;
  historical_value_unclear: boolean;
}
export interface Offer {
  id: string;
  airline: Airline;
  flight_id: string;
  origin: string;
  destination: string;
  domestic: boolean;
  departure_at_ms: number;
  arrival_at_ms: number;
  fare_type: Fare;
  fare: Money;
  tax: Money;
  services_available: boolean;
  version: number;
}
export interface Target {
  ticket_id: string;
  replacements: { segment_id: string; offer_id: string }[];
  segment_ids: string[];
}
export interface OperationRequest {
  action: Action;
  targets: Target[];
}
export interface Line {
  ticket_id: string;
  segment_id: string | null;
  entitlement_id: string;
  kind: 'CHANGE_FEE' | 'FARE_DIFFERENCE' | 'FARE' | 'TAX' | 'EXTRA' | 'CANCELLATION_FEE';
  direction: 'COLLECT' | 'REFUND' | 'CREDIT' | 'FORFEIT';
  amount: Money;
  payment_ref: string | null;
  rule_id: string;
}
export interface SourceRef {
  airline: Airline;
  section: string;
  page: number;
  rule_id: string;
}
export interface Decision {
  status: DecisionStatus;
  reasons: string[];
  known_rights: string[];
  lines: Line[];
  totals: { collect: Money; refund: Money; credit: Money; forfeit: Money };
  sources: SourceRef[];
}
export interface Quote {
  id: string;
  actor_id: string;
  session_id: string;
  conversation_id: string;
  intent_version: number;
  request: OperationRequest;
  decision: Decision;
  ticket_versions: Record<string, number>;
  offer_versions: Record<string, number>;
  bundle_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  confirmation_token: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'CONSUMED';
  display?: { tickets: Ticket[]; offers: Offer[] };
}
export interface Actor {
  id: string;
  name: string;
  traveler_id: string;
}
export interface Context {
  session_id: string;
  actor_id: string | null;
  csrf: string;
}
export interface Card {
  kind: string;
  data: any;
}
