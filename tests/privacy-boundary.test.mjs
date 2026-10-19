// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { LocalCommandError, runLocalCommand } from "../scripts/lib/local-command.mjs";
import { aggregatePrivacySurface, decodeGitMetadataBytes, normalizePrivacyText, p8ReleasePrivacySourcePaths, parseGitObjectBatch, parseHistoricalTreePaths, scanPrivacyEntries, walkHistoricalCommitPaths } from "../scripts/lib/privacy.mjs";
import { readUstar, writeUstar } from "../scripts/lib/tar.mjs";
import { BRAND, ENGINE_REPOSITORY_NAMES, LEGACY_REPOSITORY_NAMES } from "../dist/build/packages/core/src/index.js";

const batchCheckFormat = "--batch-check=%(objectname) %(objecttype) %(objectsize)";
const batchArguments = ["cat-file", "--batch-all-objects", "--batch"];
const fixtureMaximumBytes = 64 * 1024 * 1024;
const joinParts = (parts, separator) => parts.join(separator);
const PRIVATE_VM_HOST = joinParts(["vm-aos", "internal"], ".");
const PRIVATE_DNS_HOST = joinParts(["aos", "tcrn", "internal"], ".");

function fixtureGit(root, arguments_, { raw = false, tolerateStderr = false } = {}) {
  const publicEmail = joinParts(["fixture", "@", "users.noreply.github.com"], "");
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: raw ? undefined : "utf8",
    maxBuffer: fixtureMaximumBytes,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-14T00:00:00Z",
      GIT_AUTHOR_EMAIL: publicEmail,
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_DATE: "2026-07-14T00:00:00Z",
      GIT_COMMITTER_EMAIL: publicEmail,
      GIT_COMMITTER_NAME: "fixture",
    },
  });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stderr?.toString("utf8") ?? ""}`);
  if (!tolerateStderr) {
    assert.equal(result.stderr?.length ?? 0, 0, arguments_.join(" "));
  }
  return raw ? result.stdout : result.stdout.trim();
}

async function emptyFixtureRepository(context, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(async () => rm(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  return root;
}

// Independent reimplementation of the length the batch pass must emit: the batch-check
// bytes are byte-for-byte the headers the batch pass repeats, plus each declared payload
// and its framing newline. Kept separate from the production computation on purpose.
function declaredBatchBytes(root) {
  const check = fixtureGit(root, ["cat-file", "--batch-all-objects", batchCheckFormat], { raw: true, tolerateStderr: true });
  let expected = check.length;
  for (const line of check.toString("utf8").split("\n")) {
    if (line === "") continue;
    const size = Number(line.split(" ")[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("PRIVACY_GIT_OBJECT_INDEX_SIZE");
    expected += size + 1;
  }
  return expected;
}

async function corruptOneLooseObject(root, object) {
  const path = join(root, ".git", "objects", object.slice(0, 2), object.slice(2));
  await chmod(path, 0o644);
  await writeFile(path, Buffer.from("this is not a zlib stream"));
}

test("adversarial object-database shapes fail closed instead of shortening the scanned surface", async (context) => {
  await context.test("a symlink blob is extracted by declared length, not by delimiter", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-symlink-");
    // A symlink blob's content is the raw target with no trailing newline, so a parser
    // that scanned for the framing LF instead of honouring the declared size would run
    // straight into the next object's header and lose the privacy-bearing path.
    const target = joinParts(["..", "..", "Users", "local-user", "secrets.txt"], "/");
    await symlink(target, join(root, "link"));
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "symlink fixture"]);
    const stream = fixtureGit(root, batchArguments, { raw: true });
    const records = parseGitObjectBatch(stream, declaredBatchBytes(root));
    const blob = records.find((record) => record.type === "blob");
    assert.ok(blob, "the symlink blob must be present in the batch stream");
    assert.deepEqual(blob.content, Buffer.from(target, "utf8"));
    const findings = scanPrivacyEntries(
      [{ label: blob.object, kind: "blob", content: blob.content.toString("utf8") }],
      { owner: publicIdentity.login },
    );
    assert.ok(findings.some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")));
  });

  await context.test("a submodule gitlink is absent from the object database and is not claimed as scanned", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-gitlink-");
    const gitlink = "b".repeat(40);
    await writeFile(join(root, "a.txt"), "content\n");
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},sub`]);
    fixtureGit(root, ["commit", "-q", "-m", "gitlink fixture"]);
    const records = parseGitObjectBatch(fixtureGit(root, batchArguments, { raw: true }), declaredBatchBytes(root));
    // --batch-all-objects enumerates only objects this database holds, so the gitlink
    // commit is simply absent -- the tree naming it is still scanned, and the batch pass
    // does not emit a placeholder record that would be mistaken for scanned content.
    assert.ok(records.every((record) => record.object !== gitlink));
    assert.ok(records.some((record) => record.type === "tree" && record.content.includes("sub")));
    assert.throws(
      () => runLocalCommand("git", ["cat-file", "commit", gitlink], { cwd: root, raw: true }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_FAILED",
    );
  });

  await context.test("an object database beyond the former capture bound remains complete; an explicit caller bound refuses", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-oversize-");
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "oversized fixture"]);
    const expected = declaredBatchBytes(root);
    // spawnSync's 1 MiB default silently returns a truncated stdout on overflow, which is
    // the fail-open shape: every object past the cut goes unscanned while the gate stays
    // green. The default keeps the complete stream, and an explicit caller budget refuses.
    assert.equal(runLocalCommand("git", batchArguments, { cwd: root, raw: true }).length, expected, "default capture keeps all declared bytes");
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: expected - 1 }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_OUTPUT_OVERFLOW",
    );
    const stream = runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: expected + 1 });
    assert.equal(stream.length, expected);
    assert.ok(parseGitObjectBatch(stream, expected).some((record) => record.content.length === 2 * 1024 * 1024));
    // The exact shape an overflow hands back: a prefix that parses cleanly on its own and
    // drops everything after the cut. Only comparing against the declared total sees it.
    assert.throws(
      () => parseGitObjectBatch(stream.subarray(0, 1024 * 1024), expected),
      /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u,
    );
  });

  await context.test("a corrupted object degrades to a size-less record that stops the scan", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-corrupt-");
    await writeFile(join(root, "a.txt"), "hello\n");
    await writeFile(join(root, "b.txt"), "world\n");
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "corruption fixture"]);
    const object = fixtureGit(root, ["hash-object", "a.txt"]);
    await corruptOneLooseObject(root, object);
    // git still exits 0 on an unreadable object. It reports the failure on stderr and
    // degrades the record to a bare "<oid> missing" line carrying neither a type nor a
    // size -- in both the batch-check and the batch pass. Nothing about the exit status
    // or the surrounding framing marks the object as unscanned, so the parser has to
    // reject the header outright rather than step over it.
    const raw = spawnSync("git", batchArguments, { cwd: root, maxBuffer: fixtureMaximumBytes });
    assert.equal(raw.status, 0);
    assert.ok(raw.stderr.length > 0);
    assert.ok(raw.stdout.toString("utf8").includes(`${object} missing\n`));
    assert.throws(() => parseGitObjectBatch(raw.stdout, raw.stdout.length), /PRIVACY_GIT_OBJECT_TYPE/u);
    // The same degradation reaches the declared-length pass, where a size-less line
    // cannot contribute a length and must stop the scan instead of being skipped.
    assert.throws(() => declaredBatchBytes(root), /PRIVACY_GIT_OBJECT_INDEX_SIZE/u);
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: fixtureMaximumBytes }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_UNEXPECTED_STDERR",
    );
  });
});

