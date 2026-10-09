# Einzbern 2.0.0 发行说明：安装与引擎版本

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 10/13：安装与引擎版本

上一模块：[Atelier](Release-Notes-2.0.0-Atelier.md) · 下一模块：[Mana Orchestrate](Release-Notes-2.0.0-Mana-Orchestrate.md)

## A library this engine may not open is refused when it is opened

A library this engine may not open is refused when it is opened, before any lock is taken,
the device cache is read or anything is written (TCRN-CROSS-STORY-471 R1, AC1; MIN-227 D22;
`packages/core/src/format-version.ts`): a library or stream manifest whose `formatVersion` is
newer than the newest format this engine reads (1) is `LIBRARY_FORMAT_UNSUPPORTED` with
`required` and `supported`, and a library whose `minEngineVersion` is above this engine's
version is `ENGINE_TOO_OLD` with `required` and `actual`. Versions compare by semantic-version
precedence, pre-releases included. The two fields are read before the rest of the manifest is
judged, so a newer format that changed the manifest's shape is still named as a newer format.

## Engine versions live in the device directory

Engine versions live in the device directory (TCRN-CROSS-STORY-471 R2, R3, AC2, AC3; STORY-469
R3; MIN-227 D22, D23; `packages/core/src/engine-home.ts`): `engine/<version>/` holds one whole
engine per version, `engine/current` (`einzbern.engine-current.v1`: `version`, `previous`,
`switchedAt`) names the one in use, and `engine/einzbern.mjs`, the stable entry an installer
copies from `scripts/einzbern-launcher.mjs`, runs the current version's `scripts/einzbern.mjs`
with the same arguments and exit code, so a hook names that file and never a version directory.
`engine-update --from <unpacked tree> --sha256 <install-tree digest> --version <x.y.z> --at`
checks the tree against the digest, copies it to `engine/<version>/` (or reuses the same bytes
already there; other bytes under that version are `ENGINE_VERSION_CONFLICT`), runs it once with
`engine-list` to prove it starts as that version and to learn the library format it reads
(`ENGINE_PROBE_FAILED`, `ENGINE_VERSION_MISMATCH`), and only then rewrites `engine/current`,
keeping the version it replaces as `previous`; it reports every library in this device's
registry the new version would refuse (`ENGINE_TOO_OLD`, `LIBRARY_FORMAT_UNSUPPORTED`).
`engine-rollback --at` makes the previous version current again, so a second rollback undoes the
first (`ENGINE_ROLLBACK_UNAVAILABLE` when there is none or it is no longer installed), and
`engine-list` shows the versions, the pointer and whether the stable entry is in place. A switch
rewrites `engine/current` alone, so `settings.json` and `hooks.json` never change. Fetching a
release is the installer's job; the engine never reaches the network.

## `status` reports `multiDevice`

`status` reports `multiDevice` (TCRN-CROSS-STORY-471 R4; MIN-227 D22): every device the library
knows (its `akasha/` directories), the engine version its stream manifest records (null for a
device with no committed manifest yet), whether it is this device and whether it is ready, and a
plain hint naming the devices to upgrade first (`先把以下设备升级到 ≥<version> 再写入新格式：…`)
while a device's version is unknown or below the one required: the library's `minEngineVersion`
while the format stays, the writing engine's version for a newer format. A write that raises a
library's format must check the same readiness first and refuse with `LIBRARY_UPGRADE_NOT_READY`
(`packages/core/spec/ether-library-v1.md`); this engine has no such write yet.

## The engine ships as one release archive that needs nothing but Node.js

The engine ships as one release archive that needs nothing but Node.js (TCRN-CROSS-STORY-481;
MIN-227 D23, D28; `scripts/lib/bundle.mjs`, `scripts/pack-release.mjs`,
`skill/mana-orchestrate/scripts/install.mjs`, `packages/core/src/node-floor.ts`).
`pnpm run bundle --entry <file> --out <file>` writes an entry and every module it reaches as one ES
module with no dependency: only `node:` built-ins stay outside the file, a bare specifier is refused
with `BUNDLE_EXTERNAL_DEPENDENCY`, and a file a module reads beside itself through
`new URL("<relative path>", import.meta.url)` is carried inside it. The bundler is the TypeScript
compiler this repository already pins; nothing is added and nothing is fetched.
`pnpm run pack:release [--version <version>] [--out <directory>]` packs the build as
`einzbern-<version>.tar.gz` and its `.sha256` (in `dist/release` by default): one
`einzbern-<version>/` directory holding the CLI and the hook entry as one file each, the two stable
launchers as they are, Atelier as one file beside the static files it serves, the skill rendered for
the version, the READMEs, CHANGELOG.md, LICENSE and NOTICE, and `manifest.json`
(`einzbern.release-manifest.v1`: `version`, `nodeFloor`, `installTreeDigest` and `files`, the digest
taken over the directory without the manifest). Two packs of one tree are the same bytes: the tar
headers carry no time and no owner, and the gzip header names no time and no platform. A
`--version` the built engine does not answer as is refused with `PACK_VERSION_MISMATCH`. The
skill's `scripts/install.mjs` is the fetch step that puts an engine on a device before any engine
is there: `--version <version>` downloads that release, the one network use of the installation,
and `--archive <file>` takes a local archive and fetches nothing. The archive's sha256 must equal
`--sha256` or the one its `.sha256` states (`INSTALL_ARCHIVE_DIGEST_MISMATCH`, and nothing is
written); it is unpacked with `node:` built-ins alone, installed through `engine-update` against the
manifest's install-tree digest, given both launchers as `engine/einzbern.mjs` and `engine/hook.mjs`,
and answered with `INSTALL_ENGINE_READY` and the next step, setup. The engine runs on Node.js 24.0.0
or later (`NODE_FLOOR`, exported by core with `assertNodeFloor` and `meetsNodeFloor`): the CLI
refuses an older Node.js with `ENGINE_NODE_TOO_OLD` and the `required` and `actual` versions before
the rest of the engine loads, and the hook answers nothing there. CI packs the archive, unpacks it
under the runner's temporary directory and runs `commands`, and `status` on a temporary library, from
it with Node.js alone.

