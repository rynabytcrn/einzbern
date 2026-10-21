# General native execution and authorized host fallback v1

Status: implementation contract for INIT065 / MIN357, implementing the existing MIN356 D1–D3 decisions. This document does not claim any real-host regression or installation acceptance has passed. The original INIT064 stop happened before a native invocation or that dispatch's engine rejection: the installed Skill incorrectly converted missing process-style evidence integration into a dispatch stop.

## Scope and compatibility

C1–C3 provide normal native execution guidance, read-only policy resolution, project-context/CLI wiring, native report recording, and matching installation navigation. Config-saving transactions (S1/S2) and ranked candidate recommendations (R) are separate deliveries, never prerequisites for native execution. Existing process and dot v1 records retain their original validators and admitted/refused semantics. Do not reinterpret a legacy refusal as a new allowed decision or migrate its bytes implicitly.

The new request is `tcrn.host-execution-request.v1`; decision is `tcrn.host-execution-decision.v1`; preparation is `tcrn.host-native-preparation.v1`; retained record is `tcrn.host-native-record.v1`. Unknown versions or decision states are uninterpretable, not default allow. `executionDecisionEligibility` is the common mapping used by project-context and preparation. `allowed` and `degraded` are executable; `blocked`, `awaiting-choice`, and `reconcile` are not. Current preparation is deliberately degraded: requested values are known but actual host selection is not attested.

## Normal execution, not a new runtime adapter requirement

An authorized caller uses its currently exposed Codex, Claude or dot native tools and normal prompt/report instructions. No separate runtime adapter or successful prior launch is required. The optional engine audit commands are not a replacement launcher and do not grant platform permissions. The caller assembles their JSON from actual context; never ask the user to hand-fill repeated metadata. Failure to express optional audit metadata must not stop an otherwise authorized native call; retain the available raw result and label the affected conclusion unknown. Real permissions, explicit hard limits, applicable source scope and approved work method still bind the caller.

Separate `hostKind` (codex/claude/dot), `invocationKind` (native-tool), and `selectionControl` (explicit/host-managed/unknown). Claude reads the existing `claude-code` policy partition. Dot remains host-managed for its own model; it neither invents a selected model nor reads unrelated model/quota policy as an admission gate. Codex/Claude may use a host-managed alternative when their exposed tool contract and existing authorization permit it.

## Request and action applicability

A request identifies current work/revision, action (decomposition/research/coordination/implementation), phase (dispatch/work), category, quality rejection count, requested child count, tool capabilities, requested selection, existing authorization report and context readiness. The report is not authentication or newly minted permission.

- Parent reads its required context before dispatch. A child may be created with child=`not-created`; that child must read its own required context before phase=`work`. No pre-creation child receipt exists or is required.
- INIT064 regression retains coordination-only `targets=[]`. Authorized decomposition/research/coordination requires no development target or synthetic binding.
- Source implementation requires the actual repository, absolute writable roots, and granted permission in `sourceScope`. If a `projectRef` is explicitly requested, it must belong to the current work and its applicable design/repository/output/language readiness is checked. A report cannot override actual tool filesystem restrictions. Optional `saveRequirement` only blocks execution when the user explicitly required saving first; pending or failed optional saving does not revoke execution authority.
- Pending/failed parent context, absent source permission for implementation, cancelled/completed/blocked work, and actual permission denial affect that action, not unrelated work.

## Configured intent, fallback and errors

`configuredIntent`, `requestedSelection`, and `actualSelection` are distinct. The first is from the validated device policy, the second is what the caller is to request, and the third remains unknown until the host actually reports it. Ordinary exact model/effort configuration is a preference, not an implicit no-substitution instruction.

Unconfigured host or empty configured entry may use the available request. Unsupported configured combinations may use a caller-observed `fallbackSelection` directly under existing `same-host` or `listed-selections` authorization. The core does not guess vendor models or rank candidates. `selectionObservations` retain each exact selection, support state and observation instant; current negative support overrides a stale catalog. An alternative without enumeration requires its own fresh supported observation, not the failed original's flag. Unknown/stale observations remain unknown. `authorization.status=covered` reports assessment of the actual selected action including provider, data scope and cost, not merely runner equality. The optional `fallbackBoundaryAssessment` makes known unresolved/outside boundaries explicit and requests a decision only for that fallback. Its absence does not create another mandatory metadata gate or enlarge existing authority. With a supported alternative and existing coverage, additional confirmations=0 and persistent configuration writes=0. Outside existing coverage, return the concrete choice requiring authorization; do not repeatedly ask for already-covered class fallback. Persisting a configuration is a separate explicit decision, not a side effect of temporary use.

Missing policy file is absence; malformed JSON/schema, digest mismatch and I/O failures propagate their real errors. They are not converted to empty configuration. Model unavailable, rate limiting, network failure, missing telemetry and policy errors do not increment quality rejection history or silently reset it. Only an actual quality rejection increments once per retained event id. Technical retry is subject to known non-execution or prior reconciliation, backoff, and existing authorization; actual denial stops its affected action.

## Optional information and hard limits

| Information | Missing-state effect |
| --- | --- |
| Exportable authorization/source reference | Existing current-conversation authorization remains valid; audit reference unknown |
| Session/provider identity | Not required to launch; provider association remains unknown |
| Full model enumeration | Not a prerequisite if the native tool accepts the selection request; known unsupported selection uses fallback |
| Actual selected model | Unknown, never copied from desired configuration |
| Platform occupancy/limit | Unknown, never zero; host enforces its own platform constraint |
| Account usage window | Unknown, never zero; missing window alone does not stop execution |
| Process stdout/stderr/exitCode | Not applicable to a native tool return; never synthesize |
| Explicit user hard budget/call/no-substitution/concurrency constraint | Must remain satisfied; unresolved hard guarantee stops only dependent action |
| Actual source repository/scope/permission | Required for implementation, not coordination |

