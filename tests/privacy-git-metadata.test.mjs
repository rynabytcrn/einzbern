// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

const joinParts = (parts, separator) => parts.join(separator);
const owner = "public-contributor";
const mail = (login = owner, domain = "users.noreply.github.com") => [login, domain].join("@");
const webMail = joinParts(["noreply", "github.com"], "@");
const identity = (role, name, email) => `${role} ${name} <${email}> 1 +0000`;
const author = identity("author", "Public Display Name", mail(`12345+${owner}`));
const committer = identity("committer", "GitHub", webMail);
const subject = `Merge pull request #42 from ${owner}/fix/public-change`;
const privateEmail = mail("fixture", "example.invalid");
const privatePath = joinParts(["", "Users", "fixture", "private"], "/");
const secret = ["ghp", "_", "a".repeat(32)].join("");
function commit({ a = author, c = committer, message = subject, parents = 2, extra = "" } = {}) {
  return [`tree ${"a".repeat(40)}`, ...["b", "c"].slice(0, parents).map((digit) => `parent ${digit.repeat(40)}`), a, c,
    ...(extra ? [extra] : []), "", message, ""].join("\n");
}
function reasons(content, { kind = "commit", privateTokens = [] } = {}) {
  return scanPrivacyEntries([{ kind, label: "synthetic", content }], { owner, privateTokens })
    .map((finding) => finding.split(":", 1)[0]);
}
function detects(content, reason, options) {
  assert.ok(reasons(content, options).includes(reason), `must retain ${reason}`);
}

test("public Git metadata tokens allow display-name differences and both noreply forms", () => {
  assert.deepEqual(reasons(commit()), []);
  assert.deepEqual(reasons(commit({ a: identity("author", "显示名称", mail()), message: "ordinary commit", parents: 0 })), []);
  assert.deepEqual(reasons(commit({ a: identity("author", owner, mail()) })), []);
});

test("privacy classification does not authenticate a commit or trust its whole identity", () => {
  for (const [payload, reason] of [[privateEmail, "EMAIL_IDENTIFIER"], [privatePath, "LOCAL_ABSOLUTE_PATH"], [secret, "GITHUB_CLASSIC_TOKEN"], [owner, "OWNER_PRIVATE_IDENTIFIER"]]) {
    detects(commit({ a: identity("author", `Display ${payload}`, mail()) }), reason);
    detects(commit({ c: identity("committer", `Display ${payload}`, mail("contributor")) }), reason);
    detects(commit({ message: `${subject}\n\n${payload}` }), reason);
  }
  detects(commit({ a: identity("author", "Display", privateEmail) }), "EMAIL_IDENTIFIER");
  detects(commit({ a: identity("author", "Display", mail(`prefix-${owner}`)) }), "OWNER_PRIVATE_IDENTIFIER");
  detects(commit({ a: identity("author", "Display", mail("AKIA" + "A".repeat(16))) }), "AWS_ACCESS_KEY");
  detects(commit(), "PRIVATE_RUNTIME_VALUE", { privateTokens: [owner] });
});

test("only actual header slots, not body lookalikes or normalized spoofing, classify", () => {
  for (const message of [author, `${subject}\n\n${author}`, `prefix\n${committer}`, `\n${subject}`]) {
    detects(commit({ message }), message.includes("noreply") ? "EMAIL_IDENTIFIER" : "OWNER_PRIVATE_IDENTIFIER");
  }
  detects(commit({ extra: author }), "EMAIL_IDENTIFIER");
  detects(commit({ extra: `gpgsig fixture\n ${author}` }), "EMAIL_IDENTIFIER");
  detects(commit({ a: " " + author }), "EMAIL_IDENTIFIER");
  detects(commit().replace("\n\n", "\n"), "EMAIL_IDENTIFIER");
  detects(commit().replace("tree ", "not-tree "), "EMAIL_IDENTIFIER");
  detects(commit().replace("author ", "author\\x20"), "EMAIL_IDENTIFIER");
  detects(author, "EMAIL_IDENTIFIER");
});

test("malformed domains, login syntax, suffixes, and service identities stay findings", () => {
  const emails = [mail(owner, "users.noreply.github.com.evil"), mail(owner, "users.noreply.github.com."),
    mail(owner, "users.noreply.github.com/extra"), mail(owner, "USERS.NOREPLY.GITHUB.COM"),
    mail("-fixture"), mail("fixture-"), mail("fixture--name"), mail("a".repeat(40)), mail(`0+${owner}`)];
  for (const email of emails) detects(commit({ a: identity("author", "Display", email) }), "EMAIL_IDENTIFIER");
  detects(commit({ a: identity("author", "GitHub", webMail) }), "EMAIL_IDENTIFIER");
  detects(commit({ c: identity("committer", "Not GitHub", webMail) }), "EMAIL_IDENTIFIER");
  detects(commit({ c: committer + " extra" }), "EMAIL_IDENTIFIER");
});

