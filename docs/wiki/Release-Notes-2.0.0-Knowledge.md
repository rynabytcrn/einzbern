# Einzbern 2.0.0 发行说明：知识

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 5/13：知识

上一模块：[召回与钩子](Release-Notes-2.0.0-Recall-and-the-Hook.md) · 下一模块：[受管段、Command Spell 与门](Release-Notes-2.0.0-Managed-Sections-Rules-and-Gates.md)

## The knowledge store in a library is `crest/`

The knowledge store in a library is `crest/` with `store.json`, `metadata/` and `bodies/` only
(TCRN-CROSS-STORY-469 R1, R4; 466 R1; `packages/core/spec/knowledge-core-v1.md`): its index view
is this device's cache, `cache/<library>/crest-views/index.json`, projected again by any read that
finds it missing or out of date rather than read as a partial store, so another device reads the
same store and projects its own. The marker binds the library id and the library head, one digest
over every stream's head. Every crest write (and a whole knowledge batch) runs under this
machine's lock of the library, the lock every chain write takes; the mutation claim stays the
crash journal `knowledge-recover` reads, and two devices' concurrent crest writes are not made
safe against each other.

## Knowledge is written once and found at once

Knowledge is written once and found at once (TCRN-CROSS-STORY-476; MIN-227 D9, D25;
`packages/core/src/knowledge-core.ts`, `packages/core/src/knowledge-hint.ts`). A card is active and
retrievable the moment it is written: the candidate lifecycle and the promotion step are gone with
`knowledge-promote`, `knowledge-retire`, `retire-proposals` and `retire-sweep`, a card retires only
when a later card names it with `--supersedes`, and a write that names the candidate or retired
lifecycle is refused with `KNOWLEDGE_LIFECYCLE_RETIRED` and its remedy.
`knowledge-create --lifecycle` is optional and takes `active` alone; `knowledge-list --promotion`
and `knowledge-body --allow-unpromoted` are gone. Records written before keep the lifecycle and
promotion state they were written with. `knowledge.aggregateBytes` counts the bodies of live cards only, so a superseded
card gives its body back to the budget, and a refusal for the budget names `bodyBytes` and `limit`.
`--scope user` on `knowledge-create` and `knowledge-capture` files a card in this user's crest
(`crest` in the device directory, or the folder the device-level key `crest.userPath` names), which
every project recalls; `knowledge-capture --scope` also takes `role` (its default) and `workspace`.
`knowledge-list`, `knowledge-snippet` and `knowledge-body` read the user crest with `--scope user`.
`recall` reads both stores and reports each under `knowledgeStores`; a card hit carries `scope`
(`project` or `user`), and a user card's line reads `[卡片 用户]`. Every knowledge verb that writes a
card (create, capture, article-create, article-refresh, reverify and batch) answers `ids` beside
the store `version`: the card written, the card it superseded, and in a batch every member's. A
work record reaching done (`work-transition`, and each done member of `work-batch` under
`knowledgeHints`) and `minutes-record` answer `knowledgeHint`: the line
`是否有可提取的知识；可能冲突的卡：…` and `conflictCandidateIds`, the cards the write-time conflict
scorer finds against the record's title and goal or the minutes' summary, in both stores. A
possible conflict names the cards under `conflicts` on stderr.

## Two devices share the user crest through a synced folder

