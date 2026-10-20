// SPDX-License-Identifier: Apache-2.0
// Tests in this file run sequentially; Node isolates each file in a process.
import { CLI, R46_AT, TEST_ACTOR, assert, cli, ensureProjectCoordination, execFileAsync, join, lstat, mkdir, mkdtemp, namedRead, portalRoot, rawRequest, readBoot, readFile, readOptions, realpath, registeredLibrary, request, rm, scratch, scratchHome, servedBy, shownTarget, spawn, startPortal, startupRefusal, test, tmpdir, writeFile, writeOptions } from "./portal-support.mjs";



test("state surface uses the doctor's eight checks and selected library projection", async (t) => {
  const fixture = await scratch("tcrn-portal-state-", "TCRN-PORTAL-STATE");
  const wrapper = join(fixture.base, "status-wrapper.mjs");
  await writeFile(wrapper, `import { spawnSync } from "node:child_process";
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
if (process.argv[2] === "status" && actual.status === 0) {
  const body = JSON.parse(actual.stdout);
  body.engineVersion = "0.11.99";
  process.stdout.write(JSON.stringify(body));
} else if (process.argv[2] === "doctor" && actual.status === 0 && process.env.TCRN_TEST_DOCTOR_RED === "registry") {
  const body = JSON.parse(actual.stdout);
  body.checks = body.checks.map((check) => check.check === "registry" ? { ...check, ok: false, reasonCode: "PORTAL_TEST_REGISTRY_RED", detail: { causes: ["PORTAL_TEST_REGISTRY_RED"] } } : check);
  body.ok = false;
  process.stdout.write(JSON.stringify(body));
} else {
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
  const { child, url } = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: wrapper } });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.engineVersion, "0.11.99");
  const doctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.equal(status.body.checks.length, 8);
  assert.deepEqual(status.body.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), doctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.equal(status.body.ok, doctor.ok);
  assert.equal(status.body.doctorReasonCode, doctor.checks.find((check) => !check.ok)?.reasonCode ?? doctor.reasonCode);
  const libraryStatus = await cli(["status", "--workspace", fixture.workspace], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.deepEqual(status.body.library, {
    versionVector: libraryStatus.versionVector,
    streams: libraryStatus.streams,
    rejectedEventCount: libraryStatus.rejectedEventCount,
    configProjection: libraryStatus.configProjection,
  });

  child.kill();
  const redPortal = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: wrapper, TCRN_TEST_DOCTOR_RED: "registry" } });
  t.after(() => redPortal.child.kill());
  const { boot: redBoot } = await readBoot(redPortal.url);
  const redStatus = await request(redPortal.url, "/api/status", readOptions(redBoot.token));
  const { stdout: redDoctorOutput } = await execFileAsync(process.execPath, [wrapper, "doctor", "--project", fixture.proseRoot], {
    encoding: "utf8", env: { ...process.env, ...fixture.deviceEnv, HOME: fixture.home, TCRN_TEST_DOCTOR_RED: "registry" },
  });
  const redDoctor = JSON.parse(redDoctorOutput);
  assert.equal(redStatus.body.ok, false);
  assert.deepEqual(redStatus.body.checks, redDoctor.checks);
  assert.equal(redStatus.body.doctorReasonCode, redDoctor.checks.find((check) => !check.ok)?.reasonCode ?? redDoctor.reasonCode);
  assert.equal(redStatus.body.checks.find((check) => check.check === "registry").reasonCode, "PORTAL_TEST_REGISTRY_RED");
});



test("launcher generation emits regular files that carry only --library, starts the macOS launcher, and names a library the device has not registered", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-launchers-", "TCRN-PORTAL-LAUNCH");
  const outputDir = join(fixture.base, "launchers");
  await mkdir(outputDir);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const generator = join(portalRoot, "scripts", "generate-launchers.mjs");
  const report = JSON.parse((await execFileAsync(process.execPath, [generator, "--library", fixture.workspace, "--output-dir", outputDir, "--port", "0"], { encoding: "utf8" })).stdout);
  assert.equal(report.reasonCode, "PORTAL_LAUNCHERS_GENERATED");
  assert.equal(report.library, fixture.workspace);
  assert.equal(report.symlinks, false);
  assert.equal(report.files.length, 3);
  for (const file of report.files) {
    assert.equal((await lstat(file)).isFile(), true);
    assert.equal((await lstat(file)).isSymbolicLink(), false);
    const text = await readFile(file, "utf8");
    assert.match(text, /--library/u);
    assert.doesNotMatch(text, /--container|--prose-root|--workspace|--partition/u);
  }
  const command = report.files.find((file) => file.endsWith(".command"));
  assert.match(await readFile(command, "utf8"), /^#!\/bin\/sh/u);
  const launcher = spawn(command, [], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: TEST_ACTOR, ...fixture.deviceEnv, HOME: fixture.home }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => launcher.kill());
  const url = await new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error(`launcher timeout: ${buffer}`)), 15000); launcher.stdout.on("data", (chunk) => { buffer += chunk; const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING")); if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); } }); launcher.on("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${buffer}`)); }); });
  const { boot: launcherBoot } = await readBoot(url);
  assert.equal(launcherBoot.library.libraryPath, fixture.workspace);
  assert.equal((await request(url, "/api/libraries", readOptions(launcherBoot.token))).body.libraries.length, 2);

  // --library is optional: without it the launcher names no library and the portal chooses at start.
  const plainOutput = join(fixture.base, "plain-launchers");
  await mkdir(plainOutput);
  const plain = JSON.parse((await execFileAsync(process.execPath, [generator, "--output-dir", plainOutput, "--port", "0"], { encoding: "utf8" })).stdout);
  assert.equal(plain.library, null);
  for (const file of plain.files) assert.doesNotMatch(await readFile(file, "utf8"), /--library/u);

  const vanished = join(fixture.base, "vanished-library");
  const badOutput = join(fixture.base, "bad-launchers");
  await mkdir(badOutput);
  await execFileAsync(process.execPath, [generator, "--library", vanished, "--output-dir", badOutput, "--port", "0"], { encoding: "utf8" });
  let failure;
  try { await execFileAsync(join(badOutput, "atelier.sh"), [], { encoding: "utf8", env: { ...process.env, TCRN_PORTAL_ACTOR: TEST_ACTOR, ...fixture.deviceEnv, HOME: fixture.home } }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(String(failure.stderr), /PORTAL_LIBRARY_UNKNOWN/u);
});



