# CI impact plan v1

The schema is `einzbern.ci-impact-plan.v1`. `scripts/ci/impact-plan.mjs create <file>`
uses the checked-out contributor HEAD and GitHub event. `validate <file>` independently
rederives it from local Git, event and rules; `validate-remote <file>` additionally
recollects eligible exact-base remote provenance. `validate-baseline <file>` reconstructs
an older plan from its immutable Git objects. No successful artifact is reused across SHA.

| Fields | Meaning |
| --- | --- |
| `repository`, `event` | Repository and event identity; only PR/push can select |
| `comparison` | `base`, `before`, `head`, `method=merge-base\|before` |
| `head`, `tree`, `complete`, `records` | Current source and complete ordered Git status/path records |
| `rulesVersion`, `rulesHash` | Frozen classification rules and exact file SHA-256 |
| `baseline`, `baselineEligibility` | Previous run's exact-base provenance, honest coverage and eligibility/fallback reason |
| `runId`, `attempt` | Current execution, never inherited from baseline |
| `coverage`, `reasons`, `categories` | Full/selective verdict and explicit conservative fallback/category union |
| `shards`, `prerequisites`, `tasks` | Exact authoritative P1 partition and ordered tasks |
| `sourceCoreTests`, `sourcePortalTests` | Complete sorted source file catalogs |
| `coreTests`, `portalTests` | Exact current file selection; selected Portal always complete |
| `notApplicable` | Omitted core `path` or Portal `task`, explicit `rule` and `affectedPaths` |
| `planDigest` | SHA-256 of all other fields, recursively sorted object keys, compact UTF-8 JSON; array order remains semantic |

A verified baseline declares `state=verified`, `repository`, `sha`, `runId`, `attempt`,
`workflow`, `conclusion`, `coverage`, `verification`, `evidenceDigest`. Full requires
`CI_VERIFIED`; selective requires `CI_SELECTED_VERIFIED`. Only actual successful
workflow/jobs plus rehashed retained evidence qualify. The collector bounds API pages;
any incomplete page, denied request, missing object, unavailable/legacy artifact or
uncertain validation returns `state=unavailable,reason` and a full current plan.

Classification accepts only audited modified paths for selection. Added, deleted,
renamed and copied records remain represented completely and force full. README and
listed explanatory Wiki pages select documentation contracts. Privacy selects all
privacy and audited consumer regressions. Portal selects the full Portal train plus
root consumers. CI integrity tests always run. Union applies to mixed known changes;
Core/CLI/protocol/shared/build/dependency/controller/policy/unknown changes force full.
The first policy patch, manual P1 and release validation are full.

Artifact-pin-only compares both complete workflow files. Only full 40-hex refs for
`actions/upload-artifact` and `actions/download-artifact`, and their same-line numeric
version comments, are masked. Every other changed byte selects full. Actual historical
cumulative fixtures classify #29 full, #31/#32 pin-only and #33 privacy; tests explicitly
inject baseline eligibility and do not claim historical CI success.

Checks always preserve every current non-Core/Portal P1 task, archive before full
HEAD-reachable privacy, wiring, package/archive digest/unpack and isolated install,
setup and doctor. Exact tool pins and offline execution remain. Core selection enters
only through explicit `test --ci-plan`; default test/H1/P8 use their original rosters.
Core's maximum remains 900000ms, P8's 600000ms. Selected Portal is all recursive tests
and six existing steps, with build prerequisite and original isolation/output handling.

Every `verify` rederives the plan, requires successful plan and selected jobs, and
checks the exact downloaded artifact set, plan, raw receipts, source manifests, actual
controller argv, SHA/tree/run/attempt and bytes. Missing, duplicated, extra, reordered,
failed/cancelled/timed-out or forged N/A evidence is red. Full returns `CI_VERIFIED`;
selective returns `CI_SELECTED_VERIFIED`, `coverage=selective`. Release/full-P1 consumers
must require full. PF2-H1 remains its separate literal Corepack invocation.

The plan artifact includes deterministic binary payload and manifest under `transport/`.
`transport-evidence.mjs create|verify <directory> <plan>` binds SHA/run/attempt/plan digest,
rehashes bytes and rejects missing/extra/symlink files. The workflow requests pinned official action transfer of
the same-run bytes. Package smoke retains a manifest seal and all existing outcomes.
Fixture verification is a component result, not actual hosted transport. Candidate
remote transfer and any 3–5 minute speedup remain unknown until separately authorized
remote CI produces measurements. Mana retains its current lightweight full distribution
verification; no global/live policy, installation or release permission is implied.