Two devices share the user crest through a synced folder without one device's late delivery
stopping the other (TCRN-CROSS-SUB-310; MIN-235 D7; `packages/core/src/knowledge-core.ts`,
`packages/core/src/recall-inputs.ts`). Each device appends immutable events under
`events/<device id>/`, and a same-subject pair two devices wrote before either saw the other is an
unresolved conflict, not a refusal of the whole crest: `knowledge-list --scope user` names such
pairs as `unresolvedConflicts`, its default selection leaves their cards out (`--selection all`,
`knowledge-snippet` and `knowledge-body` still read them), every other card reads, recalls and is
written as before, and a write whose `--supersedes` names either card of a pair resolves it. A
user-crest write records every conflict it was admitted beside in the new card's `coexistsWith`,
with `--coexist` or beside the card it supersedes; a card two devices each replaced is replaced,
and colliding replacements form a pair like any other. `recall` answers `userCrestDegraded` at its
top when the user crest gave fewer cards than it holds: the read's refusal code alone (such as
`KNOWLEDGE_LIMIT_EXCEEDED` for a merge past `knowledge.aggregateBytes`, whose disposition is still
pending), or `KNOWLEDGE_POSSIBLE_CONFLICT` with `unresolvedConflicts` and `withheldCards`; it is
absent otherwise. A user-crest `knowledge-create` whose event is committed answers from its own
scan (`version` is that scan's plus one) and never reads the crest again, so nothing delivered
meanwhile turns it into a refusal. `knowledge-recover --scope user` never writes the crest's
`store.json`: initialization by the first card is the one operation that does.

## Two devices that write one external key before either sees the other's no longer stop the user crest

Two devices that write one external key before either sees the other's no longer stop the user
crest either (TCRN-CROSS-SUB-413; STORY-476 D7; `packages/core/src/knowledge-core.ts`,
`packages/core/src/recall-inputs.ts`). The key's differing records are an unresolved duplicate, not
`KNOWLEDGE_PARTIAL_STATE`: `knowledge-list --scope user` names it at its top as
`unresolvedDuplicates` (`id`, `externalKey` and `versions`, each version's `deviceId`, `sequence`
and `eventHash` with its `updatedAt`, `subject` and `bodySha256`), its default selection and
`recall` leave every version out (`--selection all` lists each), and `knowledge-snippet` and
`knowledge-body` for the id answer every version under `versions` with the same entry at their
top. `recall` names it under `userCrestDegraded` as `unresolvedDuplicates`, with reason code
`KNOWLEDGE_DUPLICATE` when no pair is withheld as well; `withheldCards` counts every withheld card
and version. Every other card reads, recalls and is written as before, and each live version holds
budget. A write whose `--supersedes` names the id resolves it: every version is replaced at once,
leaves the budget and default recall, and stays readable by the id. A write of a key the crest
already holds is still refused as `KNOWLEDGE_DUPLICATE`, the same record delivered twice is one card,
and a forked or altered stream, or one stream holding two different records for one id, is still
refused naming its device. A user-crest write that supersedes a card of the metadata/body layout
reads that card's body as an explicit read does, rather than refusing it as not admitted.

## Two devices write one library's crest without sharing a file

Two devices write one library's crest without sharing a file (TCRN-CROSS-SUB-414; STORY-476 D7;
MIN-235 D7, O3; `packages/core/src/knowledge-core.ts`, `knowledge-batch.ts`, `store-backend.ts`,
`recall-inputs.ts`, `packages/cli/src/index.ts`; `packages/core/spec/knowledge-core-v1.md`). Each
device appends its cards to its own event stream, `crest/events/<device id>/`, and those streams are the authority: an
`einzbern.crest-event.v1` event holds the card's metadata, names its body file (written first), and
records `chain` -- every chain stream's head the write was checked against -- and `replaces`, the digest
of the record of the same card it replaces. `knowledge-reverify`, `knowledge-policy` and
`knowledge-article-refresh` append the card again as a new record; a supersede appends only the new
card, and reads project `supersededBy` over the card it names. `store.json` is written by
`knowledge-init` alone, once and exclusively, bound to the library id and that id's own digest (the
same bytes on every device); no card write, supersede, rebase, recovery, body migration, read or chain
write writes it, and no write takes a mutation claim. The CLI no longer rebases the crest after each
chain write: a library read answers at the chain head it replays (`eventHighWaterDigest` is that head,
`version` counts every event), so a chain write never leaves the crest trailing; `--allow-trailing` is
still taken and changes nothing about a library's answer (it keeps its meaning for an old-layout store);
and `knowledge-rebase` and `knowledge-batch --align-first` re-validate every record against the chain,
write nothing, and answer the same shape. For a library's crest `KNOWLEDGE_HIGH_WATER_MISMATCH` now
means a manifest that does not bind the library, or a record written against chain events this device
does not hold -- a folder that delivered the card first, or a partial restore that left the crest newer
than its chain (WSF-3): `knowledge-list` and a read of the id name those records under `awaitingChain`
and leave their cards out of default selection and recall, and `knowledge-validate`,
`knowledge-checkpoint` and `knowledge-rebase` refuse with details `awaitingChain`. A library's crest
merges its writers as the user crest does: a same-subject pair two devices wrote is
`unresolvedConflicts`, and one key two devices wrote, or one card two devices each wrote again, is
`unresolvedDuplicates`, both named by `knowledge-list` and a read of the id and resolved by
`--supersedes`; a library write now records in `coexistsWith` the conflicts it was admitted beside a
card it supersedes, as it did with `--coexist`. A crash leaves a committed event or a body no event
names, which reads ignore, so nothing needs recovering. The metadata/body layout an engine before event
streams wrote, its bodies in segments or not, stays readable and no new card rewrites it; the claim its
interrupted write left still locks writes until `knowledge-recover`, which completes that write without
writing `store.json`. A new crest is `store.json` alone until its first card; `knowledge-bodies-migrate`
answers zero bodies for a crest of event streams only and refuses an old-layout store; the exported
`StoreBackend` type has no `writeKnowledgeMarker`. This replaces the STORY-469 statement above that two
devices' concurrent crest writes are not made safe against each other. `recall` names the cards a
library's crest withheld at the top of its answer as `projectCrestDegraded`, in the form
`userCrestDegraded` has: reason code `KNOWLEDGE_POSSIBLE_CONFLICT` when an unresolved pair is withheld,
else `KNOWLEDGE_DUPLICATE` when versions of an unresolved duplicate are, else
`KNOWLEDGE_HIGH_WATER_MISMATCH` when records awaiting chain events are all it withheld;
`unresolvedConflicts`, `unresolvedDuplicates` and `awaitingChain` carry what `knowledge-list` names, each
present when it is not empty, and `withheldCards` counts every withheld card and version once. It is
absent when nothing is withheld, and a refused read stays `knowledgeReasonCode`. O-1 is unchanged: a
merge whose live bodies exceed `knowledge.aggregateBytes` is refused whole, and `recall` reports it under
`knowledgeStores.project`.

