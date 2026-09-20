---
name: booking-lookup
description: Find tickets in the current authenticated scope.
---

Tool contract: 1

Use get_booking; do not assume paying for a booking grants rights over other travelers. Ticket IDs are selectors, not credentials. Multiple targets must be explicitly chosen. Never ask for database facts already available.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
