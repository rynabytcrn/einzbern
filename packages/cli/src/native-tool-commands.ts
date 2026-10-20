// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import type { RuntimeCommandCatalogEntry, RuntimeCommandFlag } from "../../core/src/runtime-input-contract.js";
import { dotObject, validateDotExecutionRequest } from "../../core/src/dot-execution.js";
import { prepareNativeDispatch, recordNativeDispatch, writeDispatchArtifact } from "../../core/src/dispatch-workflow.js";
import type { NativeDispatchPreparation } from "../../core/src/dispatch-workflow.js";
import { normalizeNativeToolEvidence } from "../../core/src/native-tool-evidence.js";
import type { NativeToolAttempt, NativeToolResponseInput } from "../../core/src/native-tool-evidence.js";
import { planSharedSubmit, readSharedSubmitAdvisory, validateSharedSubmitAdvisory, writeSharedSubmitAdvisory } from "../../core/src/shared-submit.js";
import type { SharedSubmitInput } from "../../core/src/shared-submit.js";
import type { WorkspaceState, WorkspaceWriteLockOptions } from "../../core/src/workspace.js";

const flag = (name: string, required: boolean, valueKind = "path", valueShape?: string): RuntimeCommandFlag => ({ name, required, valueKind: valueKind === "path" ? "string" : valueKind, ...(valueShape === undefined ? {} : { valueShape }) });
export const NATIVE_TOOL_COMMAND_CATALOG: readonly RuntimeCommandCatalogEntry[] = Object.freeze([
  { name: "execution-native-prepare", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("request", true, "path", "DotExecutionRequest JSON including actual-session contextRead"), flag("tool", true, "string"), flag("tool-contract", true, "path", "{ref,sha256} JSON"), flag("arguments", true, "path", "actual tool arguments JSON"), flag("output", true)] },
  { name: "execution-native-record", availability: "cli", mutates: true, flags: [flag("binding", true), flag("response", false, "path", "NativeToolResponseInput JSON; absent keeps pending attempt"), flag("output", true)] },
  { name: "execution-native-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true), flag("work-id", false, "string"), flag("work-revision", false, "integer")] },
  { name: "shared-submit-plan", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "shared-submit-evidence", availability: "cli", mutates: false, flags: [flag("from-file", true)] },
  { name: "shared-submit-advisory-read", availability: "cli", mutates: false, flags: [flag("workspace", true)] },
  { name: "shared-submit-advisory-write", availability: "cli", mutates: true, flags: [flag("workspace", true), flag("from-file", true), flag("actor", true, "string"), flag("handoff-evidence", true, "string"), flag("timeout-ms", false, "integer")] },
]);
export interface NativeToolCommandContext {
  /** Existing CLI registry/path resolution and real materialization, not an arbitrary evaluator. */
  readonly resolveWorkspace: (selector: string) => Promise<{ readonly root: string; readonly state: WorkspaceState }>;
  readonly home?: string;
  readonly writeLockOptions?: WorkspaceWriteLockOptions;
  /** Inject only after the integration reserved-root audit, never from input JSON or a flag. */
  readonly advisoryStorageAuditEvidenceRef?: string;
}
function json(value: unknown): JsonValue { return JSON.parse(canonicalJson(value)) as JsonValue; }
async function input(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }
/** Return null only for unowned verbs; output guards/error mapping remain the integration seam. */
export async function runNativeToolCommand(command: string, values: Readonly<Record<string, string>>, context: NativeToolCommandContext): Promise<JsonValue | null> {
  const catalog = NATIVE_TOOL_COMMAND_CATALOG.find(entry => entry.name === command); if (!catalog) return null;
  for (const key of Object.keys(values)) if (!catalog.flags.some(entry => entry.name === key)) throw new Error(`unsupported --${key}`);
  for (const f of catalog.flags) if (f.required && !values[f.name]?.trim()) throw new Error(`--${f.name} is required`);
  if (command === "execution-native-prepare") {
    const workspace = await context.resolveWorkspace(values.workspace!);
    const request = validateDotExecutionRequest(await input(values.request!));
    const contract = dotObject(await input(values["tool-contract"]!), "tool contract", ["ref", "sha256"]);
    const result = await prepareNativeDispatch(workspace.state, request, { toolName: values.tool!, toolContractObservation: contract as unknown as NativeToolAttempt["toolContractObservation"], argumentsValue: await input(values.arguments!) }, context.home);
    await writeDispatchArtifact(values.output!, result, [workspace.root], context.home);
    return json({ reasonCode: result.attempt ? "NATIVE_PREPARATION_READY" : "NATIVE_PREPARATION_REFUSED", ...result });
  }
  if (command === "execution-native-record") {
    const preparation = await input(values.binding!) as NativeDispatchPreparation;
    const response = values.response === undefined ? undefined : await input(values.response!) as NativeToolResponseInput;
    let result: unknown;
    try { result = recordNativeDispatch(preparation, response); }
    catch (error) {
      // Preserve raw failed/unassociated source material in the same private create-new path.
      result = { reasonCode: "NATIVE_RECORD_INVALID", preparation, ...(response === undefined ? {} : { response }), normalized: { requested: true, evidenceType: "native-tool", valid: false, complete: false, status: "invalid", problems: [String(error)] } };
    }
    await writeDispatchArtifact(values.output!, result, [], context.home);
    return json(result);
  }
  if (command === "execution-native-evidence") {
    const revision = values["work-revision"];
    if (revision !== undefined && (!/^[1-9][0-9]*$/u.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error("--work-revision must be a positive safe integer");
    return json(normalizeNativeToolEvidence(await input(values["from-file"]!), { ...(values["work-id"] === undefined ? {} : { workId: values["work-id"] }), ...(revision === undefined ? {} : { workRevision: Number(revision) }) }));
  }
  if (command === "shared-submit-plan" || command === "shared-submit-evidence") return json(planSharedSubmit(await input(values["from-file"]!) as SharedSubmitInput));
  const workspace = await context.resolveWorkspace(values.workspace!);
  if (command === "shared-submit-advisory-read") return json(await readSharedSubmitAdvisory(workspace.root, context.home));
  if (command === "shared-submit-advisory-write") {
    if (!context.advisoryStorageAuditEvidenceRef) throw new Error("shared-submit advisory storage has not passed the integration reserved-root audit");
    const advisory = validateSharedSubmitAdvisory(await input(values["from-file"]!));
    return json(await writeSharedSubmitAdvisory(workspace.root, advisory, { actor: values.actor!, handoffEvidenceRef: values["handoff-evidence"]!, storageAuditEvidenceRef: context.advisoryStorageAuditEvidenceRef, ...(context.home === undefined ? {} : { home: context.home }), ...(context.writeLockOptions === undefined ? {} : { writeLockOptions: context.writeLockOptions }) }));
  }
  throw new Error(`cataloged native command has no handler: ${command}`);
}
