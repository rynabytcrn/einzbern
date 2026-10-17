# Independent P1 CI evidence

The ordinary GitHub verification job executes the existing `verify:p1` train exactly once.
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

## Provenance and method limits

The generic observer is adapted from supplied read-only method sources with SHA-256:

- d1 runner: `503210af6998675fabdd31bcd087937ec63e1dd2e0a3ca910c701b2064aee365`
- fixture preflight: `cc7e44ce6f8d97d742867def911709c296c4f504a28679c18c0664848dd15675`

The adaptation removes private fixed paths, uses CI's explicitly acquired pinned pnpm, runs
`verify:p1` rather than `test`, and explicitly propagates child/retention failures. Unit tests use
harmless fixture processes and negative preflight/retention cases, not product race experiments.
A utility test pass is not a full P1 run or proof that this environment passes formal preflight.

Original PF-2/PF-3 receipts, historical inventory preservation versus regeneration, U18 source/input
closure and actual dry-run requirements remain separate in `native-acceptance.md`. Do not relabel
older CI summaries or this independent train as those missing receipts.
