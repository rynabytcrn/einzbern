// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-543 GWT1-GWT4 (TCRN-CROSS-SUB-523; Owner ruling TCRN-CROSS-MIN-262 D1, B2): a
// coordination library's card writes take no write language policy. Such a library records
// artifact.language to pick the language of its managed and variables sections (TCRN-CROSS-MIN-259 D3),
// and can never record models.* (TCRN-CROSS-MIN-243 D1), so the STORY-364 policy, which needs the
// economy-tier model, refused every card it was handed from the moment it recorded a language. Here a
// coordination library records zh-CN and no models.*: knowledge-capture, knowledge-create, a
// knowledge-batch's create members, knowledge-article-create and knowledge-article-refresh write the
// prose they were handed, untranslated and with no phrasings, as a card written before the language
// was recorded; answers handed in (a provider in core, a language bundle on the CLI) are not used, and
// nothing asks them. recall still answers an English query with the translation it is owed and no
// model to owe it. A project library recording the same language with no economy-tier model still
// refuses all three write verbs and keeps no card. The CLI runs are fresh processes of the shipped
// entry. Everything here is temporary: the containers, their libraries, a home for the CLI runs and
// the test process's device directory (helpers/device-home.mjs), which the CLI runs share.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  KNOWLEDGE_BATCH_SCHEMA_VERSION,
  applyKnowledgeBatch,
  captureKnowledgeUnit,
  createKnowledgeArticle,
  createKnowledgeUnit,
  declareChainIdentity,
  detectLanguage,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  materializeWorkspace,
  refreshKnowledgeArticle,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 15, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const OWNER = deriveStableId("owner", "STORY-543-OWNER");
const ECONOMY_MODEL = "claude-sonnet-5";
const DIGEST = "b".repeat(64);
// A coordination library somewhere else, which a project library's identity names.
const COORDINATION_ELSEWHERE = deriveStableId("workspace", "STORY-543-COORDINATION-ELSEWHERE");

// The card of tests/story-364-knowledge-language.test.mjs: English prose, which a zh-CN library that
// takes the policy stores translated, with phrasings.
const englishCard = {
  subject: "Credentials are not a prerequisite for implementation",
  summary: "A key that has not been issued does not block the work that will use it",
  snippet: "build against the interface, not the secret",
  tags: ["lesson"],
  accountableOwnerId: OWNER,
  body: "The API key had not been granted and every task behind it was called blocked.",
};
const PHRASINGS_ZH = ["密钥没批下来能不能先做", "开发要不要等凭据", "凭据是不是实现的前置"];
const TRANSLATIONS = {
  [englishCard.subject]: "凭据不是实现的前置",
  [englishCard.summary]: "密钥还没批下来并不阻塞要用它的工作",
  [englishCard.snippet]: "对着接口做，不对着密钥做",
};

/** The economy-tier model's answers, as a provider that records every time it is asked. */
function provider() {
  const asked = [];
  return {
    asked,
    model: ECONOMY_MODEL,
    translate(text, target, field) {
      asked.push(["translate", field, target]);
      return TRANSLATIONS[text] ?? "凭据不是实现的前置";
    },
    expand(_subject, _summary, language) {
      asked.push(["expand", language]);
      return PHRASINGS_ZH;
    },
  };
}

/**
 * A library in a temporary container, with its chain identity (a coordination library names itself,
 * a project library names a coordination library elsewhere), zh-CN recorded at its library level
 * unless `language` is false, no models.* record, and its knowledge store initialized.
 */
