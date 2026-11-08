// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeCodexPeerBatch } from "./codex-peer-batch.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { isCodexIndependentCreate, isCodexNativeSpawn } from "./native-tool-evidence.js";
import type { CodexPeerBatch } from "./codex-peer-batch.js";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { codexToolResult, runCodexQueryGuard } from "./codex-query-guard.js";
import { consumeCodexSettingsIntent, hasCodexSettingsOverride, observeCodexSettingsResult } from "./codex-peer-settings.js";

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
  readonly workerIds?: readonly string[];
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
const DELIVERY_REASON = "This coordinator's recorded batch is terminal, but no return attempt was observed. Load Mana Orchestrate and follow its Codex batch-delivery procedure. If the existing authorization covers delivery, send the batch result to the recorded main conversation and retain the receipt. A local final reply is not cross-conversation delivery. Report unavailable capability or permission instead of retrying blindly.";

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Consume structured tool results only. Never interpret a shell command or a transcript.

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
  const workerIds = receipt.records.flatMap(record => {
    const provider = object(record.providerId);
    return provider?.status === "observed" && text(provider.value) ? [provider.value] : [];
  });
  const handoffBound = await bindHandoff(receipt, device);
  for (const participant of [manifest.main.conversationId, manifest.coordinator.conversationId]) {
    const file = statePath(device, participant);
    const previous = await readTurn(`${file}.receipt`, participant, "pending");
    const same = previous?.manifestDigest === canonicalSha256(manifest) ? previous : null;
    const state: PeerTurn = {
      schemaVersion: "einzbern.codex-peer-hook.v1", sessionId: participant, turnId: "pending",
      manifestDigest: canonicalSha256(manifest), mainId: manifest.main.conversationId, coordinatorId: manifest.coordinator.conversationId,
      allTerminal: receipt.allTerminal, reportEligible: receipt.reportEligible, deliveryStatus: receipt.deliveryStatus,
      workerIds, handedOff: same?.handedOff === true || (participant === manifest.main.conversationId && handoffBound), deliveryAttempted: same?.deliveryAttempted ?? false, stopPrompted: same?.stopPrompted ?? false,
    };
    // A derived participant index is written by the validated receipt path for
    // both peers. It does not assert a native parent/child relationship.
    await saveTurn(`${file}.receipt`, state);
    await saveTurn(`${file}.pending`, state);
  }
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

