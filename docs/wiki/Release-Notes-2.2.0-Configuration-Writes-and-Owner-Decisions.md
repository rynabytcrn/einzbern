# Einzbern 2.2.0 发行说明：配置写入与 Owner 决定

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 4/9：配置写入与 Owner 决定

上一模块：[受管段、Command Spell 与变量](Release-Notes-2.2.0-Managed-Sections-Rules-and-Variables.md) · 下一模块：[设备维护](Release-Notes-2.2.0-Device-Maintenance.md)

## Four more writes take `--decided-in minutes:<id>#D<n>`

Four more writes take `--decided-in minutes:<id>#D<n>` (TCRN-CROSS-STORY-541, TCRN-CROSS-SUB-510,
EPIC-150 R7, MIN-258 D3): `work-gate-release`, whose decision names the gate by its id;
`project-bindings-set` and `project-bindings-remove`, whose decision names the binding's key; and
`work-release --force`, whose decision names the work item by its id or its whole external key,
never through `<prefix>.*`. The decision is checked and recorded as it is for the configuration
writes of 2.0.3, so `gate.updated` joins the operations that may carry the optional authorization
extras: a release records `surface`, `atelier` for Atelier's, and for a cited decision `decidedIn`
and `decidedInLibraryId`. Without a decision a model's run is still `MODEL_WRITE_REFUSED`, its
remedy naming Atelier and `--decided-in`. `chain-declare` takes no decision and stays with Atelier;
its remedy now names Atelier's library page. The specs, the Wiki and the CLI comments now say that a
cited decision is checked before the write takes the lock, against the state the write reads
(TCRN-CROSS-SUB-518, EPIC-150 R8).

---

[返回模块目录](Release-Notes-2.2.0.md) · 上一模块：[受管段、Command Spell 与变量](Release-Notes-2.2.0-Managed-Sections-Rules-and-Variables.md) · 下一模块：[设备维护](Release-Notes-2.2.0-Device-Maintenance.md)
