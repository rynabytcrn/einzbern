#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-364 — the write-path language hook, and the one-time migration that
// gives the cards already in a store their artefact language and their phrasings.
//
// WHY A SCRIPT AND NOT A VERB. The engine calls no model: packages/* declare no runtime
// dependency, scripts/lib/local-command.mjs admits only node and git, and verify:p1's
// offline leg measures both. So the model's answers arrive here as data — a bundle the
// Agent produced by asking the economy-tier model configured for the current host — and this file turns
// them into the provider the core write path requires. It decides what to say; the engine
// decides how to store it, exactly as the (since retired) capture hook did.
//
// FOUR WRITE PATHS, ONE ENFORCEMENT POINT. knowledge-capture, knowledge-create,
// conference-close --distill and knowledge-batch's create members all reach
// packages/core/src/knowledge-core.ts's buildMetadata, which is where the policy is
// applied. Every one of the four takes --language-bundle on the CLI and turns it into the
// same provider this file builds, so the hook and the operator hand the write path the
// same shape (Owner ruling TCRN-CROSS-MIN-160 D3). There is no promotion step to reach:
// a card is retrievable the moment it is written (TCRN-CROSS-SUB-308).
//
// SUBCOMMANDS
//   plan     --workspace <path> [--host <host>] [--out <file>]
//            Reads the store and prints the request: every card whose prose is not in the
//            artefact language, plus every card with no phrasings. This is what the Agent
//            hands the economy-tier model.
//   migrate  --workspace <path> --host <host> --bundle <file> [--dry-run] [--at <instant>]
//            Applies the model's answers. --dry-run reports what would be rewritten and
//            writes nothing.
//   capture  --workspace <path> --host <host> --bundle <file> --subject … --summary … --snippet …
//            --tags a,b --owner <id> --body <text> [--at <instant>]
//            The write-path hook for one new card.
//
// BUNDLE SHAPE
//   { "model": "<the economy-tier model configured for the current host>",
//     "translations": { "<source text>": "<translated text>" },
//     "expansions": { "<knowledge id or NEW>": { "<language tag>": ["…", "…", "…"] } } }
// A translation the bundle does not carry is a refusal, not a passthrough: the write path
// is fail-closed and this file never invents prose.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(SCRIPT_DIRECTORY, "../dist/build/packages/core/src/index.js");
const NEW_CARD_KEY = "NEW";

function fail(reasonCode, message) {
  process.stdout.write(JSON.stringify({ ok: false, reasonCode, message }) + "\n");
  process.exitCode = 1;
  return undefined;
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values[name] = "true";
      continue;
    }
    values[name] = next;
    index += 1;
  }
  return values;
}

/**
 * The provider the core write path asks for, backed by a bundle rather than by a network
 * call. `model` is checked by the core against the recorded economy tier, so a bundle
 * produced by a different model is refused there rather than trusted here.
 */
export function bundleProvider(core, bundle, cardKey = NEW_CARD_KEY) {
  return core.languageProviderFromBundle(core.parseLanguageBundle(bundle), cardKey);
}

function readBundle(path) {
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  if (typeof bundle !== "object" || bundle === null || typeof bundle.model !== "string") {
    throw new Error("bundle must be an object naming the model that produced it");
  }
  return bundle;
}

async function loadCore() {
  return import(CORE);
}

