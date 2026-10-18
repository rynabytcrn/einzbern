# 命令行参考

本页由 `scripts/wiki-cli-reference.mjs` 根据 `COMMAND_CATALOG` 生成。每个动词均列出可用范围、是否写入，以及旗标是否必填和取值类型；旗标的值有固定写法时另列「写法」；`programmatic-only` 表示只能由程序调用。

## `agents-render`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--project` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--actor` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `artifact-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `artifact-put`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--file` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--timeout-ms` | 可选 | `integer` |

## `artifact-verify`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `chain-declare`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--project-id` | 可选 | `string` |
| `--workspace` | 可选 | `string` |
| `--role` | 必填 | `string` |
| `--coordination-library-id` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `chain-identity`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `chain-validate`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `commands`

- 可用范围：`cli`。
- 是否写入：否。

无旗标。

## `configuration-projections-plan`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |

## `configuration-projections-refresh`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--actor` | 可选 | `string` |  |
| `--output-keys` | 可选 | `string` | `JSON array of stable registered output keys; omitted selects all known outputs, [] selects none` |

## `device-clean`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--at` | 必填 | `instant` |
| `--yes` | 可选 | `boolean` |
| `--home` | 可选 | `string` |

## `doctor`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--project` | 可选 | `string` |

## `engine-list`

- 可用范围：`cli`。
- 是否写入：否。

无旗标。

## `engine-model-policy-catalog`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--host` | 可选 | `string` |

## `engine-model-policy-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--host` | 必填 | `string` |  |
| `--policy` | 必填 | `json` |  |
| `--at` | 必填 | `instant` |  |
| `--actor` | 必填 | `string` |  |
| `--decided-in` | 必填 | `string` | `minutes:<id>#D<n>` |

## `engine-rollback`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--at` | 必填 | `instant` |

## `engine-update`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--from` | 必填 | `string` |
| `--sha256` | 必填 | `string` |
| `--version` | 必填 | `string` |
| `--at` | 必填 | `instant` |

## `event-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |

## `execution-evidence`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--from-file` | 必填 | `string` | `Path to JSON {handoff, hostResult}; see specs/dispatch-admission-evidence-v1.md in the engine archive. Association only, not host authentication. Exit 0: complete association; exit 1: invalid, unavailable, or unreadable input.` |

## `execution-policy-resolve`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--host` | 必填 | `string` |
| `--category` | 必填 | `string` |
| `--rejections` | 必填 | `integer` |
| `--project-budget` | 可选 | `integer` |
| `--usage` | 可选 | `json` |

## `export`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `gates-config-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--status` | 可选 | `string` |

## `gates-config-propose`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--name` | 必填 | `string` |
| `--action` | 可选 | `string` |
| `--command` | 可选 | `string` |
| `--root` | 可选 | `string` |
| `--covers` | 可选 | `list` |
| `--required` | 可选 | `boolean` |
| `--enabled` | 可选 | `boolean` |
| `--release-only` | 可选 | `boolean` |
| `--order` | 可选 | `integer` |
| `--actor` | 必填 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `gates-config-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--name` | 必填 | `string` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `gates-config-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--name` | 必填 | `string` |  |
| `--command` | 可选 | `string` |  |
| `--root` | 可选 | `string` |  |
| `--covers` | 可选 | `list` |  |
| `--required` | 可选 | `boolean` |  |
| `--enabled` | 可选 | `boolean` |  |
| `--release-only` | 可选 | `boolean` |  |
| `--order` | 可选 | `integer` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `gates-plan`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--base` | 可选 | `string` |
| `--base-by-root` | 可选 | `json` |
| `--release` | 可选 | `boolean` |
| `--work-id` | 可选 | `list` |
| `--project-id` | 可选 | `string` |

## `gates-run`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--project` | 可选 | `string` |
| `--base` | 可选 | `string` |
| `--base-by-root` | 可选 | `json` |
| `--release` | 可选 | `boolean` |
| `--work-id` | 可选 | `list` |
| `--project-id` | 可选 | `string` |

## `host-probe`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--host` | 必填 | `string` |
| `--model` | 必填 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `init`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--project-name` | 可选 | `string` |
| `--git-remote` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--cloud-hosted` | 可选 | `boolean` |

## `install-manifest`

- 可用范围：`cli`。
- 是否写入：否。

无旗标。

