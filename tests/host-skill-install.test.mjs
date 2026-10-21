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
