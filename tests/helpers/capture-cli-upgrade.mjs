// SPDX-License-Identifier: Apache-2.0
// Synthetic pre-upgrade declarations are fixture setup only. Capture and every
// readback use the supplied real child CLI, including when it is the packed entry.
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendEvents, createProject, DIRECTORY, initializeKnowledgeStore,
  initializeLibrary, sortWorkspaceSettings,
} from "../../dist/build/packages/core/src/index.js";
import { applyEngineModelPolicySet, ENGINE_MODEL_POLICY_WRITE_TARGET } from "../../dist/build/packages/core/src/engine-model-policy.js";
import { engineModelPolicyPath } from "../../dist/build/packages/core/src/device-home.js";

const at = "2026-09-08T00:00:09Z";
const fields = {
  subject: "Credentials are not a prerequisite for implementation",
  summary: "The key does not block the work",
  snippet: "Build against the interface, not the secret",
};
const translated = { subject: "凭据不是实现的前置", summary: "密钥没有批下来并不阻塞工作", snippet: "对着接口做，不对着密钥做" };
const expansions = { "zh-CN": ["凭据是不是实现的前置", "密钥没批下来能不能先做", "开发要不要等凭据"] };
const body = "The original English source body stays unchanged.";

async function snapshot(root, prefix = "") {
  const result = {};
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  for (const entry of entries) {
    const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await snapshot(join(root, entry.name), `${key}/`));
    else result[key] = (await readFile(join(root, entry.name))).toString("base64");
  }
  return result;
}

