# CI verification

P1 still consists of the twelve tasks in `scripts/p1-sequence.mjs`. The local
`verify:p1` command remains serial. GitHub Actions partitions that same roster:

| Job mode | Work | Isolated state |
| --- | --- | --- |
| `p1-checks` | Format, lint, types, build, archive, dependency boundary, offline, full-history privacy, links, retrieval; test wiring and package/install/setup/doctor smoke | Full clone, HOME, TMPDIR, device directory, dist |
| `p1-core` | The complete core test roster, including S6 | Separate full clone and runtime directories |
| `p1-portal` | Build prerequisite and complete Portal train | Separate full clone and runtime directories |

The required `verify` job waits for every matrix member. It refuses missing,
cancelled or failed jobs, mismatched source commits or run attempts, incomplete
task coverage, changed source manifests, and missing or altered retained bytes.
It does not infer success from whichever artifacts happened to upload. Package
smoke remains part of the checks job's success condition.

Manual `pf2-h1` runs remain a single explicit H1 invocation using pinned Corepack.
They do not run P1 or package smoke and do not establish whole PF-2/PF-3 acceptance.
The ten-minute core controller limit is unchanged; incomplete tests remain red.

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
remain bound to their original commits. Full replay still runs on every CI run.
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
The aggregate checks both executed file rosters against the source manifests.
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
