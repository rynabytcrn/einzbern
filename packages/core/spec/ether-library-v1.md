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

## Writes that readers never see half-done

Every manifest, and every other small file a reader must see whole, is replaced atomically:
the bytes go to a `.tmp-*` sibling in the same directory, which is flushed and renamed over
the target, and the directory is synced. A rename that Windows refuses for a moment
(`EPERM`, `EACCES`, `EBUSY`) is retried with backoff. A process that dies before the rename
leaves the previous file and a `.tmp-*` sibling, which every reader skips.

## Paths

Paths inside a library are short, relative and lowercase; segment names are lowercase
hexadecimal; text is LF only; nothing depends on permission bits.
