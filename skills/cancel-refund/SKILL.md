---
name: cancel-refund
description: Prepare voluntary whole-ticket cancellation or unused-tax requests.
---

Tool contract: 1

Use quote_operation after the ticket is explicit. Separate collect, cash refund, credit and forfeit. Return deterministic decision and sources even if denied. Active travel tax conflicts and partly used refunds may need review. No chat confirmation can execute money movement.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
