// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-486 (TCRN-CROSS-SUB-347). The five root READMEs are the finalized Einzbern
// READMEs, kept verbatim under docs/readme/einzbern/ and rendered by scripts/render-readme.mjs
// with the release version filled in; package.json's description is the finalized English
// About text. A root README edited by hand, a template that lost its version slot, a language
// switch pointing at a file that is not there, or a machine path in what a reader sees, is red.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "render-readme.mjs");
const TEMPLATES = join(REPO_ROOT, "docs", "readme", "einzbern");
const NAMES = ["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"];
const PLACEHOLDER = "{{version}}";
const LOCAL_PATH_REASONS = new Set(["LOCAL_ABSOLUTE_PATH", "LINUX_HOME_PATH", "WINDOWS_USER_PATH"]);
// Digests pin docs/dispatch/2026-09-25-einzbern/readme/einzbern/, the independent final text, with
// two changes made to it since: MIN-238 D4 names the helper repository at the final address in its
// `npx skills add` line instead of the placeholder, and TCRN-CROSS-MIN-260 D1 counts seven built-in
// principles where the text counts them in general (comparison table, Command Spell introduction,
// glossary), lists all seven under the Command Spell introduction, and says the four of the
// 2026-09-26 measurements are the four of that time. TCRN-CROSS-MIN-277 D2 counts three hosts and
// names DeepSeek Harness in the hosts badge, the hosts-one-memory tile, the alternating-hosts case
// and the switching-hosts row.
const FINAL_README_TEMPLATE_SHA256 = Object.freeze({
  "README.md": "19898b6903b73e98d13ae3b96adba92b85568bcecc4ea6c3274e48e545b291e3",
  "README.en.md": "aec6a9e04101ef7831f2b62582c845e19db119f4ba644503bed27dc3d312f9dd",
  "README.ja.md": "d70d35965fc7458a27ea7cbf3151d4ca8503196d12ce4cc03943e28618ccec69",
  "README.ko.md": "9378c8b434f5fff75c128cb45c14004f51104d9de36d0ec7f65b4117c325711d",
  "README.fr.md": "3c23466af98f1bc22ee9da90ecb664fe4660f000d2f18773564b76b02decf8c0",
});

async function packageVersion() {
  return JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")).version;
}

function render(root, arguments_) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "render-readme.mjs"), ...arguments_], { cwd: root, encoding: "utf8" });
  return { status: result.status, output: JSON.parse(result.stdout.trim()) };
}

test("495-T4: preserve the finalized five-language README templates as historical evidence", async () => {
  for (const name of NAMES) {
    const template = await readFile(join(REPO_ROOT, "tests/fixtures/readme/story-495", name), "utf8");
    const digest = createHash("sha256").update(template).digest("hex");
    assert.equal(digest, FINAL_README_TEMPLATE_SHA256[name], `${name} matches the finalized external README`);
    assert.equal(template.split(PLACEHOLDER).length - 1, 1, `${name} carries one ${PLACEHOLDER} slot`);
  }
});

test("486-R1, R4: each root README is its template with package.json's version filled in", async () => {
  const version = await packageVersion();
  for (const name of NAMES) {
    const template = await readFile(join(TEMPLATES, name), "utf8");
    const root = await readFile(join(REPO_ROOT, name), "utf8");
    assert.equal(root, template.replaceAll(PLACEHOLDER, version), `${name} is its template rendered for ${version}`);
    assert.ok(!root.includes(PLACEHOLDER), `${name} has no unfilled slot`);
  }
  const check = render(REPO_ROOT, ["--check"]);
  assert.equal(check.status, 0);
  assert.deepEqual(check.output, { ok: true, reasonCode: "README_RENDER_MATCHES", version, drifted: [] });
});

test("486-R1: each root README's language switch links the other four, and each of them exists", async () => {
  for (const name of NAMES) {
    const body = await readFile(join(REPO_ROOT, name), "utf8");
    const targets = [...body.matchAll(/\]\((README(?:\.[a-z]{2})?\.md)\)/gu)].map((match) => match[1]);
    assert.deepEqual([...targets].sort(), NAMES.filter((other) => other !== name).sort(), `${name} links the other four`);
    for (const target of targets) await access(join(REPO_ROOT, target));
  }
});

