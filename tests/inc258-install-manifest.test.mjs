// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-258: stopped backup mechanisms are not install obligations.
// TCRN-CROSS-INC-274: live-platform testing replaced with synthetic fixture;
// whether this machine's install surface is correct is platform-doctor's job —
// it accepts an explicit --platform-root, not a unit test.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INSTALL_MANIFEST, INSTALL_MANIFEST_REQUIRED_ITEM_IDS, assertInstallManifestComplete } from "../dist/build/packages/core/src/index.js";
import { hookLauncherPath } from "../dist/build/packages/core/src/host-hooks.js";
import { engineCurrentPath, engineLauncherPath } from "../dist/build/packages/core/src/engine-home.js";
import { skillCopiesRecordPath } from "../dist/build/packages/core/src/skill-copies.js";
import { inspectInstallWiring } from "../scripts/platform-doctor.mjs";

const REMOVED_IDS = ["machine.local-snapshot-receipt", "machine.offsite-push-receipt"];

async function createInstallFixture(context, { skipItems = [] } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc258-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "platform");
  const home = join(base, "home");

  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await mkdir(home, { recursive: true });

  // Create all manifest items except the skipped ones
  for (const entry of INSTALL_MANIFEST.items) {
    if (skipItems.includes(entry.id)) continue;

    const path = entry.pathTemplate.replaceAll("<PLATFORM_ROOT>", root).replaceAll("<HOME>", home);

    if (
      entry.acceptanceProbe.startsWith("probe:regular-directory") ||
      entry.acceptanceProbe.startsWith("probe:engine-version")
    ) {
      await mkdir(path, { recursive: true });
    } else {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{}\n");
      if (entry.acceptanceProbe.startsWith("probe:regular-executable")) {
        await chmod(path, 0o755);
      }
    }
  }

  return { root, home };
}

test("INC-258 install wiring accepts the stopped backup removal", async (context) => {
  const fixture = await createInstallFixture(context, { skipItems: REMOVED_IDS });
  const result = await inspectInstallWiring(fixture.root, fixture.home);
  assert.equal(result.ok, true);
});

test("INC-258 install manifest matches the post-removal surface and rejects restored receipts", async (context) => {
  const fixture = await createInstallFixture(context, { skipItems: REMOVED_IDS });
  assertInstallManifestComplete(INSTALL_MANIFEST);
  // 20 until TCRN-CROSS-STORY-467 R3 retired the two adapter bundles, their two install
  // receipts and the engine repository's own settings fixture; 14 since R2 retired the
  // helper trust archive; 15 since TCRN-CROSS-STORY-477 R1 added the stable hook launcher; 18 since
  // TCRN-CROSS-STORY-480 R4 added the engine pointer, the stable entry and the skill copies' record;
  // 17 since TCRN-CROSS-STORY-491 R2 (SUB-376) retired the container AGENTS.md.
  assert.equal(INSTALL_MANIFEST.items.length, 17);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST.items.some((entry) => entry.id === id)), []);
  assert.deepEqual(REMOVED_IDS.filter((id) => INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes(id)), []);
  const restored = {
    ...INSTALL_MANIFEST,
    items: [
      ...INSTALL_MANIFEST.items,
      { id: REMOVED_IDS[0], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-local.json", writer: "user-guided", acceptanceProbe: "probe:local-snapshot-freshness;maxAgeHours=26" },
      { id: REMOVED_IDS[1], layer: "machine", host: "shared", pathTemplate: "<PLATFORM_ROOT>/missing-offsite.json", writer: "user-guided", acceptanceProbe: "probe:offsite-push-freshness;maxAgeHours=26" },
    ],
  };
  const red = await inspectInstallWiring(fixture.root, fixture.home, restored);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missing.map((entry) => entry.id).sort(), [...REMOVED_IDS].sort());
});

