# Einzbern 2.0.0 发行说明：发行与仓库工具

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 13/13：发行与仓库工具

上一模块：[迁移](Release-Notes-2.0.0-Migration.md)

## The repository's `test` task waits out a process group whose members are still exiting

The repository's `test` task waits out a process group whose members are still exiting
(TCRN-CROSS-SUB-402, TCRN-CROSS-INC-393; TCRN-CROSS-STORY-493; `scripts/task.mjs`). `kill(-group, 0)`
can answer EPERM for such a group, so the group exit wait asks again after EPERM inside the same
10 s window (1,000 probes 10 ms apart); ESRCH is exit, any other code still fails closed at once
with `TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN` naming that code, an EPERM that lasts the whole window
fails closed the same way naming EPERM, and a group still alive at the end is still
`TEST_CONTROLLER_GROUP_LIVENESS_TIMEOUT`. The wait carries a test seam,
`TCRN_TEST_PROCESS_GROUP_PROBE_CODES`: a comma-separated list of error codes (`E[A-Z0-9]+`) that the
first probes of each wait report instead of probing, the last one repeated when it ends in `*`; a
malformed value fails closed with the new `TEST_CONTROLLER_GROUP_PROBE_INJECTION_INVALID`.

## The platform doctor no longer checks the container `AGENTS.md`

The platform doctor no longer checks the container `AGENTS.md`, whose layout rendering pipeline is
retired (TCRN-CROSS-STORY-491 R2, TCRN-CROSS-SUB-376; `scripts/platform-doctor.mjs`,
`packages/core/src/install-manifest.ts`). Its output drops the `platformAgents` leg (a non-empty
file with the topology section; `PLATFORM_AGENTS_MISSING`, `PLATFORM_AGENTS_NOT_FILE`,
`PLATFORM_AGENTS_EMPTY`, `PLATFORM_AGENTS_TOPOLOGY_SECTION_MISSING`) and the `platformAgentsHistory`
leg (byte equality with `platform-docs/platform-root-agents.md`; `PLATFORM_AGENTS_UNTRACKED`,
`PLATFORM_AGENTS_HISTORY_DIVERGED`), and `install-manifest` names 17 items: `container.platform-agents`
is neither an item nor a required id, so `installWiring` no longer probes the file. Every other leg
keeps its name, order and reason codes, and a `CLAUDE.md` whose import target is gone is still named
by `bridgeSyntax` (`PLATFORM_BRIDGE_TARGET_UNAVAILABLE`). Gate receipt stores no longer pile up in
TMPDIR (Q12; `scripts/final-gate-plan.mjs`): each receipt authority still makes its
`tcrn-code-owned-gates-*` store with `mkdtemp`, and every receipt in it stays on disk and trusted for
every query its process makes, but the stores a process made are removed when that process exits,
which the tests and `batch:formal` both inherit, so the `storeRoot` a batch reports is gone once the
run ends. A store that cannot be removed is left where it is and never changes the exit code. Receipt
documents, descriptors, trust checks and reason codes are unchanged.

## The release privacy scan reads the formal package by its content

The release privacy scan reads the formal package by its content (TCRN-CROSS-INIT-053 R48). Both
release privacy scans of `verify:p8` (its artifact scan and the P8 surface of its privacy scan) take
their entries from one builder: the gzip header's text fields, every ustar header, padding and end
block of the inflated archive, and each member's path and body under the reviewed member labels. The
compressed bytes are bound by digest only (the sidecar, the release manifest and the aggregate
surface digest) and are no longer read as text, so a deflate stream that happens to spell an address
is no finding, while an address or a local path in a member, a member path or a gzip text field
still is. A package another reader would unpack to something the scan does not label (reserved gzip
flags, a second gzip member, bytes after the trailer, a CRC or length that does not match, an entry
other than a regular file) is refused with `P8_RELEASE_ARCHIVE_LAYOUT_INVALID`.

## The root `package.json` drops `pg:schema` and `pg:test`

The root `package.json` drops `pg:schema` and `pg:test`, whose target files were removed with the PostgreSQL backend in TCRN-CROSS-INC-275 (TCRN-CROSS-SUB-357 S2).

## Release preparation can now run in two phases around one local release commit per repository

Release preparation can now run in two phases around one local release commit per repository
(TCRN-CROSS-SUB-357, the Owner's method of 2026-10-08). `scripts/release.mjs generate` checks
both trees, reads the gate plan, the versions and the CHANGELOG cut before it changes a file, then
writes the versions, the single core version replacement, the CHANGELOG section and
`docs/releases/<version>.md`, builds, renders the READMEs, regenerates the CLI reference only when
it is out of date and renders the helper tree. It records a receipt outside both repositories: every
changed file with its status, size and SHA-256, the gate library and declaration digest, and the
helper's extra files, tracked and untracked, with the tracked ones kept by `--keep-extra` and the
rest to remove. It commits nothing and runs no gate. `scripts/release.mjs finish` refuses unless
each repository is exactly one single-parent commit past the recorded HEAD with the recorded bytes,
the engine commit passes the release commit check, the helper commit removes exactly the listed
files and leaves the kept ones unchanged, and the gate library and declarations are unchanged. It
then moves other versions' release artifacts to `dist/stale-release/` by the P8 rule, runs the
release gates, packs and checks. Both phases report every failed condition together; `prepare`,
`check`, `publish-plan` and `--execute` are unchanged.

## `pnpm privacy:staged` labels staged content with its repository path

`pnpm privacy:staged` labels staged content with its repository path, as `verify:privacy` labels
working-tree files, so the reviewed DS provenance line staged at its own inventory path is
classified and no longer reported, while the same line at another or renamed path, or next to other
private content, remains a finding (TCRN-CROSS-SUB-357 S1).

## P8 classifies the compiled public-owner metadata line in a 2.0.0 package only in the three members that carry it

P8 classifies the compiled public-owner metadata line in a 2.0.0 package only in the three members
that carry it, `atelier/portal.mjs`, `scripts/einzbern-hook.mjs` and `scripts/einzbern.mjs`, each
by its exact label, after a member-by-member review of an isolated 2.0.0 release dry run; another
version, member, line or value remains a finding (TCRN-CROSS-SUB-357 S1). The version checks in the
tests read the current version, so the release commit changes no test.

## Release preparation requires explicit registered library and project roots

Release preparation requires explicit registered library and project roots and
checks the real release gate selection, execution, saved run and unchanged tree
and declarations (TCRN-CROSS-SUB-357). Empty declarations, missing required roots
and red gates refuse preparation. An approved future release updates the actual
core version with the manifests; build, pack and P8 read that same version, while
schema identifiers remain independent. Release commit checks admit only the
single core version replacement and verified generated README and CLI documents.
Actual release preparation and publishing retain their separate authorization stops.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[迁移](Release-Notes-2.0.0-Migration.md)