Known platform capacity and explicitly configured project/device concurrency caps remain applicable. Known fresh usage crossing an explicitly configured quota wait/serial threshold is respected. Optional missing or stale quota windows do not establish permission to exceed a known hard limit and do not themselves ban native execution. The five-minute freshness comparison is only an observation boundary, not a task timeout. Unknown outcomes require reconciliation before duplicate invocation.

## Optional audit commands

1. `execution-host-prepare --workspace <library> --request <json> --arguments <json> --output <new-file>` reads current work and policy, runs the versioned project-context path, and stores a local preparation. Arguments JSON is `{selection, argumentsValue}`. Selection must match the resolved request; it is not proof of actual use. `attempt.id` is explicitly local correlation, never a provider/session ID. Nonexecutable preparation is retained with no attempt and a failing CLI status.
2. The authorized caller invokes the native tool itself and retains actual prompt/arguments/returns. The engine does not invoke a child or claim success.
3. `execution-host-record --binding <file> [--events <json-array>] [--prior <file>] --output <new-file>` retains available events. A valid pending recording exits successfully as recording, not as completion. Invalid input evidence is retained with an invalid outcome, not repaired.
4. `execution-host-evidence --from-file <file>` recomputes the record from retained inputs. Integrity is not independent authentication or acceptance.

Artifacts use the existing create-new private file writer, outside device/library roots; existing files are never overwritten. They may contain private prompts, paths and results: do not automatically commit or publish them. Optional identifiers remain optional. Digest detects inconsistency, not malicious rewriting or user identity.

## Reports, host returns, reviews and cancellation

`work-report` contains a normal summary, context reads, artifacts, checks and limitations. It can support delivered-awaiting-review without process fields or exported session ID. It does not prove host finality or independently verify its own claims.

`host-response` retains exact raw data and source tool. A wait/status tool may differ from spawn; preserve its true name and associate it to the existing local attempt with the caller's actual query basis. This is local correlation, not a required exported provider identity. Wrong-attempt association is rejected, never silently relabeled as spawn. Optional JSON pointers map only existing fields. Confirmed terminal state requires an actually returned terminal field and its documented meaning, not a report saying “done”. `review` separately records the reviewer, result and evidence; it does not manufacture a host result. Actual model/provider fields, when available, are extracted from raw bytes, never desired configuration/local IDs.

Cancel-requested stops new work. Cancel-accepted records host acknowledgement, not termination. Occupancy remains retained-or-unknown until actual terminal confirmation. Completion received during cancellation remains completion; a late accepted/running event cannot regress a confirmed terminal. Contradictory terminal events remain retained and produce unknown finality/reconciliation. Duplicate identical events are idempotent; same id/different content is a visible conflict. Pending/unknown tasks keep follow-up responsibility and useful handoff information, with bounded host-specific status checks, not busy polling or invented closure.

## Installation and fresh-session consumption

Generated Skill includes `Execution protocol: tcrn.host-execution-request.v1.` and normal navigation to the three general-native commands for Codex/Claude/dot. The archive installer and normal setup validate this marker against that candidate engine's command catalog at installation time. Mixed pairs are not installed. This is not a runtime adapter or per-dispatch compatibility probe. Historical pairs without the marker remain explicitly legacy and make no new-path guarantee.

Normal setup preserves modified installed Skill copies for review rather than silently overwriting divergent recorded bytes. Existing backup/atomic installation mechanisms remain in use. A downgrade to a historical Skill restores historical behavior and cannot be reported as this fix. No persistent model configuration changes occur during native dispatch. E and Mana installer sources must match; generated Skill and release outputs are refreshed only after cumulative inputs freeze.

## Acceptance mapping and evidence boundaries

Authored deterministic fixtures cover T01's original coordination shape, T02's actually unavailable configured value and authorized fallback, versioned whole-path T15, error classification/quality separation, two-stage context/source scope, hard limits, report/finality split and T13 cancellation race. These are fixture evidence only.

Independent C4 must additionally run T01/T02 with actual exposed host tools and T03 in a new session consuming the normally installed candidate Skill. Record candidate commits, matching installer/generated bytes, prompt/read/return/report, extra confirmation count=0, dispatch-stage persistent configuration writes=0 and fabricated bindings=0. Record Codex, Claude and dot independently; unavailable real host paths stay unverified. A fixture success or current-session verbal clarification is not installed fresh-session evidence. S1/S2 saving and R recommendations report their own results separately. No automatic deployment, installation on real devices, merge or release is authorized by this specification.

## Optional recommendation

`execution-fallback-candidates --request <request.json> --at <UTC>` reads reported host combinations/observations and current policy. It does not call a model, write configuration, mint authorization or replace action-specific preparation. Normal execution does not depend on this command. Corrupt policy errors remain errors, not an empty recommendation.

Candidates come only from reported tool combinations, fresh supported per-selection observations or the exposed host-managed contract. Same-model effort variants then same-runner alternatives receive soft precedence; no effort strength equivalence across providers is inferred. Cost and quality stay explicitly unknown. Explicit hard limits and actual tool absence are honored. Existing authority is assessed by the same core decision function; a suggestion awaiting a decision is not permission to execute.

The first three entries are a presentation budget, with an omitted count. This is not a limit on authorized calls or retries. Known authorized alternatives remain directly executable without first generating or choosing from a recommendation list. Missing optional observations do not introduce a new execution gate.