test("merge classification covers only the account slot of a first two-parent public-noreply subject", () => {
  for (const [payload, reason] of [[privateEmail, "EMAIL_IDENTIFIER"], [privatePath, "LOCAL_ABSOLUTE_PATH"], [secret, "GITHUB_CLASSIC_TOKEN"], [owner, "OWNER_PRIVATE_IDENTIFIER"]]) {
    detects(commit({ message: `${subject}/${payload}` }), reason);
  }
  for (const message of [`prefix ${subject}`, `${subject} suffix`, `message\n${subject}`, subject.replace("#42", "#0"), subject.replace(`${owner}/`, `prefix-${owner}/`)]) {
    detects(commit({ message }), "OWNER_PRIVATE_IDENTIFIER");
  }
  detects(commit({ parents: 1 }), "OWNER_PRIVATE_IDENTIFIER");
  detects(commit({ c: identity("committer", "Display", privateEmail) }), "OWNER_PRIVATE_IDENTIFIER");
  detects(commit({ c: identity("committer", "Display", privateEmail) }), "EMAIL_IDENTIFIER");
});

test("public identity text is still private outside metadata, including tag bodies", () => {
  for (const kind of ["source", "blob", "filename", "build", "archive", "release", "remote", "tag"]) {
    detects(commit(), "EMAIL_IDENTIFIER", { kind });
  }
  const tagger = identity("tagger", owner, mail());
  const tag = `object ${"a".repeat(40)}\ntype commit\ntag v1\n${tagger}\n\nrelease\n`;
  assert.deepEqual(reasons(tag, { kind: "tag" }), []);
  detects(tag + tagger, "EMAIL_IDENTIFIER", { kind: "tag" });
});


test("public user and web-flow committers support distinct fork and upstream accounts", () => {
  const upstream = "public-upstream";
  const a = identity("author", upstream, mail(upstream));
  for (const c of [committer, identity("committer", upstream, mail(upstream)), identity("committer", "Different Display Name", mail(`12345+${upstream}`))]) {
    const content = commit({ a, c });
    for (const account of [owner, upstream]) {
      assert.deepEqual(scanPrivacyEntries([{ kind: "commit", label: "synthetic", content }], { owner: account }), []);
    }
    for (const [payload, reason] of [[privateEmail, "EMAIL_IDENTIFIER"], [privatePath, "LOCAL_ABSOLUTE_PATH"], [secret, "GITHUB_CLASSIC_TOKEN"], [owner, "OWNER_PRIVATE_IDENTIFIER"]]) {
      detects(commit({ a, c, message: `${subject}/${payload}` }), reason);
      detects(commit({ a, c: c.replace("committer ", `committer Display ${payload} `) }), reason);
    }
    detects(content, "PRIVATE_RUNTIME_VALUE", { privateTokens: [upstream] });
  }
});

for (const object of ["36f50376cd9862bc5192c1a5c8835c998b626f2a", "a32bbc60551e3d1caf7f19ebfe7e4034309f5e29"]) {
  test(`retained merge ${object} scans cleanly in fork and upstream contexts`, (context) => {
    const read = spawnSync("git", ["cat-file", "commit", object], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    if (read.status !== 0) {
      context.skip(`${object} is not in this clone's history`);
      return;
    }
    // Derive already-public account slots without storing identities in fixtures.
    const authorAccount = /^author [^<>\n]+ <(?:[0-9]+\+)?([^@<>]+)@users\.noreply\.github\.com>/mu.exec(read.stdout)?.[1];
    const forkAccount = /^Merge pull request #[1-9][0-9]* from ([^/\s]+)\//mu.exec(read.stdout)?.[1];
    assert.ok(authorAccount && forkAccount, "retained fixture exposes both public account slots");
    for (const account of new Set([authorAccount, forkAccount])) {
      const entries = [{ kind: "commit", label: `git-commit:${object}`, content: read.stdout }];
      assert.deepEqual(scanPrivacyEntries(entries, { owner: account }), []);
      const changed = read.stdout + privateEmail;
      assert.ok(scanPrivacyEntries([{ ...entries[0], content: changed }], { owner: account })
        .some((finding) => finding.startsWith("EMAIL_IDENTIFIER:")));
    }
  });
}
