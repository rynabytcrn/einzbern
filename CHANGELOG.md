# Changelog

All notable changes will be documented here. The project uses Semantic
Versioning after the first accepted release.

## Unreleased

### Hosts and Hooks

DSH is a host the hook runs under (TCRN-CROSS-STORY-548). `EINZBERN_HOST` names the host when it is
`claude-code`, `codex` or `dsh`; any other value, the empty string included, counts as unset, and the
host is read as before (`CLAUDE_PROJECT_DIR` set: Claude Code, otherwise Codex). Without
`EINZBERN_HOST`, what the hook prints for Claude Code and Codex is unchanged byte for byte. DSH runs
the launcher through its plugin and keeps no hook file Einzbern writes: `planHostHooks` refuses it
with `HOST_HOOKS_HOST_NOT_FILE_BASED`, and setup, doctor, migration cleanup and `host-render` walk
`HOST_HOOK_FILE_HOSTS` (Claude Code and Codex) only. Each recall line in `log/hook.ndjson` now
carries `host` after `reasonCode`, an additive field of `einzbern.hook-log.v1`; the launcher's lines
for prompts outside a registered project are unchanged.

`EXECUTION_HOSTS` now lists `dsh` beside `claude-code` and `codex`, so execution configuration
(host configurations, defaults and persona bindings) accepts `dsh`, and the vocabulary's `hosts` term
list names it. The default `models.tiers` table is unchanged and still has rows for Claude Code and
Codex only. doctor's `hooks-present` and the fresh setup plan read this home's DSH profiles, never
writing them: a plugin that would run another launcher than this device directory's is red
(`DSH_PLUGIN_HOOK_PATH_MISMATCH`); a profile without the plugin is a hint (`DSH_PLUGIN_MISSING`).

### Mana Orchestrate Skill

The skill's description and the five Mana Orchestrate READMEs name DeepSeek Harness beside Claude
Code and Codex (MIN-275 D2). `SKILL_DESCRIPTION` reads "into Claude Code, Codex and DeepSeek
Harness"; the READMEs' skill badge lists the three hosts, and their install section says that DSH
reads the `~/.agents/skills` copy and recalls through the dsh-mana-orchestrate plugin, with no hook
file written. The five Einzbern READMEs count three hosts and name DeepSeek Harness in their hosts
badge, the hosts-one-memory tile, the alternating-hosts case and the switching-hosts row, and
`package.json`'s description ends "For Claude Code, Codex and DeepSeek Harness." (MIN-277 D2).

### Release and Repository Tooling

The `fast-uri` override is now `^3.1.8` (TCRN-CROSS-STORY-544, TCRN-CROSS-SUB-525, MIN-265 D1).
GHSA-hrr3-gc8f-f4qj affects `fast-uri` from 3.0.0 up to but not including 3.1.8, and the previous
`^3.1.7` still allowed the affected 3.1.7. The lockfile still resolves 3.1.8 with the same
integrity; only the override lines of `pnpm-workspace.yaml` and `pnpm-lock.yaml` change. `fast-uri`
is a development dependency and is not in the release package.

The privacy scan allows the reviewed identity lines of merge commit `72ae480e` (TCRN-CROSS-MIN-279
D1). That web merge of PR #10 carries the account's primary address, and it is public history on
`main`. The allowance is the commit's object id with the sha256 of each full `author` and
`committer` line. The same lines on any other commit, or a changed line on this one, are still
`EMAIL_IDENTIFIER` findings. Merge commit `440f297d`, the web merge of PR #13, is allowed the same way
(TCRN-CROSS-MIN-281 D1); from then on pull requests are merged locally under the noreply identity.

CI is shorter (TCRN-CROSS-MIN-280). The portal remediation train runs once, as the `portal` leg of
`pnpm verify:p1`; the workflow's second `pnpm verify:portal` step, which ran the same script again
for about twelve minutes, is gone (D1). `verify:p1` reports a `durations` list with each leg's
`durationMs`, red legs included; the leg rows keep their shape (D2). On a pull request the privacy
leg scans the history increment only: the commits reachable from HEAD and not from the PR's base,
named by `EINZBERN_PRIVACY_HISTORY_BASE`, with every tree they hold, plus the whole tracked tree,
the refs and the origin as before; it reports `privacyScope: "pull-request-increment"` and the
`historyBase`. Push to `main`, `workflow_dispatch`, the P8 scan and a run without the variable keep
the full HEAD-reachable history (D3).

## 2.2.1

Einzbern and Mana Orchestrate ship in lockstep at 2.2.1. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Knowledge and Minutes

A coordination library's knowledge writes no longer take the write language policy
(TCRN-CROSS-STORY-543, TCRN-CROSS-SUB-523 and TCRN-CROSS-SUB-524, EPIC-151 R11, MIN-262 D1). Its
`artifact.language` decides only the language of its managed sections and variable sections; it has
no `models.*` (MIN-243 D1), so no economy-tier model can translate for it, and once it recorded a
language 2.2.0 refused every `knowledge-capture`, `knowledge-create` and `knowledge-batch` card
there with `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`. Its cards, and the article indexes of
`knowledge-article-create` and `knowledge-article-refresh`, are now written in the words they were
handed, untranslated and with no phrasings, as before it recorded a language; a `--language-bundle`
is still read and checked, and its answers are not used. recall still answers a query in another
language with the translation it is owed (`queryTranslation`, its `model` null), and the managed
sections still follow `artifact.language`. A project library, and a library with no chain identity,
keep the policy: once it records `artifact.language`, a card write there needs its economy-tier model
and a language bundle. No event, record, library format, flag, receipt field or reason code changes.

### Upgrading from 2.2.0

- Readers still need 2.2.0 for a library that already exists, because 2.2.1 writes no new event,
  record or library format: after 2.2.1 writes to such a library, 2.2.0 still opens it, counts no
  rejected event and still writes there. 2.2.0 reads a card that 2.2.1 writes in a coordination
  library that recorded `artifact.language` like any other card, in the words it was written and
  with no phrasings, and its recall finds it. A library that 2.2.1 creates records
  `minEngineVersion` 2.2.1, and 2.2.0 refuses to open it with `ENGINE_TOO_OLD`, as with every
  release. Install 2.2.1 on every device that reads the same library, together.
- Rolling back to 2.2.0 leaves a library and the cards that 2.2.1 wrote there intact, but a
  coordination library that recorded `artifact.language` then refuses card writes again with
  `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`, and a library that 2.2.1 created does not open.
- A gate run that 2.2.0 recorded still counts toward done: 2.2.1 records and reads runs in the same
  shapes (`einzbern.gate-run.v1`, with `einzbern.gate-tree.v3` roots).
- Once 2.2.1 is installed, a coordination library that recorded `artifact.language` writes cards
  with no `--language-bundle`; a project library that recorded it still needs its economy-tier model
  and a language bundle. A card that 2.2.0 refused in a coordination library with
  `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE` was never written, so write it again (here, the six cards
  of TCRN-CROSS-EPIC-150 R10; MIN-262 D1).

## 2.2.0

Einzbern and Mana Orchestrate ship in lockstep at 2.2.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Concurrency and Device State

More writes now hold the library write lock for their append alone, as work and configuration writes
have since 2.1.0 (TCRN-CROSS-STORY-538, TCRN-CROSS-SUB-497 to TCRN-CROSS-SUB-501, EPIC-150 R7,
MIN-256 D6, MIN-257 D6, MIN-258 D1): gate and rule proposals with their approval and rejection,
`work-delete` and `project-delete`, the managed-section writes (`agents-render`, `rule-resolve`,
`rule-enable`, `rule-disable` and the variable sections), `artifact-put`, and `knowledge-reverify`,
`knowledge-article-refresh` and the knowledge staleness policy write. Each reads and checks outside
the lock, so a refusal waits for no other writer; under the lock it checks that no stream moved
since its read and appends, or reads again, and after four tries the whole write runs under one
hold. A managed-section write plans AGENTS.md and CLAUDE.md from its read, and writes them only
while every file it read still holds what it read, so an AGENTS.md that another process changed
after the plan is not written over and the write plans again.

An approval's conditions are judged again against the state its append is built on, with the same
reason codes: an approval that another approval overtook is `PROPOSAL_NOT_FOUND` at its append, and
when a rule proposal is recorded again at the same instant with another change, the rule's approval
is `PROPOSAL_STALE` and AGENTS.md is put back (TCRN-CROSS-SUB-497). The deletes judge the leases
again at the append: a lease claimed on the item between the read and the append that still runs at
`--at` refuses `work-delete` with `WORK_LEASED`, whoever asks, and nothing is written; a lease
released in between is not removed a second time (TCRN-CROSS-SUB-498). `recover` keeps holding the
lock for its whole run.

`artifact-put` copies the blob into the library and reads it back before the lock, and holds the
lock only to replace the manifest (TCRN-CROSS-SUB-500). `snapshot-manifest` takes no lock: it stamps
every file it covers (path, inode, size, modification time) before it reads the state and after it
walks the tree, and reads under the lock only after four unsteady reads. `workspace-relocate` still
holds the lock from the copy to the tombstone; a blob that an `artifact-put` writes into the source
library while the relocation copies now makes the relocation fail safe with
`RELOCATE_COPY_MISMATCH`, taking its copy back, and a put that arrives after the tombstone is
refused, so no recorded data is lost.

`knowledge-batch` no longer holds the lock from its first member to its last: each member takes the
lock as its verb does, and `--align-first` takes it for its own rebase (TCRN-CROSS-SUB-501).
`knowledge-rebase`, `knowledge-bodies-migrate`, `knowledge-recover` and `knowledge-init` keep
holding it for their whole run. The CLI catalog spec lists what each write holds the lock for, and
the other specs, the file-lock header and the agent-integration reference now describe the lock as
the engine holds it (TCRN-CROSS-SUB-517 and TCRN-CROSS-SUB-522, EPIC-150 R8 and R9).

### Knowledge and Minutes

The INIT family of a record is now also read from a reference that is the whole external key of a
work record this library holds, and from a card's linked work, in the knowledge card guard and in
the `minutes-record` guard alike (TCRN-CROSS-STORY-539, TCRN-CROSS-SUB-503, EPIC-150 R7, MIN-256 D6,
MIN-258 D1). A key the library holds no work under names no family, as a file or a URL does.

Reads now set aside an unresolved pair of cards whose INIT families are both known and differ
(TCRN-CROSS-STORY-539, TCRN-CROSS-SUB-504, EPIC-150 R7): `knowledge-list` neither names such a pair
nor withholds its cards from default selection, and recall and a checkpoint follow. The crest scan
and its cache still find every pair, and a pair of one family, or of no known family, stands as
before. The knowledge hint leaves out the cards of a family apart from its target's and says how
many: its line ends with that count, and the receipts of `work-transition`, `work-batch` and
`minutes-record` carry it as `filteredByFamily`. A target of no known family keeps every card. The
minutes spec's topic comparison and the governed-loop tutorial describe the split and the count
(TCRN-CROSS-SUB-520, EPIC-150 R8).

### Managed Sections, Rules and Variables

A coordination library now writes managed sections too, into the one project root this device's
registry holds for it outside every library: the container it coordinates (TCRN-CROSS-STORY-540,
TCRN-CROSS-SUB-505, EPIC-150 R7, MIN-258 D3, which replaces MIN-245 D6). `agents-render`,
`rule-resolve`, `rule-enable`, `rule-disable` and the variable sections write that root's AGENTS.md
from the coordination library's own configuration and record each section, as they do for a project,
and `rule-list` reads a coordination library against that root. A root within a library is refused
with `MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY`, for a project library too, and a root that the
registry does not hold for the library with `MANAGED_SECTION_OUTPUT_UNREGISTERED`. A coordination
library that this device registered no such root for records a rule change alone and says
`outputBindingStatus: "unconfigured"` in the receipt; there an enabled rule reads
`removed-from-file`, and the receipt and Atelier's Rules page say why.

A coordination library's system variable section lists the settings that hold for it, each with its
effective value and source: `execution.maxConcurrentSubagents`, the four `quota.*` settings and the
seven `design.*` bindings, and no `models.*` or `execution.dispatchTiers` (TCRN-CROSS-STORY-540,
TCRN-CROSS-SUB-506, EPIC-150 R7). Both variable sections, for any library, now follow
`artifact.language`: `zh-CN` writes their headings, notes, table headers and placeholders in
Chinese, and any other value, or none, the English they always had. `variable-set` and
`variable-remove` on a coordination library render its sections again into its registered root;
`settings-set` still renders nothing.

Setup's repair now plans and writes the managed sections of a coordination library's registered
container, from the coordination library's own configuration, and an update still writes no project
file (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-507, EPIC-150 R7). The managed-sections check of `doctor`
lists every recorded section with its state in `detail.sections`, and reads a coordination library's
container against that library's records.

Two rules join the built-in catalog after `design-authority`, at version 1 and off until a project
enables them (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-509, EPIC-150 R9, MIN-258 D3, MIN-259 D1):
`residue-cleanup`, the Owner's rule for clearing what a task or a batch leaves behind, and
`goal-writing`, the contract for writing a session goal. Their Chinese text is the Owner's wording;
the English of `residue-cleanup` and the opening paragraph of `goal-writing` are translations that
await the Owner's correction. The catalog now holds seven rules.

`unattended-commands` is now at version 2 (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-514, EPIC-150 R9,
MIN-258 D3, MIN-259 D2). Its first clause gains one sentence: with the Owner's authorization, the
skill's trash-empty tool empties the named trash directories under the session's scratch directory,
plan first, one authorization per report of paths and sizes. Every other line is version 1's. A
project that enabled version 1 reads `update-available`, and neither that read nor `agents-render`
changes its AGENTS.md; `rule-enable` takes version 2.

### Configuration Writes and Owner Decisions

Four more writes take `--decided-in minutes:<id>#D<n>` (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-510,
EPIC-150 R7, MIN-258 D3): `work-gate-release`, whose decision names the gate by its id;
`project-bindings-set` and `project-bindings-remove`, whose decision names the binding's key; and
`work-release --force`, whose decision names the work item by its id or its whole external key,
never through `<prefix>.*`. The decision is checked and recorded as it is for the configuration
writes of 2.0.3, so `gate.updated` joins the operations that may carry the optional authorization
extras: a release records `surface`, `atelier` for Atelier's, and for a cited decision `decidedIn`
and `decidedInLibraryId`. Without a decision a model's run is still `MODEL_WRITE_REFUSED`, its
remedy naming Atelier and `--decided-in`. `chain-declare` takes no decision and stays with Atelier;
its remedy now names Atelier's library page. The specs, the Wiki and the CLI comments now say that a
cited decision is checked before the write takes the lock, against the state the write reads
(TCRN-CROSS-SUB-518, EPIC-150 R8).

### Device Maintenance

`library-unregister --project <path> --at <UTC>` removes the one registry entry whose project path
is the one given, which need not exist any more (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-511,
EPIC-150 R7, MIN-258 D3). Without `--yes true` it answers `LIBRARY_UNREGISTER_PLAN_READY` and writes
nothing; with it, `registry.json` is copied into `backups/<UTC>-library-unregister/` of the device
directory and replaced without that entry under the registry lock, and it answers
`LIBRARY_UNREGISTERED`. Other entries of the same library stay, and a path that no entry has is
`LIBRARY_NOT_REGISTERED`. The registry check of `doctor` lists each entry whose library path no
longer exists in `detail.hints`, with `REGISTRY_LIBRARY_MISSING` and the verb, and keeps its answer.

`device-clean --at <UTC>` lists each install and update staging in the device directory's `trash/`
and each entry of its `backups/`, with kind, version, size and reason, judged against
`engine/current` (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-512, EPIC-150 R7, MIN-258 D3). It keeps the
pre-update backups of the current and the previous version, the stagings of the current version and
any other entry of `trash/`, and clears the other stagings and pre-update backups. Any other backup
is judged by what it holds, read with `lstat` alone and no link followed, and lists those names as
`contents` (TCRN-CROSS-SUB-519 and TCRN-CROSS-SUB-521, EPIC-150 R8 and R9). A backup of the skill
copies alone, in the layout an update leaves (each host's copy at `<host skill root>/<skill id>`),
is cleared as `skill-copies-backup`. A backup that holds originals a write replaced (host hooks,
writable roots, managed sections, crest bodies, launchers, a registry, or the old helper's copies
and the install markers a migration moved) is kept as `holds-originals`, and anything else as
`unrecognised-backup`. A symbolic link, or an area whose real path leaves the device directory, is
refused and never touched. Without `--yes true` it answers `DEVICE_CLEAN_PLAN_READY` and writes
nothing; with it, each cleared entry is checked again and deleted, and `DEVICE_CLEANED` names each
with its size, or why it was not deleted. Without `engine/current` it answers
`DEVICE_CLEAN_ENGINE_UNKNOWN`.

### Atelier

Atelier now manages a coordination library's rules, variables and AGENTS.md through its registered
container (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-508, EPIC-150 R7, MIN-258 D3): the Rules page shows
the container's AGENTS.md, names the file a coordination library writes or says why it writes none,
and its saves and resolutions reach that file. A write of `execution.maxConcurrentSubagents` or of a
`quota.*` setting renders a coordination library's sections again, and a write of
`artifact.language` renders every library's.

Three writes that a model makes only with an Owner decision now have their place in Atelier
(TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-513, EPIC-150 R7, MIN-258 D3). A Library tab on the status
page declares the chain identity after a confirmation step, and removes a registry entry with
`library-unregister`, the plan first and the removal once confirmed, never for the selected entry. A
Migrated gates section on the Gates page lists the gates still holding work back and the released
ones with who, when and why, and releases one with `work-gate-release` for a reason that is not
blank. The copy is in all five locales, and the Rules page titles `residue-cleanup` and
`goal-writing` in all five as it titles the other rules (TCRN-CROSS-SUB-509, EPIC-150 R9).

### Mana Orchestrate Skill

The skill now ships `scripts/trash-empty.mjs` (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-514,
EPIC-150 R9, MIN-259 D2). It takes a scratch root and the trash directories to empty, each relative
to it. Each must end in `trash` or `trash-<name>`, be a directory and not a symbolic link, and lie
inside the scratch root by its real path; wildcards, absolute paths, dot segments and overlapping
names are refused, and so is a scratch root that is the filesystem root, the home or above it.
Without `--yes` it prints the plan (path, entries, bytes) and deletes nothing; with `--yes` it
checks again, deletes what each named directory holds, keeps the directory and prints the receipt.
Any refusal deletes nothing. The update reference says that it runs only after the Owner authorized
the report, and how to clear the device directory with `device-clean` once the user agreed; the
doctor reference asks for the user's go-ahead before `library-unregister --yes true`.

### Release and Repository Tooling

The portal proof's replay of TCRN-CROSS-INC-155 no longer compares the whole historical
`pnpm-lock.yaml` with the current one (TCRN-CROSS-EPIC-150 R9 PF-1): it compares only the entries
that decide TypeScript, the importers' `typescript` specifiers and versions and the
`typescript@<version>` entries under packages and snapshots, beside `package.json` and the installed
`typescript` as before. A difference is still `EVIDENCE_HISTORY_DEPENDENCY_MISMATCH`.

The `fast-uri` override is now `^3.1.7` and resolves to 3.1.8, within the `^3.0.1` range that `ajv`
declares (TCRN-CROSS-EPIC-150 R9 PF-1). `fast-uri` is a development dependency and is not in the
release package.

The coordination and human-only panels portal tests reach the loopback Atelier through an alias of
`globalThis.fetch`, as the proposals portal test does, so the offline boundary scan passes them
(TCRN-CROSS-SUB-515 and TCRN-CROSS-SUB-516, EPIC-150 R8).

### Upgrading from 2.1.0

- Readers need 2.2.0. Once 2.2.0 releases a migrated gate in a library, 2.1.0 still opens that
  library without an error and can still write to it, but it counts that `gate.updated`, which
  carries the new authorization extras, in `rejectedEventCount` and skips it, so it reads the gate
  as still pending and holding its work back while 2.2.0 reads it satisfied. 2.1.0 reads the
  managed-section and rule records that 2.2.0 writes for a coordination library, an enabled rule as
  enabled, but writes no section into the coordination library's container: there its `rule-list`
  says `outputBindingStatus: "unconfigured"` and its `agents-render` is refused with
  `WORKSPACE_INPUT_INVALID`. A library that 2.2.0 creates records `minEngineVersion` 2.2.0, and
  2.1.0 refuses to open it with `ENGINE_TOO_OLD`. Install 2.2.0 on every device that reads the same
  library, together.
- Rolling back to 2.1.0 is safe only before the first such write.
- A gate run that 2.1.0 recorded still counts toward done: 2.2.0 records and reads runs in the same
  shapes (`einzbern.gate-run.v1`, with `einzbern.gate-tree.v3` roots), and still skips only a run
  whose roots name their paths without content digests, as 2.0.x recorded them.
- A coordination library's managed sections: the first `agents-render` into its registered container
  replaces each marked section whose markers agree with its text and that the library never
  recorded, after AGENTS.md is copied into `backups/<UTC>/managed-sections/` of the device
  directory, and records it; a section changed by hand stays as it is, pending. `settings-set`
  renders nothing, so run `agents-render` after it. The variable sections follow
  `artifact.language`.
- `library-unregister` and `device-clean` only plan by default; they act with `--yes true`, and
  `device-clean` keeps every backup that holds originals.
- Built-in rules: `residue-cleanup` and `goal-writing` are new and off by default.
  `unattended-commands` is at version 2: a project that enabled version 1 reads `update-available`
  and its file is not touched until the rule is enabled again with `rule-enable`, which writes
  version 2.

## 2.1.0

Einzbern and Mana Orchestrate ship in lockstep at 2.1.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Gates and Done

A run made with `--work-id` now takes its tree digest over the content of the Story's own files
(TCRN-CROSS-STORY-534, TCRN-CROSS-SUB-469 and TCRN-CROSS-SUB-470, EPIC-149 R4, MIN-257 D6). It reads
every file that the commits of the Story and its Subtasks touched under a gate root, changed or not,
and records the root with those paths and a content digest for each file, without `HEAD` and without
a change list (`einzbern.gate-tree.v3`). A root that none of those commits touched is recorded with
its `HEAD` and every change, as in a run without `--work-id`, and so is every root when the commits
touched none. So a commit or a file elsewhere in the project, another session's among them, no
longer stales the run, and the Story goes to done without its gates running again. The done check
reads the recorded files again and compares their digests, and compares the files the Story's
commits touch now with the paths the run recorded: a change to one of the Story's files, committed
or not, or a new commit of the Story's that touches another file, refuses done with
`WORK_DONE_GATES_NOT_RUN`, whose details now carry `changedPaths` and `addedPaths`. Putting back the
content the run read brings the run back. A run without `--work-id`, a release run among them,
records the same shape as before.

`gates-run` now hands every gate process `EINZBERN_GATE_RUN_PRIOR` (TCRN-CROSS-STORY-537,
TCRN-CROSS-SUB-487, EPIC-149 R4, MIN-257 D6): canonical JSON with the run id and, in run order, each
gate of the same run that ended before the gate started, with its name, its declared root, the real
directory it ran in, its command, whether it passed, whether its output was cut, and the absolute
path of its output file. The first gate reads an empty list. The engine's value replaces a variable
of the same name in the caller's environment, and it is not written to the run record.

### Work Leases

A Story's transition to done, and every transition and annotation member of a `work-batch`, is now
held to the leases before the gates are judged (TCRN-CROSS-STORY-536, TCRN-CROSS-SUB-471 and
TCRN-CROSS-SUB-472, EPIC-149 R4). While another actor's unexpired lease binds the item,
`work-transition --status done` is refused with `WORK_LEASED` (`holder`, `expiresAt` and
`leasedWorkId` in its details) and no gate is judged; a batch with such a member is refused whole
with `WORK_BATCH_REFUSED`, whose `failed.reasonCode` is `WORK_LEASED`, and nothing is written. A
record that an earlier member of the batch creates is bound by a lease above the parent that member
names. The holder's own transition is judged by the gates as before, and `work-create` stays outside
the lease.

Those lease checks now parse `--at` first, with the strict instant parser the write uses, and judge
no lease when it does not parse (TCRN-CROSS-STORY-536, TCRN-CROSS-SUB-496, EPIC-149 R5). An `--at`
that is not a strict instant is refused by the write with `TIMESTAMP_INVALID`, or answered first by
the gates for a Story going to done, the same way whether the library holds a lease or not; 2.0.3
refused it with `WORK_LEASE_INVALID` in a library that held any lease.

A deleted work item or project no longer leaves its leases behind (TCRN-CROSS-STORY-535,
TCRN-CROSS-SUB-475 and TCRN-CROSS-SUB-476, EPIC-149 R4). `work-delete` removes the item's own lease
in the same append that deletes it, whoever deletes and whether the lease still runs; a refused
delete leaves the lease in place. `project-delete` judges the project's leases at its `--at`: an
expired lease, and a lease on a work item that is deleted or absent (as a delete written by 2.0.3
left it), is removed in the same append, before the project is deleted. A running lease on a live
work item refuses the delete with `WORK_LEASED`, whoever asks, with `workId`, `holder`, `expiresAt`,
`leasedWorkId` and `projectId` in its details, and nothing is written. The CLI entry
`scripts/einzbern.mjs` now prints `projectId` with that refusal (TCRN-CROSS-STORY-535,
TCRN-CROSS-SUB-495, EPIC-149 R5).

### Gate and Rule Proposals

A model can now propose a gate or rule change that Atelier settles, instead of being refused
(TCRN-CROSS-STORY-527, TCRN-CROSS-SUB-477 and TCRN-CROSS-SUB-478, EPIC-149 R4, MIN-257 D6).
`gates-config-propose` proposes a gate declaration or removal, and `rule-propose` a rule's enable or
disable; neither is refused to a model, and both record `--actor` as the proposer. The proposal is
stored in the new closed `proposal` collection, keyed `gate:<name>` or `rule:<id>`, outside the
declarations: a pending proposal is not planned, enabled, rendered or projected into
`config/project.json`, and proposing again replaces it. `proposal-approve` and `proposal-reject`
settle a proposal by `--key` and the `--proposed-at` they read, and run for Atelier only, otherwise
`MODEL_WRITE_REFUSED` with nothing appended. An approval appends, in one append, the configuration
event the direct write appends and the proposal's removal, recorded with `surface: atelier`,
`decidedInLibraryId` naming this library and `decidedIn` in the new form
`proposal:<key>@<proposed-at>`; a rule's approval writes `AGENTS.md` in the `--project` directory,
or in the one this device registered. A rejection keeps the record as rejected.
`PROPOSAL_NOT_FOUND`, `PROPOSAL_NOT_PENDING` and `PROPOSAL_STALE` refuse an approval or rejection
that cannot settle what it read. `gates-config-list` and `rule-list` take
`--status declared|pending|rejected`; `declared`, the default, lists what they listed before.

### Atelier

The gates and rules pages list the page's proposals, pending then rejected, apart from the
declarations, each with a status badge (TCRN-CROSS-STORY-527, TCRN-CROSS-SUB-479, EPIC-149 R4). A
pending row carries Approve and Reject, which run `proposal-approve` or `proposal-reject` as
`TCRN_PORTAL_ACTOR` with the `proposedAt` the row shows; a rejected row is read only. The copy is in
all five locales, and the Atelier wiki page describes the area.

### Concurrency and Device State

The library write lock is now held for the append alone (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-481,
EPIC-149 R4, MIN-257 D6). A write reads the merged state, builds its events and measures the result
outside the lock; under the lock it checks that no device stream moved since that read and appends,
or reads again. The CLI's before-reads, lease pre-checks, gate checks and a Story's done judgement
run outside the lock, and a write receipt names exactly the records its own appends wrote.

A lock wait that runs out is refused with `WORKSPACE_LOCKED`, which now names the holder's
`holderPid`, `holderCommand` and `heldSince` (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-480,
EPIC-149 R4). The lock file records the holder's command as an optional field, so its format stays
`einzbern.file-lock.v1` and older readers ignore it. Every write that takes the library write lock
accepts `--timeout-ms`, the longest it waits for the lock.

Reads of the user crest (list, snippet, body, and so recall) answer from a snapshot, without the
user crest lock (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-482, EPIC-149 R4). A user crest write replaces
this device's snapshot, `cache/user-crest/snapshot.json` in the device directory
(`einzbern.user-crest-snapshot.v1`), under the lock once its event is down. A snapshot that is
missing or behind the crest is rebuilt under the lock when the lock is free; while a writer holds
the lock, a read answers from the snapshot it has, or from a scan, and waits for nothing.

Every prompt in a registered project now leaves one line in `log/hook.ndjson` in the device
directory, written by the engine's recall in the launcher's `einzbern.hook-log.v1` shape, whether it
was answered or not: `HOOK_RECALL_ANSWERED`, `HOOK_RECALL_NO_HITS`, `HOOK_RECALL_PROMPT_EMPTY`,
`HOOK_RECALL_LIBRARY_UNCONFIRMED`, or a failed recall's own code (TCRN-CROSS-STORY-529,
TCRN-CROSS-SUB-483, EPIC-149 R4, MIN-257 D6). The directory is made 0700 and the file 0600; a line
that cannot be written is dropped, and what the hook prints is unchanged.

