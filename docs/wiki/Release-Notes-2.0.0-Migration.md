# Einzbern 2.0.0 发行说明：迁移

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 12/13：迁移

上一模块：[Mana Orchestrate](Release-Notes-2.0.0-Mana-Orchestrate.md) · 下一模块：[发行与仓库工具](Release-Notes-2.0.0-Release-and-Repository-Tooling.md)

## `library-import-legacy` imports an old-layout workspace into a new library

`library-import-legacy --legacy <old workspace> --at <instant> [--target <library>]
[--dry-run true] [--project-name] [--git-remote]` imports an old-layout workspace into a new
library whose first stream is the old chain, byte for byte (TCRN-CROSS-STORY-468 R6, AC4; 466
AC3). The old workspace is only read and its chain is validated from genesis first; a dry run
stops there, reports the events, head, stream id and segments, and writes nothing. An import
creates the library (default: `.ether` in the old workspace root) under the old workspace id,
copies every segment into this device's stream unchanged and checked by SHA-256, commits a
stream manifest that keeps the old stream id and event identities (`identityScheme: legacy`),
sequence and head, replays the library against the old chain's events, head and records, and
projects its settings into `config/project.json`. This device's next event continues the stream:
the next sequence, a priorHash on the old head, `einzbern.event.v1` beside the old
`tcrn.event.v1` events.

## `setup --mode migrate` plans the migration of an installation from before the rename

