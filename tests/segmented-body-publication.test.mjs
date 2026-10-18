// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { SegmentedKnowledgeStoreBackend } from "../dist/build/packages/core/src/store-backend.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

// An ordinary, sequential in-memory delegate records the publication contract.
// No filesystem faults, race scheduling, or crash probes are involved.
function memoryBodies() {
  const files = new Map([["first.body", Buffer.from("first body")], ["second.body", Buffer.from("second body")]]);
  const operations = [];
  const delegate = {
    async listKnowledgeBodyFiles() { return [...files.keys()]; },
    async readKnowledgeBodyFile(name) { assert.ok(files.has(name), name); return files.get(name); },
    async readKnowledgeBody(id) { return this.readKnowledgeBodyFile(`${id}.body`); },
    async writeKnowledgeBodyFile(name, bytes) {
      if (name === "manifest.json" && files.has(name)) {
        const previous = JSON.parse(files.get(name));
        for (const segment of previous.segments) {
          assert.deepEqual(files.get(segment.name), committed.get(segment.name), "committed segment remains unchanged until manifest publication");
          const index = segment.name.replace(".ndjson", ".idx");
          assert.deepEqual(files.get(index), committed.get(index), "committed index remains unchanged until manifest publication");
        }
      }
      operations.push(["write", name]);
      files.set(name, Buffer.from(bytes));
      if (name === "manifest.json") committed = new Map(files);
    },
    async removeKnowledgeBodyFile(name) { operations.push(["remove", name]); files.delete(name); },
  };
  let committed = new Map();
  return { files, operations, backend: new SegmentedKnowledgeStoreBackend(delegate) };
}

test("segmented rewrites publish a fresh generation before removing committed files", async () => {
  const { files, operations, backend } = memoryBodies();
  await backend.migrateKnowledgeBodies(4096);
  const previous = JSON.parse(files.get("manifest.json"));
  operations.length = 0;
  await backend.writeKnowledgeBody("first", "replacement");
  const current = JSON.parse(files.get("manifest.json"));
  assert.ok(current.segments.every(segment => !previous.segments.some(old => old.name === segment.name)));
  const publication = operations.findIndex(([verb, name]) => verb === "write" && name === "manifest.json");
  assert.ok(publication > 0);
  assert.ok(operations.filter(([verb]) => verb === "remove").length > 0);
  assert.ok(operations.every(([verb], index) => verb !== "remove" || index > publication));
  assert.equal((await backend.readKnowledgeBody("first")).toString(), "replacement");
  assert.equal((await backend.readKnowledgeBody("second")).toString(), "second body");
  await backend.removeKnowledgeBody("first");
  assert.deepEqual(await backend.listKnowledgeBodies(), ["second.body"]);
});

for (const inconsistency of ["digest", "count", "records", "coverage"]) {
  test(`segmented rewrite rejects inconsistent ${inconsistency} without writing`, async () => {
    const { files, operations, backend } = memoryBodies();
    await backend.migrateKnowledgeBodies(4096);
    const manifest = JSON.parse(files.get("manifest.json"));
    if (inconsistency === "digest") manifest.indexDigest = "0".repeat(64);
    if (inconsistency === "count") manifest.count++;
    if (inconsistency === "records") manifest.segments[0].records++;
    if (inconsistency === "coverage") {
      const name = manifest.segments[0].name.replace(".ndjson", ".idx");
      const index = JSON.parse(files.get(name));
      delete index.entries.first;
      files.set(name, Buffer.from(canonicalJson(index)));
      manifest.count--;
      manifest.segments[0].records--;
      manifest.indexDigest = canonicalSha256([index]);
    }
    files.set("manifest.json", Buffer.from(canonicalJson(manifest)));
    operations.length = 0;
    await assert.rejects(backend.writeKnowledgeBody("third", "third body"), { reasonCode: "KNOWLEDGE_RECORD_INVALID" });
    assert.deepEqual(operations, []);
  });
}

// Preconstructed publication states exercise recovery without interrupting a process
// or arranging concurrent filesystem operations.
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreBackend } from "../dist/build/packages/core/src/store-backend.js";
const profile = {
  reasonCodes: { pathInvalid: "KNOWLEDGE_PATH_INVALID", linkUnsafe: "KNOWLEDGE_LINK_UNSAFE", specialFile: "KNOWLEDGE_SPECIAL_FILE", limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED", sourceChanged: "KNOWLEDGE_SOURCE_CHANGED", alreadyExists: "KNOWLEDGE_ALREADY_EXISTS" },
  limits: { markerBytes: 16384, metadataBytes: 65536, bodyBytes: 8192, viewBytes: 1048576, recordBytes: 0 },
};
async function diskBodies(context) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-manifest-publication-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bodies"));
  return { root, file: new FileStoreBackend(root, profile) };
}
const emptyManifest = () => canonicalJson({ schemaVersion: "tcrn.knowledge-body-manifest.v1", segments: [], count: 0, indexDigest: canonicalSha256([]) });

test("initial body manifest publication leaves a complete single-linked manifest", async context => {
  const { root, file } = await diskBodies(context);
  await file.writeKnowledgeBodyFile("manifest.json", emptyManifest());
  assert.equal((await file.readKnowledgeBodyFile("manifest.json")).toString(), emptyManifest());
  assert.equal((await lstat(join(root, "bodies", "manifest.json"))).nlink, 1);
  assert.deepEqual(await readdir(join(root, "bodies")), ["manifest.json"]);
});

test("a complete preconstructed manifest staging pair settles without losing bytes", async context => {
  const { root, file } = await diskBodies(context);
  const bytes = emptyManifest();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const staging = join(root, "bodies", `.tmp-body-manifest-${digest}-${"a".repeat(24)}`);
  const final = join(root, "bodies", "manifest.json");
  await writeFile(staging, bytes);
  await link(staging, final);
  assert.equal((await file.readKnowledgeBodyFile("manifest.json")).toString(), bytes);
  assert.equal((await lstat(final)).nlink, 1);
  assert.deepEqual(await readdir(join(root, "bodies")), ["manifest.json"]);
});

for (const kind of ["unrecognized", "wrong-digest", "extra-link"]) {
  test(`manifest staging settlement refuses ${kind} links`, async context => {
    const { root, file } = await diskBodies(context);
    const bytes = emptyManifest();
    const digest = kind === "wrong-digest" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
    const name = kind === "unrecognized" ? "unrecognized" : `.tmp-body-manifest-${digest}-${"a".repeat(24)}`;
    const staging = join(root, "bodies", name);
    const final = join(root, "bodies", "manifest.json");
    await writeFile(staging, bytes);
    await link(staging, final);
    if (kind === "extra-link") await link(staging, join(root, "bodies", "extra"));
    const before = await readdir(join(root, "bodies"));
    await assert.rejects(file.readKnowledgeBodyFile("manifest.json"), error => ["KNOWLEDGE_LINK_UNSAFE", "KNOWLEDGE_SOURCE_CHANGED"].includes(error.reasonCode));
    assert.deepEqual(await readdir(join(root, "bodies")), before);
  });
}
