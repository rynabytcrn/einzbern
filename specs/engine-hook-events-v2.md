<!-- SPDX-License-Identifier: Apache-2.0 -->
# Engine hook events

The installed engine owns UserPromptSubmit, SubagentStart and PreToolUse for
Claude Code and Codex. Codex additionally owns SubagentStop for the bounded
collector protocol below; it is not in the common event table. Setup, update and
host-render reconcile the same stable launcher commands; doctor compares the
installed hooks with that same plan. SessionStart remains the navigation fallback
when agents.navigation is declined. SSH and control-tree hooks remain retired.
DSH's existing contract is unchanged.

## Subagent first-work context (BL-34)

The native SubagentStart envelope provides agent_type and agent_id, not the
delegated task text. The engine therefore queries the normal registered-project
recall pipeline with agent_type, applies its normal threshold and byte budget,
and returns matching lines beside the navigation pointer in SubagentStart's
hookSpecificOutput.additionalContext. It does not invent a prompt field, read
arbitrary transcripts or claim that an agent-type query is task-specific recall.
Without a match, the navigation pointer still tells the target to recall its task.
The hook log records the actual recall outcome, including empty input and no hits.

Both hosts document context injection at subagent start. Repository tests verify
real recall with native-shaped payloads and the output protocol. They cannot prove
that the installed host fired the hook before first work, approved its current
bytes, or covered every native spawn variant. Those remain native-host acceptance
obligations; no live installation or native trust state was changed by this work.

## Read guard (BL-35)

Only tool_name Read with tool_input.file_path is enforceable. A regular file
strictly larger than 32 KiB requires a positive integer limit of at most 200 lines.
An omitted, invalid or greater limit is refused with the documented PreToolUse
permissionDecision deny envelope. A file of exactly 32 KiB is allowed.

Shell/Bash and all other tools are observational only: their command strings are
not parsed or executed, and they are never refused by this guard. Unknown input,
missing paths, directories and filesystem exceptions fail open. The engine records
an observed/denied outcome without recording command text or file contents. Hosts
without a dedicated Read surface do not acquire shell enforcement through aliases.

## Codex SubagentStop collector

The Codex-only `SubagentStop` command reaches the versioned engine entry as
`subagent-stop`. Normal install, upgrade, repair, managed merge and package paths
carry explicit capability/version/trust admission. Unknown/unsupported admission
does not add a new stop entry; existing entries remain for explicit resolution. Registration and executable syntax do not establish
actual callback, trust/version support or live collection capability.

### Current activation boundary

Default Desktop enforcement remains **capability-unavailable / unverified**.
The expressly authorized isolated controller/bridge route is described in
`docs/codex-native-controller.md`; source availability is not actual-host acceptance.
The installed handler returns `{}` without changing the ordinary native final.
An old `EINZBERN_SUBAGENT_STOP_V1` marker yields the internal diagnostic
`CODEX_STOP_CAPABILITY_UNAVAILABLE` in the existing hook log, never a binding or a completion verdict.
No worker text, nonce, manifest, local snapshot or first matching stop may enroll
an authorized collector. Old device files are left untouched: no migration,
private session parsing, second daemon, invented RPC or unconditional host claim.
Do not dispatch a stage as contract-compliant while this prerequisite is missing.

Supported protocol pieces alone are insufficient: the parent must correlate its
actual native spawn receipt to an immutable exact role/batch/agent/application
attempt and fixed members. Native turn IDs are not application attempt IDs.
An authorized same-host reader must prove fresh member status/results and
reentrant hook access, and a supported wait must continue the same live collector.
A last-known agentsStates record, idle/notLoaded thread, interrupted/shutdown or
notFound state is not confirmed completion/cancellation. Only the owning initialized client can provide that wiring. Actual callback and
normal installed-route behavior need separate native evidence.

### Deterministic contract (not a host adapter)

