# INIT-090 Recall performance candidate

This is a partial implementation, not an INIT-090 completion or release receipt.

## Behavior

- 644: opt-in `EINZBERN_RECALL_OBSERVATION=1` adds request correlation,
  engine/projection version, checkpoint hash, elapsed/process CPU, authority-read
  and replay spans, event logical bytes, segment/materialization/Recall counts and
  cache reasons to the existing hook log. It never includes prompt or card bodies.
  `request-index-hit` is an in-process index hit; `replay-seed-validated` is a
  validated replay seed, **not** a claim of avoiding disk reads. CPU measures the
  process over the interval, not exclusively one concurrent request.
  `recall-summary.mjs` deduplicates correlated events/resources while counting all
  result logs, accepts fractional half-open timestamp windows and unions nested
  spans. Legacy uncorrelated logs stay explicitly uncorrelated. Network/OS I/O,
  tokens and cost are unknown, not inferred from logical event bytes.
  Actual CLI result/error and Claude Code/Codex/DSH/Kiro hit/no-hit/empty plus
  role-only and subsequent task paths have focused protocol/privacy coverage.
  Each stage reports inclusive process CPU; nested stage CPU must not be summed.
  The projection field comes from the actual cache-view schema constant, with
  the reducer's engine version recorded separately. The environment switch is
  explicitly classified in runtime-input-contract.
- 645: hook and CLI preserve the raw authority read before effective project
  configuration. An opaque process-local token passes that read through both
  knowledge stores, including user-crest family conflict lookup. Caller-supplied
  state objects and other roots cannot substitute for a token. There is no
  persistent authority token or global raw-state cache.
- 646: native role-only SubagentStart retains navigation without treating
  `agent_type` as task text. Undocumented prompt/transcript fields do not become
  new task sources. DSH navigation and Codex peer guard are unchanged.
- 647: full consolidated checkpoints bind the current manifest, consolidation
  index (source manifests/heads/vectors/generation) and engine projection version.
  Source events are reconstructed from freshly fully validated bytes. Matching
  checkpoints restore collections plus merge state, then replay only a verified
  prefix's new tail; late insertions/incompatible or damaged checkpoints fall
  back to full replay. Unchanged reads do not rewrite the checkpoint. Tests cover
  unchanged reads, restart, single/multiple/cross-writer append, bad/missing or
  generation-mismatched cache, same-length source tampering and coherently
  rehashed source history with unchanged version vectors. Source head checks run
  before checkpoint adoption, outside derived-cache failure recovery. Current official
  consolidation refuses nested generations; that refusal is preserved and tested,
  not mislabeled as a successful new-generation migration.
- 648 **blocked / not implemented**: ordinary mutable files and unchanged
  names/size/mtime do not prove unread historical bytes remained unchanged.
  This candidate retains full reads/hash validation, including archived sources.
  It does not introduce an immutable-storage trust assumption, daemon, or service.
  Owner must choose a separately reviewed trusted immutability/change-proof
  mechanism before that optimization can claim same-length tamper detection.

## Reproducible focused measurement

Use the pinned Node/pnpm toolchain and independently preserved baseline build.
Run `recall-fixture.mjs <new-library>` with an isolated `EINZBERN_HOME`, then
`recall-ab.mjs <baseline-repository> <candidate-repository> <same-library>`.
Each group uses fresh processes, alternates A/B order and adds a candidate
observation-on sample. The fixed `at` and library bytes stay unchanged. The
sampling script measures actual event-file bytes through Node's file handle API;
it does not use external read counters as a proxy for CPU or OS I/O.

Committed `samples.ndjson` and `summary.json` are synthetic-fixture results for
22 work records, one project, no knowledge cards, three queries. All 45 semantic
hashes agree; this is not evidence for every project/user-crest conflict case.
A separate real knowledge-card metadata equivalence test covers nonempty cards.

Event bytes fall from 182124 to 91062 (50%); segment reads from 2 to 1.
CPU P50/P95 is 95962/114741 baseline versus 75563/84788 candidate microseconds.
RSS P50/P95 is 80536/81676 baseline versus 81732/82544 candidate KiB.
The small fixture still increases RSS; strict no-RSS-regression acceptance is
**not established**. Observation-on and off pairs are retained; do not infer zero
or negative overhead from noisy pairs. These are fixture results, not a SLA.

## Round-two evidence and remaining boundaries

Final combined entry/consolidation/authority/observation/runtime-contract and
launcher/log-compatibility checks: 69 passed. User-crest
conflict and superseded-card status differential: 2 passed. Runtime-input contract
including the literal environment inventory: 17 passed (included in the 69). Cross-project valid,
removed and all-card selections match a fresh read. No full train is run here.

A small consolidated fixture measured full replay 8 events vs cached replay 0,
with both reading 6743 logical bytes; one observed CPU pair was 10133 vs 6729 µs.
This is a retained test diagnostic, not a production CPU guarantee. The committed 15-pair Recall measurements were repeated against a fresh pinned
original baseline after lazy observation initialization. RSS still increases for
the small fixture. One separate large-authority A/B pair showed event bytes 50%,
CPU 48.55 to 28.65 seconds and RSS 730868 to 631776 KiB, with identical authority
head and semantic digest. That is one pair, **not** a 15-pair P50/P95 claim; its
private-authority receipt is not published with this source. 648's mutable-filesystem
trust limitation remains.

## B-package entry measurements

