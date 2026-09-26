# Ether Library V1

A library is the directory that holds one project's records (TCRN-CROSS-STORY-469). Its
conventional name is `.ether`, and it may live inside the project or anywhere else, a
cloud-synchronised folder included. This document states what a library contains, who
writes each file, and how every write stays safe to read at any moment.

## Root

A library's root holds exactly seven entries:

| Entry | What it is | Writer |
| --- | --- | --- |
| `manifest.json` | the library manifest (below) | the engine, when the library is created, when its format changes and when it moves |
| `akasha/` | the event truth: one directory per device | each device writes only its own directory |
| `crest/` | the knowledge store | the engine |
| `config/` | a readable projection of the project-level settings and configuration records | the engine, when a project-level setting or configuration record is written |
| `artifacts/` | content-addressed files | the engine |
| `README.md` | what each name here means, and the old names beside the new ones | the engine, when the library is created |
| `.gitignore` | exactly `*` and a line feed | the engine, when the library is created |

`.gitignore` ignores every entry of the library, itself included, so a library inside a
Git working tree never shows in `git status`. Derived state — views, replay snapshots,
indexes — is never written into a library; it lives in the device directory's cache.

## Library manifest

`manifest.json` is canonical JSON with exactly these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `einzbern.library-manifest.v1` |
| `libraryId` | `library:` and 24 lowercase hex digits, drawn when the library is created; a library imported from an old-layout workspace keeps that workspace's `workspace:` id |
| `formatVersion` | the library format, a positive integer (1) |
| `minEngineVersion` | the lowest engine version that may open the library |
| `project` | `{name, gitRemote}`, each bounded single-line text or null: a hint for a reader, not an identity |
| `createdAt` | the strict UTC instant the library was created |

The manifest is written last when a library is created: a directory without one is not a
library, so a creation that stops half-way leaves nothing that opens. Streams are found by
listing `akasha/`, not from the root manifest, so the root manifest keeps a single writer
and changes only on the three occasions above.

## Format and engine version

An engine opens a library only when the library's `formatVersion` is at most the newest
format the engine reads and its `minEngineVersion` is at most the engine's own version
(TCRN-CROSS-STORY-471 R1). Versions compare by semantic-version precedence: major, minor
and patch as whole numbers, a pre-release below its release, pre-release identifiers
numerically when both are digits and otherwise in ASCII order. The check reads only those
two fields, before the rest of the manifest is judged, because a newer format may change
the rest; and it runs when the library is opened, before any lock is taken, any cache is
read or anything is written, so an older engine meets a newer library with a reason code
and leaves it byte for byte as it was:

| Reason code | When | Details |
| --- | --- | --- |
| `LIBRARY_FORMAT_UNSUPPORTED` | `formatVersion` is newer than the engine reads | `required` (the library's format), `supported` (the newest the engine reads) |
| `ENGINE_TOO_OLD` | `minEngineVersion` is above the engine's version | `required`, `actual` |

A stream manifest whose `formatVersion` is newer than the engine reads is refused the same
way and names its device (`deviceId`).

## Upgrading every device first

A library changes format only after every device that writes it can read the new one
(TCRN-CROSS-STORY-471 R4). The devices a library knows are its `akasha/` directories; each
stream manifest records the engine version that last wrote it, and a directory without a
committed manifest is a device whose version is unknown. `libraryUpgradeReadiness(library,
{targetFormat})` (`packages/core/src/akasha.ts`, judged by `upgradeReadiness` in
`packages/core/src/format-version.ts`) calls a device ready when its version is known and at
least the one required: the library's `minEngineVersion` while the format stays, and the
writing engine's own version when the target format is newer than the library's. This device
is always ready, since it runs the writing engine. While a device is not ready the answer
carries a plain hint: `先把以下设备升级到 ≥<version> 再写入新格式：<device>（<version>）`, with
`版本未知` for a device whose version is unknown and the device id for one without a name.

Every write that raises a library's `formatVersion` MUST first call it with the new format and
pass the answer to `assertUpgradeReady`, which refuses with `LIBRARY_UPGRADE_NOT_READY` (the
hint as its message, `required`) while another device is behind; a write that keeps the format
is never refused this way. This engine has no such write yet. `status` reports the same
judgement for the newest format this engine writes as `multiDevice`: `devices` (each with its
`engineVersion`, `self` and `ready`), `ready` and `hint`.

## Streams (akasha)

Every device writes only `akasha/<device id>/` (TCRN-CROSS-STORY-468 R2), so no file in a
library has two writers and a sync client can never produce a conflicted copy of one. A
stream directory holds its segments and one stream manifest.

A segment is canonical NDJSON, one event per line, named by an eight-digit lowercase hex
ordinal starting at `00000001.ndjson`; a new one begins when the active one would grow
past `storage.segmentBytes`. A stream imported from an old-layout workspace may also hold
`.json` segments, the JSON arrays its old engine wrote, byte for byte.

The stream manifest (`manifest.json`, `einzbern.stream-manifest.v1`) records the stream id,
the device id and its display name, the identity scheme (`einzbern`, or `legacy` for an
imported stream, which keeps its old stream and event identities), the sequence, the head
event hash, the clock high-water mark, every committed segment with its sequence range,
byte length and SHA-256, and the engine and format versions of its writer.

An append runs under this machine's lock of the library (`locks/<library>.lock` in the
device directory): it cuts off any bytes a crashed writer left past the committed length,
appends the new lines, makes them durable, and then replaces the stream manifest
atomically. The manifest is the commit point. A reader trusts only the manifest: it reads
each named segment up to the recorded length and checks its digest, so bytes appended after
the last manifest are never read, and a segment the manifest does not name is ignored. A
directory without a manifest has no committed events. Each new event takes the next sequence
of its stream and a clock one above the largest clock any stream manifest on the machine
records.

