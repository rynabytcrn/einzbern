// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { AtomicFileError } from "../dist/build/packages/core/src/atomic-file.js";
import { applyHostHooks, planHostHooks, readHostHooks } from "../dist/build/packages/core/src/host-hooks.js";

const AT = "2026-09-26T10:00:00Z";
const STAMP = "20260926T100000Z";

// Compose ordinary file plans to exercise every restoration in the generic apply loop, including
// a later successful restoration after multiple failures. All targets and backups are disposable.
async function fixture(context, firstMissing = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-host-hooks-rollback-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const deviceHome = join(base, "device");
  await mkdir(home);
  const expectation = planHostHooks({ host: "claude-code", scope: "project", deviceHome });
  const plans = [];
  for (const name of ["first", "second", "third", "last"]) {
    const root = join(base, name);
    const path = join(root, expectation.hooksFile);
    await mkdir(dirname(path), { recursive: true });
    if (name !== "first" || !firstMissing) await writeFile(path, `${JSON.stringify({ env: { fixture: name } })}\n`);
    plans.push(await readHostHooks(expectation, { root, home }));
  }
  const plan = { ...plans[0], files: plans.flatMap((entry) => entry.files) };
  const backupFor = (file) => file.before === null ? null
    : join(deviceHome, "backups", STAMP, "host-hooks", createHash("sha256").update(file.root).digest("hex").slice(0, 16), file.name);
  return { plan, backupFor };
}

async function withFilesystemFailures(replacements, operation) {
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

test("host-hook apply preserves the exact primary failure when every rollback succeeds", async (context) => {
  const { plan, backupFor } = await fixture(context, true);
  const primary = Object.assign(new Error("injected final directory failure"), { code: "EIO" });
  await withFilesystemFailures({
    mkdir: (makeDirectory) => async (path, options) => {
      if (path === dirname(plan.files[3].path)) throw primary;
      return makeDirectory(path, options);
    },
  }, async () => {
    await assert.rejects(applyHostHooks(plan, { at: AT }), (error) => error === primary);
  });
  for (const file of plan.files) {
    if (file.before === null) await assert.rejects(readFile(file.path), { code: "ENOENT" });
    else {
      assert.equal(await readFile(file.path, "utf8"), file.before);
      assert.equal(await readFile(backupFor(file), "utf8"), file.before);
    }
  }
});

for (const scenario of [
  { name: "existing-file restorations", firstMissing: false, primaryKind: "atomic" },
  { name: "new-file removal and an existing-file restoration", firstMissing: true, primaryKind: "atomic" },
  { name: "an untyped primary filesystem failure", firstMissing: false, primaryKind: "directory" },
]) {
  test(`host-hook rollback reports ${scenario.name} without hiding the primary failure or skipping later files`, async (context) => {
    const { plan, backupFor } = await fixture(context, scenario.firstMissing);
    const [first, second, third, last] = plan.files;
    const primary = Object.assign(new Error("injected final apply failure"), { code: "EIO" });
    const removalFailure = Object.assign(new Error("injected new-file removal failure"), { code: "EACCES" });
    const restored = [];
    let recovering = false;
    let failure;
    await withFilesystemFailures({
      mkdir: (makeDirectory) => async (path, options) => {
        if (scenario.primaryKind === "directory" && path === dirname(last.path)) {
          recovering = true;
          throw primary;
        }
        return makeDirectory(path, options);
      },
      rename: (rename) => async (from, to) => {
        if (to === last.path) {
          recovering = true;
          throw primary;
        }
        if (recovering && [first.path, second.path, third.path].includes(to)) {
          restored.push(to);
          if (to !== third.path) throw Object.assign(new Error("injected restore failure"), { code: "EXDEV" });
        }
        return rename(from, to);
      },
      rm: (remove) => async (path, options) => {
        if (recovering && path === first.path && scenario.firstMissing) {
          restored.push(path);
          throw removalFailure;
        }
        return remove(path, options);
      },
    }, async () => {
      await assert.rejects(applyHostHooks(plan, { at: AT }), (error) => {
        failure = error;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        assert.equal(error.errors[0], error.cause);
        if (scenario.primaryKind === "atomic") {
          assert.ok(error.cause instanceof AtomicFileError);
          assert.equal(error.reasonCode, "ATOMIC_WRITE_RENAME_FAILED");
          assert.deepEqual(error.cause.details, { path: last.path, code: "EIO", attempts: "1" });
        } else {
          assert.equal(error.cause, primary);
          assert.equal(error.reasonCode, "HOST_HOOKS_ROLLBACK_FAILED");
        }
        const failures = [first, second].map((file, index) => ({
          path: file.path,
          backup: backupFor(file),
          error: error.errors[index + 1].message,
        }));
        assert.deepEqual(error.details, { ...error.cause.details, rollbackErrors: JSON.stringify(failures) });
        assert.ok(error.message.startsWith(`${error.cause.message}; rollback failed: `));
        for (const entry of failures) {
          assert.ok(error.message.includes(entry.path));
          assert.ok(error.message.includes(entry.error));
          assert.ok(error.message.includes(entry.backup === null ? "new file has no backup" : `backup: ${entry.backup}`));
        }
        return true;
      });
    });
    assert.deepEqual(restored, [first.path, second.path, third.path], "every written file gets a restoration attempt");
    if (scenario.firstMissing) assert.equal(failure.errors[1], removalFailure);
    else assert.equal(failure.errors[1].details.path, first.path);
    assert.equal(failure.errors[2].details.path, second.path);
    assert.equal(await readFile(first.path, "utf8"), first.after);
    assert.equal(await readFile(second.path, "utf8"), second.after);
    assert.equal(await readFile(third.path, "utf8"), third.before, "a later restoration succeeds despite both earlier failures");
    assert.equal(await readFile(last.path, "utf8"), last.before, "the failed publication leaves its original intact");
    for (const file of plan.files.filter((entry) => entry.before !== null)) {
      assert.equal(await readFile(backupFor(file), "utf8"), file.before, "every backup remains available for recovery");
    }
  });
}


test("rollback detects successful-looking restoration whose bytes differ", async context => {
  const { plan, backupFor } = await fixture(context);
  const primary = new Error("primary write failure"); let recovering = false;
  await withFilesystemFailures({
    mkdir: make => async (path, options) => { if (path === dirname(plan.files[3].path)) { recovering = true; throw primary; } return make(path, options); },
    readFile: read => async (path, ...args) => { const value = await read(path, ...args); return recovering && path === plan.files[0].path ? Buffer.from("wrong restored bytes") : value; },
  }, async () => {
    await assert.rejects(applyHostHooks(plan, { at: AT }), error => {
      assert.equal(error.cause, primary); assert.match(error.message, /rollback bytes differ/u);
      assert.match(error.details.rollbackErrors, /backup/u); return true;
    });
  });
  assert.equal(await readFile(backupFor(plan.files[0]), "utf8"), plan.files[0].before);
});
