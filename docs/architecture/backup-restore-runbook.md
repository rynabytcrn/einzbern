# Backup and Restore Runbook

A backup nobody has restored is a hope, not a capability. This runbook is the
normative procedure for taking a hermetic snapshot of a workspace control tree
and restoring it byte-for-byte. It is the buildable half of ADR 0002's
snapshot-not-mirror verdict: the copy is taught (OS tools), only the manifest and
its verification are made. The companion `backup-git-tier.md` covers the optional
git tier-2 integrity witness; both restore stories route through this runbook.

All paths below are workspace-relative placeholders. `<root>` is the Workspace
authority root (the directory that contains the old-layout control directory, written `<control>/` below (its name is in [the alias table](../wiki/Glossary.md); from EPIC-141 on the engine only reads it)). Paths with spaces
are first-class here — always double-quote them.

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

The control tree may contain numbered byte-bounded `events/*.ndjson` segments,
matching point/label/time/manifest sidecars, and `snapshots/manifest.json` for
the engine's read-path checkpoint. The checkpoint is included in this whole-tree
backup but is not a backup receipt or an alternate source of truth. Knowledge
body segments and migrated attestation receipt segments are likewise derived
files; their metadata/receipt values must be verified before legacy files are
removed.

## SNAPSHOT

1. **Quiesce.** End every agent session against `<root>`. A snapshot proves a
   quiesced tree; the lease is the quiesce proof and a second holder fails
   `WORKSPACE_LOCKED`.
2. **Settle and prove green.** Run `recover` then `validate`:

   ```
   pnpm --silent exec einzbern recover --workspace "<root>" --at "<instant>"
   pnpm --silent exec einzbern validate --workspace "<root>"
   ```

   `recover` clears `.tmp-` residue under `events/` and `views/`. `validate` must
   report a valid workspace before you copy anything.
3. **Write the receipt.** Take the manifest and save stdout verbatim as the
   receipt file:

   ```
   pnpm --silent exec einzbern snapshot-manifest --workspace "<root>" --at "<instant>" > "<receipt>"
   ```

   The manifest is a deterministic canonical JSON document: sorted per-file
   sha256, the workspace `headEventHash`/`version`/`workspaceId`, and the embedded
   validate result for both stores. It excludes the held `lease/` subtree and the
   in-flight claim residue classes (SDC-9), so it matches the copy byte-for-byte
   only after the lease is released.
4. **Copy the tree (old layout, kept as history).** This step copies the old-layout
   control tree `<control>/`. For a library (`.ether/`) the current restore is
   `setup --mode restore`
   ([`references/restore.md`](../../skill/mana-orchestrate/references/restore.md)),
   which takes the library from wherever its copy is kept. For the old layout, copy
   `<control>` with OS tools to a destination **outside** `<root>`:

   ```
   cp -R "<root>/<control>" "<destinationParent>/<control>"      # macOS/Linux
   robocopy "<root>\<control>" "<destinationParent>\<control>" /E   # Windows
   ```

   The manifest was taken under a held lease and the lease is released before this
   step, so `lease/` is absent from both the manifest and the copy.
5. **Prove the copy.** Verify the copy against the saved receipt:

   ```
   pnpm --silent exec einzbern snapshot-verify --root "<destinationParent>" --manifest "<receipt>"
   ```

   `SNAPSHOT_VERIFIED` means the copy is byte-identical to the snapshotted tree.
   Any other result: do not keep the copy as a backup.

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

OS copy (`cp -R`, `robocopy /E`) preserves empty directories, so the copy runbook
above needs no recreation step. A git-based restore (see `backup-git-tier.md`)
does: git does not track empty directories, and these control-tree directories are
required by the engine even when empty. Recreate them before step 4's `validate`:

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
| `SNAPSHOT_RESIDUE_PRESENT` | The tree carries crashed-session quarantine residue (`stale-lease-*`, `released-*`, `attempt-owned-*`); a snapshot over it would bake partial state into the receipt | Remove the named quarantine directory by hand, then re-run the SNAPSHOT procedure from step 2 |
| `SNAPSHOT_MISMATCH` | The copy differs from the manifest at the named path — corrupt or truncated copy | Discard the copy and re-copy from a verified source; do not restore from it |
| `WORKSPACE_SCHEMA_INVALID` | Old layout, kept as history: an old-layout control tree restored to the wrong path or a second machine (root-identity mismatch) | For the old layout, restore in place at the exact original `<root>` on the original machine (same-path doctrine, item 1). A library is restored with `setup --mode restore` from wherever its copy is kept; a failed check of its eight names its own reason code ([`references/restore.md`](../../skill/mana-orchestrate/references/restore.md)) |
| `KNOWLEDGE_HIGH_WATER_MISMATCH` | Partial restore — the workspace and knowledge stores are out of lockstep. In a library, the crest holds records written against chain events `akasha/` no longer holds, named in `details.awaitingChain` (TCRN-CROSS-SUB-414) | Restore the WHOLE control tree so both stores return together; partial restore is unrecoverable by design in V1. In a library, restore the whole library; the named records wait until those chain events are back |
| `WORKSPACE_VIEW_STALE` | Derived views drifted from the event log | Run `recover --workspace "<root>" --at "<instant>"`, then `validate` |
| `WORKSPACE_LOCKED` | A live lease holder is present — the workspace was not quiesced | End all agent sessions and retry |
| `WORKSPACE_PATH_INVALID` | A required control-tree directory is missing (e.g. an empty directory a git restore dropped) | Recreate the missing directory (see the recreation list), then re-run `validate` |

## Anti-promises

- **Archives are not restorable.** `tcrn.workspace-archive.v1` checkpoint anchors
  are integrity anchors, not backups: V1 has no import path for them. Do not treat
  an archive as a restore source.
- **`<control>/backups/` is migration-reserved.** It is created empty at init
  and is never a user backup destination. Copy snapshots to a destination outside
  `<root>`, never into `backups/`.
- **No live-sync.** Never place a live workspace under a cloud/network sync client
  or a symlink/junction. Snapshot a quiesced tree; restore in place.

## Cross-references

- ADR 0002 — snapshot-not-mirror doctrine (`docs/adr/0002-snapshot-not-mirror-backup.md`).
- Git tier-2 integrity witness (`docs/architecture/backup-git-tier.md`).
