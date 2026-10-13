# Einzbern 2.0.3 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 6/7：发行与仓库工具

上一模块：[Mana Orchestrate 技能](Release-Notes-2.0.3-Mana-Orchestrate-Skill.md) · 下一模块：[从 2.0.2 升级](Release-Notes-2.0.3-Upgrading-from-2.0.2.md)

## The CI workflow's `verify` job may run for 45 minutes instead of 15

The CI workflow's `verify` job may run for 45 minutes instead of 15, because `Verify P1 offline` and
`Verify portal remediation train` together take longer than 15 minutes (TCRN-CROSS-MIN-254 D6,
INIT-053 R55). The runs for the four pushes to `main` after 2.0.0 were each cancelled at the
15-minute limit before the job finished. The job's steps, their commands and their names are
unchanged, and the `lessons` job keeps its 5 minutes.

---

[返回模块目录](Release-Notes-2.0.3.md) · 上一模块：[Mana Orchestrate 技能](Release-Notes-2.0.3-Mana-Orchestrate-Skill.md) · 下一模块：[从 2.0.2 升级](Release-Notes-2.0.3-Upgrading-from-2.0.2.md)
