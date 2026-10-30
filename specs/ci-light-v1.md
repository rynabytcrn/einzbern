# CI light v1

## Scope and source roster

The fixed limited profile is `ci-light`, `coverage=light`. Its source authority is
`scripts/ci/light-roster.mjs`, not changed-file selection or an uploaded local plan.
`einzbern.ci-light-roster.v1` records fourteen ordered steps, every full P1 task's
classification, `notRunHere`, full local validation responsibility and package smoke.
`rosterDigest` is SHA-256 of all other fields with recursively sorted object keys,
compact UTF-8 JSON and unchanged array order. An unclassified new P1 task refuses.

The steps are format, links, wiring, lint, build, bounded contracts, Portal proof,
design reconciliation, design proof, no-sibling dependency, offline, retrieval,
archive and privacy. Build includes its existing typecheck. Contract test files are
explicitly named in the source roster, never a recursive full-suite glob. Portal
proof and cross-repo/design contracts are not the full Portal functional/meta-replay
train. Unknown change impact does not broaden fixed light or certify full safety.

## Execution and retained bytes

Pinned Node 24.16.0 and pnpm 11.3.0 are explicitly acquired before frozen offline
execution with lifecycle scripts disabled. The existing fixture preflight, private
HOME/device/TMPDIR, full independent Git clone, source-before/source-after manifests
and clean exact source identity remain required. No local JSON substitutes for
actual hosted execution. The real official `scripts/no-network.mjs` preload guards
the runner and each direct Node step; Node workers and ordinary descendants inherit
it through `NODE_OPTIONS`. Advisory offline flags alone do not satisfy this contract.
Existing worker-count/memory admission remains; refusal is not bypassed.

Each step retains raw stdout/stderr and its status, exit code, signal, duration,
actual argv and official guard identity. Receipt steps require their actual expected
terminal reason and `ok=true`; process proof steps require real successful child
execution. The test step requires one complete raw Node TAP/spec summary, retaining
pass, fail, cancelled, skipped and todo separately. Missing, ambiguous, cancelled or
failed execution is red. A test-file registry count is not an executed test count.

Archive must execute before privacy and retain the actual source archive bytes.
Its size/hash and task receipt are bound before and after privacy. Privacy still
scans full HEAD-reachable history **and** the present source archive. A raw history
base environment shortcut is forbidden; this profile makes no privacy speedup claim.

`einzbern.ci-light-steps.v1` reports `CI_LIGHT_STEPS_VERIFIED` or
`CI_LIGHT_STEPS_RED`, the fixed roster digest and all raw-step metadata. The compatible
wrapper uses `einzbern.ci-light-evidence.v1` and `CI_LIGHT_EVIDENCE_RETAINED` or
`CI_LIGHT_EVIDENCE_REFUSED`. Retention never changes a failed child into acceptance.

## Package smoke and aggregate

Package smoke remains a real pack, SHA-256 check, unpack without node_modules,
command-catalog/init/status execution, official installer, installed setup plan/apply
and doctor check. Only curated package and receipt bytes are uploaded; no credential,
HOME or whole device/library content. A seal binds every retained byte to HEAD, tree,
run ID, attempt and roster digest. An unexecuted or partial smoke cannot pass.

The `verify` job requires the ci-light job result to be success and exactly the two
same-head/attempt light and package artifacts. It independently obtains the roster
from expected source, compares source file hashes to Git, rehashes all retained
streams and archive bytes, replays every ordered step contract and validates package
identity and outcomes. Missing, extra, altered, cancelled, reordered, duplicate or
foreign-run evidence fails closed. Success is only `CI_LIGHT_VERIFIED`; failure is
`CI_LIGHT_INCOMPLETE`. The workflow's historical display name is retained only for
check-name compatibility and does not change this limited success type.

## Explicit exclusions

`notRunHere` names full Core, full Portal, full impact regressions, PF2-H1, P8 and
release validation. `localValidationRequired=full` remains explicit. Local full P1,
formal H1, preflight and release contracts stay distinct and unchanged. Light cannot
be converted into full/selective P1, a reusable baseline, native acceptance or a
release success. No new schedule, network permission, runtime setting, fork-CI
activation, live installation or release publication is authorized by this profile.

The contribution sequence is full relevant local acceptance, authorized publication
through the contributor/fork route, then inspection of upstream PR light evidence.
Optional separately authorized fork CI is not globally forbidden, but is not required
or enabled by this change. Historical full-mode measurements are not light speedups.
