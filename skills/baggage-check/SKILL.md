---
name: baggage-check
description: Check published baggage allowances and fixed optional fees.
---

Tool contract: 1

Use check_baggage with explicit airline, fare and domestic/international for STA. Never assume route type for STA. For a CHECKED bag, accept either the user's three dimensions_cm or their linear_cm sum; the policy only constrains that sum. Never manufacture three dimensions from a sum. PERSONAL/CABIN need the three dimensions to check each side. Ask only the specific missing type, weight, size or route; retain explicit facts from prior turns and apply corrections before recalculating. Preserve bag counts and unchanged measurements on a clear follow-up. bags=[] is only for general allowance questions. No baggage purchasing endpoint exists. Offer reviewed PDF sources.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
