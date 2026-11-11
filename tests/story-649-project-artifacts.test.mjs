// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { appendEvents, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { createWorkspaceSettingRecord } from "../dist/build/packages/core/src/settings.js";
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
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(local, { recursive: true, force: true })]));
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
  const alias = join(base, "control-alias");
  await symlink(workspace, alias);
  const controlChild = join(workspace, "control-child");
  await mkdir(controlChild);
  const deviceChild = join(process.env.EINZBERN_HOME, "artifact-boundary");
  await mkdir(deviceChild, { recursive: true });
  for (const invalid of [invalidFile, link, join(alias, "control-child"), deviceChild, join(base, "missing", "disk"), workspace,
    `${roots[0]}/../a`, `${roots[0]}\u0000`, `${roots[0]}\\bad`, "../outside", "binding:unknown", "binding:paths.artifacts/../escape"]) {
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
  await assert.rejects(cli(["artifact-put", "--workspace", workspace, "--project-id", a, "--file", join(base, "source-0"), "--at", at]), { reasonCode: "ARTIFACT_PATH_INVALID" });
  assert.equal((await catalog(b)).deviceValue, roots[1]);
  await rename(unavailable, roots[0]);
  const readonly = join(base, "readonly");
  await mkdir(readonly);
  await chmod(readonly, 0o555);
  try {
    // Exercise the real process credentials; a string-only path rejection cannot prove permissions.
    await assert.rejects(writeFile(join(readonly, "permission-probe"), "probe"), error => ["EACCES", "EPERM"].includes(error.code));
    await assert.rejects(set(a, readonly), { reasonCode: "ARTIFACT_PATH_INVALID" });
    assert.equal((await catalog(a)).deviceValue, roots[0]);
    assert.equal((await catalog(b)).deviceValue, roots[1]);
  } finally {
    await chmod(readonly, 0o755);
  }
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

test("F649-1: a new device can read all settings and repair only its missing artifact binding", async () => {
  const base = await mkdtemp(join(tmpdir(), "story649-repair-"));
  const workspace = join(base, "library");
  const targets = [join(base, "first"), join(base, "second")];
  for (const target of targets) await mkdir(target);
  await initializeLibrary({ root: workspace, createdAt: at });
  const projectId = (await cli(["project-create", "--workspace", workspace, "--at", at, "--external-key", "REPAIR-649", "--name", "Repair"])).record.id;
  const args = ["--workspace", workspace, "--project-id", projectId];
  const set = target => cli(["settings-set", ...args, "--at", at, "--key", "workspace.generatedArtifactsPath", "--value", target]);
  const first = await set(targets[0]);
  const previous = process.env.EINZBERN_HOME;
  try {
    process.env.EINZBERN_HOME = join(base, "new-device");
    const catalog = await cli(["settings-catalog", ...args]);
    assert.ok(catalog.settings.some(row => row.key === "artifact.language"), "unrelated configuration remains accessible");
    const row = catalog.settings.find(row => row.key === "workspace.generatedArtifactsPath");
    assert.equal(row.currentValue, first.setting.value, "retain portable declaration, not a fallback");
    assert.equal(row.deviceValue, null);
    assert.equal(row.deviceStatus, "unconfigured");
    assert.equal(row.deviceReasonCode, "PATH_BINDING_UNCONFIGURED");
    await assert.rejects(cli(["artifact-list", ...args]), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
    const repaired = await set(targets[1]);
    assert.equal(repaired.deviceValue, targets[1]);
    assert.equal(repaired.deviceStatus, "ready");
    assert.equal(repaired.setting.value, first.setting.value);
    assert.equal((await cli(["artifact-list", ...args])).reasonCode, "ARTIFACT_LIST_READY");
  } finally { process.env.EINZBERN_HOME = previous; }
  const original = (await cli(["settings-catalog", ...args])).settings.find(row => row.key === "workspace.generatedArtifactsPath");
  assert.equal(original.deviceValue, targets[0]);
});

test("Story649: historical absolute records, relative roots and existing machine bindings generate and restart through the public CLI", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "story649-compatibility-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  const absolute = join(base, "historical-absolute");
  const bound = join(base, "machine-bound");
  await mkdir(absolute);
  await mkdir(join(bound, "suffix"), { recursive: true });
  await cli(["machine-settings-set", "--at", at, "--key", "paths.artifacts", "--value", bound]);
  for (const [index, value, destination] of [
    [0, absolute, absolute],
    [1, "relative-generated", join(workspace, "relative-generated")],
    [2, "binding:paths.artifacts", bound],
    [3, "binding:paths.artifacts/suffix", join(bound, "suffix")],
  ]) {
    const id = (await cli(["project-create", "--workspace", workspace, "--at", at, "--external-key", `COMPAT-649-${index}`, "--name", `Compatibility ${index}`])).record.id;
    const args = ["--workspace", workspace, "--project-id", id];
    if (index === 0) {
      // Historical event fixture via the engine append API; the current writer stores a device binding instead.
      const record = { ...createWorkspaceSettingRecord("workspace.generatedArtifactsPath", "artifacts", 1, at, workspace, id), value };
      await appendEvents(workspace, [state => ({ payload: { operation: "settings.updated", record }, projects: state.projects, work: state.work, settings: state.settings })], { occurredAt: at });
    } else {
      await cli(["settings-set", ...args, "--at", at, "--key", "workspace.generatedArtifactsPath", "--value", value]);
    }
    const file = join(base, `source-${index}.txt`);
    await writeFile(file, `compatibility artifact ${index}`);
    const fresh = spawnSync(process.execPath, [resolve("scripts/einzbern.mjs"), "artifact-put", ...args, "--file", file, "--at", at], { encoding: "utf8", env: process.env });
    assert.equal(fresh.status, 0, fresh.stderr);
    const put = JSON.parse(fresh.stdout);
    assert.equal(inflateSync(await readFile(join(destination, put.blobName))).toString(), `compatibility artifact ${index}`);
    const restarted = spawnSync(process.execPath, [resolve("scripts/einzbern.mjs"), "artifact-verify", ...args], { encoding: "utf8", env: process.env });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).checked, 1);
    const row = (await cli(["settings-catalog", ...args])).settings.find(setting => setting.key === "workspace.generatedArtifactsPath");
    assert.equal(row.currentValue, value);
    assert.equal(row.source.projectId, id);
  }
});

test("F649-1: Atelier directory control stays editable and explicitly unset without local binding", async () => {
  const { runInNewContext } = await import("node:vm");
  const html = await readFile(new URL("../portal/index.html", import.meta.url), "utf8");
  const start = html.indexOf("  const controlFor = (entry) => {");
  const end = html.indexOf("\n  };", start) + "\n  };".length;
  const render = runInNewContext(`${html.slice(start, end)}; controlFor`, {
    esc: value => String(value), t: key => key === "config.unset" ? "Unset" : key,
    controlId: (_, key) => key, settingLabel: key => key,
  });
  const result = render({ key: "workspace.generatedArtifactsPath", controlType: "text", currentValue: "binding:projectArtifacts/" + "a".repeat(64), deviceValue: null, deviceStatus: "unconfigured", defaultValue: "artifacts" });
  assert.match(result, /value=""/u);
  assert.match(result, /placeholder="Unset"/u);
  assert.match(result, /data-device-path-status="unconfigured">Unset/u);
  assert.match(result, /data-cli-action="settings-set"/u);
  assert.doesNotMatch(result, /disabled|binding:projectArtifacts/u);
});
