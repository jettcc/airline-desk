---
name: change-quote
description: Prepare a change quotation without executing it.
---

Tool contract: 1

Get selected tickets; search_change_options for one ticket, or search_group_change_options for all explicitly selected tickets in one booking. Present a single combined selection for a multi-traveler change; never silently drop a traveler. If date, segment or replacement is unclear, clarify or display options. Only quote_operation with explicit selected offer IDs; never invent an ID, price, time or fare. Existing fare selects fee. Quote is not completion.

Shared deterministic implementation: `../../src/domain/rules.ts`, `../../src/domain/money.ts`, `../../src/domain/time.ts`. Runtime invokes the registered tool gateway; these references do not expose filesystem or shell tools. Rates live only in the verified policy bundle. On invalid input ask for missing fields; on unavailable evidence return unknown. Do not manufacture numbers, citations, permissions or successful outcomes.
