// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { HostExecutionError } from "./host-capabilities.js";
import { minutesById, parseDecisionAddress } from "./minutes.js";
import { decisionNamesTarget, verifyWriteAuthorization } from "./write-authorization.js";
import { codexToolResult } from "./codex-query-guard.js";
import { materializeWorkspaceFromGenesis } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

const SEND = "mcp__codex_app__send_message_to_thread";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function hasCodexSettingsOverride(value: unknown): boolean {
  const args = object(value);
  return args !== null && ["model", "thinking"].some(key => Object.hasOwn(args, key));
}

/** Source correlation under the existing local trust model, not authentication or
 * a machine judgment of the decision's natural-language authorization scope. */
export async function verifyCodexSettingsIntent(state: WorkspaceState, value: unknown, argumentsValue: unknown, device: string): Promise<void> {
  const intent = object(value);
  const args = object(argumentsValue);
  if (!intent || Object.keys(intent).some(key => !["decidedIn", "basis", "targetSource", "reconciliation"].includes(key)) || !text(intent.decidedIn) || !text(intent.basis) || !text(args?.threadId) || !hasCodexSettingsOverride(args)) throw new HostExecutionError("settings adjustment needs an explicit decision source, scope basis and exact native arguments");
  if (parseDecisionAddress(intent.decidedIn) === null) throw new HostExecutionError("settings decision must name minutes:<id>#D<n>");
  const entry = minutesById(state, intent.decidedIn, "all");
  const decision = entry.decisions[0];
  if (!entry.decidedBy.includes("owner:governance") || !decision || decision.status !== "valid") throw new HostExecutionError("settings decision is missing, obsolete or not Owner-decided");
  if (decisionNamesTarget(decision.text, args.threadId)) {
    await verifyWriteAuthorization({ state, decidedIn: intent.decidedIn, target: args.threadId, home: device });
    return;
  }
  // Existing class authorization can cover temporary native test targets that did
  // not exist when the Owner decided. Preserve their actual creation return.
  const source = object(intent.targetSource);
  const created = codexToolResult(source?.response);
  const nativeCreation = ["mcp__codex_app__create_thread", "mcp__codex_app__fork_thread"].includes(String(source?.toolName));
  if (!source || Object.keys(source).some(key => !["toolName", "response"].includes(key)) || !nativeCreation || created?.threadId !== args.threadId || String(created.hostId ?? "local") !== String(args.hostId ?? "local")) throw new HostExecutionError("an unnamed temporary settings target needs its matching native create/fork return and the caller's scope assessment");
}
function directory(device: string, sessionId: string): string {
  return join(device, "codex-peer-settings", createHash("sha256").update(sessionId).digest("hex"));
}
export async function stageCodexSettingsIntent(input: { readonly device: string; readonly sessionId: string; readonly workspaceRoot: string; readonly attemptId: string; readonly argumentsValue: unknown; readonly intent: unknown }): Promise<void> {
  const dir = directory(input.device, input.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = { schemaVersion: "einzbern.codex-peer-settings.v1", sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, attemptId: input.attemptId, argumentsValue: input.argumentsValue, argumentsDigest: canonicalSha256(input.argumentsValue), intent: input.intent, preparedAt: new Date().toISOString(), attempted: false, outcome: "not-attempted" };
  await withFileLock(join(dir, "write.lock"), async () => {
    let prior: ObjectValue | null = null;
    try { prior = object(JSON.parse(await readFile(join(dir, "intent.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior) {
      const { digest, ...previous } = prior;
      if (digest !== canonicalSha256(previous)) throw new HostExecutionError("known settings attempt cannot be recovered");
      if (prior.attempted === true && prior.outcome !== "completed") {
        const reconciliation = object(object(input.intent)?.reconciliation);
        const readback = object(codexToolResult(reconciliation?.response)?.thread);
        const args = object(prior.argumentsValue);
        if (reconciliation?.attemptId !== prior.attemptId || reconciliation?.toolName !== "thread/read" || !args || readback?.id !== args.threadId || (Object.hasOwn(args, "model") && readback?.model !== args.model) || (Object.hasOwn(args, "thinking") && readback?.reasoningEffort !== args.thinking)) throw new HostExecutionError("previous settings outcome is unknown; retain its attempt and reconcile actual target settings through public thread/read before another adjustment");
      }
    }
    await writeFileAtomic(join(dir, "intent.json"), JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
  }, { command: "einzbern settings intent" });
}
export async function observeCodexSettingsResult(device: string, body: ObjectValue): Promise<void> {
  if (body.tool_name !== SEND || typeof body.session_id !== "string") return;
  const dir = directory(device, body.session_id);
  let exists = true;
  try { await readFile(join(dir, "intent.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (!exists) return;
  await withFileLock(join(dir, "write.lock"), async () => {
    const row = object(JSON.parse(await readFile(join(dir, "intent.json"), "utf8")));
    if (!row || row.attempted !== true || row.argumentsDigest !== canonicalSha256(body.tool_input)) return;
    const { digest, ...payload } = row;
    if (digest !== canonicalSha256(payload)) throw new HostExecutionError("known settings attempt cannot be recovered");
    const result = codexToolResult(body.tool_response);
    const next = { ...payload, outcome: result?.threadId === object(body.tool_input)?.threadId ? "completed" : "unknown", resultDigest: canonicalSha256(body.tool_response ?? null) };
    await writeFileAtomic(join(dir, "intent.json"), JSON.stringify({ ...next, digest: canonicalSha256(next) }) + "\n");
  }, { command: "einzbern settings result" });
}
export async function consumeCodexSettingsIntent(device: string, body: ObjectValue): Promise<boolean> {
  if (body.tool_name !== SEND || typeof body.session_id !== "string") return false;
  const dir = directory(device, body.session_id);
  try { await readFile(join(dir, "intent.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return withFileLock(join(dir, "write.lock"), async () => {
    const row = object(JSON.parse(await readFile(join(dir, "intent.json"), "utf8")));
    if (!row) return false;
    const { digest, ...payload } = row;
    if (digest !== canonicalSha256(payload) || row.schemaVersion !== "einzbern.codex-peer-settings.v1" || row.sessionId !== body.session_id || row.attempted !== false || row.argumentsDigest !== canonicalSha256(body.tool_input) || !text(row.workspaceRoot) || !text(row.preparedAt)) return false;
    const age = parseStrictInstant(new Date().toISOString()) - parseStrictInstant(row.preparedAt);
    if (age < 0n || age > 300_000_000_000n) return false;
    await verifyCodexSettingsIntent(await materializeWorkspaceFromGenesis(row.workspaceRoot), row.intent, body.tool_input, device);
    const next = { ...payload, attempted: true };
    await writeFileAtomic(join(dir, "intent.json"), JSON.stringify({ ...next, digest: canonicalSha256(next) }) + "\n");
    // This ends one native attempt; preparing another within the same existing
    // authorization remains possible after reconciling its actual result.
    return true;
  }, { command: "einzbern settings attempt" });
}
