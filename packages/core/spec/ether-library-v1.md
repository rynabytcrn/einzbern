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
| `config/` | a readable projection of the project-level settings | the engine, when a project-level setting is written |
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

## Writes that readers never see half-done

Every manifest, and every other small file a reader must see whole, is replaced atomically:
the bytes go to a `.tmp-*` sibling in the same directory, which is flushed and renamed over
the target, and the directory is synced. A rename that Windows refuses for a moment
(`EPERM`, `EACCES`, `EBUSY`) is retried with backoff. A process that dies before the rename
leaves the previous file and a `.tmp-*` sibling, which every reader skips.

## Paths

Paths inside a library are short, relative and lowercase; segment names are lowercase
hexadecimal; text is LF only; nothing depends on permission bits.
