<!-- SPDX-License-Identifier: Apache-2.0 -->
# Engine hook events

The installed engine owns UserPromptSubmit, SubagentStart and PreToolUse for
Claude Code and Codex. Codex peer coordination does not register SubagentStop or
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

No collector subagent, cap exemption, reserved collector slot, SubagentStop
keepalive, collector-wait helper or old collector fallback is active. Normal
setup/update/repair retires an old stop entry only when it can prove that the exact
entry is engine-owned. Preserve user-edited entries and unrelated hooks; surface
unresolved ownership rather than erasing it. Unknown host support does not justify
installing a stop hook. Ordinary native final output is not intercepted or blocked.

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
