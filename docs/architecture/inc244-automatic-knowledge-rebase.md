# INC-244 automatic knowledge high-water rebind

> **Retired by TCRN-CROSS-SUB-414** (STORY-476 D7, MIN-235 D7). The CLI no longer rebases the
> knowledge store after a chain write: the rebind described below is gone, and nothing it wrote is
> written any more. A library's crest (`.ether/crest/`) is each device's event stream. A read
> projects it at the chain head it replays, so a chain write never leaves the knowledge surface
> behind -- the purpose INC-244 served -- without writing a byte of the crest, and the root
> manifest `store.json` is written by `knowledge-init` alone. `knowledge-rebase` and
> `knowledge-batch --align-first` re-validate every record and write nothing; `--allow-trailing` is
> still taken and changes nothing about a library's answer.
>
> The contract is `packages/core/spec/knowledge-core-v1.md`: "Storage and authority" (the one
> operation that writes `store.json`, and the list of those that do not, a chain write among them)
> and "High-water rebase". `tests/inc244-auto-rebase.test.mjs` now proves the new behaviour: after
> a CLI workspace event the knowledge surface answers at the new head, and the crest is untouched.
> `tests/library-crest-devices.test.mjs` proves it for chain writes on two devices. The rest of this
> page is kept as the record of what INC-244 added.

## What INC-244 added (retired)

Every CLI workspace mutation already holds the workspace lease and commits one
event. The CLI now snapshots the pre-write head, executes the mutation, and—only
when the head changes—reads an existing knowledge marker with the explicit
`allowTrailing` diagnostic option. If the marker trails, the engine invokes the
ordinary governed `rebaseKnowledgeStore` CAS path under the same held lease.

The mechanism is deliberately narrow:

- no knowledge store means no extra work and does not block a normal workspace write;
- a current marker is not version-bumped;
- a rebase refusal (`KNOWLEDGE_REBASE_BLOCKED`, malformed store, lock, or CAS issue)
  is returned to the caller rather than hidden behind a green workspace receipt;
- normal `validateKnowledgeStore` remains strict, while the explicit diagnostic
  read discloses the stored and chain heads before the rebase CAS;
- no full-corpus scan occurs after every event beyond the bounded rebase path, and
  knowledge writes do not recursively trigger a workspace rebase.

The proof is `tests/inc244-auto-rebase.test.mjs`, which appends a real CLI project
event after initializing a fixture knowledge store and verifies that the next
strict validation is green at the new event head.
