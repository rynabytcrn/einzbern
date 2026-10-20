# Optional dot scheduling

The engine supplies pure state evaluation, not a scheduler SDK or a permanent
controller. Actual tool availability, historical receipts and current readbacks
are different evidence. No actual automation is created or changed by this code.

## Context patrol

Use purpose, library/project scope and execution environment as the logical key.
Prefer the saved actual instance ID. A name is not identity; an unknown create
outcome requires querying rather than blind recreation. After every create or
update, read back the same ID, interval, scope, timezone and enabled state.

The interval is 20 minutes. New-task/resume/delegated-session context reads remain
independent. Active or ordinarily blocked work is not idle. `blocked_terminal`
requires all actionable paths evidenced as blocked, explained, and no running or
independently actionable work. Two different successful checks at least 20 minutes
apart must observe the same terminal kind, fingerprint and visible revisions.
Failures, unknowns, new work or a changed terminal state reset the count.

A candidate first requests a fresh task read, then disables the same ID, then
reads tasks and schedule again. Interleaved received work resumes the same ID.
Unknown/failed resume retains pending-resume, work references and the actual
error. No atomic read/modify guarantee or visibility of unsynchronized events is
claimed. Delayed checks collapse into one current observation, not replayed slots.
A scoped Owner keep-enabled override is dynamic state, distinct from this stable
policy; it prevents automatic pause and does not restart completed work.

Pausing patrol neither cancels the main task nor stops children. It never changes
the independent daily configuration backup.

## Verification boundary

DOT-S01 real-instance E4 remains separate from sequential E2 fixtures. DOT-S02
covers pause/readback/new-work/resume ordering without race, crash or lifecycle
probes. No test or actual scheduler action was run by the implementation package.

## Independent daily configuration backup

The fixed schedule is 00:00 Asia/Shanghai (UTC+08:00), not the travel timezone.
The daily task has its own actual ID, group, selection digest, policy and readback.
It never consumes patrol enabled state, and patrol resume never enables it.
Current rollout remains disabled; implementation is not runtime authorization.

The gate consumes WP-C's actual `evaluateConfigBackupEnablement` contract:
explicit complete policy, matching policy approval digest/evidence, supported
whitelist and restore authority, group binding, safe recoverable retirement and
actual enablement authorization. It also requires scheduler deduplication and
readback capability. No policy amounts, durations or retention defaults are added.
Eligibility returns a pending action, never observed enabled state; an actual
same-ID schedule readback is still required. Unexpected enabled-without-policy
state is unknown and must be surfaced, not described as safely disabled.

A delay produces one current snapshot with its real capture/completion time and
the missed schedule reference. It never claims to reconstruct midnight contents.
Cancellation disables only this task, without deleting backup packages or changing
patrol. Reopening checks the prerequisites and explicit runtime authorization again.
DOT-S03 and CFG-B03 fixtures are not evidence of real backups or enablement.

Patrol checks also consume retained native attempt/response records. The native
validator reports execution responsibility separately from deliverable success;
pending, invalid or unverified terminal association retains that responsibility.
An empty manually supplied active-reference list cannot overrule a supplied native
record whose execution termination is still unknown.
