# Backup and Restore Runbook

A backup nobody has restored is a hope, not a capability. This runbook is the
normative procedure for taking a hermetic snapshot of a library and proving its
copy byte-for-byte; the byte-for-byte restore of an old-layout control tree below is
kept as history. It is the buildable half of ADR 0002's
snapshot-not-mirror verdict: the copy is taught (OS tools), only the manifest and
its verification are made. The companion `backup-git-tier.md` covers the optional
git tier-2 integrity witness; both restore stories route through this runbook.

All paths below are placeholders. `<root>` is the library: the `.ether/` directory
in the project, or wherever this device's registry places it
(`library-resolve --cwd "<project>"`, with the project's root as `<project>`, answers
it as `libraryPath`). `<instant>` is the current instant, written
`YYYY-MM-DDTHH:MM:SSZ`. Paths with spaces are first-class here — always double-quote
them.

The old layout kept a workspace in a control directory, written `<control>/` below
(its name is in [the alias table](../wiki/Glossary.md)); from EPIC-141 on the engine
only reads it. Where a passage below describes the old layout, `<root>` is the
directory that contains `<control>/`, and `<destinationParent>` is the directory an
old-layout snapshot copied `<control>/` into.

## Two doctrines the operator must accept before starting

1. **Same-path-only for a RESTORE (old layout, kept as history).** This doctrine
   describes the old-layout control tree `<control>/` only. A library (`.ether/`) is
   restored with `setup --mode restore`
   ([`references/restore.md`](../../skill/mana-orchestrate/references/restore.md)),
   which takes the library from wherever its copy is kept — another device, a backup
   or a cloud drive — and runs eight checks before it writes anything; a library moves
   with `workspace-relocate`, and an old-layout workspace becomes a library by
   migration, not by a restore. The doctrine as it stood for the old layout:

   A restore targets the exact original path on
   the same machine. `resolveWorkspace` fail-closes `WORKSPACE_SCHEMA_INVALID`
   ("stored roots do not match their current filesystem identities") when the
   stored root `canonicalPath`/`portableIdentity` disagree with the live
   filesystem. Restore in place.

   Moving a workspace to a new path or a new machine has no governed route. The
   relocation verb family and `packages/core/src/workspace-relocation.ts` retired
   in TCRN-CROSS-STORY-358, and `docs/adr/0003-workspace-relocation.md` retired
   with them; the 163-line RELOCATE procedure that stood in this runbook described
   verbs that are no longer in the tree. Git tag `attic-2026-09` retains them.
   Do NOT hand-edit `roots` to move a workspace: the bypass the retired verbs
   existed to make non-accidental is now the only thing on offer, and it is
   unsupported.
2. **Lockstep-only.** The knowledge store marker binds its `eventHighWaterDigest`
   to the workspace `headEventHash`. Restoring the workspace event log without the
   knowledge store (or the reverse) bricks the store with
   `KNOWLEDGE_HIGH_WATER_MISMATCH`. Whole-control-tree byte-identical restore keeps
   both stores in lockstep by construction — never restore one store alone.

   That binding is the old layout's. In a library (`.ether/`) the knowledge store,
   `crest/`, is each device's event stream (TCRN-CROSS-SUB-414): its root manifest
   `store.json` binds only the library's id, and each card's event names the chain
   heads, in `akasha/`, it was written against. The rule is the same — restore the
   whole library, never `akasha/` or `crest/` alone — but a partial restore shows
   differently (`packages/core/spec/knowledge-core-v1.md`, "Storage and authority"):
   - `akasha/` put back older than `crest/` leaves records written against chain
     events the chain no longer holds. `knowledge-list` and a read of their id name
     them as `awaitingChain`; their cards leave default selection and `recall`,
     which names them under `projectCrestDegraded`; and `knowledge-validate`,
     `knowledge-checkpoint` and `knowledge-rebase` refuse with
     `KNOWLEDGE_HIGH_WATER_MISMATCH`, details `awaitingChain`, until those chain
     events are back. A chain write made before then puts a different event in
     their place, and the records wait for good; restoring the whole library from
     one snapshot brings them back, and discards that write.
   - `crest/` put back older than `akasha/` is not refused: a read answers at the
     chain head, and the cards written after the crest was copied are simply absent,
     with nothing to name them.

   Records of the metadata/body layout that an engine before event streams wrote
   name no chain position, so they never wait this way.

A library holds its event streams (`akasha/<device>/`), its knowledge store
(`crest/`), its project configuration (`config/`) and its artifacts (`artifacts/`);
this device's views, snapshots, indexes and write lock are in the device directory,
outside the library and outside its snapshot. Old layout, kept as history: the
control tree may contain numbered byte-bounded `events/*.ndjson` segments,
matching point/label/time/manifest sidecars, and `snapshots/manifest.json` for
the engine's read-path checkpoint. The checkpoint is included in that whole-tree
backup but is not a backup receipt or an alternate source of truth. Knowledge
body segments and migrated attestation receipt segments are likewise derived
files; their metadata/receipt values must be verified before legacy files are
removed.

