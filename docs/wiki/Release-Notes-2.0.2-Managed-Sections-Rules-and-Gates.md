# Einzbern 2.0.2 发行说明：受管段、Command Spell 与门

[发行说明](Release-Notes.md) › [Einzbern 2.0.2](Release-Notes-2.0.2.md) › 模块 1/2：受管段、Command Spell 与门

下一模块：[发行与仓库工具](Release-Notes-2.0.2-Release-and-Repository-Tooling.md)

## The built-in batch processing v3 text carries the Owner's revision of MIN-246 D11

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

---

[返回模块目录](Release-Notes-2.0.2.md) · 下一模块：[发行与仓库工具](Release-Notes-2.0.2-Release-and-Repository-Tooling.md)