## `knowledge-article-create`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--host` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--path` | 必填 | `string` |
| `--category` | 必填 | `string` |
| `--title` | 必填 | `string` |
| `--summary` | 必填 | `string` |
| `--content` | 必填 | `string` |
| `--accountable-owner-id` | 必填 | `string` |
| `--evidence-ids` | 必填 | `list` |
| `--coexist` | 可选 | `boolean` |
| `--supersedes` | 可选 | `string` |
| `--language-bundle` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-article-refresh`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--host` | 可选 | `string` |
| `--expected-revision` | 必填 | `integer` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--path` | 必填 | `string` |
| `--summary` | 必填 | `string` |
| `--language-bundle` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-batch`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--host` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--from-file` | 必填 | `string` |
| `--align-first` | 可选 | `boolean` |
| `--language-bundle` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-bodies-migrate`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--segment-bytes` | 可选 | `integer` |
| `--clear-removed` | 可选 | `boolean` |
| `--at` | 可选 | `instant` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-body`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--id` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--scope` | 可选 | `string` |
| `--allow-stale` | 可选 | `boolean` |
| `--allow-trailing` | 可选 | `boolean` |

## `knowledge-capture`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--host` | 可选 | `string` | `Explicit host for configured artifact-language model policy; required by that policy, not inferred.` |
| `--at` | 必填 | `instant` |  |
| `--subject` | 必填 | `string` |  |
| `--summary` | 必填 | `string` |  |
| `--snippet` | 必填 | `string` |  |
| `--tags` | 必填 | `list` |  |
| `--accountable-owner-id` | 必填 | `string` |  |
| `--body` | 必填 | `string` |  |
| `--external-key` | 可选 | `string` |  |
| `--scope` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--role-scopes` | 可选 | `list` |  |
| `--category` | 可选 | `string` |  |
| `--kind` | 可选 | `string` |  |
| `--source-references` | 可选 | `list` |  |
| `--evidence-ids` | 可选 | `list` |  |
| `--supersedes` | 可选 | `string` |  |
| `--coexist` | 可选 | `boolean` |  |
| `--allow-trailing` | 可选 | `boolean` |  |
| `--language-bundle` | 可选 | `string` |  |
| `--timeout-ms` | 可选 | `integer` |  |

## `knowledge-checkpoint`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |

## `knowledge-create`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--host` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--external-key` | 必填 | `string` |
| `--scope` | 必填 | `string` |
| `--project-id` | 必填 | `string` |
| `--role-scopes` | 必填 | `list` |
| `--category` | 必填 | `string` |
| `--kind` | 必填 | `string` |
| `--tags` | 必填 | `list` |
| `--subject` | 必填 | `string` |
| `--summary` | 必填 | `string` |
| `--snippet` | 必填 | `string` |
| `--accountable-owner-id` | 必填 | `string` |
| `--source-references` | 必填 | `list` |
| `--source-digest` | 可选 | `string` |
| `--supersedes` | 可选 | `string` |
| `--work-ids` | 可选 | `list` |
| `--decision-ids` | 可选 | `list` |
| `--gate-ids` | 可选 | `list` |
| `--evidence-ids` | 可选 | `list` |
| `--coexist` | 可选 | `boolean` |
| `--lifecycle` | 可选 | `string` |
| `--retrieval` | 必填 | `string` |
| `--freshness` | 必填 | `string` |
| `--last-verified` | 必填 | `instant` |
| `--stale-days` | 必填 | `integer` |
| `--export` | 必填 | `string` |
| `--body` | 必填 | `string` |
| `--language-bundle` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-freshness`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--allow-trailing` | 可选 | `boolean` |

## `knowledge-init`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--acknowledge-disposable` | 可选 | `boolean` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--scope` | 可选 | `string` |
| `--selection` | 可选 | `string` |
| `--status` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--role-scope` | 可选 | `string` |
| `--category` | 可选 | `string` |
| `--kind` | 可选 | `string` |
| `--tag` | 可选 | `string` |
| `--freshness` | 可选 | `string` |
| `--search` | 可选 | `string` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |
| `--allow-trailing` | 可选 | `boolean` |

## `knowledge-rebase`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-recover`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--scope` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--reason` | 必填 | `string` |
| `--basis` | 必填 | `string` |
| `--actor` | 必填 | `string` |
| `--superseded-by` | 可选 | `string` |
| `--scope` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-reverify`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--expected-revision` | 必填 | `integer` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `knowledge-snippet`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--id` | 必填 | `string` |
| `--scope` | 可选 | `string` |
| `--allow-trailing` | 可选 | `boolean` |

## `knowledge-source-check`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--allow-trailing` | 可选 | `boolean` |

## `knowledge-validate`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `library-import-legacy`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--legacy` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--target` | 可选 | `string` |
| `--dry-run` | 可选 | `boolean` |
| `--project-name` | 可选 | `string` |
| `--git-remote` | 可选 | `string` |
| `--mapping` | 可选 | `string` |

## `library-list`

- 可用范围：`cli`。
- 是否写入：否。

无旗标。

## `library-register`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--project` | 必填 | `string` |
| `--library` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--cloud-hosted` | 可选 | `boolean` |
| `--git-remote` | 可选 | `string` |
| `--project-id` | 可选 | `string` |

## `library-resolve`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--cwd` | 可选 | `string` |

