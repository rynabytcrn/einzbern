// SPDX-License-Identifier: Apache-2.0
// A fresh, read-only CLI lifetime for one catalog. Never retain a library materialization.
import { assertNodeFloor } from "../../core/src/node-floor.js";

type CatalogLibrary = {
  projectPath: string;
  libraryId: string;
  libraryPath: string;
  projectId?: unknown;
  configurationProjectId?: unknown;
  name?: unknown;
  chain?: unknown;
};
type CatalogBody = {
  ok?: boolean;
  entries?: CatalogLibrary[];
  records?: { id: unknown; name?: unknown }[];
  workspaceId?: unknown;
  identity?: unknown;
  reasonCode?: string;
  error?: string;
};
type CatalogError = {
  reasonCode?: string;
  detail?: unknown;
  details?: Record<string, unknown>;
  message?: string;
};

function startupError(reasonCode: string, detail: Record<string, unknown>, message = reasonCode): Error & { reasonCode: string; detail: Record<string, unknown> } {
  return Object.assign(new Error(message), { reasonCode, detail });
}
const publicLibrary = ({ projectPath, libraryId, libraryPath, projectId, configurationProjectId, name, chain }: CatalogLibrary) => ({ projectPath, libraryId, libraryPath, projectId: projectId ?? null, configurationProjectId: configurationProjectId ?? null, name: name ?? null, chain: chain ?? null });

export async function runLibraryCatalogWorker(): Promise<void> {
  try {
    assertNodeFloor(process.versions.node);
    const { runCli } = await import("./index.js");
    async function cliResult(args: readonly string[]): Promise<{ ok: boolean; body: CatalogBody }> {
      let stdout = "", stderr = "";
      try {
        await runCli(args, { write: value => { stdout += value; } });
        return { ok: true, body: JSON.parse(stdout) as CatalogBody };
      } catch (caught) {
        const error = caught as CatalogError | undefined;
        const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "CLI_INTERNAL_ERROR";
        // Same public refusal fields as scripts/einzbern.mjs.
        const stringDetails = ["required", "actual", "supported", "layout", "streamId", "sequence", "eventId", "break", "segment", "line", "deviceId", "file", "timeoutMs", "remedy", "movedTo", "target", "field", "section", "runId", "treeDigest", "check", "workId", "cardId", "query", "holder", "expiresAt", "leasedWorkId", "projectId", "decidedIn", "reason", "holderPid", "holderCommand", "heldSince"];
        const numberDetails = ["bodyBytes", "limit"];
        const listDetails = ["allowedValues", "conflicts", "reds", "stories"];
        const details = error?.details !== null && typeof error?.details === "object"
          ? Object.fromEntries(Object.entries(error.details).filter(([key, value]) =>
            (stringDetails.includes(key) && typeof value === "string") ||
            (numberDetails.includes(key) && Number.isSafeInteger(value)) ||
            (listDetails.includes(key) && Array.isArray(value) && value.every((entry) => typeof entry === "string"))))
          : {};
        stderr += `${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`;
        const raw = String(stderr ?? stdout ?? "").trim();
        try { return { ok: false, body: JSON.parse(raw) as CatalogBody }; } catch {
          return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: raw || String(error?.message ?? error) } };
        }
      }
    }
    async function readLibraryCatalog(): Promise<CatalogLibrary[]> {
      const result = await cliResult(["library-list"]);
      if (!result.ok || !Array.isArray(result.body?.entries)) {
        throw startupError(result.body?.reasonCode ?? "PORTAL_LIBRARY_LIST_FAILED", {}, result.body?.error ?? "library-list failed");
      }
      const entries = result.body.entries
        .filter((entry) => typeof entry?.projectPath === "string" && typeof entry?.libraryPath === "string" && typeof entry?.libraryId === "string")
        .map(publicLibrary);
      return Promise.all(entries.map(async entry => {
        const [projects, identity] = await Promise.all([cliResult(["project-list", "--workspace", entry.libraryPath]), cliResult(["chain-identity", "--workspace", entry.libraryPath])]);
        if (projects.ok && projects.body.workspaceId !== entry.libraryId) throw startupError("PORTAL_LIBRARY_IDENTITY_MISMATCH", { expected: entry.libraryId, actual: projects.body.workspaceId }, "registered location holds a different library");
        const project = projects.body?.records?.find(project => project.id === entry.projectId);
        return { ...entry, name: project?.name ?? null, chain: identity.ok ? identity.body.identity : null };
      }));
    }
    process.stdout.write(JSON.stringify({ ok: true, entries: await readLibraryCatalog() }));
  } catch (caught) {
    const error = caught as CatalogError | undefined;
    process.stdout.write(JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "PORTAL_LIBRARY_LIST_FAILED", detail: error?.detail ?? error?.details ?? {}, error: String(error?.message ?? error) }));
  }
}
