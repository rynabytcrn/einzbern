# Atelier 工作台

Atelier 是项目配置工作台。进入页面后，先核对当前项目与知识库，再查看状态、规则、变量和门配置。页面中的配置来自引擎管理的项目记录；需要更改时使用 Atelier 或引擎支持的配置入口，不要直接改写 `.ether` 控制文件。

## 状态

状态页用于核对当前引擎、项目与已选知识库。链上工作记录的状态仍以引擎只读结果为准，例如 `status`、`work-list` 和 `work-show`；页面显示不能代替对具体 Story 的读取。

## 规则

规则页管理 Command Spell。内置规则及版本为：

| 规则 | 版本 | 初始状态 |
| --- | --- | --- |
| `autonomy` | `v1` | `disabled` |
| `batch` | `v2` | `disabled` |
| `unattended-commands` | `v1` | `disabled` |
| `silent-reporting` | `v1` | `disabled` |

规则状态包括 `disabled`、`enabled`、`user-modified`、`removed-from-file`、`update-available` 和 `pending`。启用前先阅读规则正文；规则本身不会授权更改已批准的工作步骤。

## 变量

变量页显示系统变量和自定义变量。`models.tiers` 按宿主与档位记录 `{runner, model, effort}`；默认档位为 `flagship`、`main`、`economy`。`design.authority` 是另一个系统变量。自定义变量记录类型、值和说明。系统变量只能经 Atelier 修改；密钥形态的值会以 `VARIABLE_SECRET_SHAPED` 拒绝。

## 门

门记录由命令 argv、项目内根目录、覆盖文件模式、是否必需、是否启用以及是否仅发布时运行组成。计划门时，引擎按各根目录的 Git 变更与覆盖模式求交；发布计划会列出所有启用的门。运行会收集所有结果。Story 没有门声明时可继续；有必需门时，当前树摘要下还没有运行记录会拒绝完成，必需门失败也会拒绝完成。

## 切换知识库

使用项目的知识库选择器切换到已登记的库。切换只更改项目当前绑定；不会搬动、合并或复制库数据。切换前核对目标库身份，切换后再从状态页确认选中的项目与库。不要通过复制或手改 `.ether` 文件来切换。
