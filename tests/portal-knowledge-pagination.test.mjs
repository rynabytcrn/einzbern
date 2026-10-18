// SPDX-License-Identifier: Apache-2.0
// Projection regressions use the real core's metadata answers, never a running Portal or device.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { canonicalJson } from "../scripts/lib/canonical-json.mjs";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { createKnowledgeUnit, createProject, initializeKnowledgeStore, initializeLibrary, listKnowledgeMetadata, DIRECTORY } from "../dist/build/packages/core/src/index.js";

const AT = "2026-10-18T00:00:00Z";
const source = await readFile(new URL("../portal/portal.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile("portal.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "knowledgeProjection").getText(parsed);
function projection(cliResult) {
  const bindings = { currentLibrary: () => ({ libraryPath: "/fixture" }), readInstant: () => AT, cliResult, canonicalJson, createHash };
  return new Function(...Object.keys(bindings), `${declaration}\nreturn knowledgeProjection;`)(...Object.values(bindings));
}
function card(externalKey, subject, summary = `${subject} summary`) {
  return {
    occurredAt: AT, externalKey, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["pagination"], subject, summary, snippet: `${subject} snippet`,
    accountableOwnerId: "owner:pagination-fixture", sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${subject} body`,
  };
}
async function asDevice(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try { return await operation(); }
  finally {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  }
}

test("Portal preserves native same-id versions and diagnostics within and across pages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-pagination-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const homes = [join(root, "device-a"), join(root, "device-b")];
  const devices = ["a".repeat(32), "b".repeat(32)];
  for (const [index, home] of homes.entries()) {
    await mkdir(home);
    await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: AT, deviceId: devices[index], displayName: `Fixture ${index}`, schemaVersion: "einzbern.device.v1" })}\n`);
  }
  const libraryA = join(root, "library-a"), libraryB = join(root, "library-b");
  await asDevice(homes[0], async () => {
    await initializeLibrary({ root: libraryA, createdAt: AT });
    await createProject(libraryA, { externalKey: "PAGINATION", name: "Pagination fixture", occurredAt: AT });
    await initializeKnowledgeStore(libraryA, { disposableAcknowledged: true });
    await createKnowledgeUnit(libraryA, card("PAGINATION-CONTROL", "Wombat burrow inspection"));
  });
  // Copy before either independent write, then deliver only the second writer's crest stream.
  await cp(libraryA, libraryB, { recursive: true });
  const first = await asDevice(homes[0], () => createKnowledgeUnit(libraryA, card("PAGINATION-SHARED", "Kestrel hover timing", "Kestrel morning observation")));
  const second = await asDevice(homes[1], () => createKnowledgeUnit(libraryB, card("PAGINATION-SHARED", "Kestrel hover timing", "Kestrel evening observation")));
  assert.equal(first.id, second.id);
  await cp(join(libraryB, DIRECTORY.knowledge, "events", devices[1]), join(libraryA, DIRECTORY.knowledge, "events", devices[1]), { recursive: true });
  const native = await asDevice(homes[0], () => listKnowledgeMetadata(libraryA, { at: AT, selection: "all", limit: 100 }));
  assert.equal(native.total, 3);
  assert.equal(native.unresolvedDuplicates.length, 1);
  const versions = native.records.filter((record) => record.id === first.id);
  assert.equal(versions.length, 2);
  for (const field of ["id", "revision", "updatedAt", "subject", "bodySha256"]) assert.equal(versions[0][field], versions[1][field], field);
  assert.notEqual(versions[0].summary, versions[1].summary, "identity must cover full metadata, not a short key");
  for (const pageSize of [100, 1]) {
    const calls = [];
    // Cap the real core query at one record to put the versions across a page boundary,
    // without synthesizing metadata or performing 100 unrelated fixture writes.
    const read = projection(async (args) => {
      const offset = Number(args[args.indexOf("--offset") + 1]);
      const status = args[args.indexOf("--status") + 1];
      assert.equal(args[args.indexOf("--selection") + 1], "all");
      assert.equal(args[args.indexOf("--at") + 1], AT);
      calls.push(offset);
      return { ok: true, body: await asDevice(homes[0], () => listKnowledgeMetadata(libraryA, { at: AT, selection: "all", status, offset, limit: pageSize })) };
    });
    for (const status of ["valid", "all"]) {
      calls.length = 0;
      const result = await read(status);
      assert.equal(result.ok, true);
      assert.deepEqual(result.records, native.records);
      assert.deepEqual(result.listing.unresolvedDuplicates, native.unresolvedDuplicates);
      assert.equal(result.listing.resultDigest, canonicalSha256(native.records));
      assert.equal(result.total, 3);
      assert.deepEqual(calls, pageSize === 100 ? [0] : [0, 1, 2]);
      assert.equal(result.listing.offset, 0);
      assert.equal(result.listing.truncated, false);
    }
    const removed = await read("removed");
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.records, []);
    assert.equal(removed.listing.resultDigest, canonicalSha256([]));
  }
});

