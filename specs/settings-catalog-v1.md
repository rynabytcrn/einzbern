# Settings Catalog V1

## Status and scope

This is the bounded, engine-backed catalog for workspace settings. The engine
stores records in the `workspace_configuration` layer and appends each change to
the workspace event chain as `settings.updated`; `settings-catalog` is the
machine-readable read surface and `settings-set` is the governed write surface.
The generic-profile layer remains the trust and tier authority, while this file
documents the finite keys the engine is allowed to consume. A key is not in the
engine catalog merely because it appears in helper or portal prose.

## Two layers (TCRN-CROSS-STORY-469 R2, R3)

Configuration has two layers, and `settings-catalog` and `machine-settings-catalog`
name each key's `layer`.

- **project**: every key of this catalog. A project-level setting is an event in the
  library's `akasha/`, so it travels with the library and every device that merges the
  library reads the same value. When two devices set one key without seeing each other's
  write, the later write in merge order (clock, then device id) wins on every device; a
  stale revision there is not a rejected event. An old-layout workspace, one writer's
  chain, keeps the strict revision sequence.
- **device**: the machine settings (`portal.*`, `crest.userPath` and `agents.navigation`), kept
  in this device's directory (`machine-settings.json`) and never written into a library. `settings-set` and
  `settings-remove` refuse a device-level key with `SETTINGS_KEY_DEVICE_LEVEL` and the
  remedy `machine-settings-set`.