## Merged reading

A read lists every stream directory, validates each stream on its own (manifest, segment
digests, then every event's identity, sequence, rising clock, hashes and priorHash), and
merges all events by clock, then device id, then sequence (TCRN-CROSS-STORY-468 R3). Any
structural failure fails closed and names the device, stream and sequence. Every file read
carries a timeout, so a segment a sync client has evicted to a placeholder yields
`AKASHA_READ_TIMEOUT` naming the device and file instead of a hang (TCRN-CROSS-STORY-470 R4).

The merged events replay from genesis. An event that was valid on the device that wrote it
but does not apply to the merged state (a transition the other device already made, a
revision that no longer follows) is a rejected event: its partial effects are undone, it is
listed with its device, stream, sequence, clock, operation, record and reason, and replay
continues. A create whose key another device took first, earlier in merge order, keeps its
record under the next free key (the numeric suffix counts up; a key without one gains
`-2`, `-3`, ...) and an alias records both keys; that stream's later events that name the
old id (as the record, its parent or its project) follow the rename. The library's version
is a vector of each device's stream sequence, and its head is one digest over every stream's
head. Both the order and the renaming are deterministic, so every device merges the same
streams to the same state.

## The device cache

What a replay derives stays on the device that derived it, in `cache/<library>/` of the
device directory (TCRN-CROSS-STORY-469 R4); a library never holds it.

- `views/` holds the view documents (`STATUS.md`, `index.json`, `readback.json` and, when
  the library holds extension records, `extensions.json`) and a stamp naming the engine
  version, head and version they were projected from. A read whose replay has another stamp
  projects them again.
- `snapshots/` holds one replay snapshot: the reducer's state and the merge's own state
  (rejected events, aliases and renames) after a prefix of the merged events, in a file named
  by its SHA-256, and a header naming it, the engine version that wrote it, the merged
  version, the largest clock among the covered events and, for each stream, the sequence and
  event hash where the prefix ends. A replay writes a new one once it has gone
  `storage.snapshotEveryEvents` merged events past the snapshot it resumed from.
- `crest-views/index.json` is the knowledge store's index view
  (`packages/core/spec/knowledge-core-v1.md`), projected again by any read that finds it
  missing or out of date.

A read resumes from the snapshot only while it describes a prefix of what the streams hold:
the same engine version wrote it, every stream it covers still holds the recorded event at
the recorded sequence, and every event it does not cover carries a clock above its largest
(another device's late event with a lower clock sorts inside the prefix and sends the read
back to genesis). A snapshot or view that is missing, damaged, written by another engine or
no longer a prefix is not used and is written again; a cache fault is never a library fault,
and deleting the cache changes no read. `recover` drops the cache, replays from genesis and
writes the views and a snapshot again; `chain-validate` always replays from genesis.

## Writes that readers never see half-done

Every manifest, and every other small file a reader must see whole, is replaced atomically:
the bytes go to a `.tmp-*` sibling in the same directory, which is flushed and renamed over
the target, and the directory is synced. A rename that Windows refuses for a moment
(`EPERM`, `EACCES`, `EBUSY`) is retried with backoff. A process that dies before the rename
leaves the previous file and a `.tmp-*` sibling, which every reader skips.

## Paths

Paths inside a library are short, relative and lowercase; segment names are lowercase
hexadecimal; text is LF only; nothing depends on permission bits.
