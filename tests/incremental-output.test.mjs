// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendProgressEvent, readProgressDelta, waitForProgress, summarizeProgress, PROGRESS_SCHEMA_VERSION } from "../scripts/lib/incremental-output.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-incremental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "events.ndjson");
}
const line = (type, fields = {}) => Buffer.from(`${JSON.stringify({ schemaVersion: PROGRESS_SCHEMA_VERSION, type, ...fields })}\n`);
const resume = (value, options = {}) => ({
  cursor: value.cursor, events: value.events, state: value.state, nextPollMs: value.nextPollMs,
  counters: { polls: value.polls, unchangedPolls: value.unchangedPolls, bytesRead: value.bytesRead, returnedBytes: value.returnedBytes },
  timeoutMs: 0, pollMs: 5, maxPollMs: 20, ...options,
});

test("positioned reads consume each physical byte once, including partial UTF-8 tails", async (t) => {
  const path = await fixture(t);
  const firstLine = line("selected", { id: "first", padding: "x".repeat(150_000) });
  const secondLine = line("changed", { path: "中文" });
  const cut = secondLine.indexOf(Buffer.from("中")) + 1;
  await writeFile(path, Buffer.concat([firstLine, secondLine.subarray(0, cut)]));
  const first = await readProgressDelta(path);
  assert.equal(first.nextCursor, firstLine.length);
  assert.equal(first.bytesRead, firstLine.length + cut);
  assert.equal(first.returnedBytes, firstLine.length);
  const idle = await readProgressDelta(path, first.nextCursor, JSON.parse(JSON.stringify(first.state)));
  assert.equal(idle.bytesRead, 0);
  assert.equal(idle.returnedBytes, 0);
  await appendFile(path, secondLine.subarray(cut));
  const second = await readProgressDelta(path, idle.nextCursor, idle.state);
  assert.equal(second.bytesRead, secondLine.length - cut);
  assert.equal(second.returnedBytes, secondLine.length);
  assert.equal(second.events[0].path, "中文");
  assert.equal(second.nextCursor, firstLine.length + secondLine.length);
  const last = await readProgressDelta(path, second.nextCursor, second.state);
  assert.equal(last.bytesRead, 0);
  assert.deepEqual(last.events, []);
  // Legacy numeric cursors remain accepted and use positioned reads too.
  assert.equal((await readProgressDelta(path, first.nextCursor)).bytesRead, secondLine.length);
});

test("initial missing source is pending; bound missing, shortened and replaced sources reject", async (t) => {
  const path = await fixture(t);
  assert.equal((await readProgressDelta(path)).source, "missing");
  await assert.rejects(readProgressDelta(path, 1), { reasonCode: "PROGRESS_SOURCE_INVALIDATED" });
  await writeFile(path, line("selected"));
  const first = await readProgressDelta(path);
  await rename(path, `${path}.original`);
  await assert.rejects(readProgressDelta(path, first.nextCursor, first.state), { reasonCode: "PROGRESS_SOURCE_INVALIDATED" });
  await writeFile(path, line("selected", { padding: "larger replacement" }));
  await assert.rejects(readProgressDelta(path, first.nextCursor, first.state), { reasonCode: "PROGRESS_SOURCE_INVALIDATED" });
  await rename(`${path}.original`, path);
  await writeFile(path, "");
  await assert.rejects(readProgressDelta(path, first.nextCursor, first.state), { reasonCode: "PROGRESS_CURSOR_INVALIDATED" });
});

test("bad complete records and inconsistent cursors fail, partial records remain pending", async (t) => {
  const path = await fixture(t);
  for (const cursor of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readProgressDelta(path, cursor), { reasonCode: "PROGRESS_CURSOR_INVALID" });
  }
  for (const [bytes, reasonCode] of [
    [Buffer.from("{bad}\n"), "PROGRESS_EVENT_INVALID"],
    [Buffer.from("\n"), "PROGRESS_EVENT_INVALID"],
    [Buffer.from('{"schemaVersion":"wrong","type":"selected"}\n'), "PROGRESS_EVENT_SCHEMA_INVALID"],
    [line(""), "PROGRESS_EVENT_TYPE_INVALID"],
    [Buffer.from([0xff, 0x0a]), "PROGRESS_EVENT_INVALID"],
  ]) {
    await writeFile(path, bytes);
    await assert.rejects(readProgressDelta(path), (error) => {
      assert.equal(error.reasonCode, reasonCode);
      assert.equal(error.bytesRead, bytes.length, "failed parsing still reports every physical byte read");
      return true;
    });
  }
  await writeFile(path, '{"unfinished":');
  const partial = await readProgressDelta(path);
  assert.deepEqual(partial.events, []);
  assert.equal(partial.nextCursor, 0);
  await assert.rejects(readProgressDelta(path, 0, { ...partial.state, offset: 999 }), { reasonCode: "PROGRESS_CURSOR_INVALID" });
  await assert.rejects(readProgressDelta(path, 0, { ...partial.state, path: `${path}.other` }), { reasonCode: "PROGRESS_CURSOR_INVALID" });
});

