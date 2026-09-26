// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-477 R2, AC3 and STORY-474 R2, R3 (MIN-227 D5, D7): what the one Einzbern hook
// answers when a prompt is submitted. The stable launcher in the device directory
// (scripts/einzbern-hook-launcher.mjs, installed as engine/hook.mjs) has already matched the
// prompt's directory to a registered project without opening anything; this module is reached
// only then, through the current engine version's hook entry (scripts/einzbern-hook.mjs).
//
// The answer is recall's, read the way the recall verb reads it: the library replayed through
// this device's cache (nothing is written into the library), the project's crest cards beside it,
// every indexed record reduced by recallInputsFromState, the strong-hit threshold and the
// prompt's byte budget (injection.perPromptBytes) from the library's settings. What the host gets
// is the hit lines as additionalContext and nothing else: no header, no session ledger, no model
// call. A prompt without a strong hit gets no output at all (474 R3).
//
// The launcher's registry match is a fast subset of resolveLibrary that starts no git process
// (problem list #6). Before anything is read, resolveLibrary confirms from the same directory
// that the registry names the library the launcher matched and that the library still carries
// the recorded id; when it does not, the hook stays silent rather than answer from another
// project's library.

import { HOST_HOOK_EVENTS, HOST_HOOK_HOSTS } from "./host-hooks.js";
import type { HostHookHost } from "./host-hooks.js";
import { listKnowledgeMetadata } from "./knowledge-core.js";
import { expansionsText } from "./knowledge-language.js";
import { recall, recallDocuments } from "./recall.js";
import type { RecallKnowledgeInput } from "./recall.js";
import { recallContextLines, recallInputsFromState } from "./recall-inputs.js";
import { resolveLibrary } from "./registry.js";
import type { ResolvedLibrary } from "./registry.js";
import { SETTINGS_CATALOG } from "./settings.js";
import type { SettingKey } from "./settings.js";
import { materializeLibrary } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

export const HOOK_RECALL_REASON_CODES = Object.freeze(["HOOK_INPUT_INVALID"] as const);
export type HookRecallReasonCode = typeof HOOK_RECALL_REASON_CODES[number];

export class HookRecallError extends Error {
  readonly reasonCode: HookRecallReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: HookRecallReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "HookRecallError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: HookRecallReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new HookRecallError(reasonCode, message, details);
}

// The whole knowledge corpus is read before scoring, as the recall verb reads it, so bm25 keeps
// its statistics.
const KNOWLEDGE_CORPUS_LIMIT = 1_048_576;

/** The host event a launcher word names (user-prompt-submit → UserPromptSubmit), or null. */
export function hookEventName(word: unknown): string | null {
  if (typeof word !== "string") return null;
  return Object.keys(HOST_HOOK_EVENTS).find((event) => HOST_HOOK_EVENTS[event] === word) ?? null;
}

/**
 * The host running the hook. The command line names no host (477 R1), so it is read from the
 * environment: Claude Code gives every hook command it runs CLAUDE_PROJECT_DIR, and Codex is the
 * other host the hook is rendered for. Both read the same protocol (hookProtocolOutput), so the
 * answer never depends on this guess being right.
 */
export function hookHost(env: NodeJS.ProcessEnv = process.env): HostHookHost {
  const projectDirectory = env["CLAUDE_PROJECT_DIR"];
  return typeof projectDirectory === "string" && projectDirectory.length > 0 ? "claude-code" : "codex";
}

/**
 * The JSON a host reads from the hook's standard output for `event`: `lines` joined by newlines as
 * the hookSpecificOutput's additionalContext. Claude Code and Codex read one shape, the one the
 * retired prompt-injection hook wrote for both.
 */
export function hookProtocolOutput(host: HostHookHost, event: string, lines: readonly string[]): string {
  if (!HOST_HOOK_HOSTS.includes(host)) fail("HOOK_INPUT_INVALID", `host must be one of ${HOST_HOOK_HOSTS.join(", ")}`, { host: String(host) });
  if (!Object.hasOwn(HOST_HOOK_EVENTS, event)) fail("HOOK_INPUT_INVALID", `${String(event)} is not an event Einzbern hooks`, { event: String(event) });
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) fail("HOOK_INPUT_INVALID", "lines must be strings");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } });
}

export interface PromptRecallRequest {
  // The library the launcher matched: the registry entry's libraryPath, as the registry holds it.
  readonly libraryPath: string;
  readonly prompt: string;
  readonly host: HostHookHost;
  // The directory the prompt was submitted in; the registry must resolve it to libraryPath.
  readonly cwd: string;
  // The instant card freshness is judged at; now, to the second, when left out.
  readonly at?: string;
}

