// SPDX-License-Identifier: Apache-2.0
// Cheap, independent checks before the complete native release gates and final pack.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT_DOCUMENTS, SPECIFICATIONS, verifySkillSpecifications } from "./release-package-inputs.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const moduleAt = (root, path) => import(pathToFileURL(join(root, path)).href);
function command(root, args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error(String(result.error ?? result.stderr ?? "release input check failed"));
    error.reasonCode = "RELEASE_GENERATED_CHECK_FAILED";
    throw error;
  }
  return result.stdout.trim();
}

export async function classifyReleaseArtifacts({ engineRoot, version }) {
  // Read the target module: its P8 constants are tied to the target package version.
  const p8 = await moduleAt(engineRoot, "scripts/lib/p8-workflow-rc.mjs");
  if (p8.P8_VERSION !== version) throw Object.assign(new Error("P8 is not bound to the target version"), { reasonCode: "RELEASE_P8_VERSION_MISMATCH" });
  const names = await readdir(join(engineRoot, "dist/release")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const stale = p8.staleReleaseArtifactMoves(names, version);
  const remaining = names.filter((name) => !stale.some((move) => move.name === name));
  const unknown = remaining.filter((name) => !p8.P8_RELEASE_ARTIFACTS.includes(name));
  for (const name of names) if (!(await lstat(join(engineRoot, "dist/release", name))).isFile()) unknown.push(name);
  // Missing target artifacts are pending outputs of the gates/pack, not corrupt inputs.
  return { version, stale, unknown: [...new Set(unknown)].sort(), complete: p8.p8ReleaseArtifactSetMatches(remaining), pending: p8.P8_RELEASE_ARTIFACTS.filter((name) => !remaining.includes(name)) };
}

export async function checkReleaseReadiness({ engineRoot, helperRoot, version, receipt, env = process.env }) {
  engineRoot = resolve(engineRoot);
  helperRoot = resolve(helperRoot);
  const checks = [], violations = [], unverified = [];
  const check = async (category, action) => {
    try {
      const details = await action();
      checks.push({ category, status: "verified", details });
      return details;
    } catch (error) {
      const problem = { category, code: error.reasonCode ?? "RELEASE_READINESS_UNVERIFIED", message: String(error.message ?? error), ...(error.details ?? {}) };
      violations.push(problem);
      unverified.push(category);
      checks.push({ category, status: "unverified", problem });
      return undefined;
    }
  };
  const requireThat = (condition, code, details = {}) => {
    if (!condition) throw Object.assign(new Error(code), { reasonCode: code, details });
  };
  await check("sourceAudit", async () => {
    const { loadRules, checkConsumers } = await moduleAt(engineRoot, "scripts/ci/impact-plan.mjs");
    const unknown = checkConsumers(engineRoot, loadRules(engineRoot).rules);
    requireThat(unknown.length === 0, "RELEASE_SOURCE_AUDIT_STALE", { paths: unknown });
    return { unknown };
  });
  await check("readme", async () => {
    const { renderReadmes } = await moduleAt(engineRoot, "scripts/render-readme.mjs");
    const report = await renderReadmes({ root: engineRoot, version, check: true });
    requireThat(report.ok === true && report.reasonCode === "README_RENDER_MATCHES" && report.drifted.length === 0, "RELEASE_README_STALE", { report });
    return report;
  });
  await check("cliReference", () => command(engineRoot, [join(engineRoot, "scripts/wiki-cli-reference.mjs"), "--check"], env));
  await check("generatedReceipt", async () => {
    requireThat(receipt?.generated?.readme?.reasonCode === "README_RENDERED" && receipt.generated.cliReference?.checked === true && receipt.generated.helperDocs?.reasonCode === "HELPER_DOCS_RENDERED", "RELEASE_GENERATED_PROOF_MISSING");
    const changed = [];
    for (const name of ["engine", "helper"]) {
      for (const entry of receipt[name].changes) {
        const root = name === "engine" ? engineRoot : helperRoot;
        try {
          const metadata = await lstat(join(root, entry.path));
          const bytes = metadata.isFile() ? await readFile(join(root, entry.path)) : null;
          if (bytes === null || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) changed.push(`${name}/${entry.path}`);
        } catch { changed.push(`${name}/${entry.path}`); }
      }
    }
    requireThat(changed.length === 0, "RELEASE_GENERATED_PROOF_STALE", { paths: changed });
    return { checked: true };
  });
  await check("p8", async () => {
    const report = await classifyReleaseArtifacts({ engineRoot, version });
    requireThat(report.unknown.length === 0, "RELEASE_P8_UNKNOWN_ARTIFACTS", { paths: report.unknown });
    return report;
  });
  const scratch = await mkdtemp(join(tmpdir(), "einzbern-release-readiness-"));
  try {
    const rendered = await check("skillSpecifications", async () => {
      const tree = join(scratch, "package");
      await mkdir(tree);
      command(engineRoot, [join(engineRoot, "scripts/einzbern.mjs"), "skill-render", "--out", join(tree, "skill/mana-orchestrate"), "--version", version], env);
      await mkdir(join(tree, "specs"));
      for (const name of SPECIFICATIONS) await cp(join(engineRoot, "specs", name), join(tree, "specs", name));
      for (const document of CONTRACT_DOCUMENTS) {
        const target = join(tree, document);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(engineRoot, document), target);
      }
      await verifySkillSpecifications(tree, "skill/mana-orchestrate");
      return { tree };
    });
    await check("helperGenerated", async () => {
      const source = JSON.parse(await readFile(join(helperRoot, ".github/engine-source.json"), "utf8"));
      requireThat(source.schemaVersion === "einzbern.helper-source.v1" && source.repository === "tpmoonchefryan/einzbern" && source.commit === receipt?.engine?.head && source.renderVersion === version, "RELEASE_HELPER_SOURCE_MISMATCH", { source });
      const out = join(scratch, "helper");
      await mkdir(out);
      const { renderHelperDocs } = await moduleAt(engineRoot, "scripts/render-helper-docs.mjs");
      const report = await renderHelperDocs({ out, version, root: engineRoot });
      requireThat(report.skillInstallTreeDigest === receipt?.generated?.helperDocs?.skillInstallTreeDigest, "RELEASE_HELPER_GENERATION_STALE");
      const drifted = [];
      for (const path of report.files) {
        // The renderer records current HEAD; release generation recorded its parent.
        if (path === ".github/engine-source.json") continue;
        try {
          const metadata = await lstat(join(helperRoot, path));
          if (!metadata.isFile() || !(await readFile(join(helperRoot, path))).equals(await readFile(join(out, path)))) drifted.push(path);
        } catch { drifted.push(path); }
      }
      requireThat(drifted.length === 0, "RELEASE_HELPER_GENERATION_STALE", { paths: drifted });
      const archiver = report.files.find((path) => path.endsWith("/create-skill-archive.mjs"));
      requireThat(archiver !== undefined, "RELEASE_HELPER_ARCHIVER_UNVERIFIED");
      const archiveSha256 = command(helperRoot, [join(helperRoot, archiver), "--check"], env);
      requireThat(/^[a-f0-9]{64}$/u.test(archiveSha256), "RELEASE_HELPER_ARCHIVE_INVALID");
      return { archiveSha256, skillSpecifications: rendered === undefined ? "unverified" : "verified" };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { ok: violations.length === 0, reasonCode: violations.length === 0 ? "RELEASE_READINESS_READY" : "RELEASE_READINESS_REFUSED", checks, violations, unverified };
}
