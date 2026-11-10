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
Each of 15 groups uses fresh processes, alternates A/B order and adds a candidate
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