test("batch object framing is validated per record and as a whole stream", () => {
  const object = "a".repeat(40);
  const record = (type, content) => Buffer.concat([
    Buffer.from(`${object} ${type} ${content.length}\n`, "utf8"),
    content,
    Buffer.from([0x0a]),
  ]);
  const binary = Buffer.from([0x00, 0xff, 0x0a, 0x41, 0x00]);
  const stream = Buffer.concat([record("blob", binary), record("tree", Buffer.alloc(0))]);
  const parsed = parseGitObjectBatch(stream, stream.length);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].content, binary, "an embedded framing newline must not end the record");
  assert.equal(parsed[1].content.length, 0);
  assert.throws(() => parseGitObjectBatch(stream, stream.length - 1), /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u);
  // A capture cut at a record boundary is the fail-open shape: it parses cleanly on its
  // own and silently drops every later object. Only the declared total exposes it.
  const cleanPrefix = stream.subarray(0, record("blob", binary).length);
  assert.equal(parseGitObjectBatch(cleanPrefix, cleanPrefix.length).length, 1);
  assert.throws(() => parseGitObjectBatch(cleanPrefix, stream.length), /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u);
  assert.throws(() => parseGitObjectBatch("not a buffer", 0), /PRIVACY_GIT_OBJECT_STREAM_INVALID/u);
  const declaresTooMuch = Buffer.from(`${object} blob 99\nshort\n`, "utf8");
  assert.throws(() => parseGitObjectBatch(declaresTooMuch, declaresTooMuch.length), /PRIVACY_GIT_OBJECT_TYPE/u);
  const missingFramingNewline = Buffer.from(`${object} blob 5\nshortX`, "utf8");
  assert.throws(() => parseGitObjectBatch(missingFramingNewline, missingFramingNewline.length), /PRIVACY_GIT_OBJECT_TYPE/u);
  assert.throws(
    () => parseGitObjectBatch(record("gitlink", Buffer.alloc(0)), record("gitlink", Buffer.alloc(0)).length),
    /PRIVACY_GIT_OBJECT_TYPE/u,
  );
});

