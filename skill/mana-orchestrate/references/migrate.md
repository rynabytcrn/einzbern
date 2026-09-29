# Migrate an installation from before the rename

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

Use it when a plan or `doctor` reports an installation from before the engine was named Einzbern:
an older engine copy, its helper skill copies or hooks, or an old-layout workspace. It is the
wizard for `setup --mode migrate`. Run the engine verbs below the way SKILL.md says to invoke the
engine. Supply two flags yourself: `--project <dir>`, the project the migration wires (for a
container of several projects, the container root), and `--at <UTC>`, the current instant written
`YYYY-MM-DDTHH:MM:SSZ`. An engine must be current on this device first; if the plan reports
`SETUP_ENGINE_NOT_INSTALLED`, place one as `install.md` says and plan again.

## What the migration does

With `--yes true`, in this order:

1. Each old workspace the mapping names becomes the first stream of its project's library, `.ether`
   in the project root. The import validates the whole old chain and compares its events and head
   with the plan's; each library is registered on this device with the old workspace as
   `migratedFrom`, and the portal settings of the old device directory are carried over.
2. The project's own library records the language answer.
3. The cleanup takes the old installation off this device (`migration.hostCleanup`): the old hooks,
   the old deny rules and the old inert key come out of the user's host files and of each mapped
   project's (the container's among them); the old templates, the old helper's skill copies and
   install markers, the old injection state and the old portal launchers are moved into the
   backups. Other tools' hooks and settings stay.
4. The project is wired as a first installation wires it: the two skill copies, the launchers, one
   Einzbern hook per host in the user's settings, CLAUDE.md's import section and, when the answer is
   yes, AGENTS.md's navigation section.
5. `doctor`'s eight checks run as the self-check.

With no installation from before the rename the plan answers `SETUP_MIGRATE_NOTHING`: install with
`install.md` instead.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Ask
only the questions the plan reports as open, never ask again for an answer the user already gave,
and never guess an answer.

1. Mapping. Which project each old workspace belongs to. When the project itself holds an old
   workspace, the plan proposes a mapping in `migration.mapping`; show it as a table (partition,
   old workspace, project, library) and ask whether it is right. Otherwise ask, for each old
   workspace the user wants migrated, which project it belongs to. Write the mapping as a JSON file
   in a temporary directory outside every project (it names this device's paths and is never
   committed): `{"schemaVersion": "einzbern.migration-mapping.v1", "partitions": [...]}`, each
   partition `{"partition", "legacyWorkspace", "projectRoot"}` with absolute paths, and optionally
   `"projectName"` and `"gitRemote"`. Pass it with `--mapping <file>`.
2. Cloud drive. Is a library location synced by a cloud drive? The plan suggests an answer from
   the location; the answer holds for every library. Flag: `--cloud true` or `--cloud false`.
3. Language. The language of the text Einzbern writes into the project's instruction files, as a
   language tag such as `en` or `zh-CN`; the plan proposes the one the old chain records. Flag:
   `--language <tag>`.
