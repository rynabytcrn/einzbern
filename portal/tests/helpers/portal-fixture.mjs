// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Own the scratch directory and its one portal process, including failed setup. */
export async function portalFixture(context, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let child;
  let closed = Promise.resolve();
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      let timer;
      try {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          child.kill();
          // A broken server must not keep the test runner alive indefinitely.
          timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 1000);
        }
        // close also waits for stderr, and fires after an unsuccessful spawn without an exit.
        await closed;
      } finally {
        clearTimeout(timer);
      }
      await rm(directory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  // Register before realpath, CLI setup, spawning, or waiting for the server can fail.
  context.after(cleanup);
  const base = await realpath(directory);

  async function start(args, { startupTimeoutMs = 15000, ...options } = {}) {
    if (cleanupPromise) throw new Error("portal fixture is already cleaned up");
    if (child) throw new Error("portal fixture already has a process");
    let stdout = "";
    let stderr = "";
    try {
      child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      closed = new Promise((resolve) => child.once("close", resolve));
      const url = await new Promise((resolve, reject) => {
        let pendingLine = "";
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error("portal did not start")), startupTimeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (settled) return;
          pendingLine += chunk;
          let newline;
          while ((newline = pendingLine.indexOf("\n")) !== -1) {
            const line = pendingLine.slice(0, newline);
            pendingLine = pendingLine.slice(newline + 1);
            if (!line.includes("PORTAL_LISTENING")) continue;
            try {
              const listening = JSON.parse(line);
              if (listening.reasonCode !== "PORTAL_LISTENING" || typeof listening.url !== "string" || !listening.url) {
                throw new Error("missing PORTAL_LISTENING url");
              }
              finish(null, listening.url);
            } catch (error) {
              finish(new Error("portal emitted an invalid listening announcement", { cause: error }));
            }
            break;
          }
        });
        child.on("error", (error) => finish(error));
        child.once("close", (code, signal) => finish(new Error(`portal exited ${code}${signal ? ` (${signal})` : ""}`)));
      });
      return { child, url };
    } catch (error) {
      await cleanup();
      // Both pipes have closed now, so even a failure announced on stdout keeps all stderr.
      throw new Error(`portal startup failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
    }
  }

  return { base, start, cleanup };
}