/** Receipt/cache observations grant no dispatch or messaging authority. */
export async function runCodexPeerHook(event: string, payload: unknown, device: string): Promise<PeerHookResult> {
  const body = object(payload);
  const unchanged = { reasonCode: "HOOK_PEER_NOT_APPLICABLE", output: null };
  if (body === null || !text(body.session_id)) return unchanged;
  const tool = body.tool_name;
  if (event === "PostToolUse" && tool === SEND && hasCodexSettingsOverride(body.tool_input)) await observeCodexSettingsResult(device, body);
  const query = await runCodexQueryGuard(event, body, device);
  if (query.reasonCode !== "HOOK_PEER_NOT_APPLICABLE") return query;
  if (event === "PreToolUse" && tool === SEND && hasCodexSettingsOverride(body.tool_input)) {
    const role = await readCodexPeerRole(device, body.session_id);
    if (role.status === "error") return denyPeer("HOOK_PEER_ROLE_RECOVERY_FAILED", role.reason);
    const input = object(body.tool_input) ?? {};
    if (role.status === "active" && input.threadId === role.role.mainId && (input.hostId === undefined || input.hostId === "local")) {
      try {
        if (!await consumeCodexSettingsIntent(device, body)) return denyPeer("HOOK_PEER_SETTINGS_DENIED", "Ordinary reports omit model/thinking. Load Mana Orchestrate; prepare an explicitly authorized settings adjustment with its exact native arguments and existing Owner decision.");
      } catch (error) { return denyPeer("HOOK_PEER_SETTINGS_DENIED", String(error)); }
    }
  }
  if (event === "PreToolUse" && (isCodexIndependentCreate(tool) || isCodexNativeSpawn(tool))) {
    const role = await readCodexPeerRole(device, body.session_id);
    if (role.status === "error") return denyPeer("HOOK_PEER_ROLE_RECOVERY_FAILED", `Load Mana Orchestrate. ${role.reason}; recover the enrolled role before dependent dispatch.`);
    if (role.status === "active" && isCodexIndependentCreate(tool)) return denyPeer("HOOK_PEER_WORKER_TOOL_DENIED", "This enrolled Codex coordinator must load Mana Orchestrate and dispatch workers with collaboration.spawn_agent. Independent create_thread/fork_thread cannot be used as workers.");
  }
  if (!text(body.turn_id)) return unchanged;
  if (!["Stop", "UserPromptSubmit"].includes(event) && ![SEND, WAIT, READ, "Bash"].includes(String(tool))) return unchanged;
  const file = statePath(device, body.session_id);
  if (event === "UserPromptSubmit") {
    await rm(file, { force: true });
    return unchanged;
  }
  let state = await readTurn(file, body.session_id, body.turn_id);
  const retained = await readTurn(`${file}.receipt`, body.session_id, "pending");
  if (retained && state?.manifestDigest !== retained.manifestDigest) {
    state = { ...retained, turnId: body.turn_id };
    await saveTurn(file, state);
  }
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
    const result = codexToolResult(body.tool_response);
    if (tool !== SEND || result === null || !text(input.threadId) || result.threadId !== input.threadId) return unchanged;
    // Preserve a successful main-first send even when no receipt/role exists yet.
    // This is an unbound observation, never a fabricated batch or dispatch permit.
    if (!text(body.agent_id)) await observeHandoff(device, body.session_id, input, result);
    if (state === null) return { reasonCode: "HOOK_PEER_HANDOFF_OBSERVED", output: null };
    if (body.session_id === state.mainId && input.threadId === state.coordinatorId) {
      return { reasonCode: "HOOK_PEER_HANDOFF_OBSERVED", output: null };
    }
    return unchanged;
  }

  if (state === null) return unchanged;
  if (event === "PreToolUse") {
    if (tool === SEND && !hasCodexSettingsOverride(input) && body.session_id === state.coordinatorId && input.threadId === state.mainId) {
      // An attempted send with no result is unknown, never an invitation to resend.
      state.deliveryAttempted = true;
      await saveTurn(file, state);
      await saveTurn(`${file}.receipt`, { ...state, turnId: "pending" });
      return { reasonCode: "HOOK_PEER_DELIVERY_ATTEMPTED", output: null };
    }
    return unchanged;
  }

  if (event === "Stop" && body.session_id === state.coordinatorId && state.reportEligible && state.allTerminal &&
      state.deliveryStatus === "not-attempted" && !state.deliveryAttempted && !state.stopPrompted && body.stop_hook_active === false) {
    state.stopPrompted = true;
    await saveTurn(file, state);
    await saveTurn(`${file}.receipt`, { ...state, turnId: "pending" });
    return { reasonCode: "HOOK_PEER_DELIVERY_REMINDER", output: JSON.stringify({ decision: "block", reason: DELIVERY_REASON }) + "\n" };
  }
  return unchanged;
}

