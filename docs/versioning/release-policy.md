# Release Policy

Einzbern and Mana Orchestrate ship as one lockstep release. A release is started
by an explicit release decision; merged work, green gates, or elapsed time do not
start one.

## Release triggers

The release triggers remain:

| Trigger | What counts | What does not |
| :--- | :--- | :--- |
| Protocol change | A schema identifier, trust contract, event-record shape, or CLI contract that a consumer compiles against changes | An internal refactor, a new verb that no consumer pins, a comment |
| Host format break | A supported host changes a format this repository must produce or parse, such as a hook payload, settings shape, or session-start contract | A host version bump this repository parses unchanged |
| Security fix | A defect with a security consequence in the shipped bytes | A hardening improvement with no defect behind it |

Every approved public release uses a fresh Semantic Version and `v<version>` tag,
even when it does not change a protocol schema. Select the increment by the
compatibility effect: breaking public changes use a major increment,
backward-compatible functionality uses a minor increment, and compatible fixes use
a patch increment. Both repositories carry the same version in every package
manifest and generated versioned document. An existing changelog section or local
or remote tag cannot be reused.

From the first release after 2.0.3, a change to a format version or to the shape
of an event raises the minor version (TCRN-CROSS-MIN-257 D3); such a change is not
released as a patch.

`schemaVersion` identifies a protocol or document contract, independently of the
package version. It changes when that contract's compatibility semantics change;
a release can advance its Semantic Version while keeping every compatible schema
identifier unchanged.

## Prepare the local release

Run the release script from the Einzbern repository and name the helper working
tree explicitly:

```sh
node scripts/release.mjs check --version <version> --helper <helper-working-tree>
node scripts/release.mjs prepare --version <version> --helper <helper-working-tree> --workspace <library> --project <registered-project>
```

`prepare` updates the engine and package versions and the actual core
`FRAMEWORK_VERSION` declaration, cuts the current `Unreleased`
notes into a versioned CHANGELOG section, records the Einzbern and Mana Orchestrate
renames and retired surfaces, and renders both repositories' versioned documents.
It builds the engine, runs every enabled release gate, then writes the deterministic
`einzbern-<version>.tar.gz` and its `.sha256` file. Any failed build, renderer,
release gate, pack, or digest check stops preparation. The command makes local
working tree changes only and creates no commit.

`--workspace` names an existing Einzbern library and `--project` names its exact
registered project on this device. That project must contain both release
repositories. The current tree must already have a build for the initial CLI
declaration checks. The gate declarations must be nonempty, include enabled
required gates on the exact engine and helper roots, and select every enabled
gate. Preparation passes `--release true` and both explicit roots to the real CLI;
it reads the saved native run and checks every selection, execution, exit status,
tree digest and declaration digest. Missing required coverage, a changed tree or
declaration, or any red gate stops preparation.

Preparation preserves its existing clean checkout checks and makes no commit.
Gates that require a clean committed tree can therefore refuse after the release
files change. The approved two-phase method below commits each repository once
between generating the release files and running the gates.

## Two-phase preparation

The approved method splits preparation around one local release commit per
repository. Run both phases from the Einzbern repository, on checkouts whose `.git`
is a directory rather than linked worktrees: the build, the gates and the output
session that moves stale artifacts refuse a linked worktree. Keep `EINZBERN_HOME`
on the same device directory for both phases, because the library registration
and the gate runs belong to that device.

```sh
node scripts/release.mjs generate --version <version> --helper <helper-working-tree> --workspace <library> --project <registered-project> --receipt <new-receipt-file> [--keep-extra <helper-path>]...
node scripts/release.mjs finish --version <version> --helper <helper-working-tree> --workspace <library> --project <registered-project> --receipt <new-receipt-file>
```

