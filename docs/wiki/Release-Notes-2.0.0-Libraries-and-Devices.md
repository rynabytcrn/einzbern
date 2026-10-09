# Einzbern 2.0.0 发行说明：库与设备

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 2/13：库与设备

上一模块：[改名与精简](Release-Notes-2.0.0-Renaming-and-Retirements.md) · 下一模块：[工作记录、纪要与决策](Release-Notes-2.0.0-Work-Records-and-Minutes.md)

## The device directory

The device directory is `EINZBERN_HOME` when that variable is set, otherwise `~/.einzbern`
(TCRN-CROSS-STORY-469 R3): machine settings live there, and the device file, the library
registry, each library's cache and write lock, backups and engine versions will. Manifest and
settings files are replaced atomically (temporary file, flush, rename); a rename refused with
`EPERM`, `EACCES` or `EBUSY` is retried with backoff before `ATOMIC_WRITE_RENAME_FAILED`.

## `einzbern.event.v1` is final

`einzbern.event.v1` is final (TCRN-CROSS-STORY-468 R3): beside the legacy fields every new
event carries `clock`, one more than the largest clock its device had seen, and `deviceId`,
the 32-hex-digit id of the device that wrote it, both in the hash basis; `tcrn.event.v1`
events are unchanged and read with their sequence as their clock. The device id and its
display name live in `device.json` in the device directory, created on first use; a
reinstall that loses the directory gets a new id. Library streams and their events take
identities derived from the library and device (`einzbern.stream-identity.v1`,
`einzbern.event-identity.v1`), and `validateStreamChain` checks one stream link by link.

## A library (`.ether`) has exactly seven root entries

A library (`.ether`) has exactly seven root entries: `manifest.json` (library id, format
version, minimum engine version, project hint), `akasha/`, `crest/`, `config/`,
`artifacts/`, a `README.md` that explains every name and carries the alias table, and a
`.gitignore` of `*`, so a library inside a Git working tree never shows in `git status`
(TCRN-CROSS-STORY-469 R1, R6; `packages/core/spec/ether-library-v1.md`).

## Each device writes only its own stream

Each device writes only its own stream, `akasha/<device id>/` (TCRN-CROSS-STORY-468 R2, R3):
NDJSON segments named by eight-digit lowercase hex ordinals and a stream manifest that
records the sequence, head, clock high-water mark and every committed segment with its
length and SHA-256. An append takes this machine's lock of the library, cuts off any tail a
crashed writer left, appends, and commits by replacing the stream manifest atomically;
readers trust only the manifest. A new event's clock is one above the largest clock any
stream manifest on the machine records.

## A library is read by merging every device's stream

A library is read by merging every device's stream by clock, device id and sequence
(TCRN-CROSS-STORY-468 R3-R5): its version is a vector of stream sequences and its head one
digest over the stream heads. An event that does not apply to the merged state is a rejected
event, listed and skipped; a create whose key another device took first is renamed to the
next free key with an alias, and its stream's later events follow. Each file read times out
with `AKASHA_READ_TIMEOUT` instead of hanging on a sync placeholder (TCRN-CROSS-STORY-470 R4).

## The engine writes libraries only

The engine writes libraries only (TCRN-CROSS-STORY-469). `init --workspace <library> --at
[--project-name] [--git-remote]` creates one (the five explicit roots, the workspace external
key and `--segment-events` are gone); every write takes this machine's lock of the library,
reads the merged state and appends to this device's stream; every read replays the merged
streams. `status` reports the version vector, the streams and the rejected-event count;
`work-show` also takes `--external-key` and shows a record's aliases, the records renamed
away from its key and the events rejected against it; `validate` is `chain-validate`, which
checks a library stream by stream and names the device, stream and sequence of any break.
An old-layout workspace opens read-only: reads replay it from genesis without writing, and
every write refuses with `LEGACY_WORKSPACE_READ_ONLY`. The old layout's writer is gone with
`migration-plan`, `migration-execute`, `storage-home-status` and `snapshot-replay-rebuild`:
its storage backends, segment indexes, views, replay snapshots, storage-home sentinel,
storage migration, relocation admission and filesystem-type pin.

## The test suite runs on libraries

The test suite runs on libraries (TCRN-CROSS-STORY-469): fixtures create a library in a
temporary directory and every test process gets its own device directory through
`EINZBERN_HOME`, so no test reaches the real `~/.einzbern`; the old layout is read only from
the frozen fixture in `tests/fixtures/legacy-workspace`. A library's knowledge store is its
`crest/` directory (`knowledgeStorePath`), its artifact manifest and default blob root are its
`artifacts/` directory, and `storage.segmentBytes` sizes its stream segments with a default of
1 MiB. Initializing a knowledge store always takes the disposable acknowledgment: a library has
no workspace key to carry the implicit `FIXTURE-` admission. A sprint reference names the
library a member lives in (`library:<id>#work:<id>`; an old-layout `workspace:<id>` still
reads). The backup witness (`snapshot-manifest`, `snapshot-verify`) covers the whole library
tree, and a library restored to another path verifies and reads the same head. A stream
segment whose recorded path is a directory fails with `AKASHA_SEGMENT_CORRUPT`.

