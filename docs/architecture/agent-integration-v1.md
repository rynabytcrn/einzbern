# Agent-Integration Reference V1

This is the CLI consumption contract for an automated agent driving the governed
workflow. It documents existing behavior only. The sole normative additions are
the retry obligations in section 3, which constrain callers, not the engine. The
authority for read-surface staleness is the "Authority and layout" section of
`packages/core/spec/file-engine-v1.md`; this reference cites it and adds no
divergent semantics.

## 1. Surfaces

The shipped binary runs every `availability: "cli"` verb. No verb takes an
out-of-band authority: the operator-pins channel (`--authority-pins`), the profile,
context-route and gate verbs that needed it, and their authority files are retired
(TCRN-CROSS-STORY-467 R2). The binary never consults prompt text, environment
variables or ambient configuration for authority.

There are currently no programmatic-only commands:

```
programmatic-only
```

The `commands` verb is the discovery root. It emits the schema-valid, byte-stable
`COMMAND_CATALOG` — every verb with its flags, `availability`, and `mutates`
status. An agent enumerates capability from that catalog rather than from prose;
this document stays in drift-guarded agreement with it (see the read-surface
test). Never hardcode a verb list an agent could instead read from `commands`.

The `packages/mcp` stdio entrypoint that once exposed five read-only structured
tools was retired in `v0.11.18` and removed from the repository by
TCRN-CROSS-INC-275 (2026-09-04). The CLI is the only transport; an agent
enumerates capability from the `commands` catalog described above.

## 2. Envelopes

Every verb writes exactly one canonical-JSON document to stdout on success.

- Mutation verbs return the created or mutated record identity additively in the
  envelope (id, revision, tombstone; work adds kind/status/projectId/parentId),
  so an agent never reads a view off disk to learn the id it just wrote.
- List verbs return `{reasonCode, kind, total, records, truncated}` under bounded
  `--limit`/`--offset`; show verbs return a single `record`.
- On failure the shipped binary writes nothing to stdout, writes
  `{ok:false, reasonCode, error}` to stderr, and exits 1. The `reasonCode` is the
  stable machine contract; `error` is human text and must not be parsed.

## 3. Retry table

Every recommendation names the exact reason code and a governed remediation verb.
No free-form advice. Retriable rows are transient; non-retriable rows are
workflow or corruption conditions the agent must resolve before re-issuing.

| Reason code | Class | Obligation |
| --- | --- | --- |
| `WORKSPACE_VIEW_STALE` | Retriable | Views lag authority (a writer committed an event but had not yet rewritten the derived views, or crashed between the two). Re-read up to a small fixed bound. Retry on observed version progress. If it persists, run `recover`, which rebuilds the views from the authoritative chain under the engine write lock. Reads only — `status` reads authority and never raises this code. |
| `WORKSPACE_VIEW_BUDGET_EXCEEDED` | Not retriable unchanged | The workspace's projected views would exceed the canonical ceiling, measured **before** the event segment was written. Nothing was appended: the version and head hash are unchanged, and re-issuing the same command produces the same refusal. The message names the view and the measured size. This is a capacity fact about the workspace, not a defect in the command — the remedy is a workspace-level one (see the record-count and view budgets reported by `status`), not a retry. |
| `WORKSPACE_VIEW_UNWRITTEN` | Informational — never a command's reason code | Appears only as `viewFailureReasonCode` on an otherwise successful receipt, alongside `viewProjection: "unwritten"` and `remedy: "recover"`. The event **is** committed and the reported version and head hash are the real post-append head; only the derived view could not be persisted. Do not retry the mutation — retrying appends a second event for a fact that already landed, which is precisely the defect this field exists to prevent. Run `recover`. Until then, view-verifying reads raise `WORKSPACE_VIEW_STALE` as usual. |
| `WORKSPACE_LOCKED` | Retriable (out-of-process) | Another writer held the engine write lock (`write.lock` in the control directory) for longer than the wait bound (60 s by default). The CLI already waits for the lock itself, so this appears only when a holder keeps it that long; a lock whose holder is gone (same host and process not running, or older than the stale bound) is broken by the next writer without help. Back off and re-invoke the same verb. Never delete the lock file by hand while a writer may be running. |
| `WORKSPACE_GATE_PENDING` | Non-retriable | A workflow precondition, not a transient: a governed gate on the target work is not yet satisfied, so the transition is refused. Retrying is futile. The gate must be transitioned to a satisfying state through its own governed verb before the work transition is re-issued. |
| `SNAPSHOT_RESIDUE_PRESENT` | Non-retriable | The control tree carries claim/quarantine residue at snapshot time. Resolve per the residue taxonomy (recover-cleanable classes via `recover`; manual-removal classes as documented) before re-running the snapshot witness. |
| `SNAPSHOT_MISMATCH` | Non-retriable | A copied control tree does not recompute to its saved manifest. The copy is not a faithful snapshot; re-take the snapshot from a quiesced workspace rather than retrying the verify. |

