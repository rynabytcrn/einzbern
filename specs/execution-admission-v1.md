# Execution admission v1

The existing work-project-context / handoff boundary may carry an explicit execution request. `resolveExecutionAdmission(request, { home?, projectLimit?, now? })` makes a read-only, point-in-time admission decision. An ordinary context read without that request remains compatible and is not dispatch-ready. Admission does not dispatch, reserve slots, count running agents, install a model, verify native support, fetch account usage, or introduce a scheduler.

## Request and evidence

- `host`, `category`, `rejections` select the installed host's complete ordered policy tuple. `requestedAgents` is a positive safe integer and counts the requested concurrent agents, not completed work.
- `availableCombinations` is a caller-reported array of exact `{runner, model, effort}` tuples. Missing evidence refuses; a nonmatching tuple refuses. A match is `caller-reported-match`, explicitly `caller-reported-not-native-verified`. There is no fallback to another model, effort, runner, host, or historical project setting.
- Optional `expectedPolicy: {revision, digest}` binds a previously reviewed host policy. A mismatch refuses with `EXECUTION_POLICY_STALE`. It does not lock the file or prevent later changes. Callers must obtain a new admission immediately before dispatch, not reuse an earlier receipt after policy changes.
- Optional `usage: {observedAt, source, fiveHourUsedPercent?, weeklyUsedPercent?}` is transient caller evidence, never persisted in policy. Source must be nonempty, time a strict UTC instant not later than evaluation time, percentages finite from 0 through 100. Verification is always `caller-reported-not-account-verified`.
- `home` is the absolute device directory; the device cap is read from its `machine-settings.json`. A project budget can only tighten that cap. `now` allows deterministic evaluation and must be a strict UTC instant; production consumers normally omit it.

## Quota freshness and admission

The installed engine maximum observation age is 300,000 milliseconds (five minutes), inclusive. Projects cannot override it. Configured quota requires both windows and fresh evidence: missing, stale, or partial evidence refuses, even if the known window would otherwise allow serial execution. A fresh wait threshold refuses; a fresh serial threshold reduces the admission limit to one. Requests above the admission limit refuse, without silently resizing the requested work. Known restrictions do not turn unknown windows into known-safe windows.

Historical host entries without the optional quota extension remain valid. Their admission quota status and decision are `not-configured`, not parallel or safe. Legacy resolver defaults remain available as explicit defaults but are not invented configured thresholds or account observations. Admission in this state means only the configured capability and concurrency conditions passed; it makes no account-quota safety assertion.

## Response and refusal

`tcrn.execution-admission.v1` contains `status`, `reasons`, the normalized request, full `selection` (tuple, rejections, escalation, origin revision/digest), separate `policy` identity, capability evidence status, quota freshness/status/decision and source/time/age, concurrency device/project/effective/admission limits, and `evaluatedAt`. Readable policy identity remains present even when a requested category has no selectable tier. Missing policy yields no policy identity. `selection` is null when unavailable.

Explicit refusal reasons include the resolver's unavailable/unknown/empty category reason, `EXECUTION_CAPABILITIES_MISSING`, `EXECUTION_COMBINATION_UNSUPPORTED`, `EXECUTION_POLICY_STALE`, `EXECUTION_USAGE_MISSING`, `EXECUTION_USAGE_STALE`, `EXECUTION_USAGE_INCOMPLETE`, `EXECUTION_QUOTA_WAIT`, and `EXECUTION_CONCURRENCY_EXCEEDED`. Multiple independent reasons may be returned. Invalid requests and corrupt policy/machine files throw their structured validation errors rather than becoming ordinary absence or admission.

Only `status: admitted` permits the calling workflow to proceed with the returned exact tuple and requested count. A generated Skill must consume this result before native dispatch; a refusal requires obtaining fresh evidence, reducing the requested concurrency, or an explicit policy change, not bypassing the result. The external invocation must separately supply stdout/stderr/exit evidence. Unit tests and a caller-reported tuple do not prove native execution or actual quota availability.

## Existing workflow boundary

`work-project-context --id <work> --execution-request <JSON>` resolves this contract independently
for each involved project with that target's project cap. Each handoff carries the decision and
its work revision/reference. The aggregate `dispatchAdmitted` requires a selected nonempty target
set, admitted decisions and existing development readiness. Without the flag, context reads stay
compatible and explicitly return not-requested, never dispatch permission. Coordination-only
reads do not fabricate a development target. Actual host output is submitted separately through
`review-evidence.mjs` dispatchEvidence, as specified in dispatch-admission-evidence-v1.md.

## Snapshot and observation evidence

A work-context request reads each validated policy/device-settings file once and reuses
that capture for target and common-default contexts, catalogs, readiness, effective caps
and admission decisions. Every target uses the same evaluation instant. This is not an
atomic transaction across the separately stored files and does not reserve global capacity.
The standalone asynchronous resolver remains available; the pure snapshot resolver does
not reread files and validates its supplied policy/device records.

Quota evidence includes `fiveHourUsedPercent` and `weeklyUsedPercent` as numbers or null,
together with observation time, source, age and decision. Null means unobserved, never
zero. These are explicitly caller-reported, not account-authenticated measurements.

## Machine-facing entry

`execution-prepare` accepts scalar selectors and a machine observations file, captures these same contexts/admissions immediately before dispatch, and saves exact per-target bindings. `execution-record` mechanically derives repeated evidence fields from that saved preparation and an actual caller-reported process artifact. See the shipped `dispatch-admission-evidence-v1.md` for schemas, support matrix, private create-new persistence and failure semantics. This does not add an installed native dispatcher, capability/account collector, native-tool adapter, scheduler or reservation. Unsupported modes are reported once, not delegated back to the user as recurring hand-filled JSON chores.
