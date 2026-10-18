import { effectiveProjectState } from "./project-chain.js";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-477 R2, AC3 and STORY-474 R2, R3 (MIN-227 D5, D7): what the one Einzbern hook
// answers when a prompt is submitted. The stable launcher in the device directory
// (scripts/einzbern-hook-launcher.mjs, installed as engine/hook.mjs) has already matched the
// prompt's directory to a registered project without opening anything; this module is reached
// only then, through the current engine version's hook entry (scripts/einzbern-hook.mjs).
//
// The answer is recall's, read the way the recall verb reads it: the library replayed through
// this device's cache (nothing is written into the library), the project's and user's crest cards
// beside it,
// every indexed record reduced by recallInputsFromState, the strong-hit threshold and the
// prompt's byte budget (injection.perPromptBytes) from the library's settings. What the host gets
// is the hit lines as additionalContext and nothing else: no header, no session ledger, no model
// call. A prompt without a strong hit gets no output at all (474 R3). Only valid decisions are
// indexed, whatever the prompt asks (TCRN-CROSS-SUB-426, MIN-239 D6).
//
// The launcher's registry match is a fast subset of resolveLibrary that starts no git process
// (problem list #6). Before anything is read, resolveLibrary confirms from the same directory
// that the registry names the library the launcher matched and that the library still carries
// the recorded id; when it does not, the hook stays silent rather than answer from another
// project's library.
//
// TCRN-CROSS-STORY-478 R4, AC5 (TCRN-CROSS-SUB-317): on a device that declined the navigation
// section in AGENTS.md, SessionStart supplies navigation alone. BL-34 always installs
// SubagentStart: the entry recalls against its native agent_type and adds navigation.
// navigationPointerAnswer itself reads nothing.
//
// TCRN-CROSS-SUB-483 (TCRN-CROSS-STORY-529, MIN-257 D6): every recall also says why it answered
// what it did (promptRecallOutcome): HOOK_RECALL_ANSWERED with the hit lines, otherwise
// HOOK_RECALL_PROMPT_EMPTY, HOOK_RECALL_LIBRARY_UNCONFIRMED or HOOK_RECALL_NO_HITS. The hook entry
// writes that code into log/hook.ndjson in the device directory; a failure is still thrown, and
// the entry notes the failure's own reasonCode before passing it on.

import { NAVIGATION_LINES } from "./agents-sections.js";
import { HOST_HOOK_EVENTS, HOST_HOOK_HOSTS, HOST_HOOK_POINTER_EVENTS } from "./host-hooks.js";
import type { HostHookHost } from "./host-hooks.js";
import { recall, recallDocuments } from "./recall.js";
import { readRecallCards, recallContextLines, recallDecisionHints, recallInputsFromState } from "./recall-inputs.js";
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

// Every event the launcher may be run for, with its word: the prompt hook and the pointer hooks.
// Read when it is asked for, not when this module loads: host-hooks.ts can still be loading then.
function hookEventWords(): Readonly<Record<string, string>> {
  return { ...HOST_HOOK_EVENTS, ...HOST_HOOK_POINTER_EVENTS };
}

/** The host event a launcher word names (user-prompt-submit → UserPromptSubmit, session-start → SessionStart), or null. */
export function hookEventName(word: unknown): string | null {
  if (typeof word !== "string") return null;
  const words = hookEventWords();
  return Object.keys(words).find((event) => words[event] === word) ?? null;
}

/**
 * The host running the hook. The command line names no host (477 R1), so it is read from the
 * environment. TCRN-CROSS-STORY-548 R2: EINZBERN_HOST, when it names one of HOST_HOOK_HOSTS, is
 * the answer; the DSH plugin sets it to dsh on every spawn, because DSH's Claude Code hook bridge
 * also gives the hook CLAUDE_PROJECT_DIR. Any other value, the empty string included, counts as
 * unset and never fails the hook. Unset, Claude Code gives every hook command it runs
 * CLAUDE_PROJECT_DIR, and Codex is the other host the hook is rendered for. Every host reads the
 * same protocol (hookProtocolOutput), so the answer never depends on this guess being right.
 */
export function hookHost(env: NodeJS.ProcessEnv = process.env): HostHookHost {
  const declared = env["EINZBERN_HOST"];
  if (typeof declared === "string" && (HOST_HOOK_HOSTS as readonly string[]).includes(declared)) return declared as HostHookHost;
  const projectDirectory = env["CLAUDE_PROJECT_DIR"];
  return typeof projectDirectory === "string" && projectDirectory.length > 0 ? "claude-code" : "codex";
}

/**
 * The JSON a host reads from the hook's standard output for `event`: `lines` joined by newlines as
 * the hookSpecificOutput's additionalContext. Claude Code, Codex and DSH read one shape, the one
 * the retired prompt-injection hook wrote for the first two.
 */
export function hookProtocolOutput(host: HostHookHost, event: string, lines: readonly string[]): string {
  if (!HOST_HOOK_HOSTS.includes(host)) fail("HOOK_INPUT_INVALID", `host must be one of ${HOST_HOOK_HOSTS.join(", ")}`, { host: String(host) });
  if (!Object.hasOwn(hookEventWords(), event)) fail("HOOK_INPUT_INVALID", `${String(event)} is not an event Einzbern hooks`, { event: String(event) });
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) fail("HOOK_INPUT_INVALID", "lines must be strings");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } });
}

/**
 * A pointer hook's answer (TCRN-CROSS-STORY-478 R4): the three navigation lines as the
 * additionalContext of `event`, SessionStart or SubagentStart. Nothing is retrieved and nothing is
 * read, so it is the same for every registered project.
 */
