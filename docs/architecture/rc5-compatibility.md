# rc.4 → rc.5 Workspace Compatibility and Migration

This is the normative compatibility statement for a workspace control tree that
was written or read by an `0.1.0-rc.4` binary and is now used by an
`0.1.0-rc.5` binary (the governed-conference / gate / actor-attestation surface).
It records what stays readable, what fails closed on purpose, and the one-way
boundaries an operator must accept before enabling them.

All paths below are workspace-relative placeholders. `<root>` is the Workspace
authority root — the directory that contains the old-layout control directory, written `<control>/` below (its name is in [the alias table](../wiki/Glossary.md); from EPIC-141 on the engine only reads it). Paths with spaces
are first-class; always double-quote them. No hostnames or home paths appear in
this document, and none are written into a workspace by any procedure it
describes.

## The short version

| Direction | Behaviour |
| --- | --- |
| rc.4 workspace → rc.5 binary | **Fully readable.** A workspace that carries only the frozen `work-model-v1` operations (project/work) is byte-identical under rc.5; no migration step is required. |
| rc.5 workspace with only project/work events → rc.4 binary | **Readable.** `storageVersion` stays `1` and the on-disk shapes are unchanged, so an old binary reads it. |
| rc.5 workspace carrying conference / gate / attestation events → rc.4 binary | **Fails closed as corruption (intentional).** See the next section — this is forward-incompatibility, not data loss. |
| Attestation-enabled workspace → any binary | **One-way.** Once enabled, actor attestation cannot be turned off. See "Attestation is one-way". |

The current local storage revision is additive: new event writes use byte-bounded
NDJSON segments and derived sidecars, while old count-based JSON segments remain
readable. Read paths may load an atomic replay checkpoint and apply only the
tail. This performance layout does not alter append-only history or the
forward-incompatibility rule described below.

## Forward incompatibility is intentional, not data loss

The rc.5 surface adds additive workspace event-log operations —
`conference.created`, `conference.updated`, `conference.position.appended`,
`conference.closed`, `gate.created`, `gate.updated`, `gate.deleted`, and the
`attestation.actor.enabled` chain event. It does **not** bump the storage
version: `storageVersion` stays `1` (`WORKSPACE_STORAGE_VERSION = 1`).

This is the OD-20 forward-compatibility posture. An old rc.4 binary that replays
a chain containing one of these operations reaches the reducer's terminal
`fail("WORKSPACE_EVENT_CORRUPT", "unknown operation <operation>")` — it has no
reducer branch for the operation, so it stops rather than guessing. To an rc.4
user this surfaces as `WORKSPACE_EVENT_CORRUPT`, which reads like corruption. It
is not: the bytes are intact, the hash chain is sound, and an rc.5 binary reads
the same tree cleanly. The old binary is refusing an operation it does not
understand, exactly as a fail-closed engine should.

Two consequences follow from keeping `storageVersion` at `1`:

- A rc.5 workspace that has **never** appended a conference, gate, or attestation
  event is still readable by rc.4. Byte-stability for the no-extension case is a
  proven property, not a hope (see `EXT-CONFERENCE-GATE-STORE`): views, export,
  and archive bytes are identical to rc.4 for a workspace with no extension
  events, and the `views/extensions.json` verification summary is emitted only
  when extension records exist. That file's shape changed in 1.0.0 from an
  index carrying the records to a fixed-length summary carrying their digests;
  the emission condition, and therefore the no-extension byte-stability claim
  above, is unchanged.
