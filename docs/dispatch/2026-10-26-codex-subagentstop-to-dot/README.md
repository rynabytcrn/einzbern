# INIT076：未验收的 Codex SubagentStop 候选交接给 Dot

Owner 于 2026-10-26 要求：“不继续了，先推送到github，由dot继续完成”。本分支用于保全现有引擎改动和交接；不是验收通过或合入 main 的声明。当前授权见 TCRN-CROSS-MIN-387 D1，原功能范围见 MIN-384 D1、MIN-385 D2–D3、MIN-386 D1。

## Dot 可直接使用的接续提示

请从 `codex/subagentstop-dot-handoff` 接续 INIT076，先读本文件及同目录 `state.json`。功能源码提交为 `03f62af259ceb4072c9cf8dd82d0933228ed280a`，其父为已发布的 `f5ad507d65e52ef21e3fb275e32d05d8d01b4a5e`。分支之后的提交只保全交接说明，不代表功能已验证。

独立加载适用 AGENTS 与 Mana Orchestrate，运行 recall，读取实时 status、完整 work-list 和相关 work-show；原生身份见 state.json。共享库若不可访问，明确记录该缺口，不手写控制树、不杜撰项目绑定或完成状态。当前工单仍未完成，Owner 已停止本地实施和验收，剩余工作交给 Dot。

目标保持完整：Codex 正常安装/更新产出并注册正式 SubagentStop hook；最小收集协议与异常退出通过适用回归；实际宿主触发、未完成时继续同一收集任务、仅一次事实回传、空闲父对话接续有直接证据；独立验收、原生读回与资源收尾完成。或：阻塞于只有 Owner 能做的决定，且阻点已经说明。

Dot 是接续执行方，产品目标仍然**只限 Codex**。此次不为 Dot、Claude Code 或 DSH 增加这个 hook。保持既定包、模型职责和验证节奏；不要复用已结束代理，不在父对话中活动轮询，不额外增加管理服务或唤醒 daemon。

## 已有源码与未完成项

- Codex 专属 event 注册与正常 setup fresh/update/repair 路由已写入源码，未执行正常安装回归。
- `packages/core/src/codex-subagent-stop.ts` 提供 manifest 构造、真实 event 的首次 ID 绑定、固定 snapshot 判断、有界异常及单次回传状态处理。
- `scripts/einzbern-hook.mjs` 接入该 evaluator；协议和限制在 `specs/engine-hook-events-v2.md`。
- 新协议测试及安装、宿主隔离、打包相关回归已编写。**测试、开发门、独立验收均未运行。**
- E1 源码提交前只有 `git diff --check` 通过。候选依赖曾在隔离工作树以 offline/frozen/ignore-scripts 准备；没有完整项目 build 或 gate invocation。
- 请先按当前配置准备一次批末适用门，并逐项对照原要求、实际行为和断言做独立验收。红项按整批收集后处置，不逐红修复/重跑；本文件不预判源码可用。

## 当前设备事实，不能扩大为通过

本机 user-level hook 已注册，官方内置 CLI `0.164.0-alpha.11.1` 的审核曾显示 Trusted、Installed 1 / Active 1。PATH 上的 CLI `0.156.1` 是另一份，不能代表原 Desktop 实际路径。

最初接线是只记录标记并返回 `{}` 的 observer。一个注册前创建的分析任务及一个注册后创建的 E1 业务任务正常结束，均未留下预期的标记 callback；原因仍 unknown，不能据此认定正常安装路径不可行。

在 Owner 后来要求继续的短暂准备中，root 把本机独立 wrapper 接到了此候选源码转译出的 core sidecar。它只通过无关联输入的合成加载检查；之后尚未派出新的验收任务或收集者，就收到了停止并交接的指令。**最新 wrapper 不能继续描述为“只有 observer”，也不能描述为“已在宿主验证可用”。** 完整引擎和 live Skill 没有安装更新，独立 sidecar 与正常打包产物的字节一致性未声明。

原两批收集者分别是 timeout 和 completed；completed 只证明 E1 原生终态与交付位置被收回，没有证明 hook continuation、单次 send ack 或父对话唤醒。原父对话始终维持活动回合的那段观察**不是有效的父空闲试验**。后来 loop 已停止，收集者也全部结束，没有后台任务会因此自动回传。

## 实际宿主验证必须保留的边界