export function navigationPointerAnswer(host: HostHookHost, event: string): PromptRecallAnswer {
  if (!Object.hasOwn(HOST_HOOK_POINTER_EVENTS, event)) fail("HOOK_INPUT_INVALID", `${String(event)} is not a pointer hook event`, { event: String(event) });
  return { lines: NAVIGATION_LINES, output: hookProtocolOutput(host, event, NAVIGATION_LINES) };
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
  // SubagentStart uses the same recall policy and its own host output envelope.
  readonly event?: "UserPromptSubmit" | "SubagentStart";
}

export interface PromptRecallAnswer {
  // The hit lines, in rank order, within the prompt's byte budget.
  readonly lines: readonly string[];
  // hookProtocolOutput(host, "UserPromptSubmit", lines): what the hook prints.
  readonly output: string;
}

/** Why a prompt's recall gave what it gave; one code per outcome (TCRN-CROSS-SUB-483). */
export const HOOK_RECALL_OUTCOME_CODES = Object.freeze([
  "HOOK_RECALL_ANSWERED",
  "HOOK_RECALL_NO_HITS",
  "HOOK_RECALL_PROMPT_EMPTY",
  "HOOK_RECALL_LIBRARY_UNCONFIRMED",
] as const);
export type HookRecallOutcomeCode = typeof HOOK_RECALL_OUTCOME_CODES[number];

export interface PromptRecallOutcome {
  // The answer promptRecallContext gives: null unless reasonCode is HOOK_RECALL_ANSWERED.
  readonly answer: PromptRecallAnswer | null;
  readonly reasonCode: HookRecallOutcomeCode;
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
 * The UserPromptSubmit answer for one prompt in a registered project and why it is what it is: the
 * hit lines recall gives for it, cut to injection.perPromptBytes, and the host protocol JSON
 * carrying them (HOOK_RECALL_ANSWERED); no answer when the prompt is empty
 * (HOOK_RECALL_PROMPT_EMPTY), when the registry does not confirm the launcher's library from `cwd`
 * (HOOK_RECALL_LIBRARY_UNCONFIRMED), or when recall has no line to give (HOOK_RECALL_NO_HITS). A
 * request that is not one, or a library that cannot be read, throws as before. Reads the library
 * and both knowledge crests; writes only this device's cache.
 */
export async function promptRecallOutcome(request: PromptRecallRequest): Promise<PromptRecallOutcome> {
  if (!HOST_HOOK_HOSTS.includes(request.host)) fail("HOOK_INPUT_INVALID", `host must be one of ${HOST_HOOK_HOSTS.join(", ")}`, { host: String(request.host) });
  if (typeof request.libraryPath !== "string" || request.libraryPath.length === 0) fail("HOOK_INPUT_INVALID", "libraryPath must be a path");
  if (typeof request.cwd !== "string" || request.cwd.length === 0) fail("HOOK_INPUT_INVALID", "cwd must be a path");
  const prompt = typeof request.prompt === "string" ? request.prompt.toWellFormed() : "";
  if (prompt.trim().length === 0) return { answer: null, reasonCode: "HOOK_RECALL_PROMPT_EMPTY" };
  const library = await confirmedLibrary(request.cwd, request.libraryPath);
  if (library === null) return { answer: null, reasonCode: "HOOK_RECALL_LIBRARY_UNCONFIRMED" };
  const at = request.at ?? currentInstant();
  const state = await effectiveProjectState(await materializeLibrary(library.libraryPath), library.entry.projectId);
  // TCRN-CROSS-SUB-425 (MIN-239 D6): the prompt hook recalls valid cards only, always; no prompt asks
  // it for a removed one.
  const { cards, digest } = await readRecallCards(library.libraryPath, { at, allowTrailing: true, status: "valid" });
  const tau = numericSetting(state, "retrieval.tau", (value) => Number.isFinite(value) && value >= 0);
  const scopeExcerptBytes = numericSetting(state, "retrieval.scopeExcerptBytes", (value) => Number.isSafeInteger(value) && value > 0);
  const perPromptBytes = numericSetting(state, "injection.perPromptBytes", (value) => Number.isSafeInteger(value) && value > 0);
  const result = recall({
    // Its own index: the recall verb's documents are built another way and must not answer here.
    cacheKey: `prompt-hook:${state.metadata.workspaceId}:${state.configurationProjectId ?? "library"}`,
    checkpoint: `${state.headEventHash}:${digest}`,
    documents: () => recallDocuments(recallInputsFromState(state, cards, { scopeExcerptBytes })),
    query: prompt,
    tau,
  });
  // TCRN-CROSS-SUB-426 (MIN-239 D5, D6): the index holds valid decisions only, so the hook never
  // recalls an obsolete one; a work or card hit that points at one says which decision replaced it.
  const lines = recallContextLines(recallDecisionHints(state, cards, result.records), perPromptBytes);
  if (lines.length === 0) return { answer: null, reasonCode: "HOOK_RECALL_NO_HITS" };
  return { answer: { lines, output: hookProtocolOutput(request.host, request.event ?? "UserPromptSubmit", lines) }, reasonCode: "HOOK_RECALL_ANSWERED" };
}

/**
 * The UserPromptSubmit answer for one prompt in a registered project (promptRecallOutcome's
 * answer): the hit lines and the host protocol JSON carrying them, or null when there is nothing
 * to print.
 */
export async function promptRecallContext(request: PromptRecallRequest): Promise<PromptRecallAnswer | null> {
  return (await promptRecallOutcome(request)).answer;
}