test("Portal hashes the complete ordered canonical inventory, including nested Unicode metadata", async () => {
  const all = Array.from({ length: 205 }, (_, index) => ({
    subject: `Card ${index}`, id: `knowledge:${index}`, extensions: { "😀": [index, { z: "中文", a: true }], "\ue000": { second: null, first: "é" } },
  }));
  const pages = [];
  const read = projection(async (args) => {
    const offset = Number(args[args.indexOf("--offset") + 1]);
    const records = all.slice(offset, offset + 100);
    pages.push(offset);
    return { ok: true, body: { records, total: all.length, offset, truncated: offset + records.length < all.length, resultDigest: canonicalSha256(records) } };
  });
  const result = await read();
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, all);
  assert.deepEqual(pages, [0, 100, 200]);
  assert.equal(result.listing.resultDigest, canonicalSha256(all));
  assert.notEqual(result.listing.resultDigest, canonicalSha256(all.slice(200)));
});

test("Portal still refuses duplicate full records and malformed or incomplete progress", async () => {
  const record = { id: "knowledge:one", extensions: { a: 1, b: 2 } };
  const reordered = { extensions: { b: 2, a: 1 }, id: "knowledge:one" };
  const cases = [
    [{ total: 2, records: [record, reordered] }],
    [{ total: 2, records: [record] }, { total: 2, records: [reordered] }],
    [{ total: 2, records: [record] }, { total: 2, records: [] }],
    [{ total: 2, records: [record] }, { total: 3, records: [{ id: "knowledge:two" }] }],
    [{ total: 1, records: [record, { id: "knowledge:two" }] }],
    [{ total: -1, records: [] }], [{ total: 1.5, records: [] }],
    [{ total: 1, records: null }], [{ total: 1, records: [{}] }],
    [{ total: 2, records: [record] }, { knowledgeStore: "absent", total: 0, records: [] }],
  ];
  for (const bodies of cases) {
    let index = 0;
    const result = await projection(async () => ({ ok: true, body: bodies[Math.min(index++, bodies.length - 1)] }))();
    assert.equal(result.ok, false);
    assert.equal(result.listing.reasonCode, "PORTAL_KNOWLEDGE_PAGINATION_CHANGED");
    assert.deepEqual(result.records, []);
    assert.equal(result.total, 0);
  }
  let calls = 0;
  const refusal = await projection(async () => ++calls === 1 ? { ok: true, body: { total: 2, records: [record] } } : { ok: false, body: { reasonCode: "FIXTURE_REFUSAL" } })();
  assert.equal(refusal.ok, false);
  assert.equal(refusal.listing.reasonCode, "FIXTURE_REFUSAL");
  assert.deepEqual(refusal.records, []);
  const absent = await projection(async () => ({ ok: true, body: { knowledgeStore: "absent", total: 0, records: [] } }))();
  assert.equal(absent.knowledgeStore, "absent");
  assert.equal(absent.ok, true);
  assert.equal(absent.listing.resultDigest, canonicalSha256([]));
  const single = await projection(async () => ({ ok: true, body: { total: 1, records: [record] } }))();
  assert.equal(single.listing.resultDigest, canonicalSha256([record]));
});
