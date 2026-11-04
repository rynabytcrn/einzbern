// SPDX-License-Identifier: Apache-2.0
// Managed instruction sections are harness wiring. Refresh existing registered outputs with
// the engine selected by setup, not the catalog imported by the process that began the update.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { AGENTS_FILE, CLAUDE_FILE, managedOutputBinding } from "./agents-sections.js";
import { assertNotDotAgentsTarget } from "./dot-agents.js";
import { ENGINE_FILES } from "./engine-home.js";
import { managedSectionRecordsFor, planManagedWrite } from "./managed-sections.js";
import { readRegistry, withLibraryRepointLock } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { entryKind, reasonOf, setupTargetState } from "./setup-fresh.js";
import type { SetupRecorder } from "./setup-fresh.js";
import type { SetupPlan } from "./setup.js";

export interface SetupManagedUpdate {
  readonly projectPath: string;
  readonly libraryPath: string;
  readonly libraryId: string;
  readonly projectId?: string;
  readonly status: "planned" | "updated" | "unchanged" | "pending" | "skipped" | "unavailable";
  readonly reasonCode?: string;
  readonly pending?: readonly { readonly file: string; readonly id: string }[];
}

function binding(entry: Pick<RegistryEntry, "projectPath" | "libraryPath" | "libraryId" | "projectId">): Pick<SetupManagedUpdate, "projectPath" | "libraryPath" | "libraryId" | "projectId"> {
  return { projectPath: entry.projectPath, libraryPath: entry.libraryPath, libraryId: entry.libraryId,
    ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }) };
}

/** Lists possible writes without executing or unpacking the new engine during a read-only plan. */
export async function planSetupManagedUpdates(recorder: SetupRecorder, deviceHome: string): Promise<readonly SetupManagedUpdate[]> {
  const outputs: SetupManagedUpdate[] = [];
  for (const entry of (await readRegistry(deviceHome)).entries) {
    const target = binding(entry);
    try {
      await assertNotDotAgentsTarget(entry.projectPath);
      const state = await setupTargetState(entry.projectPath, entry.libraryPath, deviceHome);
      if (state.settings.find(setting => setting.key === "agents.generation")?.value === "none") {
        outputs.push({ ...target, status: "skipped", reasonCode: "GENERATION_DISABLED" }); continue;
      }
      if (!state.configRecords.some(record => record.collection === "managed-section")) {
        outputs.push({ ...target, status: "skipped", reasonCode: "NO_MANAGED_OUTPUT" }); continue;
      }
      if (await managedOutputBinding(entry.libraryPath, entry.projectPath, state, deviceHome) !== "bound") {
        outputs.push({ ...target, status: "skipped", reasonCode: "MANAGED_SECTION_OUTPUT_UNREGISTERED" }); continue;
      }
      const pending: { file: string; id: string }[] = [];
      for (const file of [AGENTS_FILE, CLAUDE_FILE]) {
        const path = join(entry.projectPath, file);
        const probe = await planManagedWrite({ filePath: path, file, desired: [], records: managedSectionRecordsFor(state, file) });
        pending.push(...probe.pending.map(id => ({ file, id })));
        recorder.write("managed-sections", path, probe.before === null ? "create" : "update");
        if (probe.before !== null) recorder.backup("managed-sections", path);
      }
      recorder.write("library", entry.libraryPath, "update");
      outputs.push({ ...target, status: "planned", pending });
    } catch (error) {
      const reasonCode = reasonOf(error) ?? "MANAGED_OUTPUT_UNAVAILABLE";
      const skipped = reasonCode === "DOT_INDEPENDENT_TARGET" || reasonCode === "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY";
      outputs.push({ ...target, status: skipped ? "skipped" : "unavailable", reasonCode });
    }
  }
  return outputs;
}

/** Run the selected version's CLI, including on rollback; never reuse this process's catalog. */
export function runSetupEngineCommand<T>(engineDirectory: string, plan: Pick<SetupPlan, "home" | "deviceHome">, args: readonly string[]): Promise<T> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [join(engineDirectory, ENGINE_FILES.entry), ...args], {
      encoding: "utf8", env: { ...process.env, EINZBERN_HOME: plan.deviceHome, HOME: plan.home, USERPROFILE: plan.home }, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        const result = JSON.parse(stdout) as T & { reasonCode?: string };
        if (error !== null) { rejectRun(Object.assign(new Error(stderr || result.reasonCode || error.message), { reasonCode: result.reasonCode })); return; }
        resolveRun(result);
      } catch { rejectRun(error ?? new Error(stderr || "Selected engine returned no JSON receipt")); }
    });
  });
}

interface RenderReceipt {
  readonly reasonCode: string;
  readonly files: readonly { readonly file: string; readonly written: boolean; readonly backupPath: string | null }[];
  readonly pending: readonly { readonly file: string; readonly id: string }[];
  readonly recorded: number;
}

export async function applySetupManagedUpdates(recorder: SetupRecorder, plan: SetupPlan, engineDirectory: string): Promise<readonly SetupManagedUpdate[]> {
  return withLibraryRepointLock(async () => {
    const registry = await readRegistry(plan.deviceHome);
    const outputs: SetupManagedUpdate[] = [];
    for (const target of plan.managedUpdates ?? []) {
      if (target.status !== "planned") { outputs.push(target); continue; }
      const current = registry.entries.find(entry => entry.projectPath === target.projectPath);
      if (current === undefined || JSON.stringify(binding(current)) !== JSON.stringify(binding(target))) {
        outputs.push({ ...target, status: "unavailable", reasonCode: "MANAGED_OUTPUT_BINDING_CHANGED" }); continue;
      }
      try {
        const before = new Map<string, Awaited<ReturnType<typeof entryKind>>>(await Promise.all([AGENTS_FILE, CLAUDE_FILE].map(async file => [file, await entryKind(join(target.projectPath, file))] as const)));
        const rendered = await runSetupEngineCommand<RenderReceipt>(engineDirectory, plan, ["agents-render", "--project", target.projectPath,
          ...(target.projectId === undefined ? [] : ["--project-id", target.projectId]), "--at", plan.at, "--actor", "agent:setup"]);
        if (rendered.reasonCode !== "AGENTS_RENDERED") throw new Error("Selected engine did not render managed sections");
        for (const file of rendered.files.filter(file => file.written)) {
          const path = join(target.projectPath, file.file);
          recorder.write("managed-sections", path, before.get(file.file) === null ? "create" : "update");
          if (file.backupPath !== null) recorder.backups.push({ path, into: dirname(file.backupPath) });
        }
        if (rendered.recorded > 0) recorder.write("library", target.libraryPath, "update");
        outputs.push({ ...target, status: rendered.pending.length > 0 ? "pending" : rendered.files.some(file => file.written) ? "updated" : "unchanged", pending: rendered.pending });
      } catch (error) {
        outputs.push({ ...target, status: "unavailable", reasonCode: reasonOf(error) ?? "MANAGED_SECTION_REFRESH_FAILED" });
      }
    }
    return outputs;
  }, plan.deviceHome);
}