## A project deleted under a live card no longer stops a library's crest

A project deleted under a live card no longer stops a library's crest (TCRN-CROSS-SUB-414 R16;
STORY-476 D7; `packages/core/src/knowledge-core.ts`, `recall-inputs.ts`;
`packages/core/spec/knowledge-core-v1.md`). `project-delete` refuses only a project that still owns
live work, and a device that deletes a project cannot see a card another device wrote to it before
either received the other's write; every read and write of the crest then refused with
`KNOWLEDGE_LINK_INVALID`, the rebase with `KNOWLEDGE_REBASE_BLOCKED`, and a supersede of the card could
not get past the read. Such a card -- live, its project gone from the chain the read replays -- is now
named at the top of `knowledge-list` and of `knowledge-snippet` and `knowledge-body` for its id as
`unresolvedScopes` (`id`, `deviceId`, `sequence` and `eventHash`, all three null for a record of the
metadata/body layout, and `projectId`, the project that no longer resolves), leaves default selection
and `recall`, and is named under `unresolvedScopes` in `recall`'s `projectCrestDegraded`, whose reason
code is `KNOWLEDGE_LINK_INVALID` when no unresolved pair or duplicate is withheld as well (ahead of
`KNOWLEDGE_HIGH_WATER_MISMATCH`). Every other card reads, recalls and is written as before, and a write
of that card itself is refused naming it. `knowledge-validate` and `knowledge-checkpoint` still refuse
with `KNOWLEDGE_LINK_INVALID` and `knowledge-rebase` with `KNOWLEDGE_REBASE_BLOCKED`, now with details
`unresolvedScopes` and a `remedy` the CLI prints, `knowledge-create --supersedes <id>`, which is admitted:
a superseded record is not live, so nothing names it, the rebase no longer counts it an offender, and
all three answer again. A record whose scope contradicts itself still refuses the read, a forked or
altered stream is still refused naming its device, and pairs, duplicates, `awaitingChain`, dangling work
links, the user crest and O-1 are unchanged. `knowledgeStorePath` and `readKnowledgeStoreMarker` leave
the `packages/core/src/index.ts` barrel: the CLI's rebind after each chain write, which this Subtask
retired, was their last caller in a recorded consumer root, so platform-doctor's `unusedExports` leg
reported them. Both stay exported from `knowledge-core.ts`, the `allowedUnconsumedRationale` of
`scripts/policy/core-export-consumers.json` no longer says the CLI finds the store through
`knowledgeStorePath`, and `tests/platform-doctor.test.mjs` runs that leg on the checkout itself. The
spec no longer lists the retired `conference-close --distill` among the crest's card writes, and
`docs/architecture/backup-restore-runbook.md` adds that a chain write made after a partial restore
leaves the records awaiting chain events waiting for good, until the whole library is restored from one
snapshot.