`gates-run`, the whole test suite (`scripts/task.mjs test`), the portal proof train
(`scripts/verify-portal.mjs`) and release finish (`scripts/release.mjs finish`) now each take a
machine-wide heavy-run slot before they start, so two of them do not run at once on one machine
(TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-484, EPIC-149 R4, MIN-257 D6). A slot is a lock file in the
device directory's `locks/` (`heavy.lock`, then `heavy-2.lock` and on), and
`EINZBERN_HEAVY_LOCK_DIR` names another directory, so that several device directories can share one
set of slots. The new machine setting `execution.maxConcurrentHeavyRuns` (an integer from 1 to 16, 1
by default) sets how many there are. A run that has to wait writes one `HEAVY_SLOT_WAITING` line on
stderr naming the holders, again whenever they change, and waits as long as it takes. The holder
passes `EINZBERN_HEAVY_SLOT` to what it starts, so a gate, test or train it runs takes no slot of
its own; a slot is reclaimed only from a holder on this host whose process is provably dead.
`verify:p1` takes its slot at its entry, before its output session, so its legs inherit it and a
wait no longer reaches a leg's stderr (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-493, EPIC-149 R5).

### Knowledge and Minutes

The conflict guards of knowledge cards and of minutes now split their conflicts by INIT family
(TCRN-CROSS-STORY-531, TCRN-CROSS-SUB-485 and TCRN-CROSS-SUB-486, EPIC-149 R4, MIN-256 D6,
MIN-257 D6). A record's family is the Initiative at the top of the parent chain of the work it
names, directly or through the minutes it links. A card written with neither `--supersedes` nor
`--coexist`, whose conflicts are each of a family apart from the new card's, is written beside them:
the card records them in `coexistsWith`, as `--coexist` would, and the receipt lists them under
`warnings` with `KNOWLEDGE_POSSIBLE_CONFLICT`. A conflict of a shared family, or of no known family
on either side, refuses the write with `KNOWLEDGE_POSSIBLE_CONFLICT` as before, naming those under
`conflicts` and the others under `otherFamilyConflicts`. In the same way, `minutes-record` writes a
record beside the close decisions of another family, adding them to its `declarations.coexists` and
warning with `MINUTES_POSSIBLE_CONFLICT`, and refuses with `MINUTES_POSSIBLE_CONFLICT` only for the
decisions of a shared or unknown family. `--supersedes` and `--coexist` behave as before.

### Release and Repository Tooling

Inside `gates-run --release`, the push gate (`engine:release`) now leaves `verify:p1` out when the
same gate run has already passed every P1 leg (TCRN-CROSS-STORY-537, TCRN-CROSS-SUB-488,
EPIC-149 R4, MIN-252 D3, MIN-257 D6). It reads `EINZBERN_GATE_RUN_PRIOR`, and only when every leg of
`scripts/p1-sequence.mjs` has a gate in that run that is named for the leg, ran in this repository,
ran exactly the leg's package script through pnpm, passed, kept its whole output, printed exactly
one terminal receipt of the leg and printed nothing P1's zero-warning rule rejects, does its receipt
record the `verify:p1` child as `notStarted`, with `coveredBy` naming the run and each leg's gate,
output file and digest, and the assessment `P1_COVERED_BY_GATE_RUN`. Otherwise `verify:p1` runs in
full, and when a run was handed but did not carry every leg, its entry gains `p1Coverage`, saying
which legs fell short and why. Run on its own, the push gate runs `verify:p1` in full as before.

The release policy now says that, from the first release after 2.0.3, a change to a format version
or to the shape of an event raises the minor version and is not released as a patch
(TCRN-CROSS-STORY-537, TCRN-CROSS-SUB-489, EPIC-149 R4, MIN-257 D3). This release is 2.1.0 under
that rule.

The portal's Design System reconciliation and the DS component CSS snapshot generator now read
`Navigation.tsx` from the candidate commit that `portal/ds-consumer-contract.json` binds, in the git
objects of the Design System root, never from that checkout's working tree (TCRN-CROSS-STORY-533,
TCRN-CROSS-SUB-473 and TCRN-CROSS-SUB-474, EPIC-149 R4). An unpublished change in the sibling
checkout no longer turns the portal gate red. When the candidate cannot be read or has no usable
export, the reconciliation records the observation `DS_COMPONENT_CSS_SOURCE_UNRECONCILED` with its
reason (`not-a-repository`, `candidate-absent`, `tree-mismatch`, `export-not-found` or
`export-has-interpolation`), and its verdict still compares only the inline copy with the snapshot;
the generator refuses with `DS_COMPONENT_CSS_SOURCE_UNAVAILABLE` and the reason before it writes
anything, so the snapshot keeps its bytes.

### Upgrading from 2.0.3

- Readers need 2.1.0. Once 2.1.0 writes a gate or rule proposal, or Atelier's approval or rejection
  of one, to a library, 2.0.3 still opens that library without an error, but it counts each of those
  events in `rejectedEventCount` and skips it, so the state it reads no longer matches 2.1.0's: a
  gate that Atelier approved is not declared, an approved rule reads disabled, and
  `configProjection` reads `stale`. A library that 2.1.0 creates records `minEngineVersion` 2.1.0,
  and 2.0.3 refuses to open it with `ENGINE_TOO_OLD`. Install 2.1.0 first on every device that reads
  the same library.
- Rolling back to 2.0.3 is safe only before the first such write.
- A gate run that 2.0.x recorded no longer counts toward done: 2.1.0 skips a run record whose roots
  name their paths without content digests. Run `gates-run --work-id <Story id>` on 2.1.0 once more
  for each Story before it goes to done.
- New device state: the heavy-run slot files (`locks/heavy.lock`, `locks/heavy-2.lock` and on), the
  machine setting `execution.maxConcurrentHeavyRuns` (1 by default), the user crest snapshot
  (`cache/user-crest/snapshot.json`), and `~/.einzbern/log/hook.ndjson`, which gains one line per
  prompt, is never rotated, and can be deleted without losing anything.
- Running the gates on a tree that contains this release no longer needs `TCRN_DESIGN_SYSTEM_ROOT`
  to name a checkout of the bound Design System commit: the portal gate reads that commit from the
  git objects of the Design System checkout beside the engine, whatever its working tree holds.

## 2.0.3

Einzbern and Mana Orchestrate ship in lockstep at 2.0.3. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Gates and Done

A Story reaches done on the gates that apply to it, and a gate no longer has to list the Story in
its `covers` (TCRN-CROSS-STORY-525, TCRN-CROSS-SUB-446 to TCRN-CROSS-SUB-449, EPIC-149 R1, MIN-256).
Every enabled required gate now applies to every Story in the library by default (a release-only
gate only in a release run); so does a gate that the Story's own `gates` field or an ancestor's
names, and a gate whose `covers` names the Story or an ancestor. Initiatives, Epics and Stories take
the new `gates` field through `work-create --gates`, `work-annotate --gates` (`--gates -` removes
it) and a `work-batch` member's `gates`, and the field is inherited downward: a Story is held to the
names of its own field, its Epic's and its Initiative's. `work-show` reports the record's own list
as `fields.gates` and the union as `effectiveGates`; a name the project does not declare is listed
in the plan's `unknownGates` and refused at done with `WORK_DONE_GATES_NOT_COVERED`. `covers`
accepts `work:<id>` of an Initiative or an Epic as well as of a Story, and the gate then applies to
every Story below it. Done is decided by the latest run with a `--work-id` that includes the Story,
on the current tree and the current gate declarations, with every applicable gate green: without
such a run the transition is refused with `WORK_DONE_GATES_NOT_RUN`, a missing applicable result
with `WORK_DONE_GATES_NOT_COVERED`, and a red one with `WORK_DONE_GATES_RED`. `docs/wiki/Gates.md`
describes the criterion and the field.

The tree digest of a gate run is now `einzbern.gate-tree.v2` (TCRN-CROSS-STORY-530,
TCRN-CROSS-SUB-450, EPIC-149 R1). A run with `--work-id` counts only the paths under the gate roots
that the Story's commits touched: the commits reachable from `HEAD` whose message names the key of
the Story or of one of its Subtasks, not followed by a digit. The run lists those paths in
`trees[].paths`, and the done check recomputes the digest over them, so an unrelated untracked file
or another Story's change no longer stales the run, while a later change to one of those paths or a
new commit does.

### Configuration Writes and Owner Decisions

The eight configuration writes refused to a model with `MODEL_WRITE_REFUSED` (`settings-set` and
`settings-remove` of a key that is not model-writable, `variable-set`, `variable-remove`,
`rule-enable`, `rule-disable`, `gates-config-set` and `gates-config-remove`) accept
`--decided-in minutes:<id>#D<n>`, which cites an Owner decision (TCRN-CROSS-STORY-526,
TCRN-CROSS-SUB-451 to TCRN-CROSS-SUB-453 and TCRN-CROSS-SUB-455, EPIC-149 R1, MIN-256). Under the
write lock the engine checks that the minutes are found, in the library or, read only, in the
coordination library its chain identity names; that their `decidedBy` holds `owner:governance`; that
the decision is still in force; and that its text names the target (a setting key, a variable name,
a rule id or a gate name, or a `<prefix>.*` that covers it). The write then goes through and each
event it appends records `decidedIn`, `decidedInLibraryId` and `surface: cli`. A failed check is
refused with `MODEL_WRITE_AUTHORIZATION_INVALID`, carrying `decidedIn`, `target` and `reason`
(`malformed`, `not-found`, `not-owner-decided`, `obsolete` or `target-not-named`), and nothing is
appended. A write run with `EINZBERN_SURFACE=atelier` records `surface: atelier`; a model's write
that cites no decision is still `MODEL_WRITE_REFUSED`. The citation makes a write traceable to a
decision; it does not prove that the Owner took it. `--help` shows the value's shape, and
`docs/wiki/Variables.md` and `docs/wiki/Gates.md` describe the check.

On a refusal, the stderr of the CLI entry `scripts/einzbern.mjs` now carries `decidedIn` and
`reason` (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-466, EPIC-149 R2).

### Work Leases

An actor can lease a work item, so that no other actor changes it while the lease runs
(TCRN-CROSS-STORY-528, TCRN-CROSS-SUB-456 to TCRN-CROSS-SUB-458, EPIC-149 R1, MIN-256).
`work-claim --id <work> --actor <actor> --at <time>` takes the lease for its TTL, `--ttl <n>m` or
`--ttl <n>h` from 1m to 24h and 2h by default; the holder claiming again renews it. The lease holds
the whole family: a claim is refused with `WORK_LEASED` while another actor holds an unexpired lease
on the item, an ancestor or a descendant, and `work-transition`, `work-annotate` and such members of
a `work-batch` are refused with `WORK_LEASED`, naming `holder`, `expiresAt` and `leasedWorkId`, on
the leased item and everything below it when they come from another actor or name none; a refused
batch writes nothing. `work-create` and `work-delete` are not held. `work-release` lets the holder
release a lease at any time and anyone release an expired one; another actor's unexpired lease is
released only by force in Atelier (`--force true` needs `EINZBERN_SURFACE=atelier`, otherwise
`MODEL_WRITE_REFUSED`). A lease is a project-scoped `lease` configuration record keyed by the work
id, and whether it holds is judged on each write's own `--at`, never on a clock. `work-show` and
each `work-list` entry carry the item's own `lease`, `null` when it has none.

### Atelier

Atelier starts only with `TCRN_PORTAL_ACTOR` set (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-454,
EPIC-149 R1). The variable has no default any more: unset or empty, Atelier refuses to start with
one JSON line on stderr whose `reasonCode` is `PORTAL_ACTOR_REQUIRED`, and exit code 2. The
launchers it generates name no actor; they pass the variable on from the environment they run in and
refuse the same way without it. Every write Atelier makes runs the engine with
`EINZBERN_SURFACE=atelier`, so the configuration events it appends record `surface: atelier` beside
that actor.

The work page shows each lease on the leased item's row (an Initiative's or an Epic's on its group
heading) with its holder and expiry, and its release button releases the lease by force as
`TCRN_PORTAL_ACTOR` (TCRN-CROSS-STORY-528, TCRN-CROSS-SUB-459, EPIC-149 R1). Atelier's own writes
are held by another actor's lease like any other, so it releases that lease first.

The Atelier tests, and the release pack test that starts the packed Atelier, now set
`TCRN_PORTAL_ACTOR` to a test value, `agent:test-portal` (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-454,
EPIC-149 R1).

### Mana Orchestrate Skill

The navigation the engine renders into the skill says that several sessions can work in one library
at the same time: the engine queues their writes, so no session has to stop or step aside for
another, and, except for a migration, the user is never asked to stop the other sessions
(TCRN-CROSS-STORY-532, TCRN-CROSS-SUB-460, EPIC-149 R1, MIN-256 D6).

### Release and Repository Tooling

The CI workflow's `verify` job may run for 45 minutes instead of 15, because `Verify P1 offline` and
`Verify portal remediation train` together take longer than 15 minutes (TCRN-CROSS-MIN-254 D6,
INIT-053 R55). The runs for the four pushes to `main` after 2.0.0 were each cancelled at the
15-minute limit before the job finished. The job's steps, their commands and their names are
unchanged, and the `lessons` job keeps its 5 minutes.

### Upgrading from 2.0.2

- Readers need 2.0.3. Once 2.0.3 writes a work lease record, a configuration event that carries
  `surface` or `decidedIn`, or a work item's `gates` field to a library for the first time, 2.0.2
  replaying that library reports `WORKSPACE_EVENT_CORRUPT`. Install 2.0.3 first on every device that
  reads the same library. Any configuration write from Atelier is such a write, because it records
  `surface`.
- Rolling back to 2.0.2 is safe only before the first such write.
- A gate run that 2.0.2 recorded does not match the v2 tree digest, so run
  `gates-run --work-id <Story id>` once more for each Story before it goes to done. Required gates
  now apply to every Story by default.
- Every Atelier launcher must set `TCRN_PORTAL_ACTOR`.

## 2.0.2

Einzbern and Mana Orchestrate ship in lockstep at 2.0.2. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Managed Sections, Rules and Gates

The built-in batch processing v3 text carries the Owner's revision of MIN-246 D11
(TCRN-CROSS-SUB-441, INIT-053 R52). Clause 6 now ends with the merging of small rounds: a round
with at most two implementation packages or one acceptance slice has one main-tier agent do
acceptance and judgment in one pass and write the next round's decomposition file, and a round with
no implementation package, only chain writes or documentation actions, dispatches no decomposition
or acceptance agent. A new clause 9 has evidence read in excerpts: governance agents and the main
thread read only the excerpts, section numbers or line ranges a dispatch names, write tool output to
a file first and read it at most 200 lines at a time, and do not read a file larger than 32 KB
whole. The Chinese text equals the Owner's archived wording; the English of both additions is an
agent's translation that awaits the Owner's correction. The version stays at 3: an enabled rule
still reads `enabled`, an unchanged section takes the revised text at the next `agents-render` with
its section revision raised by one, and a section the user changed keeps its
`user-modified`/`pending` protection.

### Release and Repository Tooling

The repository root no longer has `AGENTS.md` or `CLAUDE.md` (TCRN-CROSS-SUB-442, INIT-053 R52), and
the source archive, which holds what git tracks, no longer carries them. Rules for agents are kept
only in the platform root's `AGENTS.md`; `CONTRIBUTING.md` remains the contributor manual.

The engine no longer reads the acceptance roster or its verdict file from the platform documents
(TCRN-CROSS-SUB-373, TCRN-CROSS-SUB-376, INIT-053 R52; STORY-490 R3, STORY-491 R2). Both files move
to the platform documents' archive, and machine-judged work is decided by the gates a project
declares in its library (`gates-config-list`) and the `gates-run` results that cover it
(TCRN-CROSS-STORY-485). `scripts/platform-doctor.mjs` drops its `acceptanceGateGroups` and
`acceptanceVerdicts` legs, so `platform:doctor` no longer reports `PLATFORM_ACCEPTANCE_ROSTER_*`,
`PLATFORM_ACCEPTANCE_VERDICTS_MISSING`, `PLATFORM_ACCEPTANCE_LANE_UNPROVEN` or
`PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED`; the install manifest's `PLATFORM_ACCEPTANCE_PROBE_*`
codes are unchanged. In `scripts/final-gate-plan.mjs` and `scripts/operational-batch-entry.mjs` the
roster is only an explicit input: the CLI refuses a final plan without `--roster <path>` with
`GATE_PLAN_ROSTER_REQUIRED` (a development plan needs none), executing a plan without a roster path
is refused with `GATE_PLAN_ROSTER_UNAVAILABLE` before any root runs, no roster exception is accepted
where no roster is named, and `batch:formal` takes the roster as `rosterPath` in its request and
answers `BATCH_ROSTER_REQUIRED` without one. The policy rule `STORY-COMPLETION-LINKS` now lands on
that done criterion and is also superseded by TCRN-CROSS-MIN-227. `docs/platform-container-layout.md`
is removed with the layout pipeline and is no longer classified under `platform-layout`;
`tests/fixtures/acceptance-gate-groups.json` stays as the explicit roster the planner tests pass.

## 2.0.1

Einzbern and Mana Orchestrate ship in lockstep at 2.0.1. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

### Cross-Project

A coordination library's Stories can reach done through their gates (TCRN-CROSS-STORY-519, INIT-053
R50; fixes TCRN-CROSS-STORY-485). On a coordination chain, `gates-plan` and `gates-run` with
`--work-id` also plan and run a Story that an enabled gate of the library's own project scope covers
by exact work id: in the project root registered for the library, under that project's declarations,
one plan or run per project, recording the project and the Story ids, so `work-transition` and
`work-batch` read that run at done. These results are listed under a new `library` field beside
`targets`, which keeps its shape; a covered Story gets no `PROJECT_SCOPE_UNDECIDED` or
`COORDINATION_ONLY` result, a selected one still runs per target, and uncovered work answers as
before. `--project-id` may be left out; given, it must name the project of every covered Story, or
the command refuses with `GATES_PROJECT_MISMATCH` before any gate runs. The gate root of a
coordination library's project, for these runs, for plans and runs with `--project-id` and for the
done check, now comes from the library's registry entry even when that entry records no project, as
setup and migration write it, as long as no entry records the project itself; a project chain still
needs an entry for the project, or the root is `GATES_PROJECT_UNKNOWN`. The done criteria and their
refusals are unchanged.

### Atelier

`docs/wiki/Atelier.md` gains a section on starting Atelier: the command, `--library` and `--port`
with `TCRN_PORTAL_LIBRARY` and `TCRN_PORTAL_PORT`, the order in which a library is chosen,
`portal.port` and the default 4319, the listener on 127.0.0.1 only, the writer `TCRN_PORTAL_ACTOR`
(default `agent:portal`; a library without actor attestation records no writer), the page token and
the target each answer names, the `PORTAL_LISTENING` line and how to stop it (TCRN-CROSS-STORY-521,
INIT-053 R50; fixes TCRN-CROSS-STORY-487).

### Migration

A migration binds a project's configuration to the old chain's project its mapping row names,
instead of creating a project of setup's own beside it (TCRN-CROSS-STORY-517, INIT-053 R50; fixes
TCRN-CROSS-STORY-489). A mapping row takes `projectId` (`project:` and 24 hexadecimal digits); a
malformed one, or one on a coordination row, refuses with `SETUP_ANSWER_INVALID` on `projectId`. The
plan gives every partition `projectId` and `projectCandidates`, the old chain's live projects as
`{id, name, externalKey, work}`, and blocks with `SETUP_ANSWER_INVALID`, listing them, when a row's
project is not live in its old chain (or in a library migrated before), or when the `--project`
partition's row has `chainRole` `project`, its old chain holds live projects and the row names none;
a row without `chainRole` may name one and otherwise keeps the former behaviour. The registry entry
records the row's project as `projectId`, and a project chain's identity as `primaryProjectId`,
which an identity migrated without one gets on the next run and an identity naming another stops
with `SETUP_LIBRARY_CONFLICT`; the `--project` partition's language and managed sections go to that
project. Running the migration again with the coordination row and the project's row, now naming its
project, repairs a library an earlier migration gave a second project: the plan and the
`SETUP_APPLIED` receipt carry `migration.projectBinding` (`partition`, `library`, `from`, `to`,
`retirement`), and the former project, when setup created it (external key `SETUP-CONFIG-`) and
nothing but its language and managed-section records is in it, loses them and is deleted once the
binding has moved; otherwise it is kept and `retirement.holds` says why. No CLI verb is added.
`docs/wiki/Migrating-from-TCRN-Workflow.md` and the skill's `references/migrate.md` describe the
field, the candidates, the blockers and the repair.

The Wiki migration page says which libraries record who wrote an event, instead of saying every
record a migration writes is signed `agent:setup` (TCRN-CROSS-STORY-518, INIT-053 R50; fixes
TCRN-CROSS-STORY-489). An event's payload carries `actor` only in a library whose chain enabled
actor attestation (its old chain carries `attestation.actor.enabled`), from that event on: there the
language, managed-section, chain-identity and settings records a migration writes carry
`agent:setup`, Atelier's writes carry `TCRN_PORTAL_ACTOR` (default `agent:portal`) and the CLI's
carry `--actor`; the coordination library migrated from cross-project is one. A library whose old
chain never enabled it, such as TCRN-TMS, records no writer: the chain identity and settings records
setup writes there hold only `operation` and `record`, and Atelier and the CLI take their actor
without writing it into the event; a record that names its operator in its own value, such as a gate
release, still does. `event-list` shows whether a library's event payloads carry `actor`. The engine
is unchanged: it writes no actor before attestation is enabled, has no verb that enables it for an
existing library, and leaves old events' bytes as they are.

### Release and Repository Tooling

The GitHub Release body that `scripts/release.mjs publish-plan` prints and `--execute release`
passes to `gh release create` as `--notes` is a short description of the version and a link to its
page in the Wiki's Release Notes chapter, as the release policy requires (MIN-243 D6), instead of
the version's CHANGELOG section, which for 2.0.0 was longer than GitHub's 125,000-character limit
for a release body (TCRN-CROSS-STORY-520, INIT-053 R50; fixes TCRN-CROSS-STORY-488). The body has
three paragraphs: the first sentence of the release summary, the line
`Release notes, by functional module:` with the address of the Wiki page `Release-Notes-<version>`,
which the script composes from the names module, and the two attachments. When
`docs/wiki/Release-Notes-<version>.md` is missing, empty or not a regular file, the plan refuses
with `RELEASE_WIKI_NOTES_MISSING` before any command is printed or run. The release title, the two
attachments and `docs/releases/<version>.md`, which keeps the CHANGELOG section in full, are
unchanged.

Links between Wiki pages open the pages, and the Atelier page says how to start Atelier
(TCRN-CROSS-STORY-521, INIT-053 R50; fixes TCRN-CROSS-STORY-487). A GitHub Wiki opens a link written
`](Page.md)` as the page's raw Markdown, so `scripts/push-wiki.mjs` now gives the Wiki each Markdown
file with its inline links to the source's top-level pages by page name: `](<page>.md)` and
`](<page>.md#<anchor>)` become `](<page>)` and `](<page>#<anchor>)`. Fenced code blocks, code spans,
images, other links and links to a page the source does not have keep their bytes; `docs/wiki` keeps
its `.md` links for the repository's rendering and the link gate, putting `.md` back gives the
source again, and the receipt counts the rewritten links in `linksRewritten`.

## 2.0.0

Einzbern and Mana Orchestrate ship in lockstep at 2.0.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

Work items record the projects they involve (TCRN-CROSS-INIT-053 R43). `--involved-projects` holds
an explicit `undecided`, `coordination-only` or `selected` state with stable library and project
references; `work-create`, `work-annotate` (with `--expected-revision`), batches, replay, listing
and filtering, `work-show` and recall keep it, and a child's projects are checked against its
parent's declared scope. A library records its chain configuration: its role, the coordination
identity, an optional primary project, an opt-in common default, and its repository and build
bindings. New libraries are format 2; a format 1 library still reads without being rewritten and
refuses the new fields. Fresh setup and project initialisation create or reuse the device's
coordination chain, and restore checks that chain's identity before it writes on the device. A
target resolves through this device's registry against the library's actual identity, and one that
cannot be used says why: unregistered, unavailable, an invalid or tombstoned chain, a missing
project, a duplicate location, unconfigured or conflicting. Settings read for a target follow an
explicit common default; collection tables, runtime settings, gate roots and managed digests are
never inherited. `work-project-context` returns each involved target with the keys whose values
differ between them, and grants no write authority.

Gates plan and run a Cross Project work item per involved target and per registered repository
(TCRN-CROSS-INIT-053 R44). Each run receives its target's effective configuration and its own cache,
and reports the work revision, the target's identity and version, its root and its handoff (models,
design authority, language, repository and build); a target that cannot be used is a refusal of its
own and does not stop the others. On a coordination chain, rules, variables and gates are runtime
records with no prose root: enabling or disabling a rule changes the runtime record without writing
prose, and a managed writer refuses a coordination or library-contained output. Prose writes from
the CLI and from Atelier hold the device registry lock and recheck the registration, the library's
identity and the selection before they write. A registration may record the chain role it was
observed with; older entries stay compatible, and discovery reports a known unavailable project
apart from a valid coordination chain.

Setup, migration and gate handoffs (TCRN-CROSS-INIT-053 R45). Release preparation reads the
framework version from its leaf module, and the command catalog lists its verbs in ascending order.
A second device restores into the coordination chain it finds by identity instead of creating one, a
project installed there later joins the same identity, competing identities refuse with
`PROJECT_CHAIN_INVALID` naming `chain-declare` as the remedy, and uninstalling keeps a coordination
registration while anything refers to it and releases it with the last reference. On a format 1
library `undecided` is stored as the absent field. A migration mapping row may carry `chainRole`
(`coordination` or `project`): plan and apply write each library's chain identity, and a second
coordination row, or a role pointing outside the mapping, refuses with `SETUP_ANSWER_INVALID`.
Output, rule and AGENTS.md consumers and the gate process take each target's own handoff, the object
`work-project-context` gives, and an unresolved gate target is a serialisable refusal of its own.

Atelier (TCRN-CROSS-INIT-053 R43 to R45) edits a work item's involved projects, filters by them and
shows each target's readiness, and sets a project's common default and repository bindings. Its
release package carries the registry lock and device directory modules once, behind a guard. Every
list names a target by one rule: the project's own name, "Unnamed project" only for a project
without one, and the shortest id tails where two read alike, never a full id in a visible label; the
complete identities are in a keyboard-operable disclosure with a copy action. Project readiness
lists, per target, its status, whether it is ready for development, what it still misses and the
settings whose values differ. The work view reads the work list once per refresh by its own read;
the side navigation collapses to a rail with the published control and keeps the choice; and the
shell's type, page width and brand mark follow the published family. Writes bind the selection's
epoch, library and project, and a switch is refused while a target write is in flight.

Projects and targets read whole (TCRN-CROSS-INIT-053 R46). Project records carry their `name` in
`project-list` and in Atelier's library and target lists. `settings-catalog` reads a target whose
common default cannot be resolved: a top-level `commonDefault` gives the reference, its status and
the reason, and every row that would inherit from it reads `source.kind: "common"` with `status:
"unresolved"` and no value; `project-bindings-set` or `project-bindings-remove` repairs the binding,
and target resolution and gates still refuse such a target. `knowledge-list` answers a library that
has no knowledge store yet with `knowledgeStore: "absent"` and no records, and recall reads it as an
empty store. Atelier names the target it served on every API response (`x-portal-served-target`) and
refuses with `PORTAL_CONFIGURATION_TARGET_CHANGED` a read or write sent for a target the selection
has since left; the Rules page, rule switches and rendering use the registration the reader
selected, and refuse as ambiguous where two registrations fit. A migration plan whose `--project` is
the coordination partition refuses at plan time, and setup names the coordination binding in its
plan and receipt.

Atelier (TCRN-CROSS-INIT-053 R46) shows each project's own name in its lists, switcher, rail and top
bar; one chain's project registered for two repositories is told apart by the repositories'
directory names, and the Rules page names the repository it edits. A target whose common default
cannot be read marks the rows it would set "Inherited defaults unavailable", with no value, and
offers to choose another project or stop inheriting; a library without a knowledge store says "No
knowledge yet". A switch clears what belonged to the old target, an answer for a target the page no
longer shows is dropped, and when another tab moves the selection the page says where it went and
offers to switch back or to view it. A child work item's projects stay within its parent's scope,
and a refused save shows the engine's reason code, its own words and how to recover; on a
coordination chain the model tables are read only and say why. Readiness lists each target's value
and source for every setting that differs and shows "Not ready" with the neutral badge, and the work
tree lists each Story's Subtasks with their projects. Every language uses the published UI type
family. The gate, model and variable tables fit a 1024 px desktop without sideways scrolling: the
gate table has three columns, a gate's switches sit in its own cell, and a cover input shows a whole
work id.

