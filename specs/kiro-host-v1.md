# Kiro host integration v1

This contract describes the candidate Kiro CLI and standalone Hook integration. It does not establish that an IDE Hook ran, that a real Kiro session used V3, or that a requested model, effort, or quota was actually selected.

## Separate surfaces and identity

Kiro CLI and Kiro IDE are independent surfaces. `probeKiroHost` observes the CLI version with `kiro-cli --version` and the IDE bundle from its Info.plist independently. CLI availability does not prove IDE availability or selection. A version probe proves neither the harness used by a later session nor which model ran. The reported actual CLI harness, selected surface, and sub-agent first-work signal remain unknown unless a per-session source proves them.

## CLI V3 Hooks

Standalone Hooks use the versioned document `.kiro/hooks/einzbern.json` with `{ "version": "v1", "hooks": [...] }`. Kiro CLI V3 loads global `~/.kiro/hooks/` and workspace `.kiro/hooks/` Hooks alongside each other. Einzbern keeps one effective owned set to avoid duplicate executions: a verified workspace set takes precedence over a global set; otherwise the global set is used. Other named hooks, unknown Einzbern-prefixed hooks, extra document fields, custom Agents, permissions, trust files, and older hook files remain untouched.

Managed entries are identified by their exact names, expected fields, and a launcher command recognized as an Einzbern Hook. A changed managed entry is a conflict and is preserved for review. Removal applies only to those entries with ownership evidence. Backups are made before replacement and existing backups are never overwritten.

| Trigger | Behavior |
| --- | --- |
| `SessionStart` | Navigation pointer only when shared navigation was declined. |
| `AgentSpawn` / `agentSpawn` | Compatibility aliases for `SessionStart`; they do not prove a child-agent event or first work. |
| `UserPromptSubmit` | Recall text is emitted as plain stdout context. Kiro CLI still submits the prompt; it cannot be refused by this hook. |
| `PreToolUse` | For documented Kiro V3 `read_file` input with an observed regular file path, the read guard may allow or deny. A deny writes its reason to stderr and exits with status 2. Unknown tool names or unrecognized input stay unknown and do not deny. |

The hook's `read` matcher follows Kiro's built-in read category. Other tools in that category are passed through as unknown unless their actual input meets the guarded `read_file` contract. Shell commands are never interpreted as file reads.

## Hook and Skill locations

The global Skill copy is `${KIRO_HOME:-$HOME/.kiro}/skills/mana-orchestrate`. Workspace Hooks are stored under `<project>/.kiro/hooks/`; global Hooks are under `${KIRO_HOME:-$HOME/.kiro}/hooks/`. The Skill-copy manifest records the Kiro destination and digest. Updates preserve user-modified copies, and uninstall moves a Kiro Skill only if the current bytes still match the recorded ownership digest.

Doctor reports Kiro CLI and IDE identity independently. If Kiro is not selected, it reports `not-selected` and does not mark the missing Kiro Hook or Skill as applicable. If selection evidence cannot be read, it reports `selection-unknown` rather than silently treating Kiro as selected or absent.

## Prepared CLI invocation and evidence

`execution-host-prepare` remains the admission point. It captures the current work, permission/source scope, requested selection, authorized fallback boundary, configured quota, reported host capacity, tool availability, and current policy. `execution-kiro-preflight` accepts only a matching Kiro CLI preparation. Its optional `--reserve-output` creates an empty private create-new destination under the dispatch artifact guard and returns its filesystem identity; without that option preflight is read-only. It does not start a process or grant permission.

`skill/mana-orchestrate/scripts/kiro-run.mjs` accepts a saved preparation and a create-new output path. When admitted, it runs `kiro-cli chat --v3 --no-interactive --output-format stream-json`, pipes the prepared prompt on stdin, passes `--model` for an explicit resolved selection, and adds `--effort` unless the explicit effort is `default`. The `default` value keeps the model explicit while leaving effort selection to Kiro. The runner passes the current environment through and does not use `KIRO_API_KEY` presence as an authentication check; Kiro CLI selects from its supported existing auth sources, and an authentication failure returned by the CLI is recorded as a process result. Headless mode documents API-key authentication for non-interactive use, while Kiro's Authentication page documents active browser sessions before API-key authentication. The runner does not add a tool-approval override.

The runner reserves and checks the exact destination before starting Kiro, then writes the engine-produced evidence through the reserved file. A setup failure after reservation names the possibly remaining reserved path. If final evidence persistence fails after a process return was saved, its error reports the private temporary `process-return.json` path. Retain that file and use `execution-kiro-record --binding <saved preparation> --result <process-return.json> --output <new private destination>` to recover the evidence; inspect the originally reserved destination separately because it may be empty or incomplete. If the process return itself cannot be fully saved, the error says so and identifies any partial file rather than claiming recovery succeeded.

The process receipt retains actual start/close observations, exit code or signal, cancellation request, stdout, and stderr. It separates preflight refusal, spawn failure, process exit, recognized permission refusal, and the documented `mcp-startup-failure` service error (exit code 3). A nonzero exit is not automatically a task failure or a service error. If the CLI output does not expose a documented service-error observation, that field stays unknown. The receipt does not infer task completion from process exit, and requested model/effort are not actual model/effort observations. Usage remains unknown unless Kiro returns a documented usage source.

Artifacts contain prompts and CLI output. The CLI writes them as create-new private files outside device and library roots. A digest detects later changes; it is not provider authentication or independent review.

## Source contracts

- [Kiro Hook triggers](https://kiro.dev/docs/hooks/types/) — per-trigger behavior, including the V3 `AgentSpawn` alias, prompt-submit behavior, and PreToolUse blocking.
- [Kiro Hooks](https://kiro.dev/docs/hooks/) — standalone file format and global/workspace scope.
- [Kiro CLI V3 Hooks migration](https://kiro.dev/docs/cli/v3/hooks-migration/) — canonical trigger names and compatibility aliases.
- [Kiro built-in tools](https://kiro.dev/docs/tools/) — the V3 `read_file` tool ID and read category.
- [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/) — explicit V3, stdin, `KIRO_API_KEY`, stream-json, and the documented permission-denial line.
- [Kiro authentication](https://kiro.dev/docs/getting-started/authentication/) — active browser session precedes API-key authentication.
- [Kiro reasoning effort](https://kiro.dev/docs/models/effort/) — effort availability depends on the selected model and the current model picker exposes supported levels.
- [Kiro CLI exit codes](https://kiro.dev/docs/reference/exit-codes/) — general exit status, MCP startup failure, and Hook exit status 2.
