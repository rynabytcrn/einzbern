# Runtime and integration input contract v1

Status: metadata contract implemented in this candidate. This is not a statement that a user's installed engine, host approval, browser, or account has been inspected.

## Purpose and authority

`packages/core/src/runtime-input-contract.ts` is the value-free dictionary for configuration-adjacent inputs outside the registered persistent settings catalogs. `runtimeInputContract(commandCatalog?)` returns `einzbern.runtime-input-contract.v1`; `configurationContract` exposes it as the independent `runtimeInputs` section. CLI callers supply the existing `COMMAND_CATALOG`. The core module neither imports the CLI nor copies its argument parser.

The dictionary describes existing consumers. It does not introduce an environment parser, alter an input's precedence, make an internal flag a public setting, authorize writes, return an effective secret/path/token, or synchronize machine choices. Persistent registered settings remain in `SETTINGS_CATALOG` and `MACHINE_SETTINGS_CATALOG`; typed variables, governance, projections and installation state keep their dedicated APIs.

The complete machine-readable artifact is the returned dictionary, not a second manually maintained table in this document. To read it through the integrated CLI, inspect `settings-catalog`'s `configurationContract.runtimeInputs`. Its `entries` are the detailed per-input rows. `commandCatalog` retains all supplied command and flag metadata, with `commandCatalogRole: operational-invocation-payloads`: command payloads are **not** automatically persistent settings. `commandCatalogAttached` distinguishes a bare core dictionary from a CLI-enriched one. A missing detailed lifecycle flag in a supplied catalog raises `RUNTIME_INPUT_CATALOG_MISMATCH`, rather than silently inventing a declaration.

## Entry schema

Each row contains:

- `key`, `kind`, `name`: stable identity, input transport family and actual environment/key/flag name. A CLI flag is identified with its command; similarly spelled `--home` flags are not aliases.
- `classification`: `startup-override`, `host-context`, `internal-transient`, `browser-preference`, `lifecycle-input`, `managed-integration`, or `test-only`.
- `visibility`: public invocation, controlled integration, internal, or test-only. This is discoverability guidance, not authorization.
- `semanticType`, `transport`, `validation`: semantic value versus actual string/file transport and the owning consumer's existing validation behavior. Optional `allowedValues`, `min`, and `max` are descriptive metadata, never a second validator.
- `defaultValue`, `defaultDescription`: a literal fallback when one exists, plus the precise absent/required/contextual behavior. `null` does not mean an empty-string default or a nullable persisted setting.
- `precedence`: highest priority first for this one consumer. Empty-value fallthrough and malformed-value refusal are specified in `validation`. There is no global CLI > environment > machine > project rule.
- `owner`, `scope`, `source`, `persistence`: whose input it is, which target it affects, where it originates, and whether its value exists for an invocation/process/browser or in a managed device file. A lifecycle input is transient even if its authorized effect writes persistent state.
- `sensitivity`, `pathBase`, `sharing`, `export`: local-path, execution-target, actor, transient-token and potentially private context boundaries. An input name and schema are public metadata; its actual value is not returned.
- `consumer`, `consumption`, `effect`, `restart`, `editing`: real source entrypoints, whether wired/helper-only/test-only, what the input does, when it takes effect, and the dedicated editing surface.
- For detailed CLI rows, `command`, `catalogReference`, and optionally `flag`: `flag` is copied from the supplied `COMMAND_CATALOG`, including requiredness, transport kind, value shape, null sentinels and deprecated aliases. An unbound core-only dictionary retains the catalog reference rather than guessing those fields.

Entries and their owned arrays are frozen. No dictionary call reads `process.env`, localStorage, host files, credentials or runtime values.

## Supported runtime/environment inventory

The detailed environment rows cover:

1. `EINZBERN_HOME`: absolute device directory; empty/unset falls back to `homedir()/.einzbern`. A relative nonempty environment root is refused. All stable launcher/bootstrap/heavy-run consumers preserve this rule.
2. `EINZBERN_HOST` and `CLAUDE_PROJECT_DIR`: valid explicit host wins; otherwise nonempty Claude project context implies Claude Code, else Codex. Unknown host declarations are treated as unset. Neither declaration is authenticated identity.
3. `CLAUDE_CODE_EXECPATH`: valid executable regular file for an explicitly requested Claude host probe, else `claude` on PATH. Production Codex probes use `codex` on PATH. The API's explicit executable override is a test seam, not a new public environment setting.
4. `EINZBERN_HEAVY_LOCK_DIR`: local lock-directory override; relative overrides use cwd. This is distinct from the persistent `execution.maxConcurrentHeavyRuns` cap.
5. `EINZBERN_RENAME_RETRY_BUDGET`: canonical nonnegative safe integer, default 8, with explicit API budget taking precedence. Zero is allowed.
6. `EINZBERN_LOCAL_PROBE_TIMEOUT_MS`: canonical positive integer within Node's timer range. The helper default is 5000 ms; actual callers may supply a different fallback, including gates planning's 30000 ms. It is not a product admission ceiling or global model timeout.
7. `TCRN_PORTAL_ACTOR`, `TCRN_WORKFLOW_CLI`, `TCRN_PORTAL_LIBRARY`, `TCRN_PORTAL_PORT` and the three `TCRN_PORTAL_WORK_*` budgets described below.
8. `TCRN_OTEL_SINK`: **helper-only**. `otel-spans.ts` can append allowlisted verb spans when explicitly called, but the current CLI dispatcher does not call it. Setting this name alone does not enable CLI tracing. This existing unwired helper is recorded rather than advertised as working observability.

