// SPDX-License-Identifier: Apache-2.0
// Isolated candidate compatibility fixtures. Real installed new-session T03 is independent C4.
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { engineVersionSource, SetupRecorder } from "../dist/build/packages/core/src/setup-fresh.js";
import { HOST_SKILL_PROTOCOL_MARKER } from "../dist/build/packages/core/src/skill-render.js";
const names = ["execution-host-prepare", "execution-host-record", "execution-host-evidence"];
async function fixture(t, skill, commands) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-host-skill-install-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of [["scripts/einzbern.mjs", `process.stdout.write(JSON.stringify({ commands: ${JSON.stringify(commands.map(name => ({ name })))} }));`], ["launchers/einzbern.mjs", "// fixture"], ["launchers/hook.mjs", "// fixture"], ["skill/mana-orchestrate/SKILL.md", skill]]) {
    const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
  }
  const recorder = new SetupRecorder(join(root, "device"), "2026-10-21T00:00:00Z");
  return { root, recorder, result: await engineVersionSource(recorder, "3.1.0", root) };
}
test("matching generated Skill/engine accepted at installation, mixed pair affects installation only", async t => {
  const matching = await fixture(t, HOST_SKILL_PROTOCOL_MARKER, names); assert.equal(matching.result.directory, matching.root); assert.deepEqual(matching.recorder.blockers, []);
  const mixed = await fixture(t, HOST_SKILL_PROTOCOL_MARKER, names.slice(0, 2)); assert.equal(mixed.result.directory, null); assert.equal(mixed.recorder.blockers[0].reasonCode, "SETUP_SKILL_ENGINE_MISMATCH");
  const historical = await fixture(t, "Historical generated Skill", []); assert.equal(historical.result.directory, historical.root);
});
test("T16 installed user-edited Skill is visible and preserved by normal setup planning", async t => {
  const { installSkillCopies, skillCopyPath, SKILL_COPY_ROOTS } = await import("../dist/build/packages/core/src/skill-copies.js");
  const { computeInstallTreeDigest } = await import("../dist/build/packages/core/src/index.js");
  const { planWiring } = await import("../dist/build/packages/core/src/setup-fresh.js");
  const { readFile } = await import("node:fs/promises");
  const f = await fixture(t, HOST_SKILL_PROTOCOL_MARKER, names);
  const home = join(f.root, "user"), deviceHome = join(f.root, "device"), source = join(f.root, "skill/mana-orchestrate");
  await installSkillCopies({ home, deviceHome, source, now: "2026-10-21T00:00:00Z" });
  const edited = join(skillCopyPath(home, SKILL_COPY_ROOTS[0]), "SKILL.md"); await writeFile(edited, "User custom instructions, do not discard\n");
  const recorder = new SetupRecorder(deviceHome, "2026-10-21T00:00:01Z");
  await planWiring(recorder, { projectRoot: f.root, home, deviceHome, library: null, cloud: false, navigation: "none", deviceNavigation: null, engine: { skillDigest: (await computeInstallTreeDigest(source)).sha256, launchers: [] }, steps: new Set(["skill-copies"]) });
  assert.ok(recorder.blockers.some(b => b.reasonCode === "SETUP_SKILL_USER_EDITED")); assert.equal(await readFile(edited, "utf8"), "User custom instructions, do not discard\n");
});

test("peer-aware Skill rejects an older same-version engine without peer receipt commands", async t => {
  const peerSkill = `${HOST_SKILL_PROTOCOL_MARKER}\nUse \`execution-codex-peer-record\` and \`execution-codex-peer-evidence\`.\n`;
  const missing = await fixture(t, peerSkill, names);
  assert.equal(missing.result.directory, null);
  assert.equal(missing.recorder.blockers[0].reasonCode, "SETUP_SKILL_ENGINE_MISMATCH");
  const ready = await fixture(t, peerSkill, [...names, "execution-codex-peer-record", "execution-codex-peer-evidence"]);
  assert.equal(ready.result.directory, ready.root);
  assert.deepEqual(ready.recorder.blockers, []);
});
