# File-Native Knowledge Core V1

P4 Knowledge Core is an offline, metadata-first store layered beside the P3
Workspace authority. Initialization is clean and empty, and it always takes an
explicit per-invocation disposability acknowledgment; without it initialization
fails closed (a library has no workspace key to carry the `FIXTURE-` prefix that
old-layout fixtures were once admitted by). The store remains a disposable derived index that is
never the system of record. Initialization never searches, imports, migrates,
infers, or consults any predecessor knowledge or workflow source.

## Storage and authority

The store is a library's `crest/` directory (TCRN-CROSS-STORY-469 R1, 466 R1) with closed
`store.json`, `metadata/` and `bodies/` entries; initializing it adds nothing to the library
root, which keeps its seven entries. Metadata is the index authority. The index view,
`index.json`, is derived, so it is this device's cache, `cache/<library>/crest-views/` in the
device directory (469 R4): a read that finds it missing or out of date projects it again
instead of failing, and another device reading the same store projects its own. An
old-layout workspace's store (`knowledge/` in its control directory, with a
`views/index.json` entry) opens read-only; every write refuses with
`LEGACY_WORKSPACE_READ_ONLY`.
Bodies are separate single-link regular files and never appear in metadata
views, default selection, or checkpoints. Metadata listing, snippet, freshness,
and checkpoint surfaces enumerate the closed body-name set but never open or
read body files. Full validation and mutations validate all body bindings;
explicit body read validates only the requested body through its bound
descriptor.

The store marker binds the exact Workspace ID and event high-water digest. In a library they
are the library id and the library head, one digest over every stream's head, so the binding
moves with any entry of the version vector, whichever device wrote it. Every write runs under
this machine's lock of the library (`locks/<library>.lock` in the device directory, the lock
every chain write takes), and inside it all mutations require an exclusive no-follow claim and
exact store-version CAS. The lock serialises one machine's writers; nothing makes two devices'
concurrent crest writes safe against each other.
Re-verification, policy updates and article refreshes additionally require
record-revision CAS. Descriptor-bound reads
bind device, inode, size, mode, and nanosecond change metadata. Atomic
replacement uses exclusive no-follow temporary files. Link, special-file,
source-replacement, partial/crash, count, size, and aggregate violations fail
closed. P1 Option-B remains the ancestor-component threat boundary.

The legacy body-file wording above describes the compatibility reader. Current
local migrations may replace the body files with canonical NDJSON segments,
point indexes, and a manifest; metadata remains one record per id and is still
the authority. `knowledge.aggregateBytes` is the workspace setting for the
body bytes of live cards (see "Capacity"), with the fixed canonical ceiling as its
upper bound; the body layout (one file per card or segments) does not change the
count.

The user crest is shared between projects and can live in a synced folder. It
uses the same one-time root identity marker, then keeps immutable event streams
under `events/<device-id>/`. Each stream advances its own sequence and previous
event hash and each event binds its metadata to a body file in that stream.
Device-local locks serialize that device's writes; independent devices append
without replacing one another's events. The root manifest is not rewritten for
card appends. Reads derive the combined event heads, version and local cache
projection from the streams; those projections are not authority. A forked
stream, duplicate key/id with differing metadata, competing replacement, or
unresolved write conflict is returned as an explicit refusal. A write interrupted
before its event commit can leave an unreferenced body, which is ignored; a
committed event is complete because its body is written first. Older metadata and
body user crests remain readable, and new events can be appended without
rewriting their existing records.

## Metadata

`KnowledgeUnitMetadata` is closed and binds its stable ID/external key, scope,
project and role scopes, category, kind, ordered tags, subject, bounded summary
and snippet, a P4-only accountable-owner protocol reference, inert current-source
references and digest, an optional `supersedes` knowledge id, ordered
work/decision/gate/evidence links, lifecycle,
retrieval and export dispositions, promotion,
freshness, last verification instant, staleness policy, focused redaction,
authority, provenance, body digest/size, revision, and update instant.