Internal transient rows are deliberately separate:

- `EINZBERN_SURFACE` conveys the Atelier child-call convention. It is not authentication or a public bypass switch.
- `EINZBERN_PROJECT_CONTEXT` is the CLI-generated canonical project handoff for gate subprocesses. It is not long-lived user configuration.
- `EINZBERN_GATE_RUN_PRIOR` is generated per gate from this run's earlier results, overwriting an inherited value. It carries local context and paths only to the intended child, not shared configuration or a caller-configurable success claim.
- `EINZBERN_HEAVY_SLOT` conveys a parent's transient token and slot file. The consumer verifies owner/token/liveness before inherited reuse; invalid inheritance follows normal acquisition. The dictionary never emits a token.

The four fault-injection environment controls physically present in `scripts/lib/safe-io.mjs` are explicitly `test-only`, with disabled defaults and exact checkpoint metadata. They are excluded from ordinary configuration editing. Contract tests only inspect their metadata/source; they do **not** run crash/race/lifecycle experiments.

## Atelier startup

The startup parser is independent of the engine CLI catalog:

- `--library` and `--port` use separate flag/value argv tokens. The first matching flag with a following token wins. A missing final token falls back to its environment value; `--flag=value` is not supported by this parser. Empty selected strings subsequently fall through as the existing consumers specify.
- Library selection: explicit `--library` > `TCRN_PORTAL_LIBRARY` > registered project from startup cwd > registered `portal.defaultPartition` > first registered library. A nonempty explicit selector that matches no registered library refuses; it does not fall back. The registry must contain a library.
- Port selection: explicit `--port` > `TCRN_PORTAL_PORT` > machine `portal.port` > 4319. The startup consumer uses `Number` and permits safe integers 0–65535, where 0 requests an ephemeral port. It listens on `127.0.0.1`. This differs intentionally from the narrower persistent machine-setting range; the registry must not falsely claim the same validator.
- Actor: `TCRN_PORTAL_ACTOR` is trimmed and required before library work. It is declared attribution, not authenticated identity.
- CLI target: defined `TCRN_WORKFLOW_CLI` overrides the bundled script, including an empty string that may fail execution. Relative overrides are interpreted by the Node child launched with `portalRoot` as cwd. This controlled integration target must not be supplied by a shared project setting.
- Work-read budgets: page records 100, page concurrency 4, read attempts 3. Each requires a canonical positive safe integer. They govern processing and retry windows, never maximum admitted library size.

Startup changes require a new server instance. UI library switching remains runtime selection, not a rewritten startup preference.

## Browser layer

Only three persistent keys under `tcrn.workflow.portal.` are inventoried: `theme`, `locale`, and `navigation`. They remain browser-origin-local and are not sent back as governed library settings.

- Theme: valid stored `light`/`dark` > machine `light`/`dark`/`system` > light. Machine `system` follows `prefers-color-scheme` and subsequent media-query changes until a browser choice overrides it. An unavailable media-query API falls back to light. `system` is not itself a persisted browser toggle value.
- Locale: a valid stored locale > valid machine locale > boot default > `en`. Valid values are the shipped locale keys. This does not set artifact language.
- Navigation: `expanded` or `collapsed`, default expanded. This sidebar state is unrelated to `agents.navigation` or shared generated navigation.

Invalid/unreadable localStorage values are ignored; blocked storage writes do not turn a UI preference into a server setting. Machine defaults are reread with a page reload; explicit browser choices apply immediately.

## Three different home/path conventions

| Surface | Meaning | Precedence and relative base |
| --- | --- | --- |
| `EINZBERN_HOME` | Device directory itself | Nonempty absolute environment path, else user home plus `.einzbern`; relative environment path refused |
| `machine-settings-* --home`, `device-clean --home` | User-home directory | Explicit argument plus `.einzbern` overrides environment; legacy relative argument follows cwd |
| Standalone `install.mjs --home` | Device directory itself | Explicit argument normalized from cwd > absolute `EINZBERN_HOME` > user home plus `.einzbern` |

