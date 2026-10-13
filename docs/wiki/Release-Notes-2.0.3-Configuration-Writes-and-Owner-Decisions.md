# Einzbern 2.0.3 发行说明：配置写入与 Owner 决定

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 2/7：配置写入与 Owner 决定

上一模块：[门与完成](Release-Notes-2.0.3-Gates-and-Done.md) · 下一模块：[工作租约](Release-Notes-2.0.3-Work-Leases.md)

## The eight configuration writes refused to a model with `MODEL_WRITE_REFUSED` accept `--decided-in minutes:<id>#D<n>`, which cites an Owner decision

The eight configuration writes refused to a model with `MODEL_WRITE_REFUSED` (`settings-set` and
`settings-remove` of a key that is not model-writable, `variable-set`, `variable-remove`,
`rule-enable`, `rule-disable`, `gates-config-set` and `gates-config-remove`) accept
`--decided-in minutes:<id>#D<n>`, which cites an Owner decision (TCRN-CROSS-STORY-526,
TCRN-CROSS-SUB-451 to TCRN-CROSS-SUB-453 and TCRN-CROSS-SUB-455, EPIC-149 R1, MIN-256). Under the
write lock the engine checks that the minutes are found, in the library or, read only, in the
coordination library its chain identity names; that their `decidedBy` holds `owner:governance`; that
the decision is still in force; and that its text names the target (a setting key, a variable name,
a rule id or a gate name, or a `<prefix>.*` that covers it). The write then goes through and each
event it appends records `decidedIn`, `decidedInLibraryId` and `surface: cli`. A failed check is
refused with `MODEL_WRITE_AUTHORIZATION_INVALID`, carrying `decidedIn`, `target` and `reason`
(`malformed`, `not-found`, `not-owner-decided`, `obsolete` or `target-not-named`), and nothing is
appended. A write run with `EINZBERN_SURFACE=atelier` records `surface: atelier`; a model's write
that cites no decision is still `MODEL_WRITE_REFUSED`. The citation makes a write traceable to a
decision; it does not prove that the Owner took it. `--help` shows the value's shape, and
`docs/wiki/Variables.md` and `docs/wiki/Gates.md` describe the check.

## On a refusal, the stderr of the CLI entry `scripts/einzbern.mjs` now carries `decidedIn` and `reason`

On a refusal, the stderr of the CLI entry `scripts/einzbern.mjs` now carries `decidedIn` and
`reason` (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-466, EPIC-149 R2).

---

[返回模块目录](Release-Notes-2.0.3.md) · 上一模块：[门与完成](Release-Notes-2.0.3-Gates-and-Done.md) · 下一模块：[工作租约](Release-Notes-2.0.3-Work-Leases.md)
