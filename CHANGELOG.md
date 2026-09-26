# Changelog

All notable changes will be documented here. The project uses Semantic
Versioning after the first accepted release.

## Unreleased

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
