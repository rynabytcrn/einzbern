# CI verification

The complete P1 roster is defined by `scripts/p1-sequence.mjs`. The local
`verify:p1` command remains serial. GitHub Actions uses an explicit impact plan to partition that roster:

| Job mode | Work | Isolated state |
| --- | --- | --- |
| `p1-checks` | Format, lint, types, build, archive, dependency boundary, offline, full-history privacy, links, retrieval; test wiring and package/install/setup/doctor smoke | Full clone, HOME, TMPDIR, device directory, dist |
| `p1-core` | Exact planned core test files; complete roster for full coverage | Separate full clone and runtime directories |
| `p1-portal` | Build prerequisite and complete Portal train | Separate full clone and runtime directories |

The required `verify` job waits for every matrix member. It refuses missing,
cancelled or failed jobs, mismatched source commits or run attempts, incomplete
task coverage, changed source manifests, and missing or altered retained bytes.
It does not infer success from whichever artifacts happened to upload. Package
smoke remains part of the checks job's success condition.

Manual `pf2-h1` runs remain a single explicit H1 invocation using pinned Corepack.
They do not run P1 or package smoke and do not establish whole PF-2/PF-3 acceptance.
The full Core controller limit is 15 minutes (900000ms); P8 remains 10 minutes (600000ms); incomplete tests remain red.

## Portal evidence and fixtures

Each Portal invocation retains raw stdout, stderr, exit status and duration for
every executed step. CI uploads these even after failure. The former seven-step
train now has six top-level steps: functional tests, current proof, cross-repo
privacy test, design reconciliation, design proof, and evidence meta-proof.
The removed standalone full evidence check was identical to the meta-proof's
final restoration check.

The meta-proof retains both current and historical mutation negatives and one
complete restoration replay. Its three phases and each of the three historical
blocks have separate timing records. Historical files and archived checkers
remain bound to their original commits. The complete replay runs whenever Portal is selected; full runs always select Portal.
Passing test output is retained as well as failing output; a `P1_RED` receipt on
stderr remains available as the original diagnostic.

The large Portal suites are grouped by functionality. Node gives each test file
its own process; tests inside a file remain sequential because fixture helpers
temporarily select a device through process environment variables. Initialization
batches six real CLI operations into one child process, with a fresh pair of
libraries and private HOME/device paths for each fixture. An explicitly overridden
CLI retains its process boundary. No shared writable library or prebuilt event
stream replaces the engine writer.

Core and Portal runners share the test-file selection predicate with test wiring.
The aggregate checks the selected core roster and complete Portal roster against the plan and full source manifests.
Nested Portal tests are executed too.

## Mana Orchestrate

The helper has one lightweight workflow: reproduce the generated distribution,
check its version and JavaScript syntax, and check the skill archive. It builds
the pinned generator but does not run the engine's core or Portal suites.
`.github/engine-source.json` names an immutable engine commit and an explicit
render version. The generator can reproduce a new release version from the clean
commit before the release version bump by passing `--version`.

The workflow, source reference and archive script are generated outputs owned by
`render-helper-docs.mjs`. They therefore survive `release generate` without a
manual extra-file exception. Publish the referenced engine commit before running
the helper workflow; local verification cannot make an unpublished commit
available to GitHub Actions.

Parallel jobs reduce the critical path only when runner capacity is available.
Extra runner startup, checkout and prerequisite build cost still counts toward
total compute. Queue time, execution time and end-to-end workflow time must be
reported separately. Local measurements are not GitHub-hosted runner benchmarks.

## Conservative impact planning

PRs use the cumulative merge-base of event base and contributor head, not the last
commit. Main pushes use before/head. Complete NUL-separated Git status records
retain both rename/copy endpoints and deleted old paths. New, renamed, copied,
deleted, unknown or incomplete changes conservatively select full verification.
Manual P1 and release validation stay full. The policy patch itself is full.

Selection needs successful applicable verification for the exact comparison base.
The read-only collector checks the workflow run and jobs, downloads retained bytes,
checks their manifests and receipts, rederives the old plan from Git and preserves
its declared full or selective coverage. Missing API permission, objects, artifacts,
pagination or provenance falls back to full. Legacy evidence without this plan
contract also falls back to full. A sound selective baseline is eligible without
being called full P1. Baseline bytes never replace current-head evidence.

The frozen `scripts/ci/impact-rules.json` maps ordinary README/Wiki explanations
to documentation contracts, privacy to privacy and consumer regressions, and Portal
to its full train plus root contract tests. Historical, generated, specification
and unlisted paths stay full. Categories union; any full trigger wins. New consumers
outside the audited snapshot force full. Action-pin-only requires equality of the
whole workflow after masking only official upload/download-artifact full 40-hex
refs and their same-line version comments. A changed option, command, condition,
permission, timeout, step order or other text forces full.

Every run retains all checks tasks, archive before full HEAD-reachable privacy,
test wiring and isolated package/install/setup/doctor smoke. CI contract tests
always run. `verify` independently rederives the current plan, validates the exact
selected tasks and test argv, rehashes downloaded evidence and transport payload,
and requires successful plan and selected matrix jobs. Missing, cancelled, timed
out, forged skipped/N/A or mismatched bytes remain red. Full success is
`CI_VERIFIED`, coverage `full`; selection success is `CI_SELECTED_VERIFIED`, coverage
`selective`. Selective success cannot satisfy full P1 or release consumers.

The same-run plan artifact contains a deterministic binary transport payload and
manifest bound to SHA, run, attempt and plan digest. The workflow requests upload/download through pinned official actions; final
verification rereads the downloaded bytes. Local fixture tests exercise the
validators, including both accepted coverage types and corruption/identity negatives. This candidate's real remote
transfer and hosted timing require a separately authorized push/CI run. A 3–5 minute
workflow remains a goal; measured speedup is unknown.

See [the machine contract](../specs/ci-impact-plan-v1.md) for fields and entry points.


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
