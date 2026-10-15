# Einzbern 2.2.0 发行说明：并发与设备状态

[发行说明](Release-Notes.md) › [Einzbern 2.2.0](Release-Notes-2.2.0.md) › 模块 1/9：并发与设备状态

下一模块：[知识与纪要](Release-Notes-2.2.0-Knowledge-and-Minutes.md)

## More writes now hold the library write lock for their append alone, as work and configuration writes have since 2.1.0

More writes now hold the library write lock for their append alone, as work and configuration writes
have since 2.1.0 (TCRN-CROSS-STORY-538, TCRN-CROSS-SUB-497 to TCRN-CROSS-SUB-501, EPIC-150 R7,
MIN-256 D6, MIN-257 D6, MIN-258 D1): gate and rule proposals with their approval and rejection,
`work-delete` and `project-delete`, the managed-section writes (`agents-render`, `rule-resolve`,
`rule-enable`, `rule-disable` and the variable sections), `artifact-put`, and `knowledge-reverify`,
`knowledge-article-refresh` and the knowledge staleness policy write. Each reads and checks outside
the lock, so a refusal waits for no other writer; under the lock it checks that no stream moved
since its read and appends, or reads again, and after four tries the whole write runs under one
hold. A managed-section write plans AGENTS.md and CLAUDE.md from its read, and writes them only
while every file it read still holds what it read, so an AGENTS.md that another process changed
after the plan is not written over and the write plans again.

## An approval's conditions are judged again against the state its append is built on, with the same reason codes

An approval's conditions are judged again against the state its append is built on, with the same
reason codes: an approval that another approval overtook is `PROPOSAL_NOT_FOUND` at its append, and
when a rule proposal is recorded again at the same instant with another change, the rule's approval
is `PROPOSAL_STALE` and AGENTS.md is put back (TCRN-CROSS-SUB-497). The deletes judge the leases
again at the append: a lease claimed on the item between the read and the append that still runs at
`--at` refuses `work-delete` with `WORK_LEASED`, whoever asks, and nothing is written; a lease
released in between is not removed a second time (TCRN-CROSS-SUB-498). `recover` keeps holding the
lock for its whole run.

## `artifact-put` copies the blob into the library and reads it back before the lock, and holds the lock only to replace the manifest

`artifact-put` copies the blob into the library and reads it back before the lock, and holds the
lock only to replace the manifest (TCRN-CROSS-SUB-500). `snapshot-manifest` takes no lock: it stamps
every file it covers (path, inode, size, modification time) before it reads the state and after it
walks the tree, and reads under the lock only after four unsteady reads. `workspace-relocate` still
holds the lock from the copy to the tombstone; a blob that an `artifact-put` writes into the source
library while the relocation copies now makes the relocation fail safe with
`RELOCATE_COPY_MISMATCH`, taking its copy back, and a put that arrives after the tombstone is
refused, so no recorded data is lost.

## `knowledge-batch` no longer holds the lock from its first member to its last

`knowledge-batch` no longer holds the lock from its first member to its last: each member takes the
lock as its verb does, and `--align-first` takes it for its own rebase (TCRN-CROSS-SUB-501).
`knowledge-rebase`, `knowledge-bodies-migrate`, `knowledge-recover` and `knowledge-init` keep
holding it for their whole run. The CLI catalog spec lists what each write holds the lock for, and
the other specs, the file-lock header and the agent-integration reference now describe the lock as
the engine holds it (TCRN-CROSS-SUB-517 and TCRN-CROSS-SUB-522, EPIC-150 R8 and R9).

---

[返回模块目录](Release-Notes-2.2.0.md) · 下一模块：[知识与纪要](Release-Notes-2.2.0-Knowledge-and-Minutes.md)
