# Einzbern 2.0.0 发行说明：受管段、Command Spell 与门

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 6/13：受管段、Command Spell 与门

上一模块：[知识](Release-Notes-2.0.0-Knowledge.md) · 下一模块：[设置、变量与模型档位](Release-Notes-2.0.0-Settings-Variables-and-Model-Tiers.md)

## The engine writes only its own sections of a project's AGENTS.md and CLAUDE.md

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

## Gates are declared per project and chosen by the change

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

## A project can switch on Command Spell rules

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

## Custom variables, Command Spell rules and gates each take an optional order

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

## A model no longer switches Command Spell rules or declares gates through the CLI

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

## A managed-section write whose records cannot be committed no longer leaves the file half changed

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

## The built-in batch processing v3 text carries the Owner's fifth round

The built-in batch processing v3 text carries the Owner's fifth round (TCRN-CROSS-INIT-053 R48,
MIN-242 D10): clause 8, knowledge is captured per round (each round's judgment produces
`lessons.json`, and the main thread records each lesson as a card with `knowledge-capture` and reads
it back). The Chinese text equals the Owner's archived wording; the English of clause 8 is an agent's
translation that awaits the Owner's correction. The version stays at 3: an unchanged enabled section
takes the revised text at the next `agents-render` with its section revision raised by one, and a
section the user changed keeps its `user-modified`/`pending` protection.

## The built-in Command Spell texts carry the Owner's revision of 2026-10-08

The built-in Command Spell texts carry the Owner's revision of 2026-10-08 (TCRN-CROSS-INIT-053
R40): batch processing v3 adds clause 7, that "once" counts per round, and silent reporting v1
adds that no report falls between two rounds. The Chinese texts equal the Owner's archived wording;
the English of both additions is an agent's translation that awaits the Owner's correction. The
versions stay at 3 and 1, as for every correction of a text: an enabled rule still reads `enabled`,
an unchanged section takes the revised text at the next `agents-render` with its section revision
raised by one, and a section the user changed keeps its `user-modified`/`pending` protection.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[知识](Release-Notes-2.0.0-Knowledge.md) · 下一模块：[设置、变量与模型档位](Release-Notes-2.0.0-Settings-Variables-and-Model-Tiers.md)
