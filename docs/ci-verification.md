# CI verification

Ordinary pull requests, main pushes and manual dispatch run one fixed `ci-light`
job followed by the strict same-source `verify` aggregate. The workflow retains its
historical display name, **P1 verification**, for check-name compatibility; its
current success is **`CI_LIGHT_VERIFIED`, `coverage=light`**, not full P1.
See the distinct [light machine contract](../specs/ci-light-v1.md).

The fixed roster is format, links, test wiring, lint, build (including its nested
typecheck), the explicit bounded light contract tests, Portal current proof,
design reconciliation and design proof, no-sibling dependency, offline boundary,
retrieval evaluation, source archive, then full HEAD-reachable privacy. Direct
Node tests preload the existing `scripts/no-network.mjs`; workers and ordinary
Node descendants inherit that guard. Offline flags are not a substitute for it.
Existing worker/memory admission remains in force. Package smoke separately packs,
hashes, unpacks and invokes the actual archive and installed setup/doctor.

The aggregate requires successful jobs, exact HEAD/tree/run/attempt/roster digest,
source manifests, ordered steps, raw streams and byte hashes, real TAP totals and
package bytes/outcomes. Missing, altered, failed or cancelled evidence is red.
Skipped and todo tests remain reported as such, not converted to passes.

Full Core, full Portal, full impact regressions, PF2-H1, P8 and release validation
are `notRunHere`; full local acceptance remains separately required. Fixed light
coverage does not expand on unknown changed paths and does not claim those paths
are safe. There is no baseline lookup or impact selection on this hosted path.
The local `verify:p1` and explicit wrapper `--mode pf2-h1` remain unchanged full
contracts; hosted manual dispatch no longer selects P1/H1. Core's full controller
cap remains 900000ms and P8's remains 600000ms; incomplete tests remain red.

## Portal evidence and fixtures (local full validation)

Each local full Portal invocation retains raw stdout, stderr, exit status and
duration for every executed step. The retained legacy full-mode tooling can upload
these even after failure. Routine hosted light CI calls only bounded Portal proof,
cross-repo privacy and design checks; it does not run the full functional/meta-replay
train or infer its test count from the wiring registry. The former seven-step
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

## Retained legacy/full-mode tooling

The sections below describe retained full/selective tooling, not the routine
hosted light workflow. Its original proof rules and source audit remain intact;
light evidence is never eligible as its full/selective baseline.

### Conservative impact planning

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

Normal release version changes preserve the frozen reader audit without rewriting
its declarations. Only the top-level stable version in the four canonical engine
manifests and the single core `FRAMEWORK_VERSION` literal are normalized; every
other byte remains audited. Version diffs still select full verification. A changed
script, dependency or reader, even in one of those files, invalidates the old audit.
After source integration, freeze the final reader and root-test maps together;
refreshing hashes alone cannot account for a newly merged consumer.

Every legacy/full-profile run retains all checks tasks, archive before full HEAD-reachable privacy,
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

The document audit records separate readers, root tests and Portal consumers in
`documentAudit[document]` for every allowlisted README/Wiki path. Only the changed
documents' maps join the selection. Privacy and Portal use the same exact-input
reverse caller graph. Comments, regex bodies, embedded fixture-program strings,
known output writes and path predicates do not create executable input edges;
`strip-catalog.mjs` cannot match `log.mjs`. There is no arbitrary basename match.
A real document/privacy reader in Portal still selects the complete Portal train.

The finite scanner follows literal imports, whole input tokens, file-local constant
aliases and arrays, finite loop bindings, and static `join`, `resolve`, `dirname`
and `URL` paths rooted at the source or repository. Built package `.js` imports
map back to tracked `.ts` sources. Python `Path`/open inputs and Node subprocess
arguments preserve real cross-language callers. Exact configuration and unsupported
text-language input tokens remain conservative candidate edges. Unknown path roots
are not discarded to turn a disposable fixture into the repository. This is not a
universal parser or proof for arbitrary dynamically generated programs; alias scopes
are conservatively unioned and some extra contracts can run.