// TCRN-CROSS-MIN-279 D1, MIN-281 D1: the reviewed identity lines of 72ae480e and 440f297d are
// remain accepted without rewriting history. Public GitHub tokens may also satisfy
// the structural metadata contract; unreviewed private edits must still fail closed.
// Each commit is read from history, so no address is written into a source file.
test("reviewed historical commits remain accepted and private identity edits fail closed", (context) => {
  const options = { owner: LEGACY_REPOSITORY_NAMES.owner };
  const scan = (label, content) => scanPrivacyEntries([{ label, kind: "commit", content }], options);
  for (const reviewed of ["72ae480e5ce142db481ecc65bccbdd3abe129643", "440f297d0f42c14714fea2063ec660f0017f4809"]) {
    const read = spawnSync("git", ["cat-file", "commit", reviewed], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
    if (read.status !== 0) {
      context.diagnostic(`${reviewed} is not in this clone's history`);
      continue;
    }
    assert.deepEqual(scan(`git-commit:${reviewed}`, read.stdout), [], `${reviewed} is clean`);
    const privateName = joinParts(["", "Users", "fixture", "private"], "/");
    const changed = read.stdout.replace(/^committer /mu, `committer ${privateName} `);
    assert.notEqual(changed, read.stdout);
    for (const object of [reviewed, "b".repeat(40)]) {
      assert.ok(scan(`git-commit:${object}`, changed).some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")), `${reviewed}: private edits remain findings`);
    }
  }
});

const publicIdentity = {
  login: "public-contributor",
  email: joinParts(["12345+public-contributor", "@", "users.noreply.github.com"], ""),
};

test("public Git hosting identity is allowed only in commit metadata", () => {
  const commit = `tree ${"a".repeat(40)}\nauthor ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\ncommitter ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\n\nmessage\n`;
  assert.deepEqual(
    scanPrivacyEntries([
      { label: "commit", kind: "commit", content: commit },
      // The engine's origin is public under either of its GitHub names: the new one, and
      // the old one until the Owner renames the remote (TCRN-CROSS-STORY-466).
      ...ENGINE_REPOSITORY_NAMES.map((name) => ({
        label: `origin:${name}`,
        kind: "remote",
        content: `https://github.com/${publicIdentity.login}/${name}.git`,
      })),
    ], {
      owner: publicIdentity.login,
      repositories: ENGINE_REPOSITORY_NAMES,
    }),
    [],
  );
  assert.equal(
    scanPrivacyEntries([{ label: "origin", kind: "remote", content: `https://github.com/${publicIdentity.login}/other.git` }], {
      owner: publicIdentity.login,
      repositories: ENGINE_REPOSITORY_NAMES,
    }).length > 0,
    true,
    "a repository outside the engine's names is not public metadata",
  );
  assert.match(
    scanPrivacyEntries([{ label: "source", kind: "source", content: publicIdentity.email }], {
      owner: publicIdentity.login,
    })[0],
    /EMAIL_IDENTIFIER/u,
  );
});

test("classified privacy samples stay path-and-line exact across source, history and source archives", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const sourcePaths = [
    "packages/core/src/names.ts",
    "tests/agents-sections.test.mjs",
    "tests/cloud-roots.test.mjs",
    "tests/configuration-projections.test.mjs",
    "tests/p1-all-legs.test.mjs",
    "tests/privacy-boundary.test.mjs",
    "tests/push-wiki.test.mjs",
    "tests/registry-resolve.test.mjs",
    "tests/release-lockstep.test.mjs",
    "tests/setup-fresh.test.mjs",
    "tests/variables-cli.test.mjs",
    "tests/variables.test.mjs",
  ];
  const names = await readFile(join(repositoryRoot, "packages/core/src/names.ts"), "utf8");
  const owner = names.match(/owner:\s*"([^"]+)"/u)?.[1];
  assert.ok(owner, "the public owner metadata is present in the reviewed names file");
  const sourceEntries = await Promise.all(sourcePaths.map(async (path) => ({
    label: path,
    kind: "source",
    content: await readFile(join(repositoryRoot, path), "utf8"),
  })));
  assert.deepEqual(scanPrivacyEntries(sourceEntries, { owner }), []);

  const p1Path = "tests/p1-all-legs.test.mjs";
  const p1Fixture = sourceEntries.find((entry) => entry.label === p1Path)?.content;
  assert.ok(p1Fixture, "the reviewed P1 test fixture is present in the source surface");
  const p1Email = p1Fixture.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu)?.[0];
  const p1EmailLine = p1Fixture.split("\n").find((line) => line.includes('"user.email"'));
  assert.ok(p1Email, "the reviewed test identity sample is present");
  assert.ok(p1EmailLine, "the sample is used only on the fixture's Git identity line");

  const p1BlobIdResult = spawnSync("git", ["rev-parse", `HEAD:${p1Path}`], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(p1BlobIdResult.status, 0, "the current fixture blob is reachable from HEAD");
  const p1BlobId = p1BlobIdResult.stdout.trim();
  const p1BlobResult = spawnSync("git", ["cat-file", "blob", p1BlobId], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(p1BlobResult.status, 0, "the current fixture blob can be read");
  assert.equal(p1BlobResult.stdout, p1Fixture, "the reachable blob carries the reviewed source bytes");
  assert.deepEqual(scanPrivacyEntries([{
    label: `git-blob:${p1BlobId}`,
    kind: "blob",
    sourcePaths: [p1Path],
    content: p1BlobResult.stdout,
  }], { owner }), []);

  const p1Archive = writeUstar([{ path: p1Path, bytes: Buffer.from(p1Fixture, "utf8") }]);
  assert.deepEqual(scanPrivacyEntries([{
    label: "dist/source/einzbern-source.tar",
    kind: "archive",
    content: p1Archive,
  }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{
    label: "dist/release/einzbern-1.2.1-source.tar",
    kind: "release",
    content: p1Archive,
  }], { owner }), []);

  const changedLine = p1Fixture.replace(p1EmailLine, `${p1EmailLine} // changed`);
  assert.ok(scanPrivacyEntries([{ label: p1Path, kind: "source", content: changedLine }], { owner })
    .includes(`EMAIL_IDENTIFIER:source:${p1Path}`), "a changed full-line digest remains a finding");
  assert.ok(scanPrivacyEntries([{ label: "tests/other-fixture.test.mjs", kind: "source", content: p1Fixture }], { owner })
    .includes("EMAIL_IDENTIFIER:source:tests/other-fixture.test.mjs"), "the same sample on another path remains a finding");
  const changedMatch = p1Fixture.replace(p1Email, joinParts(["different", "@", "example.invalid"], ""));
  assert.ok(scanPrivacyEntries([{ label: p1Path, kind: "source", content: changedMatch }], { owner })
    .includes(`EMAIL_IDENTIFIER:source:${p1Path}`), "a changed match digest remains a finding");

  const variableFixture = await readFile(join(repositoryRoot, "tests/variables.test.mjs"), "utf8");
  assert.deepEqual(scanPrivacyEntries([{
    label: `git-blob:${"a".repeat(40)}`,
    kind: "blob",
    sourcePaths: ["tests/variables.test.mjs"],
    content: variableFixture,
  }], { owner }), []);

  const unreviewedToken = ["ghp_", "Q".repeat(24)].join("");
  const unreviewedContent = `const candidate = ${JSON.stringify(unreviewedToken)};\n`;
  assert.ok(scanPrivacyEntries([{
    label: "tests/variables.test.mjs",
    kind: "source",
    content: unreviewedContent,
  }], { owner }).includes("GITHUB_CLASSIC_TOKEN:source:tests/variables.test.mjs"));
  assert.ok(scanPrivacyEntries([{
    label: `git-blob:${"b".repeat(40)}`,
    kind: "blob",
    sourcePaths: ["tests/variables.test.mjs", "src/runtime-config.mjs"],
    content: variableFixture,
  }], { owner }).some((finding) => finding.startsWith("GITHUB_CLASSIC_TOKEN:blob:")));

  const cloudRoots = await readFile(join(repositoryRoot, "tests/cloud-roots.test.mjs"));
  const privateFilename = `fixtures/${"member"}@${"example.invalid"}.txt`;
  const archive = writeUstar([
    { path: "tests/cloud-roots.test.mjs", bytes: cloudRoots },
    { path: "src/new-secret.mjs", bytes: Buffer.from(unreviewedContent, "utf8") },
    { path: privateFilename, bytes: Buffer.from("safe\n", "utf8") },
  ]);
  const originalArchive = Buffer.from(archive);
  const archiveFindings = scanPrivacyEntries([{
    label: "dist/release/einzbern-1.2.1-source.tar",
    kind: "release",
    content: archive,
  }], { owner });
  assert.deepEqual(archive, originalArchive, "scanning leaves the archive bytes unchanged");
  assert.ok(archiveFindings.some((finding) => finding.startsWith("GITHUB_CLASSIC_TOKEN:release:") && finding.endsWith("#body:src/new-secret.mjs")));
  assert.ok(archiveFindings.some((finding) => finding.startsWith("EMAIL_IDENTIFIER:release:") && finding.includes("#header:fixtures/")));
});

test("reviewed mailto sample retains exact source, blob and source-tar boundaries", async () => {
  const root = resolve(import.meta.dirname, "..");
  const path = "tests/release-lockstep.test.mjs";
  const bytes = await readFile(join(root, path));
  const originalBytes = Buffer.from(bytes);
  const fixture = bytes.toString("utf8");
  const lines = fixture.split("\n").filter((line) => line.includes("(mailto:"));
  assert.equal(lines.length, 1, "there is exactly one reviewed mailto fixture line");
  const line = lines[0];
  const email = line.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu)?.[0];
  assert.ok(email, "the reviewed value is derived from the existing fixture");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(email), "2f761a0ba6fc6541787d69b3833f6979dadb036ef2c610f73e3ecb0ad843eb76");
  assert.equal(digest(normalizePrivacyText(line)), "a7efd70d054a3dd966911e119aa4dccde720f7452a7c16b5724aacd262a8862e");
  const names = await readFile(join(root, "packages/core/src/names.ts"), "utf8");
  const owner = names.match(/owner:\s*"([^"]+)"/u)?.[1];
  assert.ok(owner);
  const scan = (entry) => {
    const original = {
      ...entry,
      content: Buffer.isBuffer(entry.content) ? Buffer.from(entry.content) : entry.content,
      ...(entry.sourcePaths === undefined ? {} : { sourcePaths: [...entry.sourcePaths] }),
    };
    const findings = scanPrivacyEntries([entry], { owner });
    assert.deepEqual(entry, original, "scanning leaves the input entry and bytes unchanged");
    return findings;
  };
  const rejected = (entry, label = entry.label) => {
    assert.ok(scan(entry).includes(`EMAIL_IDENTIFIER:${entry.kind}:${label}`),
      "the targeted entry must retain its email finding");
  };
  assert.deepEqual(scan({ label: path, kind: "source", content: fixture }), []);
  const object = fixtureGit(root, ["rev-parse", `HEAD:${path}`]).trim();
  const blob = fixtureGit(root, ["cat-file", "blob", object], { raw: true });
  assert.deepEqual(blob, bytes, "the reachable HEAD blob equals the complete source fixture");
  const blobEntry = { label: `git-blob:${object}`, kind: "blob", sourcePaths: [path], content: blob.toString("utf8") };
  assert.deepEqual(scan(blobEntry), []);

  const archive = writeUstar([{ path, bytes }]);
  const members = readUstar(archive);
  assert.equal(members.length, 1);
  assert.equal(members[0].path, path);
  assert.deepEqual(members[0].bytes, bytes, "the real tar member retains the complete source bytes");
  const archiveEntries = [
    { label: "dist/source/einzbern-source.tar", kind: "archive", content: archive },
    { label: "dist/release/einzbern-3.0.0-source.tar", kind: "release", content: archive },
  ];
  for (const entry of archiveEntries) assert.deepEqual(scan(entry), []);
  assert.deepEqual(bytes, originalBytes, "source bytes remain unchanged across all positive surfaces");

  // Isolate the reviewed line: no other private fixture can satisfy these assertions.
  const source = { label: path, kind: "source", content: line };
  assert.deepEqual(scan(source), []);
  const changedPath = "tests/unreviewed-mailto.test.mjs";
  rejected({ ...source, label: changedPath });
  const changedValue = `changed-${email}`;
  rejected({ ...source, content: line.replace(email, changedValue) });
  rejected({ ...source, content: `${line} // changed` });
  const isolatedBlob = { ...blobEntry, content: line };
  assert.deepEqual(scan(isolatedBlob), []);
  rejected({ label: isolatedBlob.label, kind: "blob", content: line });
  for (const sourcePaths of [[], [changedPath], [path, changedPath]]) {
    rejected({ ...isolatedBlob, sourcePaths });
  }
  rejected({
    label: `dist/release/einzbern-3.0.0.tar.gz/einzbern-3.0.0/${path}`,
    kind: "release", releaseArchiveMember: true, sourcePaths: [path], content: line,
  });
  const escapedPayload = [...changedValue].map((character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  assert.equal(normalizePrivacyText(escapedPayload), changedValue, "escaped bytes decode to the additional value");
  const extraPayloads = [changedValue, escapedPayload];
  for (const payload of extraPayloads) {
    rejected({ ...source, content: `${line}\n${payload}\n` });
  }
  for (const entry of archiveEntries) {
    const changedMember = writeUstar([{ path: changedPath, bytes: Buffer.from(line) }]);
    rejected({ ...entry, content: changedMember }, `${entry.label}#body:${changedPath}`);
    for (const content of [line.replace(email, changedValue), `${line} // changed`,
      ...extraPayloads.map((payload) => `${line}\n${payload}\n`)]) {
      rejected({ ...entry, content: writeUstar([{ path, bytes: Buffer.from(content) }]) },
        `${entry.label}#body:${path}`);
    }
  }
});