// TCRN-CROSS-STORY-477 R1: every host hook runs the stable launcher in the device directory, so a
// device without it is not installed: the manifest names it where the host hooks point, and the
// install wiring is red when it is missing.
test("477-R1: the install manifest names the stable hook launcher the host hooks run", async (context) => {
  const entry = INSTALL_MANIFEST.items.find((item) => item.id === "machine.hook-launcher");
  assert.deepEqual({ ...entry }, {
    id: "machine.hook-launcher", layer: "machine", host: "shared", pathTemplate: "<HOME>/.einzbern/engine/hook.mjs", writer: "user-guided", acceptanceProbe: "probe:regular-file",
  });
  assert.ok(INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes("machine.hook-launcher"));
  assert.equal(entry.pathTemplate.replaceAll("<HOME>", "/opt/ada"), hookLauncherPath("/opt/ada/.einzbern", "linux"), "the path the hook commands name");
  const fixture = await createInstallFixture(context, { skipItems: [...REMOVED_IDS, "machine.hook-launcher"] });
  const red = await inspectInstallWiring(fixture.root, fixture.home);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missing.map((item) => item.id), ["machine.hook-launcher"]);
});

// TCRN-CROSS-STORY-480 R4: the device directory's own install surface, where the engine and the
// skill installer put it: the engine pointer, the stable entry that runs the current version, and
// the record of both skill copies. A device missing one of them is not installed.
test("480-R4: the install manifest names the engine pointer, the stable entry and the skill copies' record", async (context) => {
  const home = join("/opt", "ada");
  const device = join(home, ".einzbern");
  const expected = {
    "machine.engine-current": engineCurrentPath(device),
    "machine.engine-entry": engineLauncherPath(device),
    "machine.skill-copies-record": skillCopiesRecordPath(device),
  };
  for (const [id, path] of Object.entries(expected)) {
    const entry = INSTALL_MANIFEST.items.find((item) => item.id === id);
    assert.deepEqual({ ...entry, pathTemplate: null }, {
      id, layer: "machine", host: "shared", pathTemplate: null, writer: "user-guided", acceptanceProbe: "probe:regular-file",
    });
    assert.ok(entry.pathTemplate.startsWith("<HOME>/"), id);
    assert.equal(join(home, ...entry.pathTemplate.slice("<HOME>/".length).split("/")), path, `${id} names where the engine puts it`);
    assert.ok(INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes(id), `${id} is required`);
  }
  const fixture = await createInstallFixture(context, { skipItems: [...REMOVED_IDS, ...Object.keys(expected)] });
  const red = await inspectInstallWiring(fixture.root, fixture.home);
  assert.equal(red.ok, false);
  assert.deepEqual(red.missing.map((item) => item.id).sort(), Object.keys(expected).sort());
});

// TCRN-CROSS-STORY-491 R2 (SUB-376): the layout rendering pipeline is retired, and with it the
// container AGENTS.md as an install obligation. The manifest names 17 items, the required catalog
// names the same 17, and install wiring is green on a container that has no AGENTS.md at all.
// Red leg: restore the item and install wiring names it as missing.
test("SUB-376: the container AGENTS.md is no longer an install obligation", async (context) => {
  const ids = INSTALL_MANIFEST.items.map((entry) => entry.id);
  assert.equal(ids.includes("container.platform-agents"), false);
  assert.equal(INSTALL_MANIFEST_REQUIRED_ITEM_IDS.includes("container.platform-agents"), false);
  assert.deepEqual(INSTALL_MANIFEST.items.filter((entry) => entry.pathTemplate === "<PLATFORM_ROOT>/AGENTS.md"), []);
  assert.deepEqual([...INSTALL_MANIFEST_REQUIRED_ITEM_IDS].sort(), [...ids].sort());
  const fixture = await createInstallFixture(context);
  await assert.rejects(stat(join(fixture.root, "AGENTS.md")), { code: "ENOENT" });
  const green = await inspectInstallWiring(fixture.root, fixture.home);
  assert.equal(green.ok, true, JSON.stringify(green));
  assert.equal(green.itemCount, 17);
  const restored = {
    ...INSTALL_MANIFEST,
    items: [...INSTALL_MANIFEST.items, { id: "container.platform-agents", layer: "container", host: "shared", pathTemplate: "<PLATFORM_ROOT>/AGENTS.md", writer: "engine-adapter", acceptanceProbe: "probe:regular-file" }],
  };
  const red = await inspectInstallWiring(fixture.root, fixture.home, restored);
  assert.deepEqual(red.missing.map((entry) => entry.id), ["container.platform-agents"]);
});