## No budget bounds the sum of a crest's card bodies any more

No budget bounds the sum of a crest's card bodies any more (TCRN-CROSS-SUB-310 R17; MIN-238 D1,
D5; MIN-239 D1; `packages/core/src/knowledge-core.ts`, `settings.ts`;
`packages/core/spec/knowledge-core-v1.md`). Nothing counts the bodies of the library's crest or of
the user crest, so no read, write, `recall`, `knowledge-recover` or merge of two devices' streams is
refused for the bytes they add up to: a merge whose live bodies pass what `knowledge.aggregateBytes`
allowed (131,072 bytes unless set, 1 MiB at most) reads, recalls and takes the next card on every
device, and `recall` no longer reports such a merge as a refused store under `knowledgeStores` or
`userCrestDegraded`. Each card keeps its own limits: a body over 8,192 bytes, a summary over 2,048, a
snippet over 512, metadata over 32,768 or an article over the canonical ceiling is still refused with
`KNOWLEDGE_LIMIT_EXCEEDED` before anything is written. `knowledge.aggregateBytes` is a retired
setting: `settings-catalog` and Atelier's settings page no longer offer it, its label and explanation
leave all five languages, `settings-set` refuses it as `SETTINGS_KEY_UNREGISTERED`, and a value a
chain recorded replays as history and binds nothing. `knowledge-validate` no longer answers
`capacity`, the measure of live card bodies against that limit, and `KNOWLEDGE_LIMITS` has no
`maximumAggregateBytes`. This replaces the statements above that `knowledge.aggregateBytes` counts
the bodies of live cards and that a refusal for the budget names `bodyBytes` and `limit`
(TCRN-CROSS-STORY-476), that a merge past it is refused whole with its disposition pending
(TCRN-CROSS-SUB-310 and O-1, which MIN-238 D1 decided), that each live version of a duplicate holds
budget until it is resolved (TCRN-CROSS-SUB-413), and that O-1 is unchanged (TCRN-CROSS-SUB-414).

## No single canonical value bounds a crest's derived index or a list's digest any more

