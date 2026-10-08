# 变量

变量是项目希望写进 AGENTS.md、让 Agent 读到的配置。它分两种：系统变量是引擎设置目录里的模型和设计配置键，自定义变量是项目自己起名的记录。两种都随库同步，每台合并这个库的设备读到的都一样；它们各自渲染成 AGENTS.md 里的一个受管段（受管段的规则见「受管段与 Command Spell」页）。

## 系统变量

系统变量段 `variables-system` 渲染下面的设置，其他设置永远不会出现在这里：`models.category`、`models.tiers`、`models.escalation.enabled`、`models.escalation.threshold`、`models.escalation.ceiling` 与全部 `design.*` 配套键。它们都只能经 Atelier 修改（见下文「模型写保护」）。

分类、宿主与 runner 的名字以小写字母开头，由小写字母、数字、`.`、`_`、`-` 组成，没有产品长度上限。两张表的值都按顺序从小到大完整存成规范 JSON；引用、Unicode、精确整数和密钥保护保持。

### models.category

模型分类是 `models.tiers` 的母表。规则只写分类，不写模型。每个分类是一条记录：

| 字段 | 规则 |
| --- | --- |
| `id` | 名字，全表唯一；重复报 `MODELS_CATEGORY_DUPLICATE`。 |
| `name` | 非空文本，不含控制字符。 |
| `description` | 文本，不含控制字符，可以为空。 |
| `order` | 正整数，全表唯一；重复报 `MODELS_ORDER_DUPLICATE`。顺序越小，分类越强。 |

- 默认有三个分类：`flagship`（10）、`main`（20）、`economy`（30）。名字就是 id，说明为空。
- 未设置时，档位表里引用了、默认表里却没有的分类，按名字排在默认分类后面，顺序依次加 10。所以从旧值读出的档位表，不会引用不存在的分类。
- 删除仍被档位记录引用的分类会被拒绝，报 `MODELS_CATEGORY_IN_USE`，并列出引用它的记录（写作 `models.tiers.<order>`）。
- 升档上限 `models.escalation.ceiling` 指向的分类（未设置时是默认值 `main`）同样不能删除，也报 `MODELS_CATEGORY_IN_USE`，`details.references` 列出 `models.escalation.ceiling`；放回默认分类表时若会去掉这个分类，同样被拒。

### models.tiers

模型档位是一张记录表，记录可以随意增删。每条记录：

| 字段 | 规则 |
| --- | --- |
| `order` | 正整数，全表唯一；重复报 `MODELS_ORDER_DUPLICATE`。顺序越小，记录越强，升档就是往更小的顺序走。 |
| `category` | 所属分类，必须是 `models.category` 里已有的分类，否则报 `MODELS_CATEGORY_UNKNOWN`。 |
| `runner` | 执行这条记录的程序：宿主自己，或另一个程序（例如 `codex-cli`）。 |
| `model` | 模型，文本。引擎不内置任何模型名，默认表里留空，由 Owner 填写。 |
| `effort` | 推理强度，文本，默认留空。 |
| `note` | 备注，文本，可以为空。 |

规则指定一个分类，拿到的是这个分类里顺序最大的那条记录，叫基础记录，不管它的 runner 是谁。下面的例子里，经济档由 `codex-cli` 执行：

```json
[
  { "order": 10, "category": "flagship", "runner": "claude-code", "model": "", "effort": "", "note": "" },
  { "order": 20, "category": "main", "runner": "claude-code", "model": "", "effort": "", "note": "" },
  { "order": 30, "category": "economy", "runner": "codex-cli", "model": "", "effort": "", "note": "" }
]
```

- 默认表是两个宿主 `claude-code`、`codex` 与三个默认分类的组合，每条的 runner 就是它的宿主，`model`、`effort` 与 `note` 为空。
- 默认表的编号从 10 起，每次加 10，按分类依次编号；同一分类内两个宿主交错，名字排在前面的宿主拿到较大的顺序。结果是：10 flagship 的 codex、20 flagship 的 claude-code、30 main 的 codex、40 main 的 claude-code、50 economy 的 codex、60 economy 的 claude-code。
- 旧值照常读出，事件的字节不变：
  - 旧形状 `{宿主: {档名: {runner, model, effort}}}`，以及改名前的 `execution.dispatchTiers`（每一行以它所在的宿主作为 runner），都按上面的编号读成记录，档名就是分类。
  - 新的写入只接受记录数组。

