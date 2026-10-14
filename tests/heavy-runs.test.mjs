// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-484 (TCRN-CROSS-STORY-529 GWT5, GWT6, GWT7; MIN-257 D6): the machine's heavy-run
// semaphore (scripts/lib/heavy-runs.mjs). With execution.maxConcurrentHeavyRuns at its default of
// one, a second taker waits, says on stderr who holds the slot, and takes it once the holder lets
// go; a run started by a holder inherits the slot through EINZBERN_HEAVY_SLOT and takes none; at
// two, two run side by side and the third waits; a value outside 1 to 16 is refused. gates-run,
// release finish and the portal train take a slot before they do anything, and the test command
// takes one before its output session. Every slot here lives in a directory of this test's own
// (EINZBERN_HEAVY_LOCK_DIR), and the token a whole-suite run hands down is kept out of every taker.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { devNull, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { DEVICE_HOME_ENTRIES, deviceHome } from "../dist/build/packages/core/src/device-home.js";
import { FILE_LOCK_SCHEMA_VERSION } from "../dist/build/packages/core/src/file-lock.js";
import { MACHINE_SETTINGS_CATALOG, MACHINE_SETTINGS_VERSION, applyMachineSettingSet, machineSettingsPath } from "../dist/build/packages/core/src/machine-settings.js";
import { DIRECTORY } from "../dist/build/packages/core/src/names.js";
import * as heavy from "../scripts/lib/heavy-runs.mjs";

// gates-config-set is Atelier's; this file declares its one gate as Atelier does.
standInForAtelier();

const repositoryRoot = resolve(import.meta.dirname, "..");
const MODULE_URL = pathToFileURL(join(repositoryRoot, "scripts/lib/heavy-runs.mjs")).href;
const KEY = "execution.maxConcurrentHeavyRuns";
let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 9, 0, second)).toISOString().replace(".000Z", "Z");
};
// A taker in a process of its own: it takes a slot for its command, prints what it got, and lets go
// when its stdin closes. "nested" also starts one taker of its own that inherits its environment;
// "once" lets go straight away.
const HOLDER = [
  'const [moduleUrl, command, mode] = process.argv.slice(2);',
  'const { acquireHeavySlot } = await import(moduleUrl);',
  'const slot = await acquireHeavySlot({ command });',
  'process.stdout.write(`${JSON.stringify({ event: "held", command, held: slot.held, inherited: slot.inherited, slot: slot.slot, variable: process.env.EINZBERN_HEAVY_SLOT ?? null })}\\n`);',
  'if (mode === "nested") {',
  '  const { spawnSync } = await import("node:child_process");',
  '  process.stdout.write(spawnSync(process.execPath, [process.argv[1], moduleUrl, `${command}-child`, "once"], { encoding: "utf8", env: process.env }).stdout);',
  '}',
  'if (mode === "once") {',
  '  slot.release();',
  '} else {',
  '  process.stdin.resume();',
  '  process.stdin.on("end", () => { slot.release(); process.stdout.write(`${JSON.stringify({ event: "released", command })}\\n`); });',
  '}',
  '',
].join("\n");

const jsonLines = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const pause = (milliseconds) => new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });

