# Native acceptance checklist (not executed by this PR)

The code and Linux fixture receipts do not establish the state of a user's Mac, external host
capabilities, account usage, or a second synced device. Perform these checks only after reviewing
the final PR and the exact candidate archive. Do not replace these steps with old receipts.

## Candidate and rollback

1. Record the final commit, archive SHA-256, install-tree digest and version from the reviewed
   package manifest. Verify the downloaded archive hash before installation. Version 2.2.3 is
   a candidate identity, not a claim that it was published. Recheck tag/release collisions before
   any later publication; do not overwrite an existing version with different bytes.
2. Preserve the current installed engine and the original library/event history. Run
   `einzbern engine-list` and keep the readback. Do not delete the only recovery copy.
3. Use the documented installer for the reviewed archive, then inspect the setup plan before
   applying it. Require actual `SETUP_PLAN_READY`, `SETUP_APPLIED`, and a new `einzbern doctor`
   receipt for the intended device/library. An isolated Linux receipt is not a macOS receipt.
4. If rollback is needed, use `einzbern engine-rollback --at <actual-UTC-instant>` only after
   verifying the preserved previous installation. Keep the returned receipt and run doctor again.
   Do not rewrite events or assume the older engine understands newly declared setting keys.

## Governed host policy and exact readback

1. Capture `einzbern engine-model-policy-catalog --host codex` and the corresponding readback
   for every other configured host. Record the host application's default model separately.
2. Prepare a policy JSON using `specs/engine-model-policy-v1.md`. The approved Codex ordering is
   flagship gpt-6-astra/max (order 10), main gpt-6.1-sol/max (20), economy
   gpt-6.1-sol/low (30), gpt-5.6-terra/max (40), gpt-5.6-terra/medium (50),
   gpt-6-luna/max (60). Use
   escalation enabled=true, threshold=2, ceiling=main. This is not a hardcoded engine default.
3. Obtain an actual current Owner decision naming `models.engine-policy` from the intended
   library and identify the actual actor. Do not copy a test fixture decision, actor or library id.
   Apply with the real values:

   ```sh
   einzbern engine-model-policy-set --workspace "$LIBRARY" --host codex \
     --policy "$(cat "$POLICY_JSON")" --at "$ACTUAL_UTC_INSTANT" \
     --actor "$ACTUAL_ACTOR" --decided-in "$ACTUAL_OWNER_DECISION"
   ```

4. Read `engine-model-policy-catalog --host codex` in a new process. Compare all category/tier
   values, ordering, escalation, quota declarations, host revision and digest exactly. Verify
   non-Codex host entries and host application defaults did not change. For ALL registered live
   projects (the scope of original attachment 553), confirm the same device-host policy
   source/revision/digest rather than historical project model declarations. Future projects
   must inherit the policy without a copied table. This is pending native verification; a
   two-project sample is not acceptance of the full scope.

## Selection versus actual dispatch

For rejection counts 0 through 9, run the actual installed command, saving stdout, stderr and
exit status separately:

```sh
einzbern execution-policy-resolve --host codex --category economy --rejections "$COUNT"
```

Expected tuples are Luna/max at 0–1, Terra/medium at 2–3, Terra/max at 4–5, Sol/low at 6–7,
and main Sol/max at 8 onward. There is no automatic Astra step. Verify the policy digest and
revision on every result. An absent quota observation must remain unknown, not zero.

Before dispatch, request work-project-context with --execution-request as specified in
execution-admission-v1.md. Supply the actual host capability tuples, requested agent count and
timestamped account observation. Require dispatchAdmitted and the target admission status,
then have the real dispatch adapter invoke its selected runner/model/effort without substitution
and retain its native acceptance or explicit refusal. `capabilityStatus=unchecked`, generated
instructions and policy selection are not native acceptance. If a tuple is unsupported, stop
that dispatch; do not silently switch runners, models, effort or host defaults. Repeat with the
actual configured non-Codex host. Verify a project budget cannot raise the device concurrency cap
in the adapter's real scheduling behavior. Engine admission bounds one declared request, not
global occupancy across independent hosts. Bind actual host stdout, stderr and exit status to
the admission through the review-evidence dispatchEvidence contract; unavailable fields remain
unavailable and cannot be replaced by test-run streams.

Knowledge language receipts currently enforce the resolved economy model identity against a
bundle provider. Their legacy bundle format has no runner/effort fields, so those tests do not
prove a native runner/model/effort invocation.

