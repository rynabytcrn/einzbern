# Einzbern 2.1.0 发行说明：从 2.0.3 升级

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 8/8：从 2.0.3 升级

上一模块：[发行与仓库工具](Release-Notes-2.1.0-Release-and-Repository-Tooling.md)

## Readers need 2.1.0

- Readers need 2.1.0. Once 2.1.0 writes a gate or rule proposal, or Atelier's approval or rejection
  of one, to a library, 2.0.3 still opens that library without an error, but it counts each of those
  events in `rejectedEventCount` and skips it, so the state it reads no longer matches 2.1.0's: a
  gate that Atelier approved is not declared, an approved rule reads disabled, and
  `configProjection` reads `stale`. A library that 2.1.0 creates records `minEngineVersion` 2.1.0,
  and 2.0.3 refuses to open it with `ENGINE_TOO_OLD`. Install 2.1.0 first on every device that reads
  the same library.

## Rolling back to 2.0.3 is safe only before the first such write

- Rolling back to 2.0.3 is safe only before the first such write.

## A gate run that 2.0.x recorded no longer counts toward done

- A gate run that 2.0.x recorded no longer counts toward done: 2.1.0 skips a run record whose roots
  name their paths without content digests. Run `gates-run --work-id <Story id>` on 2.1.0 once more
  for each Story before it goes to done.

## New device state

- New device state: the heavy-run slot files (`locks/heavy.lock`, `locks/heavy-2.lock` and on), the
  machine setting `execution.maxConcurrentHeavyRuns` (1 by default), the user crest snapshot
  (`cache/user-crest/snapshot.json`), and `~/.einzbern/log/hook.ndjson`, which gains one line per
  prompt, is never rotated, and can be deleted without losing anything.

## Running the gates on a tree that contains this release no longer needs `TCRN_DESIGN_SYSTEM_ROOT`

- Running the gates on a tree that contains this release no longer needs `TCRN_DESIGN_SYSTEM_ROOT`
  to name a checkout of the bound Design System commit: the portal gate reads that commit from the
  git objects of the Design System checkout beside the engine, whatever its working tree holds.

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[发行与仓库工具](Release-Notes-2.1.0-Release-and-Repository-Tooling.md)