The witness reads complete event segments under their backend's 64 MiB limit and
declared `crest/bodies/<six digits>.ndjson` knowledge segments under the existing
backend limit (the greater of 16 MiB and their manifest's declared byte count,
which must match the actual bytes); unknown paths retain the generic 1 MiB limit.

## SNAPSHOT

The snapshot is taken of the library, `<root>`, and copies it whole. An old-layout
workspace cannot be snapshotted this way: `recover` and `snapshot-manifest` take the
library's write lock, and a workspace the engine only reads refuses them with
`LEGACY_WORKSPACE_READ_ONLY` (`remedy` `library-import-legacy`; once this device has
migrated it, `LEGACY_WORKSPACE_MIGRATED`, naming the library in `movedTo`). It
becomes a library by migration
([`references/migrate.md`](../../skill/mana-orchestrate/references/migrate.md));
snapshot that library.

1. **Quiesce.** End every agent session that writes to `<root>`: on this device and,
   when the library sits in a synced folder, on every other device that writes to
   it; then let the sync client finish. The write lock only orders the writers of
   this device: it is a file in this device's directory, not in the library, and a
   writer on another device appends to its own stream in `akasha/` without it.
2. **Settle and prove green.** Run `recover` then `validate`:

   ```
   pnpm --silent exec einzbern recover --workspace "<root>" --at "<instant>"
   pnpm --silent exec einzbern validate --workspace "<root>"
   ```

   `recover` rebuilds this device's cache of the library (its views, snapshots and
   indexes, in the device directory) from every stream, holding the write lock.
   `validate` must answer `CHAIN_VALIDATED` with `layout` `library` before you copy
   anything.
3. **Write the receipt.** Take the manifest and save stdout verbatim as the
   receipt file, outside `<root>`:

   ```
   pnpm --silent exec einzbern snapshot-manifest --workspace "<root>" --at "<instant>" > "<receipt>"
   ```

   `snapshot-manifest` holds the write lock while it validates the chain and, when
   `crest/store.json` is present, the knowledge store, and while it reads every
   file, so no other writer on this device changes the library meanwhile. A writer
   that keeps the lock longer than the verb waits for it fails the snapshot with
   `WORKSPACE_LOCKED`; a lock whose holder died is broken, not waited for. The
   manifest is a deterministic canonical JSON document: every file of the library
   with its sha256 and size, sorted by path; the library's merged
   `headEventHash`/`version`/`workspaceId`; and the embedded validate result for
   both stores (`knowledge` is `absent` until the library has a knowledge store). It
   leaves out atomic-write temporaries (`.tmp-*`) and an in-flight knowledge
   mutation claim (`crest/mutation.claim`). The write lock is not in the library, so
   neither the manifest nor the copy can carry it, and the verb releases it when it
   exits.
4. **Copy the library.** Copy the whole of `<root>` with OS tools to `<copy>`, a
   directory outside `<root>` that does not exist yet:

   ```
   cp -R "<root>" "<copy>"              # macOS/Linux
   robocopy "<root>" "<copy>" /E        # Windows
   ```

   Copy the library whole, never `akasha/` or `crest/` alone (lockstep doctrine,
   item 2).
5. **Prove the copy.** Verify the copied library against the saved receipt:

   ```
   pnpm --silent exec einzbern snapshot-verify --root "<copy>" --manifest "<receipt>"
   ```

   `--root` is the copied library itself, not the directory that holds it: the verb
   knows a library by its `manifest.json`, and reads any other directory as the
   parent of an old-layout `<control>/`, answering `SNAPSHOT_MISMATCH` naming that
   directory when it is not there. `SNAPSHOT_VERIFIED` means the copy holds the
   files of the receipt, no more and no fewer, each byte-identical (empty
   directories and the entries the manifest leaves out are not compared). Any other
   result: do not keep the copy as a backup.

## RESTORE

This procedure restores the old-layout control tree `<control>/` and is kept as
history. A library (`.ether/`) is restored with `setup --mode restore`
([`references/restore.md`](../../skill/mana-orchestrate/references/restore.md)): it
takes the library from wherever its copy is kept, runs eight checks of it and writes
nothing until they pass.

1. **Quiesce.** End every agent session against `<root>`. Never restore over a
   live workspace.
2. **Copy the tree back to the ORIGINAL path (old layout).** Same-path doctrine
   (item 1, old layout) — the destination is the exact `<root>` the snapshot came
   from:

   ```
   cp -R "<destinationParent>/<control>" "<root>/<control>"      # macOS/Linux
   robocopy "<destinationParent>\<control>" "<root>\<control>" /E   # Windows
   ```

   Restore the WHOLE control tree, both stores together — never a partial restore.
3. **Prove the restored tree.** Verify the original path against the saved
   receipt:

   ```
   pnpm --silent exec einzbern snapshot-verify --root "<root>" --manifest "<receipt>"
   ```

   Expect `SNAPSHOT_VERIFIED`.
4. **Validate both stores.**

   ```
   pnpm --silent exec einzbern validate --workspace "<root>"
   pnpm --silent exec einzbern knowledge-validate --workspace "<root>"
   ```

   Both must pass before agents resume.

## Empty-directory recreation list

