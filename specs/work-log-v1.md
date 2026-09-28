# Work-Log Convention V1

## Status and scope

This is a documentation-level convention (spec only). It defines how a worker
dispatch closes; it adds no schema, no engine code, and no enforcement hook in
this candidate. Enforcement is a host-adapter concern deferred to a later route.

## Dispatch closeout

Every worker dispatch closes with two artifacts:

1. a receipt (the existing receipt-v1 record), and
2. a work-log knowledge record.

The work-log record is an ordinary knowledge unit written through the
knowledge-core-v1 write path. It is retrievable as soon as it is written: there
is no candidate state and no promotion step (TCRN-CROSS-STORY-476 R1). It
carries:

- `kind`: `decision` or `summary`;
- a link to the dispatch `workId`, and to a `gateId` when the dispatch closed
  against a gate (grounded by gate-v1);
- a body size cap of 4096 bytes (a convention number that fits under the
  knowledge body budget);
- `promotionState` `promoted` — a work-log record is written official.
  TCRN-CROSS-STORY-365 (Owner ruling TCRN-CROSS-MIN-146) removed the promotion
  gate for the fragment kinds and TCRN-CROSS-INC-282 removed the last two
  branches that still parked a write, so every card written lifecycle `active`
  is written promoted whatever its kind; the earlier wording here, "never
  auto-promoted", named a behaviour the engine had already stopped having;
- lifecycle coupling: the record tombstones with its work item.

No second knowledge store is created; the single knowledge store holds work-log
records alongside other knowledge. High-frequency small records are bounded by
the size cap alone; the promotion state no longer bounds anything, which is why
the size cap is stated as the budget's only floor.

## Event linkage

A work-log record that closes out chain mutations binds itself to the events it
covers, so the audit trail runs from an accountable actor through a decision to the
evidence behind it. The linkage reuses fields the knowledge store already validates;
it adds no schema and no engine hook.

- Event references: each covered chain event is listed as a `sourceReferences`
  entry of the form `event:<eventHash>`, where `<eventHash>` is that event's
  `eventHash` (lowercase hex, in either event namespace: legacy `tcrn.event.v1` or
  `einzbern.event.v1`). The form is a stableId-safe,
  redaction-stable string, so it satisfies the source-reference grammar
  knowledge-core already enforces — bounded, printable, sorted, unique, and left
  unchanged by artifact redaction — with no new grammar.
- Accountable owner: the record's `accountableOwnerId` matches the actor
  attested on the covered events (actor-attestation-v1 `payload.actor`). When that
  actor carries the `owner:` prefix the match is exact string equality. When the
  attested actor is a `profile:` or `agent:` id, `accountableOwnerId` stays the
  owning `owner:` id — every knowledge write refuses any other accountable owner
  with `KNOWLEDGE_PROVENANCE_INVALID` — and the `profile:`/`agent:` actor id is
  carried as an additional `sourceReferences` entry.
- Evidence links: `linkedEvidenceIds` (and `linkedGateIds` where a gate closed the
  dispatch) carry the evidence knowledge ids exactly as today. At least one evidence
  id is this convention's requirement: the write path refuses a card that lacks a
  source reference or an evidence link (`KNOWLEDGE_PROVENANCE_INVALID`) only for the
  strict kinds in `scripts/policy/knowledge-provenance.json`, and a work-log record's
  `decision` and `summary` kinds are not among them.

The resulting audit walk runs one direction only: `event.payload.actor` -> work-log
record (found by its `event:<eventHash>` reference) -> `linkedEvidenceIds` /
`linkedGateIds` -> evidence. Reference direction is event -> actor (attested in the
chain) and work-log -> event; there is deliberately no event-side forward pointer to
knowledge, which would require mutating an event after the knowledge unit exists —
impossible on an append-only chain.

## Settings change as a decision record

A settings change is recorded as a decision, using the same convention: a work-log
knowledge record (`kind: decision`) that records the prior value, the new
value, the rationale, and a backlink to the overlay admission receipt. This
grounds the WS-I settings-elicitation flow: a recommended settings change becomes
an auditable decision, not a silent mutation.

## Residuals

There is no live enforcement and no automatic dispatch instrumentation in this
candidate, and a work-log record needs no promotion: it is retrievable as soon as
it is written. The convention is normative documentation; a governed
route may later add a host-adapter enforcement hook.