test("DS publication provenance is classified only at exact inventory source lines", async () => {
  const root = resolve(import.meta.dirname, "..");
  const names = await readFile(join(root, "packages/core/src/names.ts"), "utf8");
  const owner = names.match(/owner:\s*"([^"]+)"/u)?.[1];
  assert.ok(owner);
  for (const family of ["component", "copy", "limit", "scope"]) {
    const path = `docs/verification/init053-owner-return-${family}-inventory.json`;
    const content = await readFile(join(root, path), "utf8");
    const line = content.split("\n").find(value => value.includes(`/TCRN-Design-System/pull/23`));
    assert.ok(line);
    const entry = { label: path, kind: "source", content: line };
    assert.deepEqual(scanPrivacyEntries([entry], { owner }), []);
    assert.deepEqual(scanPrivacyEntries([{ label: "git-blob:reviewed-inventory", kind: "blob", sourcePaths: [path], content: line }], { owner }), []);
    const tar = writeUstar([{ path, bytes: Buffer.from(line) }]);
    for (const [kind, label] of [["archive", "dist/source/einzbern-source.tar"], ["release", "dist/release/einzbern-source.tar"]]) assert.deepEqual(scanPrivacyEntries([{ label, kind, content: tar }], { owner }), []);
    const negatives = [
      { ...entry, content: line.replace("/pull/23", "/pull/24") },
      { ...entry, content: line.replace("TCRN-Design-System", "other-repository") },
      { ...entry, content: line + " " },
      { ...entry, content: owner },
      { ...entry, content: line + "\n" + owner },
      { ...entry, label: "docs/verification/other-inventory.json" },
      { label: "git-blob:unknown", kind: "blob", content: line },
      { label: "git-blob:mixed-origin", kind: "blob", sourcePaths: [path, "other.json"], content: line },
      { ...entry, content: line.replace(owner, owner + "-other") },
    ];
    for (const candidate of negatives) assert.ok(scanPrivacyEntries([candidate], { owner }).some(value => value.startsWith("OWNER_PRIVATE_IDENTIFIER:")), JSON.stringify(candidate));
    const privatePath = ["/", "Users", "/", owner, "/Code"].join("");
    assert.ok(scanPrivacyEntries([{ ...entry, content: line + "\n" + privatePath }], { owner }).some(value => value.startsWith("MACOS_HOME_PATH:") || value.startsWith("OWNER_PRIVATE_IDENTIFIER:")));
  }
});

test("P8 classifies only the exact compiled public-owner metadata line", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const names = await readFile(join(repositoryRoot, "packages/core/src/names.ts"), "utf8");
  const owner = names.match(/owner:\s*"([^"]+)"/u)?.[1];
  assert.ok(owner, "the owner value comes from the reviewed source metadata");
  const sourceOwnerLine = names.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.ok(sourceOwnerLine, "the value is the owner field of the public metadata object");
  assert.equal(createHash("sha256").update(owner, "utf8").digest("hex"), "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f");
  assert.equal(createHash("sha256").update(sourceOwnerLine, "utf8").digest("hex"), "acbbf0306043799672e383fe5bdfc98bfe0a2b1675085c911fce83869dc4a4be");

  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.ok(ownerLine, "the compiler output carries the reviewed owner field");
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  assert.deepEqual(scanPrivacyEntries([{ label: buildPath, kind: "build", content: buildContent }], { owner }), []);

  const changedLine = buildContent.replace(ownerLine, `${ownerLine} // changed`);
  assert.ok(scanPrivacyEntries([{ label: buildPath, kind: "build", content: changedLine }], { owner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:build:${buildPath}`));
  assert.ok(scanPrivacyEntries([{ label: "dist/build/packages/core/src/other.js", kind: "build", content: buildContent }], { owner })
    .includes("OWNER_PRIVATE_IDENTIFIER:build:dist/build/packages/core/src/other.js"));

  const releaseLabels = [
    "dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/atelier/portal.mjs",
    "dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/scripts/einzbern-hook.mjs",
    "dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/scripts/einzbern.mjs",
  ];
  const releaseEntries = releaseLabels.map((label) => ({
    label,
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(label),
    content: ownerLine,
  }));
  assert.deepEqual(releaseEntries.map((entry) => entry.sourcePaths), releaseLabels.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(releaseEntries, { owner }), []);

  const target = releaseEntries[0];
  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  assert.ok(ownerFinding({ ...target, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  assert.ok(ownerFinding({ ...target, sourcePaths: ["dist/build/packages/core/src/other.js"] }), "another source path remains unclassified");

  const changedLabel = target.label.replace("/atelier/portal.mjs", "/atelier/other.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(changedLabel), [], "a nearby archive path has no trusted source mapping");
  assert.ok(ownerFinding({ ...target, label: changedLabel, sourcePaths: p8ReleasePrivacySourcePaths(changedLabel) }));
  assert.deepEqual(p8ReleasePrivacySourcePaths(target.label.replace("1.2.1", "1.2.2")), [], "another package version is not covered");

  assert.ok(ownerFinding({ ...target, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
  const changedOwner = publicIdentity.login;
  const changedValueLine = ownerLine.replaceAll(owner, changedOwner);
  assert.ok(ownerFinding({ ...target, content: changedValueLine }, changedOwner), "a changed metadata value remains a finding");

  const credential = `ghp_${"Q".repeat(24)}`;
  const credentialFindings = scanPrivacyEntries([{
    ...target,
    content: `${ownerLine}\nconst credential = ${JSON.stringify(credential)};\n`,
  }], { owner });
  assert.ok(credentialFindings.includes(`GITHUB_CLASSIC_TOKEN:release:${target.label}`), "an unrelated real-credential pattern remains a finding");
});

// TCRN-CROSS-SUB-357 S1 (INIT-053 R41 B2): the reviewed 2.0.0 package members carry the same compiled
// owner line and are classified by their own exact labels; nothing else of 2.0.0 or another version is.
test("P8 classifies only the exact reviewed 2.0.0 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "0", "0"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // Later reviewed versions have their own exact rules; the draft 2.2.4 remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-INIT-053 U23 P-F: the reviewed 2.0.1 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is the complete helper address, public on its own; nothing else of 2.0.1 or
// another version is classified.
test("P8 classifies only the exact reviewed 2.0.1 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "0", "1"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // Later reviewed versions have their own exact rules; the draft 2.2.4 remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-INIT-053 R54 PF: the reviewed 2.0.2 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is again the complete helper address, public on its own; nothing else of
// 2.0.2 or another version is classified.
test("P8 classifies only the exact reviewed 2.0.2 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "0", "2"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // Later reviewed versions have their own exact rules; the draft 2.2.4 remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-EPIC-149 R2 PF: the reviewed 2.0.3 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is again the complete helper address, public on its own; nothing else of
// 2.0.3 or another version is classified.
test("P8 classifies only the exact reviewed 2.0.3 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "0", "3"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // Later reviewed versions have their own exact rules; the draft 2.2.4 remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-EPIC-149 R5 PF: the reviewed 2.1.0 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is again the complete helper address, public on its own; nothing else of
// 2.1.0 or another version is classified.
test("P8 classifies only the exact reviewed 2.1.0 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "1", "0"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // Later reviewed versions have their own exact rules; the draft 2.2.4 remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-EPIC-150 R9 PF-2: the reviewed 2.2.0 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is again the complete helper address, public on its own; nothing else of
// 2.2.0 or another version is classified.
test("P8 classifies only the exact reviewed 2.2.0 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "2", "0"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // 2.2.1 through 2.2.3 have exact reviewed rules; the draft 2.2.4 version remains unclassified.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

// TCRN-CROSS-EPIC-151 R11 PF-2: the reviewed 2.2.1 package members carry the same compiled owner line
// and are classified by their own exact labels. The other owner occurrence the review found, in
// scripts/einzbern.mjs, is again the complete helper address, public on its own; nothing else of
// 2.2.1 or another version is classified.
test("P8 classifies only the exact reviewed 2.2.1 package members", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const buildContent = await readFile(join(repositoryRoot, buildPath), "utf8");
  const ownerLine = buildContent.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const version = joinParts(["2", "2", "1"], ".");
  const member = (path, packageVersion = version) => joinParts(["dist", "release", `${BRAND.engine.id}-${packageVersion}.tar.gz`, `${BRAND.engine.id}-${packageVersion}`, path], "/");
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const entries = memberPaths.map((path) => ({
    label: member(path),
    kind: "release",
    releaseArchiveMember: true,
    sourcePaths: p8ReleasePrivacySourcePaths(member(path)),
    content: ownerLine,
  }));
  assert.deepEqual(entries.map((entry) => entry.sourcePaths), memberPaths.map(() => [buildPath]));
  assert.deepEqual(scanPrivacyEntries(entries, { owner }), []);

  const installLine = `        \`1. Install this skill: \\\`npx skills add ${owner}/${BRAND.helper.id}\\\`, or ask the host to find the skill.`;
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], content: `${ownerLine}\n${installLine}\n` }], { owner }), []);
  assert.deepEqual(scanPrivacyEntries([{ ...entries[2], sourcePaths: [], content: installLine }], { owner }), [], "the helper address needs no member rule");

  const ownerFinding = (entry, scanOwner = owner) => scanPrivacyEntries([entry], { owner: scanOwner })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  // The draft version after the reviewed 2.2.3 package has no rules yet.
  const nextVersion = joinParts(["2", "2", "4"], ".");
  for (const path of memberPaths) {
    assert.deepEqual(p8ReleasePrivacySourcePaths(member(path, nextVersion)), [], "2.2.4 is not covered");
    assert.ok(ownerFinding({ ...entries[0], label: member(path, nextVersion), sourcePaths: p8ReleasePrivacySourcePaths(member(path, nextVersion)) }));
  }
  const adjacent = member("launchers/einzbern.mjs");
  assert.deepEqual(p8ReleasePrivacySourcePaths(adjacent), [], "an adjacent member has no source mapping");
  assert.ok(ownerFinding({ ...entries[0], label: adjacent, sourcePaths: p8ReleasePrivacySourcePaths(adjacent) }));
  for (const entry of entries) {
    assert.ok(ownerFinding({ ...entry, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
    const changedOwner = publicIdentity.login;
    assert.ok(ownerFinding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner), "a changed metadata value remains a finding");
    assert.ok(ownerFinding({ ...entry, releaseArchiveMember: undefined }), "a source path alone does not exempt a release entry");
  }
});

