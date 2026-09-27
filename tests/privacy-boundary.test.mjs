// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { LocalCommandError, runLocalCommand } from "../scripts/lib/local-command.mjs";
import { aggregatePrivacySurface, decodeGitMetadataBytes, normalizePrivacyText, parseGitObjectBatch, parseHistoricalTreePaths, scanPrivacyEntries, walkHistoricalCommitPaths } from "../scripts/lib/privacy.mjs";
import { writeUstar } from "../scripts/lib/tar.mjs";
import { ENGINE_REPOSITORY_NAMES, LEGACY_REPOSITORY_NAMES } from "../dist/build/packages/core/src/index.js";

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

  await context.test("an oversized object database overflows the capture bound instead of truncating", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-oversize-");
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "oversized fixture"]);
    const expected = declaredBatchBytes(root);
    // spawnSync's 1 MiB default silently returns a truncated stdout on overflow, which is
    // the fail-open shape: every object past the cut goes unscanned while the gate stays
    // green. The capture must instead surface a typed overflow.
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_OUTPUT_OVERFLOW",
    );
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
