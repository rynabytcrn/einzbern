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