test("private/raw identifiers and common secret families fail closed", () => {
  const cases = [
    ["raw email", joinParts(["person", "@", "example.invalid"], ""), "EMAIL_IDENTIFIER"],
    ["fine-grained GitHub", `github_pat_${"A".repeat(32)}`, "GITHUB_FINE_GRAINED_TOKEN"],
    ["AWS session", `ASIA${"A".repeat(16)}`, "AWS_ACCESS_KEY"],
    ["npm", `npm_${"A".repeat(36)}`, "NPM_TOKEN"],
    ["Slack", `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`, "SLACK_TOKEN"],
    ["cloud", `AIza${"A".repeat(35)}`, "GOOGLE_API_KEY"],
    ["JWT", `${"eyJ"}${"A".repeat(24)}.${"B".repeat(24)}.${"C".repeat(24)}`, "JWT_TOKEN"],
    ["authenticated URL", joinParts(["https://user", ":", "password", "@", "example.invalid/path"], ""), "AUTHENTICATED_URL"],
    ["authenticated postgres URL", joinParts(["postgresql://user", ":", "password", "@", "db.example.invalid/schema"], ""), "AUTHENTICATED_URL"],
    ["private VM hostname", joinParts(["ssh to", PRIVATE_VM_HOST], " "), "PRIVATE_HOSTNAME"],
    ["private DNS hostname", joinParts(["read from", PRIVATE_DNS_HOST], " "), "PRIVATE_HOSTNAME"],
    ["private user at host", joinParts(["ssh", joinParts(["deploy", "@"], "") + PRIVATE_VM_HOST], " "), "PRIVATE_USER_AT_HOST"],
    ["private key", joinParts(["-----BEGIN OPENSSH", " PRIVATE KEY-----"], ""), "PRIVATE_KEY"],
    ["customer marker", joinParts(["tenant", "-", "export.csv"], ""), "CUSTOMER_SOURCE_MARKER"],
    ["linux home path", joinParts(["/", "home", "/", "user1", "/work"], ""), "LINUX_HOME_PATH"],
    ["raw windows path", joinParts(["C", ":", "\\", "Users", "\\", "user1"], ""), "WINDOWS_USER_PATH"],
  ];
  for (const [label, content, reasonCode] of cases) {
    const findings = scanPrivacyEntries([{ label, kind: "source", content }], {
      owner: publicIdentity.login,
    });
    assert.ok(findings.some((finding) => finding.startsWith(`${reasonCode}:`)), label);
  }
});

test("safe runtime construction keeps private URL and host boundaries red without rejecting public URLs", () => {
  const privateHost = joinParts(["vm-aos", "internal"], ".");
  const authenticated = joinParts(["https://service", ":", "secret", "@", privateHost, "/repo"], "");
  const privateSsh = joinParts(["ssh", "://", privateHost, "/repo"], "");
  const findings = scanPrivacyEntries([
    { label: "runtime-authenticated", kind: "source", content: authenticated },
    { label: "runtime-ssh", kind: "source", content: privateSsh },
    { label: "runtime-host", kind: "source", content: privateHost },
    { label: "public-url", kind: "source", content: joinParts(["https://example", ".invalid/docs"], "") },
  ], { owner: publicIdentity.login });
  assert.ok(findings.some((finding) => finding.startsWith("AUTHENTICATED_URL:source:runtime-authenticated")));
  assert.ok(findings.some((finding) => finding.startsWith("PRIVATE_SSH_URL:source:runtime-ssh")));
  assert.ok(findings.some((finding) => finding.startsWith("PRIVATE_HOSTNAME:source:runtime-host")));
  assert.equal(findings.some((finding) => finding.includes("public-url")), false);
});

