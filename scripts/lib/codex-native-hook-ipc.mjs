// SPDX-License-Identifier: Apache-2.0
// Local transport for a caller-owned live controller. This does not create a Codex client.
import { chmod, lstat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";

const MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 900_000;

function requireTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error("CODEX_NATIVE_IPC_TIMEOUT_INVALID");
}

async function requirePrivateDirectory(socketPath) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath)) throw new Error("CODEX_NATIVE_IPC_PATH_INVALID");
  const directory = await lstat(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error("CODEX_NATIVE_IPC_DIRECTORY_NOT_PRIVATE");
}

/** One newline-delimited JSON frame per connection, with a finite byte/time bound. */
function readFrame(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("CODEX_NATIVE_IPC_TIMEOUT")), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("error", fail);
      socket.off("end", ended);
      socket.off("close", ended);
    }
    function fail(error) { cleanup(); reject(error); }
    function ended() { fail(new Error("CODEX_NATIVE_IPC_INCOMPLETE")); }
    function data(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_BYTES) return fail(new Error("CODEX_NATIVE_IPC_FRAME_TOO_LARGE"));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      cleanup();
      try {
        if (newline !== bytes.length - 1) throw new Error("CODEX_NATIVE_IPC_EXTRA_FRAME");
        resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
      } catch (error) { reject(error); }
    }
    socket.on("data", data);
    socket.once("error", fail);
    socket.once("end", ended);
    socket.once("close", ended);
  });
}

/**
 * The owner calls this in the same process as its live app-server controller. Socket access
 * is restricted to the local account; it is not attestation against hostile same-UID code.
 */
export async function createCodexNativeHookBridge({ controller, socketPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  requireTimeout(timeoutMs);
  await requirePrivateDirectory(socketPath);
  if (controller?.capability !== "ready" || typeof controller.handleSubagentStop !== "function") throw new Error("CODEX_NATIVE_IPC_CONTROLLER_UNAVAILABLE");
  const connections = new Set();
  const active = new Set();
  let closed = false;
  const server = createServer(socket => {
    if (closed) { socket.destroy(); return; }
    connections.add(socket);
    const abort = new AbortController();
    socket.once("close", () => abort.abort(new Error("CODEX_NATIVE_IPC_DISCONNECTED")));
    socket.once("close", () => connections.delete(socket));
    // Keep an error listener after framing; a hook process may exit while the controller waits.
    socket.on("error", () => undefined);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once("close", () => clearTimeout(timer));
    const task = (async () => {
      try {
        const request = await readFrame(socket, timeoutMs);
        if (!["SubagentStop", "CollectorWait"].includes(request?.event) || request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("CODEX_NATIVE_IPC_REQUEST_INVALID");
        const value = request.event === "CollectorWait"
          ? await controller.waitCollector({ payload: request.payload, signal: abort.signal })
          : await controller.handleSubagentStop({ payload: request.payload, signal: abort.signal });
        if (!closed && !socket.destroyed && !abort.signal.aborted) socket.end(`${JSON.stringify(request.event === "CollectorWait" ? { result: value } : { decision: value })}\n`);
      } catch (error) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  try { await chmod(socketPath, 0o600); } catch (error) {
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
  return {
    socketPath,
    close: async () => {
      closed = true;
      for (const socket of connections) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...active]);
    },
  };
}

/** Used only when the isolated host explicitly passes its socket in the hook environment. */
export async function requestCodexNativeHookDecision({ socketPath, payload, timeoutMs = DEFAULT_TIMEOUT_MS, event = "SubagentStop" }) {
  requireTimeout(timeoutMs);
  await requirePrivateDirectory(socketPath);
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("CODEX_NATIVE_IPC_SOCKET_NOT_PRIVATE");
  const socket = createConnection(socketPath);
  const response = readFrame(socket, timeoutMs);
  try {
    const frame = `${JSON.stringify({ event, payload })}\n`;
    if (Buffer.byteLength(frame) > MAX_BYTES) throw new Error("CODEX_NATIVE_IPC_FRAME_TOO_LARGE");
    socket.write(frame);
    const answer = await response;
    if (typeof answer?.error === "string") throw new Error(answer.error);
    if (event === "CollectorWait") { if (answer?.result?.status !== "waited") throw new Error("CODEX_NATIVE_HELPER_RESPONSE_INVALID"); return answer.result; }
    if (!["allow", "block"].includes(answer?.decision?.decision) ||
        (answer.decision.decision === "block" && typeof answer.decision.reason !== "string")) throw new Error("CODEX_NATIVE_IPC_RESPONSE_INVALID");
    return answer.decision;
  } finally {
    socket.destroy();
    await response.catch(() => undefined);
  }
}

/** Explicit helper called by the SAME live collector outside SubagentStop. No enrollment. */
export async function waitCodexNativeCollector({ socketPath, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return requestCodexNativeHookDecision({ socketPath, payload, timeoutMs, event: "CollectorWait" });
}