Other `SNAPSHOT_*` codes (`SNAPSHOT_MANIFEST_INVALID`, `SNAPSHOT_MANIFEST_SCHEMA_VERSION`, `SNAPSHOT_PATH_INVALID`, `SNAPSHOT_INPUT_INVALID`, `SNAPSHOT_VERIFY_SCHEMA_VERSION`) are input/shape failures of the snapshot witness verbs and are corrected by fixing the input, not by retrying.

## 4. Sentinels

Flag-value sentinels carry a fixed meaning across verbs.

- `-` is the canonical null sentinel for a nullable flag; an omitted flag is also
  null. It applies to: `knowledge-create` `--project-id` and `--last-verified`;
  and `work-create` `--parent-id`.
- `null` is a deprecated alias for `-`, accepted this release for external
  compatibility on `knowledge-create` `--project-id` and `--last-verified` only.
  Prefer `-`; the alias may be withdrawn in a later release.
- There is no `--expected-version`, and so no `head` sentinel for it: TCRN-CROSS-STORY-467 R1
  replaced the caller-supplied version with the engine write lock. A write reads the latest
  state under the lock and builds its change against it, and its receipt echoes `ids` (the
  records it wrote), `version` and `headEventHash`, so no read-version-then-mutate two-step
  is needed. `commands`, or `<verb> --help` for a single one, remains the authority on flags.

The `--flag=value` attached form (split on the first `=`) lets a value legitimately
begin with `--`; the two-token `--flag value` form rejects a value beginning with
`--`, which doubles as missing-value detection.

## 5. Budgets

- Each argument token is capped at 65,536 characters; an overlong token fails
  closed with `CLI_INPUT_OVERSIZED` before parsing.
- List verbs are bounded by `--limit`/`--offset`; an envelope's `truncated` flag
  signals more records beyond the page.
- All emitted paths are workspace-relative under the workspace control directory; the contract
  embeds no host root path.

## 6. Determinism guarantees

For an identical committed event basis, every read verb emits byte-identical
canonical JSON: stable key order, sorted records, and no host paths, wall-clock
reads, or randomness in the output. An agent may hash a read envelope to detect
change and may compare two invocations byte-for-byte. Mutations are the only
source of new versions, and each admitted mutation advances the version by one.

## 7. Behaviour deltas since rc.5

Every change below alters what a caller observes. Each was a defect fix, not a
redesign, so no verb changed its purpose — but an agent that hardcoded a reason
code or an admission outcome may need to adjust.

Each row spells verbs, flags and reason codes as they were named when that change
landed. Several have retired since, so `commands` (section 1) is the authority on
what exists now, not the names in a row.