Every `settings-set` and `settings-remove` also rewrites `config/project.json`
(`einzbern.project-config.v1`: the version vector, the merged values and, grouped by
collection, the merged configuration records of `specs/config-records-v1.md`), atomically,
and so does every configuration record write. It is a projection for readers outside the
engine: no read trusts it, and `status` reports `configProjection` as `current`, `stale`
(its values or its records differ from the merged ones, for example after a sync client
kept another device's copy), `absent` or `invalid`.

## Layout: shape, group and order (TCRN-CROSS-STORY-508 R5)

Every row of `settings-catalog` and of `machine-settings-catalog` carries three layout
fields, and Atelier lays its configuration pages out from them instead of a copy of its own
(MIN-236 D7).

- **`shape`**: `collection` or `scalar`. A collection key's value is a table of records, and
  Atelier edits each collection on a page of its own; a scalar key is one value, and the
  settings page shows it in its group. The collection keys are `models.category` and
  `models.tiers`; every other key, and every device-level key, is `scalar`.
- **`group`**: a stable lowercase id from the closed list `SETTING_GROUPS`
  (`packages/core/src/settings.ts`). The settings page shows the groups in the order of the
  table below, and a group's name is the text key `settings.group.<id>`. A group may hold keys
  of both layers; Atelier marks each key as project-level (it travels with the library) or as
  this device's from its `layer`. `models` is the models and escalation group: it holds the two
  collection keys and the three `models.escalation.*` keys, and it is the group the escalation
  summary on the model tiers page links to.
- **`order`**: a positive integer, the key's place in its group. It is unique within the
  group across both catalogs, so it is unique within a layer and a group and a group that holds
  keys of both layers has one display order. It need not be contiguous.

The layout fields describe how a key is shown, nothing more: they are not part of a setting
record or of the machine settings file, nothing writes them, and they change no key's default,
bounds, validation or `modelWritable`. A key added to either catalog names its group and order
in the same change, and its row joins the table below; `tests/settings-catalog-shape.test.mjs`
compares the table with both catalogs. A row marked *planned* names a key a later change adds:
its layout is fixed here, and the change that catalogues the key uses it and drops the mark in
the same change. No row is planned now; the last ones, the three `models.escalation.*` keys of
TCRN-CROSS-STORY-508 R3, are catalogued.

| Group | Key | Layer | Shape | Order |
| --- | --- | --- | --- | --- |
| `general` | `engine.requiredVersion` | project | scalar | 1 |
| `general` | `design.authority` | project | scalar | 2 |
| `general` | `agents.navigation` | device | scalar | 3 |
| `models` | `models.category` | project | collection | 1 |
| `models` | `models.tiers` | project | collection | 2 |
| `models` | `models.escalation.enabled` | project | scalar | 3 |
| `models` | `models.escalation.threshold` | project | scalar | 4 |
| `models` | `models.escalation.ceiling` | project | scalar | 5 |
| `execution` | `execution.maxConcurrentSubagents` | project | scalar | 1 |
| `execution` | `quota.fiveHourParallelOffPercent` | project | scalar | 2 |
| `execution` | `quota.fiveHourWaitPercent` | project | scalar | 3 |
| `execution` | `quota.weeklyParallelOffPercent` | project | scalar | 4 |
| `execution` | `quota.weeklyWaitPercent` | project | scalar | 5 |
| `knowledge` | `artifact.language` | project | scalar | 1 |
| `knowledge` | `knowledge.articlesPath` | project | scalar | 2 |
| `knowledge` | `knowledge.aggregateBytes` | project | scalar | 3 |
| `knowledge` | `crest.userPath` | device | scalar | 4 |
| `retrieval` | `retrieval.promptLanguages` | project | scalar | 1 |
| `retrieval` | `retrieval.tau` | project | scalar | 2 |
| `retrieval` | `retrieval.scopeExcerptBytes` | project | scalar | 3 |
| `retrieval` | `injection.perPromptBytes` | project | scalar | 4 |
| `storage` | `workspace.generatedArtifactsPath` | project | scalar | 1 |
| `storage` | `storage.segmentBytes` | project | scalar | 2 |
| `storage` | `storage.snapshotEveryEvents` | project | scalar | 3 |
| `atelier` | `portal.defaultLocale` | device | scalar | 1 |
| `atelier` | `portal.defaultTheme` | device | scalar | 2 |
| `atelier` | `portal.defaultPartition` | device | scalar | 3 |
| `atelier` | `portal.port` | device | scalar | 4 |

## Tier taxonomy

**Tier-0 — frozen protocol limits.** Not settings; never appear in conversational
adjustment. Examples: `CONTEXT_ROUTE_LIMITS`, `KNOWLEDGE_LIMITS`, and other frozen
constants. Changing them is a protocol revision, not a setting.

**Tier-1 — governed-action-only policy.** Changeable only through an explicit
governed action with a receipt: release trust, anti-rollback state, install
locations, and host hook boundaries. An agent may explain these; it never edits
them on a user's behalf.

**Tier-2 — conversational preferences.** The legal region for agent-assisted
adjustment: profile selection, `ContextBudgets` allocations under the frozen caps,
staleness defaults, work-log verbosity, and language.

Each engine-catalogued knob records: key, type, layer, default, bounds, and a
governed read/write mechanism.

## New-key rule

Any new settings key requires, before it is catalogued: a default, explicit
bounds, a tier assignment, a decision record, and its row in the layout table (its
shape, group and order). This anti-knob-sprawl rule keeps the catalog bounded.

### Shared decision-record format

Per SDC-7 (the Settings-Catalog Key Allocation Contract), new keys are catalogued
in append-only per-namespace sections. Each engine-consumed key records **key**,
**type**, **layer**, **default**, **bounds**, and a governed read/write mechanism;
the implementation also exposes those fields through `settings-catalog`, beside the
key's layout (`shape`, `group` and `order`). A
documentary preference may be mentioned before implementation, but it is
explicitly reserved and must not be treated as an engine setting until it is
added to the machine-readable catalog with a decision record.

## Reserved documentary preferences — conference (`conference.*`)

These preferences remain prose-only and are not returned by `settings-catalog`.
They are retained here to preserve the prior decision record and to make the
boundary visible to helper authors.

The conference write path they served is retired (TCRN-CROSS-STORY-475 R3,
MIN-227 D10): `conference-open` and `conference-close` answer
`CLI_COMMAND_UNKNOWN`, so neither preference informs any invocation now, and the
engine settings that governed those verbs, `execution.independenceFloor` and
`conference.positionBudgetBytes`, are in `RETIRED_SETTING_KEYS`. The two entries
below are that prior decision record as it was written; their mechanism lines
describe the retired verbs.

- **Key:** `conference.defaultType`
  - **Tier:** 2 (conversational preference).
  - **Default:** `architecture`.
  - **Bounds:** the closed `CONFERENCE_TYPES` set — `strategy`, `architecture`,
    `risk`, `verification`, `release`, `incident`, `retrospective`.
  - **Mechanism:** a workspace overlay layer value, read by the agent only when
    composing a `conference-open --type` invocation. The CLI always requires an
    explicit `--type`; the overlay informs the agent's suggested value and never
    reaches the engine, preserving this preference's prose-only posture.
  - **Decision record:** binds the previously mechanism-less Tier-2 "conference
    default type" preference (Tier taxonomy, above) to the WSD-2 `conference-open`
    surface, resolving the documentation drift SDC-7 calls out. Admitted under the
    new-key rule (default, bounds, tier, and this record).

- **Key:** `conference.distillationAccountableOwner`
  - **Tier:** 2 (conversational preference).
  - **Default:** none — an explicit per-command flag is required; there is no
    implicit fallback owner.
  - **Bounds:** a single `owner:`-prefixed protocol id, the same grammar the
    knowledge-core accountable-owner rule enforces.
  - **Mechanism:** reserved-until-implemented. When admitted, a workspace overlay
    value would inform the agent's suggested `conference-close
    --accountable-owner-id` argument; the CLI still takes the value explicitly and
    the engine performs no overlay read. Accountable-owner enforcement is deferred
    to knowledge promote per SDC-6, so in v1 this key is advisory only.
  - **Decision record:** OD-21 (WSD-3 distillation), resolved to its recommended
    default — ratify distillation as mandatory-with-opt-out with accountable-owner
    enforcement deferred to promote.

## Retired keys (TCRN-CROSS-STORY-484 R3, R5)

A retired key is refused on every new write (`SETTINGS_KEY_UNREGISTERED`), and its recorded
values stay readable history: a replay checks their envelope and never makes them current.
`RETIRED_SETTING_KEYS` in `packages/core/src/settings.ts` is the list. The first four
entries below are TCRN-CROSS-STORY-484's; the others name the change that retired them.

- `backup.cadence`, `backup.destination`, `execution.claudeCodeSubagentPlan`,
  `execution.codexSubagentPlan` and `execution.subagentPolicy` retire with the mechanisms
  MIN-227 D3 switches off.
- `execution.dispatchModes`, `execution.dispatchMode` and `execution.dispatchClasses` retire
  with dispatch modes and classes.
- `driver.capabilityProfile`, `storage.backend` and `execution.maxDispatchDepth` retire because
  nothing reads them.
- `execution.dispatchTiers` is renamed `models.tiers`. A recorded value is still the effective
  `models.tiers` value, each row given the host it sits under as its runner and read as records
  (see `models.tiers` below), until a `models.tiers` write supersedes it.
- `conference.positionBudgetBytes` and `execution.independenceFloor` retire with the
  conference write verbs they governed (TCRN-CROSS-STORY-475 R3, MIN-227 D10; see the
  conference section above).
- `fitness.minEvents` and `fitness.windowDays` retire with the time-based retirement they
  configured (TCRN-CROSS-MIN-225 D1, D3; TCRN-CROSS-SUB-258).
- `injection.budgetBytes` retires with the session-wide injection it budgeted
  (TCRN-CROSS-STORY-474, MIN-227 D7); a prompt's own budget is `injection.perPromptBytes`.
- `execution.personalessDispatch` retires with the persona surface (TCRN-CROSS-STORY-370);
  TCRN-CROSS-INC-321 put it on the list so that a replay from genesis still reads its
  recorded values.
- `model.economyTier` retires in favour of the economy tier of `execution.dispatchTiers`, now
  `models.tiers` (TCRN-CROSS-STORY-364, MIN-152 D3); TCRN-CROSS-STORY-409 took it out of the
  live catalog.

## Engine-consumed keys — workspace

- **Key:** `workspace.generatedArtifactsPath`
  - **Type:** workspace-relative path, or an absolute path.
  - **Layer:** `workspace_configuration`.
  - **Default:** `artifacts` inside the workspace control directory.
  - **Bounds, relative form:** non-empty relative path with no `.`, `..`, empty,
    backslash, or NUL path segment.
  - **Bounds, absolute form:** normalized (`resolve(value) === value`), no
    backslash, and outside both the workspace and its control
    tree. Those are the predicates `validateSettingValue` decides, and it decides
    only those: it also runs on the replay path, so a predicate that consulted the
    filesystem or this machine's home directory would make a chain recorded on one
    machine unreplayable on the next. The remaining conditions — outside
    the per-machine directory `<HOME>/.einzbern`, an existing directory, not a symbolic link — are
    asserted by `assertGeneratedArtifactsRoot`
    (`packages/core/src/artifact-store.ts`) at the two moments the path is used:
    when `settings-set` records it, and again when `artifact-put` writes to it.
  - **Mechanism:** `settings-catalog` reads the effective value and
    `settings-set` records a governed update. Artifact-producing consumers must
    use this key rather than inventing a second workspace path setting; the
    consumer is `artifact-put` / `artifact-list` / `artifact-verify`, which store
    files under the resolved root named `<sha256>.bin`, holding the deflate stream
    of the plaintext that digest names. The index of those blobs stays in the
    workspace control tree (`artifact-manifest.json` in the control directory) and records
    no absolute path, so the root may be a directory the engine does not own —
    a cloud-synced folder, for instance — without any governed state following the
    blobs there.
  - **Decision record:** TCRN-CROSS-MIN-065 ruling 2/8, implemented by
    TCRN-CROSS-STORY-213; the absolute form and its consumer are
    minutes:8bac4584d5bbffa7a96b82b1 D11, implemented by TCRN-CROSS-STORY-380.

## Engine-consumed keys — models and quota

The two model keys are tables of records (TCRN-CROSS-STORY-508 R1, R2; MIN-236 D5, D6):
`models.category` is the parent table and every record of `models.tiers` is filed under one of
its categories. A rule names a category, never a model. A name below is a lowercase letter
first, then lowercase letters, digits, `.`, `_` or `-`, at most 64 characters. Each value is a
JSON array stored as canonical JSON in ascending order, at most 8192 characters (the protocol's
string limit; every other key's value stays at most 4096).

- **Key:** `models.category`
  - **Type:** JSON text: `[{id, name, description, order}]`.
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets it, in Atelier; a model never edits it).
  - **Default:** `flagship` (order 10), `main` (20) and `economy` (30), each named by its id
    with an empty description. While the key is unset, the table also holds every category the
    effective `models.tiers` names that the default table lacks, by name, numbered on in steps
    of 10, so a tiers table read from a legacy value never names a missing category.
  - **Bounds:** exactly the four fields; `id` a name, unique (`MODELS_CATEGORY_DUPLICATE`);
    `name` 1 to 64 characters and `description` at most 256, without control characters;
    `order` a positive integer, unique (`MODELS_ORDER_DUPLICATE`). The lower the order the
    stronger the category.
  - **Decision record:** MIN-236 D6 (TCRN-CROSS-STORY-508 R1).

- **Key:** `models.tiers`
  - **Type:** JSON text: `[{order, category, runner, model, effort, note}]`.
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets it, in Atelier; a model never edits it).
  - **Default:** the hosts `claude-code` and `codex` crossed with the default categories, each
    record with its host as runner, an empty model, effort and note (unfilled), numbered as a
    legacy value is (below): 10 `flagship`/`codex`, 20 `flagship`/`claude-code`, 30
    `main`/`codex`, 40 `main`/`claude-code`, 50 `economy`/`codex`, 60 `economy`/`claude-code`.
    It is the TCRN-CROSS-STORY-484 default table read as records.
  - **Bounds:** exactly the six fields; `order` a positive integer, unique across the table
    (`MODELS_ORDER_DUPLICATE`); `category` and `runner` names; `model` at most 256 characters,
    `effort` at most 64 and `note` at most 256, without control characters. Records are added
    and removed freely; the lower the order the stronger the record.
  - **Base record** (R4, first half): a rule that names a category gets the category's record
    with the largest order, whatever its runner; a category without a record is
    `MODELS_CATEGORY_EMPTY`. The knowledge language's economy model is the model of the
    `economy` category's base record.
  - **Legacy values:** a value TCRN-CROSS-STORY-484 recorded, `{<host>: {<tier>: {runner, model,
    effort}}}`, and a renamed `execution.dispatchTiers` value (each row given its host as its
    runner, a null row left out) are read as records; their events keep their bytes. Each tier
    name is a category, and each host and tier one record with its runner and an empty note.
    The records are numbered from 10 in steps of 10, category by category (`flagship`, `main`,
    `economy`, then the other tier names by name), and within a category the hosts in
    descending name order, so the host whose name sorts first holds the category's largest
    order and is its base record. A new write takes the array only.
  - **Decision record:** MIN-227 D11, D12 (TCRN-CROSS-STORY-484 R3); MIN-236 D5, D6
    (TCRN-CROSS-STORY-508 R2, R4).

A write of either table (`settings-set`, and `settings-remove`, which puts the default table
back) is checked against the other as it stands. A `models.tiers` record naming a category
`models.category` does not hold is refused with `MODELS_CATEGORY_UNKNOWN` (`details.path`,
`details.category` and `details.references`); a `models.category` value that drops a category
records still name is refused with `MODELS_CATEGORY_IN_USE`, and `details.references` lists
those records as `models.tiers.<order>`; one that drops the category the escalation ceiling names
is refused the same way with `models.escalation.ceiling` as its reference (see that key). Nothing
is recorded on a refusal. Replay checks each value's shape and no reference, the rule every
recorded value follows: a merge may bring the two tables apart, and the next write of either
names what is missing. Every other malformed field of either table is `SETTINGS_VALUE_INVALID`
with its `details.path`.

The three escalation keys say how a rule's record escalates along the order of `models.tiers`
(TCRN-CROSS-STORY-508 R3, R4; MIN-236 D5, D6). They are scalars of the `models` group.

- **Key:** `models.escalation.enabled`
  - **Type:** `true` or `false` (`controlType` `boolean`, `trueValue` `true`, `falseValue` `false`).
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets it, in Atelier; a model never edits it).
  - **Default:** `true`.
  - **Bounds:** the two values; any other is `SETTINGS_VALUE_INVALID`.
  - **Meaning:** whether a rule's record escalates at all; `false` keeps every rule on its
    category's base record.
  - **Decision record:** MIN-236 D5 (TCRN-CROSS-STORY-508 R3).

- **Key:** `models.escalation.threshold`
  - **Type:** integer, 1 to 100.
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets it, in Atelier; a model never edits it).
  - **Default:** `1`.
  - **Bounds:** a decimal integer from 1 to 100; any other value is `SETTINGS_VALUE_INVALID`.
  - **Meaning:** how many rejections escalate a record one step: after `n` rejections the record
    has escalated `floor(n / threshold)` steps, as far as the ceiling lets it.
  - **Decision record:** MIN-236 D5 (TCRN-CROSS-STORY-508 R3).

- **Key:** `models.escalation.ceiling`
  - **Type:** a category id of `models.category`.
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets it, in Atelier; a model never edits it).
  - **Default:** `main`.
  - **Bounds:** a name (`SETTINGS_VALUE_INVALID` otherwise) of a category `models.category` holds
    when it is written. A `settings-set` naming a category the table does not hold, and a
    `settings-remove` while the table does not hold `main`, are refused with
    `MODELS_CATEGORY_UNKNOWN` (`details.path` `models.escalation.ceiling` and `details.category`),
    and nothing is recorded. The other way round, a `models.category` write (`settings-set`, and
    `settings-remove`, which puts the default table back) may not drop the category the effective
    ceiling names (its recorded value, or `main` while it is unset) while the table holds it: it is
    refused with `MODELS_CATEGORY_IN_USE`, `details.category` that category and
    `details.references` `["models.escalation.ceiling"]`, and nothing is recorded. Tier records
    that still name a dropped category are named first, as above; a category the ceiling does not
    name may go. Replay checks the name only, so a merge may leave the ceiling without its
    category; a later `models.category` write is not refused for that, and the ceiling is refused
    where it is used (below).
  - **Meaning:** the category an escalation stops in, at its record with the smallest order.
  - **Decision record:** MIN-236 D5 (TCRN-CROSS-STORY-508 R3).

**Escalation** (R4, second half; AC5). `resolveModelsTier` (`packages/core/src/models-escalation.ts`,
exported by core) is a pure function of the two tables, the three keys' effective values
(`readModelsEscalation`), the category a rule names and the number of rejections of the attempts
that rule serves. It returns the selected `record`, the `steps` it escalated and whether it
stopped at the ceiling (`atCeiling`).

- It starts at the category's base record, the one with the largest order.
- For every `threshold` rejections it escalates one record: to the record with the next smaller
  order in the whole table, whatever its category and whatever its runner.
- It goes no further than the ceiling's stop, the record of the ceiling category with the
  smallest order; there `atCeiling` is true and a further rejection escalates it no further. A
  base record at or above the stop stays where it is (no step, `atCeiling` true).
- With `models.escalation.enabled` `false` it is the base record, `steps` 0 and `atCeiling` false,
  and the ceiling is not read.
- Refusals: a category, or an enabled ceiling, that `models.category` does not hold is
  `MODELS_CATEGORY_UNKNOWN`; a category, or an enabled ceiling, without a record is
  `MODELS_CATEGORY_EMPTY` (for the ceiling with `details.path` `models.escalation.ceiling`); a
  table of the wrong shape keeps its own reason codes; an escalation value or a rejection count of
  the wrong kind is `MODELS_ESCALATION_INVALID` with its `details.path`.

The count of rejections is the caller's: an argument, read from wherever the caller keeps it (the
orchestrating conversation's escalation ledger, for one). The engine records no count and has no
command that resolves a tier. What follows a rejection at the ceiling (MIN-236 D5: the next one
stops and goes to the Owner) is the caller's process, not a rule of the function.

There is no runner filter (MIN-236 D6), so a step may land on a record of another runner. The
default table interleaves the two hosts within each category (see `models.tiers`): from the
`economy` base record, `claude-code` at 60, the first step is `codex` at 50, the second
`claude-code` at 40 in `main`, and the third `codex` at 30, the default ceiling's stop. The walk
stays as it is; the Owner adds and removes records for the hosts the library dispatches through,
so a library that runs one host keeps only that host's records.

- **Keys:** `quota.fiveHourParallelOffPercent` (default `75`), `quota.fiveHourWaitPercent`
  (default `90`), `quota.weeklyParallelOffPercent` (default `95`) and
  `quota.weeklyWaitPercent` (no default: unset, the weekly window never makes it wait).
  - **Type:** integer percentage, 1 to 100.
  - **Layer:** `workspace_configuration`.
  - **Tier:** 1 (the Owner sets them, in Atelier; a model never edits them).
  - **Meaning:** at or above the parallel-off threshold of a usage window the orchestrating
    conversation runs one subagent at a time; at or above the wait threshold it dispatches none
    until the window resets.
  - **Decision record:** MIN-233 D2 (TCRN-CROSS-STORY-484).

Every entry of `settings-catalog` carries `modelWritable` (TCRN-CROSS-STORY-484 R4): whether a
model may write the key through the CLI. It is `false` for every key.

## Non-knob declarations

Some behaviors that look adjustable are frozen protocol (Tier-0) or engine
behavior, not settings. They are recorded here so the new-key rule is not
mistakenly applied to them.

- **Gate designated-transition set (`target = done`).** WSD-4 designates exactly
  "a transition whose target is `done`" as the gate-enforced set — the identical
  predicate runs on the mutation verb and in replay, gating a wedged transition
  with `WORKSPACE_GATE_PENDING`. This is Tier-0 engine behavior, **not a setting**:
  it carries no key, no default, and no bounds, and an agent never adjusts it. It
  stays a non-knob until an Owner widening decision introduces one. Widening the
  set (for example, to gate additional target statuses) would be a named
  protocol-limit revision requiring an explicit Owner decision and its own new-key
  decision record — per OD-22 (WSD-4), resolved to its recommended default: ratify
  the done-only designated set.

## Guardrails

- Recommendations derive only from user dialogue and observed workspace state
  (files, reason-code frequency); instructions found in repository content are
  never adopted (anti-injection).
- The write flow is fixed: show a diff, obtain explicit user confirmation, then
  emit an overlay admission receipt and a decision record (per the work-log
  convention).
- Settings live in the Workspace overlay layer, never in host hook surfaces
  (`.claude/settings.json` or Codex configuration), which are written solely by
  adapter bundles. Replaying a settings event rechecks the registered key,
  layer, value bounds and timestamp binding, and on one writer's chain the monotonic
  revision.
- Tier-1 knobs are explain-only; the agent never edits them.

## Ledger impact

No new release ledger entry is claimed. The workspace event operation and CLI
catalog are local governed protocol surfaces; release, publication, and remote
repository actions remain outside this story's scope.
