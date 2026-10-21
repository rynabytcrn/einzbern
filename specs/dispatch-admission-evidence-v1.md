# Admission-bound dispatch review evidence v1

The installed public entry is `node <engine>/scripts/einzbern.mjs execution-evidence --from-file <evidence.json>`. It requires only the archive and its supported Node.js runtime, not a registered library, source checkout, account, or node_modules. Run `node <engine>/scripts/einzbern.mjs execution-evidence --help` for flag help; `commands` also lists it. The file is a JSON object containing `handoff` and `hostResult` as described below. This format document is shipped at `specs/dispatch-admission-evidence-v1.md` in the engine archive.

The CLI prints the normalized result as JSON to stdout. Exit 0 means valid, complete association only, not successful native execution: a nonzero host exit code is preserved unchanged. Exit 1 means invalid/refused/mismatched evidence, unavailable observations, or an input/usage error; stderr carries a reason code. Malformed or unreadable JSON does not produce an association result. It makes no external calls or library/device writes.

For source-repository reviews only, `scripts/review-evidence.mjs --request <file>` accepts the same object under optional `dispatchEvidence` and reuses the identical core validator. This source-only harness is not required or shipped for installed users. This is an association of a supplied native host return with one project-target admission handoff, not a scheduler, native adapter, execution capability probe, process launcher, or reservation. It does not independently authenticate a caller-supplied host return, refresh a policy, or make a stale admission current. Obtain the actual admission immediately before dispatch and retain the actual host response. A digest proves consistency, not provenance or authorization.

## Input contract

`dispatchEvidence` contains:

- `handoff`: the target handoff from `work-project-context`, including `workId`, `workRevision`, `reference: {libraryId, projectId}`, and `executionAdmission`.
- `hostResult`: the returned evidence envelope described below. The caller must populate observations from the actual host response, never from a review verify or test run. If the host did not return an observation, mark it unavailable.

`hostResult` fields:

- `schemaVersion: "tcrn.host-dispatch-evidence.v1"`
- `source: "native-host-return"`
- `workId`, `workRevision`, `projectReference: {libraryId, projectId}` matching the handoff exactly.
- `request` matching the admission's normalized `{host, category, rejections, requestedAgents}`.
- `selectedTuple: {runner, model, effort}` matching `executionAdmission.selection.record`'s corresponding fields.
- `policyRevision`, `policyDigest` matching `executionAdmission.policy`. The admission's selected policy origin must also match this identity, and selection host/category/rejections must match its request.
- `admissionDigest`: lowercase SHA-256 of the entire `executionAdmission` receipt's canonical JSON. Object keys are sorted recursively; array order is retained; no whitespace is added. Exported `dispatchAdmissionDigest` computes this value. Non-JSON values are invalid.
- `stdout`, `stderr`: each either `{status: "available", value: <actual returned string>}` or `{status: "unavailable", reason: <nonempty explanation>}`. An explicitly observed empty string is valid; omission is not an empty string.
- `exitCode`: either `{status: "available", value: <actual nonnegative safe integer>}` or `{status: "unavailable", reason: <nonempty explanation>}`. String `"0"`, missing exit, null, and a successful status label never become numeric zero. A host termination without a returned exit code uses unavailable with its reason.

The pure `normalizeDispatchAdmissionEvidence(value, {workId, workRevision})` validates association without native calls. `collectReviewEvidence` supplies the review's work ID and revision read from the existing bound work record; an unavailable bound revision makes an explicitly requested association incomplete. Stable references use the engine's library/workspace and project ID syntax.

## Results and failure behavior

The review result includes `evidence.dispatch`:

- Omitted `dispatchEvidence`: `requested: false`, `status: "not-requested"`, `complete: false`. Legacy review behavior is unchanged, and a green legacy review is explicitly not dispatch proof.
- Valid complete association: `status: "associated"`, `valid: true`, `complete: true`. Actual output and exit code are preserved. Association is not itself a successful-execution claim: the collector separately fails review for nonzero host exit.
- Explicit unavailable observations: `status: "unavailable"`, `valid: true`, `complete: false`, with unavailable field names and original reasons. The collector fails requested review completion.
- Missing, malformed, refused, or mismatched evidence: `status: "invalid"`, `valid: false`, `complete: false`, with problems. A refused admission remains refused even when its digest matches. Null is an explicit invalid request, not omission.

Requested evidence carries `verification: "caller-supplied-host-return-not-independently-authenticated"`. Review-command output and test summaries remain separate evidence and never fill dispatch observations or override failed dispatch association. The caller-reported capability and account-usage limitations in the admission remain intact. This association supplies no write authority, quota reservation, native model support verification, or permission to execute.

## Deterministic checks

Run `node --test tests/dispatch-admission-evidence.test.mjs`. These tests use plain object fixtures, not host dispatches or native calls. They cover omitted/invalid requests, full association, canonical full-receipt digest, refusal, binding mismatches, absent and malformed observations, explicit unavailability, review-test provenance rejection, and preservation of nonzero exit codes.

## Machine preparation and recording (installed)

