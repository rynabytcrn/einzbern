# Einzbern 2.0.0 发行说明：召回与钩子

[发行说明](Release-Notes.md) › [Einzbern 2.0.0](Release-Notes-2.0.0.md) › 模块 4/13：召回与钩子

上一模块：[工作记录、纪要与决策](Release-Notes-2.0.0-Work-Records-and-Minutes.md) · 下一模块：[知识](Release-Notes-2.0.0-Knowledge.md)

## Recall answers by intent, and only on a strong hit

Recall answers by intent, and only on a strong hit (TCRN-CROSS-STORY-474; MIN-227 D5, D7;
`packages/core/src/recall-inputs.ts`). The index holds the Stories and the Incidents on their title,
goal and body, the Initiatives and Epics on their title and goal, every minutes record and the
cards; a Subtask, a Release or a Review is not indexed, and status does not matter. When the best
hit scores below the strong-hit threshold, `recall` answers `RECALL_NO_STRONG_HIT` with no records
and an empty `context`. The threshold is the `retrieval.tau` setting, whose default
`RECALL_STRONG_TAU` is 17: the smallest multiple of 0.25 above the best score sixteen everyday
prompts reach on the recorded cross-project corpus
(`tests/fixtures/retrieval-eval/strong-threshold.json`; `node scripts/retrieval-eval.mjs --calibrate`
recomputes it). bm25 grows
with a library, so a library of a few dozen records answers mostly title matches and named keys at
that value and lowers `retrieval.tau`. English function words leave the query, and a key fragment
that names one record by whole tokens and carries a digit (`STORY-474`) is answered as its key is.
Each record of an answer carries `line` (`[Story done] title · key · id · Epic title ‹ Initiative
title`) and `parentChain`, and the answer carries `context`, those lines cut at whole lines to
`injection.perPromptBytes`, reported as `perPromptBytes`. `--partition` and the `partition` field
are gone with the partition registry; `--host` stays. The retrieval evaluation corpus is
re-recorded read-only from the cross-project chain by `scripts/retrieval-eval-record.mjs`, with
paths, addresses and host names redacted, and the gate holds the unrelated group empty at the
threshold and answered at zero (`RETRIEVAL_EVAL_THRESHOLD_DETACHED` otherwise). The engine package
has no session-level injection entry: its host hooks render no SessionStart or PostToolUse hook.

## The strong-hit threshold is counted in words one record carries

The strong-hit threshold is counted in words one record carries (TCRN-CROSS-SUB-302, SUB-303;
TCRN-CROSS-STORY-474; MIN-235 D9; `packages/core/src/recall.ts`, `packages/core/src/settings.ts`,
`scripts/retrieval-eval.mjs`). `retrieval.tau` is no longer a raw bm25 score: it counts the bm25
weight of a word exactly one of the library's N indexed records carries, ln((N - 0.5) / 1.5) (at
least 1e-6), and recall compares the ranked scores with the searched library's own floor, tau times
that unit, so one value means the same in a library of four records and in one of six hundred. The
default `RECALL_STRONG_TAU` is 3, replacing the raw default of 17 above: the smallest whole number
above every unrelated prompt of the recorded corpus (2.83 units) and no higher than the lowest
related query of a four-record goal and body library (3.52 units), recorded as
`tests/fixtures/retrieval-eval/small-library.json` beside `strong-threshold.json` (v2). The range
stays 0 to 100, hit scores stay raw bm25, the core recall result also reports that `floor`, and a
named key is answered whatever the threshold. `scripts/retrieval-eval.mjs` calibrates on both
libraries, holds both unrelated groups empty at the default and answered at zero, and fails with
`RETRIEVAL_EVAL_THRESHOLD_FAILED` when no whole number separates the groups.

## One hook replaces the harness

