// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R1: the device id and display name in the device directory; a reinstall
// that loses the directory gets a new id.
// TCRN-CROSS-STORY-511 (TCRN-CROSS-INC-395): a reader that meets device.json while its creator is
// still publishing it reads the device once the staging link has gone, including when that link
// goes between the reader's lstat and its scan for it; what is not a publication still fails closed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import fsPromises, { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_SCHEMA_VERSION,
  deviceFilePath,
  displayNameFromHostname,
  readDevice,
  readOrCreateDevice,
  setDeviceDisplayName,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

async function deviceHomeFor(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-device-identity-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return join(base, "einzbern-home");
}

test("468-R1: the first use writes device.json with a random id and a name from the host", async (t) => {
  const home = await deviceHomeFor(t);
  assert.equal(await readDevice(home), null, "no device before first use, and reading creates nothing");
  const { device, created } = await readOrCreateDevice({ home, now: "2026-09-26T00:00:00Z", hostname: "Owner-MacBook.local" });
  assert.equal(created, true);
  assert.equal(device.schemaVersion, DEVICE_SCHEMA_VERSION);
  assert.match(device.deviceId, /^[a-f0-9]{32}$/u);
  assert.equal(device.displayName, "Owner-MacBook");
  assert.equal(device.createdAt, "2026-09-26T00:00:00Z");
  assert.equal(await readFile(deviceFilePath(home), "utf8"), canonicalJson(device), "the file is the canonical record");
  assert.deepEqual((await readdir(home)).sort(), ["device.json"], "no temporary is left behind");
});

test("468-R1: later uses read the same id back", async (t) => {
  const home = await deviceHomeFor(t);
  const first = await readOrCreateDevice({ home });
  const second = await readOrCreateDevice({ home });
  assert.equal(second.created, false);
  assert.deepEqual(second.device, first.device);
  assert.deepEqual(await readDevice(home), first.device);
});

test("468-R1: a reinstall that loses the device directory gets a new id", async (t) => {
  const home = await deviceHomeFor(t);
  const before = await readOrCreateDevice({ home });
  await rm(home, { recursive: true, force: true });
  const after = await readOrCreateDevice({ home });
  assert.equal(after.created, true);
  assert.notEqual(after.device.deviceId, before.device.deviceId);
});

test("468-R1: processes that start together agree on one id", async (t) => {
  const home = await deviceHomeFor(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => readOrCreateDevice({ home })));
  assert.equal(new Set(results.map((result) => result.device.deviceId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1, "exactly one of them wrote the file");
  assert.deepEqual((await readdir(home)).sort(), ["device.json"]);
});

test("468-R1: a damaged device file is an error and is never replaced by a new id", async (t) => {
  const home = await deviceHomeFor(t);
  const { device } = await readOrCreateDevice({ home });
  for (const text of ["{not json", JSON.stringify({ ...device, deviceId: "short" }), JSON.stringify({ ...device, extra: true }), JSON.stringify({ ...device, schemaVersion: "tcrn.device.v1" })]) {
    await writeFile(deviceFilePath(home), text, "utf8");
    await assert.rejects(readOrCreateDevice({ home }), (error) => error?.reasonCode === "DEVICE_FILE_INVALID");
    assert.equal(await readFile(deviceFilePath(home), "utf8"), text, "the damaged file is left for the owner to see");
  }
});

test("468-R1: the display name can be changed and the id stays", async (t) => {
  const home = await deviceHomeFor(t);
  const { device } = await readOrCreateDevice({ home, hostname: "desk" });
  const renamed = await setDeviceDisplayName("Studio desktop", home);
  assert.equal(renamed.deviceId, device.deviceId);
  assert.equal((await readDevice(home)).displayName, "Studio desktop");
  for (const bad of ["", " padded", "two\nlines", "x".repeat(65)]) {
    await assert.rejects(setDeviceDisplayName(bad, home), (error) => error?.reasonCode === "DEVICE_DISPLAY_NAME_INVALID", JSON.stringify(bad));
  }
  assert.equal(displayNameFromHostname("  \u0007  "), "device", "a host name with nothing readable still yields a name");
  assert.equal(displayNameFromHostname("x".repeat(80)).length, 64);
});

const STAGING_NAME = ".tmp-device-0123456789ab";
const OTHER_LINK_NAME = "device-copy.json";

function probeDevice() {
  return { schemaVersion: DEVICE_SCHEMA_VERSION, deviceId: "a".repeat(32), displayName: "probe", createdAt: "2026-09-29T00:00:00Z" };
}

const refusedAsInvalid = (error) => error?.reasonCode === "DEVICE_FILE_INVALID";

// Slips a step in between two of readDevice's own file system calls. The replacements are pushed
// into the ESM live bindings, so the engine's `import { readdir } from "node:fs/promises"` reaches
// them, and the originals are put back however the operation ends.
async function interleaved(replacements, operation) {
  const originals = Object.fromEntries(Object.keys(replacements).map((name) => [name, fsPromises[name]]));
  for (const [name, replacement] of Object.entries(replacements)) fsPromises[name] = replacement(originals[name]);
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    Object.assign(fsPromises, originals);
    syncBuiltinESMExports();
  }
}

