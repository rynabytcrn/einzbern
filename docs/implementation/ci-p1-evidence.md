# Independent P1 CI evidence

The ordinary GitHub verification jobs execute the planned partition of the existing P1 roster once.
It does not append another core or Portal run and does not change gate predicates, retries,
timeouts or privacy admission. This is independent retained P1 evidence, **not** literal
PF-2 H1 (`script=test`) or PF-3/U18 completion.

## Execution boundary

After explicit pinned Node/pnpm and frozen dependency acquisition, CI creates an independent
full `.git` clone of the checked-out contributor HEAD beneath `RUNNER_TEMP`. It preserves the
canonical origin and privacy base, scopes remote refs as the normal checkout does, and installs
from the acquired offline dependency store. Build clone, fixture temporary root, isolated device
home and evidence directory are siblings. No credentials or owner's absolute paths are copied
into the generic runner.

`python3 scripts/ci/p1-evidence.py` accepts explicit absolute `--repo`, `--evidence`, `--tmp`,
`--device`, and `--node-bin` paths (the latter is the directory containing Node). It verifies the
actual fixture location before starting P1: directory/ownership/realpath, no symlink component,
no `.git` ancestor, and Git repository discovery refusal. A failing preflight is a refusal, not
permission to hide Git discovery or change the guard. The evidence directory must not exist.
The cloud editing environment's enclosing Git directories therefore do not qualify; a clean
GitHub runner must pass its own actual preflight rather than inherit an assumed exemption.

The observer retains the outer stdout/stderr and the existing controller's full stdout/stderr
through read-only file descriptors, including after ordinary controller cleanup. Metadata binds
input/output repository identities, source manifests, actual command, tool versions, timings,
stream bytes/hashes, exact observed counts and retention validation. Missing or ambiguous counts,
missing streams, observation errors or source identity drift cannot become a successful receipt.
Child failure remains failure even if evidence retention succeeds. Metadata does not turn
caller/environment declarations into independently verified native facts.

The workflow's `always()` artifact step retains evidence on green and red outcomes for 14 days;
missing artifacts are an error. This changes diagnostic preservation, not a failing gate verdict.
Actions are pinned to full official commit identities. No authentication files, full environment
values or device-home contents belong in the artifact. Test stdout is retained without truncation,
so fixtures must continue to use synthetic data and existing privacy checks still apply.

## Fork and merge verification scope