test("private values reconstructed by common obfuscation forms are normalized before scanning", () => {
  const token = ["fixture", "-private.invalid"].join("");
  const hex = [...token].map((character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
  const unicode = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const base64 = Buffer.from(token, "utf8").toString("base64");
  const cases = [
    `["fixture","-private.invalid"].join("")`,
    hex,
    unicode,
    "fixture[-]private.invalid",
    `String.fromCharCode(${[...token].map((character) => character.charCodeAt(0)).join(",")})`,
    `Buffer.from("${base64}", "base64").toString("utf8")`,
  ];
  for (const content of cases) {
    assert.equal(normalizePrivacyText(content), token, content);
    const findings = scanPrivacyEntries([{ label: "obfuscated", kind: "source", content }], {
      owner: publicIdentity.login,
      privateTokens: [token],
    });
    assert.ok(findings.some((finding) => finding.startsWith("PRIVATE_RUNTIME_VALUE:")), content);
  }
});

test("joined, reversed and unmatched arrays preserve the privacy scan summary and findings", () => {
  const entries = [
    {
      path: "normalization/joined.mjs",
      label: "normalization/joined.mjs",
      kind: "source",
      content: 'const path = ["/Users/", "fixture-user/private.txt"].join("");',
    },
    {
      path: "normalization/reversed.mjs",
      label: "normalization/reversed.mjs",
      kind: "source",
      content: 'const remote = ["fixture.internal/repo", "ssh://"].reverse().join("");',
    },
    {
      path: "normalization/unmatched.mjs",
      label: "normalization/unmatched.mjs",
      kind: "source",
      content: String.raw`const examples = ["C:\\Users\\fixture-user", "safe"];`,
    },
  ];
  const progress = [];
  const findings = scanPrivacyEntries(entries, {
    owner: publicIdentity.login,
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(progress, [{ entriesScanned: entries.length, totalEntries: entries.length }]);
  assert.deepEqual(findings, [
    "LOCAL_ABSOLUTE_PATH:source:normalization/joined.mjs",
    "PRIVATE_HOSTNAME:source:normalization/reversed.mjs",
    "PRIVATE_SSH_URL:source:normalization/reversed.mjs",
    "WINDOWS_USER_PATH:source:normalization/unmatched.mjs",
  ]);
  assert.deepEqual(aggregatePrivacySurface(entries), {
    entries: entries.length,
    bytes: entries.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0),
    sha256: "a04984a5487e4bffaf726c1c56eafc39e72577f3d9b1b93db2a45f2593d9333d",
  });
});

test("filenames are scanned as privacy-bearing metadata", () => {
  const findings = scanPrivacyEntries(
    [{
      label: joinParts(["customer", "-", "export.csv"], ""),
      kind: "filename",
      content: joinParts(["customer", "-", "export.csv"], ""),
    }],
    { owner: publicIdentity.login },
  );
  assert.ok(findings.some((finding) => finding.startsWith("CUSTOMER_SOURCE_MARKER:")));
});

test("repeated historical filename findings retain every commit label and progress count", () => {
  const path = joinParts(["/", "Users", "/", "fixture-user", "/", "customer-export.csv"], "");
  const entries = [
    { label: "commit-one:customer-export.csv", kind: "filename", content: path },
    { label: "commit-two:customer-export.csv", kind: "filename", content: path },
  ];
  const progress = [];
  assert.deepEqual(scanPrivacyEntries(entries, {
    owner: publicIdentity.login,
    onProgress: (snapshot) => progress.push(snapshot),
  }), [
    "LOCAL_ABSOLUTE_PATH:filename:commit-one:customer-export.csv",
    "CUSTOMER_SOURCE_MARKER:filename:commit-one:customer-export.csv",
    "LOCAL_ABSOLUTE_PATH:filename:commit-two:customer-export.csv",
    "CUSTOMER_SOURCE_MARKER:filename:commit-two:customer-export.csv",
  ]);
  assert.deepEqual(progress, [{ entriesScanned: 2, totalEntries: 2 }]);
});

test("only the exact public P3 marker contract bypasses control-path rejection", () => {
  const marker = joinParts([".", "context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json"], "");
  assert.deepEqual(
    scanPrivacyEntries([{ label: "contract", kind: "source", content: marker }], { owner: publicIdentity.login }),
    [],
  );
  const sibling = joinParts([".", "context/private-note.json"], "");
  assert.ok(
    scanPrivacyEntries([{ label: "sibling", kind: "source", content: sibling }], { owner: publicIdentity.login })
      .some((finding) => finding.startsWith("CONTROL_PLANE_PATH:")),
  );
});

test("recursive historical tree records preserve privacy-bearing full paths", () => {
  assert.deepEqual(parseHistoricalTreePaths(""), []);
  assert.throws(() => parseHistoricalTreePaths("malformed"), /PRIVACY_TREE_RECORD_INVALID/u);
  const object = "a".repeat(40);
  const controlPath = `${joinParts([".", "context"], "")}/private-note.md`;
  const machinePath = joinParts(["nested", "Users", "local-user", "cache.txt"], "/");
  const records = [
    `100644 blob ${object}\t${controlPath}`,
    `100644 blob ${object}\t${machinePath}`,
  ].join("\0") + "\0";
  const paths = parseHistoricalTreePaths(records);
  assert.deepEqual(paths, [controlPath, machinePath]);
  const findings = scanPrivacyEntries(
    paths.map((path) => ({ label: path, kind: "filename", content: path })),
    { owner: publicIdentity.login },
  );
  assert.ok(findings.some((finding) => finding.startsWith("CONTROL_PLANE_PATH:")));
  assert.ok(findings.some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")));
});

test("batched tree-object walking preserves every historical commit path and order", async (context) => {
  const root = await emptyFixtureRepository(context, "tcrn-privacy-tree-walk-");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "alpha.txt"), "first revision\n");
  await writeFile(join(root, "src", "nested", "line\nbreak.txt"), "nested path\n");
  await writeFile(join(root, "src-alpha.txt"), "tree ordering\n");
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["commit", "-q", "-m", "first tree"]);

  await rm(join(root, "alpha.txt"));
  await writeFile(join(root, "customer-export.csv"), "second revision\n");
  const gitlink = "b".repeat(40);
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},submodule`]);
  fixtureGit(root, ["commit", "-q", "-m", "second tree"]);

  const commits = fixtureGit(root, ["rev-list", "HEAD"]).split("\n").filter(Boolean);
  const objectRecords = parseGitObjectBatch(fixtureGit(root, batchArguments, { raw: true }), declaredBatchBytes(root))
    .map(({ object, type, content }) => ({ path: `${type}:${object}`, content }));
  const actual = [];
  const progress = [];
  const summary = await walkHistoricalCommitPaths(
    commits,
    objectRecords,
    (commit, path, object) => actual.push({ commit, path, object }),
    (snapshot) => progress.push(snapshot),
  );
  const expected = [];
  const expectedObjects = [];
  for (const commit of commits) {
    const listing = fixtureGit(root, ["ls-tree", "-rz", "--full-tree", commit], { raw: true });
    const text = decodeGitMetadataBytes(listing, "PRIVACY_TREE_UTF8_INVALID");
    const paths = parseHistoricalTreePaths(text);
    expected.push(...paths.map((path) => ({ commit, path })));
    expectedObjects.push(...text.split("\0").filter(Boolean).map((record) => {
      const separator = record.indexOf("\t");
      const [mode, type, object] = record.slice(0, separator).split(" ");
      return { commit, path: record.slice(separator + 1), object, mode, type };
    }).map(({ commit, path, object }) => ({ commit, path, object })));
  }
  assert.deepEqual(actual, expectedObjects);
  assert.deepEqual(actual.map(({ commit, path }) => ({ commit, path })), expected);
  assert.equal(summary.commits, commits.length);
  assert.equal(summary.historicalPaths, expected.length);
  const pathSummaryDigest = (records) => {
    const digest = createHash("sha256");
    for (const { commit, path } of records) {
      digest.update(commit, "utf8");
      digest.update("\0", "utf8");
      digest.update(String(Buffer.byteLength(path, "utf8")), "utf8");
      digest.update("\0", "utf8");
      digest.update(path, "utf8");
    }
    return digest.digest("hex");
  };
  assert.equal(pathSummaryDigest(actual), pathSummaryDigest(expected));
  assert.deepEqual(progress.map(({ completedCommits }) => completedCommits), commits.map((_, index) => index + 1));
  assert.ok(actual.some(({ path }) => path === "src/nested/line\nbreak.txt"));
  assert.ok(actual.some(({ path }) => path === "submodule"));
  const asEntries = (records) => records.map(({ commit, path }) => ({
    label: `git-commit-tree:${commit}:${path}`,
    kind: "filename",
    content: path,
  }));
  assert.deepEqual(
    scanPrivacyEntries(asEntries(actual), { owner: publicIdentity.login }),
    scanPrivacyEntries(asEntries(expected), { owner: publicIdentity.login }),
  );
  assert.ok(scanPrivacyEntries(asEntries(actual), { owner: publicIdentity.login })
    .some((finding) => finding.startsWith("CUSTOMER_SOURCE_MARKER:")));
});

test("regex syntax in both historical blobs is not a fake username, while real paths remain red", () => {
  const historicalBlobIds = [
    "317076496f96385e9e8e46dbba7f916dc0f1c63b",
    "5ea8e50a91e65b4494196b44f117faba73d40ce3",
  ];
  const engineRoot = resolve(import.meta.dirname, "..");
  const concretePath = joinParts(["/", "Users", "/", "fixture-user", "/", "private.txt"], "");
  for (const object of historicalBlobIds) {
    const result = spawnSync("git", ["cat-file", "-p", object], { cwd: engineRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      scanPrivacyEntries([{ label: `historical:${object}`, kind: "blob", content: result.stdout }], { owner: publicIdentity.login }),
      [],
      `regex-only historical blob ${object}`,
    );
    const withRealPath = `${result.stdout}\nconst privatePath = ${JSON.stringify(concretePath)};\n`;
    assert.ok(
      scanPrivacyEntries([{ label: `historical-plus-data:${object}`, kind: "blob", content: withRealPath }], { owner: publicIdentity.login })
        .some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")),
      `real path appended to ${object}`,
    );
  }
  const escapedRegex = joinParts(["/", "\\/", "Users", "\\/", "fixture-user", "\\/", "private", "\\.", "txt", "/"], "");
  const quoted = JSON.stringify(concretePath);
  const joined = `[${JSON.stringify(joinParts(["/", "Users", "/"], ""))},${JSON.stringify(joinParts(["fixture-user", "/private.txt"], ""))}].join("")`;
  const encoded = Buffer.from(concretePath, "utf8").toString("base64");
  for (const content of [escapedRegex, quoted, joined, `Buffer.from(${JSON.stringify(encoded)}, "base64")`]) {
    assert.ok(
      scanPrivacyEntries([{ label: "concrete-path-form", kind: "source", content }], { owner: publicIdentity.login })
        .some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")),
      content,
    );
  }
});

test("regex literal projection preserves literal colons while removing group syntax", () => {
  const regex = (parts) => joinParts(["const pattern = /", ...parts, "/;"], "");
  const cases = [
    ["postgres-credentials-regex", regex(["postgres", ":", "\\/\\/", "alice", ":", "secret@localhost", "\\/db"]), ["AUTHENTICATED_URL"]],
    ["postgres-escaped-colon-regex", regex(["postgres\\:", "\\/\\/", "alice", ":", "secret@localhost", "\\/db"]), ["AUTHENTICATED_URL"]],
    ["postgres-noncapturing-regex", regex(["(?:postgres", ":", "\\/\\/", "alice", ":", "secret@localhost", "\\/db)"]), ["AUTHENTICATED_URL"]],
    ["ssh-regex", regex(["ssh", ":", "\\/\\/localhost", "\\/repo"]), ["PRIVATE_SSH_URL"]],
    ["ssh-noncapturing-regex", regex(["(?:ssh", ":", "\\/\\/localhost", "\\/repo)"]), ["PRIVATE_SSH_URL"]],
    ["adjacent-private-values", regex(["(?:https", ":", "\\/\\/alice", ":", "secret@db", ".internal", "\\/db)"]), ["AUTHENTICATED_URL", "PRIVATE_HOSTNAME"]],
  ];
  for (const [label, content, reasonCodes] of cases) {
    const findings = scanPrivacyEntries([{ label, kind: "source", content }], { owner: publicIdentity.login });
    for (const reasonCode of reasonCodes) {
      assert.ok(findings.some((finding) => finding.startsWith(`${reasonCode}:`)), `${label}: ${reasonCode}`);
    }
  }
});

test("staged privacy command scans index bytes before a commit and leaves history scope intact", async (context) => {
  const root = await emptyFixtureRepository(context, "tcrn-privacy-staged-");
  const checker = resolve(import.meta.dirname, "../scripts/verify-staged-privacy.mjs");
  fixtureGit(root, ["remote", "add", "origin", `https://github.com/public-contributor/${LEGACY_REPOSITORY_NAMES.engine}.git`]);
  await writeFile(join(root, "fixture.txt"), "safe baseline\n");
  fixtureGit(root, ["add", "fixture.txt"]);
  fixtureGit(root, ["commit", "-q", "-m", "baseline"]);

  const forbiddenHost = joinParts(["vm-aos", ".internal"], "");
  const forbidden = joinParts(["https://service", ":", "secret", "@", forbiddenHost, "/repo"], "");
  const forbiddenSsh = joinParts(["ssh", "://", forbiddenHost, "/repo"], "");
  await writeFile(join(root, "fixture.txt"), `${forbidden}\n${forbiddenSsh}\n`);
  fixtureGit(root, ["add", "fixture.txt"]);
  const red = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", maxBuffer: fixtureMaximumBytes });
  assert.equal(red.status, 1, red.stderr);
  assert.equal(red.stderr, "");
  const redReport = JSON.parse(red.stdout);
  assert.equal(redReport.reasonCode, "PRIVACY_STAGED_FINDINGS");
  assert.ok(redReport.findings.some((finding) => finding.startsWith("AUTHENTICATED_URL:")));
  assert.ok(redReport.findings.some((finding) => finding.startsWith("PRIVATE_SSH_URL:")));
  assert.ok(redReport.findings.some((finding) => finding.startsWith("PRIVATE_HOSTNAME:")));
  assert.equal(redReport.scope, "staged-index-increment-only");

  await writeFile(join(root, "fixture.txt"), "safe staged bytes\n");
  fixtureGit(root, ["add", "fixture.txt"]);
  const green = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", maxBuffer: fixtureMaximumBytes });
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stderr, "");
  const greenReport = JSON.parse(green.stdout);
  assert.equal(greenReport.reasonCode, "PRIVACY_STAGED_CLEAN");
  assert.equal(greenReport.stagedPaths, 1);
  assert.equal(greenReport.objects[0].scanned, true);
  assert.equal(greenReport.historicalScan, "preserved-by-pnpm-verify:privacy");
});

