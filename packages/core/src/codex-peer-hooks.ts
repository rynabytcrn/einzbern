// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodexPeerBatch } from "./codex-peer-batch.js";
import { canonicalSha256 } from "../../protocol/src/index.js";

type ObjectValue = Record<string, unknown>;
interface PeerTurn {
  readonly schemaVersion: "einzbern.codex-peer-hook.v1";
  readonly sessionId: string;
  readonly turnId: string;
  readonly manifestDigest: string;
  readonly mainId: string;
  readonly coordinatorId: string;
  readonly allTerminal: boolean;
  readonly reportEligible: boolean;
  readonly deliveryStatus: string;
  handedOff: boolean;
  deliveryAttempted: boolean;
  stopPrompted: boolean;
}

export interface PeerHookResult {
  readonly reasonCode: string;
  readonly output: string | null;
}

const SEND = "mcp__codex_app__send_message_to_thread";
const WAIT = "mcp__codex_app__wait_threads";
const READ = "mcp__codex_app__read_thread";
const POLL_REASON = "This main conversation already handed this batch to its independent coordinator in this turn. Load Mana Orchestrate and follow its Codex handoff procedure; do not poll the coordinator to keep this turn alive.";
const DELIVERY_REASON = "This coordinator's recorded batch is terminal, but no return attempt was observed. Load Mana Orchestrate and follow its Codex batch-delivery procedure. If the existing authorization covers delivery, send the batch result to the recorded main conversation and retain the receipt. A local final reply is not cross-conversation delivery. Report unavailable capability or permission instead of retrying blindly.";

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Consume structured tool results only. Never interpret a shell command or a transcript.
function resultObject(value: unknown): ObjectValue | null {
  const result = object(value);
  if (result === null || result.isError === true) return null;
  if (typeof result.exit_code === "number" && result.exit_code !== 0) return null;
  let output = result.stdout ?? result.output;
  if (Array.isArray(result.content)) {
    const parts = result.content.filter(part => object(part)?.type === "text");
    if (parts.length !== 1) return null;
    output = object(parts[0])?.text;
  }
  if (typeof output === "string") {
    try { return object(JSON.parse(output)); }
    catch { return null; }
  }
  return result;
}

function statePath(device: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(device, "cache", "codex-peer-hooks", `${key}.json`);
}

