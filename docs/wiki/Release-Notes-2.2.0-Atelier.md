# Einzbern 2.2.0 发行说明：Atelier

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 6/9：Atelier

上一模块：[设备维护](Release-Notes-2.2.0-Device-Maintenance.md) · 下一模块：[Mana Orchestrate 技能](Release-Notes-2.2.0-Mana-Orchestrate-Skill.md)

## Atelier now manages a coordination library's rules, variables and AGENTS.md through its registered container

Atelier now manages a coordination library's rules, variables and AGENTS.md through its registered
container (TCRN-CROSS-STORY-540, TCRN-CROSS-SUB-508, EPIC-150 R7, MIN-258 D3): the Rules page shows
the container's AGENTS.md, names the file a coordination library writes or says why it writes none,
and its saves and resolutions reach that file. A write of `execution.maxConcurrentSubagents` or of a
`quota.*` setting renders a coordination library's sections again, and a write of
`artifact.language` renders every library's.

## Three writes that a model makes only with an Owner decision now have their place in Atelier

Three writes that a model makes only with an Owner decision now have their place in Atelier
(TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-513, EPIC-150 R7, MIN-258 D3). A Library tab on the status
page declares the chain identity after a confirmation step, and removes a registry entry with
`library-unregister`, the plan first and the removal once confirmed, never for the selected entry. A
Migrated gates section on the Gates page lists the gates still holding work back and the released
ones with who, when and why, and releases one with `work-gate-release` for a reason that is not
blank. The copy is in all five locales, and the Rules page titles `residue-cleanup` and
`goal-writing` in all five as it titles the other rules (TCRN-CROSS-SUB-509, EPIC-150 R9).

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[设备维护](Release-Notes-2.2.0-Device-Maintenance.md) · 下一模块：[Mana Orchestrate 技能](Release-Notes-2.2.0-Mana-Orchestrate-Skill.md)