`setup --mode migrate` plans the migration of an installation from before the rename
(TCRN-CROSS-STORY-489 R1, TCRN-CROSS-SUB-364; MIN-235 D17, MIN-238 D4; `packages/core/src/migrate-legacy.ts`,
`setup.ts`). It no longer answers `SETUP_MIGRATE_PENDING`, which leaves `SETUP_REASON_CODES`; with no
installation from before the rename it still answers `SETUP_MIGRATE_NOTHING`, whatever `--mapping`
names. The mode takes `--mapping`, `--cloud`, `--language` and `--navigation` (any other option is
`SETUP_OPTION_NOT_APPLICABLE`), and without `--yes true` it writes nothing and answers
`SETUP_PLAN_READY` with a new field, `migration`. Its apply, and what a second run of the same mapping
plans, are below (TCRN-CROSS-SUB-365); a plan with a blocker is refused as before (`SETUP_BLOCKED`). The mapping is a JSON file of this device's paths that is never committed,
`{"schemaVersion": "einzbern.migration-mapping.v1", "partitions": [{"partition", "legacyWorkspace",
"projectRoot", "projectName"?, "gitRemote"?}]}`: at least one partition; `partition` is its name,
`legacyWorkspace` the absolute path of the directory that holds the old control directory,
`projectRoot` the absolute path of the project whose `.ether` the chain becomes (the container root
for cross-project), and `projectName` and `gitRemote` the library's project hints, by default the
project directory's name and its working tree's remote; no other field, and no partition, old
workspace or project named twice, through a link included. A relative `--mapping` is taken from the
project. A mapping that does not read or breaks these rules answers `SETUP_ANSWER_INVALID` with
`question` `mapping`, `file` and, where one is at fault, `entry` and `field`. Without `--mapping`, an
old workspace in the project itself is the one partition the plan infers; with none there the
`library` step holds a `SETUP_ANSWER_REQUIRED` blocker. The question `mapping` (default null) is open
whenever `--mapping` is not given, before `cloud`, `language` and `navigation`; `resolved.artifacts` is
the library of the project's own partition, `resolved.language` the `artifact.language` that
partition's chain records, else the default, and a given `--cloud` holds for every library, each of
which otherwise takes the cloud folder table's suggestion. `migration` holds `mappingFile` (the
resolved `--mapping`, or null), `mapping` (in the file's shape, or null), `partitions`, `registry`,
`deviceSettings` and `hostCleanup`. A partition is `{partition, legacyWorkspace, projectRoot, target,
targetState, action, workspaceId, streamId, events, headEventHash, projectName, gitRemote, language,
unsatisfiedGates, openItems}`: the paths are real paths once they exist; `target` is
`<projectRoot>/.ether`, `targetState` `absent`, `empty`, `not-empty` or `not-a-directory`, and `action`
`import`, or `blocked` when a blocker names the partition; `workspaceId` (the library keeps it as its
id), `streamId`, `events` and `headEventHash` are the import's dry run, which validates the chain from
genesis, and a second replay must reach the same head (`LEGACY_IMPORT_MISMATCH` otherwise);
`unsatisfiedGates` lists every gate that is not satisfied as `{id, workId, status, title,
outcomeClass}`, so a pending gate stays pending and is listed, never counted as none; `openItems` is
`{total, byStatus}` over the work that is neither done nor cancelled, `byStatus` keyed by `planned`,
`ready`, `active`, `blocked` and `pending-owner-acceptance`; `workspaceId` to `headEventHash`,
`language`, `unsatisfiedGates` and `openItems` are null when the old chain does not read, which is
unknown and not none. `registry` holds the entry each library gets, `{partition, projectPath,
libraryPath, libraryId, cloudHosted, gitRemote, migratedFrom}`, with the normalized remote and the old
workspace as `migratedFrom`. `deviceSettings` is `{from, to, keys}`: the `portal.*` keys of the old
device directory's `machine-settings.json` (`from`, null without one) against this device's (`to`),
each `{key, value, current, action}`, where `action` is `set`, `unchanged`, `kept` (this device holds
another value, which stays) or `invalid` (this engine does not take the key or value). `hostCleanup`
lists what the cleanup takes off this device (TCRN-CROSS-SUB-366, below). The writes are this
device's `device.json` when it has none, then each
library to import, the registry and, when a key is set, the machine settings, in that order; the
blockers are a target that is not a new or empty directory (`LIBRARY_TARGET_NOT_EMPTY`,
`LIBRARY_TARGET_INVALID`), a mapped project that is not a directory (`SETUP_INPUT_INVALID`), an old
workspace that does not read (its own reason code, such as `LEGACY_WORKSPACE_NOT_FOUND`), a project
this device registered to another library (`SETUP_LIBRARY_CONFLICT`) and a machine settings file that
does not read (`MACHINE_SETTINGS_FILE_INVALID`), beside the engine and device blockers of the other
modes. `migrate-legacy.ts` is not exported by core's index.

## `setup --mode migrate --yes true` applies the plan

`setup --mode migrate --yes true` applies the plan (TCRN-CROSS-STORY-489 R1, R2, R4,
TCRN-CROSS-SUB-365; MIN-235 D17, D11, MIN-238 D4; `packages/core/src/migrate-legacy.ts`, `setup.ts`,
`registry.ts`, `workspace.ts`, `packages/cli/src/index.ts`, `specs/gate-v1.md`). After this device's
`device.json` (when it has none), each partition is imported, in the plan's order, into its `target` as
the library's first stream by the import `library-import-legacy` runs (the chain validated from genesis,
the new library replayed to the same events, head and records), and the workspace id, stream, events
and head it carried are compared with the plan's: a difference stops the apply with
`LEGACY_IMPORT_MISMATCH`, whose message and `details.partition` name the partition, before anything is
registered (an import that fails for another reason keeps its own reason code and is named the same
way). Then each partition's registry entry is written with `migratedFrom`, the real path of its old
workspace, an existing `registry.json` copied first into `backups/<UTC>/registry/` of the device
directory; then each `portal.*` key the plan sets that this device still does not hold. No old
workspace or old device directory is written, and no gate changes: a pending gate is pending in the
library (MIN-238 D4). `SETUP_APPLIED` has a new field, `migration`: `partitions`, each `{partition,
legacyWorkspace, projectRoot, target, libraryId, action, events, headEventHash}` with `action`
`imported` or `skipped`; `registry`, the entries as they stand after the apply; and `deviceSettings`,
`{from, to, keys}` with each key's `current` as this device held it before and `action` as the apply
took it. `library` is the project's own partition's library. The self-check is doctor's eight checks,
as in the other modes; the language, the cleanup and the wiring that follow the migration are
described below (TCRN-CROSS-SUB-366). `SETUP_MODE_UNAVAILABLE` leaves
`SETUP_REASON_CODES`: no mode answers it any more.

## The same mapping applied again changes nothing

The same mapping applied again changes nothing (TCRN-CROSS-SUB-365). A target that is not empty is now
read: when it is the library an import of the partition's chain created (its id is the old workspace
id and one of its streams is the old stream, imported under the legacy identity scheme, carrying the
old chain up to the old head, whatever this device appended since), `targetState` is the new
`migrated` and `action` the new `skip`, and the apply finds it so again and writes nothing for it; a
library with that id that does not carry the chain stops the plan with `LEGACY_IMPORT_MISMATCH` (they
have diverged). For a target the import would refuse, `workspaceId`, `streamId`, `events` and
`headEventHash` come from the replay, which validates the chain from genesis too, rather than from the
dry run. The registry write is planned only when an entry is missing or differs, and listed in the
plan's `backups` when the file exists; a partition already registered to its library keeps its cloud
flag unless `--cloud` is given; a portal key this device holds is not set again. `library.action` is
`reuse` for a migrated partition.