| Surface | Before | Now | Why |
| --- | --- | --- | --- |
| Knowledge mutations after a non-crash write-region failure | `KNOWLEDGE_LOCKED` on every later mutation, permanently | The claim is released; the next mutation reports the real fault | The claim leaked on every failure that left the process alive, bricking the store. A simulated crash still retains the claim, because a real SIGKILL would. |
| `acquire` against a crash-retained recovery claim | `WORKSPACE_LOCKED` forever, unrecoverable | Reclaimed when the claim has expired **and** its pid is dead | The claim recorded pid and expiry that nothing ever read. A recycled pid reads as alive and is still refused. |
| `lease-inspect` | No recovery-claim reporting | Adds `recoveryClaim` (token, pid, expired, processAlive, selfReclaiming) or `null` | The operator path the spec promised had no way to see the claim it was meant to act on. |
| Enum-valued fields across protocol and the adapters | A value whose `String()` matched a member was admitted — `["specified"]`, a `toString` object, a boxed `String` | Rejected with each module's existing malformed code | Fourteen membership tests coerced before comparing. Numbers, `null`, and plain objects were always rejected; only these three shapes ever got through. |
| `extension-registration` `appliesTo` duplicates | `[["work"],["work"]]` passed both the membership and the duplicate check | Rejected | `Set` dedupe is identity-based, so two distinct arrays never collided. |
| `conference-append-position` with both `--actor-id` and `--actor` | `--actor` silently replaced the position author | Both were honoured, the author its own field, until the conference write path retired (TCRN-CROSS-STORY-475 R3); the verb now answers `CLI_COMMAND_UNKNOWN`, and the positions already on a chain still replay | The core input reused one `actorId` slot for the record author and the attestation actor. |
| `artifact-archive-apply` / `-restore` in `commands` | `availability: "cli"` | `availability: "fixture-only"` | The spec always restricted them to `FIXTURE-` Workspaces; the catalog did not say so, so an agent would plan around a verb designed to fail for it. |
| Authority-receipt reads in context-router and generic-profile | A directory reported a `*_LINK` code | Reports the module's `*_SPECIAL_FILE` code | Three copies of the hardened reader had drifted; unifying onto the strongest normalised the gate order. context-router additionally now detects a `chmod` race it previously could not see. |
| Activation install when `settings.json` changes mid-install | The concurrent edit was overwritten silently | `INSTALLER_SETTINGS_INTERFERENCE` | The merge was computed from a read taken before the bundle was written and applied wholesale. The interference is terminal, not retriable. |
| Test-controller child policy | `stdio: "inherit"` refused only in that exact spelling; `execSync`/`execFileSync` unguarded | Array, descriptor, and stream forms all refused; the sync exec pair is guarded | The guarantee was bypassable by spelling it the long way. |
| An authority receipt that grows past its ceiling **during** the read | `CONTEXT_AUTHORITY_CHANGED` / `PROFILE_ADMISSION_CHANGED` / `COMPATIBILITY_AUTHORITY_CHANGED` | The module's limit code: `CONTEXT_AUTHORITY_MALFORMED`, `PROFILE_ADMISSION_MALFORMED`, `COMPATIBILITY_LIMIT_EXCEEDED` | The three readers each did an unbounded `readFile()` and inferred the growth from a length-vs-size mismatch, which reads as a race. The unified reader stops at the ceiling and says so. **Retriability changes with it**: an agent that retried the `*_CHANGED` race must now treat this as terminal. |
| `migration-plan --target-version`, `--expected-revision`, `--stale-days` given a non-integer | The `NaN` was judged as a semantic refusal — `WORKSPACE_MIGRATION_DOWNGRADE` with the message `"NaN"`, `KNOWLEDGE_INPUT_INVALID`, `KNOWLEDGE_RECORD_INVALID` | `CLI_ARGUMENT_MALFORMED` naming the flag | A syntax error was being reported as a considered judgement about versions, promotions, or staleness policy. Integers still reach core, so genuine downgrade and range judgements are unchanged. |
| `knowledge-list` / `knowledge-candidates` `--limit` / `--offset` given a non-integer | `KNOWLEDGE_INPUT_INVALID` naming the flag | `CLI_ARGUMENT_MALFORMED` naming the flag. `knowledge-candidates` has since retired with the authority family (TCRN-CROSS-STORY-467 R2) and answers `CLI_COMMAND_UNKNOWN`; `knowledge-list` keeps the rule | The same syntax-as-semantics confusion, on the last two pagination sites. The window rule itself (at least 1, at most the record ceiling, offset at least 0) stays with core and still answers `KNOWLEDGE_INPUT_INVALID`. |
| `--limit=` and `--segment-events=` (supplied but empty) | Silently dropped; the verb answered as if the flag had been omitted | Treated as the `0` they parse to, and refused accordingly | A truthy guard cannot tell an empty value from an absent one. `--limit 0` and `--segment-events 2` are byte unchanged. |
| `work-list --parent-id null` | `total=0` — the record created by `work-create --parent-id null` was unfindable by the identical spelling | Matches, exactly as `--parent-id -` does | `work-create` accepted both sentinel spellings and `work-list` compared against only one. This was a silent wrong answer, not an inconsistency. |
| `verifyPrivacy` when the git object stream overflows its buffer | `COMMAND_FAILED` | `COMMAND_OUTPUT_OVERFLOW`, with `PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE` for a short stream | Batching the scan introduced an explicit `maxBuffer`, and an overflow there had to be distinguishable from a command that simply failed. `ENOENT` and `ETIMEDOUT` still report `COMMAND_FAILED`. |
| `P8_VERSION_MISMATCH`, `P8_ARCHIVE_*`, `P8_CORE_REFERENCE_*` (8 codes) | Emitted by four release helpers | Removed | The helpers were dead — no gate, no script, and no test reached them. No caller could observe these codes, which is why they are listed here as a removal rather than a migration. |
| `--expected-version` (and its `head` sentinel), `lease-inspect`, `lease-break`, `lease-recovery-break`; `WORKSPACE_CAS_MISMATCH`, `WORKSPACE_LEASE_*`, `WORKSPACE_RECOVERY_CLAIM_BROKEN` | A writer took a lease and passed the version it expected; a stale version was refused | Removed. A writer takes the engine write lock (`write.lock` in the control directory), reads the latest state under it and appends; a second writer waits instead of failing, and a lock whose holder is gone is broken by the next writer. Every write receipt carries `ids`, `version` and `headEventHash` | TCRN-CROSS-STORY-467 R1: the version ceremony cost a read before every write and bought nothing a single-machine lock does not; chains written under the lease replay unchanged, because none of that state was ever part of an event. |

