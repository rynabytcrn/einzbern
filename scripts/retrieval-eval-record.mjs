#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-474 R4 (TCRN-CROSS-SUB-303): records the corpus scripts/retrieval-eval.mjs scores.
//
// It opens a library (--library) or an old-layout workspace (--legacy) through the engine's
// read-only readers -- an old-layout chain is replayed from genesis without a byte written, and
// a library is read from its streams without this device's cache -- and writes under --out only.
// What it writes is what recall-inputs.ts hands the index, record for record, so the corpus is
// the one the recall verb and the prompt hook would index:
//
//   work-compact.json     the work records of the kinds recall indexes (Story, Incident,
//                         Initiative, Epic), each with its goal, body and parent titles; the
//                         scope is kept to the excerpt the index reads (scopeExcerptBytes).
//   minutes-compact.json  every minutes record, new and historical, with its decisions.
//   cards-compact.json    every card the recall verb reads, with the expansions it carries.
//   corpus-snapshot.json  the recording itself: the source it was read from, the sampling rule,
//                         the counts, the redactions, and the card links incident replay reads.
//
// Sampling. Every Initiative, Epic, minutes record and card is kept. A Story or an Incident is
// kept when an evaluation fixture names it (a judged candidate, a development-set source), or
// when the first four bytes of the SHA-256 of its id, read as an unsigned integer, are divisible
// by --sample (4 by default); a record of the pre-registered holdout is never kept, because the
// holdout scores records the corpus has not seen. The rule reads ids only, so the same chain
// gives the same sample.
//
// Redaction. Before anything is written, every text field has absolute paths replaced by
// [path], e-mail addresses by [email], and this machine's user names (the account, the home
// directory's name, the Git identity and the origin owner of this repository, and any
// --private-name) by [user]. What the privacy gate treats as deployment topology goes too: a
// private IPv4 address becomes [ip], a URL carrying credentials [url], a password-like literal (a
// word holding "password" and a digit) [secret], a thread identifier [thread-id], a claude.ai
// link [link], a login at a host ([user]@[host]), and every host this
// source names as an ssh target or after such a login, wherever else it appears, [host] -- as do
// the private runtime values the host supplies (scripts/lib/private-token-roster.mjs). The counts
// go into the snapshot and the reply. The result is then put to this repository's own privacy
// scanner, and a corpus it flags is refused rather than written.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { expansionsText } from "../dist/build/packages/core/src/knowledge-language.js";
import {
  hasLibraryManifest,
  legacyControlDirectory,
  listKnowledgeMetadata,
  materializeWorkspaceFromGenesis,
  openLegacyWorkspace,
  replayLegacyWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { scanPrivacyEntries } from "./lib/privacy.mjs";
import { privateRuntimeConfig } from "./lib/private-token-roster.mjs";

export const RECORD_SCHEMA_VERSION = "einzbern.retrieval-eval-corpus.v1";
export const WORK_SCHEMA_VERSION = "einzbern.retrieval-eval-work.v1";
export const MINUTES_SCHEMA_VERSION = "einzbern.retrieval-eval-minutes.v1";
export const CARDS_SCHEMA_VERSION = "einzbern.retrieval-eval-cards.v1";
export const SCOPE_EXCERPT_BYTES = 512;
export const DEFAULT_SAMPLE = 4;
const SAMPLED_KINDS = ["Story", "Incident"];
const KNOWLEDGE_LIST_LIMIT = 1_048_576;

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDirectory = resolve(repositoryRoot, "tests/fixtures/retrieval-eval");

class RecordError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function parseArguments(argv) {
  const values = { privateNames: [] };
  const single = new Set(["legacy", "library", "out", "at", "sample"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.startsWith("--") ? token.slice(2) : "";
    const value = argv[index + 1];
    if ((!single.has(name) && name !== "private-name") || value === undefined || value.startsWith("--")) {
      throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", `unexpected argument ${token}`);
    }
    index += 1;
    if (name === "private-name") values.privateNames.push(value);
    else if (values[name] !== undefined) throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", `--${name} given twice`);
    else values[name] = value;
  }
  if ((values.legacy === undefined) === (values.library === undefined)) {
    throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", "exactly one of --legacy and --library is required");
  }
  if (values.out === undefined) throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", "--out is required");
  const sample = values.sample === undefined ? DEFAULT_SAMPLE : Number(values.sample);
  if (!Number.isSafeInteger(sample) || sample < 1) throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", "--sample must be a positive integer");
  const at = values.at ?? `${new Date().toISOString().slice(0, 19)}Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(at)) throw new RecordError("RETRIEVAL_EVAL_RECORD_ARGUMENT_INVALID", "--at must be a UTC instant to the second");
  return { layout: values.legacy === undefined ? "library" : "legacy", source: resolve(values.legacy ?? values.library), out: resolve(values.out), at, sample, privateNames: values.privateNames };
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep) && path !== "..");
}

async function readState(layout, source) {
  if (layout === "legacy") {
    if (await legacyControlDirectory(source) === null) throw new RecordError("RETRIEVAL_EVAL_RECORD_SOURCE_INVALID", `${source} is not an old-layout workspace`);
    return replayLegacyWorkspace(await openLegacyWorkspace(source));
  }
  if (!await hasLibraryManifest(source)) throw new RecordError("RETRIEVAL_EVAL_RECORD_SOURCE_INVALID", `${source} is not a library`);
  return materializeWorkspaceFromGenesis(source);
}

function git(args) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** This machine's user names: the ones a recorded text can carry and a public fixture must not. */
function privateNames(extra) {
  const origin = git(["remote", "get-url", "origin"]).match(/github\.com[/:]([^/]+)\//u)?.[1] ?? "";
  let account = "";
  try { account = userInfo().username; } catch { account = ""; }
  const names = [account, basename(homedir()), git(["config", "user.name"]), origin, ...extra]
    .map((name) => name.trim())
    .filter((name) => name.length >= 3);
  return { names: [...new Set(names)].sort((left, right) => right.length - left.length), owner: origin || names[0] || "" };
}

const TEXT_END = "[^\\s\"'`，。；;,)）」】>\\]]*";
const PATH_PATTERN = new RegExp(`(?:\\/(?:Users|home|private|var|tmp|Volumes|opt|root|srv|mnt)\\/|(?<![A-Za-z0-9])[A-Za-z]:[\\\\/](?=[^\\s\\\\/]))${TEXT_END}`, "gu");
const LINK_PATTERN = new RegExp(`https?:\\/\\/claude\\.ai\\/${TEXT_END}`, "giu");
const CREDENTIAL_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gu;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
// The logins the privacy gate knows (scripts/lib/privacy.mjs, PRIVATE_USER_AT_HOST), and an ssh
// target: both name a host, and a named host is learned and redacted wherever else it occurs.
const LOGIN_PATTERN = /\b(?:deploy|root|tcrn|ubuntu)@([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/gu;
const SSH_TARGET_PATTERN = /\bssh\s+(?:-[A-Za-z]\s+\S+\s+)*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/gu;
const LEARNABLE_HOST = /^(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+|[A-Za-z0-9.-]+\.(?:lan|internal|corp|local))$/u;
const PRIVATE_IPV4_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/gu;
const THREAD_PATTERN = /019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gu;
// A literal password a record quotes -- a rotated fixture credential, say -- is not published again.
const SECRET_PATTERN = /\b(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]*(?:passw(?:or)?d|passphrase)[A-Za-z0-9_]*\b/giu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The hosts a source names: a login's host or an ssh target, when it has the shape of a host name. */
function learnHosts(texts) {
  const hosts = new Set();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const pattern of [LOGIN_PATTERN, SSH_TARGET_PATTERN]) {
      for (const match of text.matchAll(pattern)) if (LEARNABLE_HOST.test(match[1])) hosts.add(match[1]);
    }
  }
  return [...hosts].sort((left, right) => right.length - left.length);
}

function textsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) textsOf(entry, out);
  else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) textsOf(entry, out);
  return out;
}

function redactor(names, hosts) {
  const counts = { path: 0, link: 0, url: 0, email: 0, login: 0, ip: 0, secret: 0, threadId: 0, user: 0, host: 0 };
  const alternation = (values) => values.length === 0 ? null : new RegExp(values.map(escapeRegExp).join("|"), "giu");
  const namePattern = alternation(names);
  const hostPattern = alternation(hosts);
  const replace = (text, pattern, key, placeholder) => text.replace(pattern, () => { counts[key] += 1; return placeholder; });
  const text = (value) => {
    if (typeof value !== "string" || value.length === 0) return value;
    let out = replace(value, PATH_PATTERN, "path", "[path]");
    out = replace(out, LINK_PATTERN, "link", "[link]");
    out = replace(out, CREDENTIAL_URL_PATTERN, "url", "[url]@");
    out = replace(out, EMAIL_PATTERN, "email", "[email]");
    out = replace(out, LOGIN_PATTERN, "login", "[user]@[host]");
    out = replace(out, PRIVATE_IPV4_PATTERN, "ip", "[ip]");
    out = replace(out, SECRET_PATTERN, "secret", "[secret]");
    out = replace(out, THREAD_PATTERN, "threadId", "[thread-id]");
    if (hostPattern !== null) out = replace(out, hostPattern, "host", "[host]");
    if (namePattern !== null) out = replace(out, namePattern, "user", "[user]");
    return out;
  };
  const deep = (value) => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deep(entry)]));
    return value;
  };
  return { deep, counts };
}