One hook replaces the harness (TCRN-CROSS-STORY-477; MIN-227 D4, D5; `packages/core/src/host-hooks.ts`,
`packages/core/src/hook-recall.ts`). A host's settings carry one Einzbern hook, on UserPromptSubmit
only: `node "<device directory>/engine/hook.mjs" user-prompt-submit`. The path is absolute and
double-quoted, written with backslashes on Windows, and no shell wraps the line; no argument names
a checkout, a container or a host. `scripts/host-render.mjs --host --scope user|project` renders
it into Claude Code's `settings.json` or Codex's `hooks.json`. Every other tool's hooks and keys
stay. Taken out are every hook of the old harness, the `permissions.deny` rules that fenced the
old directories and the `tcrnWorkflowInert` key. For Codex it turns the hooks feature on and drops
the trust state of a hook that is gone. host-render no longer projects dispatch settings, and
`--workspace`, `--settings`, `--mode`, `--repo-root`, `--hooks-only` and `--backup-dir` are
refused with `HOST_RENDER_ARGUMENT_UNKNOWN`; `--library` still renders writable roots.
The launcher is `scripts/einzbern-hook-launcher.mjs`, installed as `engine/hook.mjs` beside
`engine/einzbern.mjs` (install manifest item `machine.hook-launcher`). It imports nothing from any
engine. It reads the registry and at most one Git config and starts no process. Where no project
is registered it ends with exit 0 and no output, and no library is opened. In a registered
project, or in another clone of it found through its remote, it imports the current version's
`scripts/einzbern-hook.mjs`. That entry confirms the library through the registry and answers with
recall's hit lines as `additionalContext`, cut to `injection.perPromptBytes`. A prompt without a
strong hit gets nothing, and every failure still ends with exit 0.
The old injection chain is gone: `scripts/knowledge-inject-hook.mjs`, `scripts/knowledge-inject.mjs`
and the session ledger `scripts/injection-session.mjs`, with the `~/.tcrn-injection` state it
kept, the placement manifest and their fixtures (TCRN-CROSS-STORY-474 R4). Its query translation
and knowledge judge went with it. The `recall` verb still reports a query's language, and
SessionStart, PostToolUse, PreToolUse, Stop, SubagentStart and SubagentStop carry no hook but the
two pointer hooks of a device that declined the navigation section (TCRN-CROSS-STORY-478, below).
platform-doctor no longer requires the old knowledge hook to name its container root.

## The hook launcher now appends one line to `log/hook.ndjson`

The hook launcher (`engine/hook.mjs`, TCRN-CROSS-INIT-053 R47) now appends one line to
`log/hook.ndjson` in the device directory when a prompt lands in a known container (a library, an
old-layout workspace or an old platform container) that this device's registry does not cover,
naming why with `HOOK_REGISTRY_ABSENT`, `HOOK_PROJECT_UNREGISTERED` or `HOOK_LIBRARY_UNREGISTERED`;
its exit code, stdout and stderr are unchanged, and a note it cannot write is dropped.
`scripts/platform-doctor.mjs`'s hooks leg now also reads the user-level `.claude/settings.json` and
`.codex/hooks.json` of the home it is given (checking only Einzbern's launcher and the old harness's
hooks there), reports a launcher hook whose device directory lacks `engine/current` or
`registry.json` as `PLATFORM_HOOK_ENGINE_NOT_INSTALLED`, listed after any
`PLATFORM_HOOK_TARGET_UNAVAILABLE`, and no longer lets an absent container Claude settings file hide
failures in the other hook files. Its `helperSettingsCoverage` is now red when the engine's settings
catalog or the installed helper payload cannot be read (`PLATFORM_HELPER_SETTINGS_UNREADABLE`,
`PLATFORM_HELPER_PAYLOAD_UNREADABLE`, still with `coverageAsserted: false`).
`scripts/verify-staged-privacy.mjs` accepts an origin naming the helper repository
(`mana-orchestrate`, or its old name) as well as the engine repository; the owner still comes from
origin and no classification is widened. The doctor reference of the helper skill gains "A hook that
answers nothing" (where the hook log is and how to read it), and the wiki FAQ answers how to tell a
hook that answers nothing from one that never ran.

---

[返回模块目录](Release-Notes-2.0.0.md) · 上一模块：[工作记录、纪要与决策](Release-Notes-2.0.0-Work-Records-and-Minutes.md) · 下一模块：[知识](Release-Notes-2.0.0-Knowledge.md)
