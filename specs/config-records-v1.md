# Config Records V1

## Status and scope

Project-level configuration records (TCRN-CROSS-STORY-478 R1, MIN-227 D13) are the part of a
project's configuration that is not a setting: what the engine recorded about the managed
sections it wrote into the project's files, which Command Spell rules are enabled, the custom
variables, the gate declarations, the leases actors hold on work items, and the gate and rule
changes that wait for Atelier's approval. They travel with the library, so every device that
merges the library reads the same records. `packages/core/src/config-records.ts` owns the
collections, the checks and the write functions; the replay arm in
`packages/core/src/workspace.ts` applies the events.

## Collections

The collections are a closed table. A collection outside it is refused on write
(`CONFIG_RECORD_COLLECTION_UNKNOWN`, with `details.known`) and its events are rejected on
replay.

| Collection | Holds | Story |
| --- | --- | --- |
| `managed-section` | a managed section's recorded revision, digest and state, keyed `<file>#<section id>` | TCRN-CROSS-STORY-478 |
| `rule` | a Command Spell rule's state, keyed by rule id | TCRN-CROSS-STORY-483 |
| `variable` | a custom variable, keyed by name | TCRN-CROSS-STORY-484 |
| `gate` | a gate declaration, keyed by gate name | TCRN-CROSS-STORY-485 |
| `lease` | a work lease, keyed by work id and scoped to the work item's project | TCRN-CROSS-STORY-528 |
| `proposal` | a gate or rule change that waits for Atelier, keyed `gate:<name>` or `rule:<id>` | TCRN-CROSS-STORY-527 |

Every record meets one common shape, and each collection may add its own check on top of it:

- the key is non-empty, without surrounding white space or control characters
  (`CONFIG_RECORD_KEY_INVALID`);
- the value is a plain JSON object that canonicalises completely (safe integers only; no product byte ceiling)
  (`CONFIG_RECORD_VALUE_INVALID`). A collection's own refusal is reported as
  `CONFIG_RECORD_VALUE_INVALID` with its own code in `details.refusedBy`.

## Events

| Operation | Record |
| --- | --- |
| `config.record.set` | exactly `{collection, key, value}` with optional `projectId` |
| `config.record.removed` | exactly `{collection, key}` with optional `projectId` |

A record of any other shape is `CONFIG_RECORD_EVENT_INVALID`. The payload is the common
`{operation, record}` (plus `actor` once attestation is enabled).

TCRN-CROSS-STORY-526: the payload may also carry how the write was let through (see
actor-attestation-v1, optional authorization extras): `surface` (`cli` or `atelier`) and
`decidedIn` (`minutes:<id>#D<n>`) with `decidedInLibraryId`. `setConfigRecord`,
`removeConfigRecord` and their deltas take them as `authorization`; the gate, variable and
rule writes pass theirs through, a rule change on each event it appends. Without one the
payload is exactly `{operation, record}`. A surface, decision number or library id that is
not one is `WORKSPACE_EVENT_CORRUPT` on replay. TCRN-CROSS-STORY-527 (Q5): the events of
Atelier's approval of a proposal cite the proposal instead of a decision number (see Proposals).

## Merge

Events are replayed in merge order: clock, then device id, then sequence. The set applied last
is the one every device reads, so when two devices write one key without seeing each other's
write, the write with the later clock wins, and on one clock the write from the device whose id
sorts last. A later write to a key is never a rejected event.

A removal of a key the merged state does not hold at that point — another device removed it
first — does not apply: it is recorded among the library's rejected events
(`WORKSPACE_EVENT_CORRUPT`, detail `CONFIG_RECORD_NOT_FOUND:…`) and skipped, and the read
succeeds. The same holds for an event naming an unknown collection or carrying a malformed
record. A write refuses to remove a key the merged state does not hold
(`CONFIG_RECORD_NOT_FOUND`).

An old-layout workspace has no such operation: it holds no records, a record event in its chain
is corrupt, and a record write to it refuses with `LEGACY_WORKSPACE_READ_ONLY`.

## Merged state and cache

`WorkspaceState.configRecords` lists every record as `{collection, key, value}` with optional
`projectId`, sorted by project identity, collection and key. Legacy records without a project
identity are library defaults. A declared project uses its own record first, then explicit
parent records and library defaults for rules and variables. Gate declarations and managed
sections never inherit: their roots, covers and file records belong to the selected target.
`scopedWorkspaceState` returns a consumer view and source provenance; writes and export keep
the complete native state. `configRecords(state, collection)` and `configRecord(state, collection,
key)` read them. The device cache's replay snapshot keeps them; a snapshot written without them
is not used as a seed.