export async function planCommand(core, values) {
  const { listKnowledgeMetadata, materializeWorkspace, scopedWorkspaceState, chainIdentity, readRuntimeKnowledgeLanguagePolicy, detectLanguage } = core;
  const workspace = values.workspace ?? "";
  const state = await materializeWorkspace(workspace);
  if (chainIdentity(state)?.role === "coordination") {
    const text = JSON.stringify({ ok: true, reasonCode: "KNOWLEDGE_LANGUAGE_COORDINATION_SKIPPED", cards: 0, pending: 0, rewritten: 0, request: [], rewrites: [] }) + "\n";
    if (values.out === undefined) process.stdout.write(text);
    else writeFileSync(values.out, text);
    return undefined;
  }
  // An explicit --host selects installed policy; absence does not guess or read project tiers.
  const policy = await readRuntimeKnowledgeLanguagePolicy(scopedWorkspaceState(state, values["project-id"]).settings, values.host);
  const answer = await listKnowledgeMetadata(workspace, { at: values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z"), selection: "all", ...(values["project-id"] === undefined ? {} : { projectId: values["project-id"] }), allowTrailing: true });
  const cards = (answer.records ?? []).filter((record) => record.lifecycle !== "retired" && !record.extensions?.supersededBy);
  const request = (await Promise.all(cards.map(async (record) => {
    const policy = await readRuntimeKnowledgeLanguagePolicy(scopedWorkspaceState(state, record.projectId ?? values["project-id"]).settings, values.host);
    if (policy.artifactLanguage === null) return { id: record.id, externalKey: record.externalKey, reasonCode: "KNOWLEDGE_LANGUAGE_UNCONFIGURED", translate: [], expand: [] };
    const fields = ["subject", "summary", "snippet"]
      .filter((field) => detectLanguage(String(record[field] ?? "")) !== policy.artifactLanguage)
      .map((field) => ({ field, text: String(record[field] ?? "") }));
    const phrasings = Object.keys(record.expansions ?? {});
    const missing = policy.promptLanguages.filter((language) => !phrasings.includes(language));
    return { id: record.id, externalKey: record.externalKey, artifactLanguage: policy.artifactLanguage, economyModel: policy.economyModel, translate: fields, expand: missing };
  }))).filter((entry) => entry.reasonCode !== undefined || entry.translate.length > 0 || entry.expand.length > 0);
  const payload = {
    ok: true,
    reasonCode: "KNOWLEDGE_LANGUAGE_PLAN_READY",
    artifactLanguage: policy.artifactLanguage,
    promptLanguages: [...policy.promptLanguages],
    economyModel: policy.economyModel,
    cards: cards.length,
    pending: request.length,
    request,
  };
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (values.out === undefined) process.stdout.write(text);
  else writeFileSync(values.out, text);
  return undefined;
}

export async function migrateCommand(core, values) {
  const { listKnowledgeMetadata, materializeWorkspace, scopedWorkspaceState, chainIdentity, readRuntimeKnowledgeLanguagePolicy, applyWriteLanguagePolicy, readKnowledgeBody, createKnowledgeUnit } = core;
  const workspace = values.workspace ?? "";
  const dryRun = values["dry-run"] === "true";
  const at = values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z");
  const state = await materializeWorkspace(workspace);
  if (chainIdentity(state)?.role === "coordination") {
    process.stdout.write(JSON.stringify({ ok: true, reasonCode: "KNOWLEDGE_LANGUAGE_COORDINATION_SKIPPED", cards: 0, pending: 0, rewritten: 0, request: [], rewrites: [] }) + "\n");
    return undefined;
  }
  // An explicit --host selects installed policy; absence does not guess or read project tiers.
  const answer = await listKnowledgeMetadata(workspace, { at, selection: "all", ...(values["project-id"] === undefined ? {} : { projectId: values["project-id"] }), allowTrailing: true });
  const bundle = readBundle(values.bundle ?? "");
  const rewrites = [];
  for (const record of answer.records ?? []) {
    if (record.lifecycle === "retired" || record.extensions?.supersededBy) continue;
    const policy = await readRuntimeKnowledgeLanguagePolicy(scopedWorkspaceState(state, record.projectId ?? values["project-id"]).settings, values.host);
    if (policy.artifactLanguage === null) { rewrites.push({ id: record.id, externalKey: record.externalKey, applied: false, reason: "KNOWLEDGE_LANGUAGE_UNCONFIGURED" }); continue; }
    const provider = bundleProvider(core, bundle, record.id);
    let applied;
    try {
      applied = applyWriteLanguagePolicy(
        { subject: String(record.subject ?? ""), summary: String(record.summary ?? ""), snippet: String(record.snippet ?? "") },
        policy,
        provider,
      );
    } catch (error) {
      rewrites.push({ id: record.id, externalKey: record.externalKey, applied: false, reason: String(error.message ?? error) });
      continue;
    }
    const changed = applied.subject !== record.subject || applied.summary !== record.summary ||
      applied.snippet !== record.snippet || Object.keys(record.expansions ?? {}).length === 0;
    rewrites.push({ id: record.id, externalKey: record.externalKey, applied: changed, subject: applied.subject, expansions: applied.expansions });
    if (dryRun || !changed) continue;
    const body = String((await readKnowledgeBody(workspace, record.id, { at, allowUnpromoted: true })).body ?? "");
    await createKnowledgeUnit(workspace, {
      occurredAt: at,
      externalKey: `${record.externalKey}-L`,
      scope: record.scope, projectId: record.projectId, roleScopes: record.roleScopes,
      category: record.category, kind: record.kind, tags: record.tags,
      subject: record.subject, summary: record.summary, snippet: record.snippet,
      accountableOwnerId: record.accountableOwnerId,
      sourceReferences: record.sourceReferences, sourceDigest: record.sourceDigest,
      supersedes: record.id,
      linkedWorkIds: record.linkedWorkIds, linkedDecisionIds: record.linkedDecisionIds,
      linkedGateIds: record.linkedGateIds, linkedEvidenceIds: record.linkedEvidenceIds,
      lifecycle: record.lifecycle, retrievalDisposition: record.retrievalDisposition,
      freshnessState: record.freshnessState, lastVerified: record.lastVerified,
      stalenessPolicy: record.stalenessPolicy, exportDisposition: record.exportDisposition,
      body,
    }, { languageProvider: provider, allowTrailing: true, ...(values.host === undefined ? {} : { host: values.host }) });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    reasonCode: dryRun ? "KNOWLEDGE_LANGUAGE_MIGRATION_PLANNED" : "KNOWLEDGE_LANGUAGE_MIGRATED",
    dryRun,
    cards: rewrites.length,
    rewritten: rewrites.filter((entry) => entry.applied).length,
    refused: rewrites.filter((entry) => entry.reason !== undefined).length,
    rewrites,
  }, null, 2) + "\n");
  return undefined;
}

