# Einzbern 2.0.0 发行说明：改名与精简

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 1/13：改名与精简

下一模块：[库与设备](Release-Notes-2.0.0-Libraries-and-Devices.md)

## Einzbern and Mana Orchestrate ship in lockstep at 2.0.0

Einzbern and Mana Orchestrate ship in lockstep at 2.0.0. The former TCRN Workflow and tcrn-workflow-helper release names are retired; previously written TCRN keys and tcrn.* records remain historical compatibility identifiers. Retired surfaces are listed below.

## The engine is renamed Einzbern

The engine is renamed Einzbern (TCRN-CROSS-MIN-227 D1, D2; TCRN-CROSS-STORY-466). The
helper is Mana Orchestrate, the library directory is `.ether`, events live in `akasha/`,
knowledge in `crest/`, and the per-machine directory is `~/.einzbern`. Every event and
record already written keeps its `tcrn.*` schema string byte for byte and is read as the
legacy namespace; newly written events use `einzbern.*`. Work-item prefixes
(`TCRN-CROSS-*`) and every historical `externalKey` are unchanged. The alias table below
is rendered from `packages/core/src/names.ts` and is the same table as
`docs/wiki/Glossary.md`.

<!-- einzbern:alias-table:start -->
| 旧名 | 新名 | 说明 |
| --- | --- | --- |
| `TCRN Workflow` | `Einzbern` | 产品名 |
| `tcrn-workflow` | `einzbern` | 引擎：仓名、npm 包名与 CLI 命令名 |
| `tcrn-workflow-helper` | `mana-orchestrate` | 助手：仓名与 Skill id |
| `.tcrn-workspace` | `.ether` | 项目生成物目录（库） |
| `.tcrn-workflow/` | `.ether/` | 旧布局的工作区控制目录；新引擎只读打开，不再写入 |
| `events/` | `akasha/` | 事件目录；新布局每台设备一个子目录 |
| `knowledge/` | `crest/` | 知识目录 |
| `~/.tcrn-workflow` | `~/.einzbern` | 设备目录（本机） |
| `TCRN Workflow Portal` | `Atelier` | 门户 |
| `tcrn.*` | `einzbern.*` | schema 命名空间；已写入的 tcrn.* 原样保留为只读旧命名空间，新写入用 einzbern.* |
| `.tcrn-artifacts` | （不改名、不迁移） | 平台档案，归平台层，不随改名迁移 |
<!-- einzbern:alias-table:end -->

## The governance layer is trimmed

The governance layer is trimmed (TCRN-CROSS-MIN-227 D3; TCRN-CROSS-STORY-467). Writes are
serialised by an engine file lock: `--expected-version`, its `head` sentinel and the
`lease-inspect`, `lease-break` and `lease-recovery-break` verbs are gone, and every
workspace write receipt carries the ids it wrote beside `version` and `headEventHash`.
The time-attestation store, `--attest-dir` and the `attestation-enable`,
`attestation-migrate` and `attestation-verify` verbs are gone; a chain that already
carries `attestation.actor.enabled` still replays and still requires an actor.
The authority family is gone too: the `gate-*`, `profile-*` and `context-*` verbs,
`knowledge-candidates`, the operator-pins channel (`--authority-pins`) and the authority
files they read. Gate records already on a chain still replay, and a pending one still
holds its work item back from `done`.
The `dispatch-*` and `telemetry-*` verbs, `scripts/dispatch-adapter.mjs`, the dispatch-telemetry
hook and the local telemetry store are gone: nothing writes or reads telemetry, `work-transition`
no longer takes `--evidence`, and knowledge fitness reports zero observations. A work record
that already carries a telemetry evidence snapshot still replays and is still checked.
The host hook scripts are gone with the inert adapter templates: the stop pact and the
response-style checks (`tools/stop-pact`), `scripts/chain-write-guard.mjs`,
`scripts/ssh-write-observer.mjs` with its channel proof and break-glass allowlist,
`scripts/agents-zero-hook.mjs` and `scripts/knowledge-capture-hook.mjs`, the Claude and Codex
adapter bundles with their install receipts, and this repository's own
`.claude/settings.json` observer fixture. The harness then rendered governed context
injection only (TCRN-CROSS-STORY-477 replaces it, below), and the `knowledge-capture` verb stays.
The guard mutation check and its registry, the verification map with its link and red-leg
checks, the proof-artifact generator, the RC1 candidate manifest and its input policy, and
the source allowlist are gone, with `guard-check`, `verify:map`, `verify:source`,
`generate:proof-artifacts`, `regen:map-digests` and `regen:rc1-inputs`. The source
archive and the P8 source set are the tracked file list, and the push gate runs P1 and P8.
The proof budget (its policy, the `verify:budget` and `report:budget` scripts and the
doctor's `proofBudget` leg), the governance leg (`verify:governance`: licences, lifecycle,
vulnerability snapshot, Git history, with the history and vulnerability policy files) and
coverage conservation with its baseline and waivers are gone. The test leg runs the suite only, and P1 runs twelve legs.
Release trust is the install-tree digest: `einzbern-release-verify --tree <dir> --sha256
<digest>` admits an unpacked release when its digest (sorted files, CRLF text read as LF,
symbolic links refused) equals the stated one. The signed manifest, the external trust root,
the in-toto build statement, the P8 trust leg, the helper trust archive and its install
markers are gone, and the helper copies are accepted as directories.
`verify:p1` runs all twelve legs and reports every red with its reason code (`P1_RED` with
`legs` and `reds`) instead of stopping at the first one.
The portal follows: the gate view, the dispatch configuration surface with its
<code>&#47;api/execution</code> route, the telemetry, mode and token statistics and the five-root path
panel are gone. Its writes carry workspace, time and actor only, and it no longer reads
`--attest-dir` or `TCRN_PORTAL_ATTEST_DIR`.

---

[返回模块目录](Release-Notes-2.0.0.md) · 下一模块：[库与设备](Release-Notes-2.0.0-Libraries-and-Devices.md)
