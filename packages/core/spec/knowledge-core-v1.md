# File-Native Knowledge Core V1

P4 Knowledge Core is an offline, metadata-first store layered beside the P3
Workspace authority. Initialization is clean and empty, and it always takes an
explicit per-invocation disposability acknowledgment; without it initialization
fails closed (a library has no workspace key to carry the `FIXTURE-` prefix that
old-layout fixtures were once admitted by). The store remains a disposable derived index that is
never the system of record. Initialization never searches, imports, migrates,
infers, or consults any predecessor knowledge or workflow source.

## Storage and authority

The store is a library's `crest/` directory (TCRN-CROSS-STORY-469 R1, 466 R1); initializing it
adds nothing to the library root, which keeps its seven entries. Every device that shares the
library writes its crest (TCRN-CROSS-SUB-414; STORY-476 D7; MIN-235 D7, O3): each device appends
its cards to its own event stream, `events/<device-id>/`, and those streams are the authority for
card metadata and body references. A crest holds `store.json`, its root manifest, and the
`events/` directory its first card lays out; a crest an engine before event streams wrote also
holds that engine's `metadata/` and `bodies/` (the metadata/body layout below). The index view,
`index.json`, is derived, so it is this device's cache, `cache/<library>/crest-views/` in the
device directory (469 R4): a read that finds it missing or out of date projects it again
instead of failing, and another device reading the same store projects its own; a write projects
this device's copy from its own scan. Past the protocol's canonical ceiling the view is a head and
its pages (see "Capacity"), and a view that cannot be projected is left for the next read: it never
fails a read or turns a committed write into a refusal (TCRN-CROSS-SUB-428). An old-layout
workspace's store (`knowledge/` in its control directory, with a `views/index.json` entry) opens
read-only; every write refuses with `LEGACY_WORKSPACE_READ_ONLY`.
Bodies are separate single-link regular files and never appear in metadata
views, default selection, or checkpoints. Metadata listing, snippet, freshness,
and checkpoint surfaces enumerate the closed body-name set but never open or
read body files. Full validation and mutations validate all body bindings;
explicit body read validates only the requested body through its bound
descriptor.

Each event of a library's crest (`einzbern.crest-event.v1`, named `<sequence>-<event hash>.json`)
holds one record of one card: its metadata, its body file `<sequence>-<body sha256>.body` written
before it, its device, its sequence and the previous event's hash, and two fields the user crest's
events do not carry. `chain` is every chain stream's head (device, sequence, event hash) the write
was checked against; `replaces` is the digest of the stored record of the same card that this record
replaces, null for a card's first record. A card is written again -- `knowledge-reverify`,
`knowledge-policy`, `knowledge-article-refresh` -- as a new record in the writing device's stream
naming the record it replaces, under record-revision CAS against the card as a read projects it; a
retired record, whose body an older engine may have reclaimed, is written again without a body.
Nothing is rewritten in place: a write creates its body file and its event with exclusive no-follow
creates, a crash before the event leaves a body no event names, which reads ignore, and a committed
event is complete. This machine's lock of the library (`locks/<library>.lock` in the device
directory, the lock every chain write takes) serialises the writers of one device's stream; two
devices never write one file of a crest. Descriptor-bound reads bind device, inode, size, mode, and
nanosecond change metadata. Link, special-file, source-replacement, partial, count, and size
violations fail closed. P1 Option-B remains the ancestor-component threat boundary.

A read merges every writer's records, the metadata/body layout's among them. A writer's latest record
of a card stands for its earlier ones, and of the writers' latest records the ones no other record
replaces are the card's current records: one is the card, and more than one is an unresolved
duplicate (the same-key rule below), so two devices that each wrote one card again before either saw
the other's lose neither record. A writer holding a second record of an id that replaces nothing is
refused as `KNOWLEDGE_PARTIAL_STATE`, naming the writer. A card whose `supersedes` names another is
projected over it -- the replaced card is removed, conflict superseded (see "Valid and removed") -- and
the replaced record is not rewritten; a card whose supersedes names a card not delivered yet stands,
and the named card is removed when it arrives. A stream also holds removal events
(`einzbern.crest-removal.v1`, the same file names), each after its device's earlier events and
chained to them like any other. A library's crest holds unresolved conflicts and duplicates by the rules the
user crest's follow (below) -- a card's writer, for a pair, is the writer of its first record, and a
duplicate's versions are its writers' current records -- and `knowledge-list` and a read of the id name
them with the same fields; `recall` leaves their cards out and names them at its top under
`projectCrestDegraded` (see "Freshness, writing, and retrieval").
A read also checks each event's `chain` against the chain it replays. A record written against chain
events this device does not hold yet -- a folder that delivered the card before those events, or a
partial restore that left the crest newer than its chain -- is named at the top of `knowledge-list`
and of a read of its id as `awaitingChain` (`id`, `deviceId`, `sequence`, `eventHash`, in canonical id
order); its card leaves default selection and `recall` (which names the record under `awaitingChain` in
`projectCrestDegraded`), its links are checked once the events arrive, and `knowledge-validate`,
`knowledge-checkpoint` and `knowledge-rebase` refuse with `KNOWLEDGE_HIGH_WATER_MISMATCH`, details
`awaitingChain`. Every other card reads, recalls and is written as before.

