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
- **Workers**: one bounded package each, task-category model routing and existing
  rejection-threshold escalation. They do not proactively message their parent;
  retain native final output and supported safety/interruption/result paths.

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
`tcrn.codex-peer-batch.v1` output includes requested main/economy model intent,
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

Not attempted, unknown, confirmed and failed are distinct. Once a delivery attempt exists it is not
eligible for blind resend; query that attempt and add its actual response.
`execution-codex-peer-evidence --from-file <receipt.json>` recomputes the saved
receipt against its stored observation cutoff without consulting replay wall time
or dispatching anything. A fresh recording may have a new cutoff/digest even when
its deduplicated native history is unchanged. It does not refresh native state. These
commands do not send messages or enforce global exactly-once delivery across
independent files; the coordinator must retain and resume the latest receipt.

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