A coordination chain keeps its own runtime settings (TCRN-CROSS-INIT-053 R47). On a coordination
chain `settings-catalog` lists ten settings, each with scope and layer `library`: the four library
settings, `artifact.language`, `execution.maxConcurrentSubagents` and the four `quota.*` keys. They
are read and written for the whole library only: a write with `--project-id` is refused, every other
key (`models.*` among them) is still refused, and no involved project or common default reads one.
`setup --mode migrate` lists them for the coordination partition as `coordinationSettings` rows
(`{ key, value, source, action }`): `artifact.language` always (`legacy-declared`, or the catalog
default as `legacy-default`) and the orchestration limits the old chain declares. Each is carried by the
import or written once into the coordination library, signed `agent:setup`, and never into a project
chain. Once the old chains are imported and the project's library records its language, the wizard
asks the prompt hook's recall for that library's newest valid card by its subject: `SETUP_APPLIED`
carries `recallSmoke` (`hit` with `cardId` and `query`, or `no-card`), and a miss stops the apply
with `SETUP_RECALL_SMOKE_MISSED` before the cleanup and the wiring; the same mapping applied again
goes on from there. The offline boundary check passes again with its allowlist unchanged: the
two-tab portal test asks the portal server through the test harness instead of calling `fetch`.

The hook launcher (`engine/hook.mjs`, TCRN-CROSS-INIT-053 R47) now appends one line to
`log/hook.ndjson` in the device directory when a prompt lands in a known container (a library, an
old-layout workspace or an old platform container) that this device's registry does not cover,
naming why with `HOOK_REGISTRY_ABSENT`, `HOOK_PROJECT_UNREGISTERED` or `HOOK_LIBRARY_UNREGISTERED`;
its exit code, stdout and stderr are unchanged, and a note it cannot write is dropped.
`scripts/platform-doctor.mjs`'s hooks leg now also reads the user-level `.claude/settings.json` and
`.codex/hooks.json` of the home it is given (checking only Einzbern's launcher and the old harness's
hooks there), reports a launcher hook whose device directory lacks `engine/current` or
`registry.json` as `PLATFORM_HOOK_ENGINE_NOT_INSTALLED`, listed after any
`PLATFORM_HOOK_TARGET_UNAVAILABLE`, and no longer lets an absent container Claude settings file hide
failures in the other hook files. Its `helperSettingsCoverage` is now red when the engine's settings
catalog or the installed helper payload cannot be read (`PLATFORM_HELPER_SETTINGS_UNREADABLE`,
`PLATFORM_HELPER_PAYLOAD_UNREADABLE`, still with `coverageAsserted: false`).
`scripts/verify-staged-privacy.mjs` accepts an origin naming the helper repository
(`mana-orchestrate`, or its old name) as well as the engine repository; the owner still comes from
origin and no classification is widened. The doctor reference of the helper skill gains "A hook that
answers nothing" (where the hook log is and how to read it), and the wiki FAQ answers how to tell a
hook that answers nothing from one that never ran.

Atelier consumes the design system at `d53f2305` (TCRN-CROSS-INIT-053 R46 and R47): its record
component family, its documentation stories and a static Clipboard bridge that Atelier can use;
Atelier does not use the bridge yet (post-MVP backlog item BL-04).

The release privacy scan reads the formal package by its content (TCRN-CROSS-INIT-053 R48). Both
release privacy scans of `verify:p8` (its artifact scan and the P8 surface of its privacy scan) take
their entries from one builder: the gzip header's text fields, every ustar header, padding and end
block of the inflated archive, and each member's path and body under the reviewed member labels. The
compressed bytes are bound by digest only (the sidecar, the release manifest and the aggregate
surface digest) and are no longer read as text, so a deflate stream that happens to spell an address
is no finding, while an address or a local path in a member, a member path or a gzip text field
still is. A package another reader would unpack to something the scan does not label (reserved gzip
flags, a second gzip member, bytes after the trailer, a CRC or length that does not match, an entry
other than a regular file) is refused with `P8_RELEASE_ARCHIVE_LAYOUT_INVALID`.

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

The built-in batch processing v3 text carries the Owner's fifth round (TCRN-CROSS-INIT-053 R48,
MIN-242 D10): clause 8, knowledge is captured per round (each round's judgment produces
`lessons.json`, and the main thread records each lesson as a card with `knowledge-capture` and reads
it back). The Chinese text equals the Owner's archived wording; the English of clause 8 is an agent's
translation that awaits the Owner's correction. The version stays at 3: an unchanged enabled section
takes the revised text at the next `agents-render` with its section revision raised by one, and a
section the user changed keeps its `user-modified`/`pending` protection.

The root `package.json` drops `pg:schema` and `pg:test`, whose target files were removed with the PostgreSQL backend in TCRN-CROSS-INC-275 (TCRN-CROSS-SUB-357 S2).

Release preparation can now run in two phases around one local release commit per repository
(TCRN-CROSS-SUB-357, the Owner's method of 2026-10-08). `scripts/release.mjs generate` checks
both trees, reads the gate plan, the versions and the CHANGELOG cut before it changes a file, then
writes the versions, the single core version replacement, the CHANGELOG section and
`docs/releases/<version>.md`, builds, renders the READMEs, regenerates the CLI reference only when
it is out of date and renders the helper tree. It records a receipt outside both repositories: every
changed file with its status, size and SHA-256, the gate library and declaration digest, and the
helper's extra files, tracked and untracked, with the tracked ones kept by `--keep-extra` and the
rest to remove. It commits nothing and runs no gate. `scripts/release.mjs finish` refuses unless
each repository is exactly one single-parent commit past the recorded HEAD with the recorded bytes,
the engine commit passes the release commit check, the helper commit removes exactly the listed
files and leaves the kept ones unchanged, and the gate library and declarations are unchanged. It
then moves other versions' release artifacts to `dist/stale-release/` by the P8 rule, runs the
release gates, packs and checks. Both phases report every failed condition together; `prepare`,
`check`, `publish-plan` and `--execute` are unchanged.

`pnpm privacy:staged` labels staged content with its repository path, as `verify:privacy` labels
working-tree files, so the reviewed DS provenance line staged at its own inventory path is
classified and no longer reported, while the same line at another or renamed path, or next to other
private content, remains a finding (TCRN-CROSS-SUB-357 S1).

P8 classifies the compiled public-owner metadata line in a 2.0.0 package only in the three members
that carry it, `atelier/portal.mjs`, `scripts/einzbern-hook.mjs` and `scripts/einzbern.mjs`, each
by its exact label, after a member-by-member review of an isolated 2.0.0 release dry run; another
version, member, line or value remains a finding (TCRN-CROSS-SUB-357 S1). The version checks in the
tests read the current version, so the release commit changes no test.

The built-in Command Spell texts carry the Owner's revision of 2026-10-08 (TCRN-CROSS-INIT-053
R40): batch processing v3 adds clause 7, that "once" counts per round, and silent reporting v1
adds that no report falls between two rounds. The Chinese texts equal the Owner's archived wording;
the English of both additions is an agent's translation that awaits the Owner's correction. The
versions stay at 3 and 1, as for every correction of a text: an enabled rule still reads `enabled`,
an unchanged section takes the revised text at the next `agents-render` with its section revision
raised by one, and a section the user changed keeps its `user-modified`/`pending` protection.

Release preparation requires explicit registered library and project roots and
checks the real release gate selection, execution, saved run and unchanged tree
and declarations (TCRN-CROSS-SUB-357). Empty declarations, missing required roots
and red gates refuse preparation. An approved future release updates the actual
core version with the manifests; build, pack and P8 read that same version, while
schema identifiers remain independent. Release commit checks admit only the
single core version replacement and verified generated README and CLI documents.
Actual release preparation and publishing retain their separate authorization stops.

The work index is now a bounded `tcrn.workspace-index.v3` summary of the complete
project and work collections, with counts and deterministic full-record digests
(TCRN-CROSS-STORY-515 / SUB-429). Its 1 MiB view budget and the real-library
10,000-work-record limit are unchanged. Current stamps cannot hide damaged or
missing cached view files; replay rebuilds them. Snapshot manifests and verification
read declared knowledge body segments at their backend's existing limit, including
segments past 1 MiB, and continue to reject overflow, undeclared large paths and
covered-byte changes. Old-layout compatibility remains read-only.

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

The engine is renamed Einzbern (TCRN-CROSS-MIN-227 D1, D2; TCRN-CROSS-STORY-466). The
helper is Mana Orchestrate, the library directory is `.ether`, events live in `akasha/`,
knowledge in `crest/`, and the per-machine directory is `~/.einzbern`. Every event and
record already written keeps its `tcrn.*` schema string byte for byte and is read as the
legacy namespace; newly written events use `einzbern.*`. Work-item prefixes
(`TCRN-CROSS-*`) and every historical `externalKey` are unchanged. The alias table below
is rendered from `packages/core/src/names.ts` and is the same table as
`docs/wiki/Glossary.md`.

<!-- einzbern:alias-table:start -->
| 旧名 | 新名 | 说明 |
| --- | --- | --- |
| `TCRN Workflow` | `Einzbern` | 产品名 |
| `tcrn-workflow` | `einzbern` | 引擎：仓名、npm 包名与 CLI 命令名 |
| `tcrn-workflow-helper` | `mana-orchestrate` | 助手：仓名与 Skill id |
| `.tcrn-workspace` | `.ether` | 项目生成物目录（库） |
| `.tcrn-workflow/` | `.ether/` | 旧布局的工作区控制目录；新引擎只读打开，不再写入 |
| `events/` | `akasha/` | 事件目录；新布局每台设备一个子目录 |
| `knowledge/` | `crest/` | 知识目录 |
| `~/.tcrn-workflow` | `~/.einzbern` | 设备目录（本机） |
| `TCRN Workflow Portal` | `Atelier` | 门户 |
| `tcrn.*` | `einzbern.*` | schema 命名空间；已写入的 tcrn.* 原样保留为只读旧命名空间，新写入用 einzbern.* |
| `.tcrn-artifacts` | （不改名、不迁移） | 平台档案，归平台层，不随改名迁移 |
<!-- einzbern:alias-table:end -->

The governance layer is trimmed (TCRN-CROSS-MIN-227 D3; TCRN-CROSS-STORY-467). Writes are
serialised by an engine file lock: `--expected-version`, its `head` sentinel and the
`lease-inspect`, `lease-break` and `lease-recovery-break` verbs are gone, and every
workspace write receipt carries the ids it wrote beside `version` and `headEventHash`.
The time-attestation store, `--attest-dir` and the `attestation-enable`,
`attestation-migrate` and `attestation-verify` verbs are gone; a chain that already
carries `attestation.actor.enabled` still replays and still requires an actor.
The authority family is gone too: the `gate-*`, `profile-*` and `context-*` verbs,
`knowledge-candidates`, the operator-pins channel (`--authority-pins`) and the authority
files they read. Gate records already on a chain still replay, and a pending one still
holds its work item back from `done`.
The `dispatch-*` and `telemetry-*` verbs, `scripts/dispatch-adapter.mjs`, the dispatch-telemetry
hook and the local telemetry store are gone: nothing writes or reads telemetry, `work-transition`
no longer takes `--evidence`, and knowledge fitness reports zero observations. A work record
that already carries a telemetry evidence snapshot still replays and is still checked.
The host hook scripts are gone with the inert adapter templates: the stop pact and the
response-style checks (`tools/stop-pact`), `scripts/chain-write-guard.mjs`,
`scripts/ssh-write-observer.mjs` with its channel proof and break-glass allowlist,
`scripts/agents-zero-hook.mjs` and `scripts/knowledge-capture-hook.mjs`, the Claude and Codex
adapter bundles with their install receipts, and this repository's own
`.claude/settings.json` observer fixture. The harness then rendered governed context
injection only (TCRN-CROSS-STORY-477 replaces it, below), and the `knowledge-capture` verb stays.
The guard mutation check and its registry, the verification map with its link and red-leg
checks, the proof-artifact generator, the RC1 candidate manifest and its input policy, and
the source allowlist are gone, with `guard-check`, `verify:map`, `verify:source`,
`generate:proof-artifacts`, `regen:map-digests` and `regen:rc1-inputs`. The source
archive and the P8 source set are the tracked file list, and the push gate runs P1 and P8.
The proof budget (its policy, the `verify:budget` and `report:budget` scripts and the
doctor's `proofBudget` leg), the governance leg (`verify:governance`: licences, lifecycle,
vulnerability snapshot, Git history, with the history and vulnerability policy files) and
coverage conservation with its baseline and waivers are gone. The test leg runs the suite only, and P1 runs twelve legs.
Release trust is the install-tree digest: `einzbern-release-verify --tree <dir> --sha256
<digest>` admits an unpacked release when its digest (sorted files, CRLF text read as LF,
symbolic links refused) equals the stated one. The signed manifest, the external trust root,
the in-toto build statement, the P8 trust leg, the helper trust archive and its install
markers are gone, and the helper copies are accepted as directories.
`verify:p1` runs all twelve legs and reports every red with its reason code (`P1_RED` with
`legs` and `reds`) instead of stopping at the first one.
The portal follows: the gate view, the dispatch configuration surface with its
`/api/execution` route, the telemetry, mode and token statistics and the five-root path
panel are gone. Its writes carry workspace, time and actor only, and it no longer reads
`--attest-dir` or `TCRN_PORTAL_ATTEST_DIR`.

The device directory is `EINZBERN_HOME` when that variable is set, otherwise `~/.einzbern`
(TCRN-CROSS-STORY-469 R3): machine settings live there, and the device file, the library
registry, each library's cache and write lock, backups and engine versions will. Manifest and
settings files are replaced atomically (temporary file, flush, rename); a rename refused with
`EPERM`, `EACCES` or `EBUSY` is retried with backoff before `ATOMIC_WRITE_RENAME_FAILED`.
`einzbern.event.v1` is final (TCRN-CROSS-STORY-468 R3): beside the legacy fields every new
event carries `clock`, one more than the largest clock its device had seen, and `deviceId`,
the 32-hex-digit id of the device that wrote it, both in the hash basis; `tcrn.event.v1`
events are unchanged and read with their sequence as their clock. The device id and its
display name live in `device.json` in the device directory, created on first use; a
reinstall that loses the directory gets a new id. Library streams and their events take
identities derived from the library and device (`einzbern.stream-identity.v1`,
`einzbern.event-identity.v1`), and `validateStreamChain` checks one stream link by link.
A library (`.ether`) has exactly seven root entries: `manifest.json` (library id, format
version, minimum engine version, project hint), `akasha/`, `crest/`, `config/`,
`artifacts/`, a `README.md` that explains every name and carries the alias table, and a
`.gitignore` of `*`, so a library inside a Git working tree never shows in `git status`
(TCRN-CROSS-STORY-469 R1, R6; `packages/core/spec/ether-library-v1.md`).
Each device writes only its own stream, `akasha/<device id>/` (TCRN-CROSS-STORY-468 R2, R3):
NDJSON segments named by eight-digit lowercase hex ordinals and a stream manifest that
records the sequence, head, clock high-water mark and every committed segment with its
length and SHA-256. An append takes this machine's lock of the library, cuts off any tail a
crashed writer left, appends, and commits by replacing the stream manifest atomically;
readers trust only the manifest. A new event's clock is one above the largest clock any
stream manifest on the machine records.
A library is read by merging every device's stream by clock, device id and sequence
(TCRN-CROSS-STORY-468 R3-R5): its version is a vector of stream sequences and its head one
digest over the stream heads. An event that does not apply to the merged state is a rejected
event, listed and skipped; a create whose key another device took first is renamed to the
next free key with an alias, and its stream's later events follow. Each file read times out
with `AKASHA_READ_TIMEOUT` instead of hanging on a sync placeholder (TCRN-CROSS-STORY-470 R4).
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
Configuration has two layers (TCRN-CROSS-STORY-469 R2, R3, AC5; MIN-227 D13;
`specs/settings-catalog-v1.md`). Every settings-catalog key is project-level (`layer:
"project"`): its events travel with the library, and when two devices set one key apart the
later write in merge order wins on every device instead of the second write being a rejected
event (an old-layout workspace keeps the strict revision sequence). The machine settings are
device-level (`layer: "device"`) and stay in the device directory: `settings-set` and
`settings-remove` refuse them with `SETTINGS_KEY_DEVICE_LEVEL` and the remedy
`machine-settings-set`. Each project-level write rewrites `config/project.json`
(`einzbern.project-config.v1`: version vector and merged values), a projection no read
trusts; `status` reports it as `configProjection` (`current`, `stale`, `absent`, `invalid`).
The knowledge store in a library is `crest/` with `store.json`, `metadata/` and `bodies/` only
(TCRN-CROSS-STORY-469 R1, R4; 466 R1; `packages/core/spec/knowledge-core-v1.md`): its index view
is this device's cache, `cache/<library>/crest-views/index.json`, projected again by any read that
finds it missing or out of date rather than read as a partial store, so another device reads the
same store and projects its own. The marker binds the library id and the library head, one digest
over every stream's head. Every crest write (and a whole knowledge batch) runs under this
machine's lock of the library, the lock every chain write takes; the mutation claim stays the
crash journal `knowledge-recover` reads, and two devices' concurrent crest writes are not made
safe against each other.
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
A library's cloud-hosted flag is the user's (TCRN-CROSS-STORY-470 R2, AC5; MIN-227 D19, D21):
`library-register` and `init --project` store `--cloud-hosted` when it is given and otherwise
what the cloud folder table suggests for the library's real path, and both report `realPath`
and `suggestedCloudHosted`. The table (`packages/core/src/cloud-roots.ts`) knows macOS
(`~/Library/CloudStorage/*`, iCloud Drive, `~/OneDrive*`, `~/Dropbox`) and Windows (the
`OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` variables, iCloud Drive and Dropbox under
the profile) and suggests nothing on Linux; a project's default cloud library is
`<cloud root>/Ether/<project name>`. A library given through a symbolic link is created,
registered and opened at its real path instead of being refused.
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
A library this engine may not open is refused when it is opened, before any lock is taken,
the device cache is read or anything is written (TCRN-CROSS-STORY-471 R1, AC1; MIN-227 D22;
`packages/core/src/format-version.ts`): a library or stream manifest whose `formatVersion` is
newer than the newest format this engine reads (1) is `LIBRARY_FORMAT_UNSUPPORTED` with
`required` and `supported`, and a library whose `minEngineVersion` is above this engine's
version is `ENGINE_TOO_OLD` with `required` and `actual`. Versions compare by semantic-version
precedence, pre-releases included. The two fields are read before the rest of the manifest is
judged, so a newer format that changed the manifest's shape is still named as a newer format.
Engine versions live in the device directory (TCRN-CROSS-STORY-471 R2, R3, AC2, AC3; STORY-469
R3; MIN-227 D22, D23; `packages/core/src/engine-home.ts`): `engine/<version>/` holds one whole
engine per version, `engine/current` (`einzbern.engine-current.v1`: `version`, `previous`,
`switchedAt`) names the one in use, and `engine/einzbern.mjs`, the stable entry an installer
copies from `scripts/einzbern-launcher.mjs`, runs the current version's `scripts/einzbern.mjs`
with the same arguments and exit code, so a hook names that file and never a version directory.
`engine-update --from <unpacked tree> --sha256 <install-tree digest> --version <x.y.z> --at`
checks the tree against the digest, copies it to `engine/<version>/` (or reuses the same bytes
already there; other bytes under that version are `ENGINE_VERSION_CONFLICT`), runs it once with
`engine-list` to prove it starts as that version and to learn the library format it reads
(`ENGINE_PROBE_FAILED`, `ENGINE_VERSION_MISMATCH`), and only then rewrites `engine/current`,
keeping the version it replaces as `previous`; it reports every library in this device's
registry the new version would refuse (`ENGINE_TOO_OLD`, `LIBRARY_FORMAT_UNSUPPORTED`).
`engine-rollback --at` makes the previous version current again, so a second rollback undoes the
first (`ENGINE_ROLLBACK_UNAVAILABLE` when there is none or it is no longer installed), and
`engine-list` shows the versions, the pointer and whether the stable entry is in place. A switch
rewrites `engine/current` alone, so `settings.json` and `hooks.json` never change. Fetching a
release is the installer's job; the engine never reaches the network.
`status` reports `multiDevice` (TCRN-CROSS-STORY-471 R4; MIN-227 D22): every device the library
knows (its `akasha/` directories), the engine version its stream manifest records (null for a
device with no committed manifest yet), whether it is this device and whether it is ready, and a
plain hint naming the devices to upgrade first (`先把以下设备升级到 ≥<version> 再写入新格式：…`)
while a device's version is unknown or below the one required: the library's `minEngineVersion`
while the format stays, the writing engine's version for a newer format. A write that raises a
library's format must check the same readiness first and refuse with `LIBRARY_UPGRADE_NOT_READY`
(`packages/core/spec/ether-library-v1.md`); this engine has no such write yet.

An Incident is a Story now (TCRN-CROSS-STORY-472; MIN-227 D6; `packages/core/src/work-relations.ts`):
a new record is an Initiative, Epic, Story or Subtask, and `work-create --kind Incident` or
`Release` (and a batch member of either kind) is refused with `WORK_KIND_RETIRED` and a remedy
(`details.remedy`: open a Story with a fixes relation). Every Incident and Release already on a
chain still replays, reads, transitions and can be the target of a relation; `work-list --kind`
still filters by both. Relations between work records are fields from a closed vocabulary:
parent (the record's parent), blocked-by, implements, supersedes, fixes and decided-in. A record
stores its forward relations only, blocked-by, implements, supersedes and fixes in the
required:false extension `advisory:relations` (each a sorted list of at most 64 work ids) and
decided-in as its `advisory:decided-by` minutes list, and the engine projects the reverse
(blocks, implemented-by, superseded-by, fixed-by, decides) when the record is read; the reverse
is never an event field. `work-create` and `work-annotate` take `--blocked-by`, `--implements`,
`--supersedes`, `--fixes` and `--decided-in` (`--decided-by` is its older name); a write refuses a
target that is not a live work record, the record itself or an unknown relation, and an
annotation replaces each list it names whole (`-` removes one). Replay checks only the shape of a
stored value, so an old chain or a merge naming a record this device has not seen still reads.
`work-show` returns `relations {forward, reverse, missing}` (missing: forward targets the library
no longer holds as live records), `work-list --relation <name>=<id>` filters by a forward or a
reverse name, and a `work-batch` member carries `relations {blockedBy, implements, supersedes,
fixes, decidedIn}`.

A Story is its goal, its acceptance and a free body (TCRN-CROSS-STORY-473; MIN-227 D8;
`packages/core/src/story-fields.ts`): the engine checks that a Story has a goal and an acceptance
and nothing else about its prose. They are the required:false extensions `advisory:goal`,
`advisory:acceptance` and `advisory:body`, written with `work-create` and `work-annotate --goal`,
`--acceptance` and `--body`, or as the `goal`, `acceptance` and `body` of a `work-batch` member. A
Story created with `--scope` alone still works: its goal and acceptance come from the scope's Goal
and Acceptance Criteria blocks, and the other blocks are its body. Every Story already on a chain
keeps its scope byte for byte and is mapped the same way whenever it is read; nothing is migrated.
A Story with no goal or no acceptance is refused with `WORK_STORY_FIELD_REQUIRED` (`details.field`
names which, `details.remedy` how to give it; the shipped entry prints both), on creation and on
an annotation that rewrites its goal, acceptance or scope, while an annotation that touches none
of them (a title, a summary, a relation) stays open to every Story; a batch member without either
fails the shape rule `story-fields-required`. The summary defaults to the first sentence of the
goal, and the rule that an Owner-decided Story needs its deciding minutes before done reads the
goal. The ten-block contract is gone with its reason codes (`WORKSPACE_STORY_SCOPE_REQUIRED`,
`WORKSPACE_STORY_SCOPE_INVALID`, `STORY_SCOPE_PURPOSE_INVALID`,
`STORY_SCOPE_LEGACY_ELEMENT_MISSING`) and `scripts/story-scope-compliance.mjs`; the template floor,
which alone still checks headings, reports `TEMPLATE_SCOPE_*`, and a Story bound to a template is
no longer judged by the template's headings. `work-show` returns `fields {goal, acceptance, body,
source}` (source: `fields`, `scope` or `none`); `work-list` gives each record `fields.source`, and
with `--search` it also matches the three texts and returns each as an excerpt bounded by
`--scope-bytes`, as it does the scope. `work-draft` still prints the ten-block skeleton, now marked
`optional: true` with the note `仅供参考，引擎只校验 goal 与 acceptance` and `requiredFields`, and its
examples include Stories written with fields. The governed-loop tutorial creates its Story with
`--goal` and `--acceptance`.

Minutes replace the conference (TCRN-CROSS-STORY-475; MIN-227 D9, D10; `packages/core/src/minutes.ts`,
`specs/minutes-v1.md`). `minutes-record --project-id --title --summary` with `--decisions <list>`
or `--decisions-file <JSON array of strings>`, `--decided-by`, `--work-ids` and an optional
`--external-key` writes a decision down in one `minutes.recorded` event and answers
`MINUTES_RECORDED` with the minutes `id`, its `externalKey` and the decisions numbered D1 to Dn
(`decisions [{number, text}]`); without a key it takes the next number after the latest one
recorded, and a library's first minutes must name theirs (`MINUTES_EXTERNAL_KEY_REQUIRED`).
`minutes-list` (`--project-id`, `--work-id`, `--limit`, `--offset`) pages every minutes record,
the ones a conference close wrote included (kind `conference-minutes`, titled by their
conference, with no external key), and `minutes-show --id | --external-key` returns one with
`decides`, the work records that name it as decided-in; both read an old-layout workspace too.
`work-create` and `work-annotate --decided-in` name a minutes id. Every conference verb is
retired and answers `CLI_COMMAND_UNKNOWN`: conference-open, conference-append-position,
conference-close (with `--execution-form` and `--distill`), conference-cancel,
conference-list-by-work, conference-minutes-list and conference-position-list, and with them the
settings `execution.independenceFloor` and `conference.positionBudgetBytes`. Every conference
event already on a chain still replays. The governed-loop tutorial and its proof record minutes
and name them with decided-in instead of holding, distilling and promoting a conference.

Each decision is valid or obsolete on its own, and a card that repeats a work record or a valid
decision is refused (TCRN-CROSS-STORY-514 R2 to R5, TCRN-CROSS-SUB-426; MIN-239 D3, D5, D6;
`packages/core/src/minutes.ts`, `packages/core/src/knowledge-duplicates.ts`, `specs/minutes-v1.md`).
A decision's number is `minutes:<id>#D<n>`, the historical minutes' decisions included. A decision
becomes obsolete only in the write that records the minutes saying so: `minutes-record` takes
`--supersedes <decision>=<successor>` (the successor one of the record's own decisions, `D<n>`, or
a valid decision already recorded), `--withdraws <decision>` (obsolete with no successor) and
`--coexists <decision>` (a valid decision close in topic that stays valid beside it), each decision
a number or `<external key>#D<n>`, and the record stores them as its optional `declarations`
field, which its receipt echoes. Obsolete is final: declaring an obsolete decision obsolete again,
or naming one as a successor or to stand beside, is `MINUTES_DECISION_OBSOLETE`; a decision the
library does not hold is `MINUTES_NOT_FOUND`; replay checks every declaration, and of two devices
that superseded one decision apart the record merged second is the rejected event. A decision close
in topic (a weighted cosine of recall's tokens of at least 0.5, sharing three or more) to a valid
decision the declarations leave unsettled is refused with `MINUTES_POSSIBLE_CONFLICT`, naming the
candidates under `conflicts`. `minutes-list` and `minutes-show` give the valid decisions unless
`--status obsolete|all` asks otherwise: a record with no valid decision is left out of the list,
and one with obsolete decisions names their numbers under `withheldDecisions`; in an explicit read
each decision has `status`, and an obsolete one `supersededBy` (the successor's number, text and
status, null when withdrawn) and `declaredIn`, while a valid one lists what it `supersedes`.
`minutes-show --id minutes:<id>#D<n>` (or `--external-key <key>#D<n>`) reads that decision whatever
its state. Recall indexes only valid decisions (a minutes hit's lead keeps the decision's own
number) unless `recall --status` names a decision status, which it reads as `minutes-list` does:
`obsolete` the obsolete decisions alone, each minutes hit carrying its own under
`obsoleteDecisions` with its successor or null, and `all` every decision; `removed`, a card status,
leaves the decisions valid, and the prompt hook takes no status and indexes valid decisions only.
`work-show` and a recall hit answer `obsoleteDecisions [{decision, supersededBy}]` when the
record's decided-in minutes, or a card's referenced minutes or named decisions, hold an obsolete
decision, and the hit's line adds `过时决策 <decision>→<successor>`.
No minutes verb is added. Before a card is written, knowledge-create, knowledge-batch,
knowledge-capture and an article's index card compare it with every live work record and every
valid decision; a card whose words one of them carries for at least half their weight (eight or
more shared) is refused with `KNOWLEDGE_ALREADY_RECORDED`, naming the record under `target` and
where its content belongs under `remedy`, and nothing is written. A record without declarations,
and every read of a library with no obsolete decision, answers exactly as before.

Recall answers by intent, and only on a strong hit (TCRN-CROSS-STORY-474; MIN-227 D5, D7;
`packages/core/src/recall-inputs.ts`). The index holds the Stories and the Incidents on their title,
goal and body, the Initiatives and Epics on their title and goal, every minutes record and the
cards; a Subtask, a Release or a Review is not indexed, and status does not matter. When the best
hit scores below the strong-hit threshold, `recall` answers `RECALL_NO_STRONG_HIT` with no records
and an empty `context`. The threshold is the `retrieval.tau` setting, whose default
`RECALL_STRONG_TAU` is 17: the smallest multiple of 0.25 above the best score sixteen everyday
prompts reach on the recorded cross-project corpus
(`tests/fixtures/retrieval-eval/strong-threshold.json`; `node scripts/retrieval-eval.mjs --calibrate`
recomputes it). bm25 grows
with a library, so a library of a few dozen records answers mostly title matches and named keys at
that value and lowers `retrieval.tau`. English function words leave the query, and a key fragment
that names one record by whole tokens and carries a digit (`STORY-474`) is answered as its key is.
Each record of an answer carries `line` (`[Story done] title · key · id · Epic title ‹ Initiative
title`) and `parentChain`, and the answer carries `context`, those lines cut at whole lines to
`injection.perPromptBytes`, reported as `perPromptBytes`. `--partition` and the `partition` field
are gone with the partition registry; `--host` stays. The retrieval evaluation corpus is
re-recorded read-only from the cross-project chain by `scripts/retrieval-eval-record.mjs`, with
paths, addresses and host names redacted, and the gate holds the unrelated group empty at the
threshold and answered at zero (`RETRIEVAL_EVAL_THRESHOLD_DETACHED` otherwise). The engine package
has no session-level injection entry: its host hooks render no SessionStart or PostToolUse hook.

The strong-hit threshold is counted in words one record carries (TCRN-CROSS-SUB-302, SUB-303;
TCRN-CROSS-STORY-474; MIN-235 D9; `packages/core/src/recall.ts`, `packages/core/src/settings.ts`,
`scripts/retrieval-eval.mjs`). `retrieval.tau` is no longer a raw bm25 score: it counts the bm25
weight of a word exactly one of the library's N indexed records carries, ln((N - 0.5) / 1.5) (at
least 1e-6), and recall compares the ranked scores with the searched library's own floor, tau times
that unit, so one value means the same in a library of four records and in one of six hundred. The
default `RECALL_STRONG_TAU` is 3, replacing the raw default of 17 above: the smallest whole number
above every unrelated prompt of the recorded corpus (2.83 units) and no higher than the lowest
related query of a four-record goal and body library (3.52 units), recorded as
`tests/fixtures/retrieval-eval/small-library.json` beside `strong-threshold.json` (v2). The range
stays 0 to 100, hit scores stay raw bm25, the core recall result also reports that `floor`, and a
named key is answered whatever the threshold. `scripts/retrieval-eval.mjs` calibrates on both
libraries, holds both unrelated groups empty at the default and answered at zero, and fails with
`RETRIEVAL_EVAL_THRESHOLD_FAILED` when no whole number separates the groups.