## 8. Two rules for an agent reporting on this repository

These are not style advice. Each was observed twice in this repository's own work, by the
agents building it, and each survived review the first time because the conclusion it
supported happened to be correct. They are tracked in
`scripts/policy/failure-pattern-register.json`, which is a counter rather than an essay:
one occurrence records, two promote to this section.

**Do not argue from a gate you have not checked.** "The gate is green" is a claim about
output you have read or a command you have run. Neither the presence of a gate nor its
absence may be asserted from memory or inferred from a name. The two occurrences: a
dependency decision was framed as "otherwise there is no visibility at all" without reading
`vulnerability-policy.json`, which carries `maxAgeDays: 30` and had been forcing a monthly
review the whole time; and `core-reference-personas.ts` was asserted to be an RC1 normative
input in order to argue against editing it, when the RC1 input set contains no persona
entry at all. Both conclusions held. Both arguments were unfounded, and the second one two
models then reasoned from for a full round.

The reason this is a rule rather than a preference: an unchecked gate cited as evidence is
indistinguishable, in a transcript, from a checked one. It is the same failure as reading
"all tests passing" out of an agent's own prose — only the agent doing it is you.

**A scope must be a check, not a paragraph.** When you narrow a guard, relax an invariant,
or restrict where something may be used, the restriction goes in the code path. A comment
describing the intended boundary is a description of a boundary that does not exist. The
two occurrences: `readDependencyManifest` shipped with its `node_modules` scope written as
a comment and no path constraint in the body — inside the function added to fix a guard
that had been misapplied for exactly this kind of reason; and a prose register of these
very patterns was proposed one message after establishing that prose discipline rots, which
is the same defect one layer up.

The corollary is the one that costs something: if the restriction genuinely cannot be
expressed as a check, say so where the residual is recorded, and do not let the surrounding
fix read as though it closed.