## A library's derived state is this device's cache

A library's derived state is this device's cache, `cache/<library>/` in the device directory
(TCRN-CROSS-STORY-469 R4, STORY-468 R4; `packages/core/spec/ether-library-v1.md`): the view
documents, stamped with the engine and head they were projected from, and one replay snapshot
of the reducer and merge state after a prefix of the merged events. Every read and write
resumes the merged replay from the snapshot while it is a prefix of what the streams hold (same
engine, the recorded event still at each covered stream's recorded sequence, every uncovered
event's clock above the snapshot's largest) and replays from genesis otherwise, then refreshes
the cache; a new snapshot is written every `storage.snapshotEveryEvents` merged events. A
missing, damaged or foreign cache is rebuilt and never a library error, and deleting it changes
no read. `recover` rebuilds the cache from genesis; `chain-validate` and
`materializeWorkspaceFromGenesis` never use it. The recall index is keyed by the library id.

## This device keeps a registry of libraries

This device keeps a registry of libraries, `registry.json` in the device directory
(`einzbern.registry.v1`; TCRN-CROSS-STORY-470 R1, AC1; MIN-227 D19): each entry maps a project
directory, and the project's Git remote in one normalised spelling, to a library path and id,
with a cloud-hosted flag. Nothing is written into the project. `library-register --project
--library --at [--cloud-hosted true] [--git-remote]` records one, `init --project` registers
the library it creates, `library-list` lists them and `library-resolve [--cwd]` shows which
library a directory resolves to: the directory or its nearest registered ancestor, else the Git
working tree's top level, else its remote (origin first, so another clone of the project finds
the same library), else `LIBRARY_NOT_REGISTERED`; a library that no longer carries the
registered id is `LIBRARY_REGISTRY_MISMATCH`. `--workspace` is now optional on every verb but
`init`: left out, the library is the one the current directory resolves to.

## A library's cloud-hosted flag is the user's

A library's cloud-hosted flag is the user's (TCRN-CROSS-STORY-470 R2, AC5; MIN-227 D19, D21):
`library-register` and `init --project` store `--cloud-hosted` when it is given and otherwise
what the cloud folder table suggests for the library's real path, and both report `realPath`
and `suggestedCloudHosted`. The table (`packages/core/src/cloud-roots.ts`) knows macOS
(`~/Library/CloudStorage/*`, iCloud Drive, `~/OneDrive*`, `~/Dropbox`) and Windows (the
`OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` variables, iCloud Drive and Dropbox under
the profile) and suggests nothing on Linux; a project's default cloud library is
`<cloud root>/Ether/<project name>`. A library given through a symbolic link is created,
registered and opened at its real path instead of being refused.

## `workspace-relocate` moves a library

`workspace-relocate --workspace <library> --to <place> --at <instant> [--cloud-hosted]` moves a
library (TCRN-CROSS-STORY-470 R3, AC2, AC3; `packages/core/src/relocate.ts`). The target must
not exist or be an empty directory (`RELOCATE_TARGET_NOT_EMPTY`), must not sit inside the
library or contain it (`RELOCATE_TARGET_INSIDE_SOURCE`) and must take a write
(`RELOCATE_TARGET_NOT_WRITABLE`). Under this machine's lock of the library every directory and
file is copied, each file checked by SHA-256 as it lands, the copy compared with the source by
the backup witness's digests (`RELOCATE_COPY_MISMATCH`) and replayed from genesis to the same
stream heads and version vector (`RELOCATE_REPLAY_MISMATCH`); a failure removes only what the
relocation created. Then this device's registry points at the new place and the old place gets
`TOMBSTONE.json` (`einzbern.tombstone.v1`: library id, where it went and when): it keeps its
files and still reads, `status` reports `relocatedTo`, and every write there refuses with
`LIBRARY_TOMBSTONED` naming the new place. Nothing is deleted.

## A library outside its project is one both hosts may write

A library outside its project is one both hosts may write (TCRN-CROSS-STORY-470 R5, AC4;
`packages/core/src/host-writable-roots.ts`): the project's own host settings name its real path,
Claude Code's `permissions.additionalDirectories` in `.claude/settings.local.json` and Codex's
`[sandbox_workspace_write] writable_roots` in `.codex/config.toml`, and everything else in both
files is kept (the TOML is edited in place, comments and layout included). `scripts/host-render.mjs
--host <host> --root <project> --library <library> [--at] [--plan-only]` renders this
writable-roots scope, and `workspace-relocate` does it for every project this device has
registered for the library, reporting each as `hostWiring`; a project whose wiring fails keeps the
move. A library inside its project needs nothing, wiring the same library twice changes nothing,
and each file is copied to `backups/<UTC instant>/writable-roots/<project digest>/` in the device
directory before it is replaced. A host file Git tracks is still wired and reported
`trackedByGit`, because committing it would publish the path. A host file that is not a regular
file, or not JSON or TOML the wiring can edit without risking the rest, is refused with
`HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED`, and one that changed after it was planned with
`HOST_WRITABLE_ROOTS_CONCURRENT_MODIFICATION`.

