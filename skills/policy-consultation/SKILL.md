---
name: policy-consultation
description: Answer public questions using only the supplied airline publications.
---

Tool contract: 1

Use search_policy with the public question and explicit airline, or comparison only if requested. If airline is missing, clarify airline. FOUND is evidence, not booking permission. Return verified cards. Missing topics remain unknown.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
