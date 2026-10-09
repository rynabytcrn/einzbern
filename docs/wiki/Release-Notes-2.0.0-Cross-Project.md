# Einzbern 2.0.0 发行说明：跨项目协作

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 8/13：跨项目协作

上一模块：[设置、变量与模型档位](Release-Notes-2.0.0-Settings-Variables-and-Model-Tiers.md) · 下一模块：[Atelier](Release-Notes-2.0.0-Atelier.md)

## Work items record the projects they involve

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

## Gates plan and run a Cross Project work item per involved target and per registered repository

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

## Setup, migration and gate handoffs

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

## Projects and targets read whole

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

## A coordination chain keeps its own runtime settings

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

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[设置、变量与模型档位](Release-Notes-2.0.0-Settings-Variables-and-Model-Tiers.md) · 下一模块：[Atelier](Release-Notes-2.0.0-Atelier.md)
