// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
const now = "2026-08-11T04:15:00Z";

function runCli(args, environment = {}) {
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd: portalRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment, NODE_NO_WARNINGS: "1" },
  });
  return JSON.parse(output);
}

function reconcile(declared, observed) {
  const keys = [...new Set([...Object.keys(declared), ...Object.keys(observed)])].sort();
  const mismatches = keys.filter((key) => declared[key] !== observed[key]);
  return { ok: mismatches.length === 0, mismatchKeys: mismatches };
}

const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-e2e-")));
try {
  // TCRN-CROSS-STORY-469: the demo writes a disposable library from a disposable device directory.
  process.env.EINZBERN_HOME = join(base, "device");
  const workspace = join(base, "library");
  const init = runCli([
    "init",
    "--workspace", workspace,
    "--at", now,
  ]);

  const before = runCli(["settings-catalog", "--workspace", workspace]);
  const write = runCli([
    "settings-set",
    "--workspace", workspace,
    "--at", "2026-08-11T04:15:01Z",
    "--key", "execution.maxConcurrentSubagents",
    "--value", "7",
    "--actor", "agent:codex",
  ], { EINZBERN_SURFACE: "atelier" });
  const after = runCli(["settings-catalog", "--workspace", workspace]);
  const readback = after.settings.find((entry) => entry.key === "execution.maxConcurrentSubagents");
  const config = {
    initVersion: init.version,
    catalogBefore: before.settings.find((entry) => entry.key === "execution.maxConcurrentSubagents")?.currentValue,
    receipt: {
      reasonCode: write.reasonCode,
      recordId: write.recordId,
      version: write.version,
      receiptDigest: write.receiptDigest,
      value: write.setting.value,
    },
    cliReadback: { key: readback.key, value: readback.currentValue },
    sameValue: write.setting.value === readback.currentValue,
  };

  const proseDir = join(base, "prose");
  await mkdir(join(proseDir, "docs", "decisions"), { recursive: true });
  await mkdir(join(proseDir, "docs", "reports"), { recursive: true });
  const agentsText = "# AGENTS.md\n\nRead the handover. Keep Owner actions parked.\n";
  await writeFile(join(proseDir, "AGENTS.md"), agentsText);
  await writeFile(join(proseDir, "docs", "decisions", "README.md"), "# Decisions\n");
  await writeFile(join(proseDir, "docs", "reports", "README.md"), "# Reports\n");
  const agentsReadback = await readFile(join(proseDir, "AGENTS.md"), "utf8");
  const prose = {
    readbackMatches: agentsReadback === agentsText,
    starterPack: ["AGENTS.md", "docs/decisions/README.md", "docs/reports/README.md"],
  };

  const declared = { "execution.maxConcurrentSubagents": "7", "retrieval.tau": "0.11" };
  const drifted = { ...declared, "execution.maxConcurrentSubagents": "8" };
  const red = reconcile(declared, drifted);
  const repaired = reconcile(declared, declared);
  const reconciliation = {
    redLeg: { ...red, expected: "red" },
    greenLeg: { ...repaired, expected: "green" },
    repaired: repaired.ok,
  };

  process.stdout.write(`${JSON.stringify({
    reasonCode: "PORTAL_E2E_DEMO_COMPLETE",
    config,
    prose,
    reconciliation,
  }, null, 2)}\n`);
} finally {
  await rm(base, { recursive: true, force: true });
}
