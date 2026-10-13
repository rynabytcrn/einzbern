# Config Records V1

## Status and scope

Project-level configuration records (TCRN-CROSS-STORY-478 R1, MIN-227 D13) are the part of a
project's configuration that is not a setting: what the engine recorded about the managed
sections it wrote into the project's files, which Command Spell rules are enabled, the custom
variables, the gate declarations, and the leases actors hold on work items. They travel with the library, so every device that
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

## Writes

`setConfigRecord` and `removeConfigRecord` check their input before any lock is taken, then run
as this machine's only writer of the library: they read the merged state under the library's
lock, append one event to this device's stream, and rewrite `config/project.json`.
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
items. `packages/core/src/work-lease.ts` writes it; nothing else does.

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
  it to Atelier only), and a lease that has run out binds no one, so anyone may clear it. Releasing
  an item that holds no lease is `WORK_LEASE_NOT_FOUND`.
- Whether a lease runs is judged against the instant of the write (`--at`); the engine reads no
  clock. A display may judge it against the reader's present instant, for reading only.
- Leases are not projected: `config/project.json` and `configProjectionStatus` leave the
  collection out, so a claim or a release writes no projection and a library without leases
  projects exactly as before.

An engine that predates the collection rejects its events on replay like any unknown collection's
(they are recorded among the rejected events and skipped), so every device that reads a library
needs an engine that knows `lease` before leases are written to it.

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
