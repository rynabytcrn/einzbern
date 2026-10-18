<!-- SPDX-License-Identifier: Apache-2.0 -->
# Engine hook events

The installed engine owns UserPromptSubmit, SubagentStart and PreToolUse for
Claude Code and Codex. Setup, update and host-render reconcile the same stable
launcher commands; doctor compares the installed hooks with that same plan.
SessionStart remains the navigation fallback when agents.navigation is declined.
No Stop, SSH or control-tree hook is restored. DSH's existing contract is unchanged.

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
