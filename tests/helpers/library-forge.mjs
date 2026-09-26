// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468/469 (SUB-285): a forger with write access to a library, for tests that must
// prove the reader, not the writer, enforces a rule. It rewrites the one device stream of a library
// from transformed {occurredAt, payload} specifications with correct identities, rising clocks,
// hashes and priorHash links, one segment, and a stream manifest that records them, so what a
// reader refuses is the rule under test and never the chain's integrity.

import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, createEvent, deriveEventId } from "../../dist/build/packages/protocol/src/index.js";

/** The one device stream directory of a library. */
export async function ownStreamDirectory(library) {
  const devices = await readdir(join(library, "akasha"));
  if (devices.length !== 1) throw new Error(`expected one device stream, found ${devices.length}`);
  return join(library, "akasha", devices[0]);
}

/** The committed events of the library's one device stream, as stored. */
export async function readOwnStream(library) {
  const directory = await ownStreamDirectory(library);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const events = [];
  for (const segment of manifest.segments) {
    const bytes = (await readFile(join(directory, segment.name))).subarray(0, segment.bytes).toString("utf8");
    events.push(...bytes.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line)));
  }
  return { directory, manifest, events };
}

/**
 * Rewrite the stream from `transform(events)`, whose entries need `occurredAt` and `payload` and
 * may keep a `clock`. `identity` may give the events another stream id, or event ids from
 * `eventIdFor(streamId, sequence)`, while the manifest keeps its own. Returns the rewritten events.
 */
export async function forgeOwnStream(library, transform, identity = {}) {
  const { directory, manifest, events } = await readOwnStream(library);
  const specifications = transform(structuredClone(events));
  const rebuilt = [];
  const streamId = identity.streamId ?? manifest.streamId;
  let clock = 0;
  for (const [index, specification] of specifications.entries()) {
    const sequence = index + 1;
    clock = Math.max(clock + 1, Number.isSafeInteger(specification.clock) ? specification.clock : 0);
    rebuilt.push(createEvent({
      id: identity.eventIdFor?.(streamId, sequence) ?? deriveEventId(streamId, sequence),
      streamId,
      sequence,
      clock,
      deviceId: manifest.deviceId,
      occurredAt: specification.occurredAt,
      priorHash: rebuilt.at(-1)?.eventHash ?? null,
      payload: specification.payload,
    }));
  }
  for (const segment of manifest.segments) await rm(join(directory, segment.name), { force: true });
  const text = rebuilt.map((event) => canonicalJson(event)).join("");
  const segments = [];
  if (rebuilt.length > 0) {
    await writeFile(join(directory, "00000001.ndjson"), text);
    segments.push({
      name: "00000001.ndjson",
      firstSequence: 1,
      lastSequence: rebuilt.length,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }
  await writeFile(join(directory, "manifest.json"), canonicalJson({
    ...manifest,
    sequence: rebuilt.length,
    headEventHash: rebuilt.at(-1)?.eventHash ?? null,
    clockHighWater: clock,
    segments,
  }));
  return rebuilt;
}