`sourceAudit` binds the reviewed non-document text inventory to SHA-256 bytes.
The CI workflow alone uses the classifier's same strict official artifact-pin mask;
this preserves pin-only eligibility without admitting other workflow changes.
Newly tracked inputs and changed noncategory readers, including wholly dynamic
ones, force full. A changed category source must also retain its construction-frozen
`categoryInputAudit` fingerprint: the finite input-call tokens, Python read receivers,
and referenced file-local binding definitions. An added or changed unresolved
read/call invalidates the old audit and forces `unaccounted-consumers` with full
coverage when the actual dependency cannot be derived and mapped. This also applies
to a later document-only diff; a category edit cannot silently reseal its old maps.
Known category value changes can remain selective when that input surface and the
independent reader/root maps are unchanged. This is a conservative finite audit,
not dynamic path resolution or an exemption for a whole language or extension.
Source comments or embedded declarations cannot exempt readers. Unknown
binary/unreadable sources, stale declarations, or missing reader OR root-test
mappings force full. Runtime reconstruction uses current tracked/staged bytes or
immutable Git bytes; only construction freezes declarations, once after final source.
Documentation and known opaque image/font assets retain their source exclusions.
The classifier's own rules JSON is checked as the classification schema, rather
than treating its path keys as executable reads of every file it describes.

The reviewed `consumers.privacy` and `consumers.portal` reader declarations are
frozen separately from the required root Core-test maps in `privacyTests` and
`portalTests`. Every discovered root consumer must occur in its category's test
map. A missing reader declaration OR a missing root-test mapping independently
forces `unaccounted-consumers` and full coverage; absent/stale category declarations
and unresolved sources do too. Current working bytes, including tracked staged
additions, and immutable baseline Git bytes use the same scanner and closure.
Independent plan reconstruction therefore rejects a resealed selective plan that
omits either audit requirement. Runtime planning never refreshes declarations.
Fixture construction freezes the same production category contract before edits.

The explicit document reader/test declarations and original subset floors remain.
Audited category Core consumers join the selected roster. A Portal category or
audited Portal test consumer, including one dependent on privacy inputs, selects
the complete recursive Portal roster and six-step train. Genuine audited document,
privacy, Portal and pin changes can still select. Categories union and any
conservative full trigger wins. Component regressions exercise existing Python
readers invoked by root Node consumers, original/restored inputs that pass, and
changed privacy/Portal inputs that those selected consumers actually reject.
The ordinary regression also preserves the concrete changed-category counterexample:
an existing Node root supplies `DOCUMENT_INPUT=README.md`, then its reviewed Python
helper gains `Path(os.environ["DOCUMENT_INPUT"]).read_text()`. Rules stay byte-identical
across helper and document edits. The real root passes before the document edit,
fails with `AssertionError` after it, and passes when restored; the unrelated
selected document root stays green. Current/staged/immutable audits require the
conservative fallback, and both independent validators reject a resealed stale
selective plan. A separate known-input category change retains narrow selection.
These are authored normal regressions; the implementation role does not run them.

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

The legacy/full-profile mandatory CI-integrity baseline suite registers the exact-site offline scanner
positive and host/endpoint/context-guard, extra-request/import and unrelated-module
mutations under the normal Core `TCRN_OFFLINE_PROOF=1` environment. Only the inner
runtime-network proof is guarded against recursive scanner execution. No network
capability, source-file exemption or child-spawn allowance is added.

The current Portal source-proof block is refreshed once by the existing parent
batch-end step after integration. Historical proof bindings remain unchanged.
Official action transport and hosted elapsed-time improvement for this candidate
remain unverified until separately authorized execution; the 3–5 minute target
has no measured speedup claim.

Full and selective P1 and literal H1 share terminal summary finalization. The Actions
summary includes the honest coverage/reason, available elapsed times and observed
test counts, selected task/Core/Portal file counts, and the plan's N/A reasons.
Unavailable counts and durations say `unknown`; they are not reported as zero.
Failures remain failures and appear in the summary. Real-bundle full/selective CLI
regressions and ordinary-main control-flow regressions cover summary output; H1
retains its literal command and evidence semantics.

