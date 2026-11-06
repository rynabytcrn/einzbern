# batch-execution-v1

Load only when the corresponding principle is enabled and this task needs its procedures. Existing task authorization and approved methods remain authoritative; this reference adds no agents, stages or permissions to an ordinary task.


## Batch Processing Principle v3

This governs approved decomposition, implementation, gates, testing, acceptance, chain writes, reporting and dispatch. It does not automatically add an INIT, agents or acceptance stages to ordinary tasks. Follow the current Owner decision on methods, roles, order, gates and criteria. Before changing an approved method, explain the difference, evidence, benefits, costs and risks and obtain the corresponding approval; unknown benefits remain unknown.

1. The unit of a batch. All open Stories under one INIT form one batch. One subagent performs decomposition, and each Subtask identifies changed files and dependencies. New work outside the batch scope goes on the problem list for the next batch; correcting an implementer's own changes to deliver the original package remains part of that implementation.
2. Packages and local self-checks. Group dependent Subtasks or changes to the same files into one sequential package; independent packages run concurrently. Assign one subagent per package in its own worktree and branch. Select its category through current task routing and host policy; clearly scoped local execution defaults to economy. Respect execution.maxConcurrentSubagents, device limits and actual host capacity. Before delivery, the implementer runs the smallest compilation, type check or tests directly relevant to the changes, fixes confirmed issues within the package, and supplies commands, results and unverified items. Do not repeatedly run full gates for local edits or take over independent acceptance or chain writes. Retire delivered packages; integrate all completed packages in dependency order and assign conflicts to one integration subagent.
3. Aggregate formal acceptance findings. At batch end, collect executable gate and independent acceptance results and issues before intervening. Do not interrupt, repair, rerun or open work items for individual red results; group one root cause as one issue. After integrating all implementation packages, complete the approved formal gates and independent acceptance once, address findings together, then rerun only affected or still-unexecuted required checks. Handle safety refusals and hard blockers immediately. This aggregation does not prohibit implementer self-checks and repairs under clause 2.
4. Generate according to purpose. Generate formal coverage baselines, proof artifacts and hook renderings once at batch end, not after each edit. Temporary output needed for local compilation or testing may be generated during implementation and reclaimed under residue cleanup. If aggregate fixes invalidate formal output, regenerate only affected output. Raising budgets, rewriting baselines or changing thresholds still requires the corresponding approval; regeneration is no substitute.
5. One chain write and report per batch. Aggregate transitions and annotations through the batch entry and read them back. Group decisions needed from the Owner with recommendations. Make nonblocking choices first only when they are within existing authorization and delegated discretion, and report them at closure. A nonblocking action still needing approval is not executed first; necessary communication follows the silent-reporting exceptions.
6. Dispatch by stage. Use one agent for decomposition, one per implementation package and one for integration; independent acceptance may be split by approved Epic impact. Do not dispatch agents for individual steps, confirming readings or mechanical summaries. Apply the small-round condition first: no more than 2 implementation packages or only one acceptance slice means one main-tier agent performs acceptance and judgment together, retaining the acceptance, judgment and lessons files. If another round is actually needed, include its decomposition without a separate agent. Split acceptance with separate judgment and decomposition only when the small-round condition does not apply and two or more slices are needed; an explicitly approved different role allocation remains authoritative. With no implementation package and only chain writes or documentation, the main thread performs the work and one main-tier agent reads back and judges, without decomposition or acceptance agents. Independent reviewers do not accept their own implementation.
7. Continue for substantive progress. Findings and queued work feed the next round. The responsible role continues authorized work that can advance until the goal is reached or all remaining work is blocked. Codex peers follow the stage handoff and next-batch authorization below, without idle polling by main. For the same issue, stop repeating an action after two consecutive analyses or rechecks yield no new evidence. Choose a check that distinguishes causes, or present the specific difference, actual impact and disposition choices requiring an Owner decision. Changing agents, rounds or models does not reset this history. New checks stay within approved methods and permissions; other actionable work continues. End when required acceptance is satisfied and there are no substantive findings; do not manufacture issues to start another round.
8. Capture knowledge per round. The judgment agent produces lessons.json beside its report, with subject, summary, snippet, body, tags and source evidence references (stable project identity plus repository-relative path). Capture at most 5 newly established facts or lessons; an empty list is valid. In the same round's chain write, main uses knowledge-capture and reads back the result. Record budget refusals and their actual release conditions rather than assuming migration is the only remedy. Do not depend on Stop-hook markers or repeatedly capture the same conclusion.
9. Read evidence as needed. Governance agents and main start with dispatched excerpts, sections or line ranges while preserving complete requirements and context needed for judgment. Save tool output as evidence and use tools to extract identity, hashes, counts, mappings and differences; main-tier work addresses behavior, contracts and disputed conclusions. Read no more than 200 lines at a time and do not read files over 32 KB whole. Retrieve relevant segments within actual host limits. Fill evidence gaps from relevant sources without repeatedly restating the full history.