## `library-unregister`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--project` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--yes` | 可选 | `boolean` |

## `machine-settings-catalog`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--home` | 可选 | `string` |

## `machine-settings-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--at` | 必填 | `instant` |
| `--key` | 必填 | `string` |
| `--home` | 可选 | `string` |

## `machine-settings-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--at` | 必填 | `instant` |
| `--key` | 必填 | `string` |
| `--value` | 必填 | `string` |
| `--home` | 可选 | `string` |

## `minutes-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--work-id` | 可选 | `string` |
| `--status` | 可选 | `string` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |

## `minutes-record`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--project-id` | 必填 | `string` |
| `--title` | 必填 | `string` |
| `--summary` | 必填 | `string` |
| `--decisions` | 可选 | `list` |
| `--decisions-file` | 可选 | `string` |
| `--decided-by` | 可选 | `list` |
| `--work-ids` | 可选 | `list` |
| `--external-key` | 可选 | `string` |
| `--supersedes` | 可选 | `list` |
| `--withdraws` | 可选 | `list` |
| `--coexists` | 可选 | `list` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `minutes-show`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--id` | 可选 | `string` |
| `--external-key` | 可选 | `string` |
| `--status` | 可选 | `string` |

## `project-bindings-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--project-id` | 必填 | `string` |  |
| `--key` | 必填 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--actor` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `project-bindings-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--project-id` | 必填 | `string` |  |
| `--key` | 必填 | `string` |  |
| `--value` | 必填 | `json` |  |
| `--at` | 必填 | `instant` |  |
| `--actor` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `project-context`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--reference` | 必填 | `json` |

## `project-create`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--external-key` | 必填 | `string` |
| `--name` | 必填 | `string` |
| `--actor` | 可选 | `string` |
| `--parent-project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `project-delete`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `project-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |

## `project-update`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--name` | 必填 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `proposal-approve`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--key` | 必填 | `string` |
| `--proposed-at` | 必填 | `instant` |
| `--at` | 必填 | `instant` |
| `--workspace` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--actor` | 必填 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `proposal-reject`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--key` | 必填 | `string` |
| `--proposed-at` | 必填 | `instant` |
| `--at` | 必填 | `instant` |
| `--workspace` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--actor` | 必填 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `recall`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--host` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--query` | 必填 | `string` |
| `--limit` | 可选 | `integer` |
| `--tau` | 可选 | `string` |
| `--allow-trailing` | 可选 | `boolean` |
| `--status` | 可选 | `string` |
| `--project-id` | 可选 | `string` |

## `recover`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--timeout-ms` | 可选 | `integer` |

## `rule-disable`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--id` | 必填 | `string` |  |
| `--force` | 可选 | `boolean` |  |
| `--at` | 必填 | `instant` |  |
| `--project` | 可选 | `string` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `rule-enable`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--id` | 必填 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--project` | 可选 | `string` |  |
| `--order` | 可选 | `integer` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `rule-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--status` | 可选 | `string` |

## `rule-propose`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--id` | 必填 | `string` |
| `--action` | 可选 | `string` |
| `--order` | 可选 | `integer` |
| `--at` | 必填 | `instant` |
| `--workspace` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--actor` | 必填 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `rule-resolve`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--section` | 必填 | `string` |
| `--action` | 必填 | `string` |
| `--force` | 可选 | `boolean` |
| `--at` | 必填 | `instant` |
| `--project` | 可选 | `string` |
| `--actor` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `settings-catalog`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |

## `settings-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--key` | 必填 | `string` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `settings-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--key` | 必填 | `string` |  |
| `--value` | 必填 | `string` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `setup`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--mode` | 必填 | `string` |
| `--project` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--artifacts` | 可选 | `string` |
| `--cloud` | 可选 | `boolean` |
| `--restore` | 可选 | `string` |
| `--language` | 可选 | `string` |
| `--navigation` | 可选 | `boolean` |
| `--archive` | 可选 | `string` |
| `--rollback` | 可选 | `boolean` |
| `--managed-sections` | 可选 | `string` |
| `--mapping` | 可选 | `string` |
| `--yes` | 可选 | `boolean` |

## `skill-render`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--out` | 必填 | `string` |
| `--version` | 可选 | `string` |

## `snapshot-manifest`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |

## `snapshot-verify`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--root` | 必填 | `string` |
| `--manifest` | 必填 | `string` |

## `status`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `template-admit`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--template` | 必填 | `string` |
| `--owner` | 必填 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `template-validate`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--template` | 必填 | `string` |

## `validate`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |

## `variable-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |

## `variable-remove`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--name` | 必填 | `string` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `variable-set`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--name` | 必填 | `string` |  |
| `--type` | 必填 | `string` |  |
| `--value` | 必填 | `string` |  |
| `--description` | 可选 | `string` |  |
| `--order` | 可选 | `integer` |  |
| `--exports` | 可选 | `list` |  |
| `--actor` | 可选 | `string` |  |
| `--project-id` | 可选 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `vocabulary`