## The installation wizard is one verb, `setup`, and a device is checked with `doctor`

The installation wizard is one verb, `setup`, and a device is checked with `doctor`
(TCRN-CROSS-STORY-480; MIN-227 D24; `packages/core/src/setup.ts`, `setup-fresh.ts`,
`setup-restore.ts`, `setup-maintain.ts`, `doctor.ts`).
`setup --mode fresh|restore|update|repair|migrate|uninstall --project <dir> --at <UTC>`
takes the answers `--artifacts`, `--cloud`, `--language` and
`--navigation` and the options `--restore`, `--archive`, `--rollback`, `--managed-sections` and
`--mapping`, each in the modes that use it (`SETUP_OPTION_NOT_APPLICABLE` otherwise). Without
`--yes true` it writes nothing and answers `SETUP_PLAN_READY`: the answers given, the questions
still open with their defaults, every file the apply would write in the order it writes them, the
originals it would back up first and whatever stops the apply. With `--yes true` it applies the
plan and answers `SETUP_APPLIED`: the files written, the backup directory and `selfCheck`, which
holds doctor's eight checks (`checks`) and the hook run once as a host runs it, from the project's
directory with the project's name as the prompt (`prompt`, `exitCode`, `injected`,
`hookReasonCode`). fresh installs the library, the registry entry, both skill copies, the two
launchers, one hook per host, the project's write permissions for a library outside it and the
managed sections, and a second run writes nothing. restore first runs eight checks of the library,
and the first that fails stops it with nothing written and names the check (`check`, which the CLI
entry now passes on): `RESTORE_UNREADABLE` (a placeholder that does not arrive is
`AKASHA_READ_TIMEOUT`), `RESTORE_NOT_A_LIBRARY`, `RESTORE_FORMAT_UNSUPPORTED`,
`RESTORE_STREAM_INVALID` (a broken hash chain or a sync client's conflicted copy),
`RESTORE_PROJECT_MISMATCH`, `RESTORE_REGISTRY_BOUND_ELSEWHERE`, `RESTORE_DEVICE_STREAM` and
`RESTORE_SECTIONS_DIVERGED`; then it registers and wires the project without writing the library's
settings, and `columns` lists those that came back beside this device's own. update installs the
release `--archive` names, the archive with its `.sha256` or the directory it unpacks to, checked in
memory and again by `engine-update`, and `--rollback true` goes back to the previous version; either
lays the skill copies, the launchers and the hooks again from the version now current, writes no
managed section and reports `engineSwitch`. repair runs the steps from the registry on again for
the registered library. uninstall takes the Einzbern hooks out of both hosts, moves both skill
copies and their record into the device directory's backups and removes the registry entry after
copying the registry there; the library is never read or written, and `--managed-sections remove`
takes the section markers out of the project's files and leaves their text. migrate plans the
migration of an installation from before the rename (below).
`doctor [--project <dir>]` answers `DOCTOR_READY` with `ok` and the eight checks
(`engine-version`, `hooks-present`, `skill-copies`, `registry`, `library-format`, `device-stream`,
`managed-sections`, `cloud-flag`), each `{check, ok, reasonCode, detail}` with its causes in
`detail.causes`. The skill's references follow these flags and reason codes.

## The installation wizard now says so before it writes this device's library path into a project host file Git tracks

The installation wizard now says so before it writes this device's library path into a project
host file Git tracks (TCRN-CROSS-STORY-499 R16, TCRN-CROSS-SUB-385; fixes TCRN-CROSS-STORY-478,
TCRN-CROSS-STORY-480; `packages/core/src/setup.ts`, `setup-fresh.ts`, `host-writable-roots.ts`).
When the library sits outside the project, fresh, restore and repair name it in the project's
`.claude/settings.local.json` and `.codex/config.toml`; each of the two that is in Git's index is
listed in the plan's new `warnings` before anything is written, and again in the `warnings` of
`SETUP_APPLIED`, as `{reasonCode, file, message}`: `HOST_WRITABLE_ROOTS_TRACKED_BY_GIT`, the file
relative to the project, and the message `scripts/host-render.mjs` gives for the same file. It is
listed whether or not the run changes the file, since the file names the library either way.
`warnings` is empty when neither file is tracked or the library is inside the project, and a
warning never stops the apply: the wizard still commits, unstages and ignores nothing. The CLI
prints the plan and the receipt as they are; their schema versions, host-render and doctor are
unchanged. The skill's install, update and restore references show the warnings at the final
confirmation. Whether Git tracks a host file is asked of the index alone, before any library
exists (`hostFileTrackedByGit`, exported by its module and not by core's index).

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[Atelier](Release-Notes-2.0.0-Atelier.md) · 下一模块：[Mana Orchestrate](Release-Notes-2.0.0-Mana-Orchestrate.md)
