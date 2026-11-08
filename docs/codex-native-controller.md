<!-- SPDX-License-Identifier: Apache-2.0 -->
# Codex independent conversation coordination

## Current contract and scope

INIT076's 2026-10-30 Owner revision replaces the former native collector
controller/bridge contract. This filename remains for existing references; the
old SubagentStop/collector-wait design is superseded history, not an alternate
mode. Historical work records, commits and failure evidence remain intact.

Only an explicitly selected **Codex** host uses this contract. Unknown host is
not Codex admission. Claude Code and DSH keep their existing single main
conversation coordinating workers with native completion notifications. Dot
policy and generic collection/conference behavior are unchanged.

## Roles and model policy

- **Main decision conversation (`main`)**: sets the bounded batch, package goals,
  dependencies and acceptance responsibilities; decides on the returned batch and
  authorizes the next stage. After handoff it stops idle polling. It does not use
  `/goal` or `/loop` merely to wait; substantive governance rounds remain valid.
- **Independent coordinator conversation (`economy`)**: directly dispatches fresh
  workers, waits for and reads their native results, reconciles the batch and
  reports it once to main. It is not a child collector, read-only summarizer, or
  extra collection tier. Package implementation/acceptance responsibilities do
  not silently transfer to the coordinator.
- **Workers**: the coordinator invokes the exposed `collaboration.spawn_agent` native
  subagent tool for one bounded package each, task-category model routing and existing
  rejection-threshold escalation. They do not proactively message their parent;
  retain native final output and supported safety/interruption/result paths.

The two peers are independent conversations. `create_thread` and `fork_thread`
can establish independent peers under their actual authorization; neither creates
a worker. A supported native CLI can expose the spawn tool as
`multi_agent_v1.spawn_agent`; retain that actual namespace and argument/return shape
rather than relabeling it. Missing native spawn or exact configured selection capability stops
that dependent path visibly. Do not substitute an independent chat or runner.

Resolve actual models/effort from the selected device-host policy, retaining its
revision/digest and actual dispatch receipt. Never embed concrete vendor models
in the plan or generated contract. Onboarding offers `main`, `economy`, and
`flagship`; usable main/economy groups are required for this mode. Flagship's
model group is optional, and an empty group is neither a usable model nor a valid
selected escalation ceiling. Missing required groups stop this mode, not other
hosts or unrelated operations. See `specs/engine-model-policy-v1.md`.

## Batch identity, waiting and recovery

This is an orchestration contract over supported host operations, not a new RPC,
daemon or private session database. No particular transport method or exported
controller API is required by this document. Preserve these facts in ordinary
owned run evidence and reconcile them with actual native receipts:

1. Before dispatch, freeze batchId, application attempt, the two independent
   conversation identities, package/member scope and policy origin. Bind worker
   agentId/attempt to real dispatch receipts; names, markers and self-reports are
   not authorization. Native turn IDs do not replace application attempts.
2. Enforce worker caps, device/project limits and actual available host capacity.
   There is no collector exemption or reserved collection slot. Reduce parallelism
   or split a stage when necessary; never count a missing usage observation as
   spare capacity or bypass a refusal.
3. The coordinator uses supported bounded waits, respecting wait limits, deadline,
   failure budget, no-progress boundary and user interruption. Read exact members'
   raw status/results. Preserve completed, failed, cancelled_confirmed, pending
   and unknown. Stale/future observations, query failures, identity drift and
   wrong batch/attempt cannot establish completion or cancellation.
4. Deduplicate observations and delivery within batch/attempt. Once all members
   are confirmed terminal, send one batch report containing results, evidence and
   failures through the supported independent-conversation channel. Completion of
   every worker is not success of every package. Keep delivery state separate from
   execution, acceptance and resource release.
5. On interruption/restart, reconcile existing dispatch and native state before
   any action. Reuse the same logical batch/attempt evidence; do not respawn a
   worker because a local acknowledgement is missing. Confirmed delivered reports
   are not replayed. Unknown delivery is queried, never blindly resent or treated
   as permission for the next batch. Late results stay attached to their original
   attempt and cannot advance a replacement batch. Ended workers are not revived.
6. Deadline, pause/cancel, permission/safety refusal, budget exhaustion, no progress
   and missing capability produce explicit exceptional facts and outstanding
   ownership, not fabricated success or cancellation. Stop only dependent work.
   There is no collector fallback, Stop-to-block loop or helper keepalive.

