# Einzbern 2.0.3 发行说明：从 2.0.2 升级

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 7/7：从 2.0.2 升级

上一模块：[发行与仓库工具](Release-Notes-2.0.3-Release-and-Repository-Tooling.md)

## Readers need 2.0.3

- Readers need 2.0.3. Once 2.0.3 writes a work lease record, a configuration event that carries
  `surface` or `decidedIn`, or a work item's `gates` field to a library for the first time, 2.0.2
  replaying that library reports `WORKSPACE_EVENT_CORRUPT`. Install 2.0.3 first on every device that
  reads the same library. Any configuration write from Atelier is such a write, because it records
  `surface`.

## Rolling back to 2.0.2 is safe only before the first such write

- Rolling back to 2.0.2 is safe only before the first such write.

## A gate run that 2.0.2 recorded does not match the v2 tree digest

- A gate run that 2.0.2 recorded does not match the v2 tree digest, so run
  `gates-run --work-id <Story id>` once more for each Story before it goes to done. Required gates
  now apply to every Story by default.

## Every Atelier launcher must set `TCRN_PORTAL_ACTOR`

- Every Atelier launcher must set `TCRN_PORTAL_ACTOR`.

---

[返回模块目录](Release-Notes-2.0.3.md) · 上一模块：[发行与仓库工具](Release-Notes-2.0.3-Release-and-Repository-Tooling.md)
