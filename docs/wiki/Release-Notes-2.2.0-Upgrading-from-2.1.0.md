# Einzbern 2.2.0 发行说明：从 2.1.0 升级

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 9/9：从 2.1.0 升级

上一模块：[发行与仓库工具](Release-Notes-2.2.0-Release-and-Repository-Tooling.md)

## Readers need 2.2.0

- Readers need 2.2.0. Once 2.2.0 releases a migrated gate in a library, 2.1.0 still opens that
  library without an error and can still write to it, but it counts that `gate.updated`, which
  carries the new authorization extras, in `rejectedEventCount` and skips it, so it reads the gate
  as still pending and holding its work back while 2.2.0 reads it satisfied. 2.1.0 reads the
  managed-section and rule records that 2.2.0 writes for a coordination library, an enabled rule as
  enabled, but writes no section into the coordination library's container: there its `rule-list`
  says `outputBindingStatus: "unconfigured"` and its `agents-render` is refused with
  `WORKSPACE_INPUT_INVALID`. A library that 2.2.0 creates records `minEngineVersion` 2.2.0, and
  2.1.0 refuses to open it with `ENGINE_TOO_OLD`. Install 2.2.0 on every device that reads the same
  library, together.

## Rolling back to 2.1.0 is safe only before the first such write

- Rolling back to 2.1.0 is safe only before the first such write.

## A gate run that 2.1.0 recorded still counts toward done

- A gate run that 2.1.0 recorded still counts toward done: 2.2.0 records and reads runs in the same
  shapes (`einzbern.gate-run.v1`, with `einzbern.gate-tree.v3` roots), and still skips only a run
  whose roots name their paths without content digests, as 2.0.x recorded them.

## A coordination library's managed sections

- A coordination library's managed sections: the first `agents-render` into its registered container
  replaces each marked section whose markers agree with its text and that the library never
  recorded, after AGENTS.md is copied into `backups/<UTC>/managed-sections/` of the device
  directory, and records it; a section changed by hand stays as it is, pending. `settings-set`
  renders nothing, so run `agents-render` after it. The variable sections follow
  `artifact.language`.

## `library-unregister` and `device-clean` only plan by default

- `library-unregister` and `device-clean` only plan by default; they act with `--yes true`, and
  `device-clean` keeps every backup that holds originals.

## Built-in rules

- Built-in rules: `residue-cleanup` and `goal-writing` are new and off by default.
  `unattended-commands` is at version 2: a project that enabled version 1 reads `update-available`
  and its file is not touched until the rule is enabled again with `rule-enable`, which writes
  version 2.

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[发行与仓库工具](Release-Notes-2.2.0-Release-and-Repository-Tooling.md)