### Acceptance evidence and recheck scope

1. For runnable questions, first choose the smallest empirical check that can change the judgment, then expand only as its result warrants. Record actual inputs, commands, output, exit status and candidate version. Static proof needs a definite trigger and contract basis. Distinguish observed failures, static proof and untested hypotheses. Missing environment or permission remains explicitly unverified with a reason; inference cannot manufacture a pass or failure. Check test assertions against current requirements too. Passing tests does not replace Owner visual acceptance or publication authorization.
2. A blocking finding needs current behavior, an explicit contract or a credible security boundary, with its trigger and impact. Style preferences, unsupported future extensions and speculative defenses do not automatically require rework; no substantive findings is a valid outcome. Do not silently relax an existing criterion because its measured impact is small; present the difference and options to the authorized decision-maker.
3. Before rechecking, identify which changes invalidate which evidence. Reuse locatable successful execution evidence when the source, dependencies, environment, parameters, inputs and baseline relevant to that check are equivalent. Deduplicate parent and child gates from actual execution records: a script naming a child does not prove it ran, and early-failure skips remain not run. A successful child within a parent can satisfy the same check without a separate rerun, but cannot turn a failed parent into a pass. When equivalence is unproved, evidence is missing or relevant inputs changed, run the affected required checks.
4. Independent review focuses on this round's changes, failures and affected behavior, citing still-valid conclusions. Required complete validation, final integration, release and security checks follow the current contract. Reuse cannot delete gates, change criteria, reorder dependencies or conceal checks not run. Use existing tools for mechanical checks without adding review layers, agents or proof frameworks.

### Agent communication and waiting

1. Subagents deliver complete packages. Report ordinary progress, stage summaries and deferrable issues together when the package is complete. When the host already sends a completion notification, do not repeat the same result through send_message. Include this constraint when dispatching subagents.
2. Limit communication during a package to necessary exceptions. Immediately report safety issues, hard blockers that prevent further work, and dependencies or conflicts that would block other agents without immediate coordination. Keep the factual clarification needed to resolve these issues; necessary communication remains allowed.
3. The main agent reduces round trips. Do not reply with pure acknowledgments or ask for ordinary progress. Act directly on information that needs a decision or action. Ordinary status messages do not trigger extra queries of every agent's status or repeated reports.
4. Avoid empty polling while waiting. Use completion notifications and blocking waits supported by the host. Lengthen query intervals when there is repeatedly no new state, respect the host's wait limit and user interruption requirements, and continue independent work when it is available.

### Codex independent peer-conversation contract (not other hosts or dot)

Only explicitly selected Codex multi-subagent orchestration uses an independent main-category decision conversation and economy-category coordinator conversation, not a parent/collector pair. The main conversation owns batch goals, stage boundaries, judgment and next-batch authorization. The economy coordinator directly dispatches fresh workers according to task categories and existing rejection-escalation thresholds, waits for them and reads their native results. Workers do not proactively message their parent; retain native final and use supported result/interruption paths for safety and hard blockers. The coordinator is not a read-only collector and dispatches no collector. Claude Code and DSH retain single-conversation coordination and native completion notifications; dot policy is unchanged.

