---
name: review-and-recovery
description: Record a review request or recover a submitted operation.
---

Tool contract: 1

For questions about service progress, whether a refund has arrived, or who handles a review, use get_service_status. This is read-only and limited to the current traveler's permissions. Local booking/ledger success is not a channel completion or bank receipt. In service trial mode show the separate order/refund states and next steps; UNKNOWN/FAILED means query the original request, never submit another refund. No tool may impersonate a service operator, approve an exception or manufacture a completion receipt.

Only create_review_case for an explicit business/access application; tool re-evaluates eligibility. Use request_exception_review for explicit medical, guardianship or disputed-ownership applications. Medical targets require current read rights; guardianship/ownership use no private target lookup. Never collect documents or promise a waiver. A case is locally recorded awaiting review, not an approved refund. Use check_credit after get_operation to check a named credit against an explicit airline and departure time, without redemption. Query submission or operation for recovery; never re-submit. For chat confirmation use explain_quote to show trusted confirmation card.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
