# Config Records V1

## Status and scope

Project-level configuration records (TCRN-CROSS-STORY-478 R1, MIN-227 D13) are the part of a
project's configuration that is not a setting: what the engine recorded about the managed
sections it wrote into the project's files, which Command Spell rules are enabled, the custom
variables, and the gate declarations. They travel with the library, so every device that
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

Every record meets one common shape, and each collection may add its own check on top of it:

- the key is 1 to 512 UTF-8 bytes, without surrounding white space or control characters
  (`CONFIG_RECORD_KEY_INVALID`);
- the value is a JSON object that canonicalises (safe integers only) to at most 65536 bytes
  (`CONFIG_RECORD_VALUE_INVALID`). A collection's own refusal is reported as
  `CONFIG_RECORD_VALUE_INVALID` with its own code in `details.refusedBy`.

## Events

| Operation | Record |
| --- | --- |
| `config.record.set` | exactly `{collection, key, value}` |
| `config.record.removed` | exactly `{collection, key}` |

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

`WorkspaceState.configRecords` lists every record as `{collection, key, value}`, sorted by
collection, then key. `configRecords(state, collection)` and `configRecord(state, collection,
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
records grouped by collection, then keyed by record key, holding each record's value. Every
project-level write rewrites it, settings writes included, so neither kind of write drops the
other's part. No read trusts it. `configProjectionStatus(libraryRoot, settings, records)` judges
the records as well as the values when the records are passed; a projection written before
records existed carries no `records` and reads as holding none.
