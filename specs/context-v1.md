# Context V1

## Scope & Applicability

This document is normative and describes the context document admitted by
`validateContextDocument` against `context-v1.schema.json`. A context document
binds one project to a deduplicated, ordered set of live work and knowledge
identifiers at a strict generation instant. It inherits every canonical-JSON,
ordering, instant, identifier, and extension rule from `protocol-common-v1`. A
context document carries the AOS requirement `AOS-REQ-008` (deterministic
context). This document also anchors the context-route injection budgets that
the retired activation ladder's session-start summary and persona rendering cited.

## Record Shape

The field set is exact and closed (`additionalProperties: false`): a context
document has precisely `schemaVersion`, `id`, `projectId`, `workIds`,
`knowledgeIds`, `generatedAt`, and `extensions`, with no other keys.

| Field           | Rule                                                      |
| --------------- | -------------------------------------------------------- |
| `schemaVersion` | the constant string `tcrn.context.v1`                    |
| `id`            | a `stableId`                                             |
| `projectId`     | the anchoring project `stableId`                         |
| `workIds`       | an array of unique `stableId`, complete within the executing runtime    |
| `knowledgeIds`  | an array of unique `stableId`, complete within the executing runtime    |
| `generatedAt`   | a `strictInstant`                                        |
| `extensions`    | the shared closed extension map (complete within the executing runtime)     |

Both identifier arrays are validated by `assertSortedUnique`: each element is a
protocol identifier, the array is duplicate-free, and it is already sorted in
`utf8-byte-order-v1` order. Every referenced identifier must resolve to a live
(non-tombstoned) record of the same `projectId` in the supplied work graph and
knowledge set; the work graph itself is validated by the work-model rules.

## Digest & Canonicalization

A context document is hashed with the shared `canonicalSha256` rules: recursive
key ordering by `utf8-byte-order-v1`, safe integers only, one terminal LF.
Producers MUST sort `workIds` and `knowledgeIds` before hashing or exchange; an
unsorted array is rejected rather than silently reordered, so the hashed bytes
are a stable function of the referenced set.

## Context-route injection budgets

The current command catalog exposes context-document admission, not the retired
fixed-budget context router. The former 1024/4096/65536-byte and 16/64-count
router table is not a current product capacity contract. Current injection and
retrieval consumers read the selected project's settings; callers can choose
explicit prompt/result budgets. Those budgets limit a chosen response window,
not storage, replay, canonical admission or the complete dataset. A host's actual
immutable input capacity remains separate and must be observed from that host.

## Reason Codes

Context-document admission emits codes from the shared `PROTOCOL_REASON_CODES`
list: `RECORD_MALFORMED`, `CANONICAL_VALUE_INVALID`, `ID_INVALID`,
`TIMESTAMP_INVALID`, `INPUT_OVERSIZED`, `CANONICALIZATION_MISMATCH` (an unsorted
identifier array), `REFERENTIAL_INTEGRITY` (a referenced identifier absent or
cross-project), `TOMBSTONE_REFERENCED` (a referenced record is tombstoned), and
`UNKNOWN_REQUIRED_EXTENSION`. Context routing emits its own `CONTEXT_*` codes,
including the budget codes above.

## Ordering & Determinism

Both identifier arrays are total-ordered by `utf8-byte-order-v1` and are the only
ordered arrays in the record; object keys serialize in the same order under
canonical JSON. Given the same live references, the emitted bytes and digest are
identical across producers.

## Failure Semantics

Admission is fail-closed and total: a context builder MUST resolve every
non-tombstoned reference before emission, and the first violated rule throws with
its specific reason code and no document is returned. Unknown optional extensions
are preserved byte-semantically; an unknown required extension prevents
admission.

## Non-Goals

A context document does not embed record bodies, transport, credentials, or a
live-service claim; it references identifiers only. The context-route budget
table governs injection sizing, not membership. Building the underlying work
graph and knowledge records is out of scope here.