No single canonical value bounds a crest's derived index or a list's digest any more
(TCRN-CROSS-SUB-428, TCRN-CROSS-INC-398; `packages/core/src/knowledge-core.ts`;
`packages/core/spec/knowledge-core-v1.md`). With the body total gone, the index view -- every
record's metadata in one canonical value -- was the last bound on a crest: at about 300 cards with
2,000-byte summaries, the write that carried a library's index past the protocol's one-MiB ceiling was
refused with `INPUT_OVERSIZED` after its event was committed, and every read and write of the crest
was refused after it, `--supersedes` included; the user crest took that card and then refused every
read and write. The index's `indexDigest` and a `knowledge-list` page's `resultDigest` are now the
sha256 of the records' canonical list hashed one record at a time -- wherever the list fits one
canonical value, the digest it always was -- so `knowledge-validate`, `knowledge-list`, `recall` and
the knowledge hint, which read the whole crest as one page, answer at any size. This device's view
keeps the whole index in `index.json`, byte for byte as before, while it fits the ceiling and the
record-count limit; past either, `index.json` is a head, `tcrn.knowledge-index-pages.v1` (`count`,
`pages`, `indexDigest`), and the records are in `index-000001.json` onwards
(`tcrn.knowledge-index-page.v1`), each within the ceiling. A read projects a missing, damaged or
out-of-date page again and removes a page the head does not name, and a view that cannot be
projected, at a read or after a write's event is committed, is left for the next read: a committed
write is answered as committed (R14 (d)). `PROTOCOL_LIMITS.maxCanonicalBytes` and each card's limits
are unchanged, and an answer printed whole -- `knowledge-checkpoint`, `knowledge-freshness`,
`knowledge-source-check`, or a page asked for with `--limit` -- is still refused with
`INPUT_OVERSIZED` once it passes the ceiling.

## A knowledge card is valid or removed, and removed is terminal

A knowledge card is valid or removed, and removed is terminal (TCRN-CROSS-SUB-425; STORY-514 R1, R3,
R4; MIN-239 D3, D4, D6; `packages/core/src/knowledge-core.ts`, `recall-inputs.ts`, `hook-recall.ts`,
`knowledge-hint.ts`, `packages/cli/src/index.ts`, `portal/`; `packages/core/spec/knowledge-core-v1.md`,
`docs/wiki/Atelier.md`). `knowledge-remove --id --reason superseded|invalid|duplicate --basis --actor
--at` (with `--superseded-by` for `superseded` only, `--scope user` for the user crest) appends a
removal event, `einzbern.crest-removal.v1`, to this device's stream of the crest: the card, the
reason, the basis (at most 2,048 bytes), the actor (an `owner:`, `profile:` or `agent:` id) and the
card that supersedes it or null. It answers `KNOWLEDGE_UNIT_REMOVED` with the card as it is now kept
and `clearedBodies`; no verb restores a card. A card another card supersedes -- `--supersedes`, or the
mark an older engine stored -- is removed too, reason `superseded`, its basis naming the new card and
its actor the new card's accountable owner. Removal events travel with the crest and no event file is
deleted; a removal delivered before its card waits for it, and of two devices' removals of one card
the earliest stands. A removed card keeps its id, external key, subject, `supersedes` and `removal`
(`reason`, `basis`, `actor`, `removedAt`, `supersededBy`, and the event's `deviceId`, `sequence` and
`eventHash`); each device deletes the body files its own stream holds for removed cards at its next
write to that crest, the removing or superseding write included, while the metadata/body layout an
older engine left keeps its bodies until `knowledge-bodies-migrate --clear-removed true` clears them
(see below). `knowledge-list` and `recall` take `--status valid|removed|all`
(`recall` also `obsolete`, a decision status that leaves its cards valid), `valid` when left out and
echoed as `status`: default reads, `--selection all` among them, answer valid cards only, `removed`
the removed cards alone and `all` every card, each removed card as it is kept, and a recall hit on
one reads `[卡片 已移除]` and carries its `removal` as the list gives it. The prompt hook, the
knowledge hint, a checkpoint, `knowledge-freshness` and
`knowledge-source-check` read valid cards only. `knowledge-snippet`, `knowledge-body`,
`knowledge-reverify`, `knowledge-policy`, `knowledge-article-refresh`, a write superseding a removed card
and a second removal are refused with `KNOWLEDGE_CARD_REMOVED` (details `id`, `removal`, `remedy`),
and a removed card's id and key stay taken. A removed card is in no unresolved pair, resolves the
duplicate whose id it is, and is named in no `unresolvedScopes`; the crest's index view holds it as it
is kept, one record per id, and an old-layout store's index is unchanged. Atelier's knowledge list
reads valid cards and offers a card-status filter in all five languages; <code>&#47;api/knowledge?status=</code>
answers `removed` and `all`, and refuses another status with `PORTAL_KNOWLEDGE_STATUS_INVALID`. An
engine before this one refuses a crest that holds a removal event, or a record whose body this
engine cleared (a removed or superseded card), since it requires every card's body file
(`KNOWLEDGE_PARTIAL_STATE`). This replaces the statements
above that a card retires only when a later card supersedes it (TCRN-CROSS-STORY-476), that every
version of a duplicate a card supersedes stays readable by the id (TCRN-CROSS-SUB-413), and that reads
project `supersededBy` over the card a supersede names (TCRN-CROSS-SUB-414), and for knowledge cards it
replaces the audit copy MIN-235 D10 kept of a superseded body. `knowledge-core-v1.md` also stops saying
a write lands promotion state `promoted` (a new card carries none) and names, among what the library's
crest withholds, the cards whose project the chain no longer holds with `KNOWLEDGE_LINK_INVALID` and
`unresolvedScopes`.

