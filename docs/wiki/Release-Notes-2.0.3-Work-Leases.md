# Einzbern 2.0.3 发行说明：工作租约

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 3/7：工作租约

上一模块：[配置写入与 Owner 决定](Release-Notes-2.0.3-Configuration-Writes-and-Owner-Decisions.md) · 下一模块：[Atelier](Release-Notes-2.0.3-Atelier.md)

## An actor can lease a work item, so that no other actor changes it while the lease runs

An actor can lease a work item, so that no other actor changes it while the lease runs
(TCRN-CROSS-STORY-528, TCRN-CROSS-SUB-456 to TCRN-CROSS-SUB-458, EPIC-149 R1, MIN-256).
`work-claim --id <work> --actor <actor> --at <time>` takes the lease for its TTL, `--ttl <n>m` or
`--ttl <n>h` from 1m to 24h and 2h by default; the holder claiming again renews it. The lease holds
the whole family: a claim is refused with `WORK_LEASED` while another actor holds an unexpired lease
on the item, an ancestor or a descendant, and `work-transition`, `work-annotate` and such members of
a `work-batch` are refused with `WORK_LEASED`, naming `holder`, `expiresAt` and `leasedWorkId`, on
the leased item and everything below it when they come from another actor or name none; a refused
batch writes nothing. `work-create` and `work-delete` are not held. `work-release` lets the holder
release a lease at any time and anyone release an expired one; another actor's unexpired lease is
released only by force in Atelier (`--force true` needs `EINZBERN_SURFACE=atelier`, otherwise
`MODEL_WRITE_REFUSED`). A lease is a project-scoped `lease` configuration record keyed by the work
id, and whether it holds is judged on each write's own `--at`, never on a clock. `work-show` and
each `work-list` entry carry the item's own `lease`, `null` when it has none.

---

[返回模块目录](Release-Notes-2.0.3.md) · 上一模块：[配置写入与 Owner 决定](Release-Notes-2.0.3-Configuration-Writes-and-Owner-Decisions.md) · 下一模块：[Atelier](Release-Notes-2.0.3-Atelier.md)
