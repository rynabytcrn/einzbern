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
files change. Choosing a different commit time, splitting preparation into phases,
or creating a separate release library requires explicit approval of that method.

Run `check` after preparation and again after committing both repositories. It
checks the engine manifest, every `packages/*/package.json`, the core source and
built `FRAMEWORK_VERSION`, the helper manifest,
the CHANGELOG section, the engine README set, the helper README set, and the helper
`SKILL.md` all carry the requested version.

Packing also checks every engine manifest and the actual source and built core
version. P8 derives its version, tag and seven exact artifact names from this
tree's manifest. The current 1.2.1 candidate retains its historical repository
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

The release action requires the matching version tag at both repositories' origins.
The Wiki action delegates to `scripts/push-wiki.mjs`, which rehearses and commits
the local Wiki sync before pushing it.

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