The implementation constructs and validates the frozen P2 Knowledge record for
every accepted metadata/body pair. It does not alter P2 schemas or canonical
semantics.

## Freshness, writing, and retrieval

Freshness is evaluated at an explicit strict instant. A null
`stalenessPolicy.maximumAgeDays` is change-driven and never expires by the clock;
cards with no verification instant are still selectable. A finite policy marks
an expired age window `stale`, but a missing verification instant is not made
unselectable by an `unknown` result. Default selection and checkpoints exclude
stale records, superseded, rejected or retired records, non-default retrieval,
and excluded export disposition. TCRN-CROSS-INC-282 (Owner rulings
TCRN-CROSS-MIN-146 D1 and TCRN-CROSS-MIN-158 D1) made the default selection every
active card, because a promotion gate on retrieval is what left a written card
unfindable with nothing in its receipt to say so.

A card is retrievable the moment it is written (TCRN-CROSS-STORY-476 R1,
TCRN-CROSS-MIN-227 D9, TCRN-CROSS-SUB-308). Every write lands lifecycle `active`
and promotion state `promoted`, whatever its kind and whatever provenance it
carries; there is no candidate state to write and no promotion step. A write may
leave the lifecycle out; one that names `candidate` or `retired` is refused with
`KNOWLEDGE_LIFECYCLE_RETIRED` (details `required`, `actual`, `remedy`) before
anything is written. The provenance floor is therefore write time:
`validateMetadataShape` runs its assertions on a promoted record, so a `guide` or
`reference` without a source reference and an evidence link is refused at capture
rather than stored as a card no reader returns, and a fragment kind (`fact`,
`decision`, `summary`) is admitted with half-supplied provenance. Records written
before this keep the lifecycle and promotion state they were written with
(`candidate`, `rejected`, `retired`) and are read, never rewritten; a `rejected`
record stays out of default selection and its body opens only with
`allowUnpromoted`. The owner reference remains provenance accountability only;
it does not claim P5 profile admission or identity resolution.

`knowledge-batch` accepts `knowledge-create`, `knowledge-policy` and
`knowledge-reverify` members; a promote or retire member is refused by the shape
pass as an unknown verb. A `knowledge-policy` member is a bounded metadata
migration: it supplies an id (or external key), an expected revision,
and the replacement `{maximumAgeDays, unknownDisposition}` policy. The member
advances the disposable store version and metadata revision without changing the
body, source digest, or verification instant; setting `maximumAgeDays` to `null`
also removes a stale posture that came only from the retired calendar policy.

Mutation input is validated before the mutation claim is acquired. Every
non-crash error after claim acquisition releases only the identity-bound claim
generation before returning its frozen reason code, so an invalid request cannot
poison an otherwise valid store or block a later valid mutation.

## Limits and privacy

V1 limits body bytes to 8192, subject bytes to 512, summary bytes to 2048,
snippet bytes to 512, each source-reference string to 512,
metadata bytes to 32768, the default query page to 8 results, the aggregate
body budget to 1 MiB, source locators to 16, each link class to 64, tags to 32, and
role scopes to 16. The aggregate limit is the protocol canonical-view ceiling:
35 measured cards occupied 63,316 source-of-truth bytes and their derived index
occupied 52,851 bytes, or 5.0% of 1,048,576 bytes. Listing more matches than one page truncates with a
`{total, offset, truncated}` continuation window rather than failing closed, and a
bounded case-insensitive substring over subject, summary, snippet, and tags narrows
results without loading bodies. `knowledge-source-check` is the explicit source
file comparison surface; ordinary reads do not scan every source file.

The one-MiB value above is the fixed engine ceiling. A workspace may select a
lower `knowledge.aggregateBytes` value (default 131,072); changing that setting
changes future store admission without rewriting metadata or bodies.

## Capacity