The explicit user-home CLI exception remains compatible even when an unused `EINZBERN_HOME` is malformed. The installer likewise gives its explicit device-home flag priority. This metadata does not tighten either legacy flag behavior.

`setup --project` is cwd-relative. Setup's `--artifacts`, `--restore`, `--archive`, and `--mapping` are project-root-relative. Standalone installer `--archive` and engine-update `--from` are cwd-relative. These bases are per-entry facts, not interchangeable aliases for portable shared declarations.

## Lifecycle and managed host integration

All flags for `setup`, `engine-update`, `engine-rollback` and `device-clean` have detailed lifecycle rows bound to the original command catalog. Special home rows also cover all three machine-settings commands. Other operational CLI flags remain in the full command catalog, without fabricated universal defaults, persistence or inheritance.

- Setup exposes all six modes. The dedicated mode table owns option applicability. Its plan supplies contextual defaults and blockers; `--yes true` applies the plan. An unset or false confirmation does not apply.
- `--artifacts` chooses a local library binding; `--cloud` writes local registration information; `--language` becomes the governed target's artifact-language declaration; `--navigation` records a local host-navigation preference. Being answers to one wizard does not give them one storage owner.
- Restore/migration/archive/rollback choices retain dedicated validation. Uninstall's managed-section choice defaults to keep. Missing required restore/update input blocks apply; absent migration mapping can be inferred only by its existing consumer.
- `engine-update --sha256` is the **install-tree** digest. Standalone installer `--sha256` is the **compressed archive** checksum. These are not the same input. Version identity and installed execution are verified before switching current. `--at` is the strict timestamp supported by the protocol, including a numeric UTC offset, not an invented UTC-only parser.
- Standalone installer flags are `--version`, `--archive`, `--sha256`, and `--home`. Its own parser rejects duplicate/unknown/empty flags and `--flag=value`; it is not represented as a `COMMAND_CATALOG` command.
- Managed host hook commands point to the absolute stable device launcher. Codex's hooks feature switch and per-hook approved hashes are device integration state, not shared settings. Dedicated rendering preserves unrelated content and invalidates stale owned trust for changed/removed hooks; it does not manufacture approval. DSH's external plugin remains separate and is not installed or reconfigured by this registry.
- Current/previous pointers, receipts, installed hashes, managed-section status and generated outputs remain runtime/installation state. No retired signature trust archive, SSH control tree or account binding is revived.

## Coverage and exclusions

`runtimeInputs.coverage` is the exact machine-readable scan boundary. Tests recursively scan core, CLI and protocol source plus the listed product entry/support files and standalone installer. AST identifiers and string literals matching product-owned `EINZBERN_*` / `TCRN_*` names include constants passed into computed environment access. A new literal name in that boundary requires an explicit row/classification; a removed name requires reconciliation. Browser read/write keys, standalone installer flags and CLI lifecycle flags have separate parity tests.

The boundary intentionally distinguishes:

- OS/runtime inputs and cloud-directory hints such as HOME, USERPROFILE, PATH, OneDrive variants, NODE_NO_WARNINGS and GIT_OPTIONAL_LOCKS. They are not newly exposed as product preferences. The two specific Claude host inputs are detailed separately.
- Release/CI/proof/test-controller/legacy platform-maintenance tools outside the named product files. Their own TCRN_BACKUP/SSH/DS and test-controller interfaces are not ordinary runtime settings. No private deployment values are inspected or returned.
- Arbitrarily computed names, external plugin code, shell behavior, user-supplied gate data, dynamic account state and actual installed host state. The static scan does not claim to exhaust those.

This replaces the former blanket exclusion of environment/browser/startup inputs with a bounded explicit registry. It is exhaustive for the detailed rows and literal product-owned names in the declared scan set, **not** every environment variable or arbitrary command payload in the entire repository and runtime ecosystem.

## Verification

`tests/runtime-input-contract.test.mjs` verifies metadata completeness/value non-disclosure, immutable catalog reuse, detailed lifecycle parity, product-source name classification, device-home exceptions, internal context and lease classification, Portal parser/selection/port/budget behavior, local I/O validation, browser key/locale/system-theme wiring, installer parser/path/checksum distinctions and test/helper-only classification.

Pure consumer functions are extracted from their actual source for isolated deterministic tests where importing a process entrypoint would start a server or installer. Tests do not implement alternate product parsers, start Portal, install an engine, invoke live host models, use user data, or run prohibited fault-injection experiments. Existing consumer regression suites and same-candidate integration verification remain required; registry tests do not replace them.

The added execution-request, selective projection output-keys and relocation transaction-id
are invocation controls, not new persisted project settings. Their detailed rows link to the
admission, managed-render and identity-bound recovery consumers.