- 可用范围：`cli`。
- 是否写入：否。

无旗标。

## `work-annotate`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--expected-revision` | 可选 | `integer` |
| `--involved-projects` | 可选 | `json` |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--scope` | 可选 | `string` |
| `--goal` | 可选 | `string` |
| `--acceptance` | 可选 | `string` |
| `--body` | 可选 | `string` |
| `--gates` | 可选 | `list` |
| `--decided-by` | 可选 | `list` |
| `--blocked-by` | 可选 | `list` |
| `--implements` | 可选 | `list` |
| `--supersedes` | 可选 | `list` |
| `--fixes` | 可选 | `list` |
| `--decided-in` | 可选 | `list` |
| `--verify` | 可选 | `string` |
| `--result` | 可选 | `json` |
| `--sprint` | 可选 | `string` |
| `--title` | 可选 | `string` |
| `--summary` | 可选 | `string` |
| `--labels` | 可选 | `list` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `work-batch`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--from-file` | 必填 | `string` |
| `--project` | 可选 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `work-claim`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--actor` | 必填 | `string` |
| `--ttl` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `work-create`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--involved-projects` | 可选 | `json` |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--project-id` | 必填 | `string` |
| `--external-key` | 必填 | `string` |
| `--kind` | 必填 | `string` |
| `--parent-id` | 可选 | `string` |
| `--status` | 可选 | `string` |
| `--scope` | 可选 | `string` |
| `--goal` | 可选 | `string` |
| `--acceptance` | 可选 | `string` |
| `--body` | 可选 | `string` |
| `--gates` | 可选 | `list` |
| `--decided-by` | 可选 | `list` |
| `--blocked-by` | 可选 | `list` |
| `--implements` | 可选 | `list` |
| `--supersedes` | 可选 | `list` |
| `--fixes` | 可选 | `list` |
| `--decided-in` | 可选 | `list` |
| `--title` | 必填 | `string` |
| `--summary` | 可选 | `string` |
| `--labels` | 可选 | `list` |
| `--template-receipt` | 可选 | `json` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `work-delete`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `work-draft`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--kind` | 必填 | `string` |
| `--project-id` | 必填 | `string` |

## `work-gate-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--work-id` | 可选 | `string` |
| `--status` | 可选 | `string` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |

## `work-gate-release`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--id` | 必填 | `string` |  |
| `--reason` | 必填 | `string` |  |
| `--actor` | 必填 | `string` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `work-list`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--involved-project` | 可选 | `json` |
| `--workspace` | 可选 | `string` |
| `--project-id` | 可选 | `string` |
| `--kind` | 可选 | `string` |
| `--status` | 可选 | `string` |
| `--parent-id` | 可选 | `string` |
| `--sprint` | 可选 | `string` |
| `--relation` | 可选 | `string` |
| `--search` | 可选 | `string` |
| `--scope-bytes` | 可选 | `integer` |
| `--limit` | 可选 | `integer` |
| `--offset` | 可选 | `integer` |

## `work-project-context`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--id` | 必填 | `string` |  |
| `--execution-request` | 可选 | `string` | `ExecutionAdmissionRequest JSON: host, category, rejections, requestedAgents, availableCombinations, optional usage/expectedPolicy` |

## `work-release`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 | 写法 |
| --- | --- | --- | --- |
| `--workspace` | 可选 | `string` |  |
| `--at` | 必填 | `instant` |  |
| `--id` | 必填 | `string` |  |
| `--actor` | 必填 | `string` |  |
| `--force` | 可选 | `boolean` |  |
| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |
| `--timeout-ms` | 可选 | `integer` |  |

## `work-show`

- 可用范围：`cli`。
- 是否写入：否。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--id` | 可选 | `string` |
| `--external-key` | 可选 | `string` |

## `work-transition`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--at` | 必填 | `instant` |
| `--id` | 必填 | `string` |
| `--status` | 必填 | `string` |
| `--summary` | 可选 | `string` |
| `--project` | 可选 | `string` |
| `--actor` | 可选 | `string` |
| `--timeout-ms` | 可选 | `integer` |

## `workspace-relocate`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--to` | 必填 | `string` |
| `--at` | 必填 | `instant` |
| `--cloud-hosted` | 可选 | `boolean` |
| `--timeout-ms` | 可选 | `integer` |

## `workspace-relocate-discard`

- 可用范围：`cli`。
- 是否写入：是。

| 旗标 | 必填 | 取值类型 |
| --- | --- | --- |
| `--workspace` | 可选 | `string` |
| `--to` | 必填 | `string` |
| `--transaction-id` | 必填 | `string` |