// R46 I03 (PP-2; approved contract items 6, 7): a target whose saved common default does not resolve is
// still read: /api/settings answers the catalog with commonDefault and the rows that would inherit marked
// unresolved, the configuration scope can be switched to it, and removing the common default through
// /api/project-bindings reads it plainly again.
test("INIT-053 R46 I03: a target with an unresolved common default is read, switched to and repaired", async t => {
  const fixture = await scratch("portal-r46-common-", "R46-COMMON");
  await ensureProjectCoordination(fixture.workspace, R46_AT, fixture.deviceEnv.EINZBERN_HOME);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const unregistered = { libraryId: "library:" + "c".repeat(24), projectId: "project:" + "d".repeat(24) };
  const saved = await request(url, "/api/project-bindings", writeOptions(boot.token, "POST", { key: "common-default", value: unregistered }));
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  assert.deepEqual(settings.body.commonDefault, { reference: unregistered, status: "unresolved", targetStatus: "unregistered", reason: "common-default-unresolved" });
  const authority = settings.body.settings.find(entry => entry.key === "design.authority");
  assert.deepEqual([authority.currentValue, authority.source.kind, authority.source.status, authority.source.libraryId], [null, "common", "unresolved", unregistered.libraryId]);
  // The scope can leave the target and come back to it.
  const away = await request(url, "/api/configuration-scope", writeOptions(boot.token, "POST", { projectId: null }));
  assert.equal(away.response.status, 200);
  const back = await request(url, "/api/configuration-scope", writeOptions(boot.token, "POST", { projectId: fixture.projectId }));
  assert.equal(back.response.status, 200, JSON.stringify(back.body));
  assert.deepEqual([back.body.reasonCode, back.body.settings.commonDefault.status], ["PORTAL_CONFIGURATION_SCOPE_SELECTED", "unresolved"]);
  // The repair the page offers: take the common default out.
  const removed = await request(url, "/api/project-bindings", writeOptions(boot.token, "DELETE", { key: "common-default" }));
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  const repaired = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(Object.hasOwn(repaired.body, "commonDefault"), false);
  assert.equal(repaired.body.settings.some(entry => entry.source?.status === "unresolved"), false);
});