## `knowledge-bodies-migrate` keeps every body of a crest whose metadata/body layout is already in segments

`knowledge-bodies-migrate` keeps every body of a crest whose metadata/body layout is already in
segments, and `--clear-removed true` clears the removed cards' bodies from that layout
(TCRN-CROSS-SUB-425 R18; fixes TCRN-CROSS-STORY-341; TCRN-CROSS-STORY-514 R4;
`packages/core/src/store-backend.ts`, `packages/core/src/knowledge-core.ts`,
`packages/cli/src/index.ts`, `packages/core/spec/knowledge-core-v1.md`,
`skill/mana-orchestrate/references/migrate.md`). The migration rewrote the segments from the body
files alone and removed every segment it had not written, so on a layout already in segments -- the
crest a library import carries over -- it found no body file, answered `before` 0 and `after` 0, left
an empty manifest, and every read of the crest then refused with `KNOWLEDGE_PARTIAL_STATE`; on a layout
partly in segments it kept only the bodies its leftover files held. It now writes the bodies of the
segments again beside the ones the body files add, refuses a body file whose segment holds a different
body before it writes, and writes nothing when no body file is left to move; `before` and `after`
count the bodies the layout holds before and after the run, and `bodyBytes` is their size after it. A
layout that still holds one body file per card migrates as before. With
`--clear-removed true --at <UTC>` the run also clears from that layout, which no device's writes
clear, the bodies of the removed cards -- superseded ones, by this engine or by the mark an older one
stored, and ones a removal event names. It runs only on a device whose writes are the library's only ones, chain and crest streams
alike, and otherwise refuses with the new reason code `KNOWLEDGE_SOLE_WRITER_REQUIRED` (details
`deviceId` and `writers`); it copies the layout's `bodies/` into `backups/<UTC>/crest-bodies/<library>/`
of the device directory first (a backup of the same second refuses with `KNOWLEDGE_ALREADY_EXISTS`),
keeps every other body byte for byte with the manifest and the point indexes, answers `clearedBodies`
and `backupDir`, and a second run changes nothing. A read of a library's crest admits a missing body in
that layout for a removed card's record alone. The migration reference runs the clearing once after
the import and once more after each later removal of carried cards. Metadata, event files, the streams' bodies and an
old-layout workspace's read-only store are not touched, and no verb is added.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[召回与钩子](Release-Notes-2.0.0-Recall-and-the-Hook.md) · 下一模块：[受管段、Command Spell 与门](Release-Notes-2.0.0-Managed-Sections-Rules-and-Gates.md)