- Because the version was not raised, there is no numeric downgrade signal. rc.4
  does not report `WORKSPACE_MIGRATION_FUTURE` (that fires only when an on-disk
  `storageVersion` is numerically greater than the binary's, and it is not).
  The refusal is per-operation, at replay time, via `WORKSPACE_EVENT_CORRUPT`.

**Operator guidance.** Treat "conference / gate / attestation" as an rc.5-only
capability. Once a workspace has appended any of these events, standardize its
whole toolchain on rc.5. There is no supported path that lets an rc.4 binary
read past an event it cannot reduce, and none is planned for V1.

## Attestation is one-way

Actor attestation was enabled by appending a single `attestation.actor.enabled`
chain event. The verb that wrote it (`attestation-enable`) is retired
(TCRN-CROSS-STORY-467 R2); a chain that carries the event keeps the rule below. The
record is minimal (`{schemaVersion, version:1}`) and touches no record graph.

From the enabling event's sequence onward — that event included — a valid `actor`
id is **mandatory** on every appended event. The live append path and the replay
reducer enforce the identical rule:

- A mutation with no actor after enable fails closed `WORKSPACE_ACTOR_REQUIRED`.
- An actor whose id does not match the required shape fails
  `WORKSPACE_ACTOR_INVALID`.
- A hand-tampered log that drops or forges the actor on a post-enable event fails
  `WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID` at replay, so the
  binding cannot be edited out after the fact.

There is **no disable operation** in V1. Appending a second
`attestation.actor.enabled` to an already-attested workspace fails closed
`WORKSPACE_INPUT_INVALID` ("actor attestation is already enabled"), and no verb
removes the enable event. The `--actor` flag on the mutation verbs stays
catalog-optional because the **engine**, not the CLI vocabulary, makes it
mandatory once the event is present; on a non-enabled workspace, omitting
`--actor` produces a byte-identical result to rc.4.

**Operator guidance.** Enabling attestation is a deliberate, irreversible
governance decision for a workspace. Decide it once, up front. After it, every
tool and every automated caller that mutates the workspace must supply an actor
id; a caller that does not will fail closed on its first mutation.

## Knowledge stores: metadata schema evolution

The Knowledge Core store is a **disposable derived index**, never the system of
record. A library keeps it in `crest/`; an old-layout workspace's store stays in
`<root>/<control>/knowledge/`, where the current engine only reads it. Its store
marker carries `disposable: true` and
`authority: "metadata-index-authority-body-separate"`. The system of record is
the workspace event log (projects, work, conferences, gates, decisions) — that
authority is what is preserved across any knowledge metadata schema change,
because the event log's `storageVersion` stays `1`. The metadata schema is still
`tcrn.knowledge-unit-metadata.v1`.

**Historical record (rc.4 → rc.5).** An rc.5 store bound itself to that metadata
schema version and to the workspace head through `eventHighWaterDigest`, and two
maintenance paths existed. After a head advance, `knowledge-rebase` re-bound the
store to the new head, failing closed on records whose references no longer
resolved unless it was told to retire them as tombstoned audit records. A
metadata schema change was met by re-initializing a fresh disposable store and
re-capturing its units (the procedure below); there was no in-place metadata
upgrader. Neither re-binding nor that retirement is current.

**Current engine.** `packages/core/spec/knowledge-core-v1.md` ("Storage and
authority", "High-water rebase", "Lifecycle") is the normative statement; in
short:

- **Nothing to re-bind** (TCRN-CROSS-SUB-414). A library's store binds no chain
  head: its marker binds a digest of the library id, each device appends its
  cards to its own stream in `crest/events/`, and every read projects the store
  at the chain head it replayed, so a chain write never leaves the store behind.
- **Re-validation writes nothing.** `knowledge-rebase`, like
  `knowledge-batch --align-first`, re-checks every record's shape, body binding
  and scope/project/work links against the chain as it stands. It refuses with
  `KNOWLEDGE_REBASE_BLOCKED` over a valid card whose scope or project no longer
  resolves (a card whose project is gone is named with the remedy
  `knowledge-create --supersedes <id>`), and with
  `KNOWLEDGE_HIGH_WATER_MISMATCH` over a record written against chain events
  this device does not hold yet. Linked work the chain no longer holds is
  reported as `danglingWorkLinks` and refuses nothing. Re-validation is **not** a
  schema migration.
- **No retirement by links.** A card is valid or removed, and removal is final: a
  later card that names it with `--supersedes` removes it as superseded, and a
  card judged invalid, or one that repeats a work item or a decision, is removed
  explicitly. Deleting a work item removes no card; a card whose project was
  deleted leaves default selection until a card supersedes it.

### Disposable re-initialization procedure

**Historical record (rc.4 → rc.5).** The steps below are kept as the rc.4 → rc.5
procedure and do not run on the current engine. From EPIC-141 on the engine only
reads an old-layout workspace, so step 3's `knowledge-init` on `<root>` is refused
with `LEGACY_WORKSPACE_READ_ONLY`. To carry an old-layout workspace forward now,
import its chain into a library with
`library-import-legacy --legacy "<root>" --at <instant>` (`LEGACY_IMPORTED`).
`<library>` is the library the import created, the `target` its result names. The
import carries the old workspace's knowledge store into the library's `crest/` as
it is: its cards read as before, and a new card is written straight away with
`knowledge-create --workspace "<library>"` (`KNOWLEDGE_UNIT_CREATED`); a
`knowledge-init` there answers `KNOWLEDGE_ALREADY_EXISTS`. Only when the old
workspace had no knowledge store does the library need one first:
`knowledge-init --workspace "<library>" --acknowledge-disposable true`
(`KNOWLEDGE_STORE_INITIALIZED`), without which a `knowledge-create` fails
`KNOWLEDGE_PATH_INVALID`. `commands` lists the three verbs and their flags.

1. **The authority is safe.** The workspace event log under
   `<root>/<control>/events/` is the system of record and is untouched by
   this procedure. Nothing below rewrites a workspace event.

2. **Remove the derived store.** Delete `<root>/<control>/knowledge/`. This
   is a derived index; its metadata and views are re-derivable and are not the
   source of truth. (`knowledge-init` writes a *new* store directory and will not
   overwrite an existing one, so the old store must be cleared first.)

3. **Re-initialize under explicit acknowledgment.**

   ```
   pnpm --silent exec einzbern knowledge-init --workspace "<root>" --acknowledge-disposable
   ```

   Every non-fixture workspace must pass `--acknowledge-disposable`; without it,
   initialization fails closed `KNOWLEDGE_DISPOSABLE_ACK_REQUIRED`. The
   acknowledgment is the operator affirming, per invocation, that this store is a
   disposable derived index. A fresh store reports `KNOWLEDGE_STORE_INITIALIZED`
   with `records: 0` and binds to the current workspace head.

4. **Re-capture units.** Re-create the knowledge units you need with
   `knowledge-create`. A card is valid and retrievable once written, so there is
   no promotion to restore, and it leaves the valid cards only when it is
   removed, by a later card that names it with `--supersedes` or explicitly as
   invalid or as a repeat of a work item or a decision: `knowledge-promote` and
   `knowledge-retire` are retired (TCRN-CROSS-STORY-476). `knowledge-reverify`
   restores a fresh posture. Conference-distilled decisions are not re-derived:
   `conference-close --distill` retired with the conference write path
   (TCRN-CROSS-STORY-475 R3) and answers `CLI_COMMAND_UNKNOWN`. The conference
   minutes stay in the event log, where `minutes-list` and `minutes-show` read
   them (their valid decisions by default, `--status obsolete|all` for the rest).
   A decision is not copied into a card: a card that repeats a valid decision is
   refused with `KNOWLEDGE_ALREADY_RECORDED`.

### Preserved vs re-derived

**Historical record (rc.4 → rc.5).** The table is what the re-initialization
above kept and rebuilt for an rc.5 store. The cells marked rc.5 describe that
store only: a library's store on the current engine has no promotion state, and
its marker binds a digest of the library id rather than a chain head (see
"Current engine" above).

| Preserved (system of record, untouched) | Re-derived (disposable, rebuilt on re-init) |
| --- | --- |
| The workspace event log: projects, work, conferences, gates, decisions — every hash-chained event. | The knowledge metadata index and `views/` under `knowledge/`. |
| Conference minutes and gate evidence recorded as events. | Per-unit promotion state (rc.5) and freshness posture. |
| `storageVersion` and the workspace head. | The store marker's `eventHighWaterDigest` binding, re-bound to the current head at init (rc.5). |

Because the durable authority is the event log, a metadata schema change never
risks the governed record. It costs a re-capture of the derived index, which is
what "disposable" buys.

## Capability vs pinned release

Use this table to decide which binary a workspace requires. "rc.4-safe" means an
rc.4 binary reads the workspace without error.

| Capability present in the workspace | Required binary | rc.4-safe? |
| --- | --- | --- |
| Only `work-model-v1` project/work events | rc.4 or rc.5 | Yes |
| Any conference event (`conference.*`) | rc.5 | No — `WORKSPACE_EVENT_CORRUPT` on rc.4 |
| Any gate event (`gate.*`) | rc.5 | No — `WORKSPACE_EVENT_CORRUPT` on rc.4 |
| Fail-closed gate enforcement (`WORKSPACE_GATE_PENDING`) exercised | rc.5 | No — the pending-gate event is a `gate.*` event |
| `attestation.actor.enabled` appended | rc.5 | No — unknown operation on rc.4, and one-way thereafter |
| Knowledge store on the evolved metadata schema | rc.5 | Store is disposable; event-log authority stays rc.4-safe |

The knowledge store row is deliberately separate: the store is not part of the
workspace event log, so its schema does not change the rc.4-safety of the
authority. Only the derived index needs the newer binary to read.

## Reason codes referenced

Every code below is emitted by the shipped engine; grep the source to confirm.

- `WORKSPACE_EVENT_CORRUPT` — the fail-closed reducer verdict, including the
  `unknown operation` refusal an rc.4 binary hits on an rc.5-only event.
- `WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID` — mandatory-actor
  enforcement after attestation is enabled, live and on replay.
- `WORKSPACE_INPUT_INVALID` — a duplicate `attestation.actor.enabled` (already
  enabled).
- `WORKSPACE_GATE_PENDING` — a pending gate refusing a work transition to `done`.
- `WORKSPACE_MIGRATION_FUTURE` / `WORKSPACE_MIGRATION_DOWNGRADE` — the numeric
  storage-version guards; not triggered by the rc.4 → rc.5 additive events,
  documented here so operators know they are a different mechanism.
- `KNOWLEDGE_DISPOSABLE_ACK_REQUIRED` — `knowledge-init` without
  `--acknowledge-disposable` on a non-fixture workspace.
- `KNOWLEDGE_REBASE_BLOCKED` — `knowledge-rebase`, a re-validation that writes
  nothing, over a valid card whose scope or project no longer resolves; linked
  work that no longer resolves is only reported (`danglingWorkLinks`).
- `KNOWLEDGE_HIGH_WATER_MISMATCH` — a library's store holding records written
  against chain events this device does not hold yet, which validate, checkpoint
  and rebase refuse (see `backup-restore-runbook.md`); for an old-layout store, a
  marker bound to a head that is not its chain's.
- `KNOWLEDGE_STORE_INITIALIZED` — a fresh disposable store after re-init.