Full-P1 reuse in `push-gate-p1-coverage.mjs` requires Core's actual
`TESTS_VERIFIED` terminal type. An explicit coverage field must be `full`;
ordinary older full receipts may omit it. `TESTS_SELECTED_VERIFIED`,
`CI_SELECTED_VERIFIED` and relabeled full reasons with `coverage=selective` cannot
cover the Core leg in either `judgeLegOutput` or `assessP1Coverage`. The exact
package-script argv, repository/run/output-byte and zero-warning predicates
remain required. Default task execution and aliased task paths share the same
unconditional CLI lifetime, including the original heavy-slot terminal release.

The document audit is explicit for each eligible README/Wiki path. It scans
tracked text inputs across executable and configuration languages, including
Python readers invoked by Node tests, and follows literal path/basename reverse
dependencies. Documentation and known opaque image/font assets are excluded from
reader-source scanning; unknown binary or unreadable inputs remain unresolved.
The reviewed reader and test declarations are frozen in the rules file. Runtime
planning never updates them. A new staged/tracked undeclared reader, missing
declaration or unresolved reader forces full coverage. Current working bytes and
immutable baseline Git bytes use the same scanner and closure. Audited Core
consumers join the selected roster; audited Portal consumers retain the complete
Portal train. Categories still union and any conservative full trigger wins.

Baseline acquisition is a separate, read-only online CI capability. It requires
CI and GitHub Actions, the plan or verify job, the matching repository and CI workflow reference, a push
or pull-request event, and the explicit
`EINZBERN_CI_BASELINE_ONLINE=read-only` opt-in. Only the plan and final verify
steps opt in. The single reviewed GET site accepts literal HTTPS GitHub API
repository-scoped CI run, attempt-job, artifact-list and artifact-ZIP endpoints,
standard API headers and a 20-second request timeout. GitHub's artifact download
redirects are handled by the standard fetch redirect policy. Invalid context,
endpoint, permission, pagination, provenance or evidence falls back to full.
The exact guarded call-site source is checked by the offline boundary; changed
hosts, endpoints or guard text and additional requests remain findings. The
engine and offline event/source planner retain their network guard.

Whenever wrapper metadata contains an impact plan, `impact-plan.json` requires
its own bound file receipt and is reread for exact size and SHA-256 as well as
parsed-plan equality. Download aggregation repeats this check and independently
derives the plan from Git/event/rules, including baseline reader completeness.
Reserializing identical JSON bytes is therefore detectable.

The component fixtures own canonical clean Git sources with byte-identical
production task, shard, bootstrap and child-policy scripts, real harmless tests,
and complete tiny reader declarations. They call the real task CLI and shard;
no imported controller or receipt-printing substitute is used. Full and selective
positive plans must satisfy the same strict reasons and digest reconstruction as
forgeries. Selected tests leave a marker and an unselected failing sentinel stays
unexecuted. The production read-only FD observer retains actual Core raw output,
step argv, task/shard receipts and before/after source manifests.

The full and selective aggregate and baseline collector cases use real ZIP bytes;
only API transport is mocked. Runner, aggregate and collector verdicts have
separate registered cases/subtests. Negative cases cover retained-plan byte drift,
head/tree/run/attempt/source drift, missing/failed/cancelled/timed-out/skipped jobs,
partial/expired/mislabeled artifacts, manual H1 and fully resealed selection/N/A.
Package and other-leg inputs remain explicitly synthetic validator components.
These cases do not establish hosted P1, an installed product or official action
transfer. Implementation authors them without running tests; the parent batch
records the actual validation results.

The mandatory CI-integrity baseline suite registers the exact-site offline scanner
positive and host/endpoint/context-guard, extra-request/import and unrelated-module
mutations under the normal Core `TCRN_OFFLINE_PROOF=1` environment. Only the inner
runtime-network proof is guarded against recursive scanner execution. No network
capability, source-file exemption or child-spawn allowance is added.

The current Portal source-proof block is refreshed once by the existing parent
batch-end step after integration. Historical proof bindings remain unchanged.
Official action transport and hosted elapsed-time improvement for this candidate
remain unverified until separately authorized execution; the 3–5 minute target
has no measured speedup claim.
