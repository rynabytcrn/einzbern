# Einzbern 2.2.0 发行说明：受管段、Command Spell 与变量

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 3/9：受管段、Command Spell 与变量

上一模块：[知识与纪要](Release-Notes-2.2.0-Knowledge-and-Minutes.md) · 下一模块：[配置写入与 Owner 决定](Release-Notes-2.2.0-Configuration-Writes-and-Owner-Decisions.md)

## A coordination library now writes managed sections too, into the one project root this device's registry holds for it outside every library: the container it coordinates

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

## A coordination library's system variable section lists the settings that hold for it, each with its effective value and source

A coordination library's system variable section lists the settings that hold for it, each with its
effective value and source: `execution.maxConcurrentSubagents`, the four `quota.*` settings and the
seven `design.*` bindings, and no `models.*` or `execution.dispatchTiers` (TCRN-CROSS-STORY-540,
TCRN-CROSS-SUB-506, EPIC-150 R7). Both variable sections, for any library, now follow
`artifact.language`: `zh-CN` writes their headings, notes, table headers and placeholders in
Chinese, and any other value, or none, the English they always had. `variable-set` and
`variable-remove` on a coordination library render its sections again into its registered root;
`settings-set` still renders nothing.

## Setup's repair now plans and writes the managed sections of a coordination library's registered container, from the coordination library's own configuration, and an update still writes no project file

Setup's repair now plans and writes the managed sections of a coordination library's registered
container, from the coordination library's own configuration, and an update still writes no project
file (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-507, EPIC-150 R7). The managed-sections check of `doctor`
lists every recorded section with its state in `detail.sections`, and reads a coordination library's
container against that library's records.

## Two rules join the built-in catalog after `design-authority`, at version 1 and off until a project enables them

Two rules join the built-in catalog after `design-authority`, at version 1 and off until a project
enables them (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-509, EPIC-150 R9, MIN-258 D3, MIN-259 D1):
`residue-cleanup`, the Owner's rule for clearing what a task or a batch leaves behind, and
`goal-writing`, the contract for writing a session goal. Their Chinese text is the Owner's wording;
the English of `residue-cleanup` and the opening paragraph of `goal-writing` are translations that
await the Owner's correction. The catalog now holds seven rules.

## `unattended-commands` is now at version 2

`unattended-commands` is now at version 2 (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-514, EPIC-150 R9,
MIN-258 D3, MIN-259 D2). Its first clause gains one sentence: with the Owner's authorization, the
skill's trash-empty tool empties the named trash directories under the session's scratch directory,
plan first, one authorization per report of paths and sizes. Every other line is version 1's. A
project that enabled version 1 reads `update-available`, and neither that read nor `agents-render`
changes its AGENTS.md; `rule-enable` takes version 2.

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[知识与纪要](Release-Notes-2.2.0-Knowledge-and-Minutes.md) · 下一模块：[配置写入与 Owner 决定](Release-Notes-2.2.0-Configuration-Writes-and-Owner-Decisions.md)