A read checks each card's current record against the chain it replays as well (TCRN-CROSS-SUB-414
R16). A live record -- no card supersedes it and it is not retired -- whose project the chain no longer
holds does not refuse the crest: `project-delete` refuses only a project that still owns live work, and
a device that deletes a project cannot see a card another device wrote to it before either received
the other's write. The record is named at the top of `knowledge-list` and of a read of its id as
`unresolvedScopes` (`id`, `deviceId`, `sequence`, `eventHash` -- all three null for a record of the
metadata/body layout, as for a duplicate's version -- and `projectId`, the project that no longer
resolves; in canonical id order, then writer order), and its card leaves default selection and
`recall`, which names the record under `unresolvedScopes` in `projectCrestDegraded` with reason code
`KNOWLEDGE_LINK_INVALID` when no unresolved pair and no duplicate's versions are withheld as well
(ahead of the `KNOWLEDGE_HIGH_WATER_MISMATCH` of records awaiting chain events alone). Every other card
reads, recalls and is written as before; a write of that card itself (`knowledge-reverify`,
`knowledge-policy`, `knowledge-article-refresh`) is refused with `KNOWLEDGE_LINK_INVALID`, `<id>:scope`.
`knowledge-validate` and `knowledge-checkpoint` refuse with `KNOWLEDGE_LINK_INVALID` (`<id>:scope`,
naming the first such card) and `knowledge-rebase` with `KNOWLEDGE_REBASE_BLOCKED` (see "High-water
rebase"), their details carrying `unresolvedScopes` and a `remedy` naming every such card. The way out
is a card that supersedes it (`knowledge-create --supersedes <id>`), which is admitted; the superseded
card is removed, conflict superseded, nothing names it, and the three answer again. A removal of the
card (`knowledge-remove`) is a way out as well: a removed card is not live either. A
record whose scope contradicts itself -- a user card, or a scope its project and role scopes disagree
with -- is not one of these, and still refuses the read with `KNOWLEDGE_LINK_INVALID`.

The library crest's root manifest, `store.json`, is written by exactly one operation of this engine
(TCRN-CROSS-SUB-414, MIN-235 D7):

1. Initialization, `knowledge-init`: `store.json` is created with an exclusive no-follow create,
   version 0, bound to the library id and that id's own digest -- the same bytes whichever device
   writes it. A crest that already holds anything refuses with `KNOWLEDGE_ALREADY_EXISTS`, and
   nothing replaces a manifest.

Nothing else writes it, and nothing else takes a claim on the crest: not a chain write, and no
knowledge rebind after one (the CLI ran a rebase after every chain write until this change); not a
card write (`knowledge-create`, `knowledge-capture`, `knowledge-article-create`, a `knowledge-batch`
create member); not a supersede; not a card written again
(`knowledge-reverify`, `knowledge-policy`, `knowledge-article-refresh` and their batch members); not
`knowledge-rebase` or `knowledge-batch --align-first`, which re-validate and write nothing; not
`knowledge-recover`, which completes a stopped write of the metadata/body layout and never writes the
manifest; not `knowledge-bodies-migrate`, which rewrites the metadata/body layout's bodies into
segments, is run by one device, and writes neither the manifest nor an event stream -- with
`--clear-removed true` it also clears the removed cards' bodies from that layout, a single-writer
step that runs only on a device that is the library's sole writer (see "Valid and removed"); and not a
read or its cache projection. The marker a read answers is a projection and is never persisted: its version is
the manifest's advanced by every event of every stream, and its high water, `eventHighWaterDigest`, is
the chain head the read replayed. A chain write therefore never leaves the crest behind -- the purpose
the rebind after it served (TCRN-CROSS-INC-244) -- and a library's read never trails its chain. A
manifest that does not bind the library's id refuses every read with `KNOWLEDGE_HIGH_WATER_MISMATCH`.
An engine before event streams bound the manifest to the library head at its last write and advanced
its version per write under a mutation claim; this engine reads both as written and writes neither.

The metadata/body layout -- one `metadata/<id>.json` and one `bodies/<id>.body` per card -- is what an
engine before event streams wrote. It stays readable beside the device streams as the writer `legacy`
and metadata remains one record per id in it; new cards are appended to event streams, and no record of
it is rewritten by one. The body-file wording above describes its reader. A local migration,
`knowledge-bodies-migrate`, may replace its body files with canonical NDJSON segments, point indexes,
and a manifest; a crest holding only event streams has nothing to migrate. A layout whose bodies are
already in segments, or partly in them, keeps every body it holds (TCRN-CROSS-SUB-425 R18): the
migration writes the bodies of its segments again beside the ones its body files add, refuses a body
file whose segment holds a different body (`KNOWLEDGE_PARTIAL_STATE`) before it writes, and writes
nothing when no body file is left to move. Its answer's `before` and `after` count the bodies the
layout holds before and after the run, and `bodyBytes` is their size after it. A mutation claim can be
found only in that layout, left by an interrupted write of that engine, and until `knowledge-recover`
completes it every write and rebase of the crest refuses with `KNOWLEDGE_LOCKED`.
Whichever layout holds the bodies -- one file per card, segments or event streams -- nothing
counts or bounds their sum (see "Capacity").

The user crest is shared between projects and can live in a synced folder. It
uses the same one-time root identity marker, then keeps immutable event streams
under `events/<device-id>/`. Each stream advances its own sequence and previous
event hash and each event binds its metadata to a body file in that stream.
Device-local locks serialize that device's writes; independent devices append
without replacing one another's events. The root manifest is not rewritten for
card appends. Reads derive the combined event heads, version and local cache
projection from the streams; those projections are not authority. A forked,
broken or altered stream is returned as an explicit refusal naming its device and
the sequence or file, and so is one stream that holds two different records for
one knowledge id, which no writer of this engine leaves: it scans before it
writes. One external key that two writers wrote with differing metadata is not a
refusal of the crest (see the same-key rule below). A write interrupted before
its event commit can leave an unreferenced body, which is ignored; a committed
event is complete because its body is written first. Older metadata and body user
crests remain readable, and new events can be appended without rewriting their
existing records.

The user crest's root manifest, `store.json`, is written by exactly one operation
of this engine (TCRN-CROSS-SUB-310, MIN-235 D7):

1. Initialization by the crest's first card write: `store.json` is created with an
   exclusive no-follow create, version 0, bound to the user-crest identity. A
   writer that loses the create reads the winner's marker and accepts it only
   when it binds the same identity and high-water digest; it never replaces it.

Nothing else writes it: not a card append, not a supersede, not a read or its
cache projection, and not `knowledge-recover --scope user`, which only verifies
the crest, rewrites this device's derived index and releases the stale claim an
interrupted writer of the metadata/body layout left. The marker a read answers,
its version advanced by the event count and its high-water digest taken over the
stream heads, is a projection and is never persisted; a manifest that stopped
binding the identity digest would refuse every read with
`KNOWLEDGE_HIGH_WATER_MISMATCH`. An engine before event streams advanced the
marker's version on each card write under its store claim; this engine reads that
version as written and never advances it.

A shared folder can deliver one device's events after another device has already
written, so two cards about one thing can stand side by side although neither
writer saw the other. Such a pair is an unresolved conflict, not a refusal of the
crest. A pair counts only when its two live cards come from different writers --
different device streams, or a stream and the metadata/body layout -- score as a
write-time conflict against each other, and neither lists the other in
`coexistsWith`: one writer scans before it writes, so the conflicts it saw were
refused or recorded, and a user-crest write records in the new card's
`coexistsWith` every conflict it was admitted beside, with `--coexist` or beside
the card it supersedes. `knowledge-list --scope user` names the pairs as
`unresolvedConflicts` (each pair and the list in canonical id order); its default
selection leaves their cards out while `--selection all`, `knowledge-snippet` and
`knowledge-body` still read them, and every other card reads, recalls and is
written as before. A new card on the same subject is refused naming both cards; a
write whose `--supersedes` names either card of a pair resolves it. A card that
more than one card replaces -- two devices that each replaced it before either saw
the other's replacement -- is removed either way: its removal's `supersededBy`
names the latest replacement (a mark the metadata/body layout stored stays), each
replacement stays valid, and replacements that collide form a pair like any other.
A write whose event is committed answers from its own scan and that event, its
`version` the scanned version plus one: it never reads the crest again, so what
another device delivers meanwhile cannot turn a committed write into a refusal,
and the next read reports any pair it forms. A merge is never refused for the
size of its bodies (TCRN-CROSS-SUB-310 R17, MIN-238 D1; see "Capacity"): however
many body bytes the devices' cards hold together, every read, write, recall and
recovery of the crest answers as it would for one device's. `recall` names
withheld conflicts under `userCrestDegraded` (see "Freshness, writing, and
retrieval").

The same-key rule (TCRN-CROSS-SUB-413, STORY-476 D7): a knowledge id is derived
from its external key, so two writers that each write one external key before
either sees the other's write one id. The same record written by both, or
delivered twice, is one card. Records that differ are an unresolved duplicate,
not a refusal of the crest, and none of its versions is the card: each stays in
its writer's stream, and while the duplicate is unresolved default selection and
`recall` leave out every version. `knowledge-list --scope user` names it at its
top as `unresolvedDuplicates`, one entry per id in canonical id order, each with
`id`, `externalKey` and `versions`: one version per writer in canonical order of
its device id (a version the metadata/body layout holds comes after them), each
naming `deviceId`, `sequence` and `eventHash` -- the device stream and the event
that hold it, all three `null` for the metadata/body layout -- with its
`updatedAt`, `subject` and `bodySha256`. `--selection all` lists every version
as its own record. `knowledge-snippet` and `knowledge-body` for the id answer
`versions` in the same order, in place of one card's fields: each version's
`deviceId`, `sequence` and `eventHash` with its `subject`, `summary`, `snippet`
and `revision`, or with its `revision`, `freshness`, `bodySha256` and `body`
(a body read opens only when every version passes the check one card's body
does); while the duplicate is unresolved they carry its `unresolvedDuplicates`
entry at their top. Every other card reads, recalls and is written as before. A
write sees every version: it may not reuse the id or external key
(`KNOWLEDGE_DUPLICATE`), and a version on its subject is a conflict it names by
the id. A version's own `supersedes` still replaces the card it names. The
duplicate is resolved by the existing write path: a write whose `--supersedes`
names the id replaces every version at once, whichever of them its writer saw:
the id is removed, conflict superseded, with every version (see "Valid and
removed"), so no version is a default answer or a recall hit, each version's event
stays in its stream, each device clears its own version's body at its next write,
and the diagnostic is gone. A removal of the id (`knowledge-remove`) resolves it
the same way. A duplicate is unresolved while its id is not removed and one of its
versions is neither replaced nor retired. To keep one version, write its content
again under a new external key with `--supersedes` naming the id. `recall` names
an unresolved duplicate under `userCrestDegraded`.

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
removed cards (a superseded card is one; see "Valid and removed"), stale records,
rejected or retired records, non-default retrieval, and excluded export
disposition. TCRN-CROSS-INC-282 (Owner rulings
TCRN-CROSS-MIN-146 D1 and TCRN-CROSS-MIN-158 D1) made the default selection every
active card, because a promotion gate on retrieval is what left a written card
unfindable with nothing in its receipt to say so.

In either crest, default selection also leaves out the cards of an unresolved
conflict and every version of an unresolved duplicate, and in a library's crest the
card of a record awaiting chain events or of a live record whose project the chain
no longer holds (see "Storage and authority"). Recall reads the
library's crest and the user crest; a store it cannot read gives no cards and its
reason code under `knowledgeStores`, and the cards a store's default selection leaves
out are not recalled. When the user crest gave recall fewer cards than it holds, the
answer says so at its top as `userCrestDegraded` (TCRN-CROSS-SUB-310): the read's
refusal code alone (for example `KNOWLEDGE_PARTIAL_STATE` for a forked stream, no
user card recalled; no read is refused for its bodies' size), or
`KNOWLEDGE_POSSIBLE_CONFLICT` with `unresolvedConflicts` and
`withheldCards` (every other user card recalled). TCRN-CROSS-SUB-413 adds
`unresolvedDuplicates`, the entries `knowledge-list` names, when versions of an
unresolved duplicate are withheld; the reason code is then `KNOWLEDGE_DUPLICATE`
unless a pair is withheld as well, and `withheldCards` counts the pairs' cards
and every withheld version. It is absent when the user crest gave every card it
holds, or holds none.

The library's crest says the same at the top of a recall answer as
`projectCrestDegraded` (TCRN-CROSS-SUB-414), in the form `userCrestDegraded` has,
when its default selection withheld cards: `KNOWLEDGE_POSSIBLE_CONFLICT` when an
unresolved pair is withheld, else `KNOWLEDGE_DUPLICATE` when versions of an
unresolved duplicate are, else `KNOWLEDGE_LINK_INVALID` -- the refusal
`knowledge-validate` and `knowledge-checkpoint` meet -- when cards whose project the
chain no longer holds are, else `KNOWLEDGE_HIGH_WATER_MISMATCH` -- the refusal
`knowledge-validate`, `knowledge-checkpoint` and `knowledge-rebase` meet -- when
records awaiting chain events are all it withheld. `unresolvedConflicts`,
`unresolvedDuplicates`, `awaitingChain` and `unresolvedScopes` carry what
`knowledge-list` names, each present when it is not empty, and `withheldCards`
counts every withheld card and version once, although a pair's card or a
duplicate's version can also await chain events or name a project the chain no
longer holds. A refused read of the library's crest is not repeated there: its code
stays `knowledgeReasonCode` and `knowledgeStores.project`, as it always was. It is
absent when the library's crest withheld nothing.

A card is retrievable the moment it is written (TCRN-CROSS-STORY-476 R1,
TCRN-CROSS-MIN-227 D9, TCRN-CROSS-SUB-308). Every write lands lifecycle `active`
and carries no promotion state at all -- the field is gone from new records --
whatever its kind and whatever provenance it carries; there is no candidate state
to write and no promotion step. A write may leave the lifecycle out; one that names
`candidate` or `retired` is refused with `KNOWLEDGE_LIFECYCLE_RETIRED` (details
`required`, `actual`, `remedy`) before anything is written. The provenance floor is
therefore write time: `validateMetadataShape` holds a record with no promotion
state, as it holds one an older engine wrote `promoted`, to the provenance
assertions, so a `guide` or
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

Mutation input is validated before anything is written. A write takes no claim
(TCRN-CROSS-SUB-414): every refusal is decided before its event is written, so an
invalid request cannot poison the crest or block a later valid write, and a crash
leaves either no event or a complete one.

## Limits and privacy

V1 limits body bytes to 8192, subject bytes to 512, summary bytes to 2048,
snippet bytes to 512, each source-reference string to 512,
metadata bytes to 32768, the default query page to 8 results, source locators to
16, each link class to 64, tags to 32, and role scopes to 16. Listing more
matches than one page truncates with a `{total, offset, truncated}`
continuation window rather than failing closed, and a
bounded case-insensitive substring over subject, summary, snippet, and tags narrows
results without loading bodies. `knowledge-source-check` is the explicit source
file comparison surface; ordinary reads do not scan every source file.

These limits bound one card and one page. None bounds the sum of a crest's card
bodies (see "Capacity").

These text budgets are UTF-8 byte budgets. Draft 2020-12 `maxLength` counts
Unicode code points and is retained only as a structural bound. P4 schema proof
registers the local `x-tcrn-maxUtf8Bytes` assertion and executes multibyte
max/max+1 parity vectors; stock JSON Schema alone is not claimed to enforce
UTF-8 byte length.

Source and evidence locators are inert strings. The store performs no URL
resolution, network access, database access, AOS access, or implicit process
launch. Locators must already satisfy the accepted focused reference-redaction
policy; this remains a bounded policy and is not a general DLP claim.

## Capacity

No budget bounds the sum of a crest's card bodies, the library's or the user's
(TCRN-CROSS-SUB-310 R17; TCRN-CROSS-MIN-238 D1, D5; TCRN-CROSS-MIN-239 D1).
Nothing counts them: no read, write, recall, `knowledge-recover` or merge of two
devices' streams is refused for the bytes they add up to, and a merge past any
sum an earlier engine admitted reads, recalls and is written like any other.
What keeps a crest small is what a card is for: one fact about the environment
or one lesson, captured where work reaches done or minutes are recorded, with
decisions in minutes, intents in work items, and a card on a subject an active
card holds written with `--supersedes` or `--coexist` (TCRN-CROSS-MIN-227 D9,
D25; TCRN-CROSS-MIN-146; TCRN-CROSS-MIN-225). Each card is still held to its own
limits ("Limits and privacy"): a body, summary, snippet or metadata past its
limit, or an article past the canonical ceiling, is refused with
`KNOWLEDGE_LIMIT_EXCEEDED` before anything is written.

Nor does the metadata the cards add up to bound a crest (TCRN-CROSS-SUB-428,
TCRN-CROSS-INC-398). The derived index is no single canonical value, so neither
the protocol's one-MiB canonical ceiling nor its record-count limit, which stay
where they are, reaches it. Its `indexDigest` (`knowledge-validate`, the marker
read) and the `resultDigest` of a `knowledge-list` page are the sha256 of the
records' canonical list -- wherever that list fits one canonical value, exactly
the digest it always was -- hashed one record at a time, so the page recall and
the knowledge hint read, the whole crest, is answered at any size. This device's
view holds the whole index in `index.json`, byte for byte as before, while the
index fits the ceiling and the record-count limit. Past either, `index.json` is a
head, `tcrn.knowledge-index-pages.v1`, naming the index's `count` of records, the
number of `pages` that hold them and its `indexDigest`; page n is
`index-<n, six digits>.json`, `tcrn.knowledge-index-page.v1`, holding the next
records in index order within the same ceiling, and the records of the pages in
page order hash to the head's digest. A read that finds a page missing, damaged or
out of date projects it again, and removes a page the head does not name. A view
that cannot be projected, at a read or after a write's event is committed, is left
for the next read: it never changes a read's answer, and a committed write is
answered as committed (R14 (d)). What stays one canonical value is an answer
printed whole: an answer that holds every card -- `knowledge-checkpoint`,
`knowledge-freshness`, `knowledge-source-check` -- or a page asked for with
`--limit`, is still refused with `INPUT_OVERSIZED` once it passes the ceiling.

`knowledge.aggregateBytes`, the setting that bounded the body bytes of live cards
(TCRN-CROSS-STORY-476 R3, TCRN-CROSS-SUB-309), is a retired setting
(`specs/settings-catalog-v1.md`): a new write of it is refused, and a value a chain
recorded replays as history and binds nothing. `knowledge-validate` no longer
reports the `capacity` it measured against that limit, and `KNOWLEDGE_LIMITS` has
no `maximumAggregateBytes`.

## High-water rebase

A library crest's marker no longer holds a high water to re-bind (TCRN-CROSS-SUB-414, MIN-235
D7). Every read projects the crest at the chain head it replays and checks each card's current
record against that chain: a live record whose project the chain no longer holds is named as
`unresolvedScopes` and its card leaves default selection (R16; see "Storage and authority"), a
record whose scope contradicts itself refuses the read with `KNOWLEDGE_LINK_INVALID`, and linked
work the chain no longer holds is reported as `danglingWorkLinks` without blocking. No chain event
makes a knowledge read refuse, not even a project deleted under a card, and nothing needs
re-binding after one; a record written against chain events this device does not hold yet waits
for them (see "Storage and authority").

`knowledge-rebase`, and `knowledge-batch --align-first`, is the full re-validation of every
record's metadata shape, body binding, and scope/project/work links against the chain as it
stands, and it writes nothing. A live record whose scope/project references no longer resolve is
an offender: the rebase fails closed with `KNOWLEDGE_REBASE_BLOCKED` and a deterministic id-sorted
offender list. A live record is one no card supersedes, no removal removes and that is not retired;
a removed or retired record is no offender, whatever its links (R16; TCRN-CROSS-SUB-425). When an offender is a card whose project
the chain no longer holds, the refusal's details carry `unresolvedScopes` and the `remedy`,
`knowledge-create --supersedes <id>` for each such card. A record this device's chain does not hold
yet refuses it with `KNOWLEDGE_HIGH_WATER_MISMATCH`, and a crest holding an older engine's mutation
claim with `KNOWLEDGE_LOCKED`. The `retire-invalid` escape that retired offenders is gone with every
other retirement path but `--supersedes` (TCRN-CROSS-SUB-308), and since R16 that one is open to an
offender whose project is gone: the crest's read no longer refuses the supersede. A removal
(`knowledge-remove`, TCRN-CROSS-SUB-425) takes such a card out of the offenders as well. A rebase that
answers reports the projected `version`, the chain head as `eventHighWaterDigest`, `retired: 0` and
no offender, and projects this device's index view again; there is no write for a fault to
interrupt.

`--allow-trailing`, still taken by the metadata-first reads, changes nothing about a library's
answer. It keeps its meaning for an old-layout workspace's read-only store, whose marker binds its
old chain's head: a read of it refuses with `KNOWLEDGE_HIGH_WATER_MISMATCH` when that head is not
the chain's, unless the flag admits it, labelled with both heads (TCRN-CROSS-INC-226).
`knowledge-validate` and `knowledge-checkpoint` are never exempt. For a library's crest they refuse
a crest its chain does not hold, which is how a snapshot restore that put the chain back without the
crest (WSF-3) finds a crest newer than the chain beside it; for an old-layout store, a trailing marker.

## Valid and removed

A card is valid or removed (TCRN-CROSS-SUB-425; TCRN-CROSS-STORY-514 R1, R3, R4;
TCRN-CROSS-MIN-239 D3, D4, D6, which for knowledge cards replaces the audit copy
TCRN-CROSS-MIN-235 D10 kept of a superseded body). Removed is terminal: no verb
restores a card, and a card removed by mistake is answered by a new card under a new
external key. A card is removed for one of three reasons, and every removal names its
basis, its actor and its instant:

- `superseded` -- another card supersedes it in a conflict. A write whose
  `--supersedes` names the card removes it -- the removal's basis names the new card,
  its actor is the new card's accountable owner and its instant the new card's -- and
  so does the mark an older engine stored on a card it replaced.
  `knowledge-remove --reason superseded --superseded-by <id>` records the same reason
  for a card that a valid card of the same crest already covers.
- `invalid` -- the card is wrong. Nothing judges that on its own: the model that finds
  a card invalid in use removes it with `knowledge-remove --reason invalid` and writes
  down why.
- `duplicate` -- the card repeats what a work item or a decision holds, which the basis
  names.

`knowledge-remove --id <id> --reason <reason> --basis <text> --actor <id> --at <instant>`
(with `--superseded-by <id>` for the reason `superseded` only, and `--scope user` for a
card of the user crest) reads the whole crest under this machine's lock of it and
refuses, before anything is written: an unknown reason, a blank basis, an actor that is
no `owner:`, `profile:` or `agent:` id, or `--superseded-by` given for another reason or
left out for `superseded` (`KNOWLEDGE_INPUT_INVALID`); a basis past 2,048 bytes
(`KNOWLEDGE_LIMIT_EXCEEDED`); a card the crest does not hold (`KNOWLEDGE_NOT_FOUND`); a
successor it does not hold (`KNOWLEDGE_LINK_INVALID`); and a card or successor already
removed (`KNOWLEDGE_CARD_REMOVED`). Otherwise it appends one removal event,
`einzbern.crest-removal.v1` -- the card's id, the reason, the basis, the actor and the
successor or null, with the instant as `occurredAt` -- to this device's stream of that
crest, and answers `KNOWLEDGE_UNIT_REMOVED` with the card as it is now kept, the
version its scan projected advanced by the event, and `clearedBodies`. The id of a
duplicate is removed with every version.

A removal event travels with the crest like every other event, and no event file is
ever deleted. A read of either crest applies each removal event to the card it names;
one naming a card not delivered yet waits for it, as a supersede does. Of several
removals of one card -- two devices that each removed it before either saw the other's
-- the earliest stands, then one an event holds before one a supersession derives,
then the event's device and sequence in canonical order; every event stays.

What a removed card keeps is its `id`, `externalKey` and `subject`, the `supersedes`
its own record named, `status: "removed"`, and `removal`: `reason`, `basis`, `actor`,
`removedAt`, `supersededBy` (the successor, or null), and the `deviceId`, `sequence` and
`eventHash` of the event that holds it -- all three null for a removal a supersession
derives, whose `actor` is the successor's accountable owner (null only where an older
engine's mark names a successor the crest does not hold). Its summary, snippet, tags,
links and sources are answered by no read, and its body is cleared: every device
deletes the body files its own stream holds for removed cards the next time it writes
to that crest -- the write that removes or supersedes the card, or any later card
write, removal, re-verification, policy update or article refresh -- after that
write's event is committed and under its lock; a file it cannot delete is left for its
next write and never turns a committed write into a refusal. A device clears only its
own stream, since two devices never write one file of a crest. The metadata/body
layout an older engine left, which no device owns, is cleared by one step instead,
`knowledge-bodies-migrate --clear-removed true --at <instant>`, the library's
single-writer step (TCRN-CROSS-SUB-425 R18; see "Storage and authority"). It runs only
on a device that is the library's sole writer -- every stream of the library's chain
and of its crest is that device's -- and otherwise refuses with
`KNOWLEDGE_SOLE_WRITER_REQUIRED`, details `deviceId` and `writers`. Under this
machine's lock of the library, after a read of the whole crest that binds every body,
it copies the layout's `bodies/` into `backups/<UTC second>/crest-bodies/<library>/`
of the device directory -- a backup is never overwritten, and a place already taken
refuses with `KNOWLEDGE_ALREADY_EXISTS` -- then writes the segments again without the
bodies of the removed cards, a superseded card's among them, and with every other
body byte for byte, the manifest and the point indexes with them; a body file still
left is moved in the same rewrite. With nothing to clear and nothing to move it writes
nothing and backs nothing up, so a second run changes nothing. Its answer adds
`clearedBodies` and `backupDir`, null when nothing was written. An old-layout
workspace's read-only store keeps its bodies, which no read answers; so do the
immutable events, whose metadata still holds the summary and snippet they were
written with. A read
admits a missing body for a removed card's records alone, so a device that receives
the deletion of a body before the removal event itself reads the crest as partial
(`KNOWLEDGE_PARTIAL_STATE`) until the event arrives, as it does an event delivered
before its body.

Reads answer valid cards unless asked for another status. `knowledge-list` and
`recall` take `--status valid|removed|all` (left out, `valid`), which a model adds only
when a user asked for removed cards; the list echoes it as `status`, and so does a
recall that was given one. `--selection` chooses among the valid cards as it always
did; a removed card is listed only under `removed` or `all`, once per id, as it is
kept, and a list filtered by project, role, category, kind, tag or freshness lists
none, since a removed card keeps none of them, while a search matches its subject. A
recall hit on a removed card says `status: "removed"` and its line reads
`[卡片 已移除]`. The prompt hook, the knowledge hint, a checkpoint, `knowledge-freshness`
and `knowledge-source-check` read valid cards only, always, and so does Atelier's
knowledge list unless its viewer picks another status. `knowledge-snippet` and
`knowledge-body` refuse a removed card with `KNOWLEDGE_CARD_REMOVED` -- details `id`,
`removal` and `remedy` -- before any body file is opened, and so do
`knowledge-reverify`, `knowledge-policy`, `knowledge-article-refresh`, a write whose
`--supersedes` names it, and a second removal. A removed card's id and external key
stay taken (`KNOWLEDGE_DUPLICATE`). A removed card is in no unresolved pair, resolves
the duplicate whose id it is, and is named in no `unresolvedScopes`, no
`danglingWorkLinks` and no rebase's offenders. A crest's index view holds it as it is
kept, one record per id, and `knowledge-validate` and the marker count it among
`records`; an old-layout store's index stays its engine's, every record as written.

A crest that holds a removal event, or a record whose body this engine cleared (a
removed or superseded card), is refused by an engine before this one, which does not
read the event's schema and requires every card's body file (`KNOWLEDGE_PARTIAL_STATE`).
A `retired` record an older engine left without a supersession is read as that engine
left it (see "Lifecycle"), and `knowledge-remove` can remove it.

## Lifecycle

A written card can be re-verified: `reverify` touches `lastVerified` to the
supplied instant and restores a fresh posture under CAS, so written knowledge
does not decay irreversibly out of default selection; only a record with no promotion
state (or one an older engine wrote `promoted`) that is neither retired nor removed
admits it, which is every valid card written now. The
`knowledge-retire` verb and its batch member are gone (TCRN-CROSS-SUB-308); a card
leaves by removal (see "Valid and removed").
There is no record-count cap and no body budget either (see "Capacity"): nothing
retires a card to make room, and no allowance is kept for retired records. A
`retired` record an older engine left is a tombstoned audit entry: it stays
readable, its dangling backlinks are durably tolerated, its body may have been
reclaimed, and `knowledge-recover` still completes a stopped write that left a
retired record with its body.

## Conflict retirement

A card leaves only by a write (TCRN-CROSS-MIN-225 D1, TCRN-CROSS-MIN-227 D9,
TCRN-CROSS-STORY-476 R2, TCRN-CROSS-MIN-239 D5). A capture or create whose subject
scores as a possible conflict with a valid card is refused with
`KNOWLEDGE_POSSIBLE_CONFLICT` (details `conflicts`) unless it names `--supersedes` or
`--coexist`; `--supersedes` removes the older card, conflict superseded (see "Valid
and removed"): it leaves every default and searched read, and its body is cleared.
`knowledge-remove` removes a card a model found invalid in use, or one that repeats a
work item or a decision. No clock, observation day, window or store size removes a
card: `maximumAgeDays` only marks a card `stale`, and a store has no body budget a
write could reach, so nothing is ever evicted to make room (see "Capacity").
The fitness statistic, `retire-proposals`, `retire-sweep`, `knowledge-retire` and the
rebase's `--retire-invalid` are gone (TCRN-CROSS-SUB-308); `fitness.windowDays` and
`fitness.minEvents` are retired settings whose recorded values replay as history.

The `tcrn.knowledge-retirement.v1` metadata record (card id, reason, counts, sweep
instant and window) and the marker's `lastSweepAt` are read-only historical formats:
readers and the schema accept them, and no command writes them any more.

The knowledge mutation claim an engine before event streams took records its process identity
and acquisition instant. `knowledge-recover` only reclaims a claim whose process is demonstrably
gone and whose crest can be fully validated; otherwise the store remains blocked. It completes the
stopped write of the metadata/body layout -- this device's index view projected again, a record that
write retired giving back the body it still holds -- releases the claim, and writes no root manifest
and no event (TCRN-CROSS-SUB-414).

## Governed surfaces

Core exports empty initialization/validation, creation (with its conflict
supersede), removal, metadata listing and filtering by status, bounded snippet
read, explicit body read, freshness evaluation, re-verify, staleness-policy update,
high-water rebase, metadata-only checkpoint generation, and dead-claim recovery. CLI commands mirror
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