// Where the creator's removal of the staging name lands in the reader's scan for it.
const STAGING_REMOVALS = Object.freeze([
  { when: "before the scan lists the directory", listed: false, remove: async (list, staging) => { await rm(staging); return list(); } },
  { when: "after the scan listed it, so the entry's lstat finds nothing", listed: true, remove: async (list, staging) => { const entries = await list(); await rm(staging); return entries; } },
]);

for (const branch of ["lstat", "handle"]) {
  for (const removal of STAGING_REMOVALS) {
    test(`511-R1: a staging link removed ${removal.when} is a finished publication (${branch} branch)`, async (t) => {
      const home = await deviceHomeFor(t);
      await mkdir(home);
      const device = probeDevice();
      const path = deviceFilePath(home);
      const staging = join(home, STAGING_NAME);
      if (branch === "lstat") {
        // The creator has linked its staging file into place and has not removed the staging name yet.
        await writeFile(staging, canonicalJson(device));
        await link(staging, path);
      } else {
        // The reader's lstat finds one link; the file it then opens has the staging link beside it.
        await writeFile(path, canonicalJson(device));
      }
      const steps = [];
      let listedStaging = null;
      const read = await interleaved({
        open: (open) => async (target, ...rest) => {
          if (branch === "handle" && target === path && !steps.includes("staging linked")) {
            await link(path, staging);
            steps.push("staging linked");
          }
          return open(target, ...rest);
        },
        readdir: (list) => async (directory, ...rest) => {
          if (directory !== home || steps.includes("staging removed")) return list(directory, ...rest);
          const entries = await removal.remove(() => list(directory, ...rest), staging);
          steps.push("staging removed");
          listedStaging = entries.includes(STAGING_NAME);
          return entries;
        },
      }, () => readDevice(home));
      assert.deepEqual(read, device, "the device is read, not refused as DEVICE_FILE_INVALID");
      assert.deepEqual(steps, branch === "lstat" ? ["staging removed"] : ["staging linked", "staging removed"], "the removal landed inside the wait of the branch under test");
      assert.equal(listedStaging, removal.listed);
      assert.equal((await lstat(path)).nlink, 1);
      assert.deepEqual(await readdir(home), ["device.json"]);
    });
  }
}

