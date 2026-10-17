# Admission-bound dispatch review evidence v1

The existing `scripts/review-evidence.mjs --request <file>` submission path accepts optional `dispatchEvidence`. This is an association of a supplied native host return with one project-target admission handoff, not a scheduler, native adapter, execution capability probe, process launcher, or reservation. It does not independently authenticate a caller-supplied host return, refresh a policy, or make a stale admission current. Obtain the actual admission immediately before dispatch and retain the actual host response. A digest proves consistency, not provenance or authorization.

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
