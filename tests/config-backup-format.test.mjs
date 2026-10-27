// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { CONFIG_BACKUP_RESERVATION_FILE, CONFIG_BACKUP_RESERVATION_TEXT } from "../scripts/lib/config-backup-reservation.mjs";
import { isConfigBackupFormatProtected } from "../scripts/lib/config-backup-format.mjs";
import { walkFiles } from "../scripts/lib/files.mjs";
import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-backup-format-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reserved = join(root, "retained");
  await mkdir(reserved);
  const marker = join(reserved, CONFIG_BACKUP_RESERVATION_FILE);
  await writeFile(marker, CONFIG_BACKUP_RESERVATION_TEXT);
  const group = join(reserved, "config-backups", "device", "a".repeat(32));
  const packageRoot = join(group, "20261025T063000Z-" + "b".repeat(32));
  await mkdir(join(packageRoot, "members"), { recursive: true });
  const member = join(packageRoot, "members", `${"c".repeat(64)}.json`);
  await writeFile(member, '{"value":"fixture-only-private-token"}');
  await writeFile(join(packageRoot, "manifest.json"), '{"fixture":true}');
  await writeFile(join(group, "index.json"), '{"active":[]}');
  return { root, reserved, marker, member };
}

async function productionFormatter(root, overrides = {}) {
  const source = await readFile(new URL("../scripts/task.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function formatCheck(");
  const end = source.indexOf("\nasync function lint()", start);
  assert.ok(start >= 0 && end > start);
  // Use the actual consumer body, with only filesystem-root and receipt wiring
  // injected. No build, dependency installation or global formatting is needed.
  const bindings = { walkFiles: () => walkFiles(root), repositoryRoot: root, toPosixPath: value => value, relative, extname,
    textExtensions: new Set([".json", ".ts", ".mjs", ".md"]), textNames: new Set(), readText: path => readFile(path, "utf8"), writeFile,
    isConfigBackupFormatProtected, assertion: (condition, reasonCode, detail) => { if (!condition) throw Object.assign(new Error(detail), { reasonCode }); },
    success: (reasonCode, value) => ({ reasonCode, ...value }), ...overrides };
  return new Function(...Object.keys(bindings), `${source.slice(start, end)}\nreturn formatCheck;`)(...Object.values(bindings));
}

test("format check/write preserve canonical backup bytes while ordinary JSON is still normalized and privacy still scans", async t => {
  const f = await fixture(t);
  const ordinary = join(f.root, "ordinary.json");
  await writeFile(ordinary, '{"ordinary":true}');
  const before = new Map(await Promise.all((await walkFiles(f.reserved)).map(async path => [path, await readFile(path, "utf8")])));
  const format = await productionFormatter(f.root);
  await assert.rejects(format(), error => error.reasonCode === "FORMAT_MISMATCH" && error.message === "ordinary.json");
  assert.equal((await format({ write: true })).reasonCode, "FORMAT_APPLIED");
  assert.equal(await readFile(ordinary, "utf8"), '{\n  "ordinary": true\n}\n');
  assert.equal((await format()).reasonCode, "FORMAT_VERIFIED");
  for (const [path, text] of before) assert.equal(await readFile(path, "utf8"), text);
  const files = await walkFiles(f.root);
  assert.ok(files.includes(f.member), "the generic source walker is not a format-only exclusion");
  const entries = await Promise.all(files.map(async path => ({ label: relative(f.root, path), kind: "file", content: await readFile(path, "utf8") })));
  const findings = scanPrivacyEntries(entries, { owner: "fixture-reviewer", privateTokens: ["fixture-only-private-token"] });
  assert.ok(findings.some(finding => finding.endsWith(relative(f.root, f.member))), "privacy reads and flags retained content independently");
});

test("formatter rejects malformed markers, mixed source roots and source files disguised inside a backup area", async t => {
  for (const kind of ["malformed", "mixed", "disguised"]) {
    await t.test(kind, async sub => {
      const f = await fixture(sub);
      let target = f.member;
      if (kind === "malformed") await writeFile(f.marker, "{");
      else {
        target = kind === "mixed" ? join(f.reserved, "source.ts") : join(f.reserved, "config-backups/source.ts");
        await writeFile(target, "export const value = 1;   ");
      }
      const before = await readFile(target);
      await assert.rejects(isConfigBackupFormatProtected(f.root, target), { reasonCode: "CONFIG_BACKUP_RESERVATION_INVALID" });
      await assert.rejects((await productionFormatter(f.root))({ write: true }), { reasonCode: "CONFIG_BACKUP_RESERVATION_INVALID" });
      assert.deepEqual(await readFile(target), before);
    });
  }
});

test("formatter rechecks a newly reserved ancestor immediately before its write", async t => {
  const f = await fixture(t);
  await rm(f.marker);
  let published = false;
  const format = await productionFormatter(f.root, { readText: async path => {
    const content = await readFile(path, "utf8");
    if (!published) { published = true; await writeFile(f.marker, CONFIG_BACKUP_RESERVATION_TEXT); }
    return content;
  } });
  const before = await readFile(f.member);
  await format({ write: true });
  assert.deepEqual(await readFile(f.member), before);
  assert.equal(await readFile(f.marker, "utf8"), CONFIG_BACKUP_RESERVATION_TEXT);
});