## 9. What gate identity did and did not deliver

The gate verbs and the identity roster are retired (TCRN-CROSS-STORY-467 R2): no new gate
is created, transitioned or deleted. Gates already on a chain still replay, and a pending
one still holds its work item back from `done`. What follows is kept because replay still
judges the decisions those gates recorded.

A gate whose `outcomeClass` was `owner_intent_required` could not reach `satisfied`
without an out-of-band roster naming which actors may close which classes, and a named
actor that roster permitted. Three statements bound what that bought, and they stay
load-bearing for every chain that carries such a gate.

**It delivers authorization, not authentication.** The roster says which identities are
permitted. Nothing here establishes who ran the command. `--actor` is an assertion by the
caller, as it has always been.

**Replay does not defend against a forged tail-append.** Enforcement happens at the verb.
Replay checks that a recorded decision is well formed and does not contradict the actor its
event was signed with, and it deliberately never re-reads the roster — a chain whose
readability depended on an external file still being present would brick on ordinary key
rotation, or on a restore onto a machine that never had it.

**No non-cryptographic replay check could defend against it either.** Event hashes are
unkeyed, so anyone who can write the log can compute a consistent event that replays clean,
and every input such a check could read is derivable from the same machine. This is not a
gap left for later within gate identity; closing it is the external-anchor programme, which
is a different design with a different trust story. The property is pinned by a test that
appends a forged satisfied gate and asserts replay accepts it, so the day the boundary
moves, this section fails with it.

## 10. Recall: what an answer holds, and what an empty one means

`recall --workspace <library> --at <instant> --query <prompt>` answers from one library,
whatever directory it sits in; there is no `--partition` (TCRN-CROSS-STORY-474). `--host`
names the prompt-language policy the answer is negotiated against, `--tau` overrides the
`retrieval.tau` setting for one call and `--limit` caps the records.

- **What is searched.** The Stories and the Incidents on their title, goal and body, the
  Initiatives and Epics on their title and goal, every minutes record, and the cards with the
  phrasings they carry. A Subtask, a Release or a Review is not searched, and status does not
  matter: a done Story is still the record of what was intended. A key or a key fragment that
  names one record by whole tokens and carries a digit (`TCRN-CROSS-STORY-474`, `STORY-474`)
  puts that record first.
- **What an answer holds.** `reasonCode` `RECALL_READY`; `records`, each with `kind`, `key`,
  `id`, `status`, `title`, `summary`, `score` (a decimal string), `parentChain` (the titles
  above the record, nearest first) and `line`, the record as one line a host can put in front
  of a prompt: `[Story done] title · key · id · Epic title ‹ Initiative title` for a work
  record, `[纪要 key] title · D1 first decision` for minutes, `[卡片] subject · id` for a card;
  and `context`, those lines in rank order cut at whole lines to `injection.perPromptBytes`
  (reported as `perPromptBytes`, 1600 by default). The first line that does not fit ends the
  context; `records` is never cut by it.
- **What an empty answer means.** When the best hit scores below the strong-hit threshold,
  `reasonCode` is `RECALL_NO_STRONG_HIT` and both `records` and `context` are empty: the prompt
  is about nothing the library holds, and a caller injects nothing. It is not an error and not
  a partial answer; `total` still says how many records matched at all. A named key is always
  answered, whatever the threshold. The threshold is the `retrieval.tau` setting, counted in
  words that only one record of the library carries: its unit is the bm25 weight such a word
  gets in a library of N records, ln((N - 0.5) / 1.5), and `recall` multiplies tau by that unit
  to get the searched library's own bm25 floor, so one value serves a library of any size (the
  default gives a floor of about 18 at 600 records and about 2.5 at 4). Scores stay raw bm25.
  The default (`RECALL_STRONG_TAU`, 3) is calibrated on a library the size of the cross-project
  chain and on a small one (`tests/fixtures/retrieval-eval/strong-threshold.json`); `--tau`
  overrides it for one call.