## Hooks, shared configuration and sync

- Start actual supported host sessions and subagents. Capture the real event sequence and verify
  prompt/subagent recall reaches the host before the relevant work. Navigation prose alone is
  not recall evidence.
- Exercise the installed dedicated Read guard with ordinary fixtures: a file above 32 KiB with
  no line bound or more than 200 requested lines must refuse; valid bounded reads are allowed.
  Shell remains observational. Verify installation/update/doctor ownership of these hooks and
  that retired Stop/SSH hooks are not restored.
- Compare ALL registered live projects' own output/language/design settings while confirming
  their shared engine policy, and verify future-project inheritance without a copied table. Verify explicit variable exports and value-free withholding diagnostics, and verify
  generation=none does not erase existing owner text.
- Before cloud sync, explicitly migrate shared absolute declarations to portable references and
  configure bindings separately on each device. Verify alternating writes and merged content on
  two real devices using the intended sync service. Same-machine temporary directories do not
  establish this acceptance.

Record each item as passed, failed, or not exercised with its candidate identity and actual
receipt. Never roll these statuses into an unqualified claim that native acceptance is complete.

## Relocation recovery acceptance

Before any real relocation, preserve a verified backup. Use the reviewed relocation command
against fixture libraries first. A pending destination is intentionally write-blocked until
source publication and registry repoint finish. Retry the same source/destination command to
resume a published transaction; a returned historical receipt is not fresh verification of
later destination writes. For an unpublished preparation, inspect its transaction identity
and use `workspace-relocate-discard --workspace <source> --to <target> --transaction-id <id>`
only when the engine validates the unchanged source and exact attempt-owned entries. A refusal
must not be bypassed with recursive deletion, arbitrary tombstone removal or registry editing.
This checklist does not attest real cloud-provider rename/hydration behavior.


## Container-only heading follow-up

These are post-install edits to the owner's container AGENTS.md, not engine template
changes. Current read-only inspection confirms they remain pending. Apply only under
separate write authorization and in a separate container commit:

- `### 八、Owner 即时规则` becomes `### 八、Owner 即时规则（已迁入第三部分）`.
- `## 第三部分 受管段：内置原则与系统变量` becomes
  `## 第三部分 受管段：内置原则、系统变量与自定义变量`.

Preserve all managed markers and body bytes. Verify the managed-sections doctor is
okay with an empty pending list. The original acceptance method identifies these
as MIN-267 D1 / R10-N5; this source PR does not claim they were applied.

## PF-2 / PF-3 final evidence method

After package preparation commits, freeze the final HEAD. PF-2 H1 runs once in an
isolated build clone using the reviewed `--mode pf2-h1` adaptation of the supplied
original d1-runner.py observer, documented in `ci-p1-evidence.md`. Preserve complete controller stdout/stderr and outer
stdout/stderr/meta with input/output identities, sizes, hashes and exact test-file,
pass and fail counts. Prior generic test summaries are diagnostics, not substitutes.

PF-3 verifies identical HEAD and zero tests/portal-tests diff, then reuses that PF-2
controller stdout. Missing receipts cannot be replaced by an unrelated full rerun.
It also requires U18 dry-run and actual generation, four inventories bound to HEAD
and allOk, plus privacy-boundary, init053-owner-return and
staged-privacy-reviewed-paths consumer tests. The exact supplied runner/method must
be reviewed and adapted to the execution environment before this sequence begins.

### Unresolved method reconciliation

The BL-39 option preserves the four original verification inventories as immutable historical
snapshots. PF-3 separately calls for current-HEAD regeneration of four inventories. Choosing
historical retention does not waive that later requirement: current regeneration and the exact
method/input reconciliation remain pending. Do not overwrite the historical snapshots or label
summaries as regenerated inventories. Required U18 historical inputs and dry-run/actual-generation
receipts must be complete before claiming PF-3 closure.

The default CI observer described in `ci-p1-evidence.md` runs the existing single `verify:p1`
train. It is independent P1 evidence. Only an explicitly selected `pf2-h1` run executes the
literal H1 `script=test` command; its implementation or focused test pass is not an H1 receipt.
Neither mode replaces PF-3's reuse of its specified PF-2 receipt. Actual upgrade/setup dry-run receipts and final
package privacy evidence must also be bound to their exact candidate rather than inferred from
source implementation or an earlier package smoke.
