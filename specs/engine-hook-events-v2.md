<!-- SPDX-License-Identifier: Apache-2.0 -->
# Engine hook events

The installed engine owns UserPromptSubmit, SubagentStart and PreToolUse for
Claude Code and Codex, plus PostToolUse and Stop for Codex. Codex peer coordination does not register SubagentStop or
a collector keepalive hook. Setup, update and
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

## Codex peer coordination and retired collector hooks

The current Codex contract is `docs/codex-native-controller.md`: independent main
and economy conversations, with the economy coordinator directly dispatching and
reading worker results. It is selected only for an explicit Codex host, never by
an unknown-host fallback. Claude Code and DSH retain single-conversation
coordination and native completion notifications; dot remains independent.

A successful native SEND is retained as an unbound handoff observation even before
main has a receipt or role. Validated peer-record stages recoverable receipt facts
for both participants, including actual retained worker IDs. These derived facts
survive turn changes and engine restarts; they grant neither dispatch permission
nor a native parent/child relationship. No main-side staging or repeated SEND is
required. Unknown/failed sends do not become successful handoffs.

Codex `read_thread` and `wait_threads` use a separate durable query guard, including
sessions with no cache or peer role. The first query can return its result. Another
query is allowed only when every target is an observed native subagent of this
native session/actor and its actual returned latest turn is `inProgress`. Native
SubagentStart or the original native spawn return establishes that relationship;
peer labels, model names, `changed`, timeout and thread-active flags do not.
Unknown identity, terminal/unknown turns or any independent target ends the loop.
The next PreToolUse denies before the tool runs, regardless of cursor, tool,
target mixture, wrapper, new model turn or summary continuation. Reserving the
outstanding query also prevents concurrent inner calls from outrunning its result.

UserPromptSubmit with an actual nonempty prompt starts a new query opportunity.
A new prompt can steer the same active turn, including an identical repeated
request. A turn id or compaction alone cannot reset state.
Where the host supplies a subagent actor ID, its query state is separate from
the parent session. The
hook consumes the supported event, not a caller-added query-intent field or an
extra Owner approval. Host events and local evidence are source correlation,
not authentication against a same-permission local writer.

PostToolUse adds context without hiding the first query result. It cannot undo a
query or promise to stop the whole model turn. In code mode the same inner
PreToolUse deny rejects the next tool promise before execution. `continue:false`
from PostToolUse is not used as evidence of hard termination. Verify tool effect
counts and host termination separately on the actual consuming Desktop version.

Before a coordinator ends, Stop checks the same observation. Only a confirmed
terminal, report-eligible batch with no delivery attempt receives a reminder to
load Mana Orchestrate and follow its batch-delivery procedure. It does not send
the report itself or create messaging authority. The first reminder is retained
before returning `decision: block`; a repeated Stop, an active stop continuation,
an attempted or uncertain delivery, or an absent observation ends normally.
This checks completion of an existing handoff; it does not wait for workers or
keep the coordinator alive while a batch is pending.

No collector subagent, cap exemption, reserved collector slot, SubagentStop
keepalive, collector-wait helper or old collector fallback is active. Normal
setup/update/repair retires an old stop entry only when it can prove that the exact
entry is engine-owned. Preserve user-edited entries and unrelated hooks; surface
unresolved ownership rather than erasing it. Peer hooks are rendered only for
explicit Codex, not an unknown or different host. Final output outside the eligible coordinator case is
not intercepted or blocked.

The former collector admission/bridge protocol is superseded history, not an
activation prerequisite for peers. Historical records and evidence stay readable;
they are not rewritten as successful peer acceptance. No private session database,
second daemon, invented RPC or marker-based enrollment is introduced. A local
record can retain reconciliation facts but cannot authenticate native dispatch or
prove delivery. Shared rules describe the host boundary; actual activation must
also use the explicit host at runtime and in rendered host navigation.

Source/fixture checks cover host isolation and owned-hook retirement. Native
acceptance follows the current Owner review scope and remains separate from source
regression and ordinary platform doctor results. Keep individual run results in
their work records; this installed contract does not certify a particular host.

## Durable Codex worker dispatch guard

New v2 peer receipts validate scoped `collaboration.spawn_agent` preparations and
retain their actual spawn returns/worker ID pointers. Independent create/fork
records remain their historical kind; v1 replay is legacy and cannot enroll.
`execution-codex-peer-record` writes `codex-peer-roles/<session-sha256>/anchor.json`
and `role.json` under the device root with atomic files and the existing lock.
The anchor is saved first, so interrupted payload persistence is known failure.
Role identity and validated receipt are checked on every recovery. This state is
outside cache and version directories and is not cleared by UserPromptSubmit,
summary, terminal batch, Stop or restart. Explicit governed lifecycle and readback
use the existing peer-record command as described in the native controller doc.

Before ordinary cwd/registry routing, the stable launcher routes Codex query,
SEND, native dispatch, UserPromptSubmit and SubagentStart observations to the same
current engine guard. This covers independent queries without role enrollment and
successful main-first sends outside a registered cwd. Active coordinator
create/fork and unauthorized coordinator-to-main settings overrides are denied at
PreToolUse. Known damaged protective state fails visibly for its dependent tools.
Other hosts keep their existing behavior. Native code mode uses structured inner
tool identities and arguments; JavaScript, shell and transcripts are never parsed.
No SubagentStop, collector or background service is added.

Doctor/setup report native hook registration, enabled/current trust and role
recovery as `codexGuard` separately from structural file reconciliation. Only a
current actual hooks/list observation for PreToolUse, PostToolUse,
UserPromptSubmit and SubagentStart, with matching candidate commands and
unchanged source/config byte observations establishes native readiness. Missing,
disabled, untrusted, unsupported or unknown native state is not-ready. A file or
old subagentStop flag alone cannot prove readiness. See the closed observation
shape and lifecycle in `docs/codex-native-controller.md`.

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

## Setup evidence boundary

Setup receipts and launcher self-checks retain actual installation errors, including
`hookError`; registration and a green syntax check do not prove native delivery.
Old collector capability/admission evidence does not authorize a new peer session,
override hooks=false, erase user restrictions or establish a model selection.
Peer readiness uses the selected device-host model policy and supported actual
host operations, not SubagentStop trust admission. See the model-policy contract
for required main/economy groups and optional flagship configuration.