### 升档：models.escalation.*

三个键决定一条规则的记录怎样沿档位表的顺序升档：

| 键 | 取值 | 默认 |
| --- | --- | --- |
| `models.escalation.enabled` | `true` 或 `false` | `true` |
| `models.escalation.threshold` | 正的安全整数 | `1` |
| `models.escalation.ceiling` | `models.category` 里已有的分类 id | `main` |

- **怎么升**：从规则所指分类的基础记录出发，每累计 `threshold` 次退回，就升一条，换成全表里顺序更小的下一条记录。可以跨分类，也可以换 runner。
- **升到哪里为止**：升到上限分类里顺序最小的那条记录为止，之后再被退回也不再升。基础记录本来就在上限之上时，原地不动。
- **关闭时**：`enabled` 为 `false` 时一律用基础记录，也不读上限。
- **退回次数谁来记**：由调用方自己记，调用时传入，例如实施主线程的升档台账。引擎不存计数，也没有解析升档的命令。
  - 核心导出纯函数 `resolveModelsTier`，返回选中的记录、升了几步，以及是否停在上限。
  - 停在上限之后再被退回怎么办，是调用方的流程。
- **不按 runner 过滤**：所以一步可能落到另一个 runner 的记录上。
  - 以默认表为例：从经济档的基础记录（60，`claude-code`）升一步到 50（`codex`），再一步到 40（main，`claude-code`），第三步到 30（main，`codex`），也就是默认上限。
  - 只用一个宿主的库，在档位页只保留这个宿主的记录即可，升档的走法不变。
- **写上限的检查**：写入 `models.escalation.ceiling` 时，分类表里没有这个分类就拒绝，报 `MODELS_CATEGORY_UNKNOWN`。分类表里没有 `main` 时删除这个键（等于放回默认值 `main`），同样拒绝。

### design.authority

当前项目或子项目奉为权威的设计系统，以该系统公开契约的 HTTPS URL 表示。
同一配置中的 `design.repository`、`design.pullRequestTarget`、`design.productionDocs`、
`design.buildService`、`design.buildProject` 和 `design.consumedVersion` 声明仓库、PR 目标、
生产文档、构建服务/项目和实际消费版本。每个键显示声明位置和明确父项目的继承来源；
缺项是未配置，换权威却继承其它权威的配套项是冲突。离线引擎不把声明或网页可访问
当作发布成功；真实 PR、生产发布和构建证据由已获授权的执行者核对。

各键和自定义变量按稳定项目身份读写。移除本项目覆盖后才继承明确的父项目或库默认；
改名不改绑定。登记表中的真实目录没有稳定项目绑定时不猜测 AGENTS 输出目标。
`design-authority` v1 可从系统预设显式启用；中文和英文正文不写死任何项目值。

### 在 AGENTS.md 里的样子

系统变量段按上面的次序分四个小节：

- `models.category`：Order、Id、Name、Description 四列，按顺序排列；
- `models.tiers`：Order、Category、Runner、Model、Effort、Note 六列，按顺序排列；
- `models.escalation`：Setting、Value 两列，列出三个键的当前值；
- `design`：七个键的有效值、源项目和继承状态；未设置项写 `(unset)`。

前三个小节的表格前各有一行说明：分类与档位的那一行说明顺序的含义，升档的那一行说明怎样升档。空的模型或推理强度写作 `(unset)`，空的说明或备注留空。

分类的名字或说明、档位的模型、推理强度或备注，形如密钥或含绝对路径时，这一行照写，但这几格写作 `(withheld)`，并在回执的 `withheld` 里列出原因。分类记作 `models.category.<id>`，档位记作 `models.tiers.<order>`。

段里从不写绝对路径。只有三处摘要一致时才替换这一段；你改过的段转为待处理，不会被覆盖。

## 自定义变量

自定义变量是库里 `variable` 集合的一条记录，键就是变量名：

| 字段 | 规则 |
| --- | --- |
| 名字 | 小写字母开头，由字母、数字、`.`、`_`、`-` 组成，文本；不能与设置目录里的键重名。 |
| 类型 | `string`、`number` 或 `boolean`。 |
| 值 | 始终按文本存储，完整文本，不含控制字符。`number` 的值是十进制数（可带负号和小数部分），`boolean` 的值是 `true` 或 `false`。 |
| 说明 | 可选，文本，不含控制字符。 |
| 顺序 | 可选，正整数，决定这个变量在自定义变量段里的位置（TCRN-CROSS-STORY-508 R7）。 |

