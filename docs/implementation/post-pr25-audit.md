# Post-PR25 audit status and bounded follow-on scope

Date: 2026-10-18 UTC. This index preserves the [earlier post-merge audit](post-merge-audit.md) and its historical evidence. It does not establish exhaustive audit coverage or completion of the original acceptance plan.

## Accepted baseline and historical execution identities

PR #25 was reviewed and merged at 08:35:59 UTC as `c653cc387e72fdcba55370676d7246cd8d2efacd`. Its tree, `a5bf36495ef0f5991ec8b46c412f97650a8de513`, equals accepted head `5e9290b2002738bb633d70945cf44484fcd074e5`. No additional inline, review or comment feedback was returned by the checked API responses; do not infer additional review findings from that absence.

The six corrections described in the earlier index are merged, not pending implementation. Their final retained verification belongs to **5e9290b**, not the merge SHA or a future candidate:

- P1 run 39106298207: all twelve legs passed; core recorded 252 test files, 2,226 tests, 2,224 passed, zero failed and two skipped.
- Formal H1 run 39108179948: 252 files, 2,226 tests, 2,223 passed, zero failed and three skipped. This is literal H1 evidence, distinct from P1; skipped cases are not executed passes and overlapping counts must not be added.
- The retained PR25 acceptance report records package validation, eighteen actual extracted-package CLI invocations (parent fixture preparation separately disclosed), and 82/82 independent evidence checks. Its archive SHA-256 is `f223961230a546ffa22d8d60b8fcc8e651df694a960b2ddb5ed5cf27edce8980`; install-tree digest is `ecf817ec6a2cfe117ff7660651b71e75345a31d5a57b8bc347f8b82d6e05619a`.

These are historical accepted-candidate receipts, not new executions on this follow-on candidate. They do not establish complete PF-2/PF-3 or native acceptance.

## Current source-review boundary

The bounded review covers configuration/schema/public CLI validation, governance transitions, knowledge/retrieval error handling, and a release/archive error-boundary sample. Five confirmed corrections are implemented:

1. Shared Windows absolute-path new-write guard: six new cases included two baseline failures; the fixed focused batch passed 19/19.
2. Knowledge batch shape validation and apply-error aggregation: five new cases failed on the baseline; the fixed focused batch passed 43/43.
3. Malformed gate-receipt release/required-field validation: two new cases failed on the baseline and passed 2/2 after correction. A bare invocation of existing compatibility tests was blocked by the controller's detached-process guard; the full controlled suite remains pending. That blocked invocation is not a product-regression result or a compatibility pass.
4. Value-free origin diagnostics, removing rejected origin values from the diagnostic.
5. P8 SBOM producer/consumer parity. The combined origin/SBOM batch has three new cases, with two failures and one pass on the baseline; the fixed focused batch passed 31/31.

Independent static review reported no blockers within its reviewed scope. Focused counts include overlapping existing tests and are not additive coverage totals, aggregate verification or frozen final-candidate evidence. Candidate full-suite, P8, package and formal H1 verification remain pending. Classify other observations as contract decisions, evidence gaps or no defect; do not turn the remaining coverage limitations in the [quality register](quality-audit-coverage.md) into invented defects or new product features.

After the bounded investigations and applicable focused checks, freeze the exact next candidate before its prescribed aggregate/package/H1 verification. Retain identities, commands, streams, counts and hashes; do not reuse old passes as current-head execution evidence. Previously denied custom race, crash, lifecycle and Portal boundary/symlink probes remain outside this review.

## PF-3 method and input reconciliation remains open

The recovered original method identifies `pkg-r11-pf3-scope.md`, `u18-formal.sh`, `build-final-inventories.py`, `head-binding-check.py`, the historical U18 inputs, build products and wrapper scripts. Recovering method excerpts is not evidence that all executable inputs are available or that generation occurred.

The original PF-3 method targets the four existing `init053-owner-return-{scope,copy,component,limit}-inventory.json` paths, while the [current historical-inventory policy](../verification/README.md) preserves those snapshots unchanged. Reconcile this destination/method conflict explicitly before generation; do not overwrite historical evidence, fabricate missing inputs or label summaries as regenerated inventories. This is an unresolved evidence deliverable, not a blanket claim that source implementation is absent.

PF-3 requires its specified PF-2 controller stdout, identical pre-generation HEAD and zero test-file diff, followed by the prescribed dry-run and actual generation, inventory binding and three consumer checks. The later inventory commit has its own binding checks. Tree equality alone does not meet the pre-generation identical-HEAD requirement. A missing or mismatched receipt is not permission to substitute an unrelated full rerun. See the [native acceptance method](native-acceptance.md#pf-2--pf-3-final-evidence-method).

## Separate acceptance and stopping conditions

This batch can close its bounded source investigations and candidate verification without claiming all original work complete. PF-3 closes only with its exact reconciled method, inputs and receipts; otherwise record the concrete missing input or decision.

Real macOS installation, actual actor/Owner policy decisions and readback, all registered live projects, native dispatch/hooks/trust, live work-chain readbacks and two-device synchronization remain separate [native acceptance obligations](native-acceptance.md). Container-only heading edits require their separate post-install authorization and commit. This audit does not authorize live device/library/history changes, release publication or DSH development.
