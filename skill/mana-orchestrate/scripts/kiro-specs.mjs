#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Local, deterministic Spec projection from Einzbern's current read interfaces. This helper never
// writes work, minutes, or project configuration; formal changes must already have been written
// through the engine before `refresh` can replace a managed projection.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "source.json";
const MANIFEST_SCHEMA = "einzbern.kiro-spec-source.v1";
const FILES = Object.freeze(["requirements.md", "design.md", "tasks.md"]);
const START_MARKER = "<!-- EINZBERN-SPEC:MANAGED-START -->";
const END_MARKER = "<!-- EINZBERN-SPEC:MANAGED-END -->";
const CHANGE_DECISION = /^minutes:([a-f0-9]{24})#D([1-9][0-9]*)$/u;
const WORK_ID = /^work:[a-f0-9]{24}$/u;

export class KiroSpecsError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "KiroSpecsError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new KiroSpecsError(reasonCode, message, details);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null || Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  fail("SPEC_SOURCE_VALUE_INVALID", "The engine returned a value that cannot be stamped canonically.");
}

function relativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\") || value.includes(":")) {
    fail("SPEC_PATH_INVALID", `${label} must be a relative path using forward slashes.`);
  }
  const parts = value.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) {
    fail("SPEC_PATH_INVALID", `${label} cannot contain empty, dot, or parent path segments.`);
  }
  return value;
}

function normalizeDirectory(value, cwd) {
  const portable = relativePath(value, "--spec-dir");
  const target = resolve(cwd, ...portable.split("/"));
  const fromCwd = relative(cwd, target);
  if (fromCwd === "" || fromCwd.startsWith(`..${sep}`) || fromCwd === ".." || isAbsolute(fromCwd)) {
    fail("SPEC_PATH_INVALID", "--spec-dir must resolve below the current working directory.");
  }
  return target;
}

async function assertSafePath(path, cwd, includeLeaf = true) {
  const pathFromCwd = relative(cwd, path);
  const parts = pathFromCwd.split(sep).filter(Boolean);
  if (pathFromCwd === "" && !includeLeaf) return;
  if (pathFromCwd === "" || pathFromCwd === ".." || pathFromCwd.startsWith(`..${sep}`) || isAbsolute(pathFromCwd)) {
    fail("SPEC_PATH_INVALID", "Spec output must resolve below the current working directory.");
  }
  let current = cwd;
  const length = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (const part of parts.slice(0, length)) {
    current = join(current, part);
    let stats;
    try { stats = await lstat(current); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (stats.isSymbolicLink()) fail("SPEC_PATH_SYMLINK", `Refusing to follow symbolic link ${relative(cwd, current)}.`);
    if (!stats.isDirectory()) fail("SPEC_DIRECTORY_INVALID", `${relative(cwd, current)} is not a directory.`);
  }
}

function deviceHome(env = process.env) {
  const configured = env.EINZBERN_HOME;
  if (typeof configured === "string" && configured.length > 0) {
    if (!isAbsolute(configured)) fail("SPEC_ENGINE_HOME_INVALID", "EINZBERN_HOME must be an absolute device directory.");
    return resolve(configured);
  }
  return join(homedir(), ".einzbern");
}

function engineEntry(env = process.env) {
  return join(deviceHome(env), "engine", "einzbern.mjs");
}

function invokeEngine(command, flags, options = {}) {
  const args = [engineEntry(options.env), command];
  for (const [flag, value] of Object.entries(flags)) {
    if (value === undefined || value === null) continue;
    args.push(`--${flag}`, String(value));
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) {
        reject(new KiroSpecsError("SPEC_ENGINE_READ_FAILED", `${command} exited with ${code}: ${stderr || stdout}`, { command, exitCode: code }));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch {
        reject(new KiroSpecsError("SPEC_ENGINE_OUTPUT_INVALID", `${command} did not return one JSON document.`, { command }));
      }
    });
  });
}

function engineResponse(value, command) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SPEC_ENGINE_OUTPUT_INVALID", `${command} returned a non-object result.`, { command });
  }
  return value;
}

function currentWork(workShow, workId) {
  const value = engineResponse(workShow, "work-show");
  if (value.reasonCode !== "WORKSPACE_RECORD_READY" || value.kind !== "work" || value.record?.id !== workId || value.record.tombstone === true) {
    fail("SPEC_WORK_UNAVAILABLE", `work-show did not return the requested live work item ${workId}.`);
  }
  return value;
}

