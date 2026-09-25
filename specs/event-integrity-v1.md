# Event Integrity V1

Events conform to `event-integrity-v1.schema.json`. `schemaVersion` is one of two
namespaces: `tcrn.event.v1` is the legacy namespace, which every event written before the
rename keeps byte for byte and which is only ever read, and `einzbern.event.v1` is the
namespace every new event is written in (TCRN-CROSS-STORY-466 R2). Each event's hash
basis carries its own `schemaVersion`, so a chain may hold legacy events followed by new
ones and its `priorHash` links run straight through the change. A stream starts at sequence
one with `priorHash: null`. Every later event uses the immediately prior event
hash. `payloadHash` is the canonical SHA-256 of the payload; `eventHash` is the
canonical SHA-256 of the event basis before `eventHash` is added.

An `einzbern.event.v1` also carries `clock` and `deviceId` (TCRN-CROSS-STORY-468 R3), and
both are in its hash basis. `clock` is a positive integer, one more than the largest clock
the writing device had seen when it wrote the event; `deviceId` is 32 lowercase hex digits
naming the device whose stream holds the event. A `tcrn.event.v1` carries neither: its clock
is its sequence, and its device is the one its stream is recorded under. Within one stream the
clocks strictly increase. Merged reading orders events from all streams by clock, then device
id, then sequence.

A library stream's identity is `stream:` followed by the first 24 hex digits of the canonical
SHA-256 of `{schemaVersion: "einzbern.stream-identity.v1", libraryId, deviceId}`; the event at
a sequence of that stream is `event:` followed by the first 24 hex digits of the canonical
SHA-256 of `{schemaVersion: "einzbern.event-identity.v1", streamId, sequence}`. A stream
imported from an old-layout workspace keeps that workspace's stream and event identities.

Duplicate IDs, duplicate or missing sequence values, prior-hash mismatch,
payload corruption, unknown or unhashed fields, and event-hash corruption fail
closed. Validation sorts by numeric sequence then ID using
`utf8-byte-order-v1` before checking so input order cannot change the result.
Every accepted event field participates directly or transitively in
`payloadHash` and `eventHash`.