Main resumes for the delivered batch decision and, where authorized, hands off the
next batch. A missing or uncertain host result remains uncertain; source code and
local evidence files do not manufacture native delivery or released resources.

A final reply in the coordinator's own conversation is not a send to main. Use
the supported cross-conversation tool under the existing delivery authorization,
and retain its actual return. Do not label a report delivered merely because its
text says that it was returned. When delivery is unavailable or uncertain, retain
that fact without making main poll to keep itself alive.

The existing `execution-codex-peer-record` enrolls the validated coordinator in
`device:codex-peer-roles/`, separately from disposable per-turn observations.
Its anchor and validated receipt survive new turns, summaries, terminal batches,
engine switches and client restart. Known enrollment with missing, unreadable,
malformed or mismatched material is a visible recovery failure. PreToolUse denies
its dependent create/fork/spawn calls until recovery. Ordinary unbound chats remain
subject to their normal authorization. Total removal of engine and every anchor
cannot be distinguished from a never-enrolled installation by a standalone hook.

Before the first spawn, prepare pending native workers with
`execution-host-prepare --codex-peer-worker true --codex-admission <observation>`
in the actual coordinator session, then record the frozen manifest and pending
records. This validates the first batch before workers execute. Subsequent worker
preparation automatically resolves the enrolled native session; caller-supplied
sessionRef must match it. Use the actual tool name and returned worker ID pointer;
do not fabricate parentId or model metadata absent from the native return.

PreToolUse denies an active coordinator's independent create/fork before MCP
execution, including native inner calls in code mode. It checks tool identities,
never JavaScript or shell text. The stable launcher applies this check even outside
a registered project cwd, without loading an unrelated library. It does not spawn,
call a provider, grant permission or send messages.

Stop supplies one reminder to follow this delivery procedure when a coordinator
ends with an eligible terminal batch and no delivery attempt. Repeated Stop or an
uncertain attempt ends normally. The reminder does not send a message, create
authorization, wait for pending workers or revive the retired collector loop.

## Reports, settings and query exit

An ordinary report sends only `threadId`, `hostId` and `prompt`. Sender task
selection remains preparation metadata and does not set the recipient's model or
effort. Native coordination preparation rejects `model`/`thinking` overrides by
default; new ordinary delivery records also reject them. Historical receipt
normalization retains the original meaning of stored evidence.

An explicitly authorized settings adjustment is a separate native attempt, not a
final batch delivery. Machine-assemble an optional engine-only
`--codex-settings-intent <file>` for `execution-host-prepare`. Its closed object
contains `decidedIn` (one existing Owner decision), `basis` (the caller's actual
scope assessment), and, for a temporary target not named in that decision,
`targetSource: {toolName, response}` containing the matching original independent
create/fork return. The current decision must be valid and Owner-decided. A named
target uses the existing write-authorization verifier; class authorization retains
its actual native test-target source. Neither a prompt marker nor an ordinary
receipt or `covered` report grants this correlation. The caller remains
responsible for the decision's natural-language scope.

The CLI saves a private association to the actual session, complete native
arguments digest, attempt and current decision source; it adds no MCP or v1
request/record fields. The enrolled coordinator's PreToolUse checks the exact
recipient/host/settings and rereads decision validity before execution. The
association is current for five minutes and records that native attempt as
attempted before the side effect. A successful native PostToolUse marks its
outcome; an unknown outcome cannot be overwritten by another preparation.
Reconcile unknown settings through public `thread/read` and retain
`reconciliation: {attemptId, toolName: "thread/read", response}` in a subsequent
intent. Its readback must match the previous target's requested model/effort.
This reconciles an attempt; it does not consume or exhaust the Owner's existing
authorization. Prepare any further covered adjustment from the actual current
state and record it separately. Unbound ordinary chats gain no global model ban.

For `read_thread` and `wait_threads`, only confirmed native subagents whose
returned latest turn is still in progress permit another bounded query. An
independent economy conversation is an independent target. After its first
query returns, end the loop: the next actual read/wait is denied before execution,
including changed targets/cursors, mixed waits, code-mode inner calls and summary
continuations. This applies without a prior model change, receipt or role.
A new actual UserPromptSubmit can obtain a new result and follows the same exit
rule; no query-intent JSON or additional approval is required. Native spawn or
SubagentStart evidence supplies identity; model/category/title/old cache does not.
PostToolUse feedback and stopping the whole model turn are separate host facts.
See `specs/engine-hook-events-v2.md`; actual Desktop consumption needs its own
native execution counts and version evidence.