One hook replaces the harness (TCRN-CROSS-STORY-477; MIN-227 D4, D5; `packages/core/src/host-hooks.ts`,
`packages/core/src/hook-recall.ts`). A host's settings carry one Einzbern hook, on UserPromptSubmit
only: `node "<device directory>/engine/hook.mjs" user-prompt-submit`. The path is absolute and
double-quoted, written with backslashes on Windows, and no shell wraps the line; no argument names
a checkout, a container or a host. `scripts/host-render.mjs --host --scope user|project` renders
it into Claude Code's `settings.json` or Codex's `hooks.json`. Every other tool's hooks and keys
stay. Taken out are every hook of the old harness, the `permissions.deny` rules that fenced the
old directories and the `tcrnWorkflowInert` key. For Codex it turns the hooks feature on and drops
the trust state of a hook that is gone. host-render no longer projects dispatch settings, and
`--workspace`, `--settings`, `--mode`, `--repo-root`, `--hooks-only` and `--backup-dir` are
refused with `HOST_RENDER_ARGUMENT_UNKNOWN`; `--library` still renders writable roots.
The launcher is `scripts/einzbern-hook-launcher.mjs`, installed as `engine/hook.mjs` beside
`engine/einzbern.mjs` (install manifest item `machine.hook-launcher`). It imports nothing from any
engine. It reads the registry and at most one Git config and starts no process. Where no project
is registered it ends with exit 0 and no output, and no library is opened. In a registered
project, or in another clone of it found through its remote, it imports the current version's
`scripts/einzbern-hook.mjs`. That entry confirms the library through the registry and answers with
recall's hit lines as `additionalContext`, cut to `injection.perPromptBytes`. A prompt without a
strong hit gets nothing, and every failure still ends with exit 0.
The old injection chain is gone: `scripts/knowledge-inject-hook.mjs`, `scripts/knowledge-inject.mjs`
and the session ledger `scripts/injection-session.mjs`, with the `~/.tcrn-injection` state it
kept, the placement manifest and their fixtures (TCRN-CROSS-STORY-474 R4). Its query translation
and knowledge judge went with it. The `recall` verb still reports a query's language, and
SessionStart, PostToolUse, PreToolUse, Stop, SubagentStart and SubagentStop carry no hook but the
two pointer hooks of a device that declined the navigation section (TCRN-CROSS-STORY-478, below).
platform-doctor no longer requires the old knowledge hook to name its container root.

The engine writes only its own sections of a project's AGENTS.md and CLAUDE.md
(TCRN-CROSS-STORY-478; MIN-227 D13, D14, D17; `packages/core/src/config-records.ts`,
`packages/core/src/managed-sections.ts`, `packages/core/src/agents-sections.ts`,
`specs/config-records-v1.md`). A section sits between `<!-- einzbern:section id=<id> rev=<n>
digest=<sha256> -->` and `<!-- einzbern:section-end id=<id> -->`, each on a line of its own, and
the library keeps a record of it: project-level configuration records are `config.record.set` and
`config.record.removed` events in the closed collections managed-section, rule, variable and gate,
merged like the settings (the later writer in merge order wins) and projected into
`config/project.json` as `records`, and `status` now judges `configProjection` on them too. A
section is replaced only while the digest in its marker, the one in its record and the one of its
text agree. A section the user changed is left as it is and its record goes pending; a section
whose markers the user removed is not put back; a file whose markers do not parse is refused whole
with `MANAGED_SECTION_MALFORMED` naming the line. CRLF and trailing white space are not changes, a
missing file is created only for a section to write, the original is copied to
`backups/<UTC>/managed-sections/` in the device directory before a rename replaces it, no section
renders an absolute path, and an engine upgrade writes nothing.
`agents-render [--project <dir>] --at` renders the engine's sections into the project this
device's registry resolves from the directory: AGENTS.md's two variable sections and, on a device
whose new device-level key `agents.navigation` is `written`, the navigation section (three lines:
the project is managed by Einzbern, load Mana Orchestrate, recall first); CLAUDE.md's
`claude-import` section (`@AGENTS.md`) only while CLAUDE.md does not import AGENTS.md, so a
CLAUDE.md that does keeps every byte and a project without one gets a CLAUDE.md holding that
section alone. It answers `AGENTS_RENDERED` with each section's `{id, file, result, state}`, the
sections waiting for the user and the backup directory. `rule-resolve --section <id> --action
overwrite|keep|unmanage [--force true] --at` settles a waiting section: overwrite writes the
engine's text back as the new baseline, keep records the user's text as theirs and the engine never
writes that section again, and unmanage takes the markers out and leaves the text. Overwriting a
section the user kept, and taking out a section the user changed, need force
(`MANAGED_SECTION_FORCE_REQUIRED`). A device whose `agents.navigation` is `declined` gets two
pointer hooks beside the prompt hook, on SessionStart and SubagentStart (`node "<device
directory>/engine/hook.mjs" session-start` and `subagent-start`), which answer with the three
navigation lines and read nothing. A refusal prints its `file`, `line` and `section`.

The Mana Orchestrate skill is generated by the engine (TCRN-CROSS-STORY-479; MIN-227 D24, D28;
`packages/core/src/skill-render.ts`, `packages/core/src/skill-copies.ts`). `skill/mana-orchestrate/`
in this repository is the skill's template and keeps no SKILL.md: six install-type wizard
references (install, restore, update, migrate, uninstall and doctor, each loaded only for such a
task and asking one screen of questions that both hosts share) and `agents/openai.yaml` for Codex.
`skill-render --out <dir> [--version <version>]` writes the skill directory into a missing or empty
directory and answers `SKILL_RENDERED` with its files and install-tree digest: SKILL.md rendered for
the version (the engine's own by default), and the template's `references/`, `agents/` and
`scripts/` copied beside it. SKILL.md carries the finalized English description A, the navigation
table (recall to start; work-show and minutes-show for the full text; work-transition and
work-annotate to write the result back; minutes-record for a decision, recorded as soon as it is
judged one and echoed at the end of the reply as `已记 <minutes key> Dn`; knowledge-create for a
lesson; `design.authority` from settings-catalog before UI design), how to run a verb, the
three-step routine and one line pointing to `references/`. A verb the command catalog does not carry
refuses the rendering (`SKILL_NAVIGATION_VERB_UNKNOWN`), and so do a SKILL.md of 6000 bytes or more
(`SKILL_MARKDOWN_TOO_LARGE`) and a version that is not a release version (`SKILL_VERSION_INVALID`);
an `--out` that is not empty is refused with `SKILL_OUT_NOT_EMPTY`, and the verb runs only where the
template sits beside the engine, in its source tree or in a release (`SKILL_SOURCE_MISSING`).
`installSkillCopies` places the skill as `~/.claude/skills/mana-orchestrate` and
`~/.agents/skills/mana-orchestrate`, never under `~/.codex/skills`, and records each copy's
install-tree digest in `skills.json` in the device directory; a copy about to be replaced is moved
whole to `backups/<UTC>/skill-copies/` first, and installing the same tree again changes nothing.
The legacy helper's copies and install markers are listed by `legacySkillCleanupPlan` and moved to
a backup by `applyLegacySkillCleanup`, never deleted.

Knowledge is written once and found at once (TCRN-CROSS-STORY-476; MIN-227 D9, D25;
`packages/core/src/knowledge-core.ts`, `packages/core/src/knowledge-hint.ts`). A card is active and
retrievable the moment it is written: the candidate lifecycle and the promotion step are gone with
`knowledge-promote`, `knowledge-retire`, `retire-proposals` and `retire-sweep`, a card retires only
when a later card names it with `--supersedes`, and a write that names the candidate or retired
lifecycle is refused with `KNOWLEDGE_LIFECYCLE_RETIRED` and its remedy.
`knowledge-create --lifecycle` is optional and takes `active` alone; `knowledge-list --promotion`
and `knowledge-body --allow-unpromoted` are gone. Records written before keep the lifecycle and
promotion state they were written with. `knowledge.aggregateBytes` counts the bodies of live cards only, so a superseded
card gives its body back to the budget, and a refusal for the budget names `bodyBytes` and `limit`.
`--scope user` on `knowledge-create` and `knowledge-capture` files a card in this user's crest
(`crest` in the device directory, or the folder the device-level key `crest.userPath` names), which
every project recalls; `knowledge-capture --scope` also takes `role` (its default) and `workspace`.
`knowledge-list`, `knowledge-snippet` and `knowledge-body` read the user crest with `--scope user`.
`recall` reads both stores and reports each under `knowledgeStores`; a card hit carries `scope`
(`project` or `user`), and a user card's line reads `[卡片 用户]`. Every knowledge verb that writes a
card (create, capture, article-create, article-refresh, reverify and batch) answers `ids` beside
the store `version`: the card written, the card it superseded, and in a batch every member's. A
work record reaching done (`work-transition`, and each done member of `work-batch` under
`knowledgeHints`) and `minutes-record` answer `knowledgeHint`: the line
`是否有可提取的知识；可能冲突的卡：…` and `conflictCandidateIds`, the cards the write-time conflict
scorer finds against the record's title and goal or the minutes' summary, in both stores. A
possible conflict names the cards under `conflicts` on stderr.

Two devices share the user crest through a synced folder without one device's late delivery
stopping the other (TCRN-CROSS-SUB-310; MIN-235 D7; `packages/core/src/knowledge-core.ts`,
`packages/core/src/recall-inputs.ts`). Each device appends immutable events under
`events/<device id>/`, and a same-subject pair two devices wrote before either saw the other is an
unresolved conflict, not a refusal of the whole crest: `knowledge-list --scope user` names such
pairs as `unresolvedConflicts`, its default selection leaves their cards out (`--selection all`,
`knowledge-snippet` and `knowledge-body` still read them), every other card reads, recalls and is
written as before, and a write whose `--supersedes` names either card of a pair resolves it. A
user-crest write records every conflict it was admitted beside in the new card's `coexistsWith`,
with `--coexist` or beside the card it supersedes; a card two devices each replaced is replaced,
and colliding replacements form a pair like any other. `recall` answers `userCrestDegraded` at its
top when the user crest gave fewer cards than it holds: the read's refusal code alone (such as
`KNOWLEDGE_LIMIT_EXCEEDED` for a merge past `knowledge.aggregateBytes`, whose disposition is still
pending), or `KNOWLEDGE_POSSIBLE_CONFLICT` with `unresolvedConflicts` and `withheldCards`; it is
absent otherwise. A user-crest `knowledge-create` whose event is committed answers from its own
scan (`version` is that scan's plus one) and never reads the crest again, so nothing delivered
meanwhile turns it into a refusal. `knowledge-recover --scope user` never writes the crest's
`store.json`: initialization by the first card is the one operation that does.

Two devices that write one external key before either sees the other's no longer stop the user
crest either (TCRN-CROSS-SUB-413; STORY-476 D7; `packages/core/src/knowledge-core.ts`,
`packages/core/src/recall-inputs.ts`). The key's differing records are an unresolved duplicate, not
`KNOWLEDGE_PARTIAL_STATE`: `knowledge-list --scope user` names it at its top as
`unresolvedDuplicates` (`id`, `externalKey` and `versions`, each version's `deviceId`, `sequence`
and `eventHash` with its `updatedAt`, `subject` and `bodySha256`), its default selection and
`recall` leave every version out (`--selection all` lists each), and `knowledge-snippet` and
`knowledge-body` for the id answer every version under `versions` with the same entry at their
top. `recall` names it under `userCrestDegraded` as `unresolvedDuplicates`, with reason code
`KNOWLEDGE_DUPLICATE` when no pair is withheld as well; `withheldCards` counts every withheld card
and version. Every other card reads, recalls and is written as before, and each live version holds
budget. A write whose `--supersedes` names the id resolves it: every version is replaced at once,
leaves the budget and default recall, and stays readable by the id. A write of a key the crest
already holds is still refused as `KNOWLEDGE_DUPLICATE`, the same record delivered twice is one card,
and a forked or altered stream, or one stream holding two different records for one id, is still
refused naming its device. A user-crest write that supersedes a card of the metadata/body layout
reads that card's body as an explicit read does, rather than refusing it as not admitted.

Two devices write one library's crest without sharing a file (TCRN-CROSS-SUB-414; STORY-476 D7;
MIN-235 D7, O3; `packages/core/src/knowledge-core.ts`, `knowledge-batch.ts`, `store-backend.ts`,
`recall-inputs.ts`, `packages/cli/src/index.ts`; `packages/core/spec/knowledge-core-v1.md`). Each
device appends its cards to its own event stream, `crest/events/<device id>/`, and those streams are the authority: an
`einzbern.crest-event.v1` event holds the card's metadata, names its body file (written first), and
records `chain` -- every chain stream's head the write was checked against -- and `replaces`, the digest
of the record of the same card it replaces. `knowledge-reverify`, `knowledge-policy` and
`knowledge-article-refresh` append the card again as a new record; a supersede appends only the new
card, and reads project `supersededBy` over the card it names. `store.json` is written by
`knowledge-init` alone, once and exclusively, bound to the library id and that id's own digest (the
same bytes on every device); no card write, supersede, rebase, recovery, body migration, read or chain
write writes it, and no write takes a mutation claim. The CLI no longer rebases the crest after each
chain write: a library read answers at the chain head it replays (`eventHighWaterDigest` is that head,
`version` counts every event), so a chain write never leaves the crest trailing; `--allow-trailing` is
still taken and changes nothing about a library's answer (it keeps its meaning for an old-layout store);
and `knowledge-rebase` and `knowledge-batch --align-first` re-validate every record against the chain,
write nothing, and answer the same shape. For a library's crest `KNOWLEDGE_HIGH_WATER_MISMATCH` now
means a manifest that does not bind the library, or a record written against chain events this device
does not hold -- a folder that delivered the card first, or a partial restore that left the crest newer
than its chain (WSF-3): `knowledge-list` and a read of the id name those records under `awaitingChain`
and leave their cards out of default selection and recall, and `knowledge-validate`,
`knowledge-checkpoint` and `knowledge-rebase` refuse with details `awaitingChain`. A library's crest
merges its writers as the user crest does: a same-subject pair two devices wrote is
`unresolvedConflicts`, and one key two devices wrote, or one card two devices each wrote again, is
`unresolvedDuplicates`, both named by `knowledge-list` and a read of the id and resolved by
`--supersedes`; a library write now records in `coexistsWith` the conflicts it was admitted beside a
card it supersedes, as it did with `--coexist`. A crash leaves a committed event or a body no event
names, which reads ignore, so nothing needs recovering. The metadata/body layout an engine before event
streams wrote, its bodies in segments or not, stays readable and no new card rewrites it; the claim its
interrupted write left still locks writes until `knowledge-recover`, which completes that write without
writing `store.json`. A new crest is `store.json` alone until its first card; `knowledge-bodies-migrate`
answers zero bodies for a crest of event streams only and refuses an old-layout store; the exported
`StoreBackend` type has no `writeKnowledgeMarker`. This replaces the STORY-469 statement above that two
devices' concurrent crest writes are not made safe against each other. `recall` names the cards a
library's crest withheld at the top of its answer as `projectCrestDegraded`, in the form
`userCrestDegraded` has: reason code `KNOWLEDGE_POSSIBLE_CONFLICT` when an unresolved pair is withheld,
else `KNOWLEDGE_DUPLICATE` when versions of an unresolved duplicate are, else
`KNOWLEDGE_HIGH_WATER_MISMATCH` when records awaiting chain events are all it withheld;
`unresolvedConflicts`, `unresolvedDuplicates` and `awaitingChain` carry what `knowledge-list` names, each
present when it is not empty, and `withheldCards` counts every withheld card and version once. It is
absent when nothing is withheld, and a refused read stays `knowledgeReasonCode`. O-1 is unchanged: a
merge whose live bodies exceed `knowledge.aggregateBytes` is refused whole, and `recall` reports it under
`knowledgeStores.project`.

A project deleted under a live card no longer stops a library's crest (TCRN-CROSS-SUB-414 R16;
STORY-476 D7; `packages/core/src/knowledge-core.ts`, `recall-inputs.ts`;
`packages/core/spec/knowledge-core-v1.md`). `project-delete` refuses only a project that still owns
live work, and a device that deletes a project cannot see a card another device wrote to it before
either received the other's write; every read and write of the crest then refused with
`KNOWLEDGE_LINK_INVALID`, the rebase with `KNOWLEDGE_REBASE_BLOCKED`, and a supersede of the card could
not get past the read. Such a card -- live, its project gone from the chain the read replays -- is now
named at the top of `knowledge-list` and of `knowledge-snippet` and `knowledge-body` for its id as
`unresolvedScopes` (`id`, `deviceId`, `sequence` and `eventHash`, all three null for a record of the
metadata/body layout, and `projectId`, the project that no longer resolves), leaves default selection
and `recall`, and is named under `unresolvedScopes` in `recall`'s `projectCrestDegraded`, whose reason
code is `KNOWLEDGE_LINK_INVALID` when no unresolved pair or duplicate is withheld as well (ahead of
`KNOWLEDGE_HIGH_WATER_MISMATCH`). Every other card reads, recalls and is written as before, and a write
of that card itself is refused naming it. `knowledge-validate` and `knowledge-checkpoint` still refuse
with `KNOWLEDGE_LINK_INVALID` and `knowledge-rebase` with `KNOWLEDGE_REBASE_BLOCKED`, now with details
`unresolvedScopes` and a `remedy` the CLI prints, `knowledge-create --supersedes <id>`, which is admitted:
a superseded record is not live, so nothing names it, the rebase no longer counts it an offender, and
all three answer again. A record whose scope contradicts itself still refuses the read, a forked or
altered stream is still refused naming its device, and pairs, duplicates, `awaitingChain`, dangling work
links, the user crest and O-1 are unchanged. `knowledgeStorePath` and `readKnowledgeStoreMarker` leave
the `packages/core/src/index.ts` barrel: the CLI's rebind after each chain write, which this Subtask
retired, was their last caller in a recorded consumer root, so platform-doctor's `unusedExports` leg
reported them. Both stay exported from `knowledge-core.ts`, the `allowedUnconsumedRationale` of
`scripts/policy/core-export-consumers.json` no longer says the CLI finds the store through
`knowledgeStorePath`, and `tests/platform-doctor.test.mjs` runs that leg on the checkout itself. The
spec no longer lists the retired `conference-close --distill` among the crest's card writes, and
`docs/architecture/backup-restore-runbook.md` adds that a chain write made after a partial restore
leaves the records awaiting chain events waiting for good, until the whole library is restored from one
snapshot.

No budget bounds the sum of a crest's card bodies any more (TCRN-CROSS-SUB-310 R17; MIN-238 D1,
D5; MIN-239 D1; `packages/core/src/knowledge-core.ts`, `settings.ts`;
`packages/core/spec/knowledge-core-v1.md`). Nothing counts the bodies of the library's crest or of
the user crest, so no read, write, `recall`, `knowledge-recover` or merge of two devices' streams is
refused for the bytes they add up to: a merge whose live bodies pass what `knowledge.aggregateBytes`
allowed (131,072 bytes unless set, 1 MiB at most) reads, recalls and takes the next card on every
device, and `recall` no longer reports such a merge as a refused store under `knowledgeStores` or
`userCrestDegraded`. Each card keeps its own limits: a body over 8,192 bytes, a summary over 2,048, a
snippet over 512, metadata over 32,768 or an article over the canonical ceiling is still refused with
`KNOWLEDGE_LIMIT_EXCEEDED` before anything is written. `knowledge.aggregateBytes` is a retired
setting: `settings-catalog` and Atelier's settings page no longer offer it, its label and explanation
leave all five languages, `settings-set` refuses it as `SETTINGS_KEY_UNREGISTERED`, and a value a
chain recorded replays as history and binds nothing. `knowledge-validate` no longer answers
`capacity`, the measure of live card bodies against that limit, and `KNOWLEDGE_LIMITS` has no
`maximumAggregateBytes`. This replaces the statements above that `knowledge.aggregateBytes` counts
the bodies of live cards and that a refusal for the budget names `bodyBytes` and `limit`
(TCRN-CROSS-STORY-476), that a merge past it is refused whole with its disposition pending
(TCRN-CROSS-SUB-310 and O-1, which MIN-238 D1 decided), that each live version of a duplicate holds
budget until it is resolved (TCRN-CROSS-SUB-413), and that O-1 is unchanged (TCRN-CROSS-SUB-414).

No single canonical value bounds a crest's derived index or a list's digest any more
(TCRN-CROSS-SUB-428, TCRN-CROSS-INC-398; `packages/core/src/knowledge-core.ts`;
`packages/core/spec/knowledge-core-v1.md`). With the body total gone, the index view -- every
record's metadata in one canonical value -- was the last bound on a crest: at about 300 cards with
2,000-byte summaries, the write that carried a library's index past the protocol's one-MiB ceiling was
refused with `INPUT_OVERSIZED` after its event was committed, and every read and write of the crest
was refused after it, `--supersedes` included; the user crest took that card and then refused every
read and write. The index's `indexDigest` and a `knowledge-list` page's `resultDigest` are now the
sha256 of the records' canonical list hashed one record at a time -- wherever the list fits one
canonical value, the digest it always was -- so `knowledge-validate`, `knowledge-list`, `recall` and
the knowledge hint, which read the whole crest as one page, answer at any size. This device's view
keeps the whole index in `index.json`, byte for byte as before, while it fits the ceiling and the
record-count limit; past either, `index.json` is a head, `tcrn.knowledge-index-pages.v1` (`count`,
`pages`, `indexDigest`), and the records are in `index-000001.json` onwards
(`tcrn.knowledge-index-page.v1`), each within the ceiling. A read projects a missing, damaged or
out-of-date page again and removes a page the head does not name, and a view that cannot be
projected, at a read or after a write's event is committed, is left for the next read: a committed
write is answered as committed (R14 (d)). `PROTOCOL_LIMITS.maxCanonicalBytes` and each card's limits
are unchanged, and an answer printed whole -- `knowledge-checkpoint`, `knowledge-freshness`,
`knowledge-source-check`, or a page asked for with `--limit` -- is still refused with
`INPUT_OVERSIZED` once it passes the ceiling.

A knowledge card is valid or removed, and removed is terminal (TCRN-CROSS-SUB-425; STORY-514 R1, R3,
R4; MIN-239 D3, D4, D6; `packages/core/src/knowledge-core.ts`, `recall-inputs.ts`, `hook-recall.ts`,
`knowledge-hint.ts`, `packages/cli/src/index.ts`, `portal/`; `packages/core/spec/knowledge-core-v1.md`,
`docs/wiki/Atelier.md`). `knowledge-remove --id --reason superseded|invalid|duplicate --basis --actor
--at` (with `--superseded-by` for `superseded` only, `--scope user` for the user crest) appends a
removal event, `einzbern.crest-removal.v1`, to this device's stream of the crest: the card, the
reason, the basis (at most 2,048 bytes), the actor (an `owner:`, `profile:` or `agent:` id) and the
card that supersedes it or null. It answers `KNOWLEDGE_UNIT_REMOVED` with the card as it is now kept
and `clearedBodies`; no verb restores a card. A card another card supersedes -- `--supersedes`, or the
mark an older engine stored -- is removed too, reason `superseded`, its basis naming the new card and
its actor the new card's accountable owner. Removal events travel with the crest and no event file is
deleted; a removal delivered before its card waits for it, and of two devices' removals of one card
the earliest stands. A removed card keeps its id, external key, subject, `supersedes` and `removal`
(`reason`, `basis`, `actor`, `removedAt`, `supersededBy`, and the event's `deviceId`, `sequence` and
`eventHash`); each device deletes the body files its own stream holds for removed cards at its next
write to that crest, the removing or superseding write included, while the metadata/body layout an
older engine left keeps its bodies until `knowledge-bodies-migrate --clear-removed true` clears them
(see below). `knowledge-list` and `recall` take `--status valid|removed|all`
(`recall` also `obsolete`, a decision status that leaves its cards valid), `valid` when left out and
echoed as `status`: default reads, `--selection all` among them, answer valid cards only, `removed`
the removed cards alone and `all` every card, each removed card as it is kept, and a recall hit on
one reads `[卡片 已移除]` and carries its `removal` as the list gives it. The prompt hook, the
knowledge hint, a checkpoint, `knowledge-freshness` and
`knowledge-source-check` read valid cards only. `knowledge-snippet`, `knowledge-body`,
`knowledge-reverify`, `knowledge-policy`, `knowledge-article-refresh`, a write superseding a removed card
and a second removal are refused with `KNOWLEDGE_CARD_REMOVED` (details `id`, `removal`, `remedy`),
and a removed card's id and key stay taken. A removed card is in no unresolved pair, resolves the
duplicate whose id it is, and is named in no `unresolvedScopes`; the crest's index view holds it as it
is kept, one record per id, and an old-layout store's index is unchanged. Atelier's knowledge list
reads valid cards and offers a card-status filter in all five languages; `/api/knowledge?status=`
answers `removed` and `all`, and refuses another status with `PORTAL_KNOWLEDGE_STATUS_INVALID`. An
engine before this one refuses a crest that holds a removal event, or a record whose body this
engine cleared (a removed or superseded card), since it requires every card's body file
(`KNOWLEDGE_PARTIAL_STATE`). This replaces the statements
above that a card retires only when a later card supersedes it (TCRN-CROSS-STORY-476), that every
version of a duplicate a card supersedes stays readable by the id (TCRN-CROSS-SUB-413), and that reads
project `supersededBy` over the card a supersede names (TCRN-CROSS-SUB-414), and for knowledge cards it
replaces the audit copy MIN-235 D10 kept of a superseded body. `knowledge-core-v1.md` also stops saying
a write lands promotion state `promoted` (a new card carries none) and names, among what the library's
crest withholds, the cards whose project the chain no longer holds with `KNOWLEDGE_LINK_INVALID` and
`unresolvedScopes`.

Gates are declared per project and chosen by the change (TCRN-CROSS-STORY-485; MIN-227 D4;
`packages/core/src/gates-config.ts`, `gates-plan.ts`, `gates-run.ts`, `gates-done.ts`). A gate is a
project-level configuration record of the gate collection, keyed by its name: its command is an
argv run with no shell, its root the directory of the project it runs in, its covers globs over the
paths under that root, and it is required, enabled or release-only.
`gates-config-set --name <name> --command '<JSON argv>'` declares one (`--root`, `--covers`,
`--required`, `--enabled` and `--release-only` default to `.`, `**`, true, true and false for a new
gate, and a gate declared again keeps what the flags leave out); `gates-config-list` lists the
gates and `gates-config-remove` removes one. `gates-plan` names the gates a change needs: every enabled gate
whose covers match a file changed under its root against `--base` (HEAD by default; staged,
unstaged, deleted, renamed and untracked files count), release-only gates left out, or with
`--release true` every enabled gate. `gates-run` takes the same flags and `--at`, runs every
planned gate one after another whatever the ones before it did, records the run in the device
directory's `cache/<library>/gate-runs/` with the digest of the tree it ran on, and answers every
red gate (`reds`, and the required ones as `requiredReds`). Before `work-transition` or
`work-batch` takes a Story to done, this device's latest run on the tree as it is, under the
declarations as they are, decides: a project with no enabled gate is not held back, a red
required gate refuses the transition with `WORK_DONE_GATES_RED` naming every one (`reds`,
`stories` and `runId` on stderr), and no such run refuses it with `WORK_DONE_GATES_NOT_RUN`
(remedy `gates-run`); a transition that passes answers `doneGates`, the run that passed it.
`--project` names the project for `gates-plan`, `gates-run`, `work-transition` and `work-batch`;
left out, it is the project this device's registry holds for the library, and when the gates
need a project and none is registered the verb refuses with `GATES_PROJECT_UNKNOWN`. A
change already committed is planned and run against its fork point with `--base`, since against
HEAD it has nothing to run.

