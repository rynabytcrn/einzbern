# Release Trust V1: Install-Tree Digest

The words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and
MAY are interpreted as described by RFC 2119.

Release trust answers one question: are the installed bytes the bytes that were
published? The signed manifest, the external trust root, the in-toto build statement,
the transaction log and the test-root restriction of the earlier contract are
retired (TCRN-CROSS-STORY-467 R2, TCRN-CROSS-MIN-227 D3).

1. A publisher MUST state one install-tree digest per release: 64 lowercase
   hexadecimal characters.
2. The digest covers every regular file under the unpacked release directory. Files
   are ordered by their POSIX relative path, compared by UTF-8 bytes.
3. Each file contributes its relative path, its size and its sha256. A text file
   (no NUL byte, valid UTF-8) is measured after CRLF line endings are read as LF, so
   a checkout that converted line endings still matches; any other file is measured
   as it is.
4. The tree digest is the sha256 of the canonical JSON document
   `{"entries": [...], "schemaVersion": "einzbern.install-tree-digest.v1"}`.
5. A symbolic link or any other non-regular file in the tree MUST be refused with
   `INSTALL_TREE_ENTRY_NOT_REGULAR`; it is never followed or skipped.
6. A verifier MUST admit the tree only when the computed digest equals the stated
   one, and MUST otherwise refuse with `INSTALL_TREE_DIGEST_MISMATCH`, naming both
   digests. A stated digest that is not 64 lowercase hexadecimal characters is
   refused with `INSTALL_TREE_DIGEST_INVALID`.

The executable reference is `einzbern-release-verify --tree <directory> --sha256
<digest>` (`scripts/verify-release-trust.mjs`), which reads the one definition in
`packages/core/src/install-tree-digest.ts`.

`engine-update --from <directory> --sha256 <digest> --version <version> --at <instant>`
(TCRN-CROSS-STORY-471 R3, `packages/core/src/engine-home.ts`) applies the same check before
it installs a version into the device directory's `engine/<version>/`, and checks the copy
it made against the same digest before that version can become current.

The release gates carry no trust ceremony (TCRN-CROSS-STORY-488 R3). The push gate
(`scripts/push-gate.mjs`), P8 (`scripts/lib/p8-workflow-rc.mjs`) and the release tag
gate (`scripts/lib/release-tag-gate.mjs`) perform no signing step, emit no provenance
statement and read no trust archive. What they keep is version consistency: the package
manifests, `FRAMEWORK_VERSION`, the P8 manifest and tag, the `CHANGELOG.md` heading and
the release note must name one version, and a push must not contradict a published tag
of it. P8's `release-manifest.json` and `checksums.txt` stay as the candidate's local
record of its own bytes; nothing signs them.
