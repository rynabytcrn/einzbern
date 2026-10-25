// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkReleaseReadiness, classifyReleaseArtifacts } from "../scripts/lib/release-readiness.mjs";
import { SPECIFICATIONS, verifySkillSpecifications } from "../scripts/lib/release-package-inputs.mjs";
import { P8_VERSION } from "../scripts/lib/p8-workflow-rc.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "einzbern-readiness-test-"));
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  // Reuse the actual target's P8 contract; the fixture changes only the release listing.
  await writeFile(join(root, "scripts/lib/p8-workflow-rc.mjs"), `export * from ${JSON.stringify(new URL("../scripts/lib/p8-workflow-rc.mjs", import.meta.url).href)};\n`);
  return root;
}

test("607-R2: target packages are pending outputs; unknown and stale names stay distinct", async () => {
  const root = await fixture();
  try {
    let result = await classifyReleaseArtifacts({ engineRoot: root, version: P8_VERSION });
    assert.equal(result.complete, false);
    assert.ok(result.pending.length > 0);
    assert.deepEqual(result.unknown, []);
    await mkdir(join(root, "dist/release"), { recursive: true });
    await writeFile(join(root, "dist/release/einzbern-0.0.1.tar.gz"), "old");
    await writeFile(join(root, "dist/release/unowned.txt"), "unknown");
    result = await classifyReleaseArtifacts({ engineRoot: root, version: P8_VERSION });
    assert.deepEqual(result.unknown, ["unowned.txt"]);
    assert.equal(result.stale.length, 1);
    assert.equal(result.stale[0].name, "einzbern-0.0.1.tar.gz");
    assert.equal(result.stale[0].from, "dist/release/einzbern-0.0.1.tar.gz");
    assert.ok(result.pending.length > 0, "future target artifacts remain pending");
    await assert.rejects(classifyReleaseArtifacts({ engineRoot: root, version: "0.0.0" }), { reasonCode: "RELEASE_P8_VERSION_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("607-R2: missing independent inputs are reported together, never silently green", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "dist/release"), { recursive: true });
    await writeFile(join(root, "dist/release/unknown"), "unknown");
    const report = await checkReleaseReadiness({ engineRoot: root, helperRoot: root, version: P8_VERSION, receipt: {} });
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map((check) => check.category), ["sourceAudit", "readme", "cliReference", "generatedReceipt", "p8", "skillSpecifications", "helperGenerated"]);
    assert.equal(report.violations.length, 7);
    assert.equal(report.unverified.length, 7);
    assert.ok(report.violations.some((problem) => problem.code === "RELEASE_P8_UNKNOWN_ARTIFACTS"));
    assert.equal((await readFile(join(root, "dist/release/unknown"), "utf8")), "unknown", "preflight classifies without moving outputs");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("607-R2: preflight and pack share the closed Skill specification contract", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "skill/mana-orchestrate"), { recursive: true });
    await mkdir(join(root, "specs"));
    const skill = join(root, "skill/mana-orchestrate/SKILL.md");
    const name = SPECIFICATIONS[0];
    await writeFile(skill, `Read specs/${name}.\n`);
    await assert.rejects(verifySkillSpecifications(root, "skill/mana-orchestrate"), { reasonCode: "PACK_SKILL_SPEC_MISSING" });
    await writeFile(join(root, "specs", name), "# Contract\n");
    await verifySkillSpecifications(root, "skill/mana-orchestrate");
    await writeFile(skill, "Read specs/../outside.md.\n");
    await assert.rejects(verifySkillSpecifications(root, "skill/mana-orchestrate"), { reasonCode: "PACK_SKILL_SPEC_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