async function captureCommand(core, values) {
  const { captureKnowledgeUnit } = core;
  const bundle = readBundle(values.bundle ?? "");
  const answer = await captureKnowledgeUnit(values.workspace ?? "", {
    occurredAt: values.at ?? new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
    ...(values["project-id"] === undefined ? {} : { scope: "project", projectId: values["project-id"] }),
    subject: values.subject ?? "",
    summary: values.summary ?? "",
    snippet: values.snippet ?? "",
    tags: (values.tags ?? "").split(",").filter((tag) => tag.length > 0),
    accountableOwnerId: values.owner ?? "",
    body: values.body ?? "",
  }, { languageProvider: bundleProvider(core, bundle), allowTrailing: true, ...(values.host === undefined ? {} : { host: values.host }) });
  process.stdout.write(JSON.stringify(answer) + "\n");
  return undefined;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const values = parseArguments(rest);
  const core = await loadCore();
  if (command === "plan") return planCommand(core, values);
  if (command === "migrate") return migrateCommand(core, values);
  if (command === "capture") return captureCommand(core, values);
  return fail("KNOWLEDGE_LANGUAGE_COMMAND_UNKNOWN", "expected one of: plan, migrate, capture");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("knowledge-language.mjs")) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    fail(String(error?.reasonCode ?? "KNOWLEDGE_LANGUAGE_FAILED"), String(error?.message ?? error));
  }
}