test("MIN-238 D4: only the two exact repository addresses under the reviewed owner are public metadata", async () => {
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  assert.equal(createHash("sha256").update(owner, "utf8").digest("hex"), "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f");
  const repositories = [BRAND.engine.id, BRAND.helper.id];
  assert.deepEqual(repositories, ["einzbern", "mana-orchestrate"], "the tuples name the engine and the helper repository");
  const masked = (content) => JSON.stringify(content.replaceAll(owner, "<owner>"));
  const ownerFindings = (content, { scanOwner = owner, ...entry } = {}) => scanPrivacyEntries(
    [{ label: "fixture", kind: "source", ...entry, content }],
    { owner: scanOwner },
  ).filter((finding) => finding.startsWith("OWNER_PRIVATE_IDENTIFIER:"));

  // Allowed: the complete literal, bare or behind https://github.com/, in any content surface.
  const contentSurfaces = [
    { kind: "source", label: "README.md" },
    { kind: "blob", label: `git-blob:${"c".repeat(40)}`, sourcePaths: ["README.md"] },
    { kind: "build", label: "dist/build/packages/core/src/skill-render.js" },
    { kind: "release", label: "dist/release/einzbern-1.2.1.tar.gz/einzbern-1.2.1/README.md", releaseArchiveMember: true, sourcePaths: [] },
    { kind: "commit", label: `git-commit:${"d".repeat(40)}` },
    { kind: "tag", label: `git-tag:${"e".repeat(40)}` },
  ];
  for (const repository of repositories) {
    const address = `${owner}/${repository}`;
    const url = `https://github.com/${address}`;
    for (const content of [
      address,
      url,
      `const RELEASE_REPOSITORY = "${address}";\n`,
      `npx skills add ${address}\n`,
      `> \`npx skills add ${address}\`, then install.\n`,
      `    \`1. Install this skill: \\\`npx skills add ${address}\\\`, or ask the host.\`,\n`,
      `[${repository}](${url}) and <${url}>\n`,
      `「${address}」`,
    ]) {
      for (const surface of contentSurfaces) {
        assert.deepEqual(ownerFindings(content, surface), [], `${surface.kind}: ${masked(content)}`);
      }
    }
  }
  assert.deepEqual(ownerFindings(`${owner}/${BRAND.engine.id} and https://github.com/${owner}/${BRAND.helper.id}\n`), []);
  const archive = writeUstar(repositories.map((repository) => ({
    path: `docs/${repository}.md`,
    bytes: Buffer.from(`npx skills add ${owner}/${repository}\n`, "utf8"),
  })));
  assert.deepEqual(scanPrivacyEntries([{ label: "dist/source/einzbern-source.tar", kind: "archive", content: archive }], { owner }), []);

  // Refused: the owner name in every other context keeps its finding.
  const refused = [
    ["the owner name alone", owner],
    ["a mention", `@${owner}`],
    ["the account page", `https://github.com/${owner}`],
    ["the account path", `https://github.com/${owner}/`],
    ["the legacy engine repository", `${owner}/${LEGACY_REPOSITORY_NAMES.engine}`],
    ["the legacy helper repository", `https://github.com/${owner}/${LEGACY_REPOSITORY_NAMES.helper}`],
    ["another repository", `${owner}/other`],
    ["a longer repository name", `${owner}/${BRAND.engine.id}-private`],
    ["a repository name with a suffix", `${owner}/${BRAND.helper.id}2`],
    ["a clone URL", `https://github.com/${owner}/${BRAND.engine.id}.git`],
    ["a release download URL", `https://github.com/${owner}/${BRAND.engine.id}/releases/download/v1.2.1/einzbern-1.2.1.tar.gz`],
    ["a path inside a repository", `${owner}/${BRAND.helper.id}/tree/main`],
    ["an issue reference", `${owner}/${BRAND.engine.id}#12`],
    ["a pinned reference", `${owner}/${BRAND.helper.id}@v1`],
    ["another scheme", `http://github.com/${owner}/${BRAND.engine.id}`],
    ["a host without a scheme", `github.com/${owner}/${BRAND.engine.id}`],
    ["another host", `https://gitlab.com/${owner}/${BRAND.engine.id}`],
    ["a package URL", `git+https://github.com/${owner}/${BRAND.engine.id}`],
    ["an SSH remote", `${joinParts(["git", "@", "github.com:"], "")}${owner}/${BRAND.engine.id}`],
    ["a local path", `${joinParts(["/", "Users", "/"], "")}${owner}/${BRAND.engine.id}`],
    ["a longer account name", `${owner}-bot/${BRAND.engine.id}`],
    ["an account name with a prefix", `x${owner}/${BRAND.engine.id}`],
    ["an address beside the owner name", `npx skills add ${owner}/${BRAND.helper.id} # maintained by ${owner}`],
    ["an address split across a join", `["${owner}", "${BRAND.engine.id}"].join("/")`],
  ];
  for (const [label, content] of refused) {
    assert.deepEqual(ownerFindings(content), ["OWNER_PRIVATE_IDENTIFIER:source:fixture"], `${label}: ${masked(content)}`);
  }
  assert.deepEqual(
    ownerFindings(`npx skills add ${owner}/${BRAND.helper.id}\nmaintained by ${owner}\n`),
    ["OWNER_PRIVATE_IDENTIFIER:source:fixture"],
    "an address elsewhere in the file exempts neither the file nor another line",
  );
  const otherOwner = publicIdentity.login;
  for (const content of [`${otherOwner}/${BRAND.engine.id}`, `https://github.com/${otherOwner}/${BRAND.helper.id}`]) {
    assert.deepEqual(ownerFindings(content, { scanOwner: otherOwner }), ["OWNER_PRIVATE_IDENTIFIER:source:fixture"], "the owner of each tuple is exact");
  }
  assert.deepEqual(ownerFindings(`${owner}/${BRAND.engine.id}`, { kind: "filename" }), ["OWNER_PRIVATE_IDENTIFIER:filename:fixture"], "a path that names the owner is not an address");
  assert.deepEqual(ownerFindings(`https://github.com/${owner}/${BRAND.helper.id}`, { kind: "remote" }), ["OWNER_PRIVATE_IDENTIFIER:remote:fixture"], "the origin rule is unchanged");
  const memberPath = `${owner}/${BRAND.engine.id}`;
  const namedArchive = writeUstar([{ path: memberPath, bytes: Buffer.from("safe\n", "utf8") }]);
  assert.deepEqual(
    scanPrivacyEntries([{ label: "dist/source/einzbern-source.tar", kind: "archive", content: namedArchive }], { owner })
      .filter((finding) => finding.startsWith("OWNER_PRIVATE_IDENTIFIER:")),
    [`OWNER_PRIVATE_IDENTIFIER:archive:dist/source/einzbern-source.tar#header:${memberPath}`],
    "an archive member path is not an address",
  );

  // The committed address lines are the only owner occurrences in the files that carry them.
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const addressPaths = [
    "skill/mana-orchestrate/scripts/install.mjs",
    "packages/core/src/skill-render.ts",
    "dist/build/packages/core/src/skill-render.js",
    ...["", ".en", ".ja", ".ko", ".fr"].flatMap((language) => [
      `README${language}.md`,
      `docs/readme/einzbern/README${language}.md`,
      `docs/readme/mana-orchestrate/README${language}.md`,
    ]),
  ];
  const addressEntries = await Promise.all(addressPaths.map(async (path) => ({
    label: path,
    kind: path.startsWith("dist/") ? "build" : "source",
    content: await readFile(join(repositoryRoot, path), "utf8"),
  })));
  for (const entry of addressEntries) {
    assert.ok(repositories.some((repository) => entry.content.includes(`${owner}/${repository}`)), `${entry.label} names a final address`);
  }
  assert.deepEqual(scanPrivacyEntries(addressEntries, { owner }), []);
});