Roles use main, economy and optional flagship categories, never concrete model bindings. Installation guidance offers all three stable categories. This mode requires usable main and economy model groups in the selected device-host policy; the flagship model group may remain unconfigured. Empty groups are neither usable models nor escalation ceilings. Never invent a model, effort, decision provenance or host support. Update/repair supplements missing defaults idempotently while preserving user models, custom categories and other hosts. Resolve the actual policy revision and retain dispatch receipts.

Before dispatch, fix batchId, application attempt, both independent conversation identities and member scope. Bind each worker's agentId, package and attempt from actual dispatch receipts, not names, markers, self-reports or local files posing as native authority. Worker concurrency obeys execution.maxConcurrentSubagents, device/project limits and actual hard host capacity. There is no collector cap exemption or reserved collector slot. Reduce concurrency or split stages when capacity is insufficient; never bypass the limit.

After handing off a stage, the main conversation stops idle polling and must not use /goal or /loop to actively wait. The economy coordinator directly reads fixed members using supported bounded waits, respecting intervals, deadline, query-failure limits, budget and user interruption. Preserve failed, cancelled_confirmed and unknown outcomes. Stale, future, wrong-batch/wrong-attempt or drifted observations and query failures do not establish completion. No dedicated collector subagent, SubagentStop keepalive, collector-wait helper or old collection fallback remains. Retire old engine-owned hooks only after ownership verification; preserve user edits and unrelated hooks.

Deduplicate within the exact batch/attempt and hand back one batch report after all members have confirmed terminal outcomes; failure is not success. Interruption, deadline, permission, safety, exhausted budget and no-progress exceptions retain outstanding ownership. On recovery reconcile existing dispatch, native state and delivery receipts first: unknown is investigated, not duplicate dispatch, replay of confirmed delivery or revival of ended workers. Retain late results without advancing another attempt. Unknown delivery permits neither blind resend nor the next batch. Missing capability stops only the dependent path, with no collector fallback.

Record source/automated regression separately from native-host acceptance. The current Owner decision defines the testing scope and acceptance responsibility; documentation and fixtures do not prove native acceptance of a candidate. No daemon, private session database or invented RPC is introduced. Preserve existing user goals, automations and legitimate M governance rounds with substantive work.

## 批量处理原则 v3

适用于已获批的拆分、实施、跑门、测试、验收、链写、汇报与派工。批量原则不为普通任务自动新增 INIT、代理或验收阶段；具体执行方法、角色、顺序、门与判据遵循当前 Owner 决定。需要改变已批准方法时，说明差异、依据、收益、成本与风险并取得相应批准；未知收益保持未知。