The settings shrink and each model tier names its runner (TCRN-CROSS-STORY-484 R3, R5, AC3, AC4;
MIN-227 D3, D11, D12; MIN-230 D1; MIN-233 D2; `packages/core/src/models-tiers.ts`,
`specs/settings-catalog-v1.md`). `execution.dispatchTiers` is renamed `models.tiers`: per host, each
tier (flagship, main and economy by default; tiers may be added and removed) is
`{runner, model, effort}`, so an economy tier can run on `codex-cli`. A recorded
`execution.dispatchTiers` value reads as `models.tiers`, each row taking its host as its runner,
until a `models.tiers` write supersedes it. The dispatch keys (`execution.dispatchModes`, `dispatchMode`, `dispatchClasses`), the keys of the
switched-off mechanisms (`backup.cadence`, `backup.destination`, the two subagent-plan keys and
`execution.subagentPolicy`) and the keys nothing reads (`driver.capabilityProfile`, `storage.backend`,
`execution.maxDispatchDepth`) retire: `settings-set` refuses them with `SETTINGS_KEY_UNREGISTERED`
and their history replays. `execution.maxConcurrentSubagents` stays (MIN-229 D2), and four quota
keys join the catalog: `quota.fiveHourParallelOffPercent` (75), `quota.fiveHourWaitPercent` (90),
`quota.weeklyParallelOffPercent` (95) and `quota.weeklyWaitPercent` (unset), integers from 1 to 100.
A project has custom variables (TCRN-CROSS-STORY-484 R1, R2, AC1, AC2; `packages/core/src/variables.ts`,
`packages/core/src/variables-sections.ts`). A variable is a record of the library's `variable`
collection: a name (a lowercase letter, then letters, digits, dots, underscores or hyphens, and never
a settings key), a type (`string`, `number` or `boolean`), a value and a description. A value or a
description shaped like a credential (a key prefix such as `sk-`, `AKIA` or `ghp_`, a private-key
header, a JSON web token, a long random-looking token) is refused with `VARIABLE_SECRET_SHAPED`, and
nothing is recorded. AGENTS.md carries two managed sections: `variables-system` renders `models.tiers`
(host, tier, runner, model, effort) and `design.authority` and no other setting, and
`variables-custom` renders every variable; a row that would name an absolute path or a credential is
left out and reported with its reason, and the rest is written.
`variable-list [--workspace]` answers `VARIABLE_LIST_READY` with the variables sorted by name and
what the custom section leaves out (`withheld`, each `{name, reason}`).
`variable-set --at --name --type --value [--description] [--actor]` and
`variable-remove --at --name [--actor]` answer `VARIABLE_WRITE_COMMITTED`
(`einzbern.variable-write-receipt.v1`); a second removal is refused with `CONFIG_RECORD_NOT_FOUND`,
and neither write renders AGENTS.md. Every `settings-catalog` row carries `modelWritable`, false for
every key so far (R4). A model does not change the configuration in passing: `settings-set` and
`settings-remove` on a key that is not `modelWritable`, and `variable-set` and `variable-remove`, are
refused with `MODEL_WRITE_REFUSED` and the remedy `change it in Atelier` unless `EINZBERN_SURFACE`
is `atelier`, as it is when Atelier runs the CLI. The CLI cannot tell who runs it, so this is a soft
barrier. A key the engine refuses whoever asks keeps its own refusal (`SETTINGS_KEY_DEVICE_LEVEL`,
`SETTINGS_KEY_UNREGISTERED`), and reads are never refused.

Every row of `settings-catalog` and `machine-settings-catalog` carries its layout
(TCRN-CROSS-STORY-508 R5; MIN-236 D7; `packages/core/src/settings.ts`,
`packages/core/src/machine-settings.ts`, `specs/settings-catalog-v1.md`): `shape` is `collection` for
`models.category` and `models.tiers`, tables of records that Atelier edits on pages of their own, and
`scalar` for every other key and every device-level key; `group` is one of `general`, `models`, `execution`,
`knowledge`, `retrieval`, `storage` and `atelier` (`SETTING_GROUPS`, in the order the settings page
shows them; a group's name is the text key `settings.group.<id>`, and `models` is the models and
escalation group); `order` is a positive integer, the key's place in its group, unique within the
group across both catalogs, so a group holding keys of both layers has one display order. The
layout says how a key is shown and nothing else: no record carries it, and no key's default,
bounds, validation or `modelWritable` changes. The layout table of `specs/settings-catalog-v1.md`
lists every key's group and order.

A project can switch on Command Spell rules (TCRN-CROSS-STORY-483; MIN-228 D3, MIN-229 D6;
`packages/core/src/rules-catalog.ts`, `packages/core/src/rules.ts`). The engine ships four, each with
a version and a Chinese and an English text: `autonomy` v1, `batch` v2, `unattended-commands` v1 and
`silent-reporting` v1; the English texts of the first three await the Owner's correction. Every rule
is off until it is enabled. `rule-enable --id <rule> [--project <dir>] --at` records the rule in the
library's `rule` collection as `{enabled: true, version}` at the version this engine ships and writes
its text, in the project's `artifact.language` (Chinese for `zh-CN`, English otherwise), into
AGENTS.md as the managed section `rule:<id>`. `rule-disable --id <rule> [--force true] --at` takes the
section out with its markers and records `{enabled: false, version}`; a section the user changed goes
only with `--force true` (`MANAGED_SECTION_FORCE_REQUIRED`). Both answer with the rule's state, what
became of its section and the backup directory (`RULE_ENABLED`, `RULE_DISABLED`).
`rule-list [--project <dir>]` answers `RULE_LIST_READY` with each rule's `{id, version,
recordedVersion, fileVersion, section, state}` and writes nothing. A rule is `disabled`, `enabled`,
`user-modified` (its text is not what the engine wrote, or the user kept it with `rule-resolve
keep`), `removed-from-file` (its markers are gone, and they are not put back), `update-available`
(the engine ships a higher version than the rule was enabled at; the file is left as it is until
`rule-enable` takes the new version) or `pending` (a write was refused over the user's change and
waits for `rule-resolve`). `agents-render` renders the enabled rules' sections with the others and
leaves a rule enabled at another version as the file holds it, and an engine that ships an older
version than the library records refuses to enable the rule (`RULE_VERSION_NEWER`).

Custom variables, Command Spell rules and gates each take an optional order (TCRN-CROSS-STORY-508
R7; MIN-236 D7; `packages/core/src/variables.ts`, `rules.ts`, `gates-config.ts`, `gates-plan.ts`,
`agents-sections.ts`): a positive integer recorded by `variable-set --order`, `rule-enable --order`
and `gates-config-set --order` (`CLI_ARGUMENT_MALFORMED` when it is not one). A record without an
order has no `order` field, and without orders every surface renders and plans as before. The
custom-variables section lists the variables with an order first, by order, then the rest by name;
the order is not a column. Once any rule holds an order, the rule sections of AGENTS.md follow it:
ordered rules first, then the others in catalog order. `rule-enable` and `agents-render` arrange
them across the places rule sections already hold, moving each section whole and no byte around
them; a section the user changed, kept or took over keeps its place. `rule-enable` keeps a recorded
order when `--order` is left out, `rule-disable` keeps it, and `rule-list` shows it.
`gates-plan` and `gates-run` plan, run and list the gates with an order first, by order, then the
rest by name. The order is not part of the gate declarations digest, so a run stays valid when only
orders change, and a changed command, cover or required still invalidates it (STORY-485 D8
unchanged). `variable-set` writes the whole record, so a variable set without `--order` has none;
`gates-config-set` keeps a recorded order when `--order` is left out.

The model categories and the model tiers are two tables of records (TCRN-CROSS-STORY-508 R1, R2, R4,
AC2 to AC4; MIN-236 D5, D6; `packages/core/src/models-category.ts`, `models-tiers.ts`, `settings.ts`,
`specs/settings-catalog-v1.md`). `models.category` joins the catalog, a collection first in the
`models` group: `[{id, name, description, order}]`, ids and orders unique, by default `flagship` (10),
`main` (20) and `economy` (30), each named by its id. `models.tiers` replaces the per-host shape above
with `[{order, category, runner, model, effort, note}]`: an order unique across the table, a category
of `models.category`, and a note of at most 256 characters; the lower the order, the stronger the
record. Both are stored as canonical JSON in ascending order, at most 8192 characters. A per-host
`models.tiers` value and a renamed `execution.dispatchTiers` value read as records without their
events changing: each tier name is a category and each host and tier one record with its runner,
numbered from 10 in steps of 10 category by category (`flagship`, `main`, `economy`, then the other
tier names by name) and within a category the hosts in descending name order, so `claude-code` holds
each default category's largest order. The default table is the old default read that way. While
`models.category` is unset it is the default categories and every other category the tiers name.
`settings-set` and `settings-remove` check each table against the other as it stands: a tier record
naming a category that does not exist is refused with `MODELS_CATEGORY_UNKNOWN`, and a category value
that drops a category records still name with `MODELS_CATEGORY_IN_USE`, `details.references` listing
those records as `models.tiers.<order>`; a repeated order is `MODELS_ORDER_DUPLICATE`, a repeated
category id `MODELS_CATEGORY_DUPLICATE`, and a new write takes the array only
(`SETTINGS_VALUE_INVALID`). Replay checks each value's shape and no reference. A category's base
record, the one a rule naming the category gets, is its record with the largest order whatever its
runner (`baseModelsTier`, which refuses a category without a record with `MODELS_CATEGORY_EMPTY`), and
the knowledge language's economy model is the `economy` base record's model, whichever host asks.
Core exports `MODELS_CATEGORY_SETTING_KEY`, `readModelsCategory`, `baseModelsTier` and the record
types beside `readModelsTiers`. The `variables-system` section renders `models.tiers` by order in the
columns Order, Category, Runner, Model, Effort and Note, and names a withheld record
`models.tiers.<order>`.

A rule's record escalates along the order of `models.tiers` (TCRN-CROSS-STORY-508 R3, R4, AC1, AC5;
MIN-236 D5, D6; `packages/core/src/models-escalation.ts`, `settings.ts`,
`specs/settings-catalog-v1.md`). Three scalars join the catalog in the `models` group, after the two
tables: `models.escalation.enabled` (`true` or `false`, a boolean control, default `true`),
`models.escalation.threshold` (an integer from 1 to 100, default `1`) and `models.escalation.ceiling`
(a category id, default `main`). Like every key, a model does not write them through the CLI
(`MODEL_WRITE_REFUSED`). A `settings-set` of the ceiling naming a category `models.category` does not
hold, and a `settings-remove` of it while the table does not hold `main`, are refused with
`MODELS_CATEGORY_UNKNOWN` (`details.path` `models.escalation.ceiling`); replay checks the name only.
The other way round, a `models.category` write (`settings-set`, or `settings-remove`, which puts the
default table back) that drops the category the ceiling names (its recorded value, or `main` while it
is unset) is refused with `MODELS_CATEGORY_IN_USE`, `details.references` `["models.escalation.ceiling"]`,
and nothing is recorded; tier records that still name a dropped category are named first, and a
ceiling a merge already left without its category does not hold up a category write. Atelier lists
`models.escalation.ceiling` beside the tier records above a refused category table, and a refused
restore of the default table names the ceiling's category the same way.
Core exports `resolveModelsTier`, a pure function of the two tables, the three keys' effective values
(`readModelsEscalation`), the category a rule names and the number of rejections its caller counts: it
starts at the category's base record and, for every `threshold` rejections, escalates to the record
with the next smaller order in the whole table, across categories and runners, no further than the
ceiling category's record with the smallest order; it returns the `record`, the `steps` and
`atCeiling`. A base record at or above the ceiling stays, and with escalation disabled the base record
is the answer. An unknown or empty category or ceiling is `MODELS_CATEGORY_UNKNOWN` or
`MODELS_CATEGORY_EMPTY`, and an escalation value or rejection count of the wrong kind is the new
`MODELS_ESCALATION_INVALID`. The engine keeps no count of rejections and adds no command. There is no
runner filter, so from the default `economy` base record (`claude-code`, 60) the first step is
`codex` (50).

The `variables-system` section of AGENTS.md renders every system setting (TCRN-CROSS-STORY-508 R8,
AC7; MIN-236 D8; `packages/core/src/variables-sections.ts`, `docs/wiki/Variables.md`). R8 adds to what
it rendered rather than replacing it, so `design.authority` stays (MIN-227 D11). `SYSTEM_VARIABLE_KEYS`
is `models.category`, `models.tiers`, the three `models.escalation.*` keys and `design.authority`, and
the section has one subsection each in that order, the three escalation keys sharing one:
`models.category` in the columns Order, Id, Name and Description and `models.tiers` in Order, Category,
Runner, Model, Effort and Note, both in ascending order; `models.escalation` as a Setting and Value
table of the three effective values; and `design.authority`. A line before each table says how to
read it. A category whose name or description would put an absolute path or a credential into the
file keeps its row with those cells `(withheld)` and is reported as `models.category.<id>`, as a tier
record already is as `models.tiers.<order>`; the section still names no absolute path, and it is still
replaced only while its three digests agree.

The engine ships as one release archive that needs nothing but Node.js (TCRN-CROSS-STORY-481;
MIN-227 D23, D28; `scripts/lib/bundle.mjs`, `scripts/pack-release.mjs`,
`skill/mana-orchestrate/scripts/install.mjs`, `packages/core/src/node-floor.ts`).
`pnpm run bundle --entry <file> --out <file>` writes an entry and every module it reaches as one ES
module with no dependency: only `node:` built-ins stay outside the file, a bare specifier is refused
with `BUNDLE_EXTERNAL_DEPENDENCY`, and a file a module reads beside itself through
`new URL("<relative path>", import.meta.url)` is carried inside it. The bundler is the TypeScript
compiler this repository already pins; nothing is added and nothing is fetched.
`pnpm run pack:release [--version <version>] [--out <directory>]` packs the build as
`einzbern-<version>.tar.gz` and its `.sha256` (in `dist/release` by default): one
`einzbern-<version>/` directory holding the CLI and the hook entry as one file each, the two stable
launchers as they are, Atelier as one file beside the static files it serves, the skill rendered for
the version, the READMEs, CHANGELOG.md, LICENSE and NOTICE, and `manifest.json`
(`einzbern.release-manifest.v1`: `version`, `nodeFloor`, `installTreeDigest` and `files`, the digest
taken over the directory without the manifest). Two packs of one tree are the same bytes: the tar
headers carry no time and no owner, and the gzip header names no time and no platform. A
`--version` the built engine does not answer as is refused with `PACK_VERSION_MISMATCH`. The
skill's `scripts/install.mjs` is the fetch step that puts an engine on a device before any engine
is there: `--version <version>` downloads that release, the one network use of the installation,
and `--archive <file>` takes a local archive and fetches nothing. The archive's sha256 must equal
`--sha256` or the one its `.sha256` states (`INSTALL_ARCHIVE_DIGEST_MISMATCH`, and nothing is
written); it is unpacked with `node:` built-ins alone, installed through `engine-update` against the
manifest's install-tree digest, given both launchers as `engine/einzbern.mjs` and `engine/hook.mjs`,
and answered with `INSTALL_ENGINE_READY` and the next step, setup. The engine runs on Node.js 24.0.0
or later (`NODE_FLOOR`, exported by core with `assertNodeFloor` and `meetsNodeFloor`): the CLI
refuses an older Node.js with `ENGINE_NODE_TOO_OLD` and the `required` and `actual` versions before
the rest of the engine loads, and the hook answers nothing there. CI packs the archive, unpacks it
under the runner's temporary directory and runs `commands`, and `status` on a temporary library, from
it with Node.js alone.

The installation wizard is one verb, `setup`, and a device is checked with `doctor`
(TCRN-CROSS-STORY-480; MIN-227 D24; `packages/core/src/setup.ts`, `setup-fresh.ts`,
`setup-restore.ts`, `setup-maintain.ts`, `doctor.ts`).
`setup --mode fresh|restore|update|repair|migrate|uninstall --project <dir> --at <UTC>`
takes the answers `--artifacts`, `--cloud`, `--language` and
`--navigation` and the options `--restore`, `--archive`, `--rollback`, `--managed-sections` and
`--mapping`, each in the modes that use it (`SETUP_OPTION_NOT_APPLICABLE` otherwise). Without
`--yes true` it writes nothing and answers `SETUP_PLAN_READY`: the answers given, the questions
still open with their defaults, every file the apply would write in the order it writes them, the
originals it would back up first and whatever stops the apply. With `--yes true` it applies the
plan and answers `SETUP_APPLIED`: the files written, the backup directory and `selfCheck`, which
holds doctor's eight checks (`checks`) and the hook run once as a host runs it, from the project's
directory with the project's name as the prompt (`prompt`, `exitCode`, `injected`,
`hookReasonCode`). fresh installs the library, the registry entry, both skill copies, the two
launchers, one hook per host, the project's write permissions for a library outside it and the
managed sections, and a second run writes nothing. restore first runs eight checks of the library,
and the first that fails stops it with nothing written and names the check (`check`, which the CLI
entry now passes on): `RESTORE_UNREADABLE` (a placeholder that does not arrive is
`AKASHA_READ_TIMEOUT`), `RESTORE_NOT_A_LIBRARY`, `RESTORE_FORMAT_UNSUPPORTED`,
`RESTORE_STREAM_INVALID` (a broken hash chain or a sync client's conflicted copy),
`RESTORE_PROJECT_MISMATCH`, `RESTORE_REGISTRY_BOUND_ELSEWHERE`, `RESTORE_DEVICE_STREAM` and
`RESTORE_SECTIONS_DIVERGED`; then it registers and wires the project without writing the library's
settings, and `columns` lists those that came back beside this device's own. update installs the
release `--archive` names, the archive with its `.sha256` or the directory it unpacks to, checked in
memory and again by `engine-update`, and `--rollback true` goes back to the previous version; either
lays the skill copies, the launchers and the hooks again from the version now current, writes no
managed section and reports `engineSwitch`. repair runs the steps from the registry on again for
the registered library. uninstall takes the Einzbern hooks out of both hosts, moves both skill
copies and their record into the device directory's backups and removes the registry entry after
copying the registry there; the library is never read or written, and `--managed-sections remove`
takes the section markers out of the project's files and leaves their text. migrate plans the
migration of an installation from before the rename (below).
`doctor [--project <dir>]` answers `DOCTOR_READY` with `ok` and the eight checks
(`engine-version`, `hooks-present`, `skill-copies`, `registry`, `library-format`, `device-stream`,
`managed-sections`, `cloud-flag`), each `{check, ok, reasonCode, detail}` with its causes in
`detail.causes`. The skill's references follow these flags and reason codes.

The installation wizard now says so before it writes this device's library path into a project
host file Git tracks (TCRN-CROSS-STORY-499 R16, TCRN-CROSS-SUB-385; fixes TCRN-CROSS-STORY-478,
TCRN-CROSS-STORY-480; `packages/core/src/setup.ts`, `setup-fresh.ts`, `host-writable-roots.ts`).
When the library sits outside the project, fresh, restore and repair name it in the project's
`.claude/settings.local.json` and `.codex/config.toml`; each of the two that is in Git's index is
listed in the plan's new `warnings` before anything is written, and again in the `warnings` of
`SETUP_APPLIED`, as `{reasonCode, file, message}`: `HOST_WRITABLE_ROOTS_TRACKED_BY_GIT`, the file
relative to the project, and the message `scripts/host-render.mjs` gives for the same file. It is
listed whether or not the run changes the file, since the file names the library either way.
`warnings` is empty when neither file is tracked or the library is inside the project, and a
warning never stops the apply: the wizard still commits, unstages and ignores nothing. The CLI
prints the plan and the receipt as they are; their schema versions, host-render and doctor are
unchanged. The skill's install, update and restore references show the warnings at the final
confirmation. Whether Git tracks a host file is asked of the index alone, before any library
exists (`hostFileTrackedByGit`, exported by its module and not by core's index).

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

The repository's `test` task waits out a process group whose members are still exiting
(TCRN-CROSS-SUB-402, TCRN-CROSS-INC-393; TCRN-CROSS-STORY-493; `scripts/task.mjs`). `kill(-group, 0)`
can answer EPERM for such a group, so the group exit wait asks again after EPERM inside the same
10 s window (1,000 probes 10 ms apart); ESRCH is exit, any other code still fails closed at once
with `TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN` naming that code, an EPERM that lasts the whole window
fails closed the same way naming EPERM, and a group still alive at the end is still
`TEST_CONTROLLER_GROUP_LIVENESS_TIMEOUT`. The wait carries a test seam,
`TCRN_TEST_PROCESS_GROUP_PROBE_CODES`: a comma-separated list of error codes (`E[A-Z0-9]+`) that the
first probes of each wait report instead of probing, the last one repeated when it ends in `*`; a
malformed value fails closed with the new `TEST_CONTROLLER_GROUP_PROBE_INJECTION_INVALID`.

The `effectiveValue` of a `settings-set` or `settings-remove` receipt is the key's `currentValue` in
`settings-catalog` (TCRN-CROSS-STORY-510 R2, TCRN-CROSS-SUB-417; fixes TCRN-CROSS-STORY-508;
`packages/cli/src/index.ts`). The receipt reads it with the arguments `settings-catalog` uses, the
library's segment size for an unset `storage.segmentBytes` included, so the two agree on an unset
`models.category`: the default categories and every other category `models.tiers` names. Removing
`models.category` while a tier record names a category outside the default table now receipts that
category too, where the receipt used to echo the default table. A set key's receipt still carries
its value, and any other unset key's its default. The receipt's fields, what `receiptDigest` is
taken over and the reason codes are unchanged.

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

The platform doctor no longer checks the container `AGENTS.md`, whose layout rendering pipeline is
retired (TCRN-CROSS-STORY-491 R2, TCRN-CROSS-SUB-376; `scripts/platform-doctor.mjs`,
`packages/core/src/install-manifest.ts`). Its output drops the `platformAgents` leg (a non-empty
file with the topology section; `PLATFORM_AGENTS_MISSING`, `PLATFORM_AGENTS_NOT_FILE`,
`PLATFORM_AGENTS_EMPTY`, `PLATFORM_AGENTS_TOPOLOGY_SECTION_MISSING`) and the `platformAgentsHistory`
leg (byte equality with `platform-docs/platform-root-agents.md`; `PLATFORM_AGENTS_UNTRACKED`,
`PLATFORM_AGENTS_HISTORY_DIVERGED`), and `install-manifest` names 17 items: `container.platform-agents`
is neither an item nor a required id, so `installWiring` no longer probes the file. Every other leg
keeps its name, order and reason codes, and a `CLAUDE.md` whose import target is gone is still named
by `bridgeSyntax` (`PLATFORM_BRIDGE_TARGET_UNAVAILABLE`). Gate receipt stores no longer pile up in
TMPDIR (Q12; `scripts/final-gate-plan.mjs`): each receipt authority still makes its
`tcrn-code-owned-gates-*` store with `mkdtemp`, and every receipt in it stays on disk and trusted for
every query its process makes, but the stores a process made are removed when that process exits,
which the tests and `batch:formal` both inherit, so the `storeRoot` a batch reports is gone once the
run ends. A store that cannot be removed is left where it is and never changes the exit code. Receipt
documents, descriptors, trust checks and reason codes are unchanged.

The skill's fetch script and install line name the two repositories at their final addresses, the
engine repository and the helper repository renamed under the existing GitHub account
(TCRN-CROSS-SUB-358, TCRN-CROSS-STORY-488; MIN-238 D4; `skill/mana-orchestrate/scripts/install.mjs`,
`packages/core/src/skill-render.ts`, `docs/readme/`). They replace the placeholders
`einzbern/einzbern` and `einzbern/mana-orchestrate`: `scripts/install.mjs --version` downloads the
release from the engine repository's final address, and the `npx skills add` line of the generated
SKILL.md, of the five Einzbern READMEs and of the five Mana Orchestrate READMEs names the helper
repository's. The five root READMEs are rendered again from their templates. Renaming the two
repositories on GitHub and pointing the local remotes at them remain a stop for the Owner.

A model no longer switches Command Spell rules or declares gates through the CLI
(TCRN-CROSS-STORY-513 R1, TCRN-CROSS-SUB-422; MIN-238 D2, MIN-235 D11; fixes TCRN-CROSS-STORY-483,
TCRN-CROSS-STORY-484 R4, TCRN-CROSS-STORY-485; `packages/cli/src/index.ts`, `portal/portal.mjs`).
`rule-enable`, `rule-disable`, `gates-config-set` and `gates-config-remove` join the writes that are
refused with `MODEL_WRITE_REFUSED` and the remedy `change it in Atelier` unless `EINZBERN_SURFACE` is
`atelier`: the refusal comes once the arguments parse, before the project or the library is read, and
appends no event and writes no file, so a model at work can no longer declare a gate its own Story is
then held to, or loosen or remove the gate that holds it. The refusal's details name the rule by its
id (`rule`) or the gate by its name (`gate`) beside `remedy`, as a setting's name its `key` and a
variable's its `name`; stderr carries `remedy` and the message naming it. Atelier's rule switch now
runs the CLI with `EINZBERN_SURFACE=atelier`, as its setting, variable and gate writes already did, so
rules are enabled, disabled and reordered and gates saved and deleted in Atelier as before. The CLI
cannot tell who runs it, so this remains a convention and not an identity check. `rule-list`,
`rule-resolve`, `agents-render`, `gates-config-list`, `gates-plan` and `gates-run` are not refused,
and the verbs' flags and the command catalog are unchanged.

Atelier's gate page says what a cover is (TCRN-CROSS-STORY-513 R2, TCRN-CROSS-SUB-423; fixes
TCRN-CROSS-STORY-485; `portal/locales.js`, `portal/index.html`). The label of the cover input on the
add form, the heading of the cover column in the gate table, the column's add button and the name of
the remove button beside each cover read, in all five languages, that a cover is a path glob or a
work id, the two forms `gates-config-set --covers` accepts; they used to say that covers were paths.
The page's own text for the label and the heading, shown before a language applies, is the English
copy. The input still takes one cover per line, and the covers the page writes, the gate records and
the reason codes are unchanged.

Atelier's work tab says that it is reading (TCRN-CROSS-STORY-513 R3, TCRN-CROSS-SUB-424; fixes
TCRN-CROSS-STORY-510; `portal/index.html`, `portal/locales.js`). While the work view's read of the
selected library is out, a status line above the work tree reads, in the page's language, that the
work records are being read through the engine (`dashboard.workLoading`, one key in each of the five
languages); it goes when the read returns and the list shows. The work tree keeps its `aria-busy`, the
view still keeps what it showed until a refresh's read returns, a read that failed is still shown in
the work view alone, and no other view waits for the work read. `/api/work`, its pages and its result
are unchanged.

The refusal for a directory this device has not registered names only the ways the refused verb
has (TCRN-CROSS-SUB-427; fixes TCRN-CROSS-STORY-470; `packages/core/src/registry.ts`,
`packages/cli/src/index.ts`). `LIBRARY_NOT_REGISTERED` told every caller to register a library
with `library-register` or to pass `--workspace`, but `agents-render`, `rule-enable`,
`rule-disable`, `rule-list`, `rule-resolve` and `library-resolve` take no `--workspace`, and
passing it to them is refused with `CLI_ARGUMENT_UNKNOWN`. Their refusal now names
`library-register` alone; a verb that takes `--workspace` and leaves it to the registry is still
offered it. The reason code, its `cwd` and `remedy` details and the command catalog are unchanged;
`resolveLibrary` takes the choice as an optional third argument, `{ workspaceFlag }`.

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

A managed-section write whose records cannot be committed no longer leaves the file half changed
(TCRN-CROSS-STORY-489, TCRN-CROSS-SUB-366; `packages/core/src/agents-sections.ts`,
`packages/core/src/managed-sections.ts`, `packages/core/src/rules.ts`,
`packages/core/src/variables-sections.ts`). That covers every entry point that writes AGENTS.md or
CLAUDE.md and then commits the section records: `renderAgentsSections` behind `agents-render` and
setup's render; `resolveAgentsSection` and then `enableRule` behind `rule-resolve`;
`disableAgentsSection` behind setup's disabling of the navigation section; `enableRule` behind
`rule-enable`; `disableRule` behind `rule-disable`; and `writeVariablesSections` behind the section
render that follows `variable-set` and `variable-remove`. When one of them wrote a file and the
commit of the records then failed, the file kept the new text while the library kept the old
records: the next render took a replaced section for the user's change and left it pending, and a
failed `rule-disable` left the rule enabled in the library with its section gone from the file. Each
of them now puts every file it wrote back as it read it, and takes away a file it created, before it
throws the error that stopped it, so the library holds no new event and the files match its
records; a render whose second file cannot be written takes back the first the same way.
`rule-resolve` makes two calls, and each puts back only what it wrote: when the second fails, the
section stays as the first wrote and recorded it. A file changed again since the engine wrote it is
left as it is, the backup the write made stays, and when the records went in all the same (a crash
simulated after the event commit) the files stay as written. `revertManagedWrite` in
`managed-sections.ts` does the putting back, and `putBackUnrecorded` in `agents-sections.ts`, shared
by `rules.ts` and `variables-sections.ts`, reads the library again under the write lock and puts
nothing back once its head has moved. The normal path, the results, the reason codes and the command
catalog are unchanged.

`knowledge-bodies-migrate` keeps every body of a crest whose metadata/body layout is already in
segments, and `--clear-removed true` clears the removed cards' bodies from that layout
(TCRN-CROSS-SUB-425 R18; fixes TCRN-CROSS-STORY-341; TCRN-CROSS-STORY-514 R4;
`packages/core/src/store-backend.ts`, `packages/core/src/knowledge-core.ts`,
`packages/cli/src/index.ts`, `packages/core/spec/knowledge-core-v1.md`,
`skill/mana-orchestrate/references/migrate.md`). The migration rewrote the segments from the body
files alone and removed every segment it had not written, so on a layout already in segments -- the
crest a library import carries over -- it found no body file, answered `before` 0 and `after` 0, left
an empty manifest, and every read of the crest then refused with `KNOWLEDGE_PARTIAL_STATE`; on a layout
partly in segments it kept only the bodies its leftover files held. It now writes the bodies of the
segments again beside the ones the body files add, refuses a body file whose segment holds a different
body before it writes, and writes nothing when no body file is left to move; `before` and `after`
count the bodies the layout holds before and after the run, and `bodyBytes` is their size after it. A
layout that still holds one body file per card migrates as before. With
`--clear-removed true --at <UTC>` the run also clears from that layout, which no device's writes
clear, the bodies of the removed cards -- superseded ones, by this engine or by the mark an older one
stored, and ones a removal event names. It runs only on a device whose writes are the library's only ones, chain and crest streams
alike, and otherwise refuses with the new reason code `KNOWLEDGE_SOLE_WRITER_REQUIRED` (details
`deviceId` and `writers`); it copies the layout's `bodies/` into `backups/<UTC>/crest-bodies/<library>/`
of the device directory first (a backup of the same second refuses with `KNOWLEDGE_ALREADY_EXISTS`),
keeps every other body byte for byte with the manifest and the point indexes, answers `clearedBodies`
and `backupDir`, and a second run changes nothing. A read of a library's crest admits a missing body in
that layout for a removed card's record alone. The migration reference runs the clearing once after
the import and once more after each later removal of carried cards. Metadata, event files, the streams' bodies and an
old-layout workspace's read-only store are not touched, and no verb is added.

The "A decision is made" line of the generated `SKILL.md` now says how a record replaces, withdraws
or stands beside a recorded decision (`minutes:<id>#D<n>`): it declares it in the same record with
`--supersedes <decision>=D<n>`, `--withdraws <decision>` or `--coexists <decision>`
(TCRN-CROSS-SUB-427 R18; `packages/core/src/skill-render.ts`).