## Supported batch receipt commands

The coordinator records native preparation/response history through the existing
`execution-host-prepare`, `execution-host-record` and `execution-host-evidence`
commands. For batch recovery, use:

`execution-codex-peer-record --workspace <library> --manifest <manifest.json> --records <native-records.json> --capacity <capacity.json> [--delivery <delivery.json>] [--prior <latest-receipt.json>] --output <new-private-file>`

The manifest is `tcrn.codex-peer-manifest.v1`, with explicit `host: "codex"`,
`batchId`, `attemptId`, current `workId`/`workRevision`, and device `policyDigest`.
Its `main` and `coordinator` each contain the actual `conversationId`, native
identity `sourceRef`, original `raw` response and `conversationPointer` into that
response. The pointed identities must match their declarations and must differ. Fixed `members` contain their actual
preparation `attemptId`, `workId`, `workRevision`, and observed `conversationId`
(or null while unknown). `records` is an array of retained
`tcrn.host-native-record.v1` worker records, not invented status summaries.
New v2 receipts require scoped native spawn preparations bound to the manifest's
coordinator. Associated worker identities require the original spawn return;
distinct wait/status tools retain their actual names and attempt association.
Legacy v1 receipts replay with their original historical semantics and remain
unguarded history. They cannot enroll roles or resume into new guarded batches.
`capacity` contains the observed nonnegative `active` count (null when unknown)
and positive `limit`; it is an observation, not an exemption or a scheduler.

The CLI reads current work revisions and device model policy itself, then captures
`observationCutoff` directly from its real clock (no input timestamp or override
flag). Every retained worker/delivery event and preparation request time must be
at or before this cutoff, compared at strict timestamp precision; preparation
evaluation and reported selection/usage observation times are checked too. Future evidence
is refused into a separate invalid artifact retaining the raw inputs and prior;
it cannot establish completion or release responsibility. Keep the last valid
receipt. Resume captures a fresh cutoff and refuses clock rollback below the prior
cutoff; reconcile the clock/input instead of discarding history. This is a local
observation bound, not provider clock synchronization or authentication. Its
`tcrn.codex-peer-batch.v2` output includes requested main/economy model intent,
readiness, outstanding occupancy, blocked reasons and report eligibility. These
are recomputed from evidence; no supplied field can declare successful execution.
The output is a new private file using the existing dispatch-artifact writer,
outside device/authoritative library roots. Resume with the retained latest
`--prior`; immutable membership, policy/work drift and native conflicts prevent
silently treating a changed batch as its predecessor.

A report attempt is retained with `--delivery`: its existing host-native `record`,
`recipientPointer` and `correlationPointer` into the actual send arguments,
`batchId` and `batchAttemptId`. The native preparation must have action
`coordination`; tool names remain host-defined. The pointed recipient must match
main. The correlation pointer addresses an ordinary text argument (for example
`/message` or `/prompt`), whose first line must be exactly:

```text
Einzbern-Codex-Peer-Manifest-SHA256: <lowercase canonical manifest SHA256>
```

Include the terminating LF, then the readable batch result. The normal
`execution-codex-peer-record` output supplies `reportPrefix` for machine assembly
before native send preparation; it is not a send permit. The equivalent core
helper is `codexPeerReportPrefix(manifest)` using `canonicalSha256(manifest)`.
Machine-assemble the text and pointers from the actual supported tool arguments;
do not ask users to hand-fill evidence JSON or add invented metadata fields to a
host tool. The digest binds the entire immutable manifest, including batch and
application attempt, peers, members, work revision and policy. It is **correlation
only**, never authority, enrollment or proof of provider authenticity. A marker
elsewhere in the body, an old batch marker or a wrapper relabel is not a match.
Keep the original prepared send arguments and native response unchanged.

A worker releases batch occupancy and counts toward `allTerminal` only when its
native terminal evidence has a unique, consistent identity matching its fixed
member (when known). Main/coordinator and every fixed member identity remain
reserved, including absent members. Colliding claims retain **both** workers;
unknown, drifted or conflicting evidence retains responsibility.