test("486-R1: no root README carries a local absolute path", async () => {
  for (const name of NAMES) {
    const content = await readFile(join(REPO_ROOT, name), "utf8");
    assert.ok(!content.includes(REPO_ROOT), `${name} does not name this checkout`);
    const findings = scanPrivacyEntries([{ label: name, kind: "source", content }], { owner: "readme-render-owner" })
      .filter((finding) => LOCAL_PATH_REASONS.has(finding.split(":")[0]));
    assert.deepEqual(findings, [], `${name} carries no user-home path`);
  }
});

test("486-R3: package.json's description is the finalized English About text", async () => {
  const about = await readFile(join(REPO_ROOT, "tests", "fixtures", "readme", "einzbern-about.en.txt"), "utf8");
  assert.ok(about.endsWith("\n") && !about.slice(0, -1).includes("\n"), "the fixture is one line");
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.description, about.slice(0, -1));
});

test("486-R4: render-readme writes the five root READMEs, and --check compares without writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-readme-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docs", "readme", "einzbern"), { recursive: true });
  await copyFile(SCRIPT, join(root, "scripts", "render-readme.mjs"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ version: "3.4.5" }, null, 2)}\n`);
  const templates = new Map();
  for (const name of NAMES) {
    templates.set(name, await readFile(join(TEMPLATES, name), "utf8"));
    await copyFile(join(TEMPLATES, name), join(root, "docs", "readme", "einzbern", name));
  }

  const missing = render(root, ["--check"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.output, { ok: false, reasonCode: "README_RENDER_DRIFTED", version: "3.4.5", drifted: NAMES });
  for (const name of NAMES) await assert.rejects(access(join(root, name)), `--check wrote no ${name}`);

  const written = render(root, []);
  assert.equal(written.status, 0);
  assert.deepEqual(written.output, { ok: true, reasonCode: "README_RENDERED", version: "3.4.5", written: NAMES });
  for (const name of NAMES) {
    assert.equal(await readFile(join(root, name), "utf8"), templates.get(name).replaceAll(PLACEHOLDER, "3.4.5"));
  }
  assert.equal(render(root, ["--check"]).status, 0);

  const handEdited = `${templates.get("README.en.md").replaceAll(PLACEHOLDER, "3.4.5")}hand edit\n`;
  await writeFile(join(root, "README.en.md"), handEdited);
  const drifted = render(root, ["--check"]);
  assert.equal(drifted.status, 1);
  assert.deepEqual(drifted.output.drifted, ["README.en.md"]);
  assert.equal(await readFile(join(root, "README.en.md"), "utf8"), handEdited, "--check leaves the file as it was");

  const bumped = render(root, ["--version", "3.5.0"]);
  assert.equal(bumped.status, 0);
  assert.deepEqual(bumped.output.written, NAMES);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), templates.get("README.md").replaceAll(PLACEHOLDER, "3.5.0"));
  assert.equal(render(root, ["--version", "3.5.0", "--check"]).status, 0);

  const invalid = render(root, ["--version", "latest"]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.output.reasonCode, "README_RENDER_VERSION_INVALID");
  assert.equal(render(root, ["--version"]).output.reasonCode, "README_RENDER_VERSION_MISSING");
  assert.equal(render(root, ["--write"]).output.reasonCode, "README_RENDER_ARGUMENT_UNKNOWN");
});

// MIN-337: current Ether naming is checked separately from the frozen STORY-495 evidence.
const ETHER_TEMPLATE_SHA256 = {
  "README.md": "fb726d92f89f108e095b8462959b4cf73fb775c06176934e29ed8c5ea57c67c0",
  "README.en.md": "71afa4562afa40c2428b7817ea332ea7f2eb5682e442c01b07e84a55b35b585e",
  "README.ja.md": "1d2e8856771c59aeee5939c1568e54dee25d4b449d6302279c2b0ac0aa855497",
  "README.ko.md": "c445c90ea7cb99fd5d59a0c56d7cb5e23f8d252f70e14907b12603fcd14445f8",
  "README.fr.md": "c15b1bf17404c70b404959969dee865b8b6cc6738ed57eff7c0f89cb3a2e7c8f"
};
test("MIN-337: current README templates retain the Ether naming baseline", async () => {
  for (const name of NAMES) {
    const text = await readFile(join(TEMPLATES, name), "utf8");
    assert.equal(createHash("sha256").update(text).digest("hex"), ETHER_TEMPLATE_SHA256[name]);
    assert.equal(text.split(PLACEHOLDER).length - 1, 1);
  }
});