The CI integrity roster remains unconditional, including baseline provenance and
aggregate negatives. The retained R6 baseline suite observation was 147 tests in
290.410366 seconds within a concurrent local full gate at `b3411db9`; R5 observed
147 tests in 244.504 seconds in a different uncontrolled local run. These are prior
candidate observations, not this package's pass, standalone narrow runs, hosted
timing, or speedup estimates. Same-run transfer/byte validation remains
every-run work. This package preserves the existing provenance and negative-case
assertions and timeouts; it introduces no benchmark, new stage, or claimed saving.

## Observed CI runs and immutable source reads

The October 25 review inspected retained plans for runs
`39946361161`,
`39994839287`,
`40123029828`, and
`40165506746`.
The planner executed in all four and selected full coverage in all four. The
first three lacked usable exact-base evidence and also contained independent
full triggers. The 3.3.1 run (40165506746) had a verified full baseline from
40123029828, attempt 1; its Core, CLI, package/version and structural changes
still required full coverage. These observations provide no evidence that
selective planning failed. They also do not establish a hosted selective run.

In 40165506746 the plan step took 65 seconds and final aggregation took 66
seconds. Core verification took 649 seconds; Portal verification took 1165
seconds. The Portal functional-test step reported 1,057,727 ms (about 17m37s)
for 197 tests across 19 files: 196 passed and one was TODO. Current proof took
1306 ms and the historical complete restoration replay took 6329 ms. Functional
tests dominate this observed Portal path. This change retains the complete
Portal roster, fixture boundaries, concurrency and timeouts. Its internal slow
causes require separate stage evidence; faster source reads do not establish
faster Portal tests.

Immutable baseline source audits now enumerate one tree with `ls-tree -r -z`
and read its exact blob OIDs in one `cat-file --batch` process. Framing uses raw
Buffer byte lengths, validates each OID/type/length/body delimiter and the exact
response count, and rejects truncation or trailing bytes. Tree parsing rejects
malformed paths and invalid encoding. Binary or unreadable candidates remain
unresolved. Existing text exclusions, UTF-8/NUL checks, source audit and reader
closure semantics remain in effect. Duplicate OIDs share bytes only within that
request; there is no cross-ref cache. Worktree scans retain their filesystem path.

Before this change, a local scan of commit
`1cb45a2d216a3b4fac9427ab6a112dfeac54390b` found 775 texts and zero unresolved
inputs using 776 Git processes in 5608.62 ms. The parent batch compares identical
path/content digests and the same source commit with the two-process reader.
That local measurement is separate from hosted elapsed time. Hosted improvement
and token savings remain unknown until measured; baseline provenance validation,
same-SHA/run/attempt artifact closure and remote aggregation replay are retained.

## Local source scanning and catalog measurements

Immutable source discovery uses one NUL-framed `ls-tree` and one byte-framed
`cat-file --batch` invocation, retaining exact object IDs, byte lengths, delimiter
validation and conservative unresolved-input handling. Aggregation is limited by
the executing Node runtime's Buffer capacity. It has no fixed 64 MiB repository
budget: three individually compatible 23 MiB text objects remain compatible as a
single request. This does not change category selection or baseline provenance.

On the recorded local same-root/ref/Node input, all 775 text digests matched;
Git child processes fell from 776 to 2 and source scanning measured
6934.592417 ms before versus 69.343583 ms after. A complete real baseline-plan
replay on the same candidate tree measured 20.168241166 s versus 14.647176375 s,
with exit status zero on both sides. These are local measurements; hosted runner
and end-to-end CI improvements remain unknown.

Each bundled Atelier catalog refresh starts one isolated worker. Within that
fresh lifetime it invokes the real CLI parser/writer for `library-list` and for
each entry's `project-list` and `chain-identity`; entries sharing a library still
receive both reads. The worker retains no governance state between refreshes.
Default selection and an explicit CLI path exactly equal to the bundled CLI use
the worker. Custom wrappers retain one CLI process per command, including their
stderr and failure behavior. A failed or empty refresh retains the last good
catalog. The release archive includes the worker and its complete CLI closure
for Node-only use. The recorded full Portal before measurement was 399.905174542 s
for 197 cases (196 passing, one existing TODO); after measurements must use the
same command and environment and preserve that complete set of assertions.
