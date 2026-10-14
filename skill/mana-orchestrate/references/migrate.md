# Migrate an installation from before the rename

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

Use it when a plan or `doctor` reports an installation from before the engine was named Einzbern:
an older engine copy, its helper skill copies or hooks, or an old-layout workspace. It is the
wizard for `setup --mode migrate`. Run the engine verbs below the way SKILL.md says to invoke the
engine. Supply two flags yourself: `--project <dir>`, the project the migration wires (for a
container of several projects, the container root when the mapping gives no `chainRole`; when it
does, the root of a partition whose `chainRole` is `project`, since a coordination chain takes no
project language or wiring and the plan refuses its root), and `--at <UTC>`, the current instant
written `YYYY-MM-DDTHH:MM:SSZ`. An engine must be current on this device first; if the plan reports
`SETUP_ENGINE_NOT_INSTALLED`, place one as `install.md` says and plan again.

## What the migration does

With `--yes true`, in this order:

1. Each old workspace the mapping names becomes the first stream of its project's library, `.ether`
   in the project root. The import validates the whole old chain and compares its events and head
   with the plan's; each library is registered on this device with the old workspace as
   `migratedFrom`, and the portal settings of the old device directory are carried over. The
   coordination partition's own settings the plan marks `write` (`coordinationSettings`, below) go
   into the coordination library, never into a project's.
2. The project's own library records the language answer.
3. Recall smoke: the newest valid card of the project's own library is asked for by its subject the
   way the prompt hook asks. `recallSmoke` is `hit` (with `cardId` and `query`) or `no-card`; a
   miss stops the apply with `SETUP_RECALL_SMOKE_MISSED` before the cleanup and the wiring.
4. The cleanup takes the old installation off this device (`migration.hostCleanup`): the old hooks,
   the old deny rules and the old inert key come out of the user's host files and of each mapped
   project's (the container's among them); the old templates, the old helper's skill copies and
   install markers, the old injection state and the old portal launchers are moved into the
   backups. Other tools' hooks and settings stay.
5. The project is wired as a first installation wires it: the two skill copies, the launchers, one
   Einzbern hook per host in the user's settings, CLAUDE.md's import section and, when the answer is
   yes, AGENTS.md's navigation section.