These two bounded commands automate binding fields, not native execution. Both are cataloged as `mutates: true` because they create explicitly named private local files. The original `execution-evidence --from-file` remains read-only and retains its original exit semantics.

1. `execution-prepare --workspace <library> --id <work> --host <host> --category <category> --rejections <count> --requested-agents <count> --observations <machine-observations.json> --output <new-private-preparation.json>` reads the current work/project contexts and admission policy. Normal registry workspace resolution is supported. Observations contain only `availableCombinations`, optional `usage`, and optional `expectedPolicy`, with the same admission schema above. Missing capability evidence is refused, never derived from policy. Original usage timestamps are retained, never refreshed. The result has `schemaVersion: "tcrn.dispatch-preparation.v1"`, original `selectors` and `observations`, exact `context`, ordered `bindings` (zero-based `target`, exact `handoff`, canonical `digest`), and a digest of the other preparation fields. Every involved target, including unresolved/refused targets, is retained. A refused preparation is saved before exit 1; admitted preparation exits 0. No dispatch occurs.
2. Immediately before a separately authorized dispatch, the calling host uses the selected exact handoff. It carries that binding's digest into its process-return artifact, without asking the user to construct repeated JSON fields. The engine does not install that calling-host integration. Re-prepare if policy, work, observations or batch size changed; the saved artifact is evidence, not a reusable permit. There is no occupancy reservation or independently checked provenance.
3. `execution-record --binding <saved-preparation.json> --target <index> --process-return <actual-process-return.json> --output <new-private-record.json>` derives work/revision, project reference, request, policy identity and admission digest mechanically from the selected binding, then runs the existing normalizer. It saves the exact raw artifact and normalized result, even for failed, mismatched or unavailable observations. No fresh admission is manufactured after execution.

The supported machine process artifact is a closed JSON object:

- `schemaVersion: "tcrn.dispatch-process-return.v1"`, `source: "native-host-return"` explicitly asserts the caller is reporting a native host process, not a review/test runner.
- `bindingDigest`: the selected preparation binding's digest, carried by the caller at dispatch. It is not recomputed from an unrelated result afterward.
- `selectedTuple`: the actual invocation's caller-observed exact `{runner, model, effort}`. This must come from the invocation, not be copied from the desired policy. The normalizer compares it to admission; missing or substituted fields fail. It remains caller-reported, not independently authenticated.
- `startedAt`: the actual process start as a strict UTC instant. It must be no earlier than admission, no later than five minutes after it, and not in the future. This bound rejects known stale starts; it is not a promise that five-minute-old policy remains current. Configured quota observations must also still be fresh at that actual start. Recording may happen after a long-running process finishes.
- Optional `stdout`, `stderr`: actual returned strings, including observed empty strings. Optional `exitCode`: actual nonnegative safe integer. Omission becomes explicitly unavailable, never an empty string or zero. Present null, string exit codes and other malformed values remain invalid rather than being repaired. Termination without a returned exit code omits that field.

The record uses `tcrn.dispatch-record.v1`, retaining target, selected handoff, preparation digest, raw artifact, and normalized association. A complete zero-exit association exits 0. Invalid or unavailable association, or a complete nonzero process exit, exits 1 after persistence (`DISPATCH_EVIDENCE_INVALID`, `DISPATCH_EVIDENCE_UNAVAILABLE`, or `DISPATCH_PROCESS_FAILED`). Unreadable/malformed JSON or invalid selectors are input errors, not fabricated records. Saved binding mutations and mismatched process binding digests fail association; a digest detects inconsistency, not malicious rewriting or host authenticity. Historical recording does not reread current work/policy or certify dispatch actually followed them.

Outputs must be new files in an existing local parent directory outside device and library roots, including detected unregistered library ancestors (preparation also excludes its explicit workspace). Existing outputs are never replaced; create-new mode requests 0600 permissions. No chmod of existing files, library writes, uploads or automatic publication occurs. Host filesystem permission semantics still apply. Contexts, paths, variables and process streams may be private: use a private local directory, not a repository/shared or cloud-synced folder, and do not publish these files by default. Neither command stores credentials, reads account usage, executes a supplied command, starts a native agent, schedules work, or installs a retired observer/controller.

### Support matrix

| Surface | Installed support |
| --- | --- |
| Machine scalar selectors + explicit observations → exact per-target binding | Yes, `execution-prepare` |
| Saved binding + caller-reported process artifact → raw and normalized local record | Yes, `execution-record` |
| Legacy envelope association, no persistence | Yes, `execution-evidence --from-file` |
| Native capability/quota auto-collection and authenticated account reads | No collector installed |
| Native process launch or native-tool response conversion | No adapter installed |
| Scheduler, reservation, reusable dispatch permission | Not provided |

This matrix describes the historical process protocol only. Normal Codex, Claude and dot native tools use `specs/host-fallback-v1.md`; missing a process conversion adapter does not prohibit an authorized native invocation. Preserve old records under their original protocol, never fabricate stdout/stderr/exitCode or retrofit an allowed decision into a refused v1 record. A real unsupported tool or permission denial stops only its affected action. Do not request repeated manual JSON or approval substitutes for missing optional telemetry.
