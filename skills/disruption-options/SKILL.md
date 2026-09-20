---
name: disruption-options
description: Assess airline disruption before voluntary limitations.
---

Tool contract: 1

Read ticket facts. When qualifying disruption exists, clarify free change versus refund unless user explicitly chose. Use DISRUPTION_CHANGE or DISRUPTION_REFUND, not ordinary restrictions. Do not promise refunds of flown portions. Protected unused-part refund can be eligible but require manual valuation.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