test("511-R2: a second link that is not a publication still fails closed", async (t) => {
  const device = probeDevice();

  // A second link under another name that stays: there is no publication to wait for.
  const kept = await deviceHomeFor(t);
  await mkdir(kept);
  await writeFile(deviceFilePath(kept), canonicalJson(device));
  await link(deviceFilePath(kept), join(kept, OTHER_LINK_NAME));
  await assert.rejects(readDevice(kept), refusedAsInvalid);

  // The staging name goes between the reader's lstat and its scan, but a link under another name takes its place.
  const swapped = await deviceHomeFor(t);
  await mkdir(swapped);
  await writeFile(join(swapped, STAGING_NAME), canonicalJson(device));
  await link(join(swapped, STAGING_NAME), deviceFilePath(swapped));
  let swappedInScan = false;
  await assert.rejects(interleaved({
    readdir: (list) => async (directory, ...rest) => {
      if (directory === swapped && !swappedInScan) {
        swappedInScan = true;
        await rm(join(swapped, STAGING_NAME));
        await link(deviceFilePath(swapped), join(swapped, OTHER_LINK_NAME));
      }
      return list(directory, ...rest);
    },
  }, () => readDevice(swapped)), refusedAsInvalid);
  assert.equal(swappedInScan, true);

  // The file the reader opens has gained a link under another name since its lstat (handle branch).
  const opened = await deviceHomeFor(t);
  await mkdir(opened);
  await writeFile(deviceFilePath(opened), canonicalJson(device));
  let linkedAtOpen = false;
  await assert.rejects(interleaved({
    open: (open) => async (target, ...rest) => {
      if (target === deviceFilePath(opened) && !linkedAtOpen) {
        linkedAtOpen = true;
        await link(target, join(opened, OTHER_LINK_NAME));
      }
      return open(target, ...rest);
    },
  }, () => readDevice(opened)), refusedAsInvalid);
  assert.equal(linkedAtOpen, true);

  // A staging link that is never removed outlasts the bounded wait.
  const stuck = await deviceHomeFor(t);
  await mkdir(stuck);
  await writeFile(join(stuck, STAGING_NAME), canonicalJson(device));
  await link(join(stuck, STAGING_NAME), deviceFilePath(stuck));
  await assert.rejects(readDevice(stuck), refusedAsInvalid);

  // A device.json that is not a regular file.
  const directory = await deviceHomeFor(t);
  await mkdir(deviceFilePath(directory), { recursive: true });
  await assert.rejects(readDevice(directory), refusedAsInvalid);

  for (const home of [kept, swapped, opened, stuck]) {
    assert.equal(await readFile(deviceFilePath(home), "utf8"), canonicalJson(device), "the refused file is left as it was");
  }
});

// One process of its own per caller, all on one fresh device directory: each loads the engine and
// says so, then every one of them starts on the same instant.
const FIRST_USE_PROCESS = [
  "const [core, home] = process.argv.slice(1);",
  "const { readOrCreateDevice } = await import(core);",
  "process.stdout.write(\"ready\\n\");",
  "let start = \"\";",
  "for await (const chunk of process.stdin) start += chunk;",
  "while (Date.now() < Number(start)) { /* line every process up on one instant */ }",
  "try {",
  "  const { device, created } = await readOrCreateDevice({ home });",
  "  process.stdout.write(`${JSON.stringify({ ok: true, deviceId: device.deviceId, created })}\\n`);",
  "} catch (error) {",
  "  process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? error?.code ?? null, message: String(error?.message ?? error) })}\\n`);",
  "}",
].join("\n");

function firstUseProcess(core, home) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", FIRST_USE_PROCESS, core, home], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let loaded;
  const ready = new Promise((resolve) => { loaded = resolve; });
  child.stdin.on("error", () => { /* a process that died early is reported by its result */ });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) loaded();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      loaded();
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch {
        resolve({ ok: false, reasonCode: "PROCESS_OUTPUT", message: `exit ${code ?? signal}: ${`${stdout}${stderr}`.slice(-400)}` });
      }
    });
  });
  return { child, ready, result };
}

test("511-R1: separate processes that create the device file on one instant all read it, and one of them wrote it", async (t) => {
  const core = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;
  const width = 12;
  const rounds = 8;
  for (let round = 0; round < rounds; round += 1) {
    const home = await deviceHomeFor(t);
    const processes = Array.from({ length: width }, () => firstUseProcess(core, home));
    t.after(() => {
      for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    await Promise.all(processes.map(({ ready }) => ready));
    const start = String(Date.now() + 100);
    for (const { child } of processes) child.stdin.end(start);
    const results = await Promise.all(processes.map(({ result }) => result));
    assert.deepEqual(results.filter((result) => !result.ok), [], `round ${round}: no process is refused`);
    assert.equal(new Set(results.map((result) => result.deviceId)).size, 1, `round ${round}: one id`);
    assert.equal(results.filter((result) => result.created).length, 1, `round ${round}: exactly one process wrote the file`);
    assert.deepEqual(await readdir(home), ["device.json"], `round ${round}: no staging file is left behind`);
  }
});