`evaluateCodexCollectorStop` models decisions from already-proven parent mapping
and same-host observations. It does not authenticate its arguments. Fixture inputs
are synthetic and never constitute native evidence. Any future adapter must
serialize and persist progress per exact batch/attempt before delivering a decision;
recovery with missing/uncertain progress must not replay a final or revive a worker.
The model's `ended` flag closes its decision stream, not proof of native termination.

Exactly one dedicated economy collector is required per dispatched stage. Only
that role is outside the harness worker cap; it still consumes a real reserved
slot. The capacity validator models remaining child capacity after the parent and
other active agents. Reduce workers/split stages, or block if one worker plus the
collector cannot fit. No ended-worker reuse or second collector while termination
is unknown. These are E-owned rules; M is compact generated navigation, not an
independent scheduler or policy authority. Non-Codex hosts and dot are unaffected.

The fixed member list retains raw host states/results and explicit completed,
failed, cancelled_confirmed, pending and unknown classifications. Observations
must be within this attempt, after dispatch, no later than now, at most one query
interval old, monotonic and in exact member order. Terminal evidence references
are required but not authenticated by their string shape. Replay, stale/future,
wrong-attempt data, unknown and query failure cannot establish success.

Pending decisions continue only the same live collector to a bounded native wait,
one query interval after the current evaluation and clamped to the deadline, not
a sleep in the hook or Stop-to-block loop. Accepted observation age does not shorten
that wait; an elapsed deadline exits before blocking. Early query,
replay and no progress terminate the model with an explicit exception. Deadline,
query-failure limit, budget exhaustion, pause, user cancellation, safety, permission,
protocol and script errors also retain explicit exceptional facts; no success
substitution, blind retry or fabricated cancellation acknowledgement.

The product stages one canonical raw handback and freshly revalidates native
provenance, controls and artifact digests before allowing that exact final. Formatting
exhaustion permits only an explicitly audited failed-final handoff with unresolved
ownership, never a verified raw packet or true resource release. The versioned
`collector-wait` helper executes outside the hook in the same live collector;
validated progress and per-read timestamps persist as private runtime evidence.
Recovery/restart is unsupported and cannot enroll from these files or replay a final. No parent-message tool or acknowledgement-before-exit handshake exists.
Repeated finalized decisions do not emit another final. Exit, native delivery,
genuinely idle parent resumption and resource release require separate actual-host
evidence, not the evaluator's decision. Collectors perform no analysis, summary,
implementation, acceptance, formal gate, integration or dispatch. Main-thread
/goal or /loop active waiting is forbidden; existing goals/automations and legitimate
M governance rounds with substantive work remain intact.

## Platform doctor (BL-41)

The default platform-doctor entry now requires the container's actual .ether
library. It validates optional root bridge imports, reuses the current engine's
eight device/project checks, and syntax-checks the stable launchers and the current
version's CLI and hook entries. A minimal container needs no legacy partition
folders, checked-out platform projects, MCP file or launchd job. Missing or corrupt
current installation state remains a failure. A green result explicitly leaves
native hook dispatch unverified.

The old platform checker remains an explicitly named inspectLegacyPlatform
migration diagnostic. Historical fixture tests exercise it under that name; it is
not selected by the CLI, by the presence of old directories, or as a fallback when
current checks fail. Current-layout tests use real initialized .ether libraries,
registrations, rendered hooks and installed skill records rather than supplying
synthetic pass verdicts.

Interface references, checked 2026-10-17:
- https://code.claude.com/docs/en/hooks#subagentstart
- https://developers.openai.com/codex/hooks
- https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/subagent-start.command.input.schema.json

Run the current check with `pnpm platform:doctor --platform-root <container>`.
The CLI has no legacy mode or automatic fallback: an old-only container fails the
current library check. `inspectLegacyPlatform` is an explicitly imported historical
diagnostic for migration investigations, not an installation acceptance command.