// R46 I05 (approved contract item 11; U20 D13): every answer names the target it was served for, refusals
// and device-wide routes included; a read that names another target than the one it would be served is
// refused with the selection as it is, a read that names none is served as before, and each switch's
// answer names the target it selected. A project path in any script survives the header.
test("INIT-053 R46 I05: answers name the target they served, and a read naming a stale target is refused", async t => {
  const fixture = await scratch("portal-r46-served-", "R46-SERVED");
  const wide = join(fixture.base, "项目-ü-second");
  await mkdir(wide);
  await cli(["library-register", "--project", wide, "--library", fixture.second.library, "--project-id", fixture.second.projectId, "--at", R46_AT], fixture.deviceEnv);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const first = shownTarget(boot.library, boot.epoch);
  assert.deepEqual(first, { epoch: boot.epoch, libraryId: boot.library.libraryId, projectPath: fixture.proseRoot, projectId: fixture.projectId, chainRole: null });
  const routes = [
    ["/api/settings", 200], ["/api/libraries", 200], ["/api/project-targets", 200], ["/api/machine-settings", 200], ["/api/vocabulary", 200], ["/api/commands", 200],
    ["/api/work", 200], ["/api/knowledge", 200], ["/api/rules", 200], ["/api/variables", 200], ["/api/gates", 200], ["/api/gates/last-run", 200],
    ["/api/agents-md", 200], ["/api/agents-md/reconcile", 200], ["/api/knowledge?status=bogus", 400], ["/api/execution", 404],
  ];
  for (const [path, status] of routes) {
    const answer = await request(url, path, readOptions(boot.token));
    assert.equal(answer.response.status, status, path);
    assert.deepEqual(servedBy(answer.response), first, `${path} names the target it served`);
  }
  const refusedWrite = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "bogus.key", value: "x" }));
  assert.deepEqual([refusedWrite.response.status, servedBy(refusedWrite.response)], [409, first], "a refused write names its target too");
  const untokened = await fetch(new URL("/api/settings", url));
  assert.equal(untokened.status, 403);
  assert.equal(untokened.headers.get("x-portal-served-target"), null, "a request without the token is told nothing about the selection");
  const forged = await rawRequest(url, "/api/settings", { host: "attacker.example", headers: { "x-portal-token": boot.token } });
  assert.equal(forged.status, 403);

  // A read naming the target it is served for is answered; one naming another epoch, project path or
  // project is refused with the selection as it is.
  const named = await request(url, "/api/settings", namedRead(boot.token, first));
  assert.deepEqual([named.response.status, servedBy(named.response)], [200, first]);
  const selection = { epoch: first.epoch, libraryId: first.libraryId, projectPath: first.projectPath, projectId: first.projectId, name: "R46-SERVED", chainRole: null };
  for (const stale of [{ ...first, epoch: first.epoch + 1 }, { ...first, projectPath: fixture.second.project }, { ...first, projectId: null }, { ...first, libraryId: "library:" + "e".repeat(24) }]) {
    const refused = await request(url, "/api/settings", namedRead(boot.token, stale));
    assert.deepEqual([refused.response.status, refused.body.reasonCode, refused.body.target], [409, "PORTAL_CONFIGURATION_TARGET_CHANGED", selection], JSON.stringify(stale));
  }
  const malformed = await request(url, "/api/work", { headers: { "x-portal-token": boot.token, "x-configuration-target": "not json" } });
  assert.equal(malformed.response.status, 409);

  // Another client switches the library: this client's read naming its old target is refused, not answered
  // with the other library's values, and a read naming none is the new selection's.
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: wide }));
  assert.equal(switched.response.status, 200, JSON.stringify(switched.body));
  const second = shownTarget(switched.body.library, switched.body.epoch);
  assert.deepEqual(second, { epoch: switched.body.epoch, libraryId: switched.body.library.libraryId, projectPath: wide, projectId: fixture.second.projectId, chainRole: null }, "a project path in any script survives the header");
  assert.deepEqual(servedBy(switched.response), second, "the switch's answer names the target it selected");
  assert.equal(servedBy(switched.response).epoch, switched.body.epoch);
  const stale = await request(url, "/api/settings", namedRead(boot.token, first));
  assert.deepEqual([stale.response.status, stale.body.target.libraryId, stale.body.target.projectPath, stale.body.target.epoch, stale.body.settings], [409, second.libraryId, wide, second.epoch, undefined]);
  const plain = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual([plain.response.status, servedBy(plain.response)], [200, second]);
  // The configuration scope's answer names the target it selects.
  const scoped = await request(url, "/api/configuration-scope", writeOptions(boot.token, "POST", { projectId: fixture.second.projectId }));
  assert.equal(scoped.response.status, 200, JSON.stringify(scoped.body));
  assert.deepEqual(servedBy(scoped.response), { ...second, epoch: scoped.body.epoch });
  // A write naming the old target is still refused (F05), now with the selection's six keys.
  const staleWrite = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json", "x-portal-token": boot.token, "x-configuration-target": JSON.stringify(first) }, body: JSON.stringify({ key: "artifact.language", value: "fr" }) });
  assert.deepEqual([staleWrite.response.status, staleWrite.body.reasonCode, Object.keys(staleWrite.body.target).sort()], [409, "PORTAL_CONFIGURATION_TARGET_CHANGED", ["chainRole", "epoch", "libraryId", "name", "projectId", "projectPath"]]);
});