async function library(context, role, { language = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-coordination-knowledge-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  await mkdir(home);
  await mkdir(container);
  const root = join(container, ".ether");
  const initial = await initializeLibrary({ root, createdAt: at() });
  const libraryId = initial.metadata.workspaceId;
  await declareChainIdentity(root, { role, coordinationLibraryId: role === "coordination" ? libraryId : COORDINATION_ELSEWHERE }, { occurredAt: at() });
  if (language) await recordLanguage(root);
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  return { base, home, container, root, libraryId };
}

async function recordLanguage(root) {
  await setWorkspaceSetting(root, { key: "artifact.language", value: "zh-CN", occurredAt: at() });
  const settings = (await materializeWorkspace(root)).settings;
  assert.deepEqual(settings.filter((entry) => entry.key === "artifact.language").map((entry) => entry.value), ["zh-CN"]);
  assert.equal(settings.some((entry) => entry.key.startsWith("models.")), false, "no models.* record, so no economy-tier model");
}

/** A knowledge-create input, as the batch member and the single verb take it. */
function createInput(externalKey) {
  return {
    externalKey,
    scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: englishCard.tags,
    subject: englishCard.subject, summary: englishCard.summary, snippet: englishCard.snippet,
    accountableOwnerId: OWNER, sourceReferences: [`evidence://story-543/${externalKey}`], sourceDigest: DIGEST,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", externalKey)],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: "2026-10-15T08:00:00Z", stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: englishCard.body, coexist: true,
  };
}

function batchDocument(...externalKeys) {
  return {
    schemaVersion: KNOWLEDGE_BATCH_SCHEMA_VERSION,
    members: externalKeys.map((externalKey) => ({ verb: "knowledge-create", ...createInput(externalKey) })),
  };
}

async function records(root) {
  return (await listKnowledgeMetadata(root, { at: at(), selection: "all", allowTrailing: true })).records;
}

/** The card as it was handed in: the same words in the same language, and no phrasings. */
function assertAsHanded(record, expected = englishCard) {
  assert.deepEqual([record.subject, record.summary, record.snippet], [expected.subject, expected.summary, expected.snippet], record.externalKey);
  assert.equal(detectLanguage(record.subject), "en", `${record.externalKey}: English in, English stored`);
  assert.deepEqual(record.expansions ?? {}, {}, `${record.externalKey}: no phrasings`);
}

/** One CLI run through the shipped entry in a fresh process, as this test process's device. */
function run(fixture, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home },
  });
}