1. 批的单位。一个 INIT 下全部待办 Story 是一批。拆分由一个子代理一次做完，每张 Subtask 写明改动文件与依赖。批内发现的范围外新工作记入本批问题清单，进下一批；实施者为交付原包而修正自身改动，属于原包实施。
2. 实施分包与局部自测。有依赖或改同一批文件的 Subtask 进同一包，包内顺序执行；互不影响的包并行。每包一个子代理，在自己的工作树与分支上做；类别按当前任务分档和宿主策略选择，范围明确的局部执行默认经济档。并发遵守 execution.maxConcurrentSubagents、设备限制与宿主实际容量。实施者交付前运行与改动直接相关的最小编译、类型检查或测试，修复原包内已确认的问题，并交付命令、结果及未验证项；不为局部修改反复跑全量门，也不承担独立验收或链写。包交付后退役；全部包完成后按依赖顺序合并，冲突交一个集成子代理。
3. 正式验收集中处置。批末门与独立验收先收齐本批可执行的检查结果和问题，不逐红中断、修补、重跑或开单；同一根因合并一项。全部实施包合并后，按已批准范围完成一次正式门和独立验收，问题集中处置后只复跑受影响或尚未执行的必需检查。安全拒绝和阻断后续工作的硬阻塞立即处理。此处的集中处置不禁止第 2 条的实施者局部自测与修复。
4. 生成物按用途处理。正式覆盖基线、证明物、钩子渲染等在批末各生成一次，不随每条修改重做；局部编译或测试必需的临时产物可在实施期间生成，随后按残余收尾原则回收。集中修复确实使正式产物失效时，只再生受影响产物。预算抬线、基线改写和阈值变化仍须有对应批准，不能以生成物更新代替。
5. 一批一次链写、一次汇报。转态与注解通过批量入口集中写入并读回。需要 Owner 决定的事项集中列出并附建议；可自主选择且已有授权的非阻塞事项先做并在收口回显。仍需批准的事项不能因“不阻塞”而先执行，沟通时点遵循静默汇报原则的必要例外。
6. 派工按批段。拆分一个代理，实施每包一个代理，集成一个代理；独立验收可按已批准的 Epic 影响范围分片。不为单步、确认读数或机械汇总另派代理。先判定小轮合并：实施包不超过 2 个或验收只有一片时，由一个主力档代理一次完成验收与判断，仍按原格式写验收、判断与 lessons 三份文件；确有下一轮时顺带写拆分文件，不另派拆分代理。只有不满足上述小轮条件且确需两片以上验收时，才分片验收、单独判断和拆分；已有明确批准的不同角色安排按该批准执行。没有实施包、只有链写或文档动作的轮，不派拆分与验收代理，主线程完成动作后派一个主力档代理读回并判断。独立验收者不验收自己实施的改动。
7. 按实质进展接续。一轮的问题清单与排队项是下一轮输入；仍有已批准且可推进的工作时，由负责该阶段的角色继续，直到达到目标终态或剩余工作全部阻塞。Codex 双对话按下文的批段交接与下一批授权执行，不让主决策对话空闲轮询。对同一问题，连续两次分析或复验没有新增证据时，停止重复同一动作；改用能区分原因的检查，或说明需 Owner 决定的具体差异、实际影响和可选处置。更换代理、轮次或模型不重置该记录；新检查仍须在已批准的方法与权限内，其他可推进工作继续。没有实质性发现且必需验收已满足时结束，不为凑问题启动下一轮。
8. 知识采集按轮。判断代理在判断报告旁产出 lessons.json，每条含 subject、summary、snippet、body、tags 与来源证据引用（稳定项目标识和仓库相对路径）；只写本轮新确立的事实与教训，不超过 5 条，没有新知识可为空。主线程在同一轮的链写中用 knowledge-capture 落卡并读回；预算拒绝如实记录并按实际解除条件处理，不自动假定迁移是唯一出口。不依赖 Stop 钩子标记行，不重复落同一结论。
9. 证据按需要读取。治理代理与主线程先读派工指定的摘录、节号或行号范围，保留判断必需的完整要求与上下文。工具输出先写入证据文件，机器提取身份、哈希、计数、映射与差异；主力负责行为、契约和争议判断。每次读入不超过 200 行，不整读超过 32 KB 的文件；按相关范围分段，遵守宿主实际读取限制。证据缺口只补相关来源，不反复复述完整历史。

### 验收依据与复验范围

1. 可运行的问题优先选择能改变判断的最小实测，再据结果决定是否扩大检查。记录实际输入、命令、输出、退出状态及候选版本。静态证明须给出确定触发路径与契约依据；实测失败、静态证明和待验证假设分开。环境或权限不足时标明未验证及原因，不用推测补成通过或失败。测试断言也须核对当前需求，测试通过不替代 Owner 目视验收或发布授权。
2. 阻断发现须对应当前行为、明确契约或可信安全边界，并说明触发条件与影响。风格偏好、无依据的未来扩展或推测性防御建议不能自动变成必修项；允许无实质性发现。既定判据即使影响很小也不能私自放宽，须把实测差异和处置选择交有权决定的人。
3. 复验前说明哪些改动使哪些证据失效。该项检查涉及的源码、依赖、环境、参数、相关输入与基线一致，且有可定位的成功执行证据时，可以复用。父门去重以实际执行记录为准，脚本声明包含子门不证明子门已执行；被早期失败跳过的项目保持未执行。父门内已成功的子门可满足同一检查，不再单独重跑，但不能据此把失败的父门标为通过。无法证明等价、证据缺失或相关输入变化时，补跑相关必需项。
4. 独立审查聚焦本轮变更、失败和受影响行为，引用仍有效的既有结论；必要完整验证、最终集成、发布及安全检查仍按当前契约执行。不得因复用证据删除门、改变判据、重排依赖或掩盖未执行项。机械核对优先用现有工具，不为此新增审查层、代理或证明框架。