function currentContext(segment, workId, workRevision) {
  const value = engineResponse(segment, "work-content-context");
  if (value.schemaVersion !== "tcrn.work-content-segment.v1" || value.workId !== workId || value.complete !== true || value.truncated !== false) {
    fail("SPEC_WORK_CONTEXT_INCOMPLETE", "work-content-context is incomplete; no Spec files were written.", { reasonCode: value.reasonCode ?? null });
  }
  if (value.workRevision !== workRevision) {
    fail("SPEC_SOURCE_CHANGED_DURING_READ", "work-show and work-content-context returned different revisions.", { workRevision, contextRevision: value.workRevision });
  }
  let document;
  try { document = JSON.parse(value.text); }
  catch { fail("SPEC_WORK_CONTEXT_INVALID", "work-content-context text is not valid JSON."); }
  if (sha256(value.text) !== value.digest) fail("SPEC_WORK_CONTEXT_INVALID", "work-content-context text does not match its returned digest.");
  if (document.schemaVersion !== "tcrn.work-content-context.v1" || document.workId !== workId || document.workRevision !== workRevision || document.complete !== true || !Array.isArray(document.records)) {
    fail("SPEC_WORK_CONTEXT_INVALID", "work-content-context does not describe a complete matching source snapshot.");
  }
  const direct = document.records.find(record => record.workId === workId && record.relation === "direct");
  if (!direct) fail("SPEC_WORK_CONTEXT_INVALID", "work-content-context has no direct record for the requested work.");
  if (typeof direct.fields?.goal !== "string" || direct.fields.goal.trim() === "" || typeof direct.fields?.acceptance !== "string" || direct.fields.acceptance.trim() === "") {
    fail("SPEC_SOURCE_CONTENT_EMPTY", "The current work has no usable goal or acceptance text; the helper will not invent it.");
  }
  return { segment: value, document, direct };
}

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const entry of value) walkStrings(entry, visit);
  else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) walkStrings(entry, visit);
}

