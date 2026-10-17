// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { portalFixture } from "./helpers/portal-fixture.mjs";

const url = "http://127.0.0.1:12345";
const announcement = JSON.stringify({ reasonCode: "PORTAL_LISTENING", url }) + "\n";
const ready = `process.stdout.write(${JSON.stringify(announcement)});`;
const keepAlive = "setInterval(() => {}, 1000);";
const missing = (path) => assert.rejects(access(path), { code: "ENOENT" });

// Tiny real child processes exercise the same spawn/error/close events as the server,
// without a library or a port. No test depends on the product's startup speed.
test("fixture registers cleanup before setup and removes the directory when setup fails", async (t) => {
  const hooks = [];
  const fixture = await portalFixture({ after: (hook) => hooks.push(hook) }, "portal-fixture-setup-");
  t.after(fixture.cleanup);
  assert.equal(hooks.length, 1);
  await assert.rejects(async () => {
    await writeFile(join(fixture.base, "partial-setup"), "created before failure");
    throw new Error("CLI setup failed");
  }, /CLI setup failed/u);
  await hooks[0]();
  await missing(fixture.base);
});

test("fixture accepts a split announcement, waits for exit before removal, and cleans up once", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-exit-");
  const source = `
    const { existsSync } = require("node:fs");
    process.on("SIGTERM", () => setTimeout(() => {
      process.exit(existsSync(${JSON.stringify(fixture.base)}) ? 0 : 7);
    }, 50));
    process.stdout.write(${JSON.stringify(announcement.slice(0, -2))});
    setTimeout(() => process.stdout.write(${JSON.stringify(announcement.slice(-2))}), 20);
    ${keepAlive}
  `;
  const portal = await fixture.start(["-e", source]);
  assert.equal(portal.url, url);
  const first = fixture.cleanup();
  assert.strictEqual(fixture.cleanup(), first, "concurrent cleanup joins the same work");
  await first;
  assert.equal(portal.child.exitCode, 0, "the scratch directory still existed during child shutdown");
  await missing(fixture.base);
  assert.strictEqual(fixture.cleanup(), first, "later cleanup is also idempotent");
  await fixture.cleanup();
  await assert.rejects(fixture.start(["-e", ready]), /already cleaned up/u);
});

test("fixture drains stderr while waiting for the listening announcement", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-stderr-");
  const portal = await fixture.start(["-e", `process.stderr.write("x".repeat(256 * 1024), () => { ${ready} }); ${keepAlive}`]);
  assert.equal(portal.url, url, "stderr larger than a pipe buffer cannot stall startup");
  await assert.rejects(fixture.start(["-e", ready]), /already has a process/u);
});

test("fixture reports asynchronous spawn errors and cleans up even without an exit event", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-spawn-");
  await assert.rejects(fixture.start(["-e", ready], { cwd: join(fixture.base, "missing") }), (error) => {
    assert.match(error.message, /portal startup failed/u);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
  await missing(fixture.base);
  await fixture.cleanup();
});

test("fixture cleans up when spawn throws synchronously", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-spawn-throw-");
  await assert.rejects(fixture.start(["-e", ready], { cwd: 42 }), (error) => {
    assert.equal(error.cause.code, "ERR_INVALID_ARG_TYPE");
    return true;
  });
  await missing(fixture.base);
});

test("fixture reports stdout and stderr when the process exits before listening", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-early-exit-");
  await assert.rejects(fixture.start(["-e", "process.stdout.write('starting'); process.stderr.write('configuration failed'); process.exitCode = 7;"]), (error) => {
    assert.match(error.message, /portal exited 7/u);
    assert.match(error.message, /stdout:\nstarting/u);
    assert.match(error.message, /stderr:\nconfiguration failed/u);
    return true;
  });
  await missing(fixture.base);
});

test("fixture terminates a timed-out startup and includes both output streams", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-timeout-");
  await assert.rejects(fixture.start(["-e", `process.stdout.write('PID:' + process.pid + '\\n'); process.stderr.write('still starting'); ${keepAlive}`], { startupTimeoutMs: 1000 }), (error) => {
    assert.match(error.message, /portal did not start/u);
    assert.match(error.message, /stderr:\nstill starting/u);
    const pid = Number(error.message.match(/PID:(\d+)/u)?.[1]);
    assert.ok(Number.isSafeInteger(pid), "startup diagnostics include the real child PID");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "startup rejection waits for the child to exit");
    return true;
  });
  await missing(fixture.base);
});

for (const line of ["{PORTAL_LISTENING}\n", '{"reasonCode":"PORTAL_LISTENING"}\n']) {
  test(`fixture rejects an invalid listening announcement: ${line.trim()}`, async (t) => {
    const fixture = await portalFixture(t, "portal-fixture-invalid-");
    await assert.rejects(fixture.start(["-e", `process.stderr.write('bad announcement'); process.stdout.write(${JSON.stringify(line)}); ${keepAlive}`]), (error) => {
      assert.match(error.message, /invalid listening announcement/u);
      assert.match(error.message, /bad announcement/u);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    await missing(fixture.base);
  });
}

test("fixture cleanup does not wait for another exit after the child already died by signal", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-signal-");
  const { child } = await fixture.start(["-e", `${ready} ${keepAlive}`]);
  const closed = once(child, "close");
  child.kill();
  await closed;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  await fixture.cleanup();
  await missing(fixture.base);
});

test("fixture cleanup escalates when a child ignores SIGTERM", async (t) => {
  const fixture = await portalFixture(t, "portal-fixture-stubborn-");
  const { child } = await fixture.start(["-e", `process.on('SIGTERM', () => {}); ${ready} ${keepAlive}`]);
  await fixture.cleanup();
  assert.equal(child.signalCode, "SIGKILL");
  await missing(fixture.base);
});