`recover` rebuilds this device's cache of a library: it drops the cache, replays every stream from
genesis and writes the views and a snapshot of the result, strictly and by force. Unlike the writes
that append, it holds the library write lock for its whole run (TCRN-CROSS-STORY-538): it appends
nothing, and held from the drop to the forced write the lock keeps every write on this machine from
committing in between, so the cache it leaves and the state it reports are of one head, the library
as it stands when it returns. Narrowed like an append, it would replay from genesis again whenever
a write landed during its replay, and on a busy library fall back to holding the lock for a replay
anyway. `specs/cli-catalog-v1.md` gives the same reason beside what every other write holds the lock
for ("What each write holds the library write lock for (2.2.0)").

## Writes

`setConfigRecord` and `removeConfigRecord` check their input, read the merged state and check the
change against it before any lock is taken (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-481). Under this
machine's write lock of the library they only check that no stream moved since that read, then
append one event to this device's stream and rewrite `config/project.json`. Like every other
append (`specs/cli-catalog-v1.md`, "What each write holds the library write lock for (2.2.0)"),
a write that finds a stream moved reads and checks again, and one that other writers outran four
times reads and checks under the lock.
`setConfigRecordDelta` and `removeConfigRecordDelta` are the same changes as deltas for a
caller that appends several events at once.

## Projection

`config/project.json` (`einzbern.project-config.v1`) carries `records` beside `values`: the
library-default records grouped by collection, then keyed by record key, holding each
record's value. `projects` maps each stable project ID to its own `values` and `records`;
these are declarations, not flattened inherited copies. Every
project-level write rewrites it, settings writes included, so neither kind of write drops the
other's part. No read trusts it. `configProjectionStatus(libraryRoot, settings, records)` judges
the records as well as the values when the records are passed; a projection written before
records existed carries no `records` and reads as holding none.

## Work leases

The `lease` collection (TCRN-CROSS-STORY-528, MIN-256) holds the leases actors take on work
items. `packages/core/src/work-lease.ts` builds every write to it, the lease removals a delete
appends included; nothing else writes it.

- The key is the work item's id, and the record is scoped to the item's project: a `lease` record
  or event without `projectId` is refused (`CONFIG_RECORD_VALUE_INVALID` on write,
  `CONFIG_RECORD_EVENT_INVALID` on replay).
- The value is exactly `{holder, claimedAt, expiresAt}`: the holder an actor id, both instants in
  UTC, and the lease running from one minute to 24 hours. Anything else is refused with
  `CONFIG_RECORD_VALUE_INVALID`, `details.refusedBy` `WORK_LEASE_INVALID`.
- A claim sets the record and a release removes it, one event each, through the same
  `config.record.set` and `config.record.removed` events as every other record. A claim by the
  holder renews the lease. A claim is refused with `WORK_LEASED` while another actor holds an
  unexpired lease on the item, on an item above it or on an item below it; `details` name the
  holder, `expiresAt` and the `leasedWorkId`.
- The holder releases at any time; another actor needs force while the lease runs (the CLI grants
  it to Atelier, and to a model's run that cites an Owner decision naming the work item by its id or
  its external key with `--decided-in minutes:<id>#D<n>`, TCRN-CROSS-STORY-541; the release's
  `config.record.removed` then records the authorization, as any configuration write does), and a
  lease that has run out binds no one, so anyone may clear it. Releasing an item that holds no
  lease is `WORK_LEASE_NOT_FOUND`.
- A lease does not outlive its item (TCRN-CROSS-STORY-535). Deleting a work item removes its lease
  in the same append: `work-delete`, by any actor and whether or not the lease still runs, writes the
  lease's `config.record.removed` just before `work.deleted`. A delete is not a write a lease
  guards; an item without a lease is deleted in one event, as before, and a refused delete leaves
  the lease in place.
- Nor does a lease that binds no one hold up a project's delete. `project-delete` judges the
  project's leases at its own `--at`: one that has run out, or whose work item is deleted or absent
  (a delete written before the rule above left it behind), is removed in the same append, one
  `config.record.removed` each, before `project.deleted`. One that still runs on a live work item
  refuses the delete with `WORK_LEASED`, whoever asks; `details` name the `workId`, the `holder`
  and `expiresAt` (with `leasedWorkId` and `projectId`), and nothing is written. The project's
  other refusals are as they were.
- Both deletes hold the library write lock for their append alone (TCRN-CROSS-STORY-538): they
  read and check outside it, so a refusal does not wait for another writer, and judge the leases
  again where the append builds its events, against the state it is built on, from which the
  lease removals are planned. A lease released or cleared in between is not removed. `work-delete`
  removes the lease the item held when the delete read it, and one that has run out by its `--at`;
  a lease claimed on the item since the read, or claimed again over the one read, that still runs
  at `--at` refuses the delete with `WORK_LEASED`, whoever asks, with the details a claim's refusal
  has, and nothing is written. `project-delete` judges the project's leases at the append as above,
  so one claimed since its read on a live item refuses it with `WORK_LEASED`.
- Whether a lease runs is judged against the instant of the write (`--at`); the engine reads no
  clock. A display may judge it against the reader's present instant, for reading only.