自定义变量段 `variables-custom` 渲染成 Name、Type、Value、Description 四列的表，一行一个变量：

- 有顺序的变量排在前面，按顺序从小到大；没有顺序的排在后面，按名字排序；顺序相同的几个之间也按名字。
- 顺序不单独成列。没有任何变量带顺序时，行序与从前一样，按名字。
- 改顺序会改变这一段的正文，所以和改值一样，只在三处摘要一致时才替换。你改过的段不会因为重排被覆盖，而是转为待处理。

### 命令

- `variable-list [--workspace <库>]`：回执 `VARIABLE_LIST_READY`，给出全部变量（按名字排序，带顺序的变量带 `order`），以及自定义段略去的行（`withheld`，每项 `{name, reason}`）。
- `variable-set --name <名字> --type <类型> --value <值> [--description <说明>] [--order <正整数>] --at <时刻>`：写入一个变量，回执 `VARIABLE_WRITE_COMMITTED`。
  - 它写入整条记录：不带 `--order` 时这个变量没有顺序，正如不带 `--description` 时说明为空。
  - `--order` 不是正整数时报 `CLI_ARGUMENT_MALFORMED`，库里不留任何记录。
- `variable-remove --name <名字> --at <时刻>`：删除一个变量；删除不存在的变量报 `CONFIG_RECORD_NOT_FOUND`。

省略 `--workspace` 时，命令作用于本机注册表从当前目录解析出的库。写变量不会顺带改 AGENTS.md；要把变量渲染进去，运行 `agents-render`。

## 密钥拒写

AGENTS.md 会随项目提交，所以变量里永远不放凭据。值或说明形如凭据时，`variable-set` 报 `VARIABLE_SECRET_SHAPED`，指出是哪个字段、匹配到了什么，库里不留任何记录。判定依据：

- 已知的密钥前缀：`sk-`、`AKIA`、`ASIA`、`ghp_`、`gho_`、`github_pat_`、`xoxb-`、`xoxp-`；
- PEM 私钥头（`-----BEGIN ... PRIVATE KEY-----`）；
- JSON Web Token；
- 32 个字符以上、读起来像随机串的令牌（32 位以上的十六进制串，或字母数字混排、熵接近随机字节的串）。

渲染时再查一遍：库里已有的某行若含绝对路径或形如凭据（例如在更严格的判定之前写入的记录），这一行从段里略去并报告原因（`absolute-path` 或 `secret-shaped`），段里其他内容照常写入。

## 模型写保护

配置由人在 Atelier 里改，模型不在工作途中顺手改它。设置目录的每一行都带 `modelWritable`，目前全部为 `false`。下面这些写入在环境变量 `EINZBERN_SURFACE` 不为 `atelier` 时一律拒绝，报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier`，库里不追加任何事件：

- 对 `modelWritable` 为 `false` 的键执行 `settings-set` 与 `settings-remove`；
- `variable-set` 与 `variable-remove`；
- Command Spell 原则的 `rule-enable` 与 `rule-disable`（「受管段与 Command Spell」页）；
- 门声明的 `gates-config-set` 与 `gates-config-remove`（「门」页）。

拒绝点名被拒的对象：details 里设置是 `key`，变量是 `name`，原则是 `rule`（原则 id），门是 `gate`（门名），并带 `remedy`；命令行入口在 stderr 上给出 `remedy` 和点名该对象的错误文本。

在 Atelier 里改，或以 `EINZBERN_SURFACE=atelier` 运行同一条命令，写入照常进行；Atelier 调用 CLI 时就带着它。这是约定，不是身份保证：CLI 无法分辨是谁在运行它，自己带上这个变量的调用同样放行，所以这道软屏障挡住的是模型顺手的改动，不是蓄意绕过。读取从不拒绝，`rule-resolve`、`agents-render`、`gates-plan` 与 `gates-run` 也不受这道屏障限制；引擎对任何人都拒绝的键（`SETTINGS_KEY_DEVICE_LEVEL`、`SETTINGS_KEY_UNREGISTERED`）保持各自的拒绝码。

## Configuration sources

Effective values name the concrete project, declared ancestor, explicit common
default or built-in default. Device/user values remain separate. Cross Project
is never an implicit development fallback. A common source is deliberately
bound through `project-bindings-set`, not inferred from where a work item lives.
