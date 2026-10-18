# Identity-bound relocation recovery v1

Relocation retains the existing `workspace-relocate --workspace <source> --to <target> --at <instant>`
entry point. It pins the registry before acquiring the library write lock, matching
Portal's registry-to-library order. Every writer using the shared workspace-write boundary rechecks its tombstone
inside the acquired lock before mutation.

## Publication and ownership

A destination receives a distinct `relocation-pending` guard before copying. The
transaction records only entries it exclusively created. Verification excludes only
the recognized transaction guard, never arbitrary user files. After verifying the
copy, relocation persists the source tombstone/completion receipt, repoints the
registry, then removes the matching destination guard last. At most one root is
writable through these phases. Interrupted preparation remains guarded.

The receipt binds the transaction, library, source/destination filesystem identities,
original stream/history witness, tree digest and original completion report. Existing
historical tombstones remain readable; they are not silently upgraded or adopted as
new recovery transactions. Unrecognized guards, identity changes and unexpected
content refuse recovery rather than deleting or accepting foreign files.

## Recovery commands

Repeat the original relocation command with the same source and destination and a valid
`--at` instant to resume
a recognized publication. Pending publication verifies the original snapshot; after
completion, replay validates identity and history continuity without demanding that
legitimate later destination writes match the old tree digest. The report distinguishes
`completed`, `resumed` and `historical-completion`. Historical replay preserves the
original recorded relocation time even when the retry supplies a later instant; it is not
a new verification receipt.

Before the source tombstone has been published, an abandoned preparation can be removed
with `workspace-relocate-discard --workspace <source> --to <target> --transaction-id <id>`.
This requires the exact receipt identity and unchanged source. Cleanup considers only
attempt-owned entries, never recursively sweeps the target, and preserves unrelated
additions. Changed or unexplained entries cause refusal with the guard retained for
inspection. The transaction ID is not permission to adopt an unrelated directory.

Host writable-root wiring is performed after data/registry publication and lock release.
Its failures are reported independently; recovery uses the saved, validated project
roots rather than treating hook success as proof of data publication.

## Evidence boundary

Ordinary sequential phase/state fixtures cover interrupted publication, repeated
completion after legitimate writes, exact cleanup ownership, invalid transaction guards and expired transaction capabilities.
They do not establish power-loss behavior, arbitrary concurrent interleavings,
macOS filesystem semantics or multi-device synchronization.
