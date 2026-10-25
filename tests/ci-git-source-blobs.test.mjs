// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseSourceTree, parseBlobBatch, readSourceBlobs } from "../scripts/ci/git-source-blobs.mjs";
import { documentReaderSources } from "../scripts/ci/impact-plan.mjs";
import { createCiComponentFixture, writeFixtureFile } from "./helpers/ci-component-fixture.mjs";
const oid = "a".repeat(40), other = "b".repeat(40);
const frame = (body, id = oid, type = "blob") => Buffer.concat([Buffer.from(`${id} ${type} ${body.length}\n`), body, Buffer.from("\n")]);

test("batch frames preserve exact binary lengths, UTF-8, interior LF/NUL and empty bodies", () => {
  const body = Buffer.from("雪\n\0a blob 0\n");
  const result = parseBlobBatch(Buffer.concat([frame(body), frame(Buffer.alloc(0), other)]), [oid, other]);
  assert.deepEqual(result.get(oid), body);
  assert.deepEqual(result.get(other), Buffer.alloc(0));
  assert.deepEqual(parseBlobBatch(Buffer.alloc(0), []), new Map());
});
test("batch rejects missing/wrong object, type, header, length, delimiter, count and trailing bytes", () => {
  const valid = frame(Buffer.from("雪\na"));
  const invalid = [Buffer.from(`${oid} missing\n`), frame(Buffer.from("x"), other), frame(Buffer.from("x"), oid, "tree"), Buffer.from(`${oid} blob -1\nx\n`), Buffer.from(`${oid} blob 01\nx\n`), Buffer.from(`${oid} blob 9007199254740992\n`), Buffer.from(`${oid} blob 1`), valid.subarray(0, valid.length - 2), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from("garbage")]), Buffer.concat([valid, valid]), Buffer.from(`${oid} blob 1\nx!`)];
  for (const bytes of invalid) assert.throws(() => parseBlobBatch(bytes, [oid]));
  assert.throws(() => parseBlobBatch(valid, [oid, other]));
  assert.throws(() => parseBlobBatch(valid, []));
  assert.throws(() => parseBlobBatch(valid, ["HEAD"]));
});
test("NUL tree records retain paths and reject encoding, unsafe paths, duplicate and malformed entries", () => {
  assert.deepEqual(parseSourceTree(Buffer.from(`100644 blob ${oid}\tspace 雪\tname.js\0`)), [{ mode: "100644", type: "blob", oid, path: "space 雪\tname.js" }]);
  for (const path of ["../x", "/x", "x//y", "x/./y", "x\ny", "x\\y"]) assert.throws(() => parseSourceTree(Buffer.from(`100644 blob ${oid}\t${path}\0`)));
  for (const bytes of [Buffer.from([255, 0]), Buffer.from(`100644 blob ${oid}\tx`), Buffer.from(`100644 tree ${oid}\tx\0`), Buffer.from(`160000 blob ${oid}\tx\0`), Buffer.from(`100644 blob ${oid}\tx\0`.repeat(2))]) assert.throws(() => parseSourceTree(bytes));
});
test("one tree and one batch process bind exact OIDs, deduplicate only within request and retain nonblobs", () => {
  const calls = [], refs = [];
  const run = (command, args, options) => {
    assert.equal(command, "git"); calls.push(args);
    if (args.includes("ls-tree")) { refs.push(args.at(-2)); return Buffer.from(`100644 blob ${oid}\ta.js\0` + `100755 blob ${oid}\tb.py\0` + `160000 commit ${other}\tsubmodule\0`); }
    assert.equal(options.input, `${oid}\n`);
    return frame(Buffer.from(refs.at(-1)));
  };
  const first = readSourceBlobs("/repo", "first", () => true, run);
  assert.equal(calls.length, 2);
  assert.deepEqual(first.map((entry) => entry.path), ["a.js", "b.py", "submodule"]);
  assert.equal(first[0].bytes, first[1].bytes);
  assert.equal(first[2].bytes, null);
  const second = readSourceBlobs("/repo", "second", () => true, run);
  assert.equal(calls.length, 4);
  assert.equal(second[0].bytes.toString(), "second");
  for (const ref of ["", "--all", "HEAD\nx"]) assert.throws(() => readSourceBlobs("/repo", ref, () => true, run));
  assert.throws(() => readSourceBlobs("/repo", "HEAD", () => true, () => { throw new Error("bad ref"); }), /bad ref/u);
});
test("immutable scanner preserves candidate bytes and unresolved binary inputs across refs", async (t) => {
  const fixture = await createCiComponentFixture(t);
  for (const [path, bytes] of [["scripts/sp ace 雪.py", Buffer.from("print('雪')\n")], ["opaque.dat", Buffer.from([255])], ["nul.data", Buffer.from("a\0b")], ["excluded.md", Buffer.from([255])]]) await writeFixtureFile(fixture.repo, path, bytes);
  fixture.git("add", ".");
  const first = fixture.commit();
  const actual = documentReaderSources(fixture.repo, first);
  assert.equal(actual.texts.get("scripts/sp ace 雪.py"), "print('雪')\n");
  assert.ok(!actual.texts.has("excluded.md"));
  assert.deepEqual(actual.unresolved, ["nul.data", "opaque.dat"]);
  const files = execFileSync("git", ["-C", fixture.repo, "ls-tree", "-r", "--name-only", "-z", first]).toString("utf8").split("\0").filter(Boolean);
  for (const path of files) if (actual.texts.has(path)) {
    const expected = execFileSync("git", ["-C", fixture.repo, "show", `${first}:${path}`]);
    assert.deepEqual(Buffer.from(actual.texts.get(path)), expected);
  }
  await writeFixtureFile(fixture.repo, "scripts/sp ace 雪.py", "second\n");
  fixture.git("add", ".");
  const second = fixture.commit();
  assert.equal(documentReaderSources(fixture.repo, second).texts.get("scripts/sp ace 雪.py"), "second\n");
  assert.equal(documentReaderSources(fixture.repo, first).texts.get("scripts/sp ace 雪.py"), "print('雪')\n");
  assert.throws(() => documentReaderSources(fixture.repo, "nonexistent-ref"));
});


test("real Git accepts three distinct 23 MiB text blobs in exactly two processes", async (t) => {
  const fixture = await createCiComponentFixture(t);
  const expected = new Map();
  for (const [index, char] of ["a", "b", "c"].entries()) {
    const path = `large-${index}.txt`, body = Buffer.alloc(23 * 1024 * 1024, char);
    await writeFixtureFile(fixture.repo, path, body);
    expected.set(path, body);
  }
  fixture.git("add", ".");
  const ref = fixture.commit();
  let processes = 0;
  const actual = readSourceBlobs(fixture.repo, ref, path => expected.has(path), (...args) => {
    processes += 1;
    return execFileSync(...args);
  });
  assert.equal(processes, 2);
  assert.equal(actual.length, 3);
  for (const entry of actual) assert.deepEqual(entry.bytes, expected.get(entry.path));
});