## The registry takes an optional entry field, `migratedFrom`

The registry (`einzbern.registry.v1`) takes an optional entry field, `migratedFrom`, an absolute path
(TCRN-CROSS-STORY-489 R2, R4; `packages/core/src/registry.ts`, `workspace.ts`). An entry without it
reads as before; one whose `migratedFrom` is not an absolute path is not written and does not read
(`LIBRARY_REGISTRY_INVALID`). Registering a project to the same library again keeps the entry's
`migratedFrom`, and to another library drops it. The field is the old path's tombstone, kept on this
device and never in the old workspace: a write aimed at an old-layout workspace an entry was migrated
from is refused with the new `LEGACY_WORKSPACE_MIGRATED` (in `WORKSPACE_REASON_CODES`),
`details.movedTo` the library and `details.remedy` `--workspace <library>`, and the old workspace still
reads. One no entry names, or any when the registry does not read, is refused with
`LEGACY_WORKSPACE_READ_ONLY` as before; a knowledge write to an old layout keeps its own refusal.

## A gate a migration carried over is released in Atelier

A gate a migration carried over is released in Atelier (TCRN-CROSS-STORY-489; MIN-235 D17, D11, MIN-238
D4; `packages/core/src/workspace.ts`, `packages/cli/src/index.ts`, `specs/gate-v1.md`). The gate and
conference verbs stay retired, so a gate still `pending` or `blocked` when its chain became a library
keeps holding its work item back from `done`; the refusal, `WORKSPACE_GATE_PENDING`, now names each
gate (`details.gates` and the message) and `details.remedy`
`work-gate-release --id <gate> --reason <why>, in Atelier`, and `work-transition` and `work-batch`
make that check before they weigh a Story's code gates, so the gate is what a held work item hears
first. `work-gate-release --id <gate> --reason <why> --actor <actor> --at <instant>` writes one
`gate.updated` to `satisfied` whose only extensions delta is `gate-evidence:atelier-release`,
`{required: false, value: {actor, reason, releasedAt}}`: who, why (one to 2048 bytes, not blank) and
the event's own instant. Without `EINZBERN_SURFACE=atelier` it is refused with `MODEL_WRITE_REFUSED`
(remedy `change it in Atelier`) and nothing appended; that surface is a convention, not proof of who
ran it. A deleted or already satisfied gate, a blank or oversized reason and an invalid actor are
refused with `WORKSPACE_INPUT_INVALID` or `WORKSPACE_ACTOR_INVALID`. Replay checks the entry from the
chain alone (the three fields, the instant equal to the event's, the only extensions delta, and the
event's signer when the chain signs its events) and otherwise rejects the event, leaving the gate as it
was. `work-gate-list [--work-id <id>] [--status pending|blocked|satisfied|all]` is the read face: a
`WORKSPACE_LIST_READY` page of kind `work-gate`, by default the gates that still hold work back.
Neither verb starts with `gate-` or `minutes-`. Core's index exports the two functions the CLI calls
for them, `releaseGate` and `assertWorkGatesClear`; `findMigratedEntry` and `applyMigration` are
exported by their modules only.

## `setup --mode migrate --yes true` now finishes the migration on this device

`setup --mode migrate --yes true` now finishes the migration on this device (TCRN-CROSS-STORY-489
R3, AC2, AC3, TCRN-CROSS-SUB-366; MIN-238 D4; `packages/core/src/migrate-cleanup.ts`, `setup.ts`,
`setup-fresh.ts`, `setup-maintain.ts`, `setup-restore.ts`, `names.ts`). After the partitions are
imported and registered and the portal keys set, the apply writes the language answer into the
project's own library, takes the old installation off this device and wires the project as fresh
does, every step but the registry, whose entries the migration wrote with `migratedFrom`: the two
skill copies, the two launchers, one Einzbern hook per host in the user's settings,
`agents.navigation`, CLAUDE.md's import section and, with `--navigation true`, AGENTS.md's
navigation section. The cleanup renders the host files through host-hooks: the user's
`.claude/settings.json` and `.codex/hooks.json` keep the one Einzbern hook (with the two pointer
hooks when navigation is declined), and those of each project the mapping names (the container root
among them) and of `--project` keep none of ours. Every hook of the old harness, on whatever event,
the `permissions.deny` rules that fenced the old directories and the old inert key come out; other
tools' hooks and keys stay, Codex's hooks switch stays on, and the trust state of each hook that
went goes with it. A file with nothing of ours to take out is left to the wiring (the user's) or as
it is. Then the cleanup moves into `backups/<UTC>/` of the device directory, deleting nothing: the
old adapter's template directories (`.claude/<old engine name>/` and `.codex/<old engine name>/`) of
the home and of each of those projects, and the old injection state of the home (named by
`LEGACY_INJECTION_STATE_DIRECTORY` in `names.ts`), under `host-hooks/<root key>/`; the old portal's
three launchers in each project's root, under `launchers/<root key>/`; and the old helper's skill
copies and install markers, under `skill-copies/`, as `applyLegacySkillCleanup` moves them. A root
key is the first sixteen hexadecimal digits of the SHA-256 of the root's path, which the host files'
backups already use. The old workspaces' container and the platform archive are never listed, and
the old device directory keeps its old engine copy. The plan's `migration.hostCleanup` lists each
item as `{kind, path, action, into}`: `kind` `host-file` with `action` `update` and `into` the copy
of its original, or `template`, `injection-state`, `launcher`, `skill-copy` or `marker` with
`action` `move` and `into` its place in the backups. The receipt's `migration.hostCleanup` lists
what was done, and `writes`, `backups` and `written` carry the same files under the `host-hooks`,
`launchers` and `skill-copies` steps. A backup place already taken stops the plan
(`MIGRATE_CLEANUP_BACKUP_EXISTS`, or `LEGACY_SKILL_CLEANUP_BACKUP_EXISTS` for the old helper's
entries), and so does an entry on another volume than the device directory
(`MIGRATE_CLEANUP_CROSS_VOLUME`), since a move is a rename; the apply checks every move again before
it writes anything, and a rename that fails is `MIGRATE_CLEANUP_MOVE_FAILED`. A user host file
host-hooks will not render is the wiring's blocker, recorded once. Without a mapping the plan lists
no cleanup or wiring. A library a migration imported carries its old chain, and a chain that enabled
attestation refuses a write that names no actor, so the wizard names `SETUP_ACTOR`, `agent:setup`,
on every event it writes into a library: the language and the managed-section records. The wiring
takes it as `WiringApplyInput.actorId`, which migrate, restore and repair pass, and repair names it
when it takes out a declined navigation section too; fresh creates a library that enables no
attestation, and update writes none. A repair or restore of such a library used to write the project
file and then be refused with `WORKSPACE_ACTOR_REQUIRED` before it recorded the section. Like
Atelier's `agent:portal`, the actor says which surface wrote and proves nothing. Those events go on
the imported stream, which belongs to this device: the project's own library then holds its old
chain up to the old head and this device's writes after it, while every other migrated library still
ends at its old head. The same mapping applied again writes nothing. The migration is reached
through `planSetup` and `applySetup`: `migrate-cleanup.ts`, like `migrate-legacy.ts`, is exported by
its module only, since only core and its tests call it.

## `library-import-legacy` compares a chain whose records run past one MiB, and carries the old knowledge store

`library-import-legacy` compares a chain whose records run past one MiB, and carries the old
knowledge store (TCRN-CROSS-SUB-421, TCRN-CROSS-INC-397; fixes TCRN-CROSS-STORY-468 R6; MIN-239 D7;
`packages/core/src/legacy-import.ts`). The import checked the library's replay against the old
chain's records with one `canonicalSha256` over the eight record collections, which refuses a value
past one MiB: cross-project's records measure 7.7 MB, so its import stopped with `INPUT_OVERSIZED`
after the segments and the stream manifest were written, while a dry run, which never made that
check, passed. The digest (`legacyRecordsDigest`, exported by its module and not by core's index)
is now the same canonical JSON fed to SHA-256 one record at a time, each record through
`canonicalJson` with every check it makes: within the protocol's limits it equals `canonicalSha256`
of the whole, past them it compares every record instead of refusing, and a record that is not
canonical still throws. `PROTOCOL_LIMITS.maxCanonicalBytes` is unchanged, and a mismatch is still
`LEGACY_IMPORT_MISMATCH`, now naming the collections that differ. A dry run makes every check an
import makes before it writes, and both receipts carry `records` (that digest and each collection's
count) and `knowledge`. The old workspace's knowledge store is carried into `crest/` as its engine
left it: `store.json`, `metadata/` and `bodies/` (segments included), byte for byte and checked by
SHA-256; `views/` stays behind, since a library's index view is this device's cache. The library's
crest reads that layout as it reads any crest an older engine left and takes new cards as events
beside it, and it must answer the old store's three card counts: every card whatever its status, the
cards that read as removed, and the cards listed by default; `knowledge` reports them (`cards`,
`removedCards`, `defaultCards`) and the files and bytes carried, or is `null` when the old workspace
has no store. `config/project.json` is written, with the settings and the
configuration records, once every check has passed. This device's identity is read or made before
the target is touched, and an import that stops after it has written into its target answers with the
reason code and details of what stopped it (`LEGACY_IMPORT_STOPPED` when that carries none), the
target, and every file and empty directory it left there, relative to the target, in the message and
in `written`; nothing is removed, so an import into that target again is refused as not empty until
it is moved aside.

## `library-import-legacy` counts the carried cards whatever their status, and names the file of an old knowledge store it refuses

`library-import-legacy` counts the carried cards whatever their status, and names the file of an
old knowledge store it refuses (TCRN-CROSS-SUB-421 R18, TCRN-CROSS-STORY-489;
`packages/core/src/legacy-import.ts`, `packages/core/src/migrate-legacy.ts`). Since a card the old
engine marked superseded (`extensions.supersededBy`) reads as removed (TCRN-CROSS-SUB-425), the
receipt's `knowledge.cards` had counted the valid cards alone, 93 of cross-project's 158. It is
again every card the store holds, whatever its status; the new `removedCards` counts those that
read as removed (65 there), beside `defaultCards` (55), in a dry run and an import alike, and the
library's crest must answer all three after the copy. A store this engine's reader refuses is
refused with the reader's own reason code and message (`KNOWLEDGE_RECORD_INVALID`,
`KNOWLEDGE_PATH_INVALID`, `KNOWLEDGE_PARTIAL_STATE`, ...), and the refusal now names the file of the
store it is about, in its message and in `file`, relative to the store's root, or `.` for the store
as a whole (`LegacyKnowledgeRefusedError`, exported by its module and not by core's index).
TCRN-TMS's store, whose marker and one card were saved again by another tool, indented and without
their final newline, is refused naming `store.json`. `setup --mode migrate` keeps the chain of such
a partition in its plan: the old chain is still replayed, its events, head, unsatisfied gates and
open work are listed, and the refusal is a blocker of its own whose `path` is the named file. The
skill's migrate reference and the Wiki's migration page say how the store is carried, what each
field of the receipt counts, and what the three knowledge refusals mean and how they are handled.
The records digest, the segments, the carried bytes and every other reason code are unchanged.

## A migration no longer records the catalog default as the coordination chain's language

A migration no longer records the catalog default as the coordination chain's language
(TCRN-CROSS-INIT-053 R48). When the old coordination chain declares no `artifact.language`, its
`coordinationSettings` row is still listed as `legacy-default`, now with `action: "default"`, and the
apply writes nothing: the coordination library reads the catalog default and records no language, so
a card written there needs no language bundle, as before the migration. A recorded default had turned
on the library's write language policy, after which every card write there needed the economy-tier
model and `--language-bundle` or was refused with `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`. A language
or an orchestration limit the old chain declares is carried or written as before, and written again
when the library no longer holds it. The `SETUP_RECALL_SMOKE_MISSED` refusal of the shipped entry now
carries `cardId` and `query` as fields as well as in its message. `scripts/platform-doctor.mjs`'s
`engineFloorSatisfied` is now red when the chains' `engine.requiredVersion` declarations cannot be
read (`PLATFORM_ENGINE_REQUIREMENT_UNREADABLE`, still with `requirementAsserted: false`); chains that
read and declare nothing stay green as `PLATFORM_ENGINE_REQUIREMENT_UNDECLARED`. The engine capability
surface tests hand the doctor a home directory of their own instead of reading the real one.

## Migration mappings may explicitly leave one partition's old knowledge store behind

Migration mappings may explicitly leave one partition's old knowledge store behind with
`omitLegacyKnowledge: {reason}` (TCRN-CROSS-SUB-421 R20; MIN-240 D3/D5). The default still refuses
invalid old knowledge. A single `library-import-legacy --mapping <file>` and batch setup use the
same declaration, bound to the old path and project library. Plans and receipts disclose the
omission, its reason, the original reader refusal, every file's raw digest and byte size, and
unvalidated metadata identities; unreadable card counts are `"unknown"`, never zero. The approved
TMS choice leaves its two noncanonical JSON files unchanged and its two cards absent from the new
crest; rebuilding those cards follows the actual migration through ordinary duplicate and language
gates. Chains, history, heads and pending gates still migrate, other partitions carry their
knowledge unchanged, and the user crest is unaffected.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[Mana Orchestrate](Release-Notes-2.0.0-Mana-Orchestrate.md) · 下一模块：[发行与仓库工具](Release-Notes-2.0.0-Release-and-Repository-Tooling.md)