A library needs no recreation step. OS copy (`cp -R`, `robocopy /E`) preserves
empty directories, the manifest lists files only, and `recover`, `validate` and
`snapshot-manifest` accept a library without its empty directories (`akasha/`,
`crest/`, `config/` and `artifacts/` in a new library).

Old layout, kept as history: a git-based restore (see `backup-git-tier.md`) needed
one, because git does not track empty directories and these control-tree
directories are required by the engine even when empty. Recreate them before
RESTORE step 4's `validate`:

- `<control>/backups/` — always empty in V1, required as a directory by
  `resolveWorkspace` (`WORKSPACE_PATH_INVALID` when missing). It is
  migration-reserved and is never a user backup destination.
- `<control>/knowledge/bodies/` — empty until the first knowledge unit;
  required by `scanKnowledgeStore` (`KNOWLEDGE_PARTIAL_STATE` when the store root
  entries are not exact).
- `<control>/knowledge/metadata/` — empty until the first knowledge unit;
  required by `scanKnowledgeStore` (same rule).

The `.gitkeep` workaround is inadmissible inside `knowledge/`: the store's exact
root-entry rule rejects any extra entry. Recreate the bare directories instead.

## Expected-failure table (SDC-9)

Each reason code below exists verbatim in the source (`WORKSPACE_REASON_CODES`,
the KNOWLEDGE reason-code list, or `SNAPSHOT_REASON_CODES`). If a step reports one
of these, stop and follow the action — do not force past it.

| Reason code | What it means | Action |
| --- | --- | --- |
| `SNAPSHOT_RESIDUE_PRESENT` | The library (in the old layout, the control tree) carries crashed-session quarantine residue, an entry named `stale-lease-*`, `released-*` or `attempt-owned-*`; a snapshot over it would bake partial state into the receipt | Remove the named quarantine entry by hand, then re-run the SNAPSHOT procedure from step 2 |
| `SNAPSHOT_MISMATCH` | The copy differs from the manifest at the named path — corrupt or truncated copy | Discard the copy and re-copy from a verified source; do not restore from it |
| `WORKSPACE_SCHEMA_INVALID` | Old layout, kept as history: an old-layout control tree restored to the wrong path or a second machine (root-identity mismatch) | For the old layout, restore in place at the exact original `<root>` on the original machine (same-path doctrine, item 1). A library is restored with `setup --mode restore` from wherever its copy is kept; a failed check of its eight names its own reason code ([`references/restore.md`](../../skill/mana-orchestrate/references/restore.md)) |
| `KNOWLEDGE_HIGH_WATER_MISMATCH` | Partial restore — the workspace and knowledge stores are out of lockstep. In a library, the crest holds records written against chain events `akasha/` no longer holds, named in `details.awaitingChain` (TCRN-CROSS-SUB-414) | Restore the WHOLE control tree so both stores return together; partial restore is unrecoverable by design in V1. In a library, restore the whole library; the named records wait until those chain events are back |
| `WORKSPACE_VIEW_STALE` | Old layout, kept as history: derived views in the control tree drifted from the event log. A library holds no views: this device's views are its cache in the device directory, which `recover` (SNAPSHOT step 2) rebuilds from every stream; this engine lists the code but does not raise it | Old layout, kept as history: run `recover --workspace "<root>" --at "<instant>"`, then `validate` |
| `WORKSPACE_LOCKED` | Another writer on this device held the library's write lock longer than the verb waits for it: a session was still writing, so the library was not quiesced. Old layout, kept as history: a live lease holder was present | End every agent session on this device that writes to the library, and retry |
| `WORKSPACE_PATH_INVALID` | `--workspace` names no real directory (nothing is there, for one); a library does not need its empty directories (see the recreation list). Old layout, kept as history: a required control-tree directory is missing (e.g. an empty directory a git restore dropped) | Give the library directory itself, the one that holds `manifest.json`. Old layout, kept as history: recreate the missing directory (see the recreation list), then re-run `validate` |

## Anti-promises

- **Archives are not restorable.** `tcrn.workspace-archive.v1` checkpoint anchors
  are integrity anchors, not backups: V1 has no import path for them. Do not treat
  an archive as a restore source.
- **The copy goes outside the library.** Copy snapshots to a destination outside
  `<root>`, never into it: a copy inside the library would be read as part of it by
  the next snapshot. Old layout, kept as history: `<control>/backups/` is created
  empty at init, is migration-reserved and is never a user backup destination.
- **A sync folder is not a backup.** A snapshot is taken from a quiesced library
  (SNAPSHOT step 1). Keeping the library in a synced folder is how devices share it
  now ([`Multi-Device-and-Cloud.md`](../wiki/Multi-Device-and-Cloud.md)), not a
  backup of it; take snapshots as above. Old layout, kept as history: never place a
  live workspace under a cloud/network sync client or a symlink/junction; snapshot a
  quiesced tree; restore in place.

## Cross-references

- ADR 0002 — snapshot-not-mirror doctrine (`docs/adr/0002-snapshot-not-mirror-backup.md`).
- Git tier-2 integrity witness (`docs/architecture/backup-git-tier.md`).
