# 变量

变量是项目希望写进 AGENTS.md、让 Agent 读到的配置。它分两种：系统变量是引擎设置目录里的两个键，自定义变量是项目自己起名的记录。两种都随库同步，每台合并这个库的设备读到的都一样；它们各自渲染成 AGENTS.md 里的一个受管段（受管段的规则见「受管段与 Command Spell」页）。

## 系统变量

系统变量段 `variables-system` 只渲染两个设置，其他设置永远不会出现在这里。

### models.tiers

每个宿主一张档位表，每一档写明三件事。下面的例子把 `claude-code` 的经济档交给 `codex-cli` 执行：

```json
{
  "claude-code": {
    "flagship": { "runner": "claude-code", "model": "", "effort": "" },
    "main": { "runner": "claude-code", "model": "", "effort": "" },
    "economy": { "runner": "codex-cli", "model": "", "effort": "" }
  }
}
```

- `runner` 是执行这一档的程序：宿主自己，或另一个程序（例如 `codex-cli`），所以一个宿主的经济档可以交给别的程序跑。
- `model` 与 `effort` 是这一档用的模型和推理强度。引擎不内置任何模型名，默认档的这两项留空，由 Owner 填写。
- 默认宿主是 `claude-code` 与 `codex`，默认档位是 `flagship`、`main`、`economy`；默认表里每一档的 runner 就是它所在的宿主，`model` 与 `effort` 为空。档位可以增删，档位名只是数据，引擎只记录、不解释。宿主、档位与 runner 的名字以小写字母开头，由小写字母、数字、`.`、`_`、`-` 组成，最多 64 个字符。
- 旧设置 `execution.dispatchTiers` 已改名为 `models.tiers`。库里记过的旧值照常读出：每一行以它所在的宿主作为 runner，直到一次 `models.tiers` 写入取代它。

在 AGENTS.md 里它渲染成 Host、Tier、Runner、Model、Effort 五列的表。空的模型或推理强度写作 `(unset)`；形如密钥或含绝对路径的，写作 `(withheld)`，并在回执的 `withheld` 里列出原因。

### design.authority

项目奉为权威的设计系统，以该设计系统自身文档的 URL 表示。可以不设。它只是声明：引擎从不访问这个地址，也不检查地址背后是什么。未设置时段里写 `(unset)`。

## 自定义变量

自定义变量是库里 `variable` 集合的一条记录，键就是变量名：

| 字段 | 规则 |
| --- | --- |
| 名字 | 小写字母开头，由字母、数字、`.`、`_`、`-` 组成，最多 64 个字符；不能与设置目录里的键重名。 |
| 类型 | `string`、`number` 或 `boolean`。 |
| 值 | 始终按文本存储，最多 1024 个字符，不含控制字符。`number` 的值是十进制数（可带负号和小数部分），`boolean` 的值是 `true` 或 `false`。 |
| 说明 | 可选，最多 512 个字符，不含控制字符。 |
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

配置由人在 Atelier 里改，模型不在工作途中顺手改它。设置目录的每一行都带 `modelWritable`，目前全部为 `false`。下面这些写入在环境变量 `EINZBERN_SURFACE` 不为 `atelier` 时一律拒绝，报 `MODEL_WRITE_REFUSED`，补救提示为 `change it in Atelier`：

- 对 `modelWritable` 为 `false` 的键执行 `settings-set` 与 `settings-remove`；
- `variable-set` 与 `variable-remove`。

Atelier 调用 CLI 时带着 `EINZBERN_SURFACE=atelier`，因此放行。CLI 无法分辨是谁在运行它，所以这是一道软屏障：它挡住的是顺手的改动，不是蓄意绕过。读取从不拒绝；引擎对任何人都拒绝的键（`SETTINGS_KEY_DEVICE_LEVEL`、`SETTINGS_KEY_UNREGISTERED`）保持各自的拒绝码。
