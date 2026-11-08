// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readEngineCurrent, engineVersionDirectory } from "./engine-home.js";
import { join, resolve } from "node:path";
import { parseStrictInstant } from "../../protocol/src/index.js";
import { hostHookCommand, hookLauncherPath } from "./host-hooks.js";
import { inspectCodexPeerRoles } from "./codex-peer-hooks.js";

/** Raw public app-server hooks/list output, retained with its actual file observations.
 * Neither this envelope nor hashes authenticate a provider or grant hook trust. */
export interface CodexHookObservation {
  readonly schemaVersion: "tcrn.codex-hook-observation.v1";
  readonly observedAt: string;
  readonly version: string;
  readonly cwd: string;
  readonly raw: unknown;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function codexNativeGuardHealth(input: {
  readonly device: string;
  readonly home: string;
  readonly cwd: string;
  readonly observation?: CodexHookObservation;
  readonly now?: string;
}): Promise<{ readonly ready: boolean; readonly reasons: readonly string[]; readonly native: string; readonly roleRecovery: Awaited<ReturnType<typeof inspectCodexPeerRoles>> }> {
  const reasons: string[] = [];
  const roleRecovery = await inspectCodexPeerRoles(input.device);
  if (!roleRecovery.ready) reasons.push("role-recovery-failed");
  const observed = input.observation;
  let native = "unknown";
  if (!observed) reasons.push("native-hooks-observation-missing");
  else {
    try {
      if (observed.schemaVersion !== "tcrn.codex-hook-observation.v1" || !observed.version || !Array.isArray(observed.files)) throw new Error("invalid observation contract");
      const age = parseStrictInstant(input.now ?? new Date().toISOString()) - parseStrictInstant(observed.observedAt);
      // Same five-minute current-observation bound as native dispatch preparation.
      if (age < 0n || age > 300_000_000_000n) throw new Error("native observation is stale or future");
      const current = await readEngineCurrent(input.device);
      if (current === null) throw new Error("no current engine for the native guard");
      const installed = engineVersionDirectory(current.version, input.device);
      const hookModule = await import(pathToFileURL(join(installed, "scripts", "einzbern-hook.mjs")).href) as Record<string, unknown>;
      if (hookModule["CODEX_PEER_GUARD_CONTRACT"] !== "einzbern.codex-peer-dispatch-guard.v1" || typeof hookModule["runPeerDispatchHookEvent"] !== "function") throw new Error("current engine does not expose the durable native guard contract");
      if (!(await readFile(join(input.device, "engine", "hook.mjs"))).equals(await readFile(join(installed, "launchers", "hook.mjs")))) throw new Error("stable hook launcher differs from the current engine guard launcher");
      const cwd = await realpath(input.cwd);
      if (await realpath(observed.cwd) !== cwd) throw new Error("native observation is for another cwd");
      const data = object(observed.raw)?.data;
      if (!Array.isArray(data)) throw new Error("hooks/list data unavailable or unsupported");
      const rows = [];
      for (const value of data) {
        const row = object(value);
        if (typeof row?.cwd === "string" && await realpath(row.cwd) === cwd) rows.push(row);
      }
      if (rows.length !== 1) throw new Error("hooks/list cwd is missing or ambiguous");
      const row = rows[0]!;
      if (!Array.isArray(row.errors) || row.errors.length !== 0 || !Array.isArray(row.warnings) || row.warnings.length !== 0) throw new Error("native hook loading errors/warnings obscure applicability");
      const command = hostHookCommand(hookLauncherPath(input.device), "PreToolUse", input.home);
      const hooks = Array.isArray(row.hooks) ? row.hooks.map(object).filter(hook => hook?.eventName === "preToolUse" && hook.handlerType === "command" && hook.command === command) : [];
      if (hooks.length !== 1) throw new Error("candidate native PreToolUse registration missing or duplicated");
      const hook = hooks[0]!;
      if (hook.enabled !== true) throw new Error("candidate native PreToolUse is disabled");
      if (hook.trustStatus !== "trusted" || typeof hook.currentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(hook.currentHash)) throw new Error("current exact native PreToolUse definition is not trusted");
      if (typeof hook.sourcePath !== "string" || (hook.matcher !== null && hook.matcher !== undefined)) throw new Error("candidate hook source or applicability unavailable");
      const required = [hook.sourcePath, join(input.home, ".codex", "config.toml")];
      for (const file of required) {
        const actual = await realpath(file);
        const facts = observed.files.filter(fact => resolve(fact.path) === actual || resolve(fact.path) === resolve(file));
        if (facts.length !== 1 || facts[0]!.sha256 !== createHash("sha256").update(await readFile(actual)).digest("hex")) throw new Error("hook/config bytes changed since the native observation");
      }
      native = "registered-enabled-current-trusted";
    } catch (error) { native = "not-ready"; reasons.push(String(error)); }
  }
  return { ready: reasons.length === 0, reasons, native, roleRecovery };
}
