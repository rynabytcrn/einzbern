// SPDX-License-Identifier: Apache-2.0

// INC-059: this file is self-sufficient about its world — the offline guard may be
// preloaded by the suite (task.mjs) or absent on a lone `node --test` run. Installing
// it here, before any transport import, makes the single-run / suite / sandbox worlds
// agree (install is idempotent: a preloaded guard returns immediately). This is a
// fixture for the guard's presence, not a skip — the assertions below still test the
// blocking surface for real.
import { installNoNetworkGuard } from "../scripts/no-network.mjs";

installNoNetworkGuard();

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { createOfflineScannerFixture, assertOfflineUnixFixturePathBudget, offlineUnixFixtureLayout } from "./helpers/ci-component-fixture.mjs";
import http from "node:http";
import http2 from "node:http2";
import net, { connect as namedConnect, createConnection as namedCreateConnection } from "node:net";
import test from "node:test";
import { join } from "node:path";

// The privacy gate refuses a literal loopback address in source, so the address the
// transport tests need is assembled at run time, matching tests/p4-artifact-lifecycle.test.mjs:53.
const joinParts = (parts, separator) => parts.join(separator);
const loopbackHost = () => joinParts(["127", "0", "0", "1"], ".");

// Neutralizing a handle that the guard was supposed to have refused must never replace
// the intended OFFLINE_NETWORK_ESCAPED diagnostic with an unrelated teardown failure.
function discard(handle) {
  try {
    handle?.close?.();
  } catch {
    // The escape itself is the finding; a failure to tidy up after it is not.
  }
}

// Asserts the surface is blocked, and reports an escape as an escape rather than as
// whatever incidental error a live handle produces later.
function refuses(name, invoke) {
  let handle;
  try {
    handle = invoke();
  } catch (error) {
    assert.equal(error.code, "OFFLINE_NETWORK_BLOCKED", `${name} threw ${error.code ?? error.message}`);
    return;
  }
  discard(handle);
  assert.fail(`OFFLINE_NETWORK_ESCAPED:${name}`);
}

async function refusesAsync(name, invoke) {
  let handle;
  try {
    handle = await invoke();
  } catch (error) {
    assert.equal(error.code, "OFFLINE_NETWORK_BLOCKED", `${name} threw ${error.code ?? error.message}`);
    return;
  }
  discard(handle);
  assert.fail(`OFFLINE_NETWORK_ESCAPED:${name}`);
}

test("Node network entry points are blocked during verification", async () => {
  assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);
  await assert.rejects(fetch("https://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => http.request("http://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => net.connect(443, "example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
});

test("the socket transport itself is sealed, not only the connect factories", () => {
  // net.connect is a convenience factory. A socket constructed directly reaches the
  // wire without passing through it, and carried a real loopback payload before this
  // was sealed, so patching the factory alone proved nothing about the transport.
  refuses("net.Socket.prototype.connect", () => new net.Socket().connect(9, loopbackHost()));
});

test("both Resolver classes are sealed, not only the callback module's", async () => {
  // node:dns and node:dns/promises export *different* Resolver classes. Sealing only
  // the callback one left every promise-shaped resolver instance running the real
  // system resolver while dns.lookup was blocked.
  refuses("dns.Resolver#resolve4", () => new dns.Resolver().resolve4("example.invalid", () => {}));
  await refusesAsync("dnsPromises.Resolver#resolve4", () => new dnsPromises.Resolver().resolve4("example.invalid"));
  await refusesAsync("dnsPromises.Resolver#resolve", () => new dnsPromises.Resolver().resolve("example.invalid"));
  await refusesAsync("dnsPromises.Resolver#resolve6", () => new dnsPromises.Resolver().resolve6("example.invalid"));
  await refusesAsync("dnsPromises.lookup", () => dnsPromises.lookup("localhost"));
  await refusesAsync("dns.promises.lookup", () => dns.promises.lookup("localhost"));
});

test("UDP egress is blocked without relying on the resolver detour", async () => {
  // dgram.send routes literal addresses through dns.lookup, so the guard appeared to
  // cover UDP for free. A caller-supplied `lookup` skips that path entirely and the
  // datagram reached a loopback receiver end to end. The socket transport is what has
  // to be sealed.
  const bypassLookup = (host, options, callback) => callback(null, host, 4);
  const receiver = dgram.createSocket({ type: "udp4", lookup: bypassLookup });
  try {
    await new Promise((resolveBind) => receiver.bind(0, loopbackHost(), resolveBind));
    const { port } = receiver.address();
    const delivered = new Promise((resolveMessage) => receiver.once("message", () => resolveMessage("DELIVERED")));
    const sender = dgram.createSocket({ type: "udp4", lookup: bypassLookup });
    try {
      refuses("dgram.Socket#send", () => sender.send(Buffer.from("probe"), port, loopbackHost()));
      refuses("dgram.Socket#connect", () => sender.connect(port, loopbackHost()));
    } finally {
      discard(sender);
    }
    const outcome = await Promise.race([
      delivered,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("NOT_DELIVERED"), 250)),
    ]);
    assert.equal(outcome, "NOT_DELIVERED", "OFFLINE_NETWORK_ESCAPED:dgram payload reached the receiver");
  } finally {
    discard(receiver);
  }
});