async function installPolicy(home, host, model, effort = "medium", category = "economy") {
  await applyEngineModelPolicySet({
    home, host, occurredAt: at, actor: "agent:test",
    authorization: { decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}`, target: ENGINE_MODEL_POLICY_WRITE_TARGET },
    policy: {
      categories: [{ id: category, name: category, description: "", order: 10 }],
      tiers: [{ order: 10, category, runner: host, model, effort, note: "" }],
      escalation: { enabled: false, threshold: 2, ceiling: category },
    },
  });
}

async function seed(root, model) {
  const home = join(root, "home");
  const device = join(home, "einzbern");
  const cwd = join(root, "blank-work");
  const workspace = join(root, "library");
  await mkdir(device, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = device;
  try {
    await initializeLibrary({ root: workspace, createdAt: "2026-09-08T00:00:00Z" });
    await createProject(workspace, { occurredAt: "2026-09-08T00:00:01Z", externalKey: "PR24-CAPTURE-UPGRADE", name: "Legacy language fixture" });
    for (const [index, [key, value]] of Object.entries({
      "artifact.language": "zh-CN",
      "retrieval.promptLanguages": "zh-CN",
      "models.tiers": JSON.stringify([{ order: 10, category: "economy", runner: "claude-code", model, effort: "medium", note: "" }]),
    }).entries()) {
      const occurredAt = `2026-09-08T00:00:0${index + 2}Z`;
      const record = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: 1, updatedAt: occurredAt, tombstone: false };
      await appendEvents(workspace, [(state) => ({
        payload: { operation: "settings.updated", record }, projects: state.projects, work: state.work,
        settings: sortWorkspaceSettings([...state.settings, record]),
      })], { occurredAt });
    }
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  }
  const env = { ...process.env, HOME: home, EINZBERN_HOME: device };
  for (const key of ["NODE_PATH", "TCRN_WORKFLOW_CLI", "TCRN_PORTAL_LIBRARY", "TCRN_PORTAL_PORT"]) delete env[key];
  return { cwd, env, workspace, device };
}

/** execute(args, {cwd, env}) must spawn the CLI under test, not call runCli/core. */
export async function runCaptureCliUpgradeMatrix({ root, execute }) {
  const cases = [];
  for (const model of ["claude-sonnet-5", "fixture-claude-secondary"]) {
    for (const codexPolicy of [false, true]) cases.push({ name: `legacy-${model}-${codexPolicy}`, model, codexPolicy, host: "claude-code", success: true });
  }
  cases.push(
    { name: "claude-device-priority", host: "claude-code", policy: "claude-code", bundle: "device-model", success: true },
    { name: "claude-bundle-mismatch", host: "claude-code", policy: "claude-code" },
    ...[["empty-model", "", "medium", "economy"], ["empty-effort", "device-model", "", "economy"], ["no-economy", "device-model", "medium", "main"]].map(([name, policyModel, effort, category]) => ({ name: `claude-${name}`, host: "claude-code", policy: "claude-code", policyModel, effort, category })),
    { name: "codex-device-success", host: "codex", policy: "codex", bundle: "device-model", success: true },
    { name: "codex-policy-missing", host: "codex" },
    { name: "codex-policy-corrupt", host: "codex", corrupt: true },
    { name: "claude-policy-corrupt", host: "claude-code", corrupt: true },
    { name: "host-missing", policy: "claude-code", bundle: "device-model" },
  );
  for (const item of cases) {
    const location = join(root, item.name);
    const fixture = await seed(location, item.model ?? "legacy-project-model");
    const call = (args) => execute(args, { cwd: fixture.cwd, env: fixture.env });
    const json = (args) => {
      const result = call(args);
      assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    if (item.codexPolicy) await installPolicy(fixture.device, "codex", "unrelated-codex-model");
    if (item.policy) await installPolicy(fixture.device, item.policy, item.policyModel ?? "device-model", item.effort ?? "medium", item.category ?? "economy");
    if (item.corrupt) await writeFile(engineModelPolicyPath(fixture.device), "not JSON\n");
    const bundlePath = join(location, "language-bundle.json");
    await writeFile(bundlePath, JSON.stringify({
      model: item.bundle ?? item.model ?? "legacy-project-model",
      translations: Object.fromEntries(Object.entries(fields).map(([key, value]) => [value, translated[key]])),
      expansions: { NEW: expansions },
    }));
    const settingsArgs = ["settings-catalog", "--workspace", fixture.workspace];
    const settingsReadback = () => {
      const result = call(settingsArgs);
      assert.equal(result.status, item.corrupt ? 1 : 0, `${item.name}: settings readback`);
      if (item.corrupt) assert.match(result.stderr, /ENGINE_MODEL_POLICY_FILE_INVALID/u);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const settingsBefore = settingsReadback();
    const deviceBefore = await snapshot(fixture.device);
    const before = await snapshot(fixture.workspace);
    const args = ["knowledge-capture", "--workspace", fixture.workspace, "--at", at,
      ...Object.entries(fields).flatMap(([key, value]) => [`--${key}`, value]),
      "--tags", "lesson", "--accountable-owner-id", "owner:agent-session", "--body", body,
      "--external-key", "PR24-CLI-CAPTURE", "--language-bundle", bundlePath,
      ...(item.host ? ["--host", item.host] : [])];
    const result = call(args);
    let capturedRecords;
    if (item.success) {
      assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).reasonCode, "KNOWLEDGE_UNIT_CREATED");
      const records = json(["knowledge-list", "--workspace", fixture.workspace, "--at", at]).records;
      capturedRecords = records;
      assert.equal(records.length, 1, item.name);
      const [record] = records;
      for (const key of Object.keys(fields)) assert.equal(record[key], translated[key], `${item.name}: stored ${key}`);
      assert.deepEqual(record.expansions, expansions, `${item.name}: stored expansions`);
      assert.equal(json(["knowledge-snippet", "--workspace", fixture.workspace, "--id", record.id]).snippet, translated.snippet);
      assert.equal(json(["knowledge-body", "--workspace", fixture.workspace, "--id", record.id, "--at", at]).body, body);
    } else {
      assert.equal(result.status, 1, `${item.name}: unexpected capture success`);
      assert.match(result.stderr, new RegExp(item.corrupt ? "ENGINE_MODEL_POLICY_FILE_INVALID" : "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE"), item.name);
      assert.equal(json(["knowledge-list", "--workspace", fixture.workspace, "--at", at]).records.length, 0, item.name);
    }
    assert.deepEqual(settingsReadback(), settingsBefore, `${item.name}: historical settings unchanged`);
    const deviceAfter = await snapshot(fixture.device);
    if (item.success) {
      // A successful append refreshes exactly its derived crest index. Never
      // exempt policy, identity, historical views, or an arbitrary cache subtree.
      const indexes = Object.keys(deviceBefore).filter(key => /^cache\/library-[a-f0-9]+\/crest-views\/index\.json$/u.test(key));
      assert.equal(indexes.length, 1);
      const [index] = indexes;
      const cached = JSON.parse(Buffer.from(deviceAfter[index], "base64").toString("utf8"));
      assert.equal(cached.authority, "derived-rebuildable");
      assert.equal(cached.version, 1);
      assert.deepEqual(cached.records.map(record => ({ ...record, supersedes: record.supersedes ?? null })), capturedRecords, `${item.name}: derived index reflects the one append`);
      assert.deepEqual({ ...deviceAfter, [index]: deviceBefore[index] }, deviceBefore, `${item.name}: all other device bytes, including policy and identity, unchanged`);
    } else assert.deepEqual(deviceAfter, deviceBefore, `${item.name}: refused capture leaves all device bytes unchanged`);
    const after = await snapshot(fixture.workspace);
    const historical = (files) => Object.fromEntries(Object.entries(files).filter(([key]) => !key.startsWith(`${DIRECTORY.knowledge}/`)));
    assert.deepEqual(historical(after), historical(before), `${item.name}: historical library bytes unchanged`);
    if (item.success) {
      assert.notDeepEqual(after, before, `${item.name}: knowledge append exists`);
      for (const [key, bytes] of Object.entries(before).filter(([key]) => key.startsWith(`${DIRECTORY.knowledge}/events/`))) assert.equal(after[key], bytes, `${item.name}: existing knowledge events unchanged`);
    } else assert.deepEqual(after, before, `${item.name}: refusal writes nothing`);
    assert.deepEqual(await readdir(fixture.cwd), [], `${item.name}: blank working directory remains blank`);
  }
}