6. `doctor`'s eight checks run as the self-check.

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
   `"projectName"` and `"gitRemote"`. Only when the user explicitly chooses to leave that partition's
   old knowledge behind, add `"omitLegacyKnowledge": {"reason": "<why>"}` to that entry (see below).
   `"projectId"` names the old chain's project that the project's configuration (language, managed
   sections, registry entry) belongs to: `project:` and 24 hexadecimal digits. The plan lists each
   partition's live projects in `projectCandidates` (`id`, `name`, `externalKey`, and `work`, the
   count of its live work items). When the `--project` partition's candidates are not empty, show
   them as a table and ask which one the project is; write the chosen `id` as that row's
   `projectId` and plan again. Never pick one for the user: not by name, not because it is the only
   one, not by path. A row whose `chainRole` is `project` cannot go without it (the plan blocks with
   `SETUP_ANSWER_INVALID`). A row without `chainRole` that names none, for a library no earlier run
   bound to a project, gets a configuration project of setup's own beside the old ones (see "When a
   migration created a second project" below). A coordination row takes none. Another project row
   may name its project the same way, which binds its registry entry and its identity's primary
   project. A malformed `projectId`, or one on a coordination row, refuses the mapping with
   `SETUP_ANSWER_INVALID` on `projectId`.
   Pass it with `--mapping <file>`.
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
     outcome class) and `openItems` (the work still open, by status), `knowledge` for a store to carry
     and `knowledgeOmission` for an explicit omission with its reason and source evidence; the
     coordination partition alone has `coordinationSettings`, the chain's own settings, each
     `{key, value, source, action}`: `artifact.language` always (`source` `legacy-declared` when the
     old chain declares it, else `legacy-default` with the catalog default) and
     `execution.maxConcurrentSubagents` and the `quota.*` keys the old chain declares; `action` is
     `carried` (the import brings it), `write` (the apply writes it into the coordination library)
     or `default` (a `legacy-default` language: written nowhere, so the coordination library records
     no language and its card writes need no language bundle); every partition also has `projectId`,
     the project its row names (`null` for none), and `projectCandidates`, the old chain's live
     projects (`null` when the old chain does not read), and a project row that names a project has
     it in `chainIdentity` as `primaryProjectId`;
   - `registry`, the entry each library gets (with `projectId` when its row names one), and
     `deviceSettings`, the portal keys that move;
   - `projectBinding`, only when the `--project` partition's row names a project and the partition
     is not blocked: `{partition, library, from, to, retirement}` (see "When a migration created a
     second project" below);
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
   - `SETUP_LIBRARY_CONFLICT`: this device registered the project to another library, or a library
     migrated before names another primary project than its row's `projectId`. A primary project
     changes only through `chain-declare`, which the user declares on the library page in Atelier;
     from a model it is refused with `MODEL_WRITE_REFUSED` even when it cites a decision, so tell
     the user.
   - `SETUP_ANSWER_INVALID` on a partition's library: its row's `projectId` is not a live project of
     its old chain (or, for a library migrated before, of the library), or the `--project`
     partition's row has `chainRole` `project`, its old chain holds live projects and the row names
     none. The message lists the candidates; ask question 1 for the row and plan again.
   - `SETUP_ANSWER_INVALID` on the project itself: `--project` names the partition whose
     `chainRole` is `coordination`. Nothing is imported. Plan again with the same mapping and
     `--project` set to the root of a partition whose `chainRole` is `project`; the blocker names
     one.
   - `MIGRATE_CLEANUP_BACKUP_EXISTS` or `LEGACY_SKILL_CLEANUP_BACKUP_EXISTS`: a backup of the same
     second is already there. Plan again with a later `--at`.
   - `MIGRATE_CLEANUP_CROSS_VOLUME`: an entry to move is on another volume than the device
     directory; a move is a rename and cannot cross volumes. Tell the user which one.
   - `HOST_HOOKS_FILE_UNSUPPORTED`: a host file is a link or does not parse; the user fixes it.
4. Final confirmation. Show the mapping, a table of the partitions (partition, library, action,
   events, head), each explicit knowledge omission with its reason, named source files and
   unvalidated card identities, the gates that stay pending, the `hostCleanup` list and every file the plan
   would write, and ask once whether to apply. Continue only on a clear yes.
5. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: `migration` with
   each partition `imported` or `skipped`, the registry entries and `hostCleanup` as it was done
   (and `projectBinding` as it was left, when the plan had one), the files `written`, the backup
   directory (`backupDir`), `recallSmoke` and `selfCheck`. If it
   stops with `LEGACY_IMPORT_MISMATCH`, its `partition` names where; the partitions before it are in
   their libraries and are skipped when you plan and apply again. If it stops with
   `SETUP_RECALL_SMOKE_MISSED`, the libraries are imported and registered, nothing old is taken off
   and nothing is wired: tell the user the card the refusal names in the library it names as
   `target`, check that library's retrieval settings such as `retrieval.tau`, then plan and apply
   again with the same mapping and a later `--at`; the migrated partitions are skipped.
6. Report the backup directory, what the cleanup took off, each library, the gates still pending,
   and the eight checks in `selfCheck`. Handle any check that is not ok with `doctor.md`.

Running the same command again changes nothing: migrated partitions are skipped, and the
cleanup and the wiring find nothing left to do.

## Knowledge carried

- By default the import carries each old workspace's knowledge store (`knowledge/` in its old control
  directory) into the library's `crest/` as its engine left it: the marker `store.json`,
  `metadata/` and `bodies/` (segments included), byte for byte. The old `views/` stays behind,
  since the library's index view is this device's cache. The library reads that layout and writes
  new cards beside it; writing a card never rewrites the carried files. Of the steps in this
  reference, only the clearing step under "After the migration" does: it backs up the carried
  `bodies/` first, then writes it again without the bodies of the removed cards.
- A card the old engine marked as replaced (`extensions.supersededBy` in its metadata) reads as
  removed: `knowledge-list` lists it only with `--status removed` or `--status all`. It is carried
  with the rest.