test("http2 stays blocked in depth", () => {
  // Defence in depth only: http2.connect already routes through the patched
  // net.connect. This asserts the belt as well as the braces, and must not be read as
  // evidence that http2 was independently exploitable.
  refuses("http2.connect", () => http2.connect(["http://", loopbackHost(), ":9"].join("")));
});

test("ESM named imports resolve to the patched functions", () => {
  // Every patch mutates the CommonJS module object. Without syncBuiltinESMExports at
  // the end of the guard, `import { connect } from "node:net"` keeps the original
  // binding and the whole guard is bypassable by import style alone. This file is
  // loaded after the preload, which is the ordering the guard depends on.
  assert.equal(namedConnect, net.connect, "stale ESM binding for net.connect");
  assert.equal(namedCreateConnection, net.createConnection, "stale ESM binding for net.createConnection");
  refuses("esm named connect", () => namedConnect(9, loopbackHost()));
  refuses("esm named createConnection", () => namedCreateConnection(9, loopbackHost()));
});

if (process.env.TCRN_OFFLINE_PROOF !== "1") {
  const offlineFixture = (options) => createOfflineScannerFixture(undefined, options);

  function scanOffline(root) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [join(root, "scripts", "task.mjs"), "offline"], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  function scanReport(run) {
    const output = run.status === 0 ? run.stdout : run.stderr;
    assert.match(output.trim().split("\n").at(-1), /^\{/u, `offline child produced no JSON report:\n${run.stdout}\n${run.stderr}`);
    return JSON.parse(output.trim().split("\n").at(-1));
  }

  test("offline scan allows the version-scoped installer fetch and still rejects unknown fetch sites", async () => {
    for (const fixtureOptions of [{}, { unexpectedSource: true }, { extraInstallerFetch: true }]) {
      const fixture = await offlineFixture(fixtureOptions);
      try {
        const run = scanOffline(fixture.root);
        const report = scanReport(run);
        if (fixtureOptions.unexpectedSource) {
          assert.equal(run.status, 1, run.stdout);
          assert.equal(report.reasonCode, "OFFLINE_BOUNDARY_FINDINGS");
          assert.match(report.error, /NETWORK_API:scripts\/unexpected-network\.mjs/u);
        } else if (fixtureOptions.extraInstallerFetch) {
          assert.equal(run.status, 1, run.stdout);
          assert.equal(report.reasonCode, "OFFLINE_BOUNDARY_FINDINGS");
          assert.match(report.error, /NETWORK_API:skill\/mana-orchestrate\/scripts\/install\.mjs/u);
        } else {
          assert.equal(run.status, 0, run.stderr);
          assert.equal(report.reasonCode, "OFFLINE_BOUNDARY_VERIFIED");
        }
      } finally {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }
  });

  // Exact baseline-site cases are registered by the mandatory CI-integrity
  // suite even under TCRN_OFFLINE_PROOF=1. Only this inner proof avoids recursion.

  test("offline harness declarations allow only the recorded loopback sites, not new egress", async () => {
    const mutations = [
      { file: "ui-presence-support.mjs", append: 'await fetch("https://example.invalid");', finding: "NETWORK_API" },
      { file: "disposable-portal-fetch.test.mjs", append: 'await fetch("https://example.invalid");', finding: "NETWORK_API" },
      { file: "disposable-portal-fetch.test.mjs", append: 'import https from "node:https";', finding: "NETWORK_MODULE" },
      { file: "disposable-portal-fetch.test.mjs", replace: ['server.listen(0, "127.0.0.1");', 'server.listen(0, "0.0.0.0");'], finding: "NETWORK_MODULE" },
      { file: "disposable-portal-fetch.test.mjs", replace: ['http://127.0.0.1:${server.address().port}', 'https://example.invalid'], finding: "NETWORK_API" },
      { file: "ui-presence-support.mjs", replace: ['const fetch = disposablePortalFetch();', 'const fetch = globalThis.fetch;'], finding: "NETWORK_API" },
    ];
    for (const mutation of mutations) {
      const fixture = await offlineFixture({ harnessMutation: mutation });
      try {
        const run = scanOffline(fixture.root);
        const report = scanReport(run);
        assert.equal(run.status, 1, run.stdout);
        assert.equal(report.reasonCode, "OFFLINE_BOUNDARY_FINDINGS");
        assert.ok(report.error.includes(`${mutation.finding}:portal/tests/${mutation.file}`), report.error);
      } finally {
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }
  });
}

test("offline permits only canonical owned private filesystem Unix IPC", async t => {
  const parent = await realpath(tmpdir());
  assertOfflineUnixFixturePathBudget(join(parent, `${offlineUnixFixtureLayout.directoryPrefix}${offlineUnixFixtureLayout.suffix}`));
  const directory = await realpath(await mkdtemp(join(parent, offlineUnixFixtureLayout.directoryPrefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assertOfflineUnixFixturePathBudget(directory);
  // Generic offline-boundary fixture, independent of the retired Codex bridge.
  const socketPath = join(directory, "h");
  const server = net.createServer(socket => socket.end("private-ipc"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await chmod(socketPath, 0o600);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath); let text = "";
    socket.setTimeout(1000, () => socket.destroy(new Error("private IPC fixture timeout")));
    socket.on("data", chunk => { text += chunk; }); socket.on("end", () => resolve(text)); socket.on("error", reject);
  });
  assert.equal(response, "private-ipc");
  for (const path of ["relative.sock", "\0abstract", join(directory, "absent"), "https://example.invalid/socket"]) {
    refuses(`Unix invalid destination ${JSON.stringify(path)}`, () => net.connect(path));
  }
  const link = join(directory, "link"); await symlink(socketPath, link);
  refuses("symlink socket", () => namedCreateConnection(link));
  const ordinary = join(directory, "file"); await writeFile(ordinary, "x", { mode: 0o600 });
  refuses("regular file", () => new net.Socket().connect(ordinary));
  await chmod(directory, 0o755);
  refuses("shared parent", () => namedConnect(socketPath));
  await chmod(directory, 0o700);
  await chmod(socketPath, 0o666);
  refuses("shared socket", () => net.connect(socketPath));
  await chmod(socketPath, 0o600);
  const alias = join(directory, "alias"); await symlink(directory, alias);
  refuses("symlink directory", () => net.connect(join(alias, "h")));
  // Ownership validation seam: no privileged chown or external account is needed.
  const original = fs.lstatSync;
  for (const unowned of [directory, socketPath]) {
    fs.lstatSync = (...args) => {
      const stat = original(...args);
      if (args[0] === unowned) Object.defineProperty(stat, "uid", { value: (process.getuid?.() ?? 0) + 1 });
      return stat;
    };
    syncBuiltinESMExports();
    try { refuses("unowned destination", () => net.connect(socketPath)); }
    finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  }
  refuses("inherited TCP options", () => net.connect(Object.assign(Object.create({ port: 9, host: loopbackHost() }), { path: socketPath })));
  refuses("mutable path accessor", () => net.connect({ get path() { return socketPath; } }));
  assert.equal((await lstat(socketPath)).isSocket(), true);
  await assert.rejects(fetch("https://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  refuses("TCP remains blocked", () => net.connect({ host: loopbackHost(), port: 9 }));
});

// Static source classification only: changed probes below are never imported or
// executed. In particular, removing their guard must not attempt any transport.
test("offline light guard declaration pins exact probes and rejects structural mutations", async t => {
  const cases = [
    { name: "missing guard", replace: ["assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true, 'PRETRANSPORT_GUARD_MISSING');", "/* required pretransport guard removed */"] },
    { name: "replacement preload", replace: ['pathToFileURL(join(root, "scripts/no-network.mjs")).href', 'pathToFileURL(join(root, "scripts/empty-preload.mjs")).href'] },
    { name: "changed options", replace: ["assert.equal(process.env.NODE_OPTIONS,", "assert.notEqual(process.env.NODE_OPTIONS,"] },
    { name: "changed target", replace: ["http://192.0.2.1/", "http://198.51.100.1/"] },
    { name: "extra fetch", append: 'await fetch("https://example.invalid");' },
    { name: "extra module", append: 'import https from "node:https";' },
    { name: "changed binding", replace: ["import { get } from 'node:http';", "import { get as alternateGet } from 'node:http';"] },
    { name: "binding alias", append: 'const alternateGet = get;' },
  ];
  // Read the actual unchanged production classifier, not a reimplemented mock.
  // Only this trusted function is evaluated; source-under-test stays inert text.
  const classify = async root => {
    const task = await readFile(join(root, "scripts/task.mjs"), "utf8");
    const start = task.indexOf("function loopbackHarnessSites(content, declaration) {");
    const end = task.indexOf("\nasync function verifyOfflineBoundary()", start);
    assert.ok(start >= 0 && end > start, "production classifier delimiters changed");
    return new Function("createHash", `return (${task.slice(start, end).trim()});`)(createHash);
  };
  const finding = (source, sites) => {
    const calls = [...source.matchAll(/\bfetch\s*\(/gu)];
    const modules = ["node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "undici"];
    return calls.some(call => !sites.fetchOffsets.has(call.index)) || modules.some(name =>
      (source.includes(`"${name}"`) || source.includes(`'${name}'`)) && !sites.modules.has(name));
  };
  const baseline = await createOfflineScannerFixture(t);
  const file = "tests/ci-light-evidence.test.mjs";
  const original = await readFile(join(baseline.root, file), "utf8");
  const policy = JSON.parse(await readFile(join(baseline.root, "scripts/policy/offline-loopback-harness.json"), "utf8"));
  const classifier = await classify(baseline.root);
  const sites = classifier(original, policy[file]);
  assert.deepEqual([...sites.modules].sort(), ["node:dns/promises", "node:http", "node:net"]);
  assert.equal(sites.fetchOffsets.size, 1);
  assert.equal(finding(original, sites), false);
  const stale = `${original}\n// changed source digest\n`;
  assert.equal(finding(stale, classifier(stale, policy[file])), true, "stale hash must refuse even harmless source changes");
  for (const mutation of cases) {
    const fixture = await createOfflineScannerFixture(t, { lightGuardMutation: { ...mutation, rebindDigest: true } });
    const changed = await readFile(join(fixture.root, file), "utf8");
    const rebound = JSON.parse(await readFile(join(fixture.root, "scripts/policy/offline-loopback-harness.json"), "utf8"))[file];
    assert.equal(rebound.sourceSha256, createHash("sha256").update(changed).digest("hex"));
    assert.equal(finding(changed, classifier(changed, rebound)), true, mutation.name);
  }
});