### 代理通信与等待

1. 子代理按包交付。普通进度、阶段小结、可延后的问题集中在完成时报告；已有宿主完成通知时，不再用 send_message 重复发送同一结果。派工时确保子代理收到本条约束。
2. 中途通信限定例外。安全问题、无法继续的硬阻塞，以及不立即协调就会阻塞其他代理的依赖或冲突，可以立即上报；保留解决这些问题所需的事实澄清，不禁止必要通信。
3. 主代理减少往返。不回复纯确认，不催问普通进度；收到需要决策或行动的信息时直接处理。普通状态消息不触发额外的全体状态查询或重复汇报。
4. 等待避免空轮询。使用宿主支持的完成通知与阻塞等待；连续没有新状态时延长查询间隔，遵守宿主等待上限和用户中断要求；有独立可做的工作时继续该工作。

### Codex 独立双对话契约（其他宿主与 dot 不适用）

仅在明确选定 Codex 宿主的多子代理编排中使用独立的主力主决策对话与经济协调对话；不是父子收集代理。主决策对话负责批目标、阶段边界、判断及下一批授权；经济协调对话直接派出全新工作子代理，按任务类型的类别与既有退回阈值升档，直接等待并读取其原生结果。工作子代理不主动向父对话发消息，保留原生 final；安全和硬阻塞通过宿主支持的结果/中断路径处理。协调者不是只读收集者，也不另派收集者。Claude Code、DSH 仍由单主对话协调子代理并使用原生完成通知；dot 策略不变。

角色只使用 main（主力）、economy（经济）与可选 flagship（旗舰）类别，不绑定具体模型。安装引导提供这三个稳定分类；所选设备宿主策略必须配置可解析的 main 与 economy 模型组才可启用本模式，flagship 模型组可跳过。空组不是可用模型或升档上限，不编造模型、effort、决定来源或宿主支持；更新/修复幂等补缺，保留用户模型、自定义分类及其他宿主。按实际策略版本解析并保留派工回执。

派工前固定 batchId、application attempt、两个独立对话标识及成员范围；每个工作子代理由真实派工回执绑定 agentId、任务包与 attempt。不得凭名称、marker、自述或本地文件冒充原生授权。工作并发同时遵守 execution.maxConcurrentSubagents、设备/项目限制与真实宿主硬容量；没有 collector cap 豁免或预留收集槽。容量不足则减并发或分批，不能绕限。

主决策对话交付批段后停止空闲轮询，不用 /goal 或 /loop 主动等待；经济协调对话使用宿主支持的有界等待直接读取固定成员结果，遵守间隔、截止、失败次数、预算及用户中断。保留 failed、cancelled_confirmed 与 unknown；陈旧、未来、错批、错 attempt、漂移及查询失败不算完成。禁止专用收集子代理、SubagentStop 保活、collector-wait 或旧收集机制 fallback。旧引擎 owned hook 仅在核实归属后退役，保留用户修改及无关 hook。

协调者按同批同 attempt 去重，全部成员确认终态后向主决策对话交付一次批报告；失败不伪装成功。中断、期限、权限、安全、预算耗尽与无进展明确报告剩余责任。恢复时先核对既有派工、原生状态与已交付回执，结果未知先查证，不重复派工、不重放已确认交付、不复活已结束 worker；迟到结果保留但不得推进另一 attempt。交付未知不得盲目重发或启动下一批。缺能力只停依赖路径，不能换收集者回退。

源码/自动化回归与真实宿主验收分别记录；具体测试范围和验收责任遵循当前 Owner 决定，不以文档或模拟冒称候选真实宿主已验收。不创建 daemon、不读取私有会话数据库、不虚构 RPC。保留既有用户目标、自动化及 M 正常治理轮次；本限制不取消有实质工作的后续轮。


## Recording checks and reusing results

### Direct checks and independent reproduction

