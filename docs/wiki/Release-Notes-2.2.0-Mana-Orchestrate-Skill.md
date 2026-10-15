# Einzbern 2.2.0 发行说明：Mana Orchestrate 技能

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 7/9：Mana Orchestrate 技能

上一模块：[Atelier](Release-Notes-2.2.0-Atelier.md) · 下一模块：[发行与仓库工具](Release-Notes-2.2.0-Release-and-Repository-Tooling.md)

## The skill now ships `scripts/trash-empty.mjs`

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

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[Atelier](Release-Notes-2.2.0-Atelier.md) · 下一模块：[发行与仓库工具](Release-Notes-2.2.0-Release-and-Repository-Tooling.md)