The restore and doctor references now explain that managed-section details identify sections as
`<file>#<section id>` and `rule-resolve --section` takes only the section id; both references ship
with the skill (TCRN-CROSS-SUB-427 R20).

## 1.2.1 — patch candidate

This patch release makes write-time conflict detection and `--supersedes` the
only way knowledge retires (Owner ruling TCRN-CROSS-MIN-225,
TCRN-CROSS-STORY-465): the hooks and the batch entry stop writing observation
boundary rows, seal receipts, collector self-checks and day summaries, and
`telemetry-observation` refuses (TCRN-CROSS-SUB-257); `retire-sweep` retires
nothing and writes nothing, fitness is a read-only statistic, and
`fitness.windowDays` and `fitness.minEvents` are retired settings
(TCRN-CROSS-SUB-258); the portal's evolution panel lists conflict retirements
only (TCRN-CROSS-SUB-259); and replay reads the removal of a retired setting
as history while a replay snapshot no longer seeds a retired key, so the
snapshot-seeded read and a replay from genesis hold the same state
(TCRN-CROSS-INC-389, TCRN-CROSS-SUB-261). The command catalog is unchanged
from 1.2.0. `hardRatio` rises from 2.5354 to the measured 2.5521 with two
recorded exceptions and `coreSourceLineCap` falls from 24683 to the measured
23956 under Owner ruling minutes:1e37408180449980244bdf7b D1. The upgrade note
(upgrade both hosts together, and when to run `snapshot-replay-rebuild` and
then `recover`) and the known limitations are in `docs/releases/1.2.1.md`.
The immutable 1.2.0 Engine and 1.0.6 Helper publications remain unchanged;
the paired 1.2.1/1.0.7 release is published only after exact-commit CI and
independent asset verification.

The hooks and the batch entry no longer write observation boundary rows,
per-channel or four-channel seal receipts, `collector-self-check` records or
`telemetry/summaries/<day>.json`, and SessionStart no longer runs the
retirement sweep (TCRN-CROSS-MIN-225 D3, TCRN-CROSS-SUB-257). A caller that
still passes `--observation-boundary` to `knowledge-inject.mjs` is answered
`TELEMETRY_BOUNDARY_RETIRED`, and a legacy `selfCheck` call to the batch
verify emitter is answered `TELEMETRY_SELF_CHECK_RETIRED`; neither writes
anything. `telemetry-observation` keeps its catalog entry unchanged from
1.2.0, validates its arguments, and then refuses with
`TELEMETRY_OBSERVATION_RETIRED` without reading the workspace or telemetry.
The four channel events keep their payloads. Records already written,
including the boundary rows, receipts and self-checks an installed 1.2.0 hook
keeps writing until both hosts are upgraded, stay readable through
`telemetry-list` and `telemetry-stats`.

Knowledge retires only through write-time conflict detection and
`--supersedes` (TCRN-CROSS-MIN-225 D1, TCRN-CROSS-SUB-258). `retire-sweep`
retires nothing for any instant, window or telemetry and writes nothing, the
marker's `lastSweepAt` included: it answers
`KNOWLEDGE_RETIRE_SWEEP_CONFLICT_ONLY` under
`tcrn.knowledge-retire-sweep.v2`. Fitness is a read-only statistic,
`tcrn.knowledge-fitness.v2`: per artifact it counts every readable telemetry
record up to `--at`, with no window, eligibility or proposal, and
`retire-proposals` returns those counts with the retired cards and their
historical retirement records, while `proposals` and `ruleDiffs` stay empty.
`--window-days` and `--min-events` remain in the catalog, are still
validated, are listed back under `retiredInputs`, and have no effect.
`fitness.windowDays` and `fitness.minEvents` are retired settings: a new
write is refused with `SETTINGS_KEY_UNREGISTERED`, and recorded values replay
as history. The core observation-day readers (receipt validation, the
collector self-check table, per-channel day verdicts, observation windows and
`telemetry/summaries`) are removed; the `tcrn.knowledge-retirement.v1`
metadata record and `lastSweepAt` stay readable as historical formats.
`maximumAgeDays` still only marks a card stale, and a full store still
refuses the next write rather than evicting anything. `hardRatio` rises from
2.5354 to the measured 2.5481 with one recorded exception and
`coreSourceLineCap` falls from 24683 to the measured 23943 under Owner ruling
minutes:1e37408180449980244bdf7b D1.

The portal's evolution panel lists conflict retirements only: the cards a
`--supersedes` write replaced, each with its replacement and time, newest
first, read from `knowledge-list` page by page; its fourth stat counts them.
The window, last-sweep, proposal and pending-retirement lines are gone, and
neither the evolution nor the knowledge view calls `retire-proposals` any
more (TCRN-CROSS-MIN-225 D3, TCRN-CROSS-SUB-259).

Replay reads the removal of a retired setting as history, and a replay
snapshot no longer carries a retired key into the current settings
(TCRN-CROSS-INC-389, TCRN-CROSS-SUB-261). A `settings.removed` event for a
key on the retired list keeps its envelope checks (exact fields, field types,
a strict and event-bound timestamp) and neither consults nor changes the
current settings, like the `settings.updated` records for that key, so a
chain that set and then removed `fitness.windowDays` or `fitness.minEvents`
under 1.1.0 to 1.2.0 reads again; removing a live key that was never set is
still `WORKSPACE_EVENT_CORRUPT`. A replay snapshot is still verified exactly
as stored, and only its seed drops retired keys, so the snapshot-seeded read
and a replay from genesis hold the same state. Upgrade note: a workspace
whose newest replay snapshot was taken while a now-retired key
(`execution.personalessDispatch`, `model.economyTier`, `fitness.windowDays`
or `fitness.minEvents`) was still live, or that recorded such a key while it
was live and also holds another setting, conference, gate or template
record, may first answer `WORKSPACE_VIEW_STALE` from `validate` and the read
verbs that check the views after the upgrade. Upgrade every engine copy that
reads the workspace together, then run `snapshot-replay-rebuild` and after it
`recover` with 1.2.1. `hardRatio` rises from 2.5481 to the measured 2.5521
(proofLines from 72243 to 72390, productLines from 28352 to 28365) with one
recorded exception and `coreSourceLineCap` rises from 23943 to the measured
23956 under Owner ruling minutes:1e37408180449980244bdf7b D1.

## 1.2.0 — minor candidate

This release seals and reads the observation evidence behind automatic
knowledge retirement one channel at a time (TCRN-CROSS-EPIC-138): a
`collector-self-check` record class written by each channel's own write path,
one v2 receipt per channel beside the unchanged four-channel v1 receipt, the
read-only `telemetry-observation` verb, fitness windows counted in
relevant-channel observation days with `windows`, `refusals`, `idleDays` and
`unprovenDays` and `KNOWLEDGE_RETIRE_SWEEP_REFUSED` on a short window, per-day
fitness summaries under `telemetry/summaries/<day>.json`, and one open
observation interval per session (`TELEMETRY_BOUNDARY_ALREADY_OPEN`,
TCRN-CROSS-STORY-464). It also bounds snapshot-less chain replay by the
20,000-event `maxChainEvents` and writes the replay snapshot when an append
crosses an interval multiple (TCRN-CROSS-STORY-451); writes the attestation
lock as a `tcrn.attestation-lock.v2` line whose start time `ps` reads under
`LC_ALL=C` and `TZ=UTC`, takes stale locks over safely, and reports lock
state and uncovered single writes in `attestation-verify`
(TCRN-CROSS-STORY-457, TCRN-CROSS-STORY-458, TCRN-CROSS-INC-382); lets the
SSH write observer read its runtime configuration from the container
settings env (TCRN-CROSS-STORY-456); gives judge telemetry `cliSource` and a
bounded, redacted `failureDetail` and runs the host's own Claude CLI
(TCRN-CROSS-STORY-459, TCRN-CROSS-INC-387); repairs the `batch:formal` entry
(TCRN-CROSS-STORY-460, TCRN-CROSS-INC-383, TCRN-CROSS-INC-384); moves
stale-version source archives aside in `verify:p8`, keeps portal tests off
the real machine settings and documents the checks a release run makes
(TCRN-CROSS-STORY-461, TCRN-CROSS-INC-386); adds a responsibility-classified
proof count beside the raw ratio (TCRN-CROSS-STORY-462); and pins the INC-155
coverage evidence to integrity relations (TCRN-CROSS-STORY-463). The 1.1.3
known limitations on stale and empty attestation locks and on the
10,000-event replay bound are resolved. `hardRatio` rises from 2.5324 to the
measured 2.5354 with three recorded exceptions and `coreSourceLineCap` from
24126 to the measured 24683 under Owner ruling OQ-EV1-1. The upgrade note
(upgrade both hosts together) and the known limitations are in
`docs/releases/1.2.0.md`. The immutable 1.1.3 Engine and 1.0.5 Helper
publications remain unchanged; the paired 1.2.0/1.0.6 release is published
only after exact-commit CI and independent asset verification.

The offline vulnerability policy snapshot was refreshed on 2026-09-23 after a
real advisory check of the complete frozen dependency graph (25 packages, 4
direct and 21 transitive): the repository's Dependabot alerts (8, all fixed,
none open), `pnpm audit`, and the GitHub advisory database queried per exact
package version found no known vulnerability, so `knownVulnerabilities` is
unchanged and `fast-uri` stays at the patched 3.1.6 (TCRN-CROSS-STORY-450).
`evaluateVulnerabilityPolicyFreshness` counts whole UTC days and fails closed
once the age exceeds `maxAgeDays` (30): the governance check shows the
seven-day `VULNERABILITY_POLICY_EXPIRING` notice from 2026-10-16T00:00:00Z and
reports `VULNERABILITY_POLICY_STALE` from 2026-10-24T00:00:00Z, the 31st UTC
day after the check, unless the snapshot is refreshed again before then.

`retire-proposals` keeps `missingDays` and `invalidDays` only as compatibility
names: since TCRN-CROSS-STORY-454 they list the card window's idle days (no
channel activity, which neither count toward the observation window nor break
it) and its unproven days, as `<day>.ndjson` names, not the days the window is
missing. How many observation days a window lacks is
`windows.<class>.missingObservationDays`; the portal's evolution panel now shows
that number for the card window and lists the idle and unproven days beside it
(TCRN-CROSS-INC-381).

The observation collector follows two more rules, with the seal and its reading
unchanged (TCRN-CROSS-INC-385): a session's open start that is older than the
session's latest stop on the channel no longer counts as an open interval, so a
Stop resumes from that stop instead of alternating with gap resumes, and a UTC
day already sealed for a channel receives no further boundary row, so a resumed
start keeps the last stop's instant but goes into the first unsealed day after
it; known limitation: a cross-day SessionStart made before the previous day is
sealed and never followed by a Stop still leaves that session's rows for the
previous day unpaired, and the day then seals only if other sessions cover it.

The two core readers of an observation day, `readObservationDayVerdicts` (behind
`telemetry-observation` and the fitness summary a seal writes) and
`readObservationWindows` (behind the fitness window and `retire-proposals`), now
read the day files in date order, from four days before the day to three after
(TCRN-CROSS-INC-388). They used to read the day's own file first and only one
day back, so a session group whose covering start lay in an earlier file was
read after its stops and voided: a day the collector sealed across midnight, or
after a session resumed past sealed days, read as unproven.
`telemetry-observation` and the seal-time summary now agree with the receipts
the collector writes; the rules that judge the rows are unchanged.

## 1.1.3 — patch candidate

This append-only patch repairs the time-attestation store after the
cross-project chain crossed its 1 MiB canonical limit (TCRN-CROSS-INC-378,
with its proof follow-ups TCRN-CROSS-INC-379 and TCRN-CROSS-INC-380): the
store digest is streamed, segments roll at 1 MiB or 8,192 records, each
read-modify-write holds a directory lock, and writes that carry
`--attest-dir` check the store before the lease. The read-only
`attestation-verify` verb and the `attestation-migrate` `--mode repair` and
`--mode restore` modes check and repair a store without hand edits. Managed
hooks now propagate the governed platform root, including the three Codex
handlers that derived it from their install location. `coreSourceLineCap`
rises from 23815 to the measured 24126. Known limitations (stale and empty
attestation locks, and the 10,000-event `validateEventChain` bound on
snapshot-less replay) are listed in `docs/releases/1.1.3.md`. The immutable
1.1.2 Engine and 1.0.4 Helper publications remain unchanged; the paired
1.1.3/1.0.5 release is published only after exact-commit CI and independent
asset verification.

## 1.1.2 — patch candidate

This append-only patch closes the optional-article Helper freshness grammar and
corrects platform-doctor host-render comparison to use the managed Engine
checkout declared by `machine.workflow-engine`. The immutable 1.1.1 Engine and
1.0.3 Helper publications remain unchanged; the paired 1.1.2/1.0.4 release is
published only after exact-commit CI and independent asset verification.

## 1.1.1 — patch candidate

This append-only patch repairs same-process stale output-session recovery by
serialising recovery per canonical repository while preserving the durable
inter-process claim protocol. It also corrects the install-surface contract in
the next Helper release: canonical Codex and Claude Code copies are the only
required live placements, and the legacy Codex location is reported as orphan
history. Immutable v1.1.0 and v1.0.2 publications remain unchanged.

## 1.1.0 — unpublished candidate

This candidate carries the complete unpublished capability delta since 1.0.1,
including segmented local storage, dispatch settings and host projection,
knowledge and recall surfaces, telemetry, review evidence, and portal
capabilities. It also carries the approved INIT-051 repair set: explicit host
identity injection, paired telemetry coverage for resumed sessions, trusted
companion verification before test-root execution, and the portal vocabulary
and knowledge read-surface cleanup. It has not been tagged, published,
deployed, or installed into a live host.

## 1.0.1 — 2026-08-20

A patch release with one fix, cut because `v1.0.0`'s commit is red in CI and a
published release must point at a verified lineage.

The Markdown link gate added in `1.0.0` resolved targets with `existsSync` alone,
so a cross-repository citation written as a `../../` filesystem path resolved on
a machine holding a sibling checkout and failed on a runner holding one
repository. Five consecutive pushes were red while every local run was green.
Escape is now judged on the link's shape before any filesystem question, and
reported as its own verdict. See `docs/releases/1.0.1.md`.

## 1.0.0 — 2026-08-20

The first accepted release. No event transforms, `storageVersion` stays 1, no
verb removed, no successful command's reason code changed, and no `recover`
required — an engine at `0.14.0` and one at `1.0.0` read the same chains.

Carries the batch primitives (`work-batch`, `knowledge-batch`), a retrieval
surface that answers in a workspace being written to (`--allow-trailing`), the
separation of `maxChainEvents` from `maxRecords`, and four gates that measure
things nothing measured before: Markdown link resolution, acceptance verdicts,
chain headroom against a review trigger, and dispatch field budgets.

Full note, including the two measured failures that produced the fixes and what
this release does not claim: `docs/releases/1.0.0.md`.

## 0.14.0 — 2026-08-19

Carries `TCRN-CROSS-STORY-299`. The extension view stops growing with the prose
written into the chain, and a write whose view cannot be projected stops being
reported as a rejection after its event has already committed. Both halves ship
together on purpose: the second alone would close `recover`'s only exit, and the
first alone would leave the false rejection in place.

- **The extension view is a fixed-length verification summary.**
  `views/extensions.json` carried every conference, position, minutes and gate
  record whole, so it grew with the governed prose in the chain and crossed the
  one-MiB canonical ceiling at 532 records, taking eight read verbs down with it
  (`TCRN-CROSS-INC-198`). It now carries a count and a digest per collection:
  each record is hashed, then the vector of hashes is hashed. Measured on the six
  chains this platform runs, the file goes from 740,123 / 185,537 / 168,006 /
  59,575 / 37,759 / 27,132 bytes to between 656 and 662 bytes, and stays there —
  the shape is fixed-length, not merely smaller. Detection is unchanged: any byte
  inside any record, and any reordering of two records, still moves the file.
  `schemaVersion` becomes `tcrn.workspace-extension-index.v2`.

- **A projection that cannot fit is refused before anything is written.** The
  view projection moved ahead of the event-segment write, so an over-budget
  workspace now fails with `WORKSPACE_VIEW_BUDGET_EXCEEDED` at an untouched
  chain — same version, same head, no segment — instead of failing after the
  event is durable.

- **A view that cannot be written no longer reports the write as rejected.**
  When the segment has committed and only the derived view fails to persist, the
  receipt stays successful and carries `viewProjection: "unwritten"`,
  `viewFailureReasonCode: "WORKSPACE_VIEW_UNWRITTEN"` and `remedy: "recover"`.
  This is the defect INC-198 recorded: a command reported rejection while its
  event sat in the chain, and the natural retry appended a second event for a
  fact that had already landed. The success reason code is deliberately
  unchanged — five checks across this platform compare that string for equality,
  and a second success code would read as failure to every one of them.

- **`status` reports what is left before each ceiling.** A new `budgets` block
  gives every view's bytes, limit and headroom, the largest event segment, and
  the record count against its cap. It hangs on `status` because `status` is the
  one verb that still answers past a ceiling; a gauge on a view-verifying verb
  would be readable only while it had nothing to report. `canonicalByteLength`
  is added to the protocol package for this: it shares the serialiser with
  `canonicalJson` and skips only the ceiling verdict, so the meter does not
  inherit the failure it exists to warn about.

**Residual-applicability analysis.** The old shape is not retained for any
supported reader, and this is a replacement rather than a conditional path.
(1) It does not hold for some deployments and fail for others: any chain that
accumulates enough governed prose reaches the ceiling, so the old shape is
defective everywhere and merely has not finished failing yet. Switching on size
would make a view's bytes depend on how large the workspace is, which is a worse
invariant than the one being replaced. (2) The literal 0.11.17 treatment of the
work index — keep identity and status verbatim, digest the extension bag — was
measured and rejected rather than assumed unsuitable: applied here it *grows*
the cross-project file by 537 bytes, because extension-record prose lives in
first-class fields rather than in an extension bag. What is carried over from
that change is its method, not its target. (3) No identity rows are kept at all,
because every per-record shape is linear; the work index is that shape today, at
446.6 bytes per record, and its own ceiling is measured eight weeks out and
carried by `TCRN-CROSS-STORY-302`. The view's purpose is staleness verification,
not indexing: no code on this platform parses it, its only readers are the
byte-equality check in `validateWorkspace` and an opaque copy in migration, and
record contents are served from the event log through `conference-position-list`
and `conference-minutes-list`.

**A correction this release carries.** `TCRN-CROSS-INC-198` and the 0.11.17 notes
state that the canonical form escapes non-ASCII and that Chinese prose therefore
costs about six times its byte length, and report the affected view as 1.55 MiB,
48% over the ceiling. That is wrong. `canonicalValue` serialises strings with
`JSON.stringify`, which does not escape non-ASCII; three independent
recomputations, each calibrated against on-disk bytes until equal, put the true
overshoot at about 0.1%. Capacity planning that used the six-fold figure
misestimates every ceiling here by roughly half. The original records are not
edited; the correction is appended, which is what an append-only chain is for.

**Compatibility.** `storageVersion` stays 1 and no event is transformed, but the
derived views change shape, so every chain's on-disk views become stale the
moment a 0.14.0 engine reads them. Upgrade **all** engine copies that read a
given chain before recovering any of them: an older copy computes the old shape,
and running its `recover` writes the view back, leaving two copies alternating
and the view-verifying verbs red either way. Then, per chain, acquire the lease
and run `recover`, and confirm with `validate`. During that window the eight
view-verifying verbs raise `WORKSPACE_VIEW_STALE` on any chain not yet
recovered; `status`, `settings-catalog`, `gate-list`, `conference-list-by-work`
and `persona-list` are unaffected.

## 0.13.0 — 2026-08-18

Carries `TCRN-CROSS-MIN-102`, the ruling that closed a review of this engine's
own surface and constraint quality. Two of the four changes are defect fixes
that tighten behaviour; read the compatibility note at the end before upgrading
a chain that other copies also read.

- **Only a satisfied gate clears the way to `done`.** The clearance predicate
  counted `pending` alone while `GATE_TRANSITIONS` lets a gate move
  `pending`↔`blocked` freely and without evidence, so flipping a gate to
  `blocked` released the work item — two legal commands took an unsatisfied gate
  out of the way, in a state whose name says the opposite. `assertGateClearance`
  is shared by the verb and the replay reducer, so one predicate tightened both
  sides and the "identical predicate" invariant still holds. The documented
  deadlock escape is unchanged and is still the tombstone.
- **The Owner-acceptance gate no longer depends on the language a scope is
  written in.** The four Goal purpose anchors accept `为谁`/`beneficiary`,
  `目的锚`/`purpose anchor`, `符合性判据`/`compliance criterion`, and
  `判定人`/`decider`; `storyScopeNamesOwnerDecider` moved with them in the same
  change, because an English scope naming Owner as decider while that probe
  stayed Chinese-only would have reached `done` with no deciding-minutes
  backlink. Measured against all 590 live Story scopes, none changed verdict.
- **A single conference position may now carry up to 8,192 bytes**, with a
  per-workspace writing budget `conference.positionBudgetBytes` (default 4,096,
  bounded by the ceiling) enforced on the write path. Replay knows only the
  fixed ceiling, so a record's validity stays a pure function of its own bytes
  and `conference-v1`'s store-independence promise survives.
- **The write path stops minting outcome classes that meant nothing.**
  `gate-create` mints `role_decision` and `owner_intent_required`;
  `conference-close` declines only `blocked`. `discussion_only` is kept on
  conferences on purpose — minutes are the record of a deliberation, and one
  that reached no ruling still needs a truthful class. All five classes remain
  valid in the schema and in replay, so no existing record is affected, and an
  unrecognised value still reaches the engine's own reason code.
- `platform-doctor` gains an `engineAlignment` leg that compares each partition's
  declared `engine.requiredVersion` against every installed engine copy.
- Retired the `legacyDecision` scope check (it could not fail unless the Goal
  decider anchor had already failed) and the duplicate acceptance-shape
  evaluation; pinned the distilled summary to the knowledge store's own bound.

**Compatibility.** A chain that has written a position larger than 2,048 bytes
is refused by any older engine with `WORKSPACE_EVENT_CORRUPT`, which is
indistinguishable from real byte damage. Upgrade every copy that reads a chain
before writing the first oversized position, declare the floor in
`engine.requiredVersion`, and let `platform-doctor` check it. Chains that stay
under the old bound are unaffected. The gate tightening is retroactive by
design: a work record driven to `done` past a blocked gate no longer replays.

## 0.11.18 — 2026-08-17

- The engine repository no longer reads or executes anything inside a sibling
  project's tree, and the rule is a gate rather than a grep. Five reverse
  dependencies were removed; `verify:no-sibling-dependency` discovers siblings
  from the filesystem instead of a typed roster, so it cannot go stale the moment
  a new one is admitted, and it stays quiet on the three shapes that name a
  sibling without depending on it — a provenance citation, a classified command
  sample, and a generic tool pointed at a directory.

- Installed adapter bundles are accepted by their receipt's per-file content
  digests rather than by the directory existing. The former ceiling let a bundle
  with a changed byte pass; an unreadable or empty receipt is now itself the
  finding rather than a fallback to "the directory is here".

- An adapter installation whose files were touched but not changed has a governed
  way back. `identityDigest` covers ctime, which cannot be set, so a chmod, an
  editor save or a restore from backup wedged an installation permanently:
  uninstall refused the mismatch and install refused the occupied target.
  `adapter-rebind` and `claude-adapter-rebind` relax the identity comparison and
  nothing else — content, containment, realpath, link shape and read-time
  stability are all still enforced, and a read taken with drift tolerated is not
  branded, so no other verb can act on it.

- Both Agent App hosts are under the platform harness. It had lived only as
  hand-kept JSON inside `.claude/settings.json`, so a Codex session ran under
  none of it. One capability roster now renders per host, keyed on what must be
  true rather than on which hook provides it, so a host missing a guarantee is
  visible as such. Claude Code's declarative `permissions.deny` has no Codex
  equivalent; the control-tree write refusal is a PreToolUse hook there, with its
  three weaker properties recorded rather than glossed. `platform-doctor` gains a
  coverage leg: a host with an adapter installed must have a complete harness.

- The MCP transport is retired. It derived every tool from the command catalog
  and held no logic of its own, all 126 catalog verbs were already `cli`, and the
  authority contract it consumed is unchanged and exercised through the CLI. The
  bundle keeps its `mcp` grant object, since dropping a required field of
  `tcrn.operator-authority-bundle.v1` is a schema break rather than a cleanup.

- `pnpm preflight` runs the P1 roster instead of a second copy of it. The copies
  had drifted by two gates — `portal` and `no-sibling-dependency` — so the one
  world that proves this repository stands up without its siblings was the world
  not running the sibling gate.

- The portal's UI tests wait for the page to settle instead of sleeping at it.
  A fixed 900ms in the shared loader, and three 700ms sleeps after a fetch, read
  the DOM before it was filled under load. Both now wait on a real signal, which
  is also faster.

## 0.11.17 — 2026-08-16

- Views are bounded by record count rather than by prose length. The graph
  digest hashes each record and then the vector of hashes; the index carries
  each extension as the digest of its value (`tcrn.workspace-index.v2`).
  Detection power is unchanged, the cross-project index drops from 1.55 MiB to
  274 KB, and a workspace that had merely accumulated governed prose can be read
  again. Existing workspaces take the new shape through `recover`.
- Gates stop measuring against references that move. The portal coverage
  baseline becomes a versioned roster instead of `git show HEAD`; the doctor
  derives the snapshot train's duty from each chain's `backup.cadence` and
  relaxes only, never tightens; an evidence block that quoted a HEAD-relative
  count keeps its number and drops the claim it cannot honour. The practice is
  written down as the gate-reference-stability convention.
- The harness is declared at the container and machine layers only — 46 manifest
  items become 23 — and a new doctor leg walks the governed area to report any
  harness root the manifest places nothing under. The chain-write refusal moves
  to the machine layer, where it holds regardless of which folder a session
  opens.