Capacity counts card bodies and nothing else (TCRN-CROSS-STORY-476 R3,
TCRN-CROSS-SUB-309): not the store marker, not the metadata, not the derived index.
Only live cards count: a card that a later card superseded, the one retirement there
is, gives its body back to the budget, and so does a `retired` record an older engine
left. A superseded card's body stays in its immutable store or event stream for an
explicit read; it is simply not charged or included in default recall. No supersede
operation physically deletes that body. The count is the sum of each counted record's own `bodyBytes`, which a full
read binds to the body on disk, so a metadata-only read measures the same number.
Every read measures a store this way, including one written before the change, so an
existing store is recounted the first time it is read and nothing is migrated or
rewritten. A write that would take the count past `knowledge.aggregateBytes` is refused
with `KNOWLEDGE_LIMIT_EXCEEDED` (unchanged), its details carrying the projected
`bodyBytes` and the `limit`; a write that supersedes a card is charged its own body
less the one it retires, which is how a replacement makes room rather than doubling
the store. A read of a store already over the limit refuses the same way.
`knowledge-validate` reports the measure as `capacity: {bodyBytes, limit}`.

These text budgets are UTF-8 byte budgets. Draft 2020-12 `maxLength` counts
Unicode code points and is retained only as a structural bound. P4 schema proof
registers the local `x-tcrn-maxUtf8Bytes` assertion and executes multibyte
max/max+1 parity vectors; stock JSON Schema alone is not claimed to enforce
UTF-8 byte length.

Source and evidence locators are inert strings. The store performs no URL
resolution, network access, database access, AOS access, or implicit process
launch. Locators must already satisfy the accepted focused reference-redaction
policy; this remains a bounded policy and is not a general DLP claim.

## High-water rebase

The store marker binds the workspace event head at which it was last consistent.
Any workspace event advances that head, and every knowledge read then fails
closed with `KNOWLEDGE_HIGH_WATER_MISMATCH` until a governed rebase re-binds the
store. Rebase re-validates every record's full metadata shape, body binding, and
scope/project/work links against the new workspace state. A live record whose
scope/project or linked-work references no longer resolve is an offender: the
rebase fails closed with `KNOWLEDGE_REBASE_BLOCKED` and a deterministic id-sorted
offender list. The `retire-invalid` escape that retired those records is gone
with every other retirement path but `--supersedes` (TCRN-CROSS-SUB-308); a
rebase that lands rewrites no record, and its result reports `retired: 0` and
no offender. Rebase is a single version step under the mutation claim; a fault at either write
point leaves the claim present so the next admission fails closed
(`KNOWLEDGE_PARTIAL_STATE`/`KNOWLEDGE_LOCKED`), never accepting a half-rebased
marker. The store is not event-sourced, so rebase — not re-initialization — is the
only path that preserves records across workspace events.

## Lifecycle

A written card can be re-verified: `reverify` touches `lastVerified` to the
supplied instant and restores a fresh posture under CAS, so written knowledge
does not decay irreversibly out of default selection; only a promoted, non-retired
record admits it, which is every card written now. There is no manual retirement:
the `knowledge-retire` verb and its batch member are gone (TCRN-CROSS-SUB-308).
There is no independent record-count cap: capacity is controlled by the canonical
byte ceiling, not by a historical count or by a retired-record allowance. A
`retired` record an older engine left is a tombstoned audit entry: it stays
readable, its dangling backlinks are durably tolerated, its body may have been
reclaimed, and `knowledge-recover` still completes a stopped write that left a
retired record with its body.

## Conflict retirement