async function until(check, what, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

/** A scratch directory with a device directory, a slot directory and the taker script of its own. */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-heavy-runs-")));
  const home = join(base, "device");
  const locks = join(base, "heavy-locks");
  await mkdir(home, { recursive: true });
  const script = join(base, "holder.mjs");
  await writeFile(script, HOLDER);
  const started = [];
  context.after(async () => {
    for (const run of started) if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  });
  // The environment a taker sees: this scratch's device and slot directories, and no token handed
  // down by a run above this test.
  const environment = (extra = {}) => {
    const env = { ...process.env, EINZBERN_HOME: home, EINZBERN_HEAVY_LOCK_DIR: locks, ...extra };
    if (!Object.hasOwn(extra, heavy.HEAVY_SLOT_VARIABLE)) delete env[heavy.HEAVY_SLOT_VARIABLE];
    return env;
  };
  const track = (child) => {
    const run = { child, stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (chunk) => { run.stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { run.stderr += chunk; });
    run.closed = once(child, "close");
    run.lines = () => jsonLines(run.stdout);
    run.notices = () => jsonLines(run.stderr).filter((line) => line.reasonCode === "HEAVY_SLOT_WAITING");
    started.push(run);
    return run;
  };
  const holder = (command, { mode = "hold", env = environment() } = {}) => {
    const run = track(spawn(process.execPath, [script, MODULE_URL, command, mode], { env, stdio: ["pipe", "pipe", "pipe"] }));
    run.release = () => run.child.stdin.end();
    run.held = () => run.lines().find((line) => line.event === "held");
    return run;
  };
  return { base, home, locks, environment, track, holder };
}

test("SUB-484: the module's names are the engine's, and the slots sit in the device directory unless EINZBERN_HEAVY_LOCK_DIR moves them", async (context) => {
  assert.equal(heavy.DEVICE_DIRECTORY, DIRECTORY.device);
  assert.equal(heavy.LOCKS_DIRECTORY, DEVICE_HOME_ENTRIES.locks);
  assert.equal(heavy.MACHINE_SETTINGS_FILE, DEVICE_HOME_ENTRIES.machineSettings);
  assert.equal(heavy.MACHINE_SETTINGS_SCHEMA_VERSION, MACHINE_SETTINGS_VERSION);
  assert.equal(heavy.LOCK_SCHEMA_VERSION, FILE_LOCK_SCHEMA_VERSION);
  assert.equal(heavy.HEAVY_RUNS_SETTING, KEY);
  const { base, home } = await scratch(context);
  const env = { EINZBERN_HOME: home };
  assert.equal(heavy.deviceDirectory(env), deviceHome(env));
  assert.equal(heavy.heavyLockDirectory(env), join(deviceHome(env), DEVICE_HOME_ENTRIES.locks));
  assert.equal(heavy.heavyLockDirectory({}, base), join(base, DIRECTORY.device, DEVICE_HOME_ENTRIES.locks), "without EINZBERN_HOME, the user's home");
  assert.equal(heavy.heavyLockDirectory({ ...env, EINZBERN_HEAVY_LOCK_DIR: join(base, "shared") }), join(base, "shared"));
  assert.equal(join(heavy.deviceDirectory({ EINZBERN_HOME: process.env.EINZBERN_HOME }), heavy.MACHINE_SETTINGS_FILE), machineSettingsPath());
  assert.deepEqual([1, 2, 16].map((slot) => heavy.heavySlotPath(base, slot)), [join(base, "heavy.lock"), join(base, "heavy-2.lock"), join(base, "heavy-16.lock")]);
  const entry = MACHINE_SETTINGS_CATALOG.find((candidate) => candidate.key === KEY);
  assert.deepEqual(
    [entry.layer, entry.type, entry.controlType, entry.defaultValue, entry.min, entry.max, entry.group, entry.order, entry.shape, entry.valueSource],
    ["device", "integer", "number", String(heavy.HEAVY_RUNS_DEFAULT), heavy.HEAVY_RUNS_MIN, heavy.HEAVY_RUNS_MAX, "execution", 6, "scalar", "settings-catalog"],
  );
  assert.deepEqual([heavy.HEAVY_RUNS_DEFAULT, heavy.HEAVY_RUNS_MIN, heavy.HEAVY_RUNS_MAX], [1, 1, 16]);
});

test("SUB-484 (GWT5): at the default of one, a second taker waits, names the holder on stderr, and takes the slot once it is let go", async (context) => {
  const { locks, holder } = await scratch(context);
  const first = holder("first");
  await until(first.held, "the first taker's slot");
  assert.deepEqual({ ...first.held(), variable: undefined }, { event: "held", command: "first", held: true, inherited: false, slot: 1, variable: undefined });
  const slotFile = join(locks, "heavy.lock");
  assert.match(first.held().variable, /^[a-f0-9]{32}:/u);
  assert.equal(first.held().variable.slice(33), slotFile, "the token names the slot file it holds");
  const owner = JSON.parse(await readFile(slotFile, "utf8"));
  assert.deepEqual(Object.keys(owner), ["schemaVersion", "pid", "token", "hostname", "createdAt", "command"]);
  assert.deepEqual([owner.schemaVersion, owner.pid, owner.token, owner.command], [FILE_LOCK_SCHEMA_VERSION, first.child.pid, first.held().variable.slice(0, 32), "first"]);
  if (process.platform !== "win32") assert.equal((await stat(slotFile)).mode & 0o777, 0o600);

  const second = holder("second");
  const [notice] = await until(() => second.notices().length > 0 && second.notices(), "the second taker's notice");
  assert.deepEqual(notice, {
    reasonCode: "HEAVY_SLOT_WAITING", command: "second", slots: 1,
    holders: [{ slot: "heavy.lock", pid: first.child.pid, command: "first", since: owner.createdAt }],
  });
  await pause(300);
  assert.equal(second.held(), undefined, "the second taker is still waiting");
  assert.equal(second.notices().length, 1, "the same holder is named once");

  first.release();
  await first.closed;
  assert.deepEqual(first.lines().at(-1), { event: "released", command: "first" });
  await until(second.held, "the second taker's slot");
  assert.deepEqual([second.held().held, second.held().slot], [true, 1]);
  assert.equal(JSON.parse(await readFile(slotFile, "utf8")).command, "second");
  second.release();
  await second.closed;
  await assert.rejects(stat(slotFile), { code: "ENOENT" }, "a released slot leaves no file");
});

test("SUB-484 (GWT6): a run a holder starts inherits its slot through EINZBERN_HEAVY_SLOT and takes none, and a token that holds nothing is not trusted", async (context) => {
  const { locks, holder, environment } = await scratch(context);
  const parent = holder("parent", { mode: "nested" });
  await until(() => parent.lines().length >= 2, "the parent and its child");
  const [held, child] = parent.lines();
  assert.deepEqual([held.held, held.slot], [true, 1]);
  assert.deepEqual({ ...child, variable: undefined }, { event: "held", command: "parent-child", held: false, inherited: true, slot: null, variable: undefined });
  assert.equal(child.variable, held.variable, "the child ran under its parent's token");
  assert.equal(parent.notices().length, 0, "the child did not wait for its parent's slot");

  // The same token in a process the holder did not start, once the holder has let go, names a slot
  // that no longer carries it: that taker takes a slot of its own.
  parent.release();
  await parent.closed;
  const stale = environment({ [heavy.HEAVY_SLOT_VARIABLE]: held.variable });
  const fresh = await heavy.acquireHeavySlot({ command: "after", env: stale });
  assert.deepEqual([fresh.held, fresh.inherited, fresh.slot], [true, false, 1]);
  assert.equal(stale[heavy.HEAVY_SLOT_VARIABLE], `${fresh.token}:${join(locks, "heavy.lock")}`);
  fresh.release();
  assert.equal(stale[heavy.HEAVY_SLOT_VARIABLE], held.variable, "release puts back what the environment held");
  // A forged token naming a held slot is not the holder's either.
  const owner = holder("owner");
  await until(owner.held, "the owner's slot");
  const forged = holder("forged", { env: environment({ [heavy.HEAVY_SLOT_VARIABLE]: `${"f".repeat(32)}:${join(locks, "heavy.lock")}` }) });
  await until(() => forged.notices().length > 0, "the forged taker's notice");
  assert.equal(forged.held(), undefined);
  owner.release();
  await until(forged.held, "the forged taker's own slot");
  assert.deepEqual([forged.held().held, forged.held().inherited], [true, false]);
  forged.release();
  await forged.closed;
});

test("SUB-484 (GWT7): at two, two takers run side by side and a third waits for either", async (context) => {
  const { home, locks, holder } = await scratch(context);
  await applyMachineSettingSet({ key: KEY, value: "2", occurredAt: at(), path: join(home, "machine-settings.json") });
  const first = holder("first");
  await until(first.held, "the first slot");
  const second = holder("second");
  await until(second.held, "the second slot");
  assert.deepEqual([first.held().slot, second.held().slot], [1, 2]);
  assert.deepEqual([first.notices().length, second.notices().length], [0, 0], "neither waited");
  const third = holder("third");
  const [notice] = await until(() => third.notices().length > 0 && third.notices(), "the third taker's notice");
  assert.equal(notice.slots, 2);
  assert.deepEqual(notice.holders.map(({ slot, pid, command }) => [slot, pid, command]), [["heavy.lock", first.child.pid, "first"], ["heavy-2.lock", second.child.pid, "second"]]);
  await pause(300);
  assert.equal(third.held(), undefined);
  first.release();
  await until(third.held, "the third taker's slot");
  assert.equal(third.held().slot, 1);
  second.release();
  third.release();
  await Promise.all([first.closed, second.closed, third.closed]);
  await assert.rejects(stat(join(locks, "heavy-2.lock")), { code: "ENOENT" });
});

test("SUB-484: a value outside 1 to 16 is refused with MACHINE_SETTING_VALUE_INVALID, and an unreadable setting stops a taker", async (context) => {
  const { base, home, environment } = await scratch(context);
  const path = join(home, "machine-settings.json");
  for (const value of ["0", "17", "-1", "1.5", "two", ""]) {
    await assert.rejects(applyMachineSettingSet({ key: KEY, value, occurredAt: at(), path }), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" }, value);
  }
  for (const value of ["1", "16"]) assert.equal((await applyMachineSettingSet({ key: KEY, value, occurredAt: at(), path })).values[KEY], value);
  assert.equal(heavy.maxConcurrentHeavyRuns({ EINZBERN_HOME: home }), 16);
  // The engine's verb refuses the same values.
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    const refused = await runCli(["machine-settings-set", "--at", at(), "--key", KEY, "--value", "17"], { write() {} }).then(() => null, (error) => error);
    assert.equal(refused?.reasonCode, "MACHINE_SETTING_VALUE_INVALID");
    let output = "";
    await runCli(["machine-settings-catalog"], { write(value) { output += value; } });
    assert.equal(JSON.parse(output).settings.find((entry) => entry.key === KEY).currentValue, "16");
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  }
  // A value the file should never hold, and a file that is not one, are refused rather than read as one slot.
  const write = (values) => writeFile(path, `${JSON.stringify({ schemaVersion: MACHINE_SETTINGS_VERSION, layerKind: "machine_configuration", values, updatedAt: at() })}\n`);
  await write({ [KEY]: "0" });
  assert.throws(() => heavy.maxConcurrentHeavyRuns({ EINZBERN_HOME: home }), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" });
  await assert.rejects(heavy.acquireHeavySlot({ command: "refused", env: environment() }), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" });
  await writeFile(path, "not json\n");
  assert.throws(() => heavy.maxConcurrentHeavyRuns({ EINZBERN_HOME: home }), { reasonCode: "MACHINE_SETTINGS_FILE_INVALID" });
  await write({});
  assert.equal(heavy.maxConcurrentHeavyRuns({ EINZBERN_HOME: home }), 1, "unset, one");
  assert.equal(heavy.maxConcurrentHeavyRuns({ EINZBERN_HOME: join(base, "nowhere") }), 1, "no file, one");
  await assert.rejects(heavy.acquireHeavySlot({ command: "" }), { reasonCode: "HEAVY_SLOT_OPTIONS_INVALID" });
});

test("SUB-484: a slot whose holder on this host is dead is taken over; a malformed or foreign one is waited for", async (context) => {
  const { locks, environment } = await scratch(context);
  await mkdir(locks, { recursive: true });
  const slotFile = join(locks, "heavy.lock");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const owner = (pid, host) => `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid, token: "a".repeat(32), hostname: host, createdAt: "2026-10-14T00:00:00.000Z", command: "crashed" })}\n`;
  const notices = [];
  const stderr = { write: (text) => notices.push(...jsonLines(text)) };

  await writeFile(slotFile, owner(dead, hostname()));
  const taken = await heavy.acquireHeavySlot({ command: "after", env: environment(), stderr, timeoutMs: 5_000 });
  assert.deepEqual([taken.held, taken.slot], [true, 1]);
  assert.deepEqual(notices, [], "a dead holder is not waited for");
  taken.release();
  await assert.rejects(stat(slotFile), { code: "ENOENT" });

  for (const [text, holder] of [
    ["not an owner\n", { slot: "heavy.lock", pid: null, command: null, since: null }],
    [owner(dead, "elsewhere.invalid"), { slot: "heavy.lock", pid: dead, command: "crashed", since: "2026-10-14T00:00:00.000Z" }],
  ]) {
    notices.length = 0;
    await writeFile(slotFile, text);
    await assert.rejects(heavy.acquireHeavySlot({ command: "patient", env: environment(), stderr, timeoutMs: 300 }), { reasonCode: "HEAVY_SLOT_TIMEOUT" });
    assert.deepEqual(notices, [{ reasonCode: "HEAVY_SLOT_WAITING", command: "patient", slots: 1, holders: [holder] }]);
    assert.equal(await readFile(slotFile, "utf8"), text, "the slot file is left as it was");
  }
});

/** A Git project with one commit, a library and a device directory of this test's own, and one gate that records what it saw. */
async function gateFixture(context, base, locks) {
  const previous = { HOME: process.env.HOME, EINZBERN_HOME: process.env.EINZBERN_HOME };
  process.env.HOME = join(base, "home");
  process.env.EINZBERN_HOME = join(base, "desk");
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await mkdir(process.env.HOME, { recursive: true });
  const project = join(base, "project");
  await mkdir(project);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
  const git = (args) => execFileSync("git", ["-C", project, "-c", "user.name=heavy-runs-test", "-c", "user.email=heavy-runs-test-at-example.invalid", "-c", "commit.gpgsign=false", ...args], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  await writeFile(join(project, "README.md"), "heavy\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  const library = join(base, ".ether");
  const cli = async (args) => {
    let output = "";
    await runCli(args, { write(value) { output += value; } });
    return JSON.parse(output);
  };
  await cli(["init", "--workspace", library, "--at", at()]);
  const probe = join(base, "probe.json");
  const record = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ variable: process.env.EINZBERN_HEAVY_SLOT ?? null, owner: JSON.parse(fs.readFileSync(${JSON.stringify(join(locks, "heavy.lock"))}, "utf8")) }));`;
  await cli(["gates-config-set", "--workspace", library, "--at", at(), "--name", "probe", "--command", JSON.stringify([process.execPath, "-e", record])]);
  return { project, library, probe, cli, run: () => ["gates-run", "--workspace", library, "--at", at(), "--project", project, "--release", "true"] };
}

test("SUB-484: gates-run holds a slot while its gates run, hands it to them, and waits for one while every slot is held", async (context) => {
  const { base, locks, environment, track } = await scratch(context);
  const { probe, cli, run } = await gateFixture(context, base, locks);
  const saved = { slot: process.env[heavy.HEAVY_SLOT_VARIABLE], locks: process.env[heavy.HEAVY_LOCK_DIRECTORY_VARIABLE] };
  delete process.env[heavy.HEAVY_SLOT_VARIABLE];
  process.env[heavy.HEAVY_LOCK_DIRECTORY_VARIABLE] = locks;
  try {
    const ran = await cli(run());
    assert.deepEqual([ran.reasonCode, ran.ok, ran.run.gates.map((gate) => gate.name)], ["GATES_RUN_COMPLETED", true, ["probe"]]);
    const seen = JSON.parse(await readFile(probe, "utf8"));
    assert.deepEqual([seen.owner.command, seen.owner.pid], ["gates-run", process.pid], "the slot was held by gates-run while its gate ran");
    assert.equal(seen.variable, `${seen.owner.token}:${join(locks, "heavy.lock")}`, "the gate ran under the slot's token");
    assert.equal(process.env[heavy.HEAVY_SLOT_VARIABLE], undefined, "the token left with the slot");
    await assert.rejects(stat(join(locks, "heavy.lock")), { code: "ENOENT" });
  } finally {
    if (saved.slot === undefined) delete process.env[heavy.HEAVY_SLOT_VARIABLE];
    else process.env[heavy.HEAVY_SLOT_VARIABLE] = saved.slot;
    if (saved.locks === undefined) delete process.env[heavy.HEAVY_LOCK_DIRECTORY_VARIABLE];
    else process.env[heavy.HEAVY_LOCK_DIRECTORY_VARIABLE] = saved.locks;
  }

  // Another process's gates-run waits for a slot this test holds, and runs once it is let go. It
  // runs as this fixture's device, and its home is the private one gateFixture made under base,
  // named here rather than read back from the environment (TCRN-CROSS-SUB-492).
  const holding = await heavy.acquireHeavySlot({ command: "holder", env: environment() });
  const child = track(spawn(process.execPath, [join(repositoryRoot, "scripts/einzbern.mjs"), ...run()], { env: environment({ EINZBERN_HOME: process.env.EINZBERN_HOME, HOME: join(base, "home") }), stdio: ["ignore", "pipe", "pipe"] }));
  const [notice] = await until(() => child.notices().length > 0 && child.notices(), "gates-run's notice");
  assert.deepEqual([notice.command, notice.holders.map(({ pid, command }) => [pid, command])], ["gates-run", [[process.pid, "holder"]]]);
  await pause(300);
  assert.equal(child.stdout, "", "gates-run has not run while the slot is held");
  holding.release();
  const [code] = await child.closed;
  assert.equal(code, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(JSON.parse(await readFile(probe, "utf8")).owner.pid, child.child.pid);
});

test("SUB-484: release finish and the portal train take a slot before they do anything else", async (context) => {
  const { base, locks, environment, track } = await scratch(context);
  const holding = await heavy.acquireHeavySlot({ command: "holder", env: environment() });
  const finish = track(spawn(process.execPath, [join(repositoryRoot, "scripts/release.mjs"), "finish", "--version", "not-a-version", "--helper", base, "--workspace", base, "--project", base, "--receipt", join(base, "receipt.json")], { cwd: base, env: environment(), stdio: ["ignore", "pipe", "pipe"] }));
  // An empty PATH: were the train to start, its first step could not find pnpm and would end at once.
  const emptyPath = join(base, "empty-path");
  await mkdir(emptyPath);
  const portal = track(spawn(process.execPath, [join(repositoryRoot, "scripts/verify-portal.mjs")], { cwd: base, env: environment({ PATH: emptyPath }), stdio: ["ignore", "pipe", "pipe"] }));
  for (const [child, command] of [[finish, "release finish"], [portal, "verify:portal"]]) {
    const [notice] = await until(() => child.notices().length > 0 && child.notices(), `${command}'s notice`);
    assert.deepEqual([notice.command, notice.holders.map(({ command: holder }) => holder)], [command, ["holder"]]);
  }
  await pause(300);
  assert.deepEqual([finish.child.exitCode, portal.child.exitCode, finish.stdout, portal.stdout], [null, null, "", ""], "neither has started its work");
  holding.release();
  const [[finishCode], [portalCode]] = await Promise.all([finish.closed, portal.closed]);
  assert.equal(finishCode, 1);
  assert.equal(jsonLines(finish.stderr).at(-1).reasonCode, "RELEASE_VERSION_INVALID", "finish checked its version only once it held a slot");
  assert.notEqual(portalCode, 0, "the train's first step could not start");
  await assert.rejects(stat(join(locks, "heavy.lock")), { code: "ENOENT" }, "both let go of their slot as they ended");
});

test("SUB-484: the test command takes its slot before its output session, and the build carries the module", async () => {
  const source = await readFile(join(repositoryRoot, "scripts/task.mjs"), "utf8");
  const taking = source.indexOf('if (command === "test") heavySlot = await acquireHeavySlot({ command: "test" });');
  const session = source.indexOf("const result = await withExclusiveOutputSession(repositoryRoot, async () => invoke(command));");
  assert.ok(taking > 0 && session > taking, "the slot is taken first");
  assert.match(source, /\} finally \{\n {2}heavySlot\?\.release\(\);\n\}\n?$/u, "and let go however the command ends");
  assert.ok(source.includes('safeWriteOutput(repositoryRoot, "dist/build/scripts/lib/heavy-runs.mjs", heavyRuns)'));
  assert.deepEqual(await readFile(join(repositoryRoot, "dist/build/scripts/lib/heavy-runs.mjs")), await readFile(join(repositoryRoot, "scripts/lib/heavy-runs.mjs")), "the build's copy is the source");
});