1. 固定本批真实 task ID，使用全新经济收集者；普通业务代理交付后静默结束。
2. 父先写 manifest；nonce 只作关联，不是认证。首次匹配 stop 从真实 payload 保存 session/agent ID，后续只能继续同一尚未结束的收集任务，不猜原始 ID，不恢复已结束代理。
3. 收集者用实际暴露的原生工具查询；shell 只消费其快照，不读私有会话库、transcript 或未公开格式，不假装能调用 collaboration。
4. 未收齐且预算内，必须实际观察到同步 block、同一任务续跑、合理间隔和明确截止。失败、确认取消与成功分别保留；unknown 不是终态。
5. 单次回传先留 in-flight，再保存实际工具返回/ack；unknown 不盲目重发。发送与本地 ack 落盘不原子，不能宣称严格 exactly-once 已证明。
6. 截止、查询失败、用户取消、脚本/协议异常要有各自有界退出，不无限 Stop/block。
7. 父完成编排后要真正结束活动回合，不能用等待脚本、自动 goal 或反复状态查询维持它。只有“子任务/收集者仍在运行、父已空闲”的实际试验才覆盖要求。
8. 原生 `collaboration.send_message` 的工具说明不承诺启动新回合。曾记录过 app-native 父消息接口作为候选能力，但从未调用或验证；请按实际可用工具和既有授权判断，不能把“发送成功”代替父真的开始新回合。
9. 配置、schema 枚举、Trusted/Active、单元模拟和终态查询，均不得替代这四项真实行为证据。无法建立时报告具体缺口和 Owner 决策边界，不偷偷缩小验收范围。

官方语义参考：[Codex hooks](https://learn.chatgpt.com/docs/hooks)。同步 continuation 与后台 informational output 的行为不同，实际 Desktop 工具路径必须另证。

## 门、基线和原生工单

当前门配置需要独立现读。既有配置的两个 root 是 `TCRN Platform/einzbern` 与 `TCRN Platform/mana-orchestrate`；两者 realpath 都必须落在真实的隔离容器中。不要将裸 engine checkout 当容器，不修改治理配置来凑路径，不去测试旧的本机源码树。

engine base 为 `f5ad507d65e52ef21e3fb275e32d05d8d01b4a5e`，Helper base 为 `0a201cb83ece2d73be3e03d708a11550bc9fdbd4`。Helper 本轮没有源码修改，不在本次推送范围。用当前 commands 核对 `gates-plan/gates-run` 的 project、base-by-root、work-id 旗标和真实覆盖，不加 release 旗标，不杜撰工单 ID。

工作项均在 state.json：INIT076、EPIC175、STORY609/610/611、SUB653–657。原生协调任务保留 targets=[]，不伪造应用开发绑定。机器通过、源码/行为验收与 Owner 目视/发布授权分别记录；未满足时不转 done。

## 已完成的旧 CI 观测

已发布父提交 f5ad507d 的既有 [run 40222231539](https://github.com/tpmoonchefryan/einzbern/actions/runs/40222231539)，attempt 1 已 success，从开始到最后一个 job 为 969 秒。其真实 plan coverage=full，原因包括 CI/planner/gates/release 路径和 structural-change:A；这不证明选跑逻辑未启用。

这份结果只覆盖旧提交。原 INIT075 的 11/11 开发门和独立验收也只属于旧候选，不得挪作当前 hook 候选的验收；不用为了确认旧读数重跑它们。对本交接 HEAD，如存在自动 CI，先核对精确 SHA 的实际运行再决定后续，不重复触发。

## 保留与交接限制

当前所有既有子代理均已确认终态；没有复用它们，没有安排后台接续。源码/Helper 工作树及正式本机证据作为未完成交付输入保留。旧 INIT075 冻结候选另行保留，不属于本轮可清理范围。

分析产生的可重建公共 schema 共 8,788,793 逻辑字节已移入该分析任务 scratch/trash，未物理删除，也没有释放空间声明。两个空配置审核 CLI 会话已退出，官方归档尝试失败，未手写私有会话数据。本机独立 hook 仍消费其 wrapper、sidecar 和 scratch device 路径，未满足引用关系时不得移动或删除这些输入。

本机原始日志、完整 hook 配置、trust 元数据、个人设备路径和控制树不进入本 GitHub 交接。Dot 若不能访问本机证据，只能把相应真实宿主项记为不可验证，不能以该缺口伪造通过。按现有权限经引擎写原生进展并读回；真实设备写入、main 合并、tag、Release 或新发布仍需各自适用授权。