Knowledge retires only at write time (TCRN-CROSS-MIN-225 D1, TCRN-CROSS-MIN-227 D9,
TCRN-CROSS-STORY-476 R2). A capture or create whose subject scores as a possible
conflict with an active card is refused with `KNOWLEDGE_POSSIBLE_CONFLICT` (details
`conflicts`) unless it names `--supersedes` or `--coexist`; `--supersedes` marks the
older card with `extensions.supersededBy`, which takes it out of default and
searched retrieval while it stays lifecycle `active` and its body stays readable by
an explicit body read. No clock, observation day, window or operator act retires a
card: `maximumAgeDays` only marks a card `stale`, and a store at its aggregate limit
refuses the next write with `KNOWLEDGE_LIMIT_EXCEEDED` rather than evicting anything.
The fitness statistic, `retire-proposals`, `retire-sweep`, `knowledge-retire` and the
rebase's `--retire-invalid` are gone (TCRN-CROSS-SUB-308); `fitness.windowDays` and
`fitness.minEvents` are retired settings whose recorded values replay as history.

The `tcrn.knowledge-retirement.v1` metadata record (card id, reason, counts, sweep
instant and window) and the marker's `lastSweepAt` are read-only historical formats:
readers and the schema accept them, and no command writes them any more.

The knowledge mutation claim records its process identity and acquisition instant.
`knowledge-recover` only reclaims a claim whose process is demonstrably gone and whose
metadata/body set can be fully validated; otherwise the store remains blocked.

## Governed surfaces

Core exports empty initialization/validation, creation (with its conflict
supersede), metadata listing and filtering, bounded snippet read, explicit body
read, freshness evaluation, re-verify, staleness-policy update, high-water rebase,
metadata-only checkpoint generation, and dead-claim recovery. CLI commands mirror
these surfaces.
`P4_KNOWLEDGE_CORE_VERIFIED` proves only this bounded file-native capability; it
does not mark the graph work done or start RC2/P5/P6.

## KR-05 fact-card mapping appendix (WS-F)

This appendix aligns the AOS KR-05 fact-card entry convention with product
`KnowledgeUnitMetadata`. It records the correspondence; it does not reconcile the
two, and discrepancies are noted rather than silently normalized.

KR-05 fact-card entry fields are defined by `Kr05SeedEntryCandidate` in the AOS
repository (`packages/db/src/knowledge-seed-convention.ts`) as structured entry
fields plus mandatory body sections — not document frontmatter. Product
`KnowledgeUnitMetadata` is defined in `packages/core/src/knowledge-core.ts`.

| KR-05 fact-card field | KnowledgeUnitMetadata field | Note |
|---|---|---|
| `id` | `id` | Both are stable identifiers. |
| `title` | `subject` | Renamed; same role. |
| `roleScope` | `roleScopes[]` | KR-05 single scope; product is a bounded array. |
| `project` | `projectId` | Renamed. |
| `category` | `category` | KR-05 uses a free string; product uses a closed 8-value enum. Discrepancy recorded. |
| `knowledgeKind` | `kind` | KR-05 `fact_card_convention` vs the product closed kind enum (fact/guide/decision/reference/summary). Discrepancy recorded. |
| `status` | `lifecycle` / `promotionState` | KR-05 `canonical`/… maps onto the product lifecycle and promotion vocabularies. Discrepancy recorded. |
| `lastVerified` | `lastVerified` | Same field. |
| `stalenessPolicy` | `stalenessPolicy` | KR-05 uses a string (`review_after_30_days`); product uses a structured object (`{maximumAgeDays, unknownDisposition}`). Discrepancy recorded. |
| `sourceRef` | `sourceReferences[]` | KR-05 single ref; product is a bounded array. |
| `sourceDigest` | `sourceDigest` | Same field. |
| `tags` | `tags[]` | Same role. |
| `summary` | `summary` | Same field. |
| `body` (+ required sections) | `snippet` / explicit body read | Product separates a bounded snippet from an explicit body read; KR-05 mandatory body sections (invariants, settings_and_cross_module_interactions, gotchas, source_refs_with_digests) are body content. |

The KR-05 required body sections have no dedicated `KnowledgeUnitMetadata` fields;
they are body content governed by the product body/snippet budgets. This mapping
is a documentation alignment for the shared knowledge-records requirement
(AOS-REQ-006); it adds no schema surface and no engine code.