For a local check, select the command that exercises the changed behavior through
its normal entry point. Use the existing test selector, fixture or declared gate
that covers the actual trigger. Record the candidate revision, relevant fixture
or input revision, invocation and environment, stdout or stderr evidence, and
exit status. Record a skipped or unavailable check separately. The implementer
can fix a confirmed failure in the original package and recheck its affected
behavior.

- Exercise an added or changed guard with real inputs the current contract supports. Use the actual interface or filesystem layout when it is part of the behavior under review.
- For an added or changed fallback, distinguish permitted absence, unreadable data, malformed data and a valid empty result. Apply an absence default only where the contract allows it. Keep reads required for a completion decision failed or explicitly unverified when they cannot be completed.
- For a bug fix, use the original failing input to show that the regression detects the defect and that the fixed candidate meets the contract. Reuse locatable evidence of the original failure when the relevant inputs are equivalent under item 3.

An independent reviewer can run the smallest reproduction that can change the
judgment in the approved isolated environment. Follow the permissions and role
limits for that batch. Cite the observed trigger, result and impact when asking
for rework. Compare passing evidence against the current source, dependencies,
environment, arguments, relevant inputs and baseline. A change invalidates
evidence only where it affects one of those inputs. The approved formal gates
and independent judgment retain their own scope.

### One execution record and its references

Record each actual execution once with a stable reference. Implementation
handoff, acceptance, judgment and lessons cite the same record for the same
execution, and each supplies the findings appropriate to its role. Keep raw
outputs at the referenced location and let tools extract the fields needed for
the decision. A required delivery view can carry a short finding and evidence
reference. An earlier success can satisfy a current check only when its relevant
inputs match and the record shows that it ran.

For governance reads within one responsibility, reuse the version and head
from the same live `work-show` receipt when the next step needs only that
identity and revision. Read `status` when its own fields are needed. A new
worker still reads its live work and inherited constraints. After a write or
a relevant state change, read back the affected scope. When comparing a read
workflow, keep the library, work item, inputs and effective head comparable.
Record the command sequence, exit statuses, raw and delivered bytes where
observable, and wall time. Keep token use, cost and causes unknown when the
measurements cannot establish them.

## 检查记录与结果复用

### 局部检查与独立复现

局部检查从正常入口触发本次改动影响的行为，使用现有测试选择器、夹具或适用门。
记录候选版本、相关夹具或输入版本、命令和环境、标准输出或错误输出的证据及退出状态。
跳过或无法执行的检查单列。实施者在原包内修复已确认的失败，并复验受影响行为。

- 新增或修改 guard 时，用当前契约支持的真实合法输入验证。被审行为依赖实际接口或文件系统布局时，使用该接口或布局。
- 新增或修改 fallback 时，区分合法缺失、不可读、损坏与有效空结果。只有契约允许的缺失才使用默认值。完成判定所依赖的读取未能完成时，保留失败或明确标为未验证。
- 修复缺陷时，用原失败输入证明回归能检出缺陷，且修复后的候选满足契约。相关输入符合第 3 条的等价条件时，复用可定位的原失败证据。

独立验收者可在已批准的隔离环境中执行能改变判断的最小复现，遵循该批次的权限与角色限制。
要求返工时引用实测触发条件、结果和影响。复用通过证据前，核对相关源码、依赖、环境、参数、
输入及基线是否等价。变更只使受影响的证据失效。既定正式门与独立判断各按其范围执行。

### 一份执行事实与引用

每次实际执行只记录一次并给出稳定引用。实施交接、验收、判断与知识采集针对同一次执行引用
同一份记录，各自写出该角色应作出的结论。原始输出留在引用位置，需要哪些字段就用工具提取哪些。
现有必需交付可只附简短发现和证据引用。只有相关输入等价且有实际成功执行记录时，才复用已有检查。

同一职责范围内，后续若只需要任务身份、库版本及 head，复用同一份实时 `work-show` 回执。
需要 `status` 独有字段时单独读取。新工作者仍须读取实时任务与继承约束。发生写入或相关状态
变化后，读回受影响范围。比较读取流程时对齐库、任务、输入与生效的 head，记录调用序列、
退出状态、可观测的原始与交付字节及墙钟时间。实测无法证明的 token、费用与归因保持未知。