- Portal: the partition switcher reads the container instead of a snapshot taken
  at boot; a switch, an explanation icon, and a tooltip stacking context are
  corrected against measured contracts; and a leg that failed about one run in
  three now waits for its condition rather than for a fixed interval.
- Known ceiling: `export` still canonicalises the whole state, so a large chain
  cannot export. That wants chunking rather than digests and is not in this
  release.

## 0.11.16 — 2026-08-14

- The install surface is engine data: `install-manifest` enumerates every
  wiring item across both adapters — layer, placeholder path template, writer,
  and an acceptance probe — with an independent required-item catalog so that
  deleting an item turns the completeness gate red rather than shrinking the
  truth.
- The platform doctor executes the probes it is given: wiring presence,
  deployment freshness against the helper pin, helper copies by digest,
  launchd duty by last exit and product freshness, hook target resolvability,
  bridge syntax, and trust-archive freshness. Every leg carries a synthetic
  red in the suite.
- The paired backup is retired where it silently died; a local snapshot timer
  (tar + sha256 + chain versions, 14-copy rotation) and an encrypted pure-file
  offsite leg replace it, both registered in the manifest so the doctor sees a
  stall instead of assuming health.
- Evidence residency: originals with real paths live in the platform archive;
  the public copies are sanitised and declare it. Cross-repo privacy is a gate
  of its own, scanning every governed project root the manifest names.

## 0.11.15 — 2026-08-13

- Subagent model plans: a plan is `{host, name, defaultModel, assignments}`
  mapping persona to model; `execution.claudeCodeSubagentPlan` and
  `execution.codexSubagentPlan` name the plan a host reads before dispatch.
  Five verbs, referential integrity both ways, and the 0.11.14 write family
  (`host-config-*`, `persona-binding-*`) retired from the catalog with its
  events still replaying.
- Preset personas are editable as chain overlays over compiled data:
  `persona-preset-override`, `persona-preset-restore` (whole or per field), and
  tombstone deletion. Names remain identities; content moved to prose fields and
  the free-form `prompt` field is gone.
- `vocabulary`: a read-only surface for the closed sets the engine enforces —
  roles with `reviewOnlyDispatchable`, conference types with their covering
  independence floors, hosts, execution forms, and enum settings.
- The portal was rebuilt into a dashboard plus four management pages; state
  surfaces fail visibly (health reddens on a failed read, engine version comes
  from the engine, the receipt chip shows the version or the reason code).
- Gates that can fail: rendered-DOM UI presence, whole-table i18n comparison,
  coverage conservation against a checked-in baseline that must name every test
  file, and byte-for-byte re-execution of verbatim evidence blocks. Each ships
  with a mutation proving it goes red, and `verify:portal` runs in CI with the
  workflow step asserted from the verify train.

## 0.11.14 — 2026-08-12

- Execution configuration: per-host named model configurations with a `default`
  pointer and per-persona pins; six verbs, one chain event per action,
  referential integrity enforced, model names carried and never interpreted.
- `execution.subagentPolicy` and `execution.independenceFloor` settings; where
  the floor covers a conference type, `conference-close` requires
  `--execution-form independent`.
- The portal grew an Execution surface, and every setting leads with a
  translated human name in all five locales.

## 0.11.13 — 2026-08-12

- The portal ships in `portal/`. Cloning the engine gets the interface with it,
  and the portal drives the CLI it arrived with rather than a machine-level path.
- `portal:test` and `portal:proof` are sibling steps; the design-system
  comparisons skip where that repository is absent.

## 0.11.12 — 2026-08-12

- `--control-manifest-out` is declared in the command catalog. It was added to both
  relocation verbs in 0.11.11 but not to the catalog, which is the only authority
  this engine has on what exists.

## 0.11.11 — 2026-08-12

- `relocation-vacate` proves its receipt emittable before the commit point, so an
  oversized control manifest refuses while the source is still live instead of
  destroying it. `relocation-plan` and `relocation-vacate` accept
  `--control-manifest-out <path>`; the new refusal is
  `WORKSPACE_RELOCATION_MANIFEST_OVERSIZED`.
- `release-preflight` asserts the format gate, which `verify-p1` could never run
  during a train. Two schema files are normalised.

## 0.11.10 — 2026-08-12

**INIT-023 productization: engine version declarations and enum value exposure.**

- a workspace can declare the engine version it requires, and an engine that does not satisfy it refuses by name with both version numbers rather than surfacing a version mismatch as a corrupt chain;
- a workspace carrying no declaration is unaffected, so existing chains read and write as before;
- `settings-catalog` publishes `allowedValues` for keys with a closed value set, so a consumer can offer exactly what the engine accepts instead of maintaining a second copy;
- a refused enum write names the accepted values in both its payload and its message.

## 0.11.9 — 2026-08-11

**INIT-022 pre-pin: settings, template admission, and the adapter baseline.**

- `settings-catalog` and `settings-set` make workspace settings a first-class machine-readable surface: registered keys carry type, layer, current and default values, writes go through compare-and-swap against the live head, and each write answers with a receipt bearing the chain version and receipt digest;
- the settings registry is a closed set the engine defines, because a key exists only where the engine consumes it — a deployment sets values, not the vocabulary;
- `template-admit` and `template-validate` move what a record must contain from a compiled constant to data the engine admits under digest and owner authorization, so a project carries its own genre without forking the engine while the base contract stays outside the reach of what it constrains;
- the adapter baseline names the hooks the machinery needs and validates only those, leaving hooks a user installs untouched and unjudged.

## 0.11.8 — 2026-08-07

**INIT-020 QA3 hardening closes the migration, admission, evidence, and release gates.**

- PG migrations require a named schema and caller-stamped instant, write and read back the storage-home sentinel, and refuse expired epoch leases;
- sealed archive reads identify their storage authority, backend admission recognizes concrete backend kind, and PG admission requires the named append-only trigger;
- test wiring scans non-standard test entrypoints, validates executable owners, and CI runs the evidence round-trip proof;
- ADR red legs are structured policy records, receipt hygiene anchors both heads to the authoritative event stream, and release preflight binds a green P8 result to the exact tag commit and metadata-only release diff;
- Story-209 now requires the exact ten-block Story scope, preserves the legacy evidence/fix/decision contract, and refuses incomplete scope at create and transition gates;
- dispatch briefs require red-line boundaries, file pointers, verification commands, chain closeout actions, and effective evidence commands; closeout and source-to-rule conservation each have executable positive and negative legs;
- the public preflight runs the complete P1 gate set in an independent no-local clone under a scrubbed environment and reports every gate, including the optional PG lane, rather than relying on the evaluated checkout.

## 0.11.7 — 2026-08-07

**The storage-home seal is an explicit, fail-closed recovery path.**

- added the engine-only `storage-home-seal` verb for sealing a retained file archive to a validated PG authority without overwriting divergent archive bytes;
- added `storage-home-status` for an engine read-back of the binding;
- retries preserve the original declaration and conflicting bindings refuse;
- the seal requires the live PG schema, a validated chain, and an expected-version sentinel.

## 0.11.6 — 2026-08-07

**Interrupted migrations can resume a verified target prefix.**

- A strict prefix is admitted to the existing byte-prefix proof before the
  remaining source segments are copied; a same-version head mismatch remains a
  fork refusal.
- Added a segment-interruption regression test and release evidence.

## 0.11.5 — 2026-08-07

**Migration view equivalence is independent of backend collation.**

- `migration-verify` sorts workspace views by canonical name before comparing
  names and bytes, so `STATUS.md` cannot make a healthy FileBackend/PG pair red
  merely because the two stores enumerate names differently.
- Added a mixed-case view regression test and the release evidence for the
  patch.

## 0.11.4 — 2026-08-07

**The storage-home migration gate and PG test path are fail-closed.**

`0.11.4` is the INIT-020 engine release on top of `0.11.3`:

- file-backed mutation refuses a migrated workspace's storage-home sentinel;
- migration takes an archive-side lease and preserves the PG backend's typed
  storage errors;
- the PG suite applies an isolated `chain_test_*` schema and runs serially,
  including the append-only trigger refusal proof; and
- the release/test wiring records the PG job as a real pipeline owner.

The CLI verb count remains 104. No push or public release is performed by this
workspace task.

## 0.11.3 — 2026-08-06

**The engine CLI serves a chain from Postgres when TCRN_PG_\* is set.**

`0.11.3` is the STORY-189 switch-window serving release on top of `0.11.2`:

- `runCli` arms the storage and store backend factories with a PgBackend /
  PgStoreBackend for the schema named by `TCRN_PG_SCHEMA` when
  `TCRN_PG_CONNECTION` is set, so the read verbs answer from a PG-backed chain.
  Migration verbs are excluded (their explicit backends win) and `commands` is
  excluded (it answers from the catalogue).

No verb, event-schema, storage-version, or file-backend byte change; CLI verb
count stays 104.

## 0.11.2 — 2026-08-06

**The Postgres backend segments by the workspace's segmentEventLimit.**

`0.11.2` is the STORY-189 window rerun release on top of `0.11.1`:

- The PG backend hardcoded `SEGMENT_LIMIT=1024`, so a chain whose single
  segment exceeded the 1 MiB canonical bound became unreadable after migration
  (TCRN-Design-System v983, `WORKSPACE_MIGRATION_FUTURE`). It now reads
  `segmentEventLimit` from the workspace metadata row and lays out segments
  with it, matching the file backend; the segment-limit cache is invalidated on
  metadata write so the migration probe does not freeze a stale fallback.

No verb, event-schema, storage-version, or file-backend byte change; CLI verb
count stays 104.

## 0.11.1 — 2026-08-06

**Migration-verify tamper detection restored, and the migration CLI exits.**

`0.11.1` is the STORY-189 window rerun release on top of `0.11.0`:

- `migration-verify` compares the full canonical bytes of each event, not a
  stored `eventHash`, so it still tolerates the file/PG segment-layout
  difference while catching a tamper of any event field (the STORY-178 red-leg
  guarantee).
- The migration CLI now closes its PG backends with `this` bound and swallows
  close failures, so `migration-execute` / `-verify` / `-rollback` exit cleanly
  instead of hanging on a live pg client.

No verb, event-schema, storage-version, or file-backend byte change; CLI verb
count stays 104.

## 0.11.0 — 2026-08-06

**Postgres storage backend, dual-backend equivalence, and the migration verb
family.**

`0.11.0` is the INIT-020 engine-side release (TCRN-CROSS-INIT-020): the engine
gains a second storage backend and the verbs to move a governed chain between
the two, without changing what a chain *is* on either side.

- Storage abstraction: `StorageBackend` / `StoreBackend` interfaces; the file
  backend is converged onto them (`workspace` data plane plus the knowledge /
  artifact stores), byte-identical behaviour.
- Postgres backend: `PgBackend` / `PgStoreBackend` in the new
  `packages/pg-backend` workspace package, `pg` driver pinned at `8.22.0`; a
  per-chain schema, append-only enforced by GRANT + trigger, fail-closed on
  connection or verification failure.
- Dual-backend equivalence gate: per-event bytes / head / version compared
  value-for-value, with a mutation witness so the gate cannot be silently
  constant-true.
- Migration verb family: `migration-plan` / `migration-execute` /
  `migration-verify` / `migration-rollback`. Migration is a copy of bound
  state: the workspace binding does not travel with the bytes, so a bypass
  copy is refused.
- ADR `0004-postgres-storage-backend` records the direction, schema layout,
  roles/GRANT matrix, and the equivalence criteria (STORY-171).

Compatibility notes:

- No verb, event-schema, or storage-version change to the file backend; file
  chains are byte-identical to `0.10.2` until a migration runs.
- Release hygiene: this release adds a fifth workspace package
  (`packages/pg-backend`); all five manifests, `FRAMEWORK_VERSION`, and the
  `P8_VERSION` / `P8_TAG` constants are cut on one version. Carries an
  annotated tag.

## 0.10.2 — 2026-08-04

**WSA-3 also admits on create.**

`0.10.1` refused to close an Initiative that still held live non-terminal work,
but nothing stopped a new live child being created under an Initiative that was
already `done` — so a closed subtree could be reopened one `work-create` later.
`createWork` now refuses a non-terminal record whose parent is a done,
non-tombstoned `Initiative` (`WORKSPACE_INPUT_INVALID`); the same create under a
live Initiative is still accepted.

Like its transition-side twin the check sits in the write path's mutation
reducer, never in `validateWorkGraph` — replay runs that validator over every
historical event, which is how `0.10.0` fail-closed an existing chain.

- No verb, event-schema, or storage-version change; `PROTOCOL_REASON_CODES`
  unchanged.