The CLI observation now distinguishes `hit`, `no-hit`, `empty` and `error`.
An empty argument keeps `CLI_ARGUMENT_MISSING`; a whitespace-only query is
rejected with `CLI_ARGUMENT_MALFORMED` before authority reads or indexing.
Neither query text nor output/card bodies enter the observation log.

`recall-ab.mjs` still accepts its original three arguments for the core sample.
An optional fourth argument is a JSON entry specification:

```json
{
  "entry": "cli",
  "host": "claude-code",
  "projectPath": "/owned/synthetic-project",
  "at": "2026-11-10T15:00:00Z",
  "queries": ["Recall performance", "PERF-STORY-13", "nonexistent-zxy-needle"],
  "deviceTemplate": "/owned/devices/template",
  "deviceRoot": "/owned/devices",
  "devicePrefix": "unique-series-",
  "osTime": true
}
```

Create the synthetic library and register its project using a separate owned
device home. Remove only that setup's derived cache/log/locks before preserving
the template. Template and sample devices must be siblings: registry/config paths
are device-relative. Every sample exclusively creates a new device, then copies
the same template. Use a new prefix for another series. `entry: "hook"` calls the
actual hook event entry; `entry: "cli"` runs `scripts/einzbern.mjs`, including its
parser, output and failure wrapper. Hook wall-clock dates are pinned to `at` in
the sample process because that event has no public time flag. The monotonic
elapsed and CPU clocks remain real.

```sh
node scripts/performance/recall-ab.mjs BASELINE CANDIDATE LIBRARY SPEC.json > samples.ndjson
```

The default is 15 groups starting at pair 0 and every query in the spec. Optional
`--groups N`, `--start-pair N` and `--query-indexes 0,2` select an explicit fixed
series without rewriting the spec or the child inputs. For example, to append
pairs 15 through 99 for just the first query:

```sh
node scripts/performance/recall-ab.mjs BASELINE CANDIDATE LIBRARY SPEC.json --groups 85 --start-pair 15 --query-indexes 0 > appended.ndjson
```

Even pair numbers run baseline then candidate; odd pair numbers run candidate
then baseline. Candidate-observed runs last. A continuing series must prove
source, runtime, dependency, input, entry, measurement and device/cache conditions
equivalent before combining historical rows. Otherwise keep those rows separate
and use the complete predeclared fresh series. Never choose a window or stop or
extend the series based on its performance results.

All stdout, stderr, order, failed samples and actual result logs are retained.
Each row also records the actual child command/argv/cwd, device home and a SHA256
of the sorted environment entries, without publishing environment values. This
parent metadata is prepared after the measured spawn-to-close interval.
The script does not stop at the first child failure. Event-file reads are counted
through file handles. Identical in-memory module probes count complete library
materializations and time the real CLI operation without changing baseline files.
Their overhead is included, and the loaded source digest/size and memory samples
are recorded; these are instrumented measurements. Parent spawn-to-close elapsed
is separate from the internal operation interval. On macOS, optional system
`time -lp` adds post-exit process CPU seconds and maximum RSS in its native bytes;
Node's separately sampled `maxRSS` remains in KiB. The native time CPU counters
have centisecond output resolution. Block operation counts are not OS I/O bytes.

The entry sample snapshots `completedMemory` and Node resource usage before its
reporter runs. Source inventory uses code-unit path ordering, so preparing the
inventory does not initialize locale data in the target process. Reporter sort,
JSON encoding, write call and natural `beforeExit` snapshots are emitted to
stderr as `einzbern.performance.reporter.v1`; the paired runner preserves them
alongside native system-time output. Reporter snapshots report their own CPU,
elapsed time, memory and Node peak. The system peak and lifecycle still include
the complete child process, output flushing and reporter. Earlier series using
locale sorting and post-sort `completedMemory` have different reporter allocation
conditions and remain separate evidence. This correction alone does not explain
an operation-timer or pre-report Node RSS regression.

Import `summarizePairedSamples` from `recall-summary.mjs` to summarize the JSON
rows. Pass the frozen series explicitly, for example
`summarizePairedSamples(rows, { groups: 100, startPair: 0, queryIndexes: [0] })`.
Its compatible defaults are 15 groups starting at 0, using the queries present in
the input rows. Each expected pair must contain exactly one baseline, candidate
and candidate-observed in the alternating order. Missing, duplicate, unexpected,
failed or unparseable samples remain visible and prevent `complete=true` and
passing thresholds. An explicitly selected query with no rows is incomplete.
Query, fixed time, head, semantic output and read-file inputs must match across
the series; physical counts and loaded-source fingerprints must remain stable
within each mode; candidate and candidate-observed physical counts must match.
Observation may load additional modules, whose mode-specific fingerprints stay
separate. Baseline and
candidate retain their different physical read/materialization counts.

P50/P95 remains nearest rank `sorted[ceil(p*n)-1]` per query/input: n=15 P95 is
rank 15 (the maximum); n=100 P95 is rank 95. The report includes each mode's
actual n and ranks. A complete measurement is separate from satisfying each
unchanged resource and logical-byte threshold. Actual logs are reconciled through
`summarizeRecall`; the source/spec/library/device fingerprints and cache conditions
also need their external before/after evidence, since event read counts alone do
not fingerprint all knowledge-card inputs.
Cold device caches do not imply a cold OS/file-provider cache. Negative observed
differences do not establish negative observer overhead. The historical small
fixture RSS regression and its raw samples above remain part of the evidence;
larger or nonempty corpora cannot replace that criterion. These tools alone do
not establish the strict no-latency/CPU/RSS-regression acceptance.
