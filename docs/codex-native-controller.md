# Opt-in Codex native controller

This API connects a caller-owned Codex app-server client to the Einzbern SubagentStop
handler in an isolated host. It does not establish support in the default Desktop
client. The standard handler remains unavailable without this explicit connection.

The host owner supplies an initialized `client.call(method, params)` and a
`tools.registerDynamicTool({ name, description, inputSchema, handler })` interface.
The latter must register real tools with that app-server and invoke the handler
only from server-origin dynamic-tool requests, preserving `threadId`, `callId` and
`arguments`. A local map or agent-authored payload is not native registration.

The required native methods are `thread/read`, `thread/turns/list`,
`thread/items/list`, `thread/loaded/list` and `thread/archive`. Their responses
must expose the parent/session relationship, full turn items, native task activity,
model and effort, terminal states and dynamic-tool receipts consumed by the
controller. The owning client is responsible for transport timeouts and disposal.
API compatibility and real native behavior require separate acceptance evidence.

The versioned hook entry exports the controller and local bridge as well as
`runHookEvent`. A caller can import the same source entry after building, or the
versioned entry supplied by its normal installation:

```js
const { createCodexNativeController, createCodexNativeHookBridge } =
  await import(versionedHookEntryUrl);
const controller = await createCodexNativeController({
  client, tools, run, runtimeDirectory, wakeOnAgentMessagesApproved: true,
});
if (controller.capability !== "ready") throw new Error(controller.reasonCode);
const bridge = await createCodexNativeHookBridge({
  controller, socketPath, timeoutMs: 900_000,
});
try {
  // Start the authorized isolated app-server host with this inherited environment.
  // Its normal installed hook launcher reaches the same in-memory controller.
  await ownHostSession({
    env: { ...process.env, EINZBERN_CODEX_NATIVE_HOOK_SOCKET: bridge.socketPath },
  });
} finally {
  await bridge.close();
  await controller.close();
  await disposeOwnedClient();
}
```

`ownHostSession`, tool registration and client disposal above are the caller's
existing native interfaces, not interfaces implemented by Einzbern. Keep the
socket path short enough for the OS Unix socket limit, in an existing private
directory (0700); the bridge creates a 0600 socket. Set `EINZBERN_HOST=codex` only
in the authorized host environment. Preserve the ordinary installed launcher and
its project registry. No live Desktop or global configuration change is needed.
The socket carries only hook JSON and decisions. It neither reads private session
storage nor enrolls members from files. Same-account hostile code is outside this
filesystem transport's authentication boundary.

`run` pins batch/attempt, native parent thread/session, start/deadline, query
interval (at least 10 seconds), query-failure bound, worker/collector model and
effort, and host-observed pre-dispatch capacity. Pass the approved per-run wake
opt-in; this flag does not enable native wake behavior itself. Dispatch the fixed
workers and exactly one dedicated collector, then have the parent invoke
`einzbern_register_native_batch` with their exact native task names. The collector
lists all worker names in `targets`. Parent-only `einzbern_control_native_batch`
can signal the documented exception exits without changing membership.

Registration/progress exist only in the owning process. Restart recovery is not
implemented. Do not recreate an attempt or a second collector after an unknown
outcome. Result artifacts preserve complete structured final items as canonical
JSON, with digest and native references; they do not preserve transport frames.
Worker archiving and observed unload are separate from collector exit, native
return and parent wake. The owner must retain evidence and observe the latter
events through the native client before declaring acceptance or releasing all
resources. `close()` unregisters callbacks; it does not cancel native children.

The bridge bounds each connection's size and lifetime. It cannot abort an already
running controller query. Bridge or controller failures retain the launcher's
ordinary fail-open policy, and do not prove structured collector completion.
