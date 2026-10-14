# Einzbern 2.1.0 发行说明：并发与设备状态

[发行说明](Release-Notes.md) › [Einzbern 2.1.0](Release-Notes-2.1.0.md) › 模块 5/8：并发与设备状态

上一模块：[Atelier](Release-Notes-2.1.0-Atelier.md) · 下一模块：[知识与纪要](Release-Notes-2.1.0-Knowledge-and-Minutes.md)

## The library write lock is now held for the append alone

The library write lock is now held for the append alone (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-481,
EPIC-149 R4, MIN-257 D6). A write reads the merged state, builds its events and measures the result
outside the lock; under the lock it checks that no device stream moved since that read and appends,
or reads again. The CLI's before-reads, lease pre-checks, gate checks and a Story's done judgement
run outside the lock, and a write receipt names exactly the records its own appends wrote.

## A lock wait that runs out is refused with `WORKSPACE_LOCKED`, which now names the holder's `holderPid`, `holderCommand` and `heldSince`

A lock wait that runs out is refused with `WORKSPACE_LOCKED`, which now names the holder's
`holderPid`, `holderCommand` and `heldSince` (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-480,
EPIC-149 R4). The lock file records the holder's command as an optional field, so its format stays
`einzbern.file-lock.v1` and older readers ignore it. Every write that takes the library write lock
accepts `--timeout-ms`, the longest it waits for the lock.

## Reads of the user crest answer from a snapshot, without the user crest lock

Reads of the user crest (list, snippet, body, and so recall) answer from a snapshot, without the
user crest lock (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-482, EPIC-149 R4). A user crest write replaces
this device's snapshot, `cache/user-crest/snapshot.json` in the device directory
(`einzbern.user-crest-snapshot.v1`), under the lock once its event is down. A snapshot that is
missing or behind the crest is rebuilt under the lock when the lock is free; while a writer holds
the lock, a read answers from the snapshot it has, or from a scan, and waits for nothing.

## Every prompt in a registered project now leaves one line in `log/hook.ndjson` in the device directory

Every prompt in a registered project now leaves one line in `log/hook.ndjson` in the device
directory, written by the engine's recall in the launcher's `einzbern.hook-log.v1` shape, whether it
was answered or not: `HOOK_RECALL_ANSWERED`, `HOOK_RECALL_NO_HITS`, `HOOK_RECALL_PROMPT_EMPTY`,
`HOOK_RECALL_LIBRARY_UNCONFIRMED`, or a failed recall's own code (TCRN-CROSS-STORY-529,
TCRN-CROSS-SUB-483, EPIC-149 R4, MIN-257 D6). The directory is made 0700 and the file 0600; a line
that cannot be written is dropped, and what the hook prints is unchanged.

## `gates-run`, the whole test suite, the portal proof train and release finish now each take a machine-wide heavy-run slot before they start

`gates-run`, the whole test suite (`scripts/task.mjs test`), the portal proof train
(`scripts/verify-portal.mjs`) and release finish (`scripts/release.mjs finish`) now each take a
machine-wide heavy-run slot before they start, so two of them do not run at once on one machine
(TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-484, EPIC-149 R4, MIN-257 D6). A slot is a lock file in the
device directory's `locks/` (`heavy.lock`, then `heavy-2.lock` and on), and
`EINZBERN_HEAVY_LOCK_DIR` names another directory, so that several device directories can share one
set of slots. The new machine setting `execution.maxConcurrentHeavyRuns` (an integer from 1 to 16, 1
by default) sets how many there are. A run that has to wait writes one `HEAVY_SLOT_WAITING` line on
stderr naming the holders, again whenever they change, and waits as long as it takes. The holder
passes `EINZBERN_HEAVY_SLOT` to what it starts, so a gate, test or train it runs takes no slot of
its own; a slot is reclaimed only from a holder on this host whose process is provably dead.
`verify:p1` takes its slot at its entry, before its output session, so its legs inherit it and a
wait no longer reaches a leg's stderr (TCRN-CROSS-STORY-529, TCRN-CROSS-SUB-493, EPIC-149 R5).

---

[返回模块目录](Release-Notes-2.1.0.md) · 上一模块：[Atelier](Release-Notes-2.1.0-Atelier.md) · 下一模块：[知识与纪要](Release-Notes-2.1.0-Knowledge-and-Minutes.md)
