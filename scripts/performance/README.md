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
  Remaining: broader actual CLI/log and host/error/privacy matrix; stage CPU is
  not separately attributed. No claim that this fulfills every 644 acceptance.
- 645: hook and CLI preserve the raw authority read before effective project
  configuration. An opaque process-local token passes that read through both
  knowledge stores, including user-crest family conflict lookup. Caller-supplied
  state objects and other roots cannot substitute for a token. There is no
  persistent authority token or global raw-state cache.
- 646: native role-only SubagentStart retains navigation without treating
  `agent_type` as task text. Undocumented prompt/transcript fields do not become
  new task sources. DSH navigation and Codex peer guard are unchanged.
- 647 **partial**: after full archive read/hash/source validation, each archived
  source can reuse its existing validated replay checkpoint; incompatible or
  corrupt snapshots fall back. The consolidation reducer and live post-base tail
  still replay on every call. Full consolidated base/merge-state caching,
  multi-generation/restart/append measurements remain unimplemented/unverified.
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
CPU P50/P95 is 101020/119180 baseline versus 73987/91421 candidate microseconds.
RSS P50/P95 is 80788/81524 baseline versus 81604/82640 candidate KiB.
The original run showed a small RSS increase and the repeat is noisy; strict
no-RSS-regression acceptance is **not established**. Observation-on and off
pairs are in the raw results; do not infer zero or negative overhead from noise.
These final-candidate measurements are fixture results, not a production SLA.
