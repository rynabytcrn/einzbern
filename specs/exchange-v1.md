# Exchange V1

## Scope & Applicability

This document is normative and describes the exchange envelope admitted by
`validateExchangeEnvelope` against `exchange-v1.schema.json`. An envelope is a
portable, transport-neutral manifest of content entries: for each entry it binds
a portable relative path, a media type, a byte length, and a content digest. It
inherits every canonical-JSON, ordering, instant, identifier, and extension rule
from `protocol-common-v1`. It carries the AOS requirement `AOS-REQ-009` (portable
exchange envelope).

## Record Shape

The envelope field set is exact and closed (`additionalProperties: false`): an
envelope has precisely `schemaVersion`, `id`, `createdAt`, `protocolVersion`,
`entries`, and `extensions`, with no other keys.

| Field             | Rule                                                    |
| ----------------- | ------------------------------------------------------- |
| `schemaVersion`   | the constant string `tcrn.exchange.v1`                  |
| `id`              | a `stableId`                                            |
| `createdAt`       | a `strictInstant`                                       |
| `protocolVersion` | the constant integer 1                                  |
| `entries`         | a complete array within the executing runtime                      |
| `extensions`      | the shared closed extension map (complete within the executing runtime)    |

Each entry is exact and closed with precisely `path`, `mediaType`, `size`, and
`sha256`:

- `path` — a portable relative path without a product length ceiling. It may
  not be absolute, contain a backslash, or contain an empty, `.`, or `..`
  segment.
- `mediaType` — a string of 1 through 128 Unicode scalar values.
- `size` — a nonnegative safe integer that fits the executing runtime buffer.
- `sha256` — a lowercase SHA-256 digest matching `^[a-f0-9]{64}$`.

## Digest & Canonicalization

Each entry's `sha256` is the lowercase hexadecimal SHA-256 of that entry's
content bytes. The envelope itself is hashed with the shared `canonicalSha256`
rules (`utf8-byte-order-v1` recursive key ordering, safe integers only, one
terminal LF). The envelope binds content by digest, not by embedding bytes.

## Reason Codes

Envelope admission emits codes from the shared `PROTOCOL_REASON_CODES` list:

- `RECORD_MALFORMED` — missing/extra field, wrong `schemaVersion`, a
  `protocolVersion` other than 1, a non-array `entries`, a non-string or
  wrong-shape `sha256`, a negative or non-integer `size`, or an empty
  `mediaType`.
- `CANONICAL_VALUE_INVALID` — a key that is not a well-formed Unicode scalar
  string.
- `ID_INVALID` — an `id` that is not a valid `stableId`.
- `TIMESTAMP_INVALID` — a `createdAt` outside the strict instant subset.
- `PATH_ESCAPE` — an absolute path, a backslash, or an empty/`.`/`..` segment.
- `INPUT_OVERSIZED` — a value beyond the executing runtime capacity, a
  `mediaType` above 128 scalar values, or a `path` above 512 scalar values.
- `CANONICALIZATION_MISMATCH` — entries not in strictly ascending path order.
- `UNKNOWN_REQUIRED_EXTENSION` — a required extension with no registration.

## Ordering & Determinism

Entries are ordered by `path` using `utf8-byte-order-v1`; the admitter rejects
any entry whose path does not strictly follow its predecessor, which also forbids
duplicate paths. Object keys serialize in the same total order under canonical
JSON, so an envelope's bytes and digest are a stable function of its entry set.

## Failure Semantics

Admission is fail-closed and total: the first violated rule throws with its
specific reason code and no envelope is returned. An admitted envelope asserts
only the manifest — it does not imply a transport, endpoint, credential,
database, or live-compatibility claim, and it does not fetch or write content.

## Non-Goals

Filesystem materialization, chunked transfer, resumption, and crash-consistent
writeout are a separate module and are out of scope for this envelope contract.
Receipt of an envelope is represented separately (see `receipt-v1`).
