# Protocol Common V1

This document is normative. V1 protocol documents use canonical UTF-8 JSON.
Every normative text ordering uses `utf8-byte-order-v1`: compare the exact UTF-8
byte sequences as unsigned bytes and let a proper prefix sort first. Inputs
must be well-formed Unicode scalar strings. V1 performs no Unicode
normalization or case folding, so composed and decomposed spellings are
distinct. This same total order applies to recursive object keys, ID arrays,
paths, work/event tie breakers, RC1 input records, and verification digests.
Arrays otherwise preserve their specified order; JSON has no insignificant
whitespace, permits safe-integer numbers only, and ends with exactly one LF.
SHA-256 digests cover those exact bytes.

Every scalar string and every object key is validated independently before
ordering or serialization, including singleton and nested objects. Lone UTF-16
surrogates fail with `CANONICAL_VALUE_INVALID`; implementations may not rely on
a sorting callback to discover malformed keys. Canonical object bytes are
emitted directly from the validated `utf8-byte-order-v1` key list; reconstructing
a JavaScript object and relying on its enumeration order is forbidden. Every
enumerable own key is preserved exactly, including `__proto__` and integer-like
keys; therefore `"10"` sorts before `"2"`.

Stable IDs use `namespace:value`; namespaces and values are lowercase ASCII and
match the common schema. The namespace starts with a letter; the namespace and
value then use the declared ASCII characters with no product length ceiling. Raw
external keys must be printable ASCII before any
conversion and canonicalize with ASCII lowercase-to-uppercase conversion only;
non-ASCII values are rejected. `deriveStableId` hashes the namespace, a NUL
separator, and the canonical external key, then uses the first 24 lowercase
hexadecimal characters. Unicode expansion aliases such as `ß` and `ss` are
therefore impossible.

Instants use the strict no-leap-second RFC 3339 subset. Parsing yields an exact
signed epoch-nanosecond integer after numeric offset normalization; comparisons
never use host date parsing or millisecond rounding. V1 rejects normalized,
date-only, locale, impossible-date, seconds-60, and invalid-offset values.
Version windows are inclusive and require `1 <= minimum <= version <= maximum`.

Unknown optional extensions are preserved byte-semantically through canonical
JSON. Every extension-bearing V1 record uses the same closed extension value
shape, stable-ID property-name rule, safe-integer
canonical-value rules, and registry check.
Unknown required extensions fail with `UNKNOWN_REQUIRED_EXTENSION`.
Objects reject unknown normative fields. R4 removes the former 1 MiB canonical,
10,000-record, 8,192-character, 64-extension and 64-level product ceilings.
Canonical serialization visits its stack iteratively, preserves complete values,
refuses cycles, non-plain objects, ill-formed Unicode and unsafe integers, and
retains the runtime's own string, buffer and array capacities. These capacities
are measured from Node, not replacement product budgets. A caller may request a
processing window; that window does not permanently limit library size. See
`docs/verification/init053-owner-return-limit-inventory.json` for each consumer,
removed bound and necessary protocol or runtime boundary.

All failures use one code from `PROTOCOL_REASON_CODES`; implementations MUST NOT
replace a more specific code with a generic success or partial result.
