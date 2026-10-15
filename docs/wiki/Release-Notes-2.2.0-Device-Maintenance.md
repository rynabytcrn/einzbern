# Einzbern 2.2.0 发行说明：设备维护

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 5/9：设备维护

上一模块：[配置写入与 Owner 决定](Release-Notes-2.2.0-Configuration-Writes-and-Owner-Decisions.md) · 下一模块：[Atelier](Release-Notes-2.2.0-Atelier.md)

## `library-unregister --project <path> --at <UTC>` removes the one registry entry whose project path is the one given, which need not exist any more

`library-unregister --project <path> --at <UTC>` removes the one registry entry whose project path
is the one given, which need not exist any more (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-511,
EPIC-150 R7, MIN-258 D3). Without `--yes true` it answers `LIBRARY_UNREGISTER_PLAN_READY` and writes
nothing; with it, `registry.json` is copied into `backups/<UTC>-library-unregister/` of the device
directory and replaced without that entry under the registry lock, and it answers
`LIBRARY_UNREGISTERED`. Other entries of the same library stay, and a path that no entry has is
`LIBRARY_NOT_REGISTERED`. The registry check of `doctor` lists each entry whose library path no
longer exists in `detail.hints`, with `REGISTRY_LIBRARY_MISSING` and the verb, and keeps its answer.

## `device-clean --at <UTC>` lists each install and update staging in the device directory's `trash/` and each entry of its `backups/`, with kind, version, size and reason, judged against `engine/current`

`device-clean --at <UTC>` lists each install and update staging in the device directory's `trash/`
and each entry of its `backups/`, with kind, version, size and reason, judged against
`engine/current` (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-512, EPIC-150 R7, MIN-258 D3). It keeps the
pre-update backups of the current and the previous version, the stagings of the current version and
any other entry of `trash/`, and clears the other stagings and pre-update backups. Any other backup
is judged by what it holds, read with `lstat` alone and no link followed, and lists those names as
`contents` (TCRN-CROSS-SUB-519 and TCRN-CROSS-SUB-521, EPIC-150 R8 and R9). A backup of the skill
copies alone, in the layout an update leaves (each host's copy at `<host skill root>/<skill id>`),
is cleared as `skill-copies-backup`. A backup that holds originals a write replaced (host hooks,
writable roots, managed sections, crest bodies, launchers, a registry, or the old helper's copies
and the install markers a migration moved) is kept as `holds-originals`, and anything else as
`unrecognised-backup`. A symbolic link, or an area whose real path leaves the device directory, is
refused and never touched. Without `--yes true` it answers `DEVICE_CLEAN_PLAN_READY` and writes
nothing; with it, each cleared entry is checked again and deleted, and `DEVICE_CLEANED` names each
with its size, or why it was not deleted. Without `engine/current` it answers
`DEVICE_CLEAN_ENGINE_UNKNOWN`.

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[配置写入与 Owner 决定](Release-Notes-2.2.0-Configuration-Writes-and-Owner-Decisions.md) · 下一模块：[Atelier](Release-Notes-2.2.0-Atelier.md)