- The receipt of `library-import-legacy` (a dry run's and an import's alike) holds `knowledge`,
  `null` when the old workspace has no store or its entry explicitly omits it (then
  `knowledgeOmission` explains what was left behind):
  - `cards`: every card of the store, whatever its status
    (`knowledge-list --selection all --status all`);
  - `removedCards`: those of them that read as removed (`--status removed`);
  - `defaultCards`: those `knowledge-list` answers by default (valid cards only);
  - `files` and `bytes`: the files carried into `crest/` and their size.

  After the copy the library must answer the same three counts, or the import stops with
  `LEGACY_IMPORT_MISMATCH`. To see a partition's counts before the apply, run
  `library-import-legacy --legacy <old workspace> --dry-run true --at <UTC>`; it writes nothing.
- Without an explicit omission, a store the engine cannot read blocks its partition. The plan lists the refusal as a blocker of
  its own, whose `path` is the file of the store it is about (the store itself when the refusal
  does not fall on a single file, for example when it is about the store as a whole), and still
  lists the partition's `events`, `headEventHash`,
  `unsatisfiedGates` and `openItems`. `library-import-legacy` names the same file in `file`,
  relative to the store (`.` when the refusal does not fall on a single file, for example when it
  is about the store as a whole).
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

### Explicitly leaving old knowledge behind

Only an entry that the user explicitly approves may contain
`"omitLegacyKnowledge": {"reason": "<why the old store is not carried>"}`. The object accepts only
`reason`, a nonblank line of at most 512 characters with no control characters; unknown fields,
wrong types, and missing or blank reasons refuse with `SETUP_ANSWER_INVALID`. Omission applies to
the whole old store of that partition, including readable cards; the user's independent crest
and other entries' knowledge are unaffected. A missing declaration still takes the strict
carry path, with all canonical byte, path and digest checks.

The same mapping works for one partition's import:
`library-import-legacy --legacy <old workspace> --mapping <file> --dry-run true --at <UTC>`.
`--legacy` must match one entry's absolute old path (after resolving `.` and `..`); its target is
that entry's `<projectRoot>/.ether`. An explicit `--target` must match that target. An unmatched
old path or a conflicting target refuses with `SETUP_ANSWER_INVALID`. Omit `--dry-run true` for
the real import after approval. No separate flag bypasses validation.

The dry run, the plan's partition and the applied receipt all expose `knowledgeOmission`:
`selection: "omit"`, the declared `reason`, the source `store` and its `presence`, the ordinary
reader's `refusal` (code, relative file and message), and `files` (relative path, raw byte size,
SHA-256 and any `issue`). This inventory also identifies a second noncanonical JSON file even
when the reader stops at the first. `counts` comes only from the ordinary reader: its three
counts when readable, `"unknown"` when refused, or `"absent"` when there is no store.
`unvalidatedCards` lists the ids and external keys parsed from metadata, with their files; these
facts are not accepted card records and cannot establish counts. Unreadable facts stay unknown,
and links are not followed by the inventory. `knowledge` is `null` for an omission, so the
selection and evidence must be shown with it.

An omission imports the chain, history, stream head and pending gates normally into a readable
library crest containing none of that old store's cards. It never edits old bytes. An existing
library that already carries old metadata cannot be cleared by changing its mapping declaration:
the plan blocks with `LEGACY_IMPORT_MISMATCH`. With the same omission, a migrated library is
skipped on a repeated apply and the reason and old source evidence remain visible.

For the approved TMS choice, `store.json` and
`metadata/knowledge:af064728aab1f7daa1440840.json` remain unchanged in the old workspace.
After the actual migration, reconstruct `CARD-FALSIFIABLE-NOT-CORRECT` and
`CARD-COUNT-ONLY-GATE` from their content through `knowledge-create`; the normal duplicate and
language gates still apply. Reconstruction is a later migration action, never an import repair.

## After the migration