function excerpt(value, maximumBytes) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maximumBytes) return String(value ?? "");
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function sampled(id, sample) {
  return createHash("sha256").update(id, "utf8").digest().readUInt32BE(0) % sample === 0;
}

async function fixtureIds() {
  const read = async (name) => JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
  const named = new Set();
  for (const entry of await read("judge-sheet.json")) for (const candidate of entry.candidates) named.add(candidate.id);
  for (const pair of (await read("incident-replay-frozen.json")).records) named.add(pair.source.workId);
  const holdout = new Set((await read("holdout-source.json")).records.map((record) => record.id));
  return { named, holdout };
}

function listed(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function recordCorpus(options) {
  if (inside(options.source, options.out)) throw new RecordError("RETRIEVAL_EVAL_RECORD_OUT_INSIDE_SOURCE", `${options.out} lies inside the source ${options.source}`);
  const state = await readState(options.layout, options.source);
  // As the recall verb does: a source with no knowledge store still has work and minutes, and the
  // reason code the card read produced is recorded rather than swallowed.
  let knowledge;
  try {
    knowledge = await listKnowledgeMetadata(options.source, { at: options.at, allowTrailing: true, includeExplicitOnly: true, limit: KNOWLEDGE_LIST_LIMIT });
  } catch (error) {
    if (typeof error?.reasonCode !== "string") throw error;
    knowledge = { reasonCode: error.reasonCode, resultDigest: "absent", records: [] };
  }
  const liveCards = knowledge.records ?? [];
  const cards = liveCards.map((record) => ({
    id: String(record.id),
    externalKey: String(record.externalKey ?? ""),
    subject: String(record.subject ?? ""),
    summary: String(record.summary ?? ""),
    snippet: String(record.snippet ?? ""),
    tags: (record.tags ?? []).map((tag) => String(tag)),
    expansions: expansionsText(record.expansions),
  }));
  const inputs = recallInputsFromState(state, cards, { scopeExcerptBytes: SCOPE_EXCERPT_BYTES });

  const { named, holdout } = await fixtureIds();
  const kept = { named: 0, sampled: 0, always: 0 };
  const dropped = { holdout: 0, unsampled: 0 };
  const work = [];
  for (const record of inputs.work) {
    if (holdout.has(record.id)) { dropped.holdout += 1; continue; }
    if (SAMPLED_KINDS.includes(record.kind)) {
      if (named.has(record.id)) kept.named += 1;
      else if (sampled(record.id, options.sample)) kept.sampled += 1;
      else { dropped.unsampled += 1; continue; }
    } else kept.always += 1;
    work.push({ ...record, scope: excerpt(record.scope, SCOPE_EXCERPT_BYTES) });
  }
  work.sort((left, right) => left.externalKey < right.externalKey ? -1 : left.externalKey > right.externalKey ? 1 : 0);
  const minutes = [...inputs.minutes].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const cardLinks = liveCards.map((record) => ({
    id: String(record.id),
    externalKey: String(record.externalKey ?? ""),
    lifecycle: String(record.lifecycle ?? ""),
    promotionState: String(record.promotionState ?? ""),
    supersedes: listed(record.supersedes),
    linkedWorkIds: listed(record.linkedWorkIds),
    sourceReferences: listed(record.sourceReferences),
  }));

  const { names, owner } = privateNames(options.privateNames);
  // Hosts are learned from the whole source, not from the sample, so a host named once in a record
  // the sample drops is still redacted where a kept record names it again.
  const runtime = privateRuntimeConfig();
  const runtimeTokens = runtime.configured ? [runtime.host, runtime.runtimeRoot] : [];
  const hosts = [...new Set([...learnHosts([...textsOf(inputs), ...textsOf(cardLinks)]), ...runtimeTokens])];
  const { deep, counts } = redactor(names, hosts);
  const kinds = {};
  for (const record of work) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
  const files = {
    "work-compact.json": json({ schemaVersion: WORK_SCHEMA_VERSION, strategy: "recall-inputs", scopeExcerptBytes: SCOPE_EXCERPT_BYTES, total: work.length, records: deep(work) }),
    "minutes-compact.json": json({ schemaVersion: MINUTES_SCHEMA_VERSION, strategy: "recall-inputs", total: minutes.length, records: deep(minutes) }),
    "cards-compact.json": json({ schemaVersion: CARDS_SCHEMA_VERSION, strategy: "recall-inputs", total: cards.length, records: deep([...cards].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) }),
  };
  const redactedLinks = deep(cardLinks).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const recording = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordedAt: options.at,
    recorder: "scripts/retrieval-eval-record.mjs",
    engineCommit: git(["rev-parse", "HEAD"]) || null,
    source: {
      layout: options.layout,
      workspaceId: state.metadata.workspaceId,
      chainVersion: state.version,
      headEventHash: state.headEventHash,
      knowledgeReasonCode: String(knowledge.reasonCode ?? ""),
      knowledgeResultDigest: String(knowledge.resultDigest ?? ""),
    },
    sampling: {
      indexedWorkKinds: ["Epic", "Incident", "Initiative", "Story"],
      sampledKinds: SAMPLED_KINDS,
      sample: options.sample,
      rule: "every Initiative, Epic, minutes record and live card; a Story or Incident when an evaluation fixture names it or when the first four bytes of sha256(id) as an unsigned integer are divisible by sample; never a pre-registered holdout record",
      scopeExcerptBytes: SCOPE_EXCERPT_BYTES,
    },
    counts: {
      sourceWork: state.work.length,
      indexableWork: inputs.work.length,
      work: work.length,
      workKinds: kinds,
      keptNamed: kept.named,
      keptSampled: kept.sampled,
      keptAlways: kept.always,
      droppedHoldout: dropped.holdout,
      droppedUnsampled: dropped.unsampled,
      minutes: minutes.length,
      cards: cards.length,
    },
    redactions: { ...counts },
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
    records: redactedLinks,
  };
  files["corpus-snapshot.json"] = json(recording);

  if (owner.length > 0) {
    const findings = scanPrivacyEntries(Object.entries(files).map(([label, content]) => ({ label, kind: "source", content })), { owner, privateTokens: hosts });
    if (findings.length > 0) throw new RecordError("RETRIEVAL_EVAL_RECORD_PRIVATE", `the redacted corpus still carries private text: ${findings.join(", ")}`, { findings });
  }
  await mkdir(options.out, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(options.out, name), text);
  return {
    ok: true,
    reasonCode: "RETRIEVAL_EVAL_CORPUS_RECORDED",
    out: options.out,
    source: recording.source,
    counts: recording.counts,
    redactions: recording.redactions,
    privacyScan: owner.length > 0 ? "clean" : "skipped-no-owner",
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
    corpusDigest: canonicalSha256(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]))),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await recordCorpus(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "RETRIEVAL_EVAL_RECORD_FAILED", message: error?.message ?? String(error), ...(error?.details ?? {}) })}\n`);
    process.exitCode = 1;
  }
}
