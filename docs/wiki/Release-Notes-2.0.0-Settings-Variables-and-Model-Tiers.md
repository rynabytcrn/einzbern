# Einzbern 2.0.0 发行说明：设置、变量与模型档位

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 7/13：设置、变量与模型档位

上一模块：[受管段、Command Spell 与门](Release-Notes-2.0.0-Managed-Sections-Rules-and-Gates.md) · 下一模块：[跨项目协作](Release-Notes-2.0.0-Cross-Project.md)

## Configuration has two layers

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

## The settings shrink and each model tier names its runner

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

## Every row of `settings-catalog` and `machine-settings-catalog` carries its layout

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

## The model categories and the model tiers are two tables of records

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

## A rule's record escalates along the order of `models.tiers`

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

## The `variables-system` section of AGENTS.md renders every system setting

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

## The `effectiveValue` of a `settings-set` or `settings-remove` receipt is the key's `currentValue`

The `effectiveValue` of a `settings-set` or `settings-remove` receipt is the key's `currentValue` in
`settings-catalog` (TCRN-CROSS-STORY-510 R2, TCRN-CROSS-SUB-417; fixes TCRN-CROSS-STORY-508;
`packages/cli/src/index.ts`). The receipt reads it with the arguments `settings-catalog` uses, the
library's segment size for an unset `storage.segmentBytes` included, so the two agree on an unset
`models.category`: the default categories and every other category `models.tiers` names. Removing
`models.category` while a tier record names a category outside the default table now receipts that
category too, where the receipt used to echo the default table. A set key's receipt still carries
its value, and any other unset key's its default. The receipt's fields, what `receiptDigest` is
taken over and the reason codes are unchanged.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[受管段、Command Spell 与门](Release-Notes-2.0.0-Managed-Sections-Rules-and-Gates.md) · 下一模块：[跨项目协作](Release-Notes-2.0.0-Cross-Project.md)