- Release hygiene: `packages/{cli,core,protocol}` were still pinned at `0.9.0`
  while the root manifest said `0.10.x`, so `verify:p8` could not pass for either
  earlier 0.10 release. All four manifests, `FRAMEWORK_VERSION`, and the
  `P8_VERSION` / `P8_TAG` constants now agree, and the release carries an
  **annotated** tag (`v0.10.0` and `v0.10.1` were lightweight, so no tag object
  existed for the helper's `IDENTITY` to pin).

## 0.10.1 — 2026-08-03

**WSA-3 moved from replay-level to write-path admission.**

`0.10.0` placed WSA-3 in the work-graph validator, which a chain **replay** runs
over every historical event. A chain that legitimately closed an Initiative
before 0.10.0 — while descendants were still open — therefore failed replay
under 0.10.0 (`WORKSPACE_EVENT_CORRUPT`), making an existing, otherwise-healthy
chain unreadable. That is the defect this patch fixes.

`0.10.1` moves the check out of the graph validator and into the **write path**:
`transitionWork` refuses to move an `Initiative` to `done` when its subtree still
holds live non-terminal work (refused with `WORKSPACE_INPUT_INVALID`). Replay is
unaffected — historical chains stay readable — and the rule still holds going
forward: you cannot close an INIT with open descendants.

- No verb, event-schema, or storage-version change.
- `PROTOCOL_REASON_CODES` is unchanged from 0.9.0 (the 0.10.0-only entry is
  removed; the check now reports `WORKSPACE_INPUT_INVALID` from the core layer).

## 0.10.0 — 2026-08-03

*Superseded by 0.10.1 — see above. The 0.10.0 placement of WSA-3 in the graph
validator made existing chains with a historically-premature INIT close fail
replay; do not deploy 0.10.0.*


Closing an Initiative that still holds a live, non-terminal work item is now a
chain-level error instead of a discipline.

The engine's work-graph validation (`validateWorkGraph`) gains **WSA-3**: an
`Initiative` in the terminal `done` state may not have any live non-terminal
descendant at any depth — a done Epic under it with a still-active Story is red
too, not just direct children. A tombstoned (deleted) child holds no open work
and is excluded. The refusal is `WORK_GRAPH_ACTIVE_CHILDREN_OF_DONE_INITIATIVE`.

This makes "close the initiative" an act of completion: every descendant must
already be terminal, or the close is premature. The old habit of closing an INIT
with pending Epics/Stories — which previously passed silently — now fails
closed at the graph validator, so a replay over a violating chain refuses.

It is a minor release: it adds a graph-validation rule but no verb, no event
schema change, no transform of existing events, and no change to the chain
storage version. It alters `PROTOCOL_REASON_CODES` by one entry.

## 0.9.0 — 2026-07-29

A workspace gains a governed route to a new path or a new machine.

The engine binds five absolute roots and refuses a control tree whose stored root
identities disagree with the live filesystem. That refusal is correct and stays.
What was missing was a route THROUGH it: an operator who had to move a workspace
had exactly one option, hand-editing `roots`, and nothing anywhere recorded that
it had happened. The documented reason for the gap was also wrong — ADR 0002 and
the backup runbook both attributed root rebinding's deferral to OD-29, which is
the manifest-scope decision, when the apply-path deferral is OD-7 and concerns
storage-version-2 chain rewriting. Root rebinding rewrites no event and changes no
storage version.

### Added

- **`relocation-plan` / `relocation-vacate` / `relocation-adopt` /
  `relocation-abort` / `relocation-inspect`.** Five verbs that move the BINDING,
  never the bytes. `relocation-plan` is read-only and comes first: it emits the
  hop's `relocationId`, which the authority must name, and the control manifest,
  which after the vacate commits no address can produce again while adopt requires
  its exact text. Plan and vacate share one preparation function so the id the
  operator mints against is the id the vacate takes. The
  order vacate → copy → adopt is mechanically enforced, because copy-first is the
  operator's natural instinct and must fail closed rather than produce an
  unauthorized live target. Between the vacate and the adopt **zero** addresses
  are alive, not two; the source and the copy refuse under different, actionable
  codes. The operator moves the bytes with OS tools — the engine gets no copy
  path, and ADR 0003 names the refused alternatives so a later reader does not add
  one back.
- **An append-only `relocations` ledger** as a tenth, OPTIONAL field of
  `workspace.json`. `schemaVersion` stays `tcrn.workspace.v1`, `storageVersion`
  stays `1`, and the field is **absent — not empty** — on every workspace that
  never relocates, so those files are byte-identical to `0.8.0`. Because it
  travels inside the copied tree, a re-copy of a vacated source is born dead and a
  copy of an adopted target dropped back at the old path is dead too. `roots` is
  never rewritten; `activeBinding()` answers where the tree lives now.
- **A per-invocation relocation authority** on the gate-identity pins-track shape.
  A permit names `actorId`, `workspaceIds`, `destinations`, a `basis` of
  `{version, headEventHash}`, the exact `relocationId`, and the exact `stage`
  (`vacate` / `adopt` / `abort`). Without the `workspaceIds` term the roster
  permits every workspace on the machine while still looking rigorous; without
  `destinations` a permit to move a workspace somewhere approved moves it anywhere;
  without the basis a permit can name the right hop and a stale vintage. The last
  two terms are what make the permit per-INVOCATION rather than per-vintage:
  relocation does not advance the chain, so the basis alone is byte-identical after
  a hop and one file drove `vacate → adopt → abort` twice over in an adversarial
  review, leaving three live authorities for one `workspaceId` with no tampering.
  A `relocationId` is derived over `(workspaceId, sequence, from, to, basis)`, so
  one permit authorizes one hop and one verb of it — one hop, not one INVOCATION:
  the same hop presented again at the same path is admitted again, which is a stated
  ceiling rather than an oversight.
  An `abort` permit, and only an `abort` permit, also names the hop's
  `vacateCommitmentSha256` — the sha256 of the committed `vacated` ledger entry, which
  contains the sha256 of the file that authorised the vacate. A document carrying both
  permits for one hop would have to contain a digest of itself, so the abort is
  necessarily a second document and the two entries of an aborted hop can never name
  the same authority file. That is a review device and not a barrier: whoever can mint
  one permit can mint the other.
  The ledger records only `{actorId, authorityFileSha256}`, never a file
  reference — a chain whose readability depends on an external file still being
  present is a chain that bricks on a restore onto a fresh machine.
- **Adopt-side assertions for the two blindnesses the snapshot manifest cannot
  cover**: a copy that dropped an empty directory, and a copy that carried a lock
  or claim file across. Neither is a manifest bug; both are it doing what it was
  scoped to do. Each proof asserts BOTH halves — that `snapshot-verify` still
  returns `SNAPSHOT_VERIFIED`, and that adopt then refuses — because without the
  first half the second cannot be shown to measure anything.

### Changed

- `readMetadata` gains an `admit` parameter defaulting to the STRICT value. The
  enforcement point is `readMetadata` and not `resolveWorkspace`, chosen on
  evidence: `acquireWorkspaceLease`, `lease-break` and `lease-recovery-break`
  never reach `resolveWorkspace`, so placing the check there leaves a vacated
  address with live lease-mutation paths. `lease-inspect` is deliberately still
  admitted at a dead address — it emits no workspace content and cannot revive
  anything, and an operator legitimately needs to see a stale lease on a dead
  tree.
- `verifySnapshotManifest` gains an optional `excludePaths`, additive and
  byte-neutral for every existing caller.
- The three mutating verbs are absent from the MCP surface, excluded by a
  predicate derived from the command catalog rather than a hand-written list of
  names.

### Doctrine retired

- ADR 0002's "Restore constraint" paragraph and doctrine 1 of the backup runbook
  both claimed root rebind needed the migration apply path, per OD-29. Both are
  retired by section reference in the same change that ships the replacement, with
  the misattribution explained rather than quietly deleted. The
  `WORKSPACE_SCHEMA_INVALID` refusal itself is unchanged.
- `packages/core/spec/file-engine-v1.md`'s immutable-metadata / closed-V1-schema
  language is narrowed with an explicit residual-applicability analysis: the old
  rule still holds for every field and every caller EXCEPT the three relocation
  verbs. Conditional retention, not deletion.

### Compatibility

Additive and byte-identical for every workspace that never relocates.

**For a workspace that carries a relocation ledger — including one whose relocation
was ABORTED and that never moved a byte — the break is total and one-way**: the
tenth metadata field fails the closed-field check with `WORKSPACE_SCHEMA_INVALID` on
any `0.8.0`-or-earlier binary — not degraded reads, no reads. Measured against a
`0.8.0` build, the break lands at the VACATE, not at the adopt. The aborted case is
named because the ledger is append-only, so cancelling a move also version-locks the
partition, and that is the case an operator is least likely to expect. Accepted deliberately
(OD-A) rather than discovered later. The ledger cap is sixteen entries, picked
deliberately (OD-B) so it does not become an accidental constant — and it is a
ONE-WAY BUDGET OF EIGHT ATTEMPTS, because a hop costs two entries whether or not a
byte moves and no verb prunes or compacts. `relocation-plan` refuses a full ledger
before the minting ceremony and reports the remaining budget.

### What this does not do

`workspace.json` is the one part of the control tree the event hash chain does not
cover. Anyone with write access to a vacated source can restore its pre-vacate
`workspace.json` in canonical bytes and that address is alive again, and the
engine **cannot** detect it — the same ceiling `gate-identity.ts` already states
about gates. This release does not prevent two truths; it makes them legible,
permanently, in both files, under one shared `relocationId`.

It does NOT make producing a fork require destroying an artifact — an earlier draft
of this entry said so and was measured wrong. `relocation-abort` alone produces one
if the destination already adopted, destroying nothing, and abort is the documented
recovery verb. What abort costs now is an authority minted for THIS hop's `abort`
stage and naming this hop's `vacateCommitmentSha256`, an explicit
`--acknowledge-fork-risk`, and an optional `--target-inspection` document whose
declared `observedAt` must sit within an hour of the abort's own `at`. **The engine
checks the DOCUMENT, not the destination**: both instants are caller-supplied, the
source cannot observe a remote address, and the check is TOCTOU by construction — an
earlier draft said "refuses the abort when the destination has adopted", which the
document alone cannot establish. The receipt records `targetInspectionSupplied`, the
document's digest and its declared instant instead of a verdict. The
source still cannot know what the destination did; the receipt and every later
`relocation-inspect` at that address say exactly that, in those words, in both tenses
— after an abort the copy stays adoptable and can never learn of the abort, so the
runbook now says to DESTROY IT.

The consequence is a mandatory close-out step no gate can replace: run
`relocation-inspect` at BOTH ADDRESSES THE LEDGER NAMES and compare. It needs both
trees at once and is therefore by construction not something `verify` can run for
you. Its scope is stated exactly, because an earlier draft overstated it: it proves
those two addresses have not both stayed live. A third address made by copying the
tree, deleting `relocations` and rewriting `roots` is a fully live authority that
appears in no ledger and that this compare cannot see — the pre-`0.9.0` hand-edit
hole, which this design does not close and does not claim to. **Nor can that compare
see an N-way adoption**: a permit is a predicate over the bytes presented at a path
rather than a token with a spend record, so one adopt permit admits the same shipped
tree at the same path on N hosts, and the two-sided compare is green at every one of
them. Closing that needs a host-identifying term the ledger does not carry, and it is
not in `0.9.0`. No single-sided "the source is still dead" assertion
exists in the suite, and that absence is deliberate — such an assertion would be
permanently true.

## 0.8.0 — 2026-07-29

The event chain becomes readable on the chains that have one worth reading.

`0.7.0` closed two of the three read-surface gaps its first cockpit consumer
filed. This closes the third, which is the same gap in its purest form: `export`
was the only read that returned events at all, and it refuses any workspace whose
canonical form exceeds one MiB. Three of the four chains on the platform that
filed this already do — `cross-project` at 1,825,251 canonical event bytes,
`TCRN-AOS` at 1,160,601, `TCRN-Design-System` at 1,134,120 — and the fourth will
by growing. So the one artifact a consumer needs in order to reproduce a chain was
unreachable exactly on the chains large enough to be worth reproducing.

### Added

- **`event-list`**, workspace-scoped and paginated with `--limit` / `--offset`
  like every other list verb. Records come back **verbatim** — `schemaVersion`,
  `id`, `streamId`, `sequence`, `occurredAt`, `priorHash`, `payload`,
  `payloadHash`, `eventHash` — because a consumer that re-derives the chain must
  hash exactly the bytes the engine hashed, and a projection would break
  re-derivation by construction. The concatenation of every page, in order, is
  the array `export` would have emitted and feeds `validateEventChain`
  unmodified. Every page carries the `workspaceId`, `version` and
  `headEventHash` anchors, so a consumer always knows which chain and which head
  it just read.
- **`CLI_EVENT_PAGE_OVERSIZED`**, the refusal for a page that does not fit. This
  is the one list verb whose records are verbatim, so page size is the payloads'
  business and a caller who raises `--limit` far enough will reach the ceiling.
  The default window is 64 — the engine's own segment size, roughly 100 KiB
  across the four live chains. A page that overflows is refused with the flag to
  lower named in the message, never silently shortened: a short page is
  indistinguishable from the end of the chain, which is the same
  absence-instead-of-refusal defect `0.7.0` was cut to fix. The code is
  deliberately distinct from the protocol's `INPUT_OVERSIZED` that `export`
  raises on the same ceiling, because the two leave the caller in different
  places — one with nowhere to go, one with a smaller window to ask for.

### Compatibility

Purely additive. No receipt changes shape, no flag becomes required, nothing was
removed or renamed, and `export` is untouched and still all-or-nothing.

## 0.7.0 — 2026-07-27

The read surface stops refusing to name things.

Two gaps were filed against this engine by its first cockpit consumer, and both
had the same shape: a read that works on a small chain and disappears on a large
one, in a way that looks like absence rather than refusal.

### Added

- **`externalKey` in `work-list` summaries.** `export` was the only read that
  carried the human-facing key, and it refuses any workspace whose canonical form
  exceeds one MiB — which two chains on the platform that filed this already do.
  A record id is a one-way digest of its key, so a consumer on the paginated path
  could render an entire work tree and name nothing in it. The one downstream
  reader resorted to re-deriving keys by brute-force digest match, which only
  works for conventionally-named records and leaves the rest permanently
  anonymous. The field the record already holds now travels with the summary.
- **`conference-position-list` and `conference-minutes-list`**, workspace-scoped
  and paginated like every other list. Before them, positions and minutes could
  be reached only through `export`, so on an oversized chain a deliberation
  holding fifteen arguments and one holding none rendered identically. The
  failure was not slow reading, it was absent reading presented as emptiness.

### Compatibility

`work-list` receipts gain a field. Consumers that compare whole canonical bodies
against a stored fixture will see the difference; consumers that read fields will
not. No verb was removed, renamed, or given a new required flag.

## 0.6.0 — 2026-07-26

Governed dual-host operator integration: pinned operator authority, a
host-neutral MCP surface, Codex installation and SessionStart activation,
bounded observe/execution receipts, and conference execution provenance. The
full narrative is `docs/releases/0.6.0.md`.

### Added

- **One pinned operator-authority contract for the remaining governed CLI
  surface.** An absolute-path plus SHA-256 pins document binds the authority
  bundle, generation floor, revocations, host observations, command allowlists,
  and every authority file consumed by the seven previously IO-only verbs.
- **`tcrn-workflow-mcp`, a host-neutral stdio JSON-RPC surface derived from the
  command catalog.** Mutations require an exact pinned grant and preserve
  numeric CAS, explicit time, actor, and stable reason-code semantics.
- **Codex install, uninstall, activation, observe, and execution-collection
  primitives.** Activation is persona-free, SessionStart-only, fail-open, and
  bound to the installer-admitted absolute handler path; every exact live
  definition still requires explicit host approval.
- **Conference execution provenance.** Execution mode, bounded host receipts,
  and fresh-context evidence distinguish synthesis from genuinely dispatched
  deliberation without turning attribution into identity.
- **Five-language root-document coverage and a machine-pinned translation
  policy**, plus a CJK-safe house style and release-time stale-mirror checks.

### Changed

- **Authority-bearing output is enforced at the CLI write boundary**, not
  trusted from catalog metadata alone; undeclared guarded output fails closed.
- **The command catalog and schema now carry the authority-bearing contract**
  used by both the CLI and MCP projection.
- **Activation hardening closes the audited path, digest, approval, rollback,
  and missing-settings gaps**, including canonical handling of a project with
  no existing `.claude/settings.json`.
- **The release dependency graph pins `fast-uri` to `3.1.4`**, closing the
  high-severity host-confusion advisory inherited through the development-only
  `ajv` toolchain.
- **Pull-request CI checks out the contributor head SHA**, so the privacy gate
  judges repository history rather than GitHub's synthetic merge commit, whose
  generated author metadata may contain an unreviewed private email address.

## 0.5.0 — 2026-07-24

The sprint / release-train mechanism: batch Initiatives into a named delivery
train and ship them together, without entangling the timebox axis with the
work-scope tree. The full narrative is `docs/releases/0.5.0.md`.

### Added

- **The `Release` work kind is open on the CLI create path**, enforced parentless
  in the graph validator: a sprint is a top-level batch container. `Review` and
  `Knowledge` stay closed.
- **`work-annotate --sprint`** attaches a member to a sprint via a `required:false`
  `advisory:sprint` extension whose value is a qualified `{workspaceId, workId}`
  reference to the sprint's Release record — cross-partition capable and
  non-binding. `work-show` surfaces it; `work-list --sprint` filters members.

### Changed

- **The advisory value-shape check now runs on `work.created` as well as
  `work.annotated`**, so a forged create cannot smuggle a malformed `advisory:*`
  value past the envelope-only graph validator (covers scope/decided-by/sprint).

## 0.4.0 — 2026-07-24

Background-resource residue governance: the machine-checkable half of a
convention that keeps a governed agent session from leaking the background loads
it spawns. The full narrative is `docs/releases/0.4.0.md`.

### Added

- **A host-neutral background-resource detector and registration face.** A pure
  core (`packages/core/src/background-resource.ts`) records the process **group**
  a session owns and, given a process-table snapshot, reports residue: any owned
  group with a live member, or any init-reparented / parent-absent orphan whose
  command matches a registered pattern. A thin host adapter
  (`scripts/spawn-guard.mjs`) reads the live table with the reaper's hardened
  `ps` invocation and stores the registry in the workspace transient zone,
  outside the engine control tree. Ships with a red-proof (guard `BR-01`/`BR-02`)
  that the injected orphan is always detected.
- **A host-wiring recipe** (`docs/architecture/background-resource-governance.md`)
  stating without overclaim that automatic session-end firing is Owner-gated on
  both hosts (Claude `Stop` is a signed ladder step; Codex is trust-gated).

## 0.3.2 — 2026-07-23

Knowledge-store curation headroom and the Incident create path. The full
narrative is `docs/releases/0.3.2.md`.

### Added

- **The CLI create path admits the `Incident` kind.** The protocol has carried
  eight work kinds since `0.1.0`, but `work-create` only opened the four
  planning kinds; a defect could therefore only be recorded as a `Story`.
  `Incident` is now creatable (with or without a parent), while `Review`,
  `Release`, and `Knowledge` stay closed to creation.

### Changed

- **The knowledge aggregate cap no longer double-charges the derived index.**
  The store index re-serializes the very metadata already counted, so the cap
  taxed every record roughly twice and a store of ~30 tiny records scanned at
  97% while holding almost no body content. The cap now bounds only the
  source-of-truth bytes (marker + Σ metadata + Σ body) across scan, create, and
  promotion; the index is still validated byte-for-byte.
- **Retiring a knowledge record reclaims its body.** A retired record's body is
  already unreadable, so retire now deletes it as its final durable step;
  retire frees bytes, not merely a live-record slot. A live record still
  requires its body, and the store stays valid without a retired one.
- **Knowledge search matches summaries, not only subject and tags**, so a
  curated card is findable by the substance in its summary.

Chains written under `0.3.1` replay unchanged.

## 0.3.1 — 2026-07-22

Release-machinery completion. The full narrative is `docs/releases/0.3.1.md`.

### Fixed

- **The P8 release pins missed the 0.3.0 version sweep.** `P8_VERSION` /
  `P8_TAG` in `scripts/lib/p8-workflow-rc.mjs` still said `0.2.0`, so the
  `v0.3.0` tree fails its own `verify:p8` with `P8_PACKAGE_VERSION_MISMATCH`
  and can never produce its release artifacts — which is why the `v0.3.0`
  GitHub Release carries no source tar, provenance, SBOM, or checksums. This
  release moves the pins (and registers the release notes in the proof route
  lists) so the P8 ceremony completes. No engine behaviour changes;
  `work-annotate` and every other verb are byte-for-byte the `0.3.0`
  behaviour.

## 0.3.0 — 2026-07-22

Advisory scope on the record. The full narrative is `docs/releases/0.3.0.md`.

### Added — a new additive operation, hence the minor bump

- **`work-annotate`**: attach non-binding advisory fields to a work record
  without changing its status. `--scope` records an authoritative scope/intent
  line; `--decided-by` backlinks the governing conference minutes. Both land as
  `required:false` extensions (`advisory:scope`, `advisory:decided-by`) — no
  registry row, they never gate a transition or block `done`. The engine appends
  a new `work.annotated` operation; a workspace that uses it is unreadable by a
  binary predating it (the WSD-1 additive-operation contract), while workspaces
  that never annotate stay byte-identical and `storageVersion` stays 1.
- **`work-show` advisory projection**: an annotated record surfaces its advisory
  fields under `advisory`; an un-annotated record's output is byte-identical to
  before.
- **Event-chain scaling advisory evidence**: the raw samples behind the README
  "Known limits" ceiling figures now ship at
  `docs/verification/2026-07-20-event-chain-ceiling-samples.json`, so the
  citation resolves in a standalone clone.

### Guarantees

- The reducer accepts a `work.annotated` event only if it changes exactly the
  advisory keys and nothing else. A forged annotation that smuggles a status
  change or a foreign extension fails closed `WORKSPACE_EVENT_CORRUPT` — pinned
  by three forge tests. Chains written under `0.2.0` replay unchanged.

## 0.2.0 — 2026-07-21

Gate identity. The full narrative is `docs/releases/0.2.0.md`.

### Changed — a behaviour change, hence the minor bump

- **Satisfying an `owner_intent_required` gate now requires an out-of-band
  roster and a named actor the roster permits.** On `0.1.0` anchoring minutes
  alone sufficed; the same transition without a roster now refuses with
  `WORKSPACE_GATE_IDENTITY_REQUIRED`, and an unpermitted actor with
  `WORKSPACE_GATE_IDENTITY_REFUSED`. The class is the per-gate opt-in; the
  other four outcome classes are unchanged. Chains written under `0.1.0`
  replay unchanged.

### Added

- **`gate-identity` module**: canonical roster document
  (`tcrn.gate-identity-authority.v1`), TOCTOU-hardened reader on the shared
  authority-file primitive, brand-guarded permission checks, and a
  self-contained decision record (`gate-identity:decision` in the gate's
  extensions) that replay shape-checks without ever re-reading the roster.
- **`gate-transition --identity-authority` / `--identity-authority-digest`**:
  the roster reaches the CLI as a stated pin.
- **Digest flags on six pins-track verbs** (`profile-resolve`,
  `profile-authorize`, `context-route`, `adapter-rollback-plan`,
  `claude-adapter-rollback-plan`, `claude-adapter-uninstall`): the caller
  states the digest it already holds; wrong digests stop at the digest; dual
  supply fails closed as `CLI_AUTHORITY_AMBIGUOUS`. Host-context verbs
  deliberately gained nothing.
- **Boundary section** `docs/architecture/agent-integration-v1.md` §9, its
  third statement pinned by a test that asserts replay accepts a forged
  tail-append.

### Fixed

- The recovery stress test demanded exactly one winner where the
  implementation promises at most one; the stronger assertion was the flake.
- Source lints (`LINT_EXPLICIT_ANY`, `LINT_EVAL`) judge code with comments and
  string literals blanked, instead of biting prose.
- Guard-check names the case that catches its two slowest mutations; the push
  gate runs in ~134s against ~205s.

## 0.1.0 — 2026-07-21

First accepted release. Everything below is relative to `0.1.0-rc.6`; the full
narrative is `docs/releases/0.1.0.md`.

### Added — evidence against a real host

- **`pnpm host-evidence`**: a productionised harness that observes the Claude
  Code activation ladder against a real host binary — eight credential-free
  group-A observations plus a credentialed group-B readback proving the
  injected authority summary reaches the model's context. Receipt:
  `docs/verification/host/claude-code.json` (Claude Code `2.1.201`).
- **Event-chain ceiling measurement**: single-command latency crosses one
  second around ~6,600 events (Apple M3, extrapolated); raw samples in
  `docs/verification/2026-07-20-event-chain-ceiling-samples.json`.
- **`canonicalDocumentBytes`**: the text-plus-trailing-newline byte contract
  gets a name; `canonicalJsonBytes` remains the release-trust signature basis.
- **Shared RFC 3339 corpus** pinning `parseStrictInstant` and
  `strictRfc3339Instant` to each other, accept and reject sides both.
- **`pnpm guard-check`**: reverting a registered guard and watching its named
  test go red is now a machine judgement over a 12-entry registry.

### Changed — documentation now states what was measured

- All five READMEs rewritten: measured activation status (live on Claude Code,
  no operator command path yet — `ADAPTER_HOST_REQUIRED` from a shell), a
  twelve-entry **Known limits** section, and a **Driver assumptions** group
  (integrity does not depend on the driving model; progress does).
- The recovery stress test asserts what the implementation promises — at most
  one winner plus liveness — instead of exactly-one, which a green rerun on
  identical bytes had shown to be over-claimed.
- CI actions pinned to v7 line; npm version updates are advisory-driven.

### Release

- Version `0.1.0`; `releaseStatus` moves from `unpublished_candidate` to
  `accepted_release`; the compatibility manifest still declares
  `supportedAosReleases: []` — no AOS pair, no connected mode.

## 0.1.0-rc.6 — 2026-07-19

### Fixed — data loss and permanent-lockout defects

- **Knowledge stores no longer brick on a rejected mutation.** `createKnowledgeUnit`
  and `rebaseKnowledgeStore` held the mutation claim across a failable region with
  no `finally`, so every failure that left the process alive leaked the claim and
  each later mutation answered `KNOWLEDGE_LOCKED` forever, with no verb able to
  clear it. A simulated crash still retains the claim, because a real SIGKILL never
  runs a `finally` and the retained claim is what marks the store mid-write; that
  exemption is now explicit and covered by a test in every mutation verb.
- **A crash during lease recovery no longer makes a Workspace unopenable.** The
  recovery claim recorded `pid` and `expiresAtNanoseconds` that nothing ever read,
  so `acquire` refused unconditionally on EEXIST. A claim is now reclaimed when it
  has expired *and* its pid is dead — the same probe the lease owner already used,
  and fail-closed in both directions of pid reuse. Malformed, linked, and
  special-file claims still fail closed.
- **`conference-append-position` no longer discards its author.** The core input
  reused one `actorId` slot for the position author and the attestation actor, so
  supplying `--actor` silently overwrote a required flag's value. The author is now
  its own field.

### Fixed — admission holes

- **Enum fields no longer admit values that merely coerce to a member.** Fourteen
  membership tests across protocol, the adapters, the Context Router, the Knowledge
  Core and the generic profile compared `String(value)` against the allowed list, so
  `["specified"]`, an object carrying `toString`, and a boxed `String` all passed.
  Numbers, `null`, and plain objects were always rejected — only those three shapes
  ever got through, and the negative cases now test exactly those.
- **`extension-registration.appliesTo` no longer accepts duplicate entries.** `Set`
  dedupe is identity-based, so two distinct `["work"]` arrays satisfied both the
  membership test and the duplicate test.

### Fixed — sandbox escapes

- **Six ways out of the offline guard and child-process policy are closed.** The
  guard patched CommonJS module objects only, so an ESM named import kept the
  original function; `net.Socket.prototype.connect`, `dns.promises`,
  `node:dns/promises` and `http2` were never patched at all. The child policy
  refused `stdio: "inherit"` only in that exact spelling, missing array, descriptor
  and stream forms, and `isNodeExecutable` never matched for `exec`, which takes a
  command line rather than an argv[0]. `execSync` and `execFileSync` were absent
  from the guarded API list entirely — the widest of the gaps, and one the original
  review did not name.

### Fixed — activation and installer

- **The settings rename is now the sole commit point of an activation install.**
  Two failable reads sat after it; either throwing left `settings.json` carrying a
  hook that pointed at a script the cleanup had just deleted, with the merge key
  blocking every retry and nothing able to restore the user's previous settings.
- **A concurrent `settings.json` edit is no longer overwritten in silence.** The
  merge was computed from a read taken before the bundle was written and applied
  wholesale; the bytes are now re-read and compared immediately before the commit.

### Performance

- **`verify:privacy` 56.6s to 2.4s (23.9x).** The object database was walked with
  two `spawnSync` git calls per object, roughly five thousand processes; it is now
  one `cat-file --batch-all-objects --batch` stream. `verify:p1` overall fell from
  133s to 81s. Scanned-entry and object counts are identical to the baseline.
- **`validateEventChain` no longer rebuilds every event twice** (392ms to 238ms on
  3000 1 KiB events), and `validateWorkGraph` validates the extension registry once
  per graph instead of once per record (559ms to 50ms on 5000 records against a
  64-entry registry).
- **Archive verbs no longer read every bundle only to discard it** — up to 512 MiB
  of I/O per store-resolving verb, for a partial-state check the surrounding lstat
  gates already answered.

### Changed — contracts and catalog

- Four `COMMAND_CATALOG` `valueKind` entries were wrong: `exchange-validate --bundle`
  is a path not JSON, both `adapter-simulate --lifecycle` flags are JSON not strings,
  and `profile-authorize --command` is a command id not JSON. An agent obeying the
  machine-readable contract would have failed on all four.
- `artifact-archive-apply` and `artifact-archive-restore` now declare
  `availability: "fixture-only"`. The spec always restricted them to `FIXTURE-`
  Workspaces — "the live local graph is therefore ineligible" — but the catalog did
  not say so, so an agent planning from it would schedule a verb designed to fail.
- `lease-recovery-break` and recovery-claim reporting in `lease-inspect` build the
  operator path `file-engine-v1.md` already promised; that spec clause is narrowed
  to match what the code now does.
- A malformed integer flag is now a syntax error naming the flag, not a semantic
  refusal. `--target-version abc` answered `WORKSPACE_MIGRATION_DOWNGRADE` with the
  message `"NaN"`; `--expected-revision`, `--stale-days`, and the knowledge
  `--limit`/`--offset` pair each handed their `NaN` to core and reported whatever
  judgement came back. All answer `CLI_ARGUMENT_MALFORMED` now. Every value that
  *is* an integer still reaches core, so no range or downgrade judgement moved —
  `--target-version 0` and `-1` are still core's call.
- A supplied-but-empty flag is no longer dropped on the floor. `--limit=` and
  `--segment-events=` were swallowed by a truthy guard and the verb answered as if
  the flag had been omitted; they now behave as the `0` they parse to.
- `work-list --parent-id null` finds the record `work-create --parent-id null`
  made. `work-create` accepted both sentinel spellings and `work-list` compared
  against only one, so an agent could create a root work item and never find it
  again with the identical spelling. That was a silent wrong answer.
- `docs/architecture/agent-integration-v1.md` gains a behaviour-delta section:
  seventeen observable changes since rc.5, two of which are admissions that used to
  succeed, and one of which changes retriability — an authority receipt that grows
  past its ceiling mid-read now reports a terminal limit code instead of the
  retriable `*_CHANGED`.

### Fixed — governance tooling

- `regen-rc1-inputs` treated every argument that was not `--check` as a request to
  write, so a typo silently rewrote the pinned RC1 proof basis. Unknown arguments
  now fail closed.
- Four dead release helpers and two dead `files.mjs` exports are retired. The
  `routeAdditions` prune this package also planned was attempted and reverted: the
  premise was verified circularly against the generator's own output, and the
  generator test proved the ledger still admits paths the declared set does not
  carry.
- Three type errors that made `workspace.ts` and the CLI uncompilable under a real
  `tsc` are fixed — `FileIdentity` was used eight times and declared nowhere, the
  CLI imported a `ProjectRecord` the protocol package never exported, and two
  parameters took their type from a default value. A first real `tsc` run reported
  147 errors across 14 files, not the 126 previously recorded and not the 167 an
  earlier draft of this entry claimed; both were estimates taken before a compiler
  was pinned. All 147 are now fixed, and the `typecheck` gate runs the pinned
  TypeScript 5.9.3 against the repository `tsconfig.json`, failing on any
  diagnostic. No type error is carried as debt.
- `pnpm push-gate` refuses a push whose version is announced inconsistently. This
  release cut advanced `package.json` and `FRAMEWORK_VERSION`, which `verify:p8`
  checks, and left the status badge in all five READMEs reading rc.5, which nothing
  checked — the gate exists for that class, the consequence of a change rather than
  the change itself. It runs `verify:p1` and `verify:p8`, treats any warning as a
  failure, and refuses a push whose version is already tagged at a different commit.
  It adds no `task.mjs` handler, no `verify:*` script, and no claim, so it is not a
  new gate under the proof-budget rule.

### Documentation

- Both READMEs lead with the problem rather than a capability inventory, and each
  names who the project is *not* for. All four translations are rebuilt from the
  corrected English.

- Make the replay complexity proof see the reducer's full-collection scans
  (CQ-10b). `materializeWorkspace` performs four scans inside its per-event loop
  — the whole work map on `work.deleted` and on `project.deleted`, the whole gate
  collection on a work transition to `done`, and full copies of the conference
  and minutes maps on a `gate.updated` to `satisfied` — and none of them
  incremented a counter the WSA-5 proof asserts on. New `collectionScan` and
  `collectionScanRecordsVisited` metrics count every one, and three new fixtures
  in `tests/p3-engine-complexity.test.mjs` (delete-bearing, done-transition,
  gate-satisfied) pin each arm's exact closed form. The existing append-only
  fixture now asserts zero scans. Behaviour is unchanged: counting only, replay
  bytes, record order, digests and reason codes are identical.
- Correct the P3 compaction-deferral proof, which stated "there is no quadratic
  term". That was false — the four scans above are quadratic terms. The document
  now names each arm, records the measured paired A/B (removing all four scans is
  4.0% of replay at the reachable ceiling, state byte-identical), and notes that
  the binding constraint is the 1 MiB canonical view-document limit reached at
  ~2,000–3,000 work records, not the 10,000-event cap.
- Decline OD-15 option 1 as measured: the four scans are retained rather than
  replaced by incrementally maintained indices. Three of them are fail-closed
  corruption checks, the shape that would exercise them is unreachable before the
  view-serialization limit bricks the workspace, and the measured upper bound on
  the whole change is 4%. The dominant replay cost is the one full replay per
  mutation (WSA-1, by design), which is roughly 40x larger.
- Unify the three drifted copies of the hardened authority-receipt reader onto a
  single shared implementation (`packages/core/src/authority-file-reader.ts`)
  carrying the strongest variant of each check: nanosecond `bigint` stat
  precision, `mode` in both the descriptor-identity recheck and the
  `sourceIdentityDigest`, a chunk-bounded read in place of an unbounded
  `readFile()`, `ELOOP` classified as a link rather than a generic change, and a
  guarded post-read `lstat` so unexpected filesystem errors can no longer escape
  untyped. Each caller keeps its own error class, reason-code family, post-read
  validator and admission branding; the shared reader takes an injected `fail`,
  a reason-code map and an `isOwnError` predicate. The Context Router and generic
  profile readers gain the mode, nanosecond, bounded-read and `ELOOP`
  protections they previously lacked.
- Normalise directory-as-authority reporting (OD-6): the Context Router and
  generic profile readers now report `CONTEXT_AUTHORITY_SPECIAL_FILE` and
  `PROFILE_ADMISSION_SPECIAL_FILE` for a directory, where they previously
  reported the `*_LINK` code because the `nlink` gate preceded the `isFile()`
  gate. Compatibility modes already reported the special-file code and is
  unchanged. `sourceIdentityDigest` values move for the Context Router and
  generic profile readers; the digest is derived from live inode data and was
  never reproducible across machines, checkouts or copies, so no stored value
  could have pinned it.

## 0.1.0-rc.5 — 2026-07-18

- Ship the governed conference and gate surface on the local candidate: nine
  governed CLI verbs (`conference-open`/`-append-position`/`-close`/`-cancel`,
  `gate-create`/`-transition`/`-delete`, `conference-list-by-work`, `gate-list`)
  persist `conference.*`/`gate.*` records as additive hash-chained workspace
  events through the single SDC-2 payload constructor, under a held lease and
  the engine `expectedVersion` CAS, with byte-identical views/export/archive for
  workspaces that carry no extension events and a conditional
  `views/extensions.json` index.
- Enforce fail-closed decision gates: a non-tombstoned pending gate anchored to a
  work item blocks that item's transition to `done` with `WORKSPACE_GATE_PENDING`
  at the verb and identically on replay (`WORKSPACE_EVENT_CORRUPT`), and a gate
  reaches `satisfied` only against a resolvable `conference-minutes` locator whose
  conference anchors the gate's work item; the frozen work status graph is
  unchanged — the precondition only narrows admissible transitions.
- Enforce actor attestation at the enable boundary: appending the one-way
  `attestation.actor.enabled` chain event (`attestation-enable`) makes a valid
  actor id mandatory from that sequence onward on both the live append path and
  the replay reducer (`WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID`), a
  duplicate enable fails `WORKSPACE_INPUT_INVALID`, and a workspace that never
  enables it stays byte-identical to `0.1.0-rc.4`.
- Land the three-step Claude Code activation ladder as gated, byte-reversible
  capability: the Step-1 installer writes the four inert bundle templates under
  `.claude/tcrn-workflow/` (O_EXCL/O_NOFOLLOW, never touching
  `.claude/settings.json`), Step 2 merges exactly one fail-open `SessionStart`
  hook (the sole authorized fail-open surface — any induced failure exits 0 as
  plain Claude Code), and Step 3 renders the single advisory Verity persona
  authority summary within the 1024-byte injection budget; nothing under
  `~/.claude` is ever named or written and every step is exact byte-inverse on
  rollback.
- Add snapshot backup and a hermetic restore round-trip: a lease-held
  `snapshot-manifest` emits a deterministic per-file manifest, `snapshot-verify`
  reports `SNAPSHOT_VERIFIED`/`SNAPSHOT_MISMATCH`, the restore runbook
  round-trips snapshot → wipe → restore byte-identically at the original path
  with both doctrine failure modes failing closed, and an optional git tier-2
  serves as an integrity witness only.
- Extend the Knowledge Core: capture-cheap `knowledge-create`, governed
  `knowledge-rebase` head re-binding (`KNOWLEDGE_REBASE_BLOCKED` on unresolved
  references), the reverify/retire lifecycle under CAS
  (`KNOWLEDGE_LIFECYCLE_INVALID`), unconditional promotion governance
  (`KNOWLEDGE_PROMOTION_INVALID`), and close-time conference distillation of each
  minutes decision into a backlinking knowledge candidate the unchanged creation
  contract accepts.
- Remove the quadratic replay cost: an n-event chain runs exactly one terminal
  full-graph validation plus one ancestor-bounded O(delta) closure per work
  event, proven by closed-form operation-count equality.
- Document the agent-integration CLI consumption contract — envelopes, the retry
  table for `WORKSPACE_VIEW_STALE`/`WORKSPACE_LOCKED`/`WORKSPACE_CAS_MISMATCH`
  (plus the lease verbs, `WORKSPACE_GATE_PENDING`, and `SNAPSHOT_*` codes), the
  `-`/`null`/`head` sentinels, and determinism guarantees — with a drift-guard
  test binding the prose to the live command catalog.
- Add opt-in, advisory time-attestation receipts via `--attest-dir` on every
  workspace-event mutation verb: the engine reads no clock, receipts write only
  outside the workspace root, embed no path or hostname, and carry no governance
  weight; export and archive bytes are identical whether or not receipts exist.
- Document the `settings-catalog-v1` conference and backup knobs, expand the
  one-page protocol stub specs to normative weight, and record the
  proof-to-product budget rule as a reviewer-enforced `CONTRIBUTING` policy.
- Prove the flagship end-to-end governed loop: one hermetic replay of
  initiative → epic → story → gate → conference → distill → promote → trace on a
  real workspace, every tutorial command executed verbatim and every produced
  digest traced to its producer (`pnpm verify:e2e`).
- Add `docs/architecture/rc5-compatibility.md`: the rc.4 → rc.5 workspace
  compatibility and migration matrix (intentional forward-incompatibility of
  conference/gate/attestation events under `storageVersion 1`, the one-way
  attestation boundary, and the disposable knowledge-store re-initialization
  procedure).

- Re-cut the MVP scope to two officially supported V1 Agent Apps (Codex and
  Claude Code) for the `0.1.0-rc.4` unpublished local candidate: add the inert
  Claude Code adapter (P6B), the additive `dependency-v1` extension, the
  `conference-v1`/`assignment-v1`/`gate-v1` skeletons, the `work-log-v1` and
  `settings-catalog-v1` documentation specs, and public requirement ledger
  entries `AOS-REQ-015..019`. `work-model-v1`, `codex-adapter.ts`, and the
  generic starter path are unchanged.
- Repair the CI package-manager bootstrap with explicit online acquisition of
  pinned Node and pnpm, then retain frozen dependency acquisition and offline
  P1 verification for the `0.1.0-rc.3` unpublished local candidate.

- Add the deterministic `0.1.0-rc.1` unpublished local Workflow release
  candidate proof, canonical USTAR source archive, closed six-artifact release
  set, sanitized Core Reference projection, and P8 verification command.

- Prepare the immutable unpublished `0.1.0-rc.1` Workflow release candidate
  with deterministic source/release artifacts, SBOM, provenance, closed
  allowlist, sanitized Core Reference projection, and offline P8 proof.

- Establish the clean-history P1 framework bootstrap.
- Pin the toolchain and offline deterministic verification commands.
- Define external release-trust-root verification and privacy boundaries.
- Freeze the P2 Protocol V1 schemas, specifications, conformance fixtures,
  generic AOS requirements ledger, P3 marker contract, and unaccepted RC1
  candidate proof manifest.
- Freeze runtime-independent UTF-8 byte ordering, exact nanosecond instant
  comparisons, closed runtime/schema parity, and executable adversarial vectors
  with offline Draft 2020-12 evaluation.
- Reject malformed Unicode across canonical protocol/proof/trust surfaces,
  align the 161-character stable-ID and extension-name schema boundary, and
  enforce vulnerability policy over the complete frozen dependency graph.
- Emit shared canonical objects directly in UTF-8 byte order, preserving every
  own key, and close RC1 candidate and verdict-slot field admission.
- Add the P3 file-native Workspace/event-engine candidate with governed CRUD,
  leases/CAS, no-follow atomic segments, crash recovery, deterministic views,
  dry-run migration planning, and filesystem fault proof without a P3 marker.
- Close RC-P3 root-entry schema parity, exact event lifecycle and Workspace
  identity binding, and exclusive crash/race-safe lease recovery proof.
- Serialize same-lease mutation admission with an identity-bound filesystem
  claim so concurrent same-version writes cannot silently replace an event.
- Add the bounded P4 artifact lifecycle candidate: closed classification,
  deterministic doctor/size and compact projections, redacted metadata-first
  references, and disposable-only archive apply/restore with fault proof.
- Add the bounded P4 file-native Knowledge Core candidate with closed metadata,
  separate explicit body reads, deterministic filters/indexes/checkpoints,
  freshness and promotion CAS, inert locators, strict limits, and disposable
  filesystem fault proof without live-store initialization.
- Close Knowledge metadata/body access separation, default-checkpoint parity,
  accountable source/evidence provenance, selection and strict-instant
  admission, UTF-8 byte-budget schema proof, and 64 actual-store insertion
  permutations.
- Close RC2 defensive boundaries for pre-claim Knowledge promotion admission,
  ownerless stale-lease generation quarantine, and incremental transient/archive
  storage exhaustion enforcement.
- Add the bounded P5 generic profile-policy candidate with closed trust and
  binding, deterministic precedence, exact merge classes, owner-rebind gating,
  canonical digests, read-only CLI surfaces, 64 insertion permutations, and a
  disposable empty-Workspace planned-delivery cold-start proof.
- Bind P5 trust admission to the frozen framework base and independent,
  descriptor-validated receipts; authorization now re-resolves untrusted
  request bytes and rejects standalone effective-profile capabilities.
- Require an out-of-band governed canonical path and raw receipt-file digest;
  P5 receipts now bind the complete request and derived effective profile, so
  caller-minted, copied, or replaced canonical receipts cannot authorize.
- Add the sanitized eight-record Core Reference persona bundle, closed schema,
  display-only release layers, read-only CLI, and deterministic/privacy proof.
- Add the bounded P6 Context Router with descriptor-bound request authority,
  admitted profile re-resolution, metadata-first and explicit-read selection,
  and privacy-minimal receipts.
- Add the Codex Adapter only as an uninstalled inert-template candidate with
  separate host injection, authority-empty fallback, deterministic bundle,
  identity-bound rollback planning, final-hop simulation, and no OG-04, RC3,
  store, hook, Skill, configuration, or activation claim.
- Require exact canonical template bytes, positional bundle/schema parity, and
  a pinned no-follow descriptor-verified installation-generation receipt before
  inert rollback planning; caller-supplied identity objects no longer admit it.
- Add P7-B offline Compatibility And Modes planning with a closed Workflow
  manifest, governed pair-receipt admission, policy rollback/replay controls,
  field-level AOS ownership preservation, and exact unavailable live surfaces.
- Bind P7-B admission to a no-follow host-anchored canonical authority receipt,
  normalize semantic sets before hashing, and prove recursive JSON and exact
  aggregate-document limits across schema and runtime.
- Bound P7-B authority receipt reads to 65,537 observed bytes so concurrent
  same-inode growth fails immediately without unbounded allocation or I/O.
