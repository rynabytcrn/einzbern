# Opt-in isolated Codex native controller

Default Desktop callback, installation, wake and unload remain unverified. This API is
only for an expressly authorized isolated Unix native host. It neither enables wake nor
changes a live Desktop/control tree. Non-Codex and dot do not receive this hook.

Import `codexNativeDynamicToolSpecs`, `createCodexNativeController`, `createCodexNativeHookBridge` and
`waitCodexNativeCollector` from the normal **versioned** `scripts/einzbern-hook.mjs`
entry after the approved build (or from its normally bundled installed entry).
The helper is reachable through the existing static import graph; no sidecar copy,
private session reader, daemon or independently installed helper is required.

The owning initialized app-server client supplies `call(method, params, {signal})`
and `registerDynamicTool(spec, {signal})`. They must actually support cancellation
and finite settlement. `transport` must carry `abort: "supported"`, `rpcTimeoutMs`,
`hookTimeoutMs` and the real `evidenceRef`. Unknown support disables this dependent
route. The RPC bound must be shorter than the actual hook timeout; the selected
transport permits at most 900000ms and helper intervals at most 890000ms. These
are transport limits, not extra query/stop budgets or a guessed Codex version range.
A nonconforming client can leave a native operation unsettled: `responsibility()`
reports it, and the owning client must dispose/query it. Timeout is never a native
cancellation acknowledgement. `now()` is the one clock seam for deterministic tests.

Pass the unchanged fixed `run`, private owned `runtimeDirectory` (0700), approved
`wakeOnAgentMessagesApproved`, and absolute normal installed `helperEntry` path.
The host itself must have the separately approved native wake configuration.
Before `thread/start`, call the pure `codexNativeDynamicToolSpecs(maxAgents)` and
pass each definition as `{ type: "function", ...definition }` in `dynamicTools`.
After the server returns the real parent thread ID, create this controller with that
ID/session and connect `registerDynamicTool` to the matching owner handler table.
Only then start the parent turn. This avoids inventing a parent ID to obtain schemas.
The two exported definitions are also the definitions the controller registers.

Register real server-origin `item/tool/call` requests, preserving the actual request
ID and `params.threadId`, `params.callId`, `params.turnId`, tool and arguments.
Invoke only that registered handler with `{ threadId, callId, arguments }` and answer
the original server request with `{ success: true, contentItems: [{ type: "inputText",
text: JSON.stringify(result) }] }`; a handler/transport error needs an explicit failed
response and owner handoff. A direct fabricated handler call is not native evidence.
No turn starts until both owner handlers and the private bridge are ready. The parent calls `einzbern_register_native_batch` once after
dispatch with exact task names and one collector targeting every fixed worker.
Registration is serialized and an attempted registration cannot be reenrolled. A
bounded failed result reaches the actual owner, retaining all unresolved dispatched
children even when identities could not be resolved. Ordinary/unregistered stops
remain untouched. Tool arguments or artifact files alone never confer role authority.

Create the bridge in the owning process with a private socket directory and supply
`EINZBERN_CODEX_NATIVE_HOOK_SOCKET` only to that isolated host. The normal launcher
reaches its versioned entry. A running-member stop returns promptly with an instruction:

```
node '<normal versioned entry>' collector-wait '<JSON identity>'
```

The **same live collector** executes that helper outside SubagentStop using its
ordinary command tool and inherited isolated socket. The bridge validates its exact
batch/attempt/collector/turn/session and fresh native pinned turn, waits until the
persisted next-query time or deadline, then settles. No child dynamic-tool inheritance
is assumed. The hook never sleeps. Early stop callbacks return the same helper
instruction without spending query-failure budget. Paths/JSON are shell-quoted as
literal arguments; the helper does not enroll from those arguments. Local account
socket access is not hostile same-UID attestation.

All constituent native reads retain acquisition/completion times and are rechecked
against the current clock after asynchronous work. Pages, progress, repeated cursors,
duplicate/empty pages, bytes, each RPC and whole hook callbacks are bounded. Successful
internal reads do not consume stop/format/query-failure budgets. Parent-only
`einzbern_control_native_batch` signals pause, user cancel, budget, safety or permission.
Failed/systemError, confirmed interrupted cancellation, pending and unknown remain
distinct. Final allow rechecks registration receipt, dispatch identity, pinned native
turns, controls, worker status/error/final items and artifact hash. Parent receipt is
never required before collector exit.

Artifacts are complete **canonical structured native turn content**, not transport
frames. Exclusive no-follow creation, owner/type/mode/link checks and digest readback
reject unsafe preexisting artifacts, including writable equal-byte files. Private
content-addressed runtime evidence retains registration, read timing, progress,
exceptions and handoff dispositions. It is evidence, never enrollment authority.
The owning caller retains it until downstream acceptance/audit retention permits
cleanup. Unsupported restart/recovery cannot replay a final, reenroll an attempt or
start a second collector; native history must resolve the old attempt first.

Four malformed formatting responses produce an auditable `failed-final-unresolved`
handoff preserving the actual failed final. That allow permits native exit; it does
not verify arbitrary text or release children. Authenticated query/control exceptions
similarly retain explicit unknown facts and owner responsibility. A verified packet,
failed final, exception handoff, collector exit, native return, idle-parent wake,
actual unload and resource release are separate facts. This controller does not
archive active workers or claim native release. The owner handles subsequent real
unload/handoff through its supported client and retains all active children.

Close the bridge, close the controller, then dispose the owned client. Bridge close
aborts its connection-owned in-flight work and waits for handlers; controller close
aborts its operations, rejects later direct callbacks, unregisters tools and drains
serialized work. Socket disposal alone never releases native children. Connected
transport failures surface an explicit error instead of a fabricated `{}` completion.

Installation plans accept `CodexHookAdmission` with state, observed version, source
evidence and actual trust/capability. Missing evidence stays unknown; unsupported or
restricted hosts do not gain a new SubagentStop entry. Existing entries are preserved
pending explicit resolution. Other installation/event tasks continue. `hooks=false`
requires explicit `enableHooksAuthorized` plan authority to change. Owned matcher,
timeout/group/settings edits conflict instead of being dropped; unrelated hooks and
native trust states are retained. Apply verifies installed bytes and every rollback's
original bytes/absence, retaining the primary error and backup references. These source
contracts and synthetic fixtures do not establish actual native support or acceptance.