function receipt(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function refusal(result) {
  assert.equal(result.status, 1, result.stdout);
  return JSON.parse(result.stderr.trim().split("\n").at(-1));
}

const captureArgs = (fixture, externalKey) => ["knowledge-capture", "--workspace", fixture.root, "--at", at(), "--external-key", externalKey,
  "--subject", englishCard.subject, "--summary", englishCard.summary, "--snippet", englishCard.snippet, "--tags", englishCard.tags.join(","),
  "--accountable-owner-id", OWNER, "--body", englishCard.body, "--coexist", "true", "--allow-trailing", "true"];

const createArgs = (fixture, externalKey) => ["knowledge-create", "--workspace", fixture.root, "--at", at(), "--external-key", externalKey,
  "--scope", "workspace", "--project-id", "-", "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", englishCard.tags.join(","),
  "--subject", englishCard.subject, "--summary", englishCard.summary, "--snippet", englishCard.snippet,
  "--accountable-owner-id", OWNER, "--source-references", `evidence://story-543/${externalKey}`,
  "--source-digest", DIGEST, "--evidence-ids", deriveStableId("evidence", externalKey),
  "--lifecycle", "active", "--retrieval", "default", "--freshness", "fresh",
  "--last-verified", "2026-10-15T08:00:00Z", "--stale-days", "90", "--export", "metadata-only",
  "--body", englishCard.body, "--host", "claude-code", "--coexist", "true"];

async function batchArgs(fixture, name, ...externalKeys) {
  const file = join(fixture.base, `${name}.json`);
  await writeFile(file, JSON.stringify(batchDocument(...externalKeys)), "utf8");
  return ["knowledge-batch", "--workspace", fixture.root, "--at", at(), "--from-file", file, "--host", "claude-code"];
}

/** A language bundle the CLI reads and checks: the recorded shape, with phrasings for every card key. */
async function writeBundle(fixture, externalKeys) {
  const file = join(fixture.base, "language-bundle.json");
  const expansions = Object.fromEntries(["NEW", ...externalKeys].map((key) => [key, { "zh-CN": PHRASINGS_ZH }]));
  await writeFile(file, JSON.stringify({ model: ECONOMY_MODEL, translations: TRANSLATIONS, expansions }), "utf8");
  return file;
}

test("543-GWT1: a coordination library that records zh-CN and no models.* writes knowledge-capture, knowledge-create and a batch's create members as handed, shaped as a card written before it recorded the language", async (context) => {
  const fixture = await library(context, "coordination", { language: false });
  const before = await captureKnowledgeUnit(fixture.root, { ...englishCard, occurredAt: at(), externalKey: "STORY-543-BEFORE" });
  assert.equal(before.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  await recordLanguage(fixture.root);

  const captured = await captureKnowledgeUnit(fixture.root, { ...englishCard, occurredAt: at(), externalKey: "STORY-543-CAPTURE", coexist: true });
  const created = await createKnowledgeUnit(fixture.root, { ...createInput("STORY-543-CREATE"), occurredAt: at() });
  const batch = await applyKnowledgeBatch(fixture.root, batchDocument("STORY-543-BATCH-A", "STORY-543-BATCH-B"), { occurredAt: at() });
  assert.deepEqual([captured.reasonCode, created.reasonCode, batch.reasonCode], ["KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_BATCH_APPLIED"]);

  const byKey = new Map((await records(fixture.root)).map((record) => [record.externalKey, record]));
  assert.deepEqual([...byKey.keys()].sort(), ["STORY-543-BATCH-A", "STORY-543-BATCH-B", "STORY-543-BEFORE", "STORY-543-CAPTURE", "STORY-543-CREATE"]);
  const shape = Object.keys(byKey.get("STORY-543-BEFORE")).sort();
  for (const record of byKey.values()) {
    assertAsHanded(record);
    assert.deepEqual(Object.keys(record).sort(), shape, `${record.externalKey}: the fields of a card written before the language was recorded`);
  }
});

test("543-GWT2: in that coordination library the economy-tier model's answers are never asked, and knowledge-article-create and knowledge-article-refresh write as handed", async (context) => {
  const fixture = await library(context, "coordination");
  const answers = provider();
  const options = { languageProvider: answers, host: "claude-code" };
  const captured = await captureKnowledgeUnit(fixture.root, { ...englishCard, occurredAt: at(), externalKey: "STORY-543-ANSWERED-CAPTURE", coexist: true }, options);
  const created = await createKnowledgeUnit(fixture.root, { ...createInput("STORY-543-ANSWERED-CREATE"), occurredAt: at() }, options);
  const batch = await applyKnowledgeBatch(fixture.root, batchDocument("STORY-543-ANSWERED-BATCH-A", "STORY-543-ANSWERED-BATCH-B"), {
    occurredAt: at(),
    languageProviders: new Map([["STORY-543-ANSWERED-BATCH-A", answers], ["NEW", answers]]),
    mutation: { host: "claude-code" },
  });
  assert.deepEqual([captured.reasonCode, created.reasonCode, batch.reasonCode], ["KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_BATCH_APPLIED"]);

  // An article whose title is close to no card here: an article write cannot stand beside a conflict.
  const article = { path: "basalt.md", title: "Basalt quarry tolerances", summary: "How far a basalt block may stray." };
  const articleCreated = await createKnowledgeArticle(fixture.root, {
    occurredAt: at(), path: article.path, category: "workflow", title: article.title, summary: article.summary,
    content: "A basalt block strays no more than two millimetres.", accountableOwnerId: OWNER,
    linkedEvidenceIds: [deriveStableId("evidence", "STORY-543-ARTICLE")],
  }, options);
  assert.deepEqual([articleCreated.reasonCode, articleCreated.revision], ["KNOWLEDGE_ARTICLE_CREATED", 1]);
  const refreshedSummary = "How far a basalt block may stray, checked again.";
  const refreshed = await refreshKnowledgeArticle(fixture.root, {
    expectedRevision: 1, occurredAt: at(), id: articleCreated.id, path: article.path, summary: refreshedSummary,
  }, options);
  assert.deepEqual([refreshed.reasonCode, refreshed.id, refreshed.revision], ["KNOWLEDGE_ARTICLE_REFRESHED", articleCreated.id, 2]);
  assert.deepEqual(answers.asked, [], "no translation and no phrasing was asked for");

  const stored = await records(fixture.root);
  assert.equal(stored.length, 5);
  for (const record of stored.filter((entry) => entry.id !== articleCreated.id)) assertAsHanded(record);
  const index = stored.find((entry) => entry.id === articleCreated.id);
  assert.equal(index.revision, 2);
  assert.deepEqual([index.subject, index.summary, index.expansions ?? {}], [article.title, refreshedSummary, {}], "the refreshed article index keeps its words and has no phrasings");
});

test("543-GWT1, GWT2, GWT4 (fresh processes): the CLI writes a coordination library's cards with and without a language bundle, lists them as handed, and recall still owes an English query its translation with no model", async (context) => {
  const fixture = await library(context, "coordination");
  const bundle = await writeBundle(fixture, ["STORY-543-CLI-CAPTURE-BUNDLE", "STORY-543-CLI-CREATE-BUNDLE", "STORY-543-CLI-BATCH-C", "STORY-543-CLI-BATCH-D"]);
  const written = [
    receipt(run(fixture, captureArgs(fixture, "STORY-543-CLI-CAPTURE"))),
    receipt(run(fixture, createArgs(fixture, "STORY-543-CLI-CREATE"))),
    receipt(run(fixture, await batchArgs(fixture, "batch", "STORY-543-CLI-BATCH-A", "STORY-543-CLI-BATCH-B"))),
    receipt(run(fixture, [...captureArgs(fixture, "STORY-543-CLI-CAPTURE-BUNDLE"), "--language-bundle", bundle])),
    receipt(run(fixture, [...createArgs(fixture, "STORY-543-CLI-CREATE-BUNDLE"), "--language-bundle", bundle])),
    receipt(run(fixture, [...await batchArgs(fixture, "batch-bundle", "STORY-543-CLI-BATCH-C", "STORY-543-CLI-BATCH-D"), "--language-bundle", bundle])),
  ];
  assert.deepEqual(written.map((entry) => entry.reasonCode), [
    "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_BATCH_APPLIED",
    "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_BATCH_APPLIED",
  ]);

  const listed = receipt(run(fixture, ["knowledge-list", "--workspace", fixture.root, "--at", at(), "--selection", "all", "--allow-trailing", "true"])).records;
  assert.deepEqual(listed.map((record) => record.externalKey).sort(), [
    "STORY-543-CLI-BATCH-A", "STORY-543-CLI-BATCH-B", "STORY-543-CLI-BATCH-C", "STORY-543-CLI-BATCH-D",
    "STORY-543-CLI-CAPTURE", "STORY-543-CLI-CAPTURE-BUNDLE", "STORY-543-CLI-CREATE", "STORY-543-CLI-CREATE-BUNDLE",
  ]);
  for (const record of listed) assertAsHanded(record);

  const answer = receipt(run(fixture, ["recall", "--workspace", fixture.root, "--host", "claude-code", "--at", at(),
    "--query", "is the key still blocking development", "--allow-trailing", "true"]));
  assert.equal(answer.queryLanguage, "en");
  assert.deepEqual(answer.queryTranslation, { from: "en", to: "zh-CN", model: null }, "the translation is owed, and no economy-tier model is recorded to owe it");
  assert.deepEqual(answer.telemetry, { queryTranslations: 1 });
});

test("543-GWT3 (fresh processes): a project library that records zh-CN and no economy-tier model still refuses knowledge-capture, knowledge-create and knowledge-batch, and keeps no card", async (context) => {
  const fixture = await library(context, "project");
  assert.equal(refusal(run(fixture, captureArgs(fixture, "STORY-543-PROJECT-CAPTURE"))).reasonCode, "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE");
  assert.equal(refusal(run(fixture, createArgs(fixture, "STORY-543-PROJECT-CREATE"))).reasonCode, "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE");
  const batch = refusal(run(fixture, await batchArgs(fixture, "batch", "STORY-543-PROJECT-BATCH-A", "STORY-543-PROJECT-BATCH-B")));
  assert.deepEqual([batch.reasonCode, JSON.parse(batch.error).failed.reasonCode], ["WORK_BATCH_REFUSED", "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE"]);
  assert.deepEqual(await records(fixture.root), [], "the refusals leave no card behind");
});