async function readTurn(file: string, sessionId: string, turnId: string): Promise<PeerTurn | null> {
  let value: ObjectValue | null;
  try { value = object(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (value?.schemaVersion !== "einzbern.codex-peer-hook.v1" || value.sessionId !== sessionId || value.turnId !== turnId) return null;
  if (!["manifestDigest", "mainId", "coordinatorId", "deliveryStatus"].every(key => text(value[key]))) return null;
  if (!["allTerminal", "reportEligible", "handedOff", "deliveryAttempted", "stopPrompted"].every(key => typeof value[key] === "boolean")) return null;
  return value as unknown as PeerTurn;
}

async function saveTurn(file: string, state: PeerTurn): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

/** Called only after the engine has validated and retained a native peer receipt. */
export async function stageCodexPeerReceipt(receipt: CodexPeerBatch, device: string, sessionId: string | undefined): Promise<void> {
  const manifest = receipt.manifest;
  if (!sessionId || ![manifest.main.conversationId, manifest.coordinator.conversationId].includes(sessionId)) return;
  await saveTurn(`${statePath(device, sessionId)}.pending`, {
    schemaVersion: "einzbern.codex-peer-hook.v1", sessionId, turnId: "pending",
    manifestDigest: canonicalSha256(manifest), mainId: manifest.main.conversationId, coordinatorId: manifest.coordinator.conversationId,
    allTerminal: receipt.allTerminal, reportEligible: receipt.reportEligible, deliveryStatus: receipt.deliveryStatus,
    handedOff: false, deliveryAttempted: false, stopPrompted: false,
  });
}

async function takeReceipt(file: string, sessionId: string): Promise<PeerTurn | null> {
  const claimed = `${file}.${randomUUID()}.claimed`;
  try { await rename(`${file}.pending`, claimed); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try { return await readTurn(claimed, sessionId, "pending"); }
  finally { await rm(claimed, { force: true }); }
}

function targetsCoordinator(tool: unknown, input: ObjectValue, coordinatorId: string): boolean {
  if (tool === READ) return input.threadId === coordinatorId && (input.hostId === undefined || input.hostId === "local");
  if (tool !== WAIT || !Array.isArray(input.targets)) return false;
  return input.targets.some(target => {
    const row = object(target);
    return row?.threadId === coordinatorId && (row.hostId === undefined || row.hostId === "local");
  });
}

/** A small, disposable observation cache; it grants no dispatch or messaging authority. */
export async function runCodexPeerHook(event: string, payload: unknown, device: string): Promise<PeerHookResult> {
  const body = object(payload);
  const unchanged = { reasonCode: "HOOK_PEER_NOT_APPLICABLE", output: null };
  if (body === null || !text(body.session_id) || !text(body.turn_id)) return unchanged;
  const tool = body.tool_name;
  if (!["Stop", "UserPromptSubmit"].includes(event) && ![SEND, WAIT, READ, "Bash"].includes(String(tool))) return unchanged;
  const file = statePath(device, body.session_id);
  if (event === "UserPromptSubmit") {
    await rm(`${file}.pending`, { force: true });
    await rm(file, { force: true });
    return unchanged;
  }
  let state = await readTurn(file, body.session_id, body.turn_id);
  const input = object(body.tool_input) ?? {};

  if (event === "PostToolUse") {
    const receipt = tool === "Bash" ? await takeReceipt(file, body.session_id) : null;
    if (receipt !== null) {
      const previous = state?.manifestDigest === receipt.manifestDigest ? state : null;
      state = {
        ...receipt, turnId: body.turn_id,
        handedOff: previous?.handedOff === true, deliveryAttempted: previous?.deliveryAttempted === true,
        stopPrompted: previous?.stopPrompted === true,
      };
      await saveTurn(file, state);
      return { reasonCode: "HOOK_PEER_RECEIPT_OBSERVED", output: null };
    }
    const result = resultObject(body.tool_response);
    if (state === null || tool !== SEND || result?.threadId !== input.threadId) return unchanged;
    if (body.session_id === state.mainId && input.threadId === state.coordinatorId) {
      state.handedOff = true;
      await saveTurn(file, state);
      return { reasonCode: "HOOK_PEER_HANDOFF_OBSERVED", output: null };
    }
    return unchanged;
  }

  if (state === null) return unchanged;
  if (event === "PreToolUse") {
    if (tool === SEND && body.session_id === state.coordinatorId && input.threadId === state.mainId) {
      // An attempted send with no result is unknown, never an invitation to resend.
      state.deliveryAttempted = true;
      await saveTurn(file, state);
      return { reasonCode: "HOOK_PEER_DELIVERY_ATTEMPTED", output: null };
    }
    if (body.session_id === state.mainId && state.handedOff && !state.allTerminal && targetsCoordinator(tool, input, state.coordinatorId)) {
      return { reasonCode: "HOOK_PEER_IDLE_POLL_DENIED", output: JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: POLL_REASON,
      } }) + "\n" };
    }
    return unchanged;
  }

  if (event === "Stop" && body.session_id === state.coordinatorId && state.reportEligible && state.allTerminal &&
      state.deliveryStatus === "not-attempted" && !state.deliveryAttempted && !state.stopPrompted && body.stop_hook_active === false) {
    state.stopPrompted = true;
    await saveTurn(file, state);
    return { reasonCode: "HOOK_PEER_DELIVERY_REMINDER", output: JSON.stringify({ decision: "block", reason: DELIVERY_REASON }) + "\n" };
  }
  return unchanged;
}