test("Portal rejects relative EINZBERN_HOME before library selection in every cwd", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "portal-relative-device-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const alternate = join(base, "other");
  await mkdir(alternate);
  for (const cwd of [base, alternate]) {
    await assert.rejects(execFileAsync(process.execPath, [join(portalRoot, "portal.mjs"), "--library", join(base, "not-a-library"), "--port", "0"], {
      cwd, env: { ...process.env, EINZBERN_HOME: "relative-device", HOME: base, TCRN_PORTAL_ACTOR: TEST_ACTOR }, encoding: "utf8",
    }), (error) => {
      assert.equal(error.code, 2, error.stderr);
      assert.equal(error.stdout, "");
      const lines = error.stderr.trim().split("\n");
      assert.equal(lines.length, 1, error.stderr);
      const failure = JSON.parse(lines[0]);
      assert.deepEqual([failure.ok, failure.reasonCode], [false, "DEVICE_HOME_INVALID"]);
      assert.match(failure.error, /absolute device directory/u);
      return true;
    });
    await assert.rejects(lstat(join(cwd, "relative-device")), { code: "ENOENT" });
  }
});



// TCRN-CROSS-STORY-482 R3, AC1: the registry's two libraries are listed and can be switched, and
// each one answers with its own status. The second library carries one event of its own, so the
// two statuses differ in more than their ids.
test("STORY-482 AC1: the registry's two libraries can be switched, and each answers with its own status", async (t) => {
  const fixture = await scratch("tcrn-portal-libraries-", "TCRN-PORTAL-LIBRARIES");
  await cli(["settings-set", "--workspace", fixture.second.library, "--at", "2026-08-11T15:01:00Z", "--actor", "agent:test", "--key", "artifact.language", "--value", "zh-CN"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const first = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const firstDoctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
  const secondDoctor = await cli(["doctor", "--project", fixture.second.project], { ...fixture.deviceEnv, HOME: fixture.home });
  const { child, url, listening } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  assert.equal(listening.selectedBy, "argument");
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  assert.equal(listed.body.reasonCode, "PORTAL_LIBRARIES_READY");
  // The registry's name for a library is what project-list says of its project: its canonical name
  // (TCRN-CROSS-INIT-053 R46 I01; the fixture names each project by its external key).
  const firstName = (await cli(["project-list", "--workspace", fixture.workspace], fixture.deviceEnv)).records.find(record => record.id === fixture.projectId).name;
  const secondName = (await cli(["project-list", "--workspace", fixture.second.library], fixture.deviceEnv)).records.find(record => record.id === fixture.second.projectId).name;
  assert.deepEqual([firstName, secondName], ["TCRN-PORTAL-LIBRARIES", "TCRN-PORTAL-LIBRARIES-SECOND"]);
  assert.equal(boot.libraryName, firstName);
  assert.deepEqual(listed.body.libraries, [
    { projectPath: fixture.proseRoot, projectId: fixture.projectId, configurationProjectId: null, libraryId: first.workspaceId, libraryPath: fixture.workspace, name: firstName, chain: null },
    { projectPath: fixture.second.project, projectId: fixture.second.projectId, configurationProjectId: null, libraryId: second.workspaceId, libraryPath: fixture.second.library, name: secondName, chain: null },
  ]);
  assert.deepEqual(listed.body.selected, { ...listed.body.libraries[0], configurationProjectId: fixture.projectId });
  assert.deepEqual(boot.libraries, listed.body.libraries);

  const statusNow = async () => (await request(url, "/api/status", readOptions(boot.token))).body;
  const languageNow = async () => (await request(url, "/api/settings", readOptions(boot.token))).body.settings.find((entry) => entry.key === "artifact.language").currentValue;
  let status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, first.version]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);
  assert.equal(status.library.rejectedEventCount, first.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, first.configProjection);
  assert.equal(await languageNow(), "en");

  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.project }));
  assert.equal(switched.response.status, 200);
  assert.equal(switched.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.deepEqual(switched.body.library, { ...listed.body.libraries[1], configurationProjectId: listed.body.libraries[1].projectId });
  assert.equal(switched.body.libraryName, secondName);
  assert.equal(switched.body.workspace, fixture.second.library);
  assert.equal(switched.body.proseRoot, fixture.second.project);
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [second.workspaceId, second.version]);
  assert.equal(status.ok, secondDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), secondDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, second.versionVector);
  assert.equal(status.library.rejectedEventCount, second.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, second.configProjection);
  assert.equal(await languageNow(), "zh-CN");
  assert.deepEqual((await request(url, "/api/libraries", readOptions(boot.token))).body.selected, { ...listed.body.libraries[1], configurationProjectId: fixture.second.projectId });

  // A library is named by its id too; the switch back reads the first library again.
  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: first.workspaceId }));
  assert.equal(back.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, first.version]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);

  const unknown = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: join(fixture.base, "not-a-library") }));
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal((await statusNow()).workspaceId, first.workspaceId, "a refused switch leaves the selection alone");
  // The partition catalog and its switch are gone with the container.
  for (const path of ["/api/partitions", "/api/partition"]) {
    const retired = await request(url, path, readOptions(boot.token));
    assert.equal(retired.response.status, 404, path);
    assert.equal(retired.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", path);
  }
});