- Clear the bodies of removed cards from the knowledge each library carried over: the import brings
  the old store's cards as its engine left them, the bodies of superseded cards included. Run
  `knowledge-bodies-migrate --workspace <library> --clear-removed true --at <UTC>` once after the
  import, and once more after each later removal of carried cards (such as a cleanup that removes
  old cards repeating a work item or a decision, or conflicting with another card), since a card
  removed after the import leaves its body there too. It runs only while this device is the
  library's sole writer, so every run must come before another
  device writes to the library: `KNOWLEDGE_SOLE_WRITER_REQUIRED` says one has, and those bodies then
  stay where no read answers them. The answer gives `clearedBodies` and the backup of the bodies it
  rewrote, `backupDir`, under `backups/<UTC>/crest-bodies/`; when no removed-card bodies remain to
  clear and no per-card body files remain to move, a run writes nothing, but if the carried layout
  still has per-card `.body` files, this step backs up its `bodies/` before moving those files into
  the segments, so `clearedBodies` can be `0` while `backupDir` is not `null`.
  `KNOWLEDGE_ALREADY_EXISTS` means a backup of the same second is already there: run again
  with a later `--at`.
- The old workspace stays where it is and still reads. A write to it answers
  `LEGACY_WORKSPACE_MIGRATED`, whose `movedTo` is the library it became; write there instead
  (`--workspace <library>`, the refusal's remedy).
- A gate that was pending or blocked in the old chain stays so in the library and keeps holding
  its work item back from done; the refusal, `WORKSPACE_GATE_PENDING`, names the gate. It is
  released in Atelier, on its migrated-gate page, or by you when the user's decision names it:
  `work-gate-release --id <gate> --reason <why> --actor <actor> --at <UTC> --decided-in
  minutes:<id>#D<n>`, citing minutes decided by `owner:governance` whose decision names the gate's
  id. Either way the gate records who released it, when and why. Without a decision your run is
  refused with `MODEL_WRITE_REFUSED`: do not set `EINZBERN_SURFACE` yourself; tell the user which
  gates are theirs to release, or ask for the decision. `work-gate-list --status all` lists them.

## When a migration created a second project

When the `--project` partition's row named no project and nothing bound the library to one yet,
setup created a configuration project of its own (external key `SETUP-CONFIG-` and a digest, named
after the project directory) and bound the language, the managed-section records and the registry
entry's `projectId` to it. An engine that did not take `projectId` always did. Beside an old chain
that holds projects, the library then has one project more: the old chain's work is in its own
project, the configuration in setup's. `library-list` shows the registry entry naming setup's
project, and the plan's `projectCandidates` tells the projects apart by `externalKey` and `work`.

Repair it with `setup --mode migrate` again; there is no other verb for it. An engine that does not
take `projectId` refuses the row (`SETUP_ANSWER_INVALID` on `projectId`, the message saying a
partition does not take it): update the engine first, as `update.md` says.

1. Write a mapping of two rows, the coordination row and the project's row, each as the first
   migration wrote it (partition, old workspace, project root, `chainRole` and every other field),
   and add to the project's row the `projectId` the user chooses from `projectCandidates`, the
   project that holds the old chain's records.
2. Plan with `--project` set to that project's root and the first migration's answers (the
   language is the one setup's project records). Both partitions must be `skip`; an `import` means
   a row differs from the first migration: stop and show it. `migration.projectBinding` gives
   `from`, the project the registry entry names now, `to`, the row's project, and `retirement`,
   what becomes of `from`: `action` `delete` when setup created it and nothing but setup's language
   and managed-section records is in it, otherwise `keep`, with `holds` saying what keeps it.
3. At the final confirmation show the binding, the retirement with its `settings`, `records` and
   `holds`, and every file the plan would write, then apply with `--yes true` and a later `--at`.
   The apply reads the former project again and checks that the registry entry, a project chain's
   identity and the managed sections have moved before it removes anything; `registry-not-moved`,
   `identity-not-moved` or `sections-not-moved` in `holds` say one has not. `retirement.action` is
   `deleted` or `kept`.
4. Report the binding, what was removed or what kept the former project, and that `AGENTS.md`'s
   system-variables section now names the new configuration target, a change in the project's
   working tree that is the user's to commit or not. Planning the same mapping again writes
   nothing.

The deletion is a `project.deleted` event on the chain: the record stays as a tombstone and no file
is deleted. With `kept` only the binding moved, and the former project stays as it was; what to do
with it is the user's call.

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