4. Navigation section. Add a short section that points agents to Einzbern in the project's
   instruction files? Flag: `--navigation true` or `--navigation false`.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode migrate --project <dir> --mapping <file> --at <UTC>`, with a flag for
   each answer already known and without `--yes`. It writes nothing and returns
   `SETUP_PLAN_READY`. Beside the questions, the answers and the files it would write or back up
   (`writes`, `backups`), it holds `migration`:
   - `partitions`: for each partition its `target` library, `targetState` (`absent`, `empty`,
     `migrated` when an earlier run imported it, `not-empty` or `not-a-directory`), `action`
     (`import`, `skip` or `blocked`), the old chain's `events` and `headEventHash`,
     `unsatisfiedGates` (every gate that is not satisfied, with its id, work item, status, title and
     outcome class) and `openItems` (the work still open, by status);
   - `registry`, the entry each library gets, and `deviceSettings`, the portal keys that move;
   - `hostCleanup`, each item `{kind, path, action, into}`: `kind` is `host-file` (updated, its
     original copied first), `template`, `injection-state`, `launcher`, `skill-copy` or `marker`
     (moved), and `into` is where it goes in the backups.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. If the plan has `blockers`, show each and stop; nothing is applied while one is there:
   - `LIBRARY_TARGET_NOT_EMPTY` or `LIBRARY_TARGET_INVALID`: the project's `.ether` holds something
     else. The user clears it or chooses another project.
   - `LEGACY_IMPORT_MISMATCH`: the old workspace changed while it was planned, or the library at
     the target holds that workspace's id but not its chain. Plan again once nothing writes to the
     old workspace; for the second case, ask the user.
   - `KNOWLEDGE_RECORD_INVALID`, `KNOWLEDGE_PATH_INVALID` or `KNOWLEDGE_PARTIAL_STATE`: the
     partition's old knowledge store does not read, and the blocker's `path` is the file of the
     store it is about. Handle it as "Knowledge carried" below says.
   - `SETUP_LIBRARY_CONFLICT`: this device registered the project to another library.
   - `MIGRATE_CLEANUP_BACKUP_EXISTS` or `LEGACY_SKILL_CLEANUP_BACKUP_EXISTS`: a backup of the same
     second is already there. Plan again with a later `--at`.
   - `MIGRATE_CLEANUP_CROSS_VOLUME`: an entry to move is on another volume than the device
     directory; a move is a rename and cannot cross volumes. Tell the user which one.
   - `HOST_HOOKS_FILE_UNSUPPORTED`: a host file is a link or does not parse; the user fixes it.
4. Final confirmation. Show the mapping, a table of the partitions (partition, library, action,
   events, head), the gates that stay pending, the `hostCleanup` list and every file the plan
   would write, and ask once whether to apply. Continue only on a clear yes.
5. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: `migration` with
   each partition `imported` or `skipped`, the registry entries and `hostCleanup` as it was done,
   the files `written`, the backup directory (`backupDir`) and `selfCheck`. If it stops with
   `LEGACY_IMPORT_MISMATCH`, its `partition` names where; the partitions before it are in their
   libraries and are skipped when you plan and apply again.
6. Report the backup directory, what the cleanup took off, each library, the gates still pending,
   and the eight checks in `selfCheck`. Handle any check that is not ok with `doctor.md`.

Running the same command again changes nothing: migrated partitions are skipped, and the
cleanup and the wiring find nothing left to do.

## Knowledge carried

- The import carries each old workspace's knowledge store (`knowledge/` in its old control
  directory) into the library's `crest/` as its engine left it: the marker `store.json`,
  `metadata/` and `bodies/` (segments included), byte for byte. The old `views/` stays behind,
  since the library's index view is this device's cache. The library reads that layout and writes
  new cards beside it; the carried files are never rewritten.
- A card the old engine marked as replaced (`extensions.supersededBy` in its metadata) reads as
  removed: `knowledge-list` lists it only with `--status removed` or `--status all`. It is carried
  with the rest.
- The receipt of `library-import-legacy` (a dry run's and an import's alike) holds `knowledge`,
  `null` when the old workspace has no store:
  - `cards`: every card of the store, whatever its status
    (`knowledge-list --selection all --status all`);
  - `removedCards`: those of them that read as removed (`--status removed`);
  - `defaultCards`: those `knowledge-list` answers by default (valid cards only);
  - `files` and `bytes`: the files carried into `crest/` and their size.

  After the copy the library must answer the same three counts, or the import stops with
  `LEGACY_IMPORT_MISMATCH`. To see a partition's counts before the apply, run
  `library-import-legacy --legacy <old workspace> --dry-run true --at <UTC>`; it writes nothing.
- A store the engine cannot read blocks its partition. The plan lists the refusal as a blocker of
  its own, whose `path` is the file of the store it is about (the store itself when it is about the
  store as a whole), and still lists the partition's `events`, `headEventHash`,
  `unsatisfiedGates` and `openItems`. `library-import-legacy` names the same file in `file`,
  relative to the store (`.` for the store as a whole).
  - `KNOWLEDGE_RECORD_INVALID`: the named file (the marker or a card's metadata) no longer holds
    the bytes its engine wrote, typically because another tool saved it again, indented or
    without its final newline.
  - `KNOWLEDGE_PATH_INVALID`: the store is bound to another place than the one the old workspace
    sits in now (it was copied or moved after its engine wrote it), or a path in it does not read.
  - `KNOWLEDGE_PARTIAL_STATE`: the store is not whole: an entry its engine never leaves there (a
    `mutation.claim` of a write that never finished, a stray file), cards and bodies that do not
    match, or a stale index view.
- Show each such blocker with its file and stop; nothing is migrated while one is there. Never
  edit, reformat, move or delete a file of the old store yourself. The user restores the store as
  its engine left it, from a backup or an earlier copy, or puts the old workspace back where its
  store is bound; then plan again.

## After the migration

- Clear the bodies of removed cards from the knowledge each library carried over: the import brings
  the old store's cards as its engine left them, the bodies of superseded cards included. Run
  `knowledge-bodies-migrate --workspace <library> --clear-removed true --at <UTC>` once after the
  import, and once more after the D7 cleanup, since a card removed after the import leaves its body
  there too. It runs only while this device is the library's sole writer, so run both before another
  device writes to the library: `KNOWLEDGE_SOLE_WRITER_REQUIRED` says one has, and those bodies then
  stay where no read answers them. The answer gives `clearedBodies` and the backup of the bodies it
  rewrote, `backupDir`, under `backups/<UTC>/crest-bodies/`; a run with nothing left to clear writes
  nothing. `KNOWLEDGE_ALREADY_EXISTS` means a backup of the same second is already there: run again
  with a later `--at`.
- The old workspace stays where it is and still reads. A write to it answers
  `LEGACY_WORKSPACE_MIGRATED`, whose `movedTo` is the library it became; write there instead
  (`--workspace <library>`, the refusal's remedy).
- A gate that was pending or blocked in the old chain stays so in the library and keeps holding
  its work item back from done; the refusal, `WORKSPACE_GATE_PENDING`, names the gate. It is
  released only in Atelier: `work-gate-release --id <gate> --reason <why> --actor <actor> --at <UTC>`
  run with `EINZBERN_SURFACE=atelier`, which records who released it, when and why. Run from a
  model, it is refused with `MODEL_WRITE_REFUSED`: do not set that surface yourself; tell the user
  which gates are theirs to release. `work-gate-list --status all` lists them.

## Backup, and move but never delete

- Everything the migration changes or takes off goes into the device directory's backups,
  `backups/<UTC>/` under the device directory: each host file's original and the moved templates
  and injection state under `host-hooks/`, the old launchers under `launchers/`, the old helper's
  copies and markers under `skill-copies/`, and the registry as it was under `registry/`. The
  result names the backup directory, and each `hostCleanup` item says where its entry went.
- Nothing is deleted. The old workspaces' container and the platform archive are never in the
  list, and the old device directory keeps its old engine copy and everything but the markers.
- Never edit, move, or copy files inside the old workspace yourself; only the engine reads it.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Mapping | `--mapping <file>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Language | `--language <tag>` |
| Navigation section | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
