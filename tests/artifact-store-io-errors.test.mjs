// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeLibrary, putArtifact, listArtifacts, verifyArtifacts, DIRECTORY } from "../dist/build/packages/core/src/index.js";

const at = "2026-10-18T06:00:00Z";
async function fixture(t) {
  const base = await fsPromises.realpath(await fsPromises.mkdtemp(join(tmpdir(), "einzbern-artifact-io-")));
  t.after(() => fsPromises.rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  const receipts = [];
  for (const name of ["one", "two"]) {
    const file = join(base, `${name}.txt`);
    await fsPromises.writeFile(file, name);
    receipts.push(await putArtifact(workspace, { file, at }));
  }
  const root = join(workspace, DIRECTORY.artifacts);
  const manifest = join(root, "artifact-manifest.json");
  return { base, workspace, root, manifest, receipts };
}

async function withFailure(method, target, code, operation) {
  const filesystemMethod = method === "readFile" ? "open" : method;
  const original = fsPromises[filesystemMethod];
  let hits = 0;
  const fail = () => {
    hits += 1;
    throw Object.assign(new Error(`injected ${code}`), { code });
  };
  fsPromises[filesystemMethod] = async (path, ...args) => {
    if (String(path) === target) {
      if (method === "readFile") {
        const handle = await original(path, ...args);
        handle.readFile = async () => fail();
        return handle;
      }
      return fail();
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await operation();
    assert.ok(hits > 0, "the exact-path filesystem failure was exercised");
  } finally {
    fsPromises[filesystemMethod] = original;
    syncBuiltinESMExports();
  }
}

for (const code of ["EIO", "EACCES"]) {
  for (const action of ["list", "verify", "put"]) {
    test(`artifact manifest ${code} refuses ${action} without replacing the index`, async (t) => {
      const fx = await fixture(t);
      const before = await fsPromises.readFile(fx.manifest);
      const file = join(fx.base, "three.txt");
      await fsPromises.writeFile(file, "three");
      const operation = action === "list" ? () => listArtifacts(fx.workspace)
        : action === "verify" ? () => verifyArtifacts(fx.workspace)
        : () => putArtifact(fx.workspace, { file, at });
      await withFailure("lstat", fx.manifest, code, async () => {
        await assert.rejects(operation, (error) => error.reasonCode === "ARTIFACT_MANIFEST_INVALID" && error.message.includes(code));
      });
      assert.deepEqual(await fsPromises.readFile(fx.manifest), before);
      assert.equal((await listArtifacts(fx.workspace)).artifacts.length, 2);
    });
  }
}

for (const method of ["lstat", "open", "readFile"]) {
  test(`artifact verification aggregates ${method} EIO and continues to another damaged blob`, async (t) => {
    const fx = await fixture(t);
    const entries = [...fx.receipts].sort((a, b) => a.sha256.localeCompare(b.sha256));
    const first = join(fx.root, entries[0].blobName);
    await fsPromises.rm(join(fx.root, entries[1].blobName));
    await withFailure(method, first, "EIO", async () => {
      const result = await verifyArtifacts(fx.workspace);
      assert.equal(result.reasonCode, "ARTIFACT_MISMATCH");
      assert.equal(result.checked, 2);
      assert.deepEqual(result.findings.map(({ sha256, finding }) => ({ sha256, finding })), [
        { sha256: entries[0].sha256, finding: "unreadable" },
        { sha256: entries[1].sha256, finding: "missing" },
      ]);
      assert.match(result.findings[0].detail, /EIO/u);
      assert.equal(JSON.stringify(result).includes(fx.root), false, "verification findings carry no local artifact-root address");
    });
  });
}

test("artifact put refuses existing-blob stat EIO without overwriting the blob or index", async (t) => {
  const fx = await fixture(t);
  const target = join(fx.root, fx.receipts[0].blobName);
  const before = await fsPromises.readFile(fx.manifest);
  const corrupted = Buffer.from("ordinary damaged blob");
  await fsPromises.writeFile(target, corrupted);
  await withFailure("lstat", target, "EIO", async () => {
    await assert.rejects(() => putArtifact(fx.workspace, { file: join(fx.base, "one.txt"), at }),
      (error) => error.reasonCode === "ARTIFACT_PATH_INVALID" && error.message.includes("EIO"));
  });
  assert.deepEqual(await fsPromises.readFile(target), corrupted);
  assert.deepEqual(await fsPromises.readFile(fx.manifest), before);
});

test("an actually absent artifact manifest remains a valid empty store", async (t) => {
  const base = await fsPromises.realpath(await fsPromises.mkdtemp(join(tmpdir(), "einzbern-artifact-empty-")));
  t.after(() => fsPromises.rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  assert.deepEqual((await listArtifacts(workspace)).artifacts, []);
  const result = await verifyArtifacts(workspace);
  assert.equal(result.reasonCode, "ARTIFACT_VERIFIED");
  assert.equal(result.checked, 0);
});