`generate` requires both trees clean and records both HEAD commits. Before it
changes a file it reads the release gate plan, the current versions and the
CHANGELOG cut, checks that the receipt is a new file outside both repositories
and that each `--keep-extra` path is tracked by the helper, and reports every
failed condition together. It then writes the package versions, the single
`FRAMEWORK_VERSION` replacement, the versioned CHANGELOG section and
`docs/releases/<version>.md` from that section, builds the engine and checks the
built version, renders the engine READMEs, regenerates the CLI reference only when
its check reports it out of date, and renders the helper tree. The receipt records
every changed file of both repositories with its status, size and SHA-256, the
gate library and declaration digest, and the helper's extra files: those Git
tracks, and those it does not track, such as an ignored lockfile. `--keep-extra`
names a tracked extra file that stays in the helper; every other tracked extra
file is listed in `removeFiles`. Untracked extra files are never removed and never
committed. `generate` creates no commit and runs no gate.

Commit each repository exactly once after `generate`. The engine commit contains
the receipt's changes. The helper commit contains the receipt's changes and the
`git rm` of every `removeFiles` path; kept files and untracked extra files stay as
they are.

`finish` reads the receipt and requires the same version, repositories, library
and project. Each repository must be exactly one single-parent commit past its
recorded HEAD and clean. The engine commit must change exactly the recorded files
with the recorded bytes and pass the release commit check below. The helper commit
must change exactly the recorded files and remove exactly `removeFiles`, while the
helper's kept files and kept extra files stay byte-identical. The gate library and
its declaration digest must still match the receipt
(`RELEASE_RECEIPT_BASIS_CHANGED` otherwise), and the source and built core version
must be the release version. Every failed condition is reported together, and
nothing runs. When the commits match, `finish` moves the source archive and
formal package of every other version from `dist/release/` to
`dist/stale-release/<version>/` by the existing P8 rule, runs every enabled release
gate as preparation does, refuses to pack while `dist/release/` still holds an
artifact of another version, packs, checks the archive digest and runs `check`.
A red gate stops `finish` before packing. `finish` can run again on the same two
commits; a source change means removing both release commits and generating
again.

Run `check` after preparation and again after committing both repositories. It
checks the engine manifest, every `packages/*/package.json`, the core source and
built `FRAMEWORK_VERSION`, the helper manifest,
the CHANGELOG section, the engine README set, the helper README set, and the helper
`SKILL.md` all carry the requested version.

Packing also checks every engine manifest and the actual source and built core
version. P8 derives its version, tag and seven exact artifact names from this
tree's manifest. The 1.2.1 candidate retains its historical repository
identity; future candidates name `tpmoonchefryan/einzbern`. These bindings change
no remote. Release and P8 schema identifiers remain independent of the version.

The release commit check admits the existing generated README language set and
the generated CLI reference only after their actual checks pass. It admits the
core source only when the full parent and HEAD blobs differ by one
`FRAMEWORK_VERSION` replacement to the requested version. Other source changes
and missing generation or source evidence remain refusals.

## Publish stops

Commit the prepared changes in both repositories before creating a plan. The plan
requires the Wiki working tree so it can print the exact Wiki command:

```sh
node scripts/release.mjs publish-plan --version <version> --helper <helper-working-tree> --wiki-dir <wiki-working-tree>
```

Planning prints the two local tag commands, the two pushes, the GitHub release
command with the archive and checksum attached, and the Wiki push command. Planning
does not create tags, push commits, create a GitHub release, or push the Wiki. Each
action remains a separate stop and runs only when explicitly named:

```sh
node scripts/release.mjs --version <version> --helper <helper-working-tree> --execute tag
node scripts/release.mjs --version <version> --helper <helper-working-tree> --execute push
node scripts/release.mjs --version <version> --helper <helper-working-tree> --execute release
node scripts/release.mjs --version <version> --helper <helper-working-tree> --wiki-dir <wiki-working-tree> --execute wiki
```

Tag by hand rather than with `--execute tag` or the tag commands the plan prints:
in each repository, create an annotated tag `v<version>` (`git tag -a`) on that
repository's release commit. Every action builds the plan first and so needs
`docs/wiki/Release-Notes-<version>.md` in the engine tree, and that page comes in
a documentation commit after the engine's release commit; the tag action tags HEAD
with a lightweight tag, which would put the engine's tag on that documentation
commit. `--execute push` pushes the tags made by hand.