test("wait continuation keeps counters, identity, partial bytes and bounded backoff", async (t) => {
  const path = await fixture(t);
  await writeFile(path, line("selected"));
  const first = await waitForProgress(path, { timeoutMs: 25, pollMs: 5, maxPollMs: 20 });
  assert.equal(first.status, "timeout");
  assert.ok(first.nextPollMs > 5 && first.nextPollMs <= 20);
  const idle = await waitForProgress(path, resume(first));
  assert.equal(idle.state.identity, first.state.identity);
  assert.equal(idle.nextPollMs, first.nextPollMs);
  assert.equal(idle.polls, first.polls + 1);
  assert.equal(idle.bytesRead, first.bytesRead);
  assert.equal(idle.events.length, 1);
  await appendProgressEvent(path, { type: "changed", id: "new" });
  const changed = await waitForProgress(path, resume(idle));
  assert.equal(changed.nextPollMs, 5);
  assert.deepEqual(changed.events.map(({ type }) => type), ["selected", "changed"]);
  await appendProgressEvent(path, { type: "completed", ok: true });
  const completed = await waitForProgress(path, resume(changed));
  assert.equal(completed.status, "completed");
  assert.equal(completed.events.filter(({ type }) => type === "completed").length, 1);
  await rename(path, `${path}.gone`);
  const known = await waitForProgress(path, resume(completed));
  assert.equal(known.status, "completed");
  assert.equal(known.polls, completed.polls);
  assert.equal(known.bytesRead, completed.bytesRead);
});

test("cancellation preserves recovery state and does not claim termination or success", async (t) => {
  const path = await fixture(t);
  await writeFile(path, line("controller-started", { pid: process.pid }));
  const first = await waitForProgress(path, { timeoutMs: 0 });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await waitForProgress(path, resume(first, { signal: controller.signal }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.summary.status, "running");
  assert.equal(cancelled.summary.exit, null);
  assert.equal(cancelled.polls, first.polls);
  await appendProgressEvent(path, { type: "controller-exited", ok: false, code: 1 });
  const failed = await waitForProgress(path, resume(cancelled));
  assert.equal(failed.status, "failed");
  for (const [type, fields, expected] of [
    ["error", {}, "failed"], ["completed", { ok: false }, "failed"], ["orphaned-before-bind", {}, "orphaned"],
  ]) assert.equal(summarizeProgress([{ schemaVersion: PROGRESS_SCHEMA_VERSION, type, ...fields }]).status, expected);
  assert.equal(summarizeProgress([
    { schemaVersion: PROGRESS_SCHEMA_VERSION, type: "error" },
    { schemaVersion: PROGRESS_SCHEMA_VERSION, type: "completed", ok: true },
  ]).status, "failed");
});

test("partial bytes survive a wait timeout and cancellation without a prefix reread", async (t) => {
  const path = await fixture(t);
  const record = line("changed", { path: "尾" });
  const cut = record.indexOf(Buffer.from("尾")) + 2;
  await writeFile(path, record.subarray(0, cut));
  const first = await waitForProgress(path, { timeoutMs: 0, pollMs: 5, maxPollMs: 20 });
  assert.equal(first.cursor, 0);
  assert.equal(first.bytesRead, cut);
  const idle = await waitForProgress(path, resume(first));
  assert.equal(idle.bytesRead, cut);
  await appendFile(path, record.subarray(cut));
  const last = await waitForProgress(path, resume(idle));
  assert.equal(last.bytesRead, record.length);
  assert.equal(last.returnedBytes, record.length);
  assert.equal(last.events.length, 1);
  assert.equal(last.events[0].path, "尾");
  await writeFile(path, "");
  const invalidated = await waitForProgress(path, resume(last));
  assert.equal(invalidated.status, "failed");
  assert.equal(invalidated.reasonCode, "PROGRESS_CURSOR_INVALIDATED");
});
