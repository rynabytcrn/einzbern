# Einzbern 2.2.0 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 8/9：发行与仓库工具

上一模块：[Mana Orchestrate 技能](Release-Notes-2.2.0-Mana-Orchestrate-Skill.md) · 下一模块：[从 2.1.0 升级](Release-Notes-2.2.0-Upgrading-from-2.1.0.md)

## The portal proof's replay of TCRN-CROSS-INC-155 no longer compares the whole historical `pnpm-lock.yaml` with the current one

The portal proof's replay of TCRN-CROSS-INC-155 no longer compares the whole historical
`pnpm-lock.yaml` with the current one (TCRN-CROSS-EPIC-150 R9 PF-1): it compares only the entries
that decide TypeScript, the importers' `typescript` specifiers and versions and the
`typescript@<version>` entries under packages and snapshots, beside `package.json` and the installed
`typescript` as before. A difference is still `EVIDENCE_HISTORY_DEPENDENCY_MISMATCH`.

## The `fast-uri` override is now `^3.1.7` and resolves to 3.1.8, within the `^3.0.1` range that `ajv` declares

The `fast-uri` override is now `^3.1.7` and resolves to 3.1.8, within the `^3.0.1` range that `ajv`
declares (TCRN-CROSS-EPIC-150 R9 PF-1). `fast-uri` is a development dependency and is not in the
release package.

## The coordination and human-only panels portal tests reach the loopback Atelier through an alias of `globalThis.fetch`, as the proposals portal test does, so the offline boundary scan passes them

The coordination and human-only panels portal tests reach the loopback Atelier through an alias of
`globalThis.fetch`, as the proposals portal test does, so the offline boundary scan passes them
(TCRN-CROSS-SUB-515 and TCRN-CROSS-SUB-516, EPIC-150 R8).

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[Mana Orchestrate 技能](Release-Notes-2.2.0-Mana-Orchestrate-Skill.md) · 下一模块：[从 2.1.0 升级](Release-Notes-2.2.0-Upgrading-from-2.1.0.md)