function minuteReferences(contextDocument, workShow) {
  const references = new Map();
  const add = (id, number = null) => {
    const prior = references.get(id) ?? new Set();
    if (number !== null) prior.add(number);
    references.set(id, prior);
  };
  const relationIds = workShow.relations?.forward?.decidedIn;
  if (Array.isArray(relationIds)) for (const id of relationIds) if (typeof id === "string" && /^minutes:[a-f0-9]{24}$/u.test(id)) add(id);
  walkStrings(contextDocument.records, text => {
    const pattern = /minutes:([a-f0-9]{24})(?:#D([1-9][0-9]*)(?:[–-]D?([1-9][0-9]*))?)?/gu;
    for (const match of text.matchAll(pattern)) {
      const id = `minutes:${match[1]}`;
      if (match[2] === undefined) add(id);
      else {
        const first = Number(match[2]);
        const last = Number(match[3] ?? match[2]);
        if (last - first > 20) fail("SPEC_MINUTES_RANGE_UNSUPPORTED", `The source cites too many decisions in ${match[0]}.`);
        for (let number = first; number <= last; number++) add(id, number);
      }
    }
  });
  return references;
}

async function readMinutes(references, invoke) {
  const result = [];
  for (const id of [...references.keys()].sort()) {
    const value = engineResponse(await invoke("minutes-show", { id }), "minutes-show");
    if (value.reasonCode !== "WORKSPACE_RECORD_READY" || value.kind !== "minutes" || value.record?.id !== id || value.record.tombstone === true) {
      fail("SPEC_MINUTES_UNAVAILABLE", `minutes-show did not return the referenced live decision record ${id}.`);
    }
    const selected = references.get(id);
    const decisions = Array.isArray(value.record.decisions) ? value.record.decisions : [];
    const relevant = selected.size === 0 ? decisions : decisions.filter(decision => selected.has(decision.number));
    if (relevant.length !== (selected.size === 0 ? decisions.length : selected.size)) {
      fail("SPEC_MINUTES_DECISION_MISSING", `The current decision record ${id} does not contain every cited decision.`);
    }
    result.push({ id, revision: value.record.revision ?? null, summary: value.record.summary ?? null,
      decisions: relevant.map(decision => ({ number: decision.number, text: decision.text })) });
  }
  return result;
}

function designSnapshot(projectContext) {
  const context = engineResponse(projectContext, "work-project-context");
  if (!Array.isArray(context.contexts) || !Array.isArray(context.conflicts)) {
    fail("SPEC_PROJECT_CONTEXT_INVALID", "work-project-context did not return its resolved context array.");
  }
  if (context.conflicts.includes("design.authority")) {
    return { status: "conflicting", conflicts: [...context.conflicts], targets: [] };
  }
  const targets = context.contexts.map(entry => {
    const settings = Array.isArray(entry.settings) ? entry.settings : [];
    const authority = settings.find(setting => setting.key === "design.authority") ?? null;
    return {
      reference: entry.reference ?? null,
      status: entry.status ?? "unknown",
      design: entry.design ?? null,
      authoritySetting: authority,
      reason: entry.reason ?? null,
    };
  });
  if (targets.length === 0) {
    return { status: "unconfigured", reason: "work-project-context resolved no target project; no design authority was configured or inferred.", targets: [] };
  }
  const statuses = new Set(targets.map(target => target.status));
  const designStatuses = new Set(targets.map(target => target.design?.status ?? "unconfigured"));
  const status = statuses.has("conflicting") || designStatuses.has("conflicting") ? "conflicting"
    : targets.some(target => target.authoritySetting?.value != null) ? "configured" : "unconfigured";
  return { status, targets };
}

export async function readCurrentSources({ workspace, workId, invoke = invokeEngine }) {
  if (typeof workspace !== "string" || workspace.trim() === "") fail("SPEC_WORKSPACE_REQUIRED", "--workspace is required.");
  if (typeof workId !== "string" || !WORK_ID.test(workId)) fail("SPEC_WORK_ID_INVALID", "--work-id must be a live work:<24 lowercase hex> id.");

  const work = currentWork(await invoke("work-show", { workspace, id: workId }), workId);
  const revision = work.record.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) fail("SPEC_WORK_REVISION_INVALID", "work-show returned no valid revision.");
  const { segment, document, direct } = currentContext(await invoke("work-content-context", { workspace, id: workId }), workId, revision);
  const project = engineResponse(await invoke("work-project-context", { workspace, id: workId }), "work-project-context");
  if (project.workId !== workId || project.workRevision !== revision || project.workContent?.workRevision !== revision) {
    fail("SPEC_SOURCE_CHANGED_DURING_READ", "work-project-context returned a different work revision.");
  }
  const decisions = await readMinutes(minuteReferences(document, work), (command, args) => invoke(command, { workspace, ...args }));
  const projectDesign = designSnapshot(project);
  const fields = direct.fields;
  const formal = {
    work: {
      id: work.record.id,
      externalKey: work.record.externalKey,
      kind: work.record.kind,
      revision,
      status: work.record.status,
      title: work.record.title,
      summary: work.record.summary,
      projectId: work.record.projectId,
      parentId: work.record.parentId,
      scopeDigest: work.record.scopeDigest ?? null,
      relations: work.relations?.forward ?? null,
      fieldSha256: sha256(canonical({ fields, scope: direct.scope ?? null, content: direct.content ?? null })),
      sourceStatus: direct.sourceStatus,
    },
    context: {
      schemaVersion: document.schemaVersion,
      workId,
      workRevision: revision,
      digest: segment.digest,
      complete: segment.complete,
      records: document.records.map(record => ({
        workId: record.workId,
        externalKey: record.externalKey,
        relation: record.relation,
        kind: record.kind,
        workRevision: record.workRevision,
        sourceStatus: record.sourceStatus,
        scope: record.scope ?? null,
        fields: record.fields,
        content: record.content,
        contentImpact: record.contentImpact,
        missing: record.missing,
      })),
      effectiveRequirements: document.effectiveRequirements,
      missing: document.missing,
      structureProblems: document.structureProblems,
      semanticVerification: document.semanticVerification,
    },
    minutes: decisions,
    project: {
      status: projectDesign.status,
      conflicts: project.conflicts,
      involvedProjects: project.involvedProjects ?? null,
      targets: projectDesign.targets,
    },
  };
  const stamp = {
    schemaVersion: MANIFEST_SCHEMA,
    workId,
    workRevision: revision,
    sourceDigest: sha256(canonical(formal)),
    legacy: direct.content === null,
    sources: {
      work: formal.work,
      contextDigest: segment.digest,
      minuteRevisions: decisions.map(({ id, revision: minuteRevision }) => ({ id, revision: minuteRevision })),
      design: projectDesign,
    },
  };
  return { stamp, formal, work, direct, context: document, design: projectDesign, project, minutes: decisions };
}

