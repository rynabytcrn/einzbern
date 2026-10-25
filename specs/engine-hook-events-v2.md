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
`subagent-stop`. The handler accepts only one exact single-line
`EINZBERN_SUBAGENT_STOP_V1 ` JSON envelope in `last_assistant_message`, with
`batchId`, `nonce` and `manifestPath`. An absent or malformed marker returns `{}`.
The handler reads only the exact batch manifest path under the device directory's
`subagent-stop/batches/<batchId>/` directory. The parent writes the manifest before
dispatch; the collector task name and every target task name must be the actual
native task names. The nonce is a correlation value, not authentication.

The first matching stop validates the existing manifest, then persists the real
payload `session_id` and `agent_id` once in `binding.json` and synchronously blocks.
Further stops are considered only when both IDs match that binding. A matching
nonce cannot bind a replacement agent or session. The handler never reads a task
transcript, private session database, or native task store, and it never invokes
collaboration or sends a parent message. `stop_hook_active` does not imply that a
target is complete.

The native collector writes `snapshot.json` with the exact fixed target list, each
raw host state, an explicit finality classification (`completed`, `failed`,
`cancelled_confirmed`, `pending` or `unknown`), evidence reference, observation
time, next query time, consecutive query failure count, latest query error,
exception reason and report attempt. The handler does not translate raw host
states into finality. Pending snapshots must schedule `nextQueryAt` no earlier
than `observedAt + queryIntervalMs`. While within budget the handler blocks the
same collector and tells it to wait with a native timer, then query the fixed list
once. It does not sleep inside the synchronous hook. A repeated stop without a
new snapshot is allowed through, preventing a rapid block loop.

All targets must have an explicit terminal classification before a normal report
is requested. A terminal `reportAttempt` is recorded as `in-flight` before the
collector calls its authorized native parent-message tool once. Only a saved
`acknowledged` state with the actual tool-result evidence permits a confirmed
normal release. `unknown` and `failed` outcomes are retained and never retried
blindly; the hook and local file cannot make host delivery plus acknowledgement
storage atomic. In-flight results get at most one reconciliation continuation.
Deadline, query failure limit, explicit collector cancellation, script error and
protocol error remain distinct; a bound collector gets at most one focused
exception-report continuation, then ends with unresolved delivery or target
facts left visible. An unbound or unrelated stop always fails open with `{}`.

This local protocol decision is not authentication, proof that the host fired the
hook, or proof that a native message was delivered. Source and fixture regressions
cannot establish those separate native-host facts.

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
