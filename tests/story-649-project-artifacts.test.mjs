// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";
standInForAtelier();
const at = "2026-11-10T16:00:00Z";
async function cli(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}
test("Story649: direct absolute selection, project isolation, fresh reads, actual blobs and negative paths", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "story649-"));
  const local = await mkdtemp(join(process.cwd(), ".story649-"));
  const workspace = join(local, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  const a = (await cli(["project-create", "--workspace", workspace, "--at", at, "--external-key", "ARTIFACT-A", "--name", "A"])).record.id;
  const b = (await cli(["project-create", "--workspace", workspace, "--at", at, "--external-key", "ARTIFACT-B", "--name", "B"])).record.id;
  const roots = [join(base, "a"), join(base, "b")];
  for (const path of roots) await mkdir(path);
  const set = (id, value) => cli(["settings-set", "--workspace", workspace, "--project-id", id, "--at", at, "--key", "workspace.generatedArtifactsPath", "--value", value]);
  const catalog = async (id) => (await cli(["settings-catalog", "--workspace", workspace, "--project-id", id])).settings.find(row => row.key === "workspace.generatedArtifactsPath");
  for (const [index, id] of [a, b].entries()) {
    const receipt = await set(id, roots[index]);
    assert.equal(receipt.deviceValue, roots[index]);
    assert.match(receipt.setting.value, /^binding:projectArtifacts\/[a-f0-9]{64}$/u);
    assert.equal((await catalog(id)).deviceValue, roots[index]);
    const file = join(base, `source-${index}`);
    await writeFile(file, `project-${index}`);
    const put = await cli(["artifact-put", "--workspace", workspace, "--project-id", id, "--file", file, "--at", at]);
    assert.equal(inflateSync(await readFile(join(roots[index], put.blobName))).toString(), `project-${index}`);
    const verified = await cli(["artifact-verify", "--workspace", workspace, "--project-id", id]);
    assert.equal(verified.reasonCode, "ARTIFACT_VERIFIED");
    assert.equal(verified.checked, 1);
  }
  const invalidFile = join(base, "not-directory");
  await writeFile(invalidFile, "file");
  const link = join(base, "symlink");
  await symlink(roots[0], link);
  for (const invalid of [invalidFile, link, join(base, "missing", "disk"), workspace, `${roots[0]}/../a`, `${roots[0]}\u0000`]) {
    await assert.rejects(set(a, invalid));
    assert.equal((await catalog(a)).deviceValue, roots[0]);
    assert.equal((await catalog(b)).deviceValue, roots[1]);
  }
  const freshRead = spawnSync(process.execPath, ["--input-type=module", "-e", `import { runCli } from './dist/build/packages/cli/src/index.js'; await runCli(${JSON.stringify(["settings-catalog", "--workspace", workspace, "--project-id", a])}, {write: value => process.stdout.write(value)});`], { encoding: "utf8", env: process.env });
  assert.equal(freshRead.status, 0, freshRead.stderr);
  assert.equal(JSON.parse(freshRead.stdout).settings.find(row => row.key === "workspace.generatedArtifactsPath").deviceValue, roots[0]);
  await set(a, "relative-artifacts");
  assert.equal((await catalog(a)).currentValue, "relative-artifacts");
  assert.equal((await catalog(b)).deviceValue, roots[1]);
  await set(a, roots[0]);
  assert.equal((await cli(["artifact-verify", "--workspace", workspace, "--project-id", a])).checked, 1, "returning to the old root retains readable indexed data");
  const unavailable = `${roots[0]}-unavailable`;
  await rename(roots[0], unavailable);
  await assert.rejects(cli(["artifact-verify", "--workspace", workspace, "--project-id", a]), { reasonCode: "ARTIFACT_PATH_INVALID" });
  assert.equal((await catalog(b)).deviceValue, roots[1]);
  await rename(unavailable, roots[0]);
  t.diagnostic(`actual filesystem devices: library=${(await stat(workspace)).dev}; target=${(await stat(roots[0])).dev}; cross-volume proof only when device numbers differ`);
});


test("Story649: project binding has independent locations on two device homes and no missing-device fallback", async () => {
  const { bindProjectArtifactPath, resolveProjectArtifactBinding } = await import("../dist/build/packages/core/src/artifact-path-binding.js");
  const base = await mkdtemp(join(tmpdir(), "story649-devices-"));
  const previous = process.env.EINZBERN_HOME;
  const homes = [join(base, "device-a"), join(base, "device-b")];
  try {
    process.env.EINZBERN_HOME = homes[0];
    const binding = await bindProjectArtifactPath("library:test", "project:a", join(base, "a"));
    assert.throws(() => resolveProjectArtifactBinding(binding, homes[1]), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
    process.env.EINZBERN_HOME = homes[1];
    assert.equal(await bindProjectArtifactPath("library:test", "project:a", join(base, "b")), binding);
    assert.equal(resolveProjectArtifactBinding(binding, homes[0]), join(base, "a"));
    assert.equal(resolveProjectArtifactBinding(binding, homes[1]), join(base, "b"));
  } finally { process.env.EINZBERN_HOME = previous; }
});
