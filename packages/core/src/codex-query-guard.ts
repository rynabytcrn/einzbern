// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { isCodexNativeSpawn } from "./native-tool-evidence.js";

type ObjectValue = Record<string, unknown>;
const READ = "mcp__codex_app__read_thread";
const WAIT = "mcp__codex_app__wait_threads";
const reason = "This query returned, or another query is still outstanding. End this waiting loop. Only a confirmed native subagent whose returned turn is still in progress permits another bounded query. A new UserPromptSubmit can start a new query; changing tools, targets, cursors or turns cannot restart this loop. Load Mana Orchestrate.";
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Parse the actual structured result, never JavaScript, shell text or a transcript. */
export function codexToolResult(value: unknown): ObjectValue | null {
  const result = object(value);
  if (result === null || result.isError === true || (typeof result.exit_code === "number" && result.exit_code !== 0)) return null;
  let output = result.stdout ?? result.output;
  if (Array.isArray(result.content)) {
    const parts = result.content.filter(part => object(part)?.type === "text");
    if (parts.length !== 1) return null;
    output = object(parts[0])?.text;
  }
  if (typeof output === "string") {
    try { return object(JSON.parse(output)); } catch { return null; }
  }
  return result;
}

interface QueryState {
  readonly schemaVersion: "einzbern.codex-query-guard.v1";
  readonly sessionId: string;
  readonly agentId: string | null;
  promptDigest: string | null;
  blocked: boolean;
  pending: { readonly key: string; readonly turnId: string | null } | null;
}
function actor(body: ObjectValue): { sessionId: string; agentId: string | null } {
  return { sessionId: String(body.session_id), agentId: text(body.agent_id) ? body.agent_id : null };
}
function directory(device: string, owner: ReturnType<typeof actor>): string {
  return join(device, "codex-query-guards", hash(JSON.stringify(owner)));
}
async function readState(file: string, owner: ReturnType<typeof actor>): Promise<QueryState> {
  let row: ObjectValue | null;
  try { row = object(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "einzbern.codex-query-guard.v1", ...owner, promptDigest: null, blocked: false, pending: null };
    throw error;
  }
  const pending = object(row?.pending);
  const validPending = row?.pending === null || (text(pending?.key) && (pending?.turnId === null || text(pending?.turnId)));
  if (row?.schemaVersion !== "einzbern.codex-query-guard.v1" || row.sessionId !== owner.sessionId ||
      row.agentId !== owner.agentId || typeof row.blocked !== "boolean" ||
      (row.promptDigest !== null && !text(row.promptDigest)) || !validPending) {
    throw new Error("known query guard cannot be recovered");
  }
  return row as unknown as QueryState;
}
async function saveState(file: string, state: QueryState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state) + "\n");
}
function queryKey(body: ObjectValue): string {
  return canonicalSha256({ tool: body.tool_name, input: body.tool_input ?? null, toolUseId: body.tool_use_id ?? null });
}
interface Target { readonly threadId: string; readonly hostId: string }
function targets(tool: unknown, input: ObjectValue): Target[] {
  const rows = tool === READ ? [input] : tool === WAIT && Array.isArray(input.targets) ? input.targets : [];
  const parsed = rows.map(object);
  if (parsed.length === 0 || parsed.some(row => !text(row?.threadId) || (row?.hostId !== undefined && !text(row.hostId)))) return [];
  return parsed.map(row => ({ threadId: String(row!.threadId), hostId: String(row!.hostId ?? "local") }));
}
async function observeChild(device: string, owner: ReturnType<typeof actor>, childId: string, source: unknown): Promise<void> {
  const dir = join(directory(device, owner), "children");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = { schemaVersion: "einzbern.codex-native-child.v1", ...owner, childId, sourceDigest: canonicalSha256(source) };
  await writeFileAtomic(join(dir, hash(childId) + ".json"), JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
}
async function nativeChild(device: string, owner: ReturnType<typeof actor>, target: Target): Promise<boolean> {
  if (target.hostId !== "local") return false;
  try {
    const value = object(JSON.parse(await readFile(join(directory(device, owner), "children", hash(target.threadId) + ".json"), "utf8")));
    if (!value) return false;
    const { digest, ...payload } = value;
    if (digest !== canonicalSha256(payload) || value.schemaVersion !== "einzbern.codex-native-child.v1" || value.sessionId !== owner.sessionId || value.agentId !== owner.agentId || value.childId !== target.threadId) throw new Error("native child observation cannot be recovered");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function inProgress(tool: unknown, result: ObjectValue | null, target: Target): boolean {
  if (!result) return false;
  if (tool === READ) {
    const thread = object(result.thread);
    const turns = result.turns;
    return thread?.id === target.threadId && String(thread.hostId ?? "local") === target.hostId && Array.isArray(turns) && object(turns[0])?.status === "inProgress" && object(result.page)?.order !== "oldest_first";
  }
  if (!Array.isArray(result.polls)) return false;
  const matches = result.polls.map(object).filter(row => object(row?.thread)?.id === target.threadId && String(object(row?.thread)?.hostId ?? "local") === target.hostId);
  return matches.length === 1 && object(matches[0]?.latestTurn)?.status === "inProgress";
}

export async function runCodexQueryGuard(event: string, body: ObjectValue, device: string): Promise<{ reasonCode: string; output: string | null }> {
  const unchanged = { reasonCode: "HOOK_PEER_NOT_APPLICABLE", output: null };
  if (!text(body.session_id)) return unchanged;
  if (event === "SubagentStart" && text(body.agent_id)) {
    // The supported event names the parent session and the native subagent id.
    await observeChild(device, { sessionId: body.session_id, agentId: null }, body.agent_id, body);
    return { reasonCode: "HOOK_QUERY_NATIVE_CHILD_OBSERVED", output: null };
  }
  const owner = actor(body);
  if (event === "PostToolUse" && isCodexNativeSpawn(body.tool_name)) {
    const result = codexToolResult(body.tool_response);
    const childId = result?.agent_id ?? result?.task_name;
    if (text(childId)) await observeChild(device, owner, childId, { tool: body.tool_name, result });
    return unchanged;
  }
  const query = body.tool_name === READ || body.tool_name === WAIT;
  if (event !== "UserPromptSubmit" && !query) return unchanged;
  const dir = directory(device, owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(join(dir, "write.lock"), async () => {
    const file = join(dir, "state.json");
    let state: QueryState;
    try { state = await readState(file, owner); }
    catch (error) {
      if (event === "PreToolUse") return { reasonCode: "HOOK_QUERY_RECOVERY_FAILED", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(error) } }) + "\n" };
      throw error;
    }
    if (event === "UserPromptSubmit") {
      // Reset from the supported prompt event, never from a changed model turn or
      // summary. Identical text can still be a new actual user request.
      if (text(body.prompt)) {
        state = { ...state, promptDigest: canonicalSha256({ turnId: body.turn_id ?? null, prompt: body.prompt }), blocked: false, pending: null };
        await saveState(file, state);
      }
      return unchanged;
    }
    if (event === "PreToolUse") {
      if (state.blocked || state.pending !== null) return { reasonCode: "HOOK_QUERY_LOOP_DENIED", output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n" };
      state.pending = { key: queryKey(body), turnId: text(body.turn_id) ? body.turn_id : null };
      await saveState(file, state);
      return { reasonCode: "HOOK_QUERY_STARTED", output: null };
    }
    if (event !== "PostToolUse" || state.pending?.key !== queryKey(body) || state.pending.turnId !== (text(body.turn_id) ? body.turn_id : null)) return unchanged;
    const queried = targets(body.tool_name, object(body.tool_input) ?? {});
    const result = codexToolResult(body.tool_response);
    const continuable = queried.length > 0 && (await Promise.all(queried.map(async target => await nativeChild(device, owner, target) && inProgress(body.tool_name, result, target)))).every(Boolean);
    state.pending = null;
    state.blocked = !continuable;
    await saveState(file, state);
    return { reasonCode: continuable ? "HOOK_QUERY_CHILD_IN_PROGRESS" : "HOOK_QUERY_LOOP_ENDED", output: continuable ? null : JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reason } }) + "\n" };
  }, { command: "einzbern codex query guard" });
}