Before creating or updating an upstream PR, run this workflow on the complete frozen
candidate in the contributor fork with `workflow_dispatch` and `mode=p1`. Check the
reported head SHA and full terminal evidence. A separate candidate branch avoids
publishing intermediate fixes to an already-open PR. See [the contribution sequence](../../CONTRIBUTING.md#fork-first-batch-end-contribution-workflow).

Fork dispatch, PR and main runs all explicitly clear `EINZBERN_PRIVACY_HISTORY_BASE`
and scan full HEAD-reachable history. The PR P1 verification job still checks its contributor head, not a
synthetic merge commit; a later main merge has additional identity/message metadata.
Public-hosting metadata classification must remain narrowly structural and retain
private payload detection. A previous candidate's green result is not proof of an
uncreated merge, and upstream checks/permissions are not replaced by a fork receipt.

## Provenance and method limits

The generic observer is adapted from supplied read-only method sources with SHA-256:

- d1 runner: `503210af6998675fabdd31bcd087937ec63e1dd2e0a3ca910c701b2064aee365`
- fixture preflight: `cc7e44ce6f8d97d742867def911709c296c4f504a28679c18c0664848dd15675`

The adaptation removes private fixed paths, uses CI's explicitly acquired pinned pnpm, runs
the planned P1 shards rather than H1 `test`, and explicitly propagates child/retention failures. Unit tests use
harmless fixture processes and negative preflight/retention cases, not product race experiments.
A utility test pass is not a full P1 run or proof that this environment passes formal preflight.

Original PF-2/PF-3 receipts, historical inventory preservation versus regeneration, U18 source/input
closure and actual dry-run requirements remain separate in `native-acceptance.md`. Do not relabel
older CI summaries or this independent train as those missing receipts.

## Explicit formal PF-2 H1 mode

`--mode pf2-h1` selects exactly one `corepack pnpm@11.3.0 -C <E> run test`.
The default remains `--mode p1` and exactly one `verify:p1`. H1 never appends P1,
Portal, packaging, or another core run. The workflow dispatch input is a bounded choice
(`p1`, `pf2-h1`), defaults to P1, and is ignored for ordinary pull-request/push events.
Dispatch `ci.yml` on the candidate branch in the fork with `mode=pf2-h1` only after that
exact candidate's ordinary P1 finishes. The existing per-ref concurrency group cancels
in-progress work, so do not dispatch H1 while candidate P1 is running. The selected ref's
SHA is checked out directly; dispatch does not merge, tag, publish, or install on a live device.
The manual workflow must exist on the dispatch repository's default branch to be discoverable
by GitHub; if not, do not substitute a different source SHA or claim a dispatch occurred.

Before offline execution, the workflow explicitly acquires official `corepack@0.34.6`
from npm (replacing package-manager shims only in the ephemeral runner), checks its version,
and runs `corepack install --global pnpm@11.3.0`. This is a real bootstrap, not an assertion
that an image cache exists. Dependency acquisition is frozen and disables lifecycle scripts;
the build clone installs from that acquired store offline. The runner then verifies pinned
Node 24.16.0, the actual PATH-resolved Corepack 0.34.6 (recording its realpath),
and pnpm 11.3.0 with `COREPACK_ENABLE_NETWORK=0` before the one child.

### Adaptation matrix against the supplied originals

| Original behavior | H1 adaptation | Default P1 |
| --- | --- | --- |
| Fixed private checkout/Node/device/TMP paths | Absolute normalized CLI paths; disjoint full clone, owned no-Git-ancestor fixtures, isolated device | Same fixture boundaries |
| `corepack pnpm@11.3.0 -C <E> run <script>` | Literal dispatch preserved; script fixed to `test` | Acquired pnpm, script `verify:p1` |
| Caller-selected once-only label | Fixed `h1` label within atomic fresh evidence directory; cannot overwrite/retry it | Fixed `p1` label, same exclusivity |
| Null stdin, direct whole outer streams, UTC/elapsed/exit | Preserved, saved as `h1.stdout` / `h1.stderr` / `h1.meta.json` | Existing `p1.*` names |
| Read-only earliest controller FDs; reaper untouched | Preserved, whole `h1-controller.stdout` / `.stderr`, hash/size reread | Same existing observer |
| Original fixture location/ownership/Git checks | Preserved and strengthened for broken `.git` links and empty isolated roots | Same preflight |
| Input/output HEAD, tree, branch, dirty status | Preserved, checked clean/equal; full source manifests also compared | Same identity checks |
| TMP top-level entries and process observations before/after | Preserved marks: TMPDIR, `tcrn-workflow/scripts/`, `tcrn-test-controller`, `task.mjs`; observer/ps excluded; after observation waits one second | Existing TMP entries; process observations are H1-only |
| Process observations recorded without enforcing emptiness | H1 refuses pre-existing matches or residual matches, never kills/cleans them | Unchanged |
| Recorded child exit but unchecked wrapper success | Corrected: actual child failure remains nonzero; capture/receipt failure also refuses | Same fail-closed propagation |
| Full inherited environment names and broad values | Operational allowlist only; no secret key inventory or private source paths | Same privacy boundary |
| No complete terminal-receipt/count validation | Require `TESTS_VERIFIED`, exact source test-file roster and unambiguous controller test/pass/fail totals | Require `P1_VERIFIED` |

H1 output is bound to a fresh label/directory and candidate input/output HEAD. Missing process
observations, controller output, receipts, totals or hashes refuse rather than being inferred.
Focused tests use explicitly injected component fixtures and harmless subprocesses. They are
not formal H1 receipts and cannot establish the editing environment's fixture admission.
Even an actual retained H1 pass establishes only PF-2 H1, not whole PF-2, upgrade/setup dry-run,
PF-3/U18 inventories, final privacy closure, or native host acceptance.

## Curated ordinary P1 package evidence

After ordinary P1, the existing isolated package smoke now retains a separate 14-day artifact:
archive and SHA-256 sidecar, release manifest (including install-tree digest), exact source HEAD,
pack stdout, commands/init/status JSON, and install/setup-plan/setup-applied/doctor JSON.
The always-upload step preserves partial failed smoke evidence too; an artifact alone is not a
successful smoke receipt. Only this curated directory is uploaded, never HOME, device/library
trees, credentials, or the complete runner filesystem. H1 skips this smoke and its upload.
These Linux isolated receipts do not establish native/live acceptance or release publication.

## Plan-bound CI shards

The default local wrapper remains `--mode p1` and full `verify:p1`. Only explicit
`p1-checks`, `p1-core`, `p1-portal` accept `--plan <absolute-file>`. The wrapper validates
that plan before execution and after source capture; saves `impact-plan.json` as a
hashed artifact; records `impactPlan`, `coverage`, `planDigest`, `selectedCoreTests`;
and retains the complete `inputManifest.coreTestFiles` and `portalTestFiles` separately.
H1 never consumes a plan. Its literal Corepack dispatch and process observations remain.

The shard invokes the same `scripts/task.mjs test --ci-plan <file>` controller.
Ordinary test, H1 and P8 cannot select files through inherited environment. Selected
Core reports `TESTS_SELECTED_VERIFIED` with exact `tests`, `argv`, `coverage`, and
`planDigest`; full Core retains `TESTS_VERIFIED`. Core uses its existing 900000ms cap,
P8 600000ms. Portal selection always keeps all recursive files and six train steps.

`aggregate-evidence.py` rereads raw step and controller output, checks source/run/tree,
exact tasks/prerequisites/extras, plan bytes and digest, selected argv and source rosters.
It invokes `impact-plan.mjs validate-remote` to rederive the current plan independently
and revalidate eligible baseline provenance. `--baseline-artifacts` is the collector's
read-only validation route: it rehashes the downloaded previous run, verifies its Git
tree/rosters and rederives its old plan. Legacy artifacts lacking this contract are
ineligible and produce full fallback rather than a manufactured success.

The plan artifact carries `transport/payload.bin` and `transport/manifest.json`.
The manifest binds `head`, `runId`, `attempt`, `planDigest`, byte count and SHA-256.
The verifier requires exact bytes and file set with bound regular-file reads. Package
smoke carries `package-seal.json`, binding those same identities to each curated file's
bytes/hash; aggregate also checks installer/setup/doctor outcomes and archive digest.
Each selected shard artifact repeats the canonical plan. The artifact directory set
must equal the plan's selected shards plus plan and package smoke; extra and missing
artifacts fail. Pinned action transport of this new candidate remains unverified
until its separately authorized hosted CI run; component fixtures are not that proof.

`CI_SELECTED_VERIFIED` always carries `coverage=selective`. It is not `CI_VERIFIED`
and does not replace manual complete P1, release, PF-2 H1, PF-3 or native acceptance.


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
