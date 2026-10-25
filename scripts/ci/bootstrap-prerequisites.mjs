#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, digest } from "./impact-plan.mjs";
import { P1_TASKS } from "../p1-sequence.mjs";
import { validateSelectedTests } from "../lib/test-roster.mjs";

const fullModes = ["p1", "pf2-h1"];
const shardModes = { "p1-checks": "checks", "p1-core": "core", "p1-portal": "portal" };
const releaseTest = "tests/release-lockstep.test.mjs";

// This acquisition-only guard checks the plan envelope and the exact core input.
// It does not admit verification: the later independent source/provenance plan
// validator remains authoritative, without repeating its expensive source audit.
export function corepackBootstrapRequired(mode, plan, basis) {
  if (fullModes.includes(mode)) return true;
  if (!Object.hasOwn(shardModes, mode)) throw new Error("Unknown bootstrap verification mode");
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Impact plan is required for shard bootstrap");
  const { planDigest, ...semantic } = plan;
  if (plan.schemaVersion !== "einzbern.ci-impact-plan.v1" || !["full", "selective"].includes(plan.coverage)
    || !/^[a-f0-9]{64}$/u.test(planDigest ?? "") || digest(semantic) !== planDigest) {
    throw new Error("Invalid bootstrap impact plan envelope or digest");
  }
  for (const key of ["repository", "event", "head", "tree", "runId", "attempt", "rulesHash"]) {
    if (typeof basis?.[key] !== "string" || !basis[key] || plan[key] !== basis[key]) throw new Error(`Bootstrap impact plan identity mismatch: ${key}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(plan.head) || !/^[a-f0-9]{40}$/u.test(plan.tree)
    || !/^[a-f0-9]{64}$/u.test(plan.rulesHash)) throw new Error("Invalid bootstrap source identity");
  const source = validateSelectedTests(plan.sourceCoreTests, basis.sourceCoreTests);
  const selected = validateSelectedTests(plan.coreTests, source);
  if (canonical(source) !== canonical(basis.sourceCoreTests) || plan.coverage === "full" && canonical(selected) !== canonical(source)) {
    throw new Error("Bootstrap impact plan core roster mismatch");
  }
  const shards = plan.shards;
  const shard = shardModes[mode];
  if (!shards || typeof shards !== "object" || Array.isArray(shards)
    || canonical(shards.core) !== canonical(["test"])
    || canonical(shards.checks) !== canonical(P1_TASKS.filter((task) => !["test", "portal"].includes(task)))
    || Object.keys(shards).some((key) => !["checks", "core", "portal"].includes(key))
    || Object.hasOwn(shards, "portal") && canonical(shards.portal) !== canonical(["portal"])
    || !Object.hasOwn(shards, shard)) throw new Error("Bootstrap impact plan shard mismatch");
  return shard === "core" && selected.includes(releaseTest);
}

function checkoutBasis(root, env) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return {
    repository: env.GITHUB_REPOSITORY, event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    head: git("rev-parse", "HEAD").trim(), tree: git("rev-parse", "HEAD^{tree}").trim(),
    rulesHash: digest(readFileSync(resolve(root, "scripts/ci/impact-rules.json"))),
    sourceCoreTests: git("ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "tests/")
      .split("\0").filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs")).sort(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, planPath, extra] = process.argv.slice(2);
  if (extra !== undefined || !fullModes.includes(mode) && (!Object.hasOwn(shardModes, mode) || !planPath)) {
    throw new Error("Expected verification mode and exact shard impact plan path");
  }
  // Manual H1 has no downloaded impact plan and always consumes the full roster.
  const required = fullModes.includes(mode) ? corepackBootstrapRequired(mode)
    : corepackBootstrapRequired(mode, JSON.parse(readFileSync(planPath, "utf8")), checkoutBasis(process.cwd(), process.env));
  process.stdout.write(`${required}\n`);
}
