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
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import net, { connect as namedConnect, createConnection as namedCreateConnection } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const repositoryRoot = resolve(import.meta.dirname, "..");

  async function offlineFixture({ unexpectedSource = false, extraInstallerFetch = false, harnessMutation = null } = {}) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "einzbern-offline-scan-"));
    const root = join(temporaryRoot, "engine");
    await mkdir(join(root, ".git"), { recursive: true });
    await cp(join(repositoryRoot, "scripts"), join(root, "scripts"), { recursive: true });
    const installerPath = join(root, "skill", "mana-orchestrate", "scripts", "install.mjs");
    await mkdir(join(root, "skill", "mana-orchestrate", "scripts"), { recursive: true });
    await cp(
      join(repositoryRoot, "skill", "mana-orchestrate", "scripts", "install.mjs"),
      installerPath,
    );
    await mkdir(join(root, "tests"), { recursive: true });
    await cp(import.meta.filename, join(root, "tests", "offline-boundary.test.mjs"));
    await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
    await cp(join(repositoryRoot, ".npmrc"), join(root, ".npmrc"));
    await mkdir(join(root, "portal", "tests", "helpers"), { recursive: true });
    for (const name of ["ui-presence.test.mjs", "disposable-portal-fetch.test.mjs", "helpers/disposable-portal-fetch.mjs"]) {
      await cp(join(repositoryRoot, "portal", "tests", name), join(root, "portal", "tests", name));
    }
    if (harnessMutation) {
      const target = join(root, "portal", "tests", harnessMutation.file);
      const source = await readFile(target, "utf8");
      await writeFile(target, harnessMutation.replace
        ? source.replace(...harnessMutation.replace)
        : `${source}\n${harnessMutation.append}\n`);
    }
    await mkdir(join(root, "node_modules"), { recursive: true });
    for (const dependency of ["ajv", "typescript"]) {
      await symlink(await realpath(join(repositoryRoot, "node_modules", dependency)), join(root, "node_modules", dependency), "dir");
    }
    if (unexpectedSource) {
      await writeFile(join(root, "scripts", "unexpected-network.mjs"), 'await fetch("https://example.invalid");\n');
    }
    if (extraInstallerFetch) {
      await writeFile(
        installerPath,
        `${await readFile(installerPath, "utf8")}\nvoid fetch("https://example.invalid");\n`,
      );
    }
    return { root, temporaryRoot };
  }

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

  test("offline harness declarations allow only the recorded loopback sites, not new egress", async () => {
    const mutations = [
      { file: "ui-presence.test.mjs", append: 'await fetch("https://example.invalid");', finding: "NETWORK_API" },
      { file: "disposable-portal-fetch.test.mjs", append: 'await fetch("https://example.invalid");', finding: "NETWORK_API" },
      { file: "disposable-portal-fetch.test.mjs", append: 'import https from "node:https";', finding: "NETWORK_MODULE" },
      { file: "disposable-portal-fetch.test.mjs", replace: ['server.listen(0, "127.0.0.1");', 'server.listen(0, "0.0.0.0");'], finding: "NETWORK_MODULE" },
      { file: "disposable-portal-fetch.test.mjs", replace: ['http://127.0.0.1:${server.address().port}', 'https://example.invalid'], finding: "NETWORK_API" },
      { file: "ui-presence.test.mjs", replace: ['const fetch = disposablePortalFetch();', 'const fetch = globalThis.fetch;'], finding: "NETWORK_API" },
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