export interface PromptRecallAnswer {
  // The hit lines, in rank order, within the prompt's byte budget.
  readonly lines: readonly string[];
  // hookProtocolOutput(host, "UserPromptSubmit", lines): what the hook prints.
  readonly output: string;
}

function currentInstant(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

// A numeric setting as the library records it, or its catalog default when it is absent or a
// value this reader cannot use.
function numericSetting(state: WorkspaceState, key: SettingKey, usable: (value: number) => boolean): number {
  const recorded = Number(state.settings.find((entry) => entry.key === key)?.value);
  if (usable(recorded)) return recorded;
  const fallback = Number(SETTINGS_CATALOG.find((entry) => entry.key === key)?.defaultValue);
  if (!usable(fallback)) throw new Error(`the settings catalog has no usable default for ${key}`);
  return fallback;
}

// The project's crest cards, metadata only. A library whose crest cannot be read (not initialized,
// or refused) still has work records and minutes to recall.
async function crestCards(libraryPath: string, at: string): Promise<{ readonly cards: readonly RecallKnowledgeInput[]; readonly digest: string }> {
  try {
    const answer = await listKnowledgeMetadata(libraryPath, { at, allowTrailing: true, includeExplicitOnly: true, limit: KNOWLEDGE_CORPUS_LIMIT });
    const records = (answer["records"] ?? []) as readonly Readonly<Record<string, unknown>>[];
    return {
      cards: records.map((record) => ({
        id: String(record["id"] ?? ""),
        externalKey: String(record["externalKey"] ?? ""),
        subject: String(record["subject"] ?? ""),
        summary: String(record["summary"] ?? ""),
        snippet: String(record["snippet"] ?? ""),
        tags: ((record["tags"] ?? []) as readonly unknown[]).map((tag) => String(tag)),
        expansions: expansionsText(record["expansions"]),
      })),
      digest: String(answer["resultDigest"] ?? ""),
    };
  } catch (error) {
    if (typeof (error as { readonly reasonCode?: unknown }).reasonCode !== "string") throw error;
    return { cards: [], digest: "absent" };
  }
}

// The registry's own answer for the directory, when it names the library the launcher matched.
async function confirmedLibrary(cwd: string, libraryPath: string): Promise<ResolvedLibrary | null> {
  try {
    const resolved = await resolveLibrary(cwd);
    return resolved.entry.libraryPath === libraryPath ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The UserPromptSubmit answer for one prompt in a registered project: the hit lines recall gives
 * for it, cut to injection.perPromptBytes, and the host protocol JSON carrying them; null when the
 * prompt is empty, when the registry does not confirm the launcher's library from `cwd`, or when
 * recall has no line to give. Reads the library and its crest; writes only this device's cache.
 */
export async function promptRecallContext(request: PromptRecallRequest): Promise<PromptRecallAnswer | null> {
  if (!HOST_HOOK_HOSTS.includes(request.host)) fail("HOOK_INPUT_INVALID", `host must be one of ${HOST_HOOK_HOSTS.join(", ")}`, { host: String(request.host) });
  if (typeof request.libraryPath !== "string" || request.libraryPath.length === 0) fail("HOOK_INPUT_INVALID", "libraryPath must be a path");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) fail("HOOK_INPUT_INVALID", "cwd must be a path");
  const prompt = typeof request.prompt === "string" ? request.prompt.toWellFormed() : "";
  if (prompt.trim().length === 0) return null;
  const library = await confirmedLibrary(request.cwd, request.libraryPath);
  if (library === null) return null;
  const at = request.at ?? currentInstant();
  const state = await materializeLibrary(library.libraryPath);
  const { cards, digest } = await crestCards(library.libraryPath, at);
  const tau = numericSetting(state, "retrieval.tau", (value) => Number.isFinite(value) && value >= 0);
  const scopeExcerptBytes = numericSetting(state, "retrieval.scopeExcerptBytes", (value) => Number.isSafeInteger(value) && value > 0);
  const perPromptBytes = numericSetting(state, "injection.perPromptBytes", (value) => Number.isSafeInteger(value) && value > 0);
  const result = recall({
    // Its own index: the recall verb's documents are built another way and must not answer here.
    cacheKey: `prompt-hook:${state.metadata.workspaceId}`,
    checkpoint: `${state.headEventHash}:${digest}`,
    documents: () => recallDocuments(recallInputsFromState(state, cards, { scopeExcerptBytes })),
    query: prompt,
    tau,
  });
  const lines = recallContextLines(result.records, perPromptBytes);
  if (lines.length === 0) return null;
  return { lines, output: hookProtocolOutput(request.host, "UserPromptSubmit", lines) };
}