test("reviewed 2.2.3 package owner classification is exact in version, member, origin and line", async () => {
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const build = await readFile(resolve(import.meta.dirname, "..", buildPath), "utf8");
  const ownerLine = build.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine).digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const member = (path, version = "2.2.3") => `dist/release/${BRAND.engine.id}-${version}.tar.gz/${BRAND.engine.id}-${version}/${path}`;
  for (const path of ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"]) {
    const label = member(path);
    const entry = { label, kind: "release", releaseArchiveMember: true, sourcePaths: p8ReleasePrivacySourcePaths(label), content: ownerLine };
    const finding = (candidate, scanOwner = owner) => scanPrivacyEntries([candidate], { owner: scanOwner })
      .includes(`OWNER_PRIVATE_IDENTIFIER:release:${candidate.label}`);
    assert.deepEqual(entry.sourcePaths, [buildPath]);
    assert.deepEqual(scanPrivacyEntries([entry], { owner }), []);
    for (const changedLabel of [member(path, "2.2.4"), member(`adjacent/${path}`), label.replace(".tar.gz/", ".other.tar.gz/")]) {
      assert.deepEqual(p8ReleasePrivacySourcePaths(changedLabel), []);
      assert.ok(finding({ ...entry, label: changedLabel, sourcePaths: p8ReleasePrivacySourcePaths(changedLabel) }));
    }
    for (const sourcePaths of [[], ["dist/build/packages/core/src/other.js"], [buildPath, "dist/build/packages/core/src/other.js"]]) {
      assert.ok(finding({ ...entry, sourcePaths }), "missing or unapproved origins remain findings");
    }
    assert.ok(finding({ ...entry, releaseArchiveMember: undefined }));
    assert.ok(finding({ ...entry, content: `${ownerLine} // changed` }));
    const changedOwner = publicIdentity.login;
    assert.ok(finding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner));
    const escapedOwner = [...owner].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const content of [`${ownerLine}\n${owner}`, `${owner}\n${ownerLine}`, `${ownerLine}\n"${escapedOwner}"`]) {
      assert.ok(finding({ ...entry, content }), "additional raw or escaped private text remains a finding");
    }
    const findings = scanPrivacyEntries([{ ...entry, content: `${ownerLine}\n${PRIVATE_VM_HOST}` }], { owner });
    assert.ok(findings.some((value) => value.startsWith("PRIVATE_HOSTNAME:")), "other private content is not exempt");
  }
});

// Current release binding; the historical 2.2.3 review above remains unchanged.
test("reviewed diagnostic 3.0.0 package owner classification is exact in version, member, origin and line", async () => {
  const owner = LEGACY_REPOSITORY_NAMES.owner;
  const buildPath = "dist/build/packages/core/src/names.js";
  const build = await readFile(resolve(import.meta.dirname, "..", buildPath), "utf8");
  const ownerLine = build.split("\n").find((line) => line.includes(owner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(ownerLine).digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const member = (path, version = "3.0.0") => `dist/release/${BRAND.engine.id}-${version}.tar.gz/${BRAND.engine.id}-${version}/${path}`;
  for (const path of ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"]) {
    const label = member(path);
    const entry = { label, kind: "release", releaseArchiveMember: true, sourcePaths: p8ReleasePrivacySourcePaths(label), content: ownerLine };
    const finding = (candidate, scanOwner = owner) => scanPrivacyEntries([candidate], { owner: scanOwner })
      .includes(`OWNER_PRIVATE_IDENTIFIER:release:${candidate.label}`);
    assert.deepEqual(entry.sourcePaths, [buildPath]);
    assert.deepEqual(scanPrivacyEntries([entry], { owner }), []);
    for (const changedLabel of [member(path, "3.0.1"), member(path, "2.2.4"), member(`adjacent/${path}`), label.replace(".tar.gz/", ".other.tar.gz/")]) {
      assert.deepEqual(p8ReleasePrivacySourcePaths(changedLabel), []);
      assert.ok(finding({ ...entry, label: changedLabel, sourcePaths: p8ReleasePrivacySourcePaths(changedLabel) }));
    }
    for (const sourcePaths of [[], ["dist/build/packages/core/src/other.js"], [buildPath, "dist/build/packages/core/src/other.js"]]) {
      assert.ok(finding({ ...entry, sourcePaths }), "missing or unapproved origins remain findings");
    }
    assert.ok(finding({ ...entry, releaseArchiveMember: undefined }));
    assert.ok(finding({ ...entry, content: `${ownerLine} // changed` }));
    const changedOwner = publicIdentity.login;
    assert.ok(finding({ ...entry, content: ownerLine.replaceAll(owner, changedOwner) }, changedOwner));
    const escapedOwner = [...owner].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const content of [`${ownerLine}\n${owner}`, `${owner}\n${ownerLine}`, `${ownerLine}\n"${escapedOwner}"`]) {
      assert.ok(finding({ ...entry, content }), "additional raw or escaped private text remains a finding");
    }
    const findings = scanPrivacyEntries([{ ...entry, content: `${ownerLine}\n${PRIVATE_VM_HOST}` }], { owner });
    assert.ok(findings.some((value) => value.startsWith("PRIVATE_HOSTNAME:")), "other private content is not exempt");
  }
});