The release action requires the matching version tag at both repositories' origins.
The Wiki action delegates to `scripts/push-wiki.mjs`, which rehearses and commits
the local Wiki sync before pushing it.

## Release notes

Each version's release notes are published in the Wiki's Release Notes chapter,
under that version. `docs/wiki/Release-Notes.md` lists the versions, and
`docs/wiki/Release-Notes-<version>.md` is the version's page. Within the version,
the notes are divided into sub-chapters by functional module, one page per module
(`docs/wiki/Release-Notes-<version>-<module>.md`), so that no reader has to take in
the whole version at once; the version's page opens with the module directory, and
the module pages link to the directory and to each other. The pages rearrange the
paragraphs of `docs/releases/<version>.md` under module and item headings without
shortening, extending or rewording them, and that file at the version's tag remains
the complete release notes. Like every Wiki page they are edited in `docs/wiki/`
and reach the Wiki through the Wiki action above.

The version's CHANGELOG section is organized by the same functional modules: the
notes under `## Unreleased` stand in `###` sub-sections, one per module, so the
section that preparation cuts from them, and `docs/releases/<version>.md`, carry
the release summary followed by the module sub-sections.

The GitHub Release body carries only a short description of the version and a link
to the version's page in the Wiki's Release Notes chapter (the Wiki page
`Release-Notes-<version>`); it never carries the full release notes. The release
command that `publish-plan` prints and `--execute release` runs builds this body as
its `--notes` value, in three paragraphs: the first sentence of the release summary
in the release script (the same paragraph that preparation writes at the top of the
version's CHANGELOG section), the line
`Release notes, by functional module:` followed by the page's address, and a line
naming the two attachments. The script composes the address when it builds the
plan, from the repository owner and the engine name in the core names module. The
release attachments are unchanged: the archive `einzbern-<version>.tar.gz` and its
`.sha256` file. When `docs/wiki/Release-Notes-<version>.md` in the engine tree is
missing, empty or not a regular file, the plan refuses with
`RELEASE_WIKI_NOTES_MISSING`, prints no command and runs no action, so a release
never links to an empty Wiki page. The complete notes stay in
`docs/releases/<version>.md`, which `generate` still writes from the version's
CHANGELOG section in full, and in the Wiki.

## Version identity

The release tag is `v<version>` in both repositories. The archive is named
`einzbern-<version>.tar.gz`; the adjacent `.sha256` file records the archive's
SHA-256 digest. The versioned CHANGELOG section preserves the rename and retirement
details, including the historical compatibility of previously written `tcrn.*`
records. The release trust check is the install-tree digest verified by the
installer; a local release result does not prove a remote publication succeeded.

## Existing artifact and post-release checks

The existing P8 check moves stale versioned source archives from `dist/release/`
to `dist/stale-release/<version>/` before asserting the closed artifact set. It
does not touch `dist/evidence/`. Do not use `pnpm clean` to clear release artifacts:
it also deletes gate evidence that later readings may cite.

After GitHub creates a release, verify its assets by release id because the
by-tag endpoint can briefly return an empty asset list. Read the id with
`gh api repos/{owner}/{repo}/releases/tags/{tag} --jq .id`, then read the release
by id. Confirm the names and count match the candidate manifest, each asset is
`uploaded`, and each `sha256:<hex>` digest matches. Download each public asset and
compare its SHA-256 and size with the manifest and by-id listing.

For a Claude host smoke or another local `claude` call, use the executable named
by `CLAUDE_CODE_EXECPATH` when it is executable. Otherwise compare
`claude --version` with the host version before calling it; stop if the standalone
CLI is older. A smoke using the host login must not add `--bare`, which only
authenticates with `ANTHROPIC_API_KEY` or an `apiKeyHelper`.

Smoke evidence records the complete argv passed to the process, including the
executable path, flags, values, and prompt, along with environment variable names.
It never records environment values, tokens, or keys.