test("STORY-355 GWT1+GWT2: a forged Host header is refused on every route, and the token now guards every GET under /api/", async (t) => {
  const fixture = await scratch("tcrn-portal-security-", "TCRN-PORTAL-SECURITY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  // GWT1: a DNS-rebinding-style Host header is rejected before any route runs at all,
  // including "/" -- the real TCP connection still lands on loopback (rawRequest talks
  // to the portal's actual address), only the Host header is forged.
  const rootForged = await rawRequest(url, "/", { host: "attacker.example" });
  assert.equal(rootForged.status, 403);
  assert.equal(rootForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const prefixForged = await rawRequest(url, "/api/settings", { host: "127.0.0.1.attacker.example" });
  assert.equal(prefixForged.status, 403);
  assert.equal(prefixForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const badPort = await rawRequest(url, "/api/settings", { host: "127.0.0.1:notaport" });
  assert.equal(badPort.status, 403);
  assert.equal(badPort.body.reasonCode, "PORTAL_HOST_REJECTED");
  const upperLocalhost = await rawRequest(url, "/api/settings", { host: "LOCALHOST", headers: { "x-portal-token": boot.token } });
  assert.equal(upperLocalhost.status, 200);

  // GWT2: token coverage now spans GET, not just the mutating verbs it used to guard alone.
  const untokenedGet = await request(url, "/api/settings");
  assert.equal(untokenedGet.response.status, 403);
  assert.equal(untokenedGet.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const tokenedGet = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(tokenedGet.response.status, 200);
});



// TCRN-CROSS-STORY-482 R3: without --library the portal chooses from the registry by where it was
// started: the library of the registered project it runs in (library-resolve), else the machine's
// default library when that names a registered one, else the first registered library.
test("STORY-482 R3: without --library the portal opens the working directory's library, then the machine's default library, then the first registered one", async (t) => {
  const fixture = await scratch("tcrn-portal-default-library-", "TCRN-PORTAL-DEFAULT-LIBRARY");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const open = async (cwd) => {
    const portal = await startPortal({ ...fixture, library: null, cwd });
    try {
      const { boot } = await readBoot(portal.url);
      return { selectedBy: portal.listening.selectedBy, libraryPath: boot.library.libraryPath, proseRoot: boot.proseRoot };
    } finally { portal.child.kill(); }
  };
  assert.deepEqual(await open(fixture.second.project), { selectedBy: "working-directory", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  await cli(["machine-settings-set", "--at", "2026-08-11T15:03:00Z", "--key", "portal.defaultPartition", "--value", second.workspaceId], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "machine-default", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  // A default that names no registered library (an old partition id, say) is passed over.
  await cli(["machine-settings-set", "--at", "2026-08-11T15:04:00Z", "--key", "portal.defaultPartition", "--value", "cross-project"], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "first-registered", libraryPath: fixture.workspace, proseRoot: fixture.proseRoot });
});



// STORY-355 carried over to libraries: AGENTS.md is the project's prose and never a file inside a
// library, which only the engine writes. A project registered inside its own library is refused
// at boot and on a switch, and the refusal names the path.
test("STORY-355: a project registered inside its own library is refused at boot and on a switch", async (t) => {
  const fixture = await scratch("tcrn-portal-prose-unsafe-", "TCRN-PORTAL-PROSE-UNSAFE");
  const nested = join(fixture.second.library, "nested-project");
  await mkdir(nested);
  await cli(["library-register", "--project", nested, "--library", fixture.second.library, "--project-id", fixture.second.projectId, "--at", "2026-08-11T15:05:00Z"], fixture.deviceEnv);
  const refused = await startupRefusal(["--library", nested], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.equal(refused.status, 2);
  assert.equal(refused.report.ok, false);
  assert.equal(refused.report.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal(refused.report.proseRoot, nested);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: nested }));
  assert.equal(switched.response.status, 409);
  assert.equal(switched.body.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal((await request(url, "/api/libraries", readOptions(boot.token))).body.selected.libraryPath, fixture.workspace, "a refused switch leaves the selection alone");
});



// TCRN-CROSS-STORY-482 R3: a library outside the registry is not something Atelier opens. With no
// registered library the portal refuses to start and names the remedy; a --library the device has
// not registered is named back, with the libraries it has.
test("STORY-482 R3: the portal refuses to start with no registered library, and names a --library the device has not registered", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-no-library-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = await scratchHome(base);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const empty = await startupRefusal([], { ...deviceEnv, HOME: home }, base);
  assert.equal(empty.status, 2);
  assert.equal(empty.report.reasonCode, "PORTAL_LIBRARY_REGISTRY_EMPTY");
  assert.equal(empty.report.remedy, "library-register");
  const project = join(base, "project");
  await registeredLibrary(deviceEnv, project, join(project, ".ether"), "TCRN-PORTAL-NO-LIBRARY", "2026-08-11T15:00:00Z");
  const loose = join(base, "unregistered-library");
  await cli(["init", "--workspace", loose, "--project-name", "TCRN-PORTAL-UNREGISTERED", "--at", "2026-08-11T15:00:01Z"], deviceEnv);
  const unknown = await startupRefusal(["--library", loose], { ...deviceEnv, HOME: home }, base);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.report.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal(unknown.report.requestedLibrary, loose);
  assert.deepEqual(unknown.report.libraries, [join(project, ".ether")]);
});