function handoffPath(device: string, sourceId: string, targetId: string, hostId: string): string {
  return join(device, "codex-peer-handoffs", canonicalSha256({ sourceId, targetId, hostId }) + ".json");
}
async function handoffState(file: string, sourceId: string, targetId: string, hostId: string): Promise<ObjectValue> {
  try {
    const row = object(JSON.parse(await readFile(file, "utf8")));
    if (!row) throw new Error("invalid handoff state");
    const { digest, ...payload } = row;
    if (digest !== canonicalSha256(payload) || row.schemaVersion !== "einzbern.codex-handoff-observation.v1" || row.sourceId !== sourceId || row.targetId !== targetId || row.hostId !== hostId || !object(row.bindings)) throw new Error("known handoff observation cannot be recovered");
    return payload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: "einzbern.codex-handoff-observation.v1", sourceId, targetId, hostId, latest: null, bindings: {} };
  }
}
async function observeHandoff(device: string, sessionId: string, input: ObjectValue, result: ObjectValue): Promise<void> {
  if (!text(input.threadId)) return;
  const hostId = String(input.hostId ?? "local");
  const file = handoffPath(device, sessionId, input.threadId, hostId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(`${file}.lock`, async () => {
    const prior = await handoffState(file, sessionId, String(input.threadId), hostId);
    const payload = { ...prior, latest: { observedAt: new Date().toISOString(), inputDigest: canonicalSha256(input), resultDigest: canonicalSha256(result), manifestDigest: null } };
    await writeFileAtomic(file, JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
  }, { command: "einzbern handoff observation" });
}
async function bindHandoff(receipt: CodexPeerBatch, device: string): Promise<boolean> {
  const manifest = receipt.manifest;
  const file = handoffPath(device, manifest.main.conversationId, manifest.coordinator.conversationId, "local");
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return withFileLock(`${file}.lock`, async () => {
    const state = await handoffState(file, manifest.main.conversationId, manifest.coordinator.conversationId, "local");
    const digest = canonicalSha256(manifest);
    const bindings = object(state.bindings)!;
    if (object(bindings[digest])) return true;
    const latest = object(state.latest);
    if (!latest || latest.manifestDigest !== null || !text(latest.observedAt) || receipt.records.length === 0 || receipt.records.some(record => parseStrictInstant(record.preparation.attempt!.requestedAt) <= parseStrictInstant(String(latest.observedAt)))) return false;
    // Identity, native order and exclusive consumption associate observed facts.
    // They do not authenticate the message's natural-language handoff intent.
    const bound = { ...latest, manifestDigest: digest, batchId: manifest.batchId, attemptId: manifest.attemptId };
    const payload = { ...state, latest: bound, bindings: { ...bindings, [digest]: bound } };
    await writeFileAtomic(file, JSON.stringify({ ...payload, digest: canonicalSha256(payload) }) + "\n");
    return true;
  }, { command: "einzbern handoff association" });
}

export interface CodexPeerRole {
  readonly schemaVersion: "einzbern.codex-peer-role.v1";
  readonly host: "codex";
  readonly coordinatorId: string;
  readonly mainId: string;
  readonly libraryId: string;
  readonly status: "active" | "retired";
  readonly actor: string;
  readonly recordedAt: string;
  readonly decidedIn: string | null;
  readonly previousDigest: string | null;
  readonly receipt: CodexPeerBatch;
  readonly digest: string;
}
export type CodexPeerRoleRead =
  | { readonly status: "unbound" }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "active" | "retired"; readonly role: CodexPeerRole };

export function codexPeerRoleDirectory(device: string, sessionId: string): string {
  return join(device, "codex-peer-roles", createHash("sha256").update(sessionId).digest("hex"));
}

/** A directory/anchor is enrollment knowledge even if its fallible payload is gone. */
export async function readCodexPeerRole(device: string, sessionId: string): Promise<CodexPeerRoleRead> {
  const directory = codexPeerRoleDirectory(device, sessionId);
  try { await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unbound" };
    return { status: "error", reason: `role directory: ${String(error)}` };
  }
  try {
    const anchor = object(JSON.parse(await readFile(join(directory, "anchor.json"), "utf8")));
    if (anchor?.schemaVersion !== "einzbern.codex-peer-enrollment.v1" || anchor.coordinatorId !== sessionId || !["active", "retired"].includes(String(anchor.status))) throw new Error("invalid enrollment anchor");
    const value = object(JSON.parse(await readFile(join(directory, "role.json"), "utf8")));
    if (value === null) throw new Error("missing role payload");
    const { digest, ...payload } = value;
    if (digest !== canonicalSha256(payload) || value.schemaVersion !== "einzbern.codex-peer-role.v1" ||
        value.host !== "codex" || value.coordinatorId !== sessionId || !["active", "retired"].includes(String(value.status)) ||
        value.libraryId !== anchor.libraryId || value.mainId !== anchor.mainId || value.status !== anchor.status || !text(value.actor) || !text(value.recordedAt)) throw new Error("invalid role identity, version or digest");
    const receipt = normalizeCodexPeerBatch(value.receipt);
    if (receipt.schemaVersion !== "tcrn.codex-peer-batch.v2" || receipt.manifest.coordinator.conversationId !== sessionId ||
        receipt.manifest.main.conversationId !== value.mainId) throw new Error("role differs from validated peer receipt");
    if (value.status === "retired" && !text(value.decidedIn)) throw new Error("retired role has no lifecycle decision");
    return { status: value.status as "active" | "retired", role: value as unknown as CodexPeerRole };
  } catch (error) {
    return { status: "error", reason: `known coordinator role cannot be recovered: ${String(error)}` };
  }
}

/** Existing peer-record is the only enrollment/lifecycle writer. Authorization is resolved
 * against live minutes by its CLI, never taken from a self-declared tool argument. */
export async function persistCodexPeerRole(input: {
  readonly receipt: CodexPeerBatch;
  readonly device: string;
  readonly sessionId: string | undefined;
  readonly libraryId: string;
  readonly actor: string;
  readonly change?: { readonly operation: "retire" | "activate" | "recover"; readonly decidedIn: string | null };
}): Promise<CodexPeerRole> {
  const receipt = normalizeCodexPeerBatch(input.receipt);
  const manifest = receipt.manifest;
  if (receipt.schemaVersion !== "tcrn.codex-peer-batch.v2") throw new Error("legacy peer receipt is historical, not role enrollment");
  if (!input.sessionId || ![manifest.main.conversationId, manifest.coordinator.conversationId].includes(input.sessionId)) throw new Error("role enrollment requires the actual native main/coordinator session");
  if (receipt.records.length !== manifest.members.length || receipt.blockedReasons.some(reason => reason === "work-revisions-unknown" || reason === "policy-drift" || reason === "model-groups-not-ready" || reason.startsWith("work-revision-drift:"))) throw new Error("role enrollment needs the current complete set of scoped pending worker preparations and matching work/policy");
  const directory = codexPeerRoleDirectory(input.device, manifest.coordinator.conversationId);
  let existed = true;
  try { await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existed = false; else throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, "write.lock"), async () => {
    const prior = await readCodexPeerRole(input.device, manifest.coordinator.conversationId);
    const anchorFile = join(directory, "anchor.json");
    let anchor: ObjectValue | null = null;
    try { anchor = object(JSON.parse(await readFile(anchorFile, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (anchor !== null && (anchor.coordinatorId !== manifest.coordinator.conversationId || anchor.mainId !== manifest.main.conversationId || anchor.libraryId !== input.libraryId)) throw new Error("enrolled peer identity/library changed; retire it through the governed lifecycle first");
    if (prior.status === "error" && (anchor !== null || existed) && !input.change) throw new Error(prior.reason);
    if ((prior.status === "retired" || anchor?.status === "retired") && input.change?.operation !== "activate") throw new Error("retired role needs an explicit governed activation");
    if (input.change && input.change.operation !== "recover" && !input.change.decidedIn) throw new Error("role lifecycle requires a verified Owner decision");
    if (input.change?.operation === "recover" && prior.status === "retired") throw new Error("recovery cannot activate a retired role");
    if (input.change?.operation === "retire" && prior.status !== "active") throw new Error("only a recovered active role can retire");
    const payload = {
      schemaVersion: "einzbern.codex-peer-role.v1" as const, host: "codex" as const,
      coordinatorId: manifest.coordinator.conversationId, mainId: manifest.main.conversationId, libraryId: input.libraryId,
      status: input.change?.operation === "retire" ? "retired" as const : "active" as const,
      actor: input.actor, recordedAt: new Date().toISOString(), decidedIn: input.change?.decidedIn ?? null,
      previousDigest: prior.status === "active" || prior.status === "retired" ? prior.role.digest : null, receipt,
    };
    if (prior.status === "active" || prior.status === "retired") {
      await mkdir(join(directory, "history"), { recursive: true, mode: 0o700 });
      await writeFileAtomic(join(directory, "history", `${prior.role.digest}.json`), JSON.stringify(prior.role) + "\n");
    }
    // The anchor goes first: interrupted writes must leave a known failed enrollment.
    await writeFileAtomic(anchorFile, JSON.stringify({ schemaVersion: "einzbern.codex-peer-enrollment.v1", coordinatorId: payload.coordinatorId, mainId: payload.mainId, libraryId: payload.libraryId, status: payload.status }) + "\n");
    const role: CodexPeerRole = { ...payload, digest: canonicalSha256(payload) };
    await writeFileAtomic(join(directory, "role.json"), JSON.stringify(role) + "\n");
    const recovered = await readCodexPeerRole(input.device, manifest.coordinator.conversationId);
    if ((recovered.status !== "active" && recovered.status !== "retired") || recovered.role.digest !== role.digest) throw new Error("role persistence readback failed");
    return recovered.role;
  }, { command: "einzbern execution-codex-peer-record" });
}

export async function inspectCodexPeerRoles(device: string): Promise<{ readonly ready: boolean; readonly roles: readonly { readonly key: string; readonly status: string; readonly reason: string | null }[] }> {
  let entries;
  try { entries = await readdir(join(device, "codex-peer-roles"), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ready: true, roles: [] };
    return { ready: false, roles: [{ key: "enrollments", status: "error", reason: String(error) }] };
  }
  const roles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const anchor = object(JSON.parse(await readFile(join(device, "codex-peer-roles", entry.name, "anchor.json"), "utf8")));
      if (!text(anchor?.coordinatorId) || codexPeerRoleDirectory(device, anchor.coordinatorId) !== join(device, "codex-peer-roles", entry.name)) throw new Error("enrollment anchor identity mismatch");
      const read = await readCodexPeerRole(device, anchor.coordinatorId);
      roles.push({ key: entry.name, status: read.status, reason: read.status === "error" ? read.reason : null });
    } catch (error) { roles.push({ key: entry.name, status: "error", reason: String(error) }); }
  }
  return { ready: roles.every(role => role.status === "active" || role.status === "retired"), roles };
}

function denyPeer(reasonCode: string, reason: string): PeerHookResult {
  return { reasonCode, output: JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n" };
}