## A device file that another process is still publishing is read, not refused as damaged

A device file that another process is still publishing is read, not refused as damaged
(TCRN-CROSS-STORY-511 R1, R2, TCRN-CROSS-SUB-419, TCRN-CROSS-INC-395; fixes TCRN-CROSS-STORY-468 R1;
`packages/core/src/device-identity.ts`). The first use of a device links a complete staging file
into place as `device.json` and then removes the staging name; `readDevice` waits while the file's
second link is that staging link. A removal that landed between the reader's lstat and its scan of
the device directory used to leave a second link with no staging name beside it, so the first
concurrent use of a new device directory could fail with `DEVICE_FILE_INVALID` on any write path.
A scan that finds no staging link is now followed by one more lstat, and the same file with one link
is a finished publication; the lstat branch and the opened-handle branch share the wait. A second
link that is still there under another name, a staging link that outlasts the unchanged one-second
wait, a symbolic link, a file that is not regular and damaged content still fail closed with
`DEVICE_FILE_INVALID`. The `device.json` format, the device id and the reason codes are unchanged.

## A read of a library that meets another writer's replacement of a stream manifest reads one whole version

A read of a library that meets another writer's replacement of a stream manifest reads one whole
version instead of refusing the manifest as damaged (TCRN-CROSS-STORY-512 R1, R2,
TCRN-CROSS-SUB-420, TCRN-CROSS-INC-396; fixes TCRN-CROSS-STORY-503; `packages/core/src/akasha.ts`).
A device commits an append by renaming a finished temporary file over its stream manifest. When that
rename landed between a reader's open of the manifest and its stat of the open file, or inside the
reader's lstat, the file the reader held had no link left, and the read failed with
`AKASHA_STREAM_MANIFEST_INVALID` ("must be a single-link regular file") although nothing was
damaged: about once in 1,280 writes when two devices' processes wrote one library at once, and the
same could happen on one device when a hook, Atelier or another CLI read while a write committed. A
file with no link left is not a second name, so it is now read: through the handle already open, as
the manifest from before the replacement; after an lstat that saw it, through the name, as the
manifest after it. Either way the segments that manifest names read back to its head, because a
replaced file is never written in place and no write changes a segment within a length some
manifest records. A second hard link, a symbolic link and a file that is not regular still fail
closed, at the lstat and at the opened handle alike, with `AKASHA_STREAM_MANIFEST_INVALID` for a
manifest and `AKASHA_SEGMENT_CORRUPT` for a segment. The manifest and segment formats, the stream
identity, the atomic write, the read timeout and the reason codes are unchanged.

## The refusal for a directory this device has not registered names only the ways the refused verb has

The refusal for a directory this device has not registered names only the ways the refused verb
has (TCRN-CROSS-SUB-427; fixes TCRN-CROSS-STORY-470; `packages/core/src/registry.ts`,
`packages/cli/src/index.ts`). `LIBRARY_NOT_REGISTERED` told every caller to register a library
with `library-register` or to pass `--workspace`, but `agents-render`, `rule-enable`,
`rule-disable`, `rule-list`, `rule-resolve` and `library-resolve` take no `--workspace`, and
passing it to them is refused with `CLI_ARGUMENT_UNKNOWN`. Their refusal now names
`library-register` alone; a verb that takes `--workspace` and leaves it to the registry is still
offered it. The reason code, its `cwd` and `remedy` details and the command catalog are unchanged;
`resolveLibrary` takes the choice as an optional third argument, `{ workspaceFlag }`.

## The work index is now a bounded `tcrn.workspace-index.v3` summary

The work index is now a bounded `tcrn.workspace-index.v3` summary of the complete
project and work collections, with counts and deterministic full-record digests
(TCRN-CROSS-STORY-515 / SUB-429). Its 1 MiB view budget and the real-library
10,000-work-record limit are unchanged. Current stamps cannot hide damaged or
missing cached view files; replay rebuilds them. Snapshot manifests and verification
read declared knowledge body segments at their backend's existing limit, including
segments past 1 MiB, and continue to reject overflow, undeclared large paths and
covered-byte changes. Old-layout compatibility remains read-only.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[改名与精简](Release-Notes-2.0.0-Renaming-and-Retirements.md) · 下一模块：[工作记录、纪要与决策](Release-Notes-2.0.0-Work-Records-and-Minutes.md)