function quote(value) {
  if (value === null || value === undefined || value === "") return "> Not present in the current formal source.\n";
  return String(value).split("\n").map(line => `> ${line}`).join("\n");
}

function workSection(record, includeBody) {
  const fields = record.fields ?? {};
  const rows = [
    `### ${record.relation === "direct" ? "Current work" : "Inherited work"}: ${record.externalKey} (${record.workId}, revision ${record.workRevision})`,
    "",
    `Source status: ${record.sourceStatus}. This status describes source extraction, not semantic acceptance.`,
    "",
    "#### Goal",
    quote(fields.goal),
    "",
    "#### Scope and constraints",
    quote(record.scope ?? fields.scope),
    "",
    "#### Acceptance",
    quote(fields.acceptance),
  ];
  if (record.content !== null) rows.push("", "#### Native structured content", quote(canonical(record.content)));
  if (includeBody) rows.push("", "#### Original work notes", quote(fields.body));
  return rows.join("\n");
}

function sourceMarker(stamp) {
  return `<!-- Einzbern source: work=${stamp.workId} revision=${stamp.workRevision} sha256=${stamp.sourceDigest} -->`;
}

function managedDocument(stamp, title, body) {
  return `${START_MARKER}\n# ${title}\n\n${sourceMarker(stamp)}\n\n${body.trimEnd()}\n${END_MARKER}\n`;
}

export function buildDocuments(snapshot) {
  const { stamp, context, direct, design, minutes } = snapshot;
  const sourceRecords = context.records;
  const requirements = [
    "This file projects current engine work content. It does not create a requirement, requirement version, or acceptance result.",
    "",
    ...sourceRecords.map(record => workSection(record, record.relation === "direct")),
    "",
    "## Effective typed requirements",
    "",
    context.effectiveRequirements?.length
      ? context.effectiveRequirements.map(requirement => `- ${requirement.id ?? "(no native id)"}${requirement.version === undefined ? "" : ` v${requirement.version}`}: ${requirement.text ?? requirement.statement ?? "(text absent)"}`).join("\n")
      : "No effective typed requirements were returned by the engine. Legacy fields above keep their actual work revisions and field digest; no independent requirement version is implied.",
    "",
    `## Formal source state\n\nWork status: ${snapshot.work.record.status}. The engine reports semantic verification as ${context.semanticVerification ?? "unknown"}.`,
  ].join("\n");

  const decisionText = minutes.length === 0
    ? "No current minute record is linked or explicitly cited by the work sources."
    : minutes.map(minute => [
      `### ${minute.id}${minute.revision === null ? "" : ` (revision ${minute.revision})`}`,
      "",
      ...minute.decisions.flatMap(decision => [`#### D${decision.number}`, "", quote(decision.text), ""]),
    ].join("\n")).join("\n");
  const designDescription = design.status === "unconfigured"
    ? `No design authority is configured for the resolved work context. ${design.reason ?? "No authority was inferred."}`
    : design.status === "conflicting"
      ? "The live work project context reports a design authority conflict. The projection preserves that state and does not select an authority."
      : "The following design authority values come from the current work-project-context readback. Their configured source and project reference remain explicit.";
  const designBody = [
    "This file records design-source availability. It does not establish a new design authority or claim publication/build evidence.",
    "",
    `Resolution: ${design.status}.`,
    "",
    designDescription,
    "",
    "## Effective design context",
    "",
    `\`design.authority\`: ${design.status === "unconfigured" ? "not configured" : "see exact current context below"}.`,
    "",
    quote(canonical(design)),
    "",
    "## Cited decisions",
    "",
    decisionText,
  ].join("\n");

  const taskTitle = snapshot.work.record.title ?? direct.fields.goal;
  const taskGoal = direct.fields.goal.replace(/\s+/gu, " ");
  const taskAcceptance = direct.fields.acceptance.replace(/\s+/gu, " ");
  const taskScope = String(direct.scope ?? "").replace(/\s+/gu, " ");
  const taskSourceNotes = String(direct.fields.body ?? "").replace(/\s+/gu, " ");
  const taskBody = [
    "Exactly one executable task represents the current work item. It is a local Spec checklist only; checking it never changes formal work status or evidence.",
    "",
    `- [ ] 1. ${taskTitle}`,
    "  - Work item: `" + stamp.workId + "` revision " + stamp.workRevision + ".",
    "  - Goal from the current formal source: " + taskGoal,
    "  - Scope from the current formal source: " + taskScope,
    "  - Acceptance from the current formal source: " + taskAcceptance,
    ...(taskSourceNotes === "" ? [] : ["  - Original work notes and delivery details from the current formal source: " + taskSourceNotes]),
    "",
    "A checked task is local progress only. Formal completion still requires the engine's work transition and its required evidence.",
  ].join("\n");

  return {
    "requirements.md": managedDocument(stamp, "Requirements", requirements),
    "design.md": managedDocument(stamp, "Design", designBody),
    "tasks.md": managedDocument(stamp, "Tasks", taskBody),
  };
}