- A lease check made before a write (TCRN-CROSS-STORY-536) -- `work-transition` to `done`, before
  the Story's gates are judged, and the transition and annotation members of a `work-batch` --
  judges leases only at an `--at` the write takes. An `--at` that is not a strict instant skips the
  check, and the write itself refuses it with `TIMESTAMP_INVALID`, as in a library that holds no
  lease (a Story going to `done` with no green run is refused by its gates first).
- Leases are not projected: `config/project.json` and `configProjectionStatus` leave the
  collection out, so a claim or a release writes no projection and a library without leases
  projects exactly as before.

An engine that predates the collection rejects its events on replay like any unknown collection's
(they are recorded among the rejected events and skipped), so every device that reads a library
needs an engine that knows `lease` before leases are written to it.

## Proposals

The `proposal` collection (TCRN-CROSS-STORY-527, MIN-257 D6) holds the changes to a gate declaration
or to a Command Spell rule that a model proposes and Atelier approves or rejects.
`packages/core/src/config-proposals.ts` writes it; nothing else does.

- The key names what the proposal would change, `gate:<gate name>` or `rule:<rule id>`, and the
  record is scoped as that gate or rule is (`projectId`, or the library when absent). A proposal
  belongs to its scope and is not inherited.
- The value is exactly `{kind, action, payload, status, proposedBy, proposedAt}`, with `rejectedBy`
  and `rejectedAt` as well when `status` is `rejected`. `kind` is the key's prefix; `action` is
  `set` or `remove` for a gate and `enable` or `disable` for a rule; `payload` is the whole gate
  declaration for `set` (checked as a gate record is), `{}` or `{order}` for `enable`, and `{}`
  otherwise; `status` is `pending` or `rejected`; the actors are actor ids and the instants UTC.
  Anything else is refused with `CONFIG_RECORD_VALUE_INVALID`, `details.refusedBy`
  `PROPOSAL_INVALID` (or the gate declaration's own `GATES_CONFIG_INVALID`).
- Proposing sets the record, pending, at the write's instant; proposing the same target again
  replaces it, a rejected one included. A gate removal is proposed only for a gate the scope
  declares (`CONFIG_RECORD_NOT_FOUND`), a rule enable only for a rule the engine ships, a rule
  disable for one it ships or the library records (`RULE_UNKNOWN`).
- Approving appends, in one append, the change the proposal names -- the same `config.record.set`
  or `config.record.removed` a direct write appends (for a rule, with its managed-section record,
  AGENTS.md written first and put back when the append fails) -- then the proposal's
  `config.record.removed`. Every event of an approval carries `surface` `atelier`, `decidedIn`
  `proposal:<key>@<proposedAt>` and `decidedInLibraryId`, this library's id.
- Rejecting rewrites the record as `rejected` with `rejectedBy` and `rejectedAt`; it stays readable.
- An approval or a rejection names the `proposedAt` it read. A key with no proposal is
  `PROPOSAL_NOT_FOUND`; a rejected proposal is `PROPOSAL_NOT_PENDING` until it is proposed again; a
  proposal recorded since at another instant is `PROPOSAL_STALE` (`details.required` the recorded
  instant, `details.actual` the one named). A refusal appends nothing.
- Proposing, rejecting and approving hold the library write lock for their append alone
  (TCRN-CROSS-STORY-538): the proposal is read and checked before the lock is taken, so a refusal
  does not wait for another writer, and checked again against the state the append is built on, so
  a proposal another writer settled or proposed again in between is refused there with the codes
  above. A rule's approval writes AGENTS.md from the proposal it read, so one proposed again since
  at the same instant with another change is `PROPOSAL_STALE` too, and AGENTS.md is put back.
- A proposal is not a declaration: gates, rules, plans, runs and managed sections read the `gate`
  and `rule` collections only. Proposals are not projected: `config/project.json` and
  `configProjectionStatus` leave the collection out, and a proposal or a rejection writes no
  projection.

An engine that predates the collection rejects its events on replay like any unknown collection's,
and rejects the approval events whose `decidedIn` cites a proposal, so the change an approval wrote
is not applied there either: every device that reads a library needs an engine that knows proposals
before they are written to it.

## Explicit chain configuration

The `chain` collection is added in library format 2. `identity` is library scoped
and requires `{role: "coordination" | "project", coordinationLibraryId}`. A
coordination identity points to its own stable library id. Optional `primaryProjectId`
is an explicit canonical project binding used on restore and a second device;
it is validated against the owning library, never inferred from a sole project. Missing identity is
unclassified; labels, paths and project count never classify a library. The
project-scoped `common-default` key is an explicit `{libraryId, projectId}` opt-in.
`repositories` requires a nonempty `bindings` list whose unique ids each name
`id`, `name`, `repository`, `buildService` and `buildProject`. This represents
Einzbern and generated Mana as two repositories of one product without inventing
a real migration identity. The ordinary engine set/replay/config projection is
the sole persistence route. Device registries contain locations, not authority.