Final-report association uses the send preparation's retained `requestedAt` as a
conservative request boundary, not authenticated transport time, send completion
or receipt resume time. Every
member must already have uniquely associated, conflict-free terminal evidence
**strictly before** that instant. Equal timestamps do not establish ordering;
retain finer actual timestamp precision when available, never invent it. Prepare
the send only after terminal eligibility is established. A send prepared earlier
may remain unproven even if actually invoked later; there is no timestamp override
to waive this evidence gap. Later
completion or identity observations cannot turn a premature report into a final
report, including when recording directly without `--prior`. Such a receipt keeps
`delivery-before-terminal-batch` even if workers are now terminal. Transport
`deliveryStatus: confirmed` alone does not establish a valid final report.

Not attempted, unknown, confirmed and failed are distinct. Once a delivery attempt exists it is not
eligible for blind resend; query that attempt and add its actual response.
`execution-codex-peer-evidence --from-file <receipt.json>` recomputes the saved
receipt against its stored observation cutoff without consulting replay wall time
or dispatching anything. A fresh recording may have a new cutoff/digest even when
its deduplicated native history is unchanged. It does not refresh native state. These
commands do not send messages or enforce global exactly-once delivery across
independent files; the coordinator must retain and resume the latest receipt.

## Role lifecycle and native readiness

`execution-codex-peer-record --role-change <json> --actor <actual actor>` uses the
same validated manifest/records and retains its predecessor. `operation: "retire"`
or `"activate"` requires `decidedIn` naming a live Owner decision authorizing the
exact target `codex-peer-roles.<coordinatorId>.<operation>` (or its governed wildcard).
The existing write-authorization verifier resolves the decision; `authorized:true`
and local overrides are not inputs. Method changes retire the corresponding role
through this path. `operation: "recover"` rebuilds fallible active role material
from its retained validated v2 receipt in an actual peer session; it cannot activate
a retired role. Every mutation reads back the saved role. Batch completion is not
retirement. Enrollment/persistence failures retain the receipt and return nonzero
`CODEX_PEER_GUARD_NOT_READY`, not ordinary-unbound success.

Setup's existing `--codex-admission` and `doctor --codex-admission` accept current
native observations. The same option is used by peer-record and worker prepare.
Machine-assemble `native` as `tcrn.codex-hook-observation.v1` with `observedAt`,
actual client `version`, `cwd`, original public app-server `hooks/list` result in
`raw`, and `files` (`path`, byte `sha256`) for the returned hook `sourcePath` and
current user `.codex/config.toml`. Retain actual returned fields unchanged. This is
observation correlation, not authentication or trust enrollment. No new daemon is
installed. Legacy `subagentStop` observations remain readable but prove no guard.

Readiness requires the candidate stable PreToolUse, PostToolUse, UserPromptSubmit and SubagentStart commands registered at
the observed cwd, enabled, currentHash trusted, no load errors/warnings obscuring
applicability, unchanged observed hook/config bytes, and successful durable role
recovery. Use a current observation within the native dispatch five-minute bound;
re-observe before each new dependent batch and after installation/config changes.
Missing capability/schema, disabled/missing/untrusted entries, stale observations
or role failures are not-ready. Model-group readiness remains separate. File
reconciliation can pass while `hooks-present.detail.codexGuard.ready` is false.
Fresh/update/repair report that native status in their self-check; they preserve
roles and user settings rather than granting trust. A disabled hook cannot promise
prevention until its real native state is restored and verified.

## Installation and compatibility

Normal setup/update/repair retires only proven engine-owned legacy collector hook
entries. Preserve user-edited and unrelated hooks and report unresolved ownership.
No SubagentStop registration, collector-wait helper or optional collector remains
an active path. User-selected models and custom categories are preserved; default
category supplementation is idempotent and cannot alter another host's policy.
Model onboarding does not silently persist model choices or fake Owner provenance.

## Evidence and PR acceptance

Source/fixture regressions verify category routing, explicit host isolation,
receipt reconciliation and legacy owned-hook retirement. They do not certify
native scheduling, waiting or message delivery. Record source checks, upstream
CI and Owner native acceptance separately. Follow the current Owner decision for
the native review scope; a fixture is not a reason to repeat an already accepted
capability experiment or to invent a new delivery prerequisite.

Keep a particular run's results and acceptance waivers in its work/PR record, not
in installed stable rules. PR push and Ready for Review do not authorize merge,
release or live installation.