function managedPart(text, name) {
  const starts = [...text.matchAll(new RegExp(START_MARKER, "gu"))];
  const ends = [...text.matchAll(new RegExp(END_MARKER, "gu"))];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    fail("SPEC_MARKERS_INVALID", `${name} must contain exactly one ordered pair of managed markers.`);
  }
  const start = starts[0].index;
  const end = ends[0].index + END_MARKER.length;
  return { before: text.slice(0, start), managed: text.slice(start, end), after: text.slice(end) };
}

function regularFile(path, label) {
  return lstat(path).then(stats => {
    if (!stats.isFile() || stats.isSymbolicLink()) fail("SPEC_FILE_NOT_REGULAR", `${label} must be a regular file, not a symlink or special file.`);
    return true;
  }).catch(error => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function readManifest(directory, workId) {
  const path = join(directory, MANIFEST_NAME);
  if (!(await regularFile(path, MANIFEST_NAME))) return null;
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { fail("SPEC_MANIFEST_INVALID", "source.json is not valid JSON."); }
  const { manifestDigest, ...unsigned } = value ?? {};
  if (value?.schemaVersion !== MANIFEST_SCHEMA || value.workId !== workId || !value.managedSha256 || typeof value.managedSha256 !== "object"
      || value.sourceStamp?.sourceDigest !== value.sourceDigest || value.sourceStamp?.workRevision !== value.workRevision
      || manifestDigest !== sha256(canonical(unsigned)) || !Array.isArray(value.files) || value.files.join("\0") !== FILES.join("\0")) {
    fail("SPEC_MANIFEST_INVALID", "source.json is not an ownership stamp for this work item.");
  }
  return value;
}

function checksumMatches(block, expected) {
  return sha256(block) === expected;
}

function taskStates(block) {
  return Object.fromEntries([...block.matchAll(/^- \[([ x])\] ([0-9]+)\./gmu)].map(match => [match[2], match[1] === "x"]));
}

function taskTemplate(block) {
  return block.replace(/^- \[[ x]\] (?=[0-9]+\.)/gmu, "- [ ] ");
}

function taskChecksumMatches(block, expected) {
  const template = taskTemplate(block);
  if (checksumMatches(template, expected)) return true;
  // Earlier refreshes stamped the sole task's checked state verbatim.
  const checkbox = /^- \[ \] (?=[0-9]+\.)/gmu;
  return [...template.matchAll(checkbox)].length === 1
    && checksumMatches(template.replace(checkbox, "- [x] "), expected);
}

function applyTaskStates(documents, states) {
  if (Object.keys(states).length === 0) return documents;
  const block = managedPart(documents["tasks.md"], "tasks.md").managed;
  const nextBlock = block.replace(/^- \[ \] ([0-9]+)(\.)(.*)$/gmu, (_line, id, dot, tail) => `- [${states[id] === true ? "x" : " "}] ${id}${dot}${tail}`);
  const parts = managedPart(documents["tasks.md"], "tasks.md");
  return { ...documents, "tasks.md": `${parts.before}${nextBlock}${parts.after}` };
}

async function inspectFiles(directory, manifest, { allowLocalTaskChecks = false } = {}) {
  const files = {};
  for (const name of FILES) {
    const path = join(directory, name);
    if (!(await regularFile(path, name))) fail("SPEC_OWNED_FILE_MISSING", `${name} is named by source.json but is missing.`);
    const text = await readFile(path, "utf8");
    const parts = managedPart(text, name);
    let states = name === "tasks.md" ? taskStates(parts.managed) : {};
    const unchanged = checksumMatches(parts.managed, manifest.managedSha256[name]);
    if (!unchanged && name === "tasks.md" && allowLocalTaskChecks && taskChecksumMatches(parts.managed, manifest.managedSha256[name])) {
      states = taskStates(parts.managed);
    } else if (!unchanged) {
      fail("SPEC_EDIT_CONFLICT", `${name} changed inside its managed section; refresh refused to overwrite the edit.`, { file: name });
    }
    files[name] = { text, ...parts, taskStates: states };
  }
  return files;
}

function manifestFor(stamp, documents) {
  const unsigned = {
    schemaVersion: MANIFEST_SCHEMA,
    workId: stamp.workId,
    workRevision: stamp.workRevision,
    sourceDigest: stamp.sourceDigest,
    sourceStamp: stamp,
    managedSha256: Object.fromEntries(FILES.map(name => {
      const managed = managedPart(documents[name], name).managed;
      return [name, sha256(name === "tasks.md" ? taskTemplate(managed) : managed)];
    })),
    files: [...FILES],
  };
  return { ...unsigned, manifestDigest: sha256(canonical(unsigned)) };
}

async function prepareDirectory(directory, workId, allowInitialize) {
  let stats;
  try { stats = await lstat(directory); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!allowInitialize) fail("SPEC_OWNERSHIP_MISSING", "The Spec directory has no ownership stamp; initialize it from current sources first.");
    await mkdir(directory, { recursive: true });
    stats = await lstat(directory);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("SPEC_DIRECTORY_INVALID", "--spec-dir must name a real directory, not a symlink or file.");
  const manifest = await readManifest(directory, workId);
  if (manifest !== null) return manifest;
  if (!allowInitialize) fail("SPEC_OWNERSHIP_MISSING", "The Spec directory has no ownership stamp; initialize it from current sources first.");
  for (const name of [...FILES, MANIFEST_NAME]) {
    if (await regularFile(join(directory, name), name)) fail("SPEC_OWNERSHIP_MISSING", `${name} exists without a source.json ownership stamp; it was left untouched.`);
    try {
      await lstat(join(directory, name));
      fail("SPEC_FILE_NOT_REGULAR", `${name} exists but is not a regular file.`);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return null;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8)}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function saveFiles(directory, documents, manifest, previousFiles = null) {
  for (const name of FILES) {
    const fresh = managedPart(documents[name], name).managed;
    const prior = previousFiles?.[name];
    const text = prior === undefined ? `${fresh}\n` : `${prior.before}${fresh}${prior.after}`;
    await atomicWrite(join(directory, name), text);
  }
  await atomicWrite(join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function initializeSpec({ workspace, workId, specDir, cwd = process.cwd(), invoke = invokeEngine }) {
  const directory = normalizeDirectory(specDir, cwd);
  const snapshot = await readCurrentSources({ workspace, workId, invoke });
  await assertSafePath(directory, cwd);
  const documents = buildDocuments(snapshot);
  const prior = await prepareDirectory(directory, workId, true);
  if (prior !== null) {
    const inspected = await inspectFiles(directory, prior, { allowLocalTaskChecks: true });
    if (prior.sourceDigest === snapshot.stamp.sourceDigest) {
      return { ok: true, reasonCode: "SPEC_ALREADY_CURRENT", workId, workRevision: snapshot.stamp.workRevision, sourceDigest: snapshot.stamp.sourceDigest };
    }
    fail("SPEC_STALE", "The owned Spec is based on older formal sources; draft changes, then refresh after engine writeback and approval.", { priorDigest: prior.sourceDigest, currentDigest: snapshot.stamp.sourceDigest, files: Object.keys(inspected) });
  }
  await saveFiles(directory, documents, manifestFor(snapshot.stamp, documents));
  return { ok: true, reasonCode: "SPEC_INITIALIZED", workId, workRevision: snapshot.stamp.workRevision, sourceDigest: snapshot.stamp.sourceDigest, specDir: specDir };
}

export async function checkSpec({ workspace, workId, specDir, cwd = process.cwd(), invoke = invokeEngine }) {
  const directory = normalizeDirectory(specDir, cwd);
  const snapshot = await readCurrentSources({ workspace, workId, invoke });
  await assertSafePath(directory, cwd);
  const manifest = await readManifest(directory, workId);
  if (manifest === null) fail("SPEC_OWNERSHIP_MISSING", "No source.json ownership stamp exists for this Spec.");
  const inspected = await inspectFiles(directory, manifest, { allowLocalTaskChecks: true });
  const checkedTasks = Object.entries(inspected["tasks.md"].taskStates).filter(([, checked]) => checked).map(([id]) => id);
  const sameSource = manifest.sourceDigest === snapshot.stamp.sourceDigest;
  return {
    ok: sameSource,
    reasonCode: sameSource ? "SPEC_CURRENT" : "SPEC_STALE",
    workId,
    workRevision: snapshot.stamp.workRevision,
    formalStatus: snapshot.work.record.status,
    formalDone: snapshot.work.record.status === "done",
    sourceDigest: snapshot.stamp.sourceDigest,
    previousSourceDigest: manifest.sourceDigest,
    tasksCheckedLocalOnly: checkedTasks,
    taskChecksAreFormalEvidence: false,
  };
}

export async function draftSpecChange({ workspace, workId, specDir, draftOut, cwd = process.cwd(), invoke = invokeEngine }) {
  const directory = normalizeDirectory(specDir, cwd);
  const outRelative = relativePath(draftOut, "--draft-out");
  const output = resolve(cwd, ...outRelative.split("/"));
  const fromCwd = relative(cwd, output);
  if (fromCwd === "" || fromCwd.startsWith(`..${sep}`) || fromCwd === ".." || isAbsolute(fromCwd)) fail("SPEC_PATH_INVALID", "--draft-out must resolve below the current working directory.");
  const snapshot = await readCurrentSources({ workspace, workId, invoke });
  await assertSafePath(directory, cwd);
  await assertSafePath(dirname(output), cwd);
  const documents = buildDocuments(snapshot);
  const manifest = await readManifest(directory, workId);
  if (manifest === null) fail("SPEC_OWNERSHIP_MISSING", "A change draft requires an existing owned Spec.");
  const priorFiles = await inspectFiles(directory, manifest, { allowLocalTaskChecks: true });
  if (manifest.sourceDigest === snapshot.stamp.sourceDigest) fail("SPEC_NO_CHANGE", "The current formal sources reproduce the owned Spec; no change draft is needed.");
  const chunks = [
    `# Proposed Spec change for ${workId}`,
    "",
    `Current formal work revision: ${snapshot.stamp.workRevision}.`,
    `Prior source digest: ${manifest.sourceDigest}.`,
    `Current source digest: ${snapshot.stamp.sourceDigest}.`,
    "",
    "This is a local draft. It has not changed formal work, minutes, design authority, or owned Spec files.",
  ];
  for (const name of FILES) chunks.push("", `## Proposed ${name}`, "", managedPart(documents[name], name).managed);
  await writeFile(output, `${chunks.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return { ok: true, reasonCode: "SPEC_CHANGE_DRAFT_WRITTEN", workId, workRevision: snapshot.stamp.workRevision, sourceDigest: snapshot.stamp.sourceDigest, priorManagedFiles: Object.keys(priorFiles), draftOut };
}

function approvalIsLinked(locator, snapshot) {
  const match = CHANGE_DECISION.exec(locator);
  if (match === null) fail("SPEC_APPROVAL_LOCATOR_INVALID", "--approved-in must be a minutes:<id>#D<n> decision locator.");
  const minuteId = `minutes:${match[1]}`;
  const number = Number(match[2]);
  const cited = snapshot.minutes.find(minute => minute.id === minuteId && minute.decisions.some(decision => decision.number === number));
  const linked = snapshot.work.relations?.forward?.decidedIn;
  if (!cited || !Array.isArray(linked) || !linked.includes(minuteId)) return false;
  return true;
}

export async function refreshSpec({ workspace, workId, specDir, approvedIn, cwd = process.cwd(), invoke = invokeEngine }) {
  const directory = normalizeDirectory(specDir, cwd);
  const snapshot = await readCurrentSources({ workspace, workId, invoke });
  await assertSafePath(directory, cwd);
  const documents = buildDocuments(snapshot);
  const manifest = await prepareDirectory(directory, workId, false);
  const priorFiles = await inspectFiles(directory, manifest, { allowLocalTaskChecks: true });
  if (manifest.sourceDigest === snapshot.stamp.sourceDigest) {
    return { ok: true, reasonCode: "SPEC_ALREADY_CURRENT", workId, workRevision: snapshot.stamp.workRevision, sourceDigest: snapshot.stamp.sourceDigest };
  }
  if (typeof approvedIn !== "string" || approvedIn.length === 0) {
    fail("SPEC_REFRESH_APPROVAL_REQUIRED", "Source changes remain a draft until a current decision is written back through the engine.", { currentSourceDigest: snapshot.stamp.sourceDigest });
  }
  if (!approvalIsLinked(approvedIn, snapshot)) {
    fail("SPEC_REFRESH_APPROVAL_NOT_WRITTEN_BACK", "The decision is not linked from the current formal work record; refresh refused.", { approvedIn });
  }
  const documentsWithLocalTaskState = applyTaskStates(documents, priorFiles["tasks.md"].taskStates);
  const nextManifest = manifestFor(snapshot.stamp, documentsWithLocalTaskState);
  await saveFiles(directory, documentsWithLocalTaskState, nextManifest, priorFiles);
  return { ok: true, reasonCode: "SPEC_REFRESHED", workId, workRevision: snapshot.stamp.workRevision, sourceDigest: snapshot.stamp.sourceDigest, approvedIn };
}

function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { command: "help" };
  const command = argv[0];
  if (!["init", "check", "draft", "refresh"].includes(command)) fail("SPEC_ARGUMENT_INVALID", "usage: kiro-specs.mjs <init|check|draft|refresh> --workspace <library> --work-id <id> --spec-dir <relative-path> [--approved-in minutes:<id>#D<n>] [--draft-out <relative-path>]");
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--workspace", "--work-id", "--spec-dir", "--approved-in", "--draft-out"].includes(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      fail("SPEC_ARGUMENT_INVALID", `Invalid or duplicate option ${flag}.`);
    }
    values.set(flag, value);
  }
  for (const required of ["--workspace", "--work-id", "--spec-dir"]) if (!values.has(required)) fail("SPEC_ARGUMENT_INVALID", `${required} is required.`);
  if (command === "draft" && !values.has("--draft-out")) fail("SPEC_ARGUMENT_INVALID", "draft requires --draft-out to name a new relative output file.");
  if (command !== "draft" && values.has("--draft-out")) fail("SPEC_ARGUMENT_INVALID", "--draft-out is only valid for draft.");
  if (command !== "refresh" && values.has("--approved-in")) fail("SPEC_ARGUMENT_INVALID", "--approved-in is only valid for refresh.");
  return {
    command,
    workspace: values.get("--workspace"),
    workId: values.get("--work-id"),
    specDir: values.get("--spec-dir"),
    approvedIn: values.get("--approved-in"),
    draftOut: values.get("--draft-out"),
  };
}

export async function run(argv = process.argv.slice(2), options = {}) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === "help") {
      return { ok: true, reasonCode: "SPEC_HELP", usage: "kiro-specs.mjs <init|check|draft|refresh> --workspace <library> --work-id <id> --spec-dir <relative-path> [--approved-in minutes:<id>#D<n>] [--draft-out <relative-path>]" };
    }
    const operation = parsed.command === "init" ? initializeSpec : parsed.command === "check" ? checkSpec : parsed.command === "draft" ? draftSpecChange : refreshSpec;
    return await operation({ ...parsed, cwd: options.cwd ?? process.cwd(), invoke: options.invoke ?? invokeEngine });
  } catch (error) {
    const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode
      : error?.code === "EACCES" || error?.code === "EPERM" ? "SPEC_PATH_PERMISSION_DENIED"
        : error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "SPEC_PATH_UNAVAILABLE"
          : "SPEC_UNEXPECTED_ERROR";
    return { ok: false, reasonCode, error: String(error?.message ?? error), ...(error?.details ? { details: error.details } : {}) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok === false) process.exitCode = 1;
}
