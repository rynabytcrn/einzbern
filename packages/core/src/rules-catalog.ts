// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-483 R1 (MIN-228 D3, MIN-229 D6): the Command Spell rules this engine ships
// with. A rule is a principle a project may switch on for the agents that work in it. The engine
// carries four, each with an id, a version, and a Chinese and an English title and body. MIN-228
// D3 fixed the set at four; MIN-229 D6 supplied batch v2, and the INIT-053 Owner supplement adds communication and waiting at v3.
//
// The Chinese texts are the Owner's final wording, word for word. tests/fixtures/rules/ holds
// copies of them, and tests/rules-catalog.test.mjs compares each constant here with its copy, so
// an edit to either side is a red test rather than a quiet drift. The English text of
// silent-reporting is the Owner's final translation as well. The English texts of autonomy, batch
// and unattended-commands were translated when this module was written and await the Owner's
// correction; a correction changes the text here and nothing else.
//
// Every text is a constant in this file, and this module reads no file: a packaged engine is one
// script, and a text kept anywhere else would not travel with it. A body is the whole rule as it
// is written into a project file: a heading that names the rule and its version, the text, and
// one final newline.
//
// Which rules a project has switched on, and the state each of them is in, is decided elsewhere;
// this module only says what the engine ships. It imports nothing, so every other module may
// import it.

/** The ids of the built-in rules, in the order they are listed. */
export const BUILT_IN_RULE_IDS = Object.freeze(["autonomy", "batch", "unattended-commands", "silent-reporting", "design-authority"] as const);
export type BuiltInRuleId = typeof BUILT_IN_RULE_IDS[number];

/** A rule's text in each language the engine ships it in. */
export interface RuleText {
  readonly zh: string;
  readonly en: string;
}

export interface BuiltInRule {
  readonly id: BuiltInRuleId;
  readonly version: number;
  readonly title: RuleText;
  readonly body: RuleText;
}

const AUTONOMY_ZH = `## 自主运行原则 v1

你在自主运行。使用者不在实时观看，无法在任务中途回答问题，所以问「要我……吗？」「是否继续？」只会让工作停摆。原始请求已涵盖的可逆动作，直接做。只有破坏性动作与真正的范围变更才停下来交给使用者定。任务做完后提出后续建议可以；动手前先请示不行。
`;

// Translated when this module was written; awaits the Owner's correction.
const AUTONOMY_EN = `## Autonomous Operation Principle v1

You are operating autonomously. The user is not watching in real time and cannot answer questions partway through a task, so asking "Do you want me to ...?" or "Should I continue?" only stalls the work. When a reversible action is already covered by the original request, just do it. Stop and leave the decision to the user only for destructive actions and genuine changes of scope. Suggesting follow-up work once the task is done is fine; asking for permission before you act is not.
`;

const BATCH_ZH = `## 批量处理原则 v3

适用于本工作区的一切工作：拆分、实施、跑门、测试、验收、链写、汇报、派工。

1. 批的单位。一个 INIT 下全部待办 Story 是一批。拆分由一个子代理一次做完，每张 Subtask 写明改动文件与依赖。批内发现的新工作记入本批问题清单，进下一批，不插入本批。
2. 实施分包并行。拆分完成后先分包：有先后依赖或改同一批文件的 Subtask 进同一个包，包内按顺序做；互不影响的 Subtask 各成一包。每个包派一个经济档子代理，在自己的工作树与分支上做，多个包同时跑。并发上限按 execution.maxConcurrentSubagents；该值超过宿主的上限或未设置时，按宿主的规则派遣。包完成即退役，不跑门、不验收、不写链。全部包完成后按依赖顺序合并到集成分支，冲突交一个集成子代理。
3. 见红只记不修。批内跑门、跑测试、做验收，每一条红与缺陷只记入本批问题清单，不停下来修，不为它重跑门，不逐条开工单。合并完成后批末一次门、一次验收，把清单一次处置，处置完再跑一次相关的门。同一根因的多条算一条。可以打断批的只有两种情况：安全拒绝，以及让后续工作无法进行的硬阻塞。
4. 生成物批末再生。覆盖基线、证明物、钩子渲染、预算抬线这类工具生成的东西，批末各做一次，作为固定收尾步骤，不随单条修改重做。
5. 一批一次链写、一次汇报。转态与注解用批量入口一次写完。待 Owner 决定的事项在收口汇报里成批列出，每项附建议。不阻塞工作的事项按建议先做，汇报里回显所做的选择，由 Owner 事后更正。
6. 派工按批段。拆分一个代理，实施每包一个代理，集成一个代理，验收一个代理，验收可按 Epic 分片同批并行。不为单步派代理，不为确认读数派代理。

修完一条又红一条的循环，本身就是违反本原则的信号：停下，把清单列全，再动手。

### 代理通信与等待

1. 子代理按包交付。普通进度、阶段小结、可延后的问题集中在完成时报告；已有宿主完成通知时，不再用 send_message 重复发送同一结果。派工时确保子代理收到本条约束。
2. 中途通信限定例外。安全问题、无法继续的硬阻塞，以及不立即协调就会阻塞其他代理的依赖或冲突，可以立即上报；保留解决这些问题所需的事实澄清，不禁止必要通信。
3. 主代理减少往返。不回复纯确认，不催问普通进度；收到需要决策或行动的信息时直接处理。普通状态消息不触发额外的全体状态查询或重复汇报。
4. 等待避免空轮询。使用宿主支持的完成通知与阻塞等待；连续没有新状态时延长查询间隔，遵守宿主等待上限和用户中断要求；有独立可做的工作时继续该工作。
`;

// Translated when this module was written; awaits the Owner's correction.
const BATCH_EN = `## Batch Processing Principle v3

This applies to all work in this workspace: decomposition, implementation, running gates, testing, acceptance, chain writes, reporting and dispatch.

1. The unit of a batch. All open Stories under one INIT form one batch. One subagent does the whole decomposition in one pass, and every Subtask states the files it changes and what it depends on. New work found during a batch goes on this batch's problem list and into the next batch; it is not inserted into this one.
2. Implementation runs in parallel packages. Once decomposition is done, group the Subtasks into packages first: Subtasks that depend on one another or change the same files go into the same package and are done in order within it; Subtasks that do not affect one another each form a package of their own. Each package goes to one economy-tier subagent, which works in its own worktree and branch, and several packages run at the same time. The concurrency limit is execution.maxConcurrentSubagents; when that value exceeds the host's limit or is not set, dispatch by the host's rules. A package retires as soon as it is finished: it runs no gates, does no acceptance and writes nothing to the chain. When every package is finished, merge them into the integration branch in dependency order and hand any conflicts to one integration subagent.
3. Record red results; do not fix them. When gates, tests or acceptance within a batch turn up a red result or a defect, it only goes on this batch's problem list: do not stop to fix it, do not rerun gates for it, and do not open a work item for each one. Once the merge is done, run the gates once and acceptance once at the end of the batch, dispose of the whole list in one pass, and after that run the relevant gates once more. Several findings with one root cause count as one. Only two things may interrupt a batch: a safety refusal, and a hard blocker that makes further work impossible.
4. Generated output is regenerated at the end of the batch. Tool-generated things such as coverage baselines, proof artifacts, hook renderings and budget-ceiling raises are each done once at the end of the batch as a fixed closing step, not redone with every individual change.
5. One chain write and one report per batch. Status transitions and annotations are written in one pass through the batch entry point. Items awaiting the Owner's decision are listed together in the closing report, each with a recommendation. Items that do not block the work are done first as recommended; the report echoes the choices made, and the Owner corrects them afterwards.
6. Dispatch follows the batch stages. One agent for decomposition, one agent per package for implementation, one agent for integration and one agent for acceptance; acceptance may be split by Epic and run in parallel within the same batch. Do not dispatch an agent for a single step, and do not dispatch an agent to confirm a reading.

A cycle in which fixing one red result turns up another is itself a sign that this principle is being broken: stop, list everything, then act.

### Agent communication and waiting

1. Subagents deliver complete packages. Report ordinary progress, stage summaries and deferrable issues together when the package is complete. When the host already sends a completion notification, do not repeat the same result through send_message. Include this constraint when dispatching subagents.
2. Limit communication during a package to necessary exceptions. Immediately report safety issues, hard blockers that prevent further work, and dependencies or conflicts that would block other agents without immediate coordination. Keep the factual clarification needed to resolve these issues; necessary communication remains allowed.
3. The main agent reduces round trips. Do not reply with pure acknowledgments or ask for ordinary progress. Act directly on information that needs a decision or action. Ordinary status messages do not trigger extra queries of every agent's status or repeated reports.
4. Avoid empty polling while waiting. Use completion notifications and blocking waits supported by the host. Lengthen query intervals when there is repeatedly no new state, respect the host's wait limit and user interruption requirements, and continue independent work when it is available.
`;

const UNATTENDED_COMMANDS_ZH = `## 无人值守指令原则 v1

无人值守时，弹出确认框等于停摆：确认框不返回错误，会话只是无限等待。凡是可能弹框的写法按禁止处理，改用等价写法，不要先试试看。

1. 删除改为移动。要清掉的文件或目录先 mv 到本会话 scratch 目录下的 trash 子目录。仓库里已跟踪的文件用 git rm。不用 rm 与 rmdir。
2. 命令里不 cd。一律绝对路径。对别的目录跑 git 用 git -C 那个目录。
3. 只写工作目录与 scratch 目录。要在别处建克隆或镜像，先用启动参数或 /add-dir 把那个目录加入会话再动手。
4. 权限规则里 deny 或 ask 列出的路径与命令一概不碰，也不把它们复制到别处再处理。
5. 弹了框的写法不重试。记入本批问题清单，换等价写法继续。

宿主说明。Claude Code：rm 或 rmdir 指向根目录、home、工作目录本身会弹框，cd 进另一个目录再跑 git 会弹框，两者在 bypass 下同样弹。
`;

// Translated when this module was written; awaits the Owner's correction.
const UNATTENDED_COMMANDS_EN = `## Unattended Commands Principle v1

When running unattended, a confirmation dialog is a stall: the dialog returns no error, and the session simply waits forever. Treat every way of writing a command that might raise a dialog as forbidden and use an equivalent form instead; do not try it first to see what happens.

1. Move instead of deleting. To clear away a file or directory, first mv it into the trash subdirectory of this session's scratch directory. For files a repository tracks, use git rm. Do not use rm or rmdir.
2. No cd in commands. Always use absolute paths. To run git against another directory, use git -C with that directory.
3. Write only to the working directory and the scratch directory. To create a clone or a mirror somewhere else, first add that directory to the session with a launch argument or /add-dir, and only then begin.
4. Never touch a path or command that the permission rules list under deny or ask, and do not copy them elsewhere to deal with them there.
5. Do not retry a form that raised a dialog. Record it on this batch's problem list and carry on with an equivalent form.

Host notes. Claude Code: rm or rmdir aimed at the root directory, home or the working directory itself raises a dialog, and so does running git after a cd into another directory; both raise a dialog under bypass as well.
`;

const SILENT_REPORTING_ZH = `## 静默汇报原则 v1

工作进行期间，主对话不输出汇报。子代理之间的切换、派工、落链、跑门，回合里只有工具调用，没有进度文字，也没有一行小结。需要留痕的事实由发现它的子代理写进状态文件。

只有两种时刻输出汇报：全部任务完成，或剩余任务全部阻塞。汇报按 owner-output-contract 写，待 Owner 决定的事项一次列全并附建议。安排唤醒源不算汇报。
`;

const SILENT_REPORTING_EN = `## Silent Reporting Principle v1

While work is in progress, the main conversation produces no reports. Between subagents, when dispatching, writing to the chain, or running gates, a turn contains tool calls only: no progress prose, no one-line summaries. Facts that must be kept are written to the state file by the subagent that found them.

Reports are produced at exactly two moments: when every task is complete, or when every remaining task is blocked. A report follows the owner-output-contract and lists every item awaiting the Owner's decision at once, each with a recommendation. Scheduling a wake-up does not count as a report.
`;

const DESIGN_AUTHORITY_ZH = "## \u8bbe\u8ba1\u6743\u5a01\u4e0e\u4e00\u81f4\u6027\u539f\u5219 v1\n\n1. \u5148\u786e\u5b9a\u8bbe\u8ba1\u6743\u5a01\u3002\u8bfb\u53d6\u5f53\u524d\u9879\u76ee\u53ca\u76ee\u6807\u5b50\u9879\u76ee\u7684\u7cfb\u7edf\u53d8\u91cf `design.authority`\uff0c\u4ee5\u53ca\u540c\u4e00\u914d\u7f6e\u4e2d\u58f0\u660e\u7684\u6743\u5a01\u4ed3\u5e93\u3001\u751f\u4ea7\u6587\u6863\u548c\u6784\u5efa\u90e8\u7f72\u7ed1\u5b9a\u3002\u6bcf\u4e2a\u9879\u76ee\u3001\u5b50\u9879\u76ee\u90fd\u5e94\u80fd\u5bf9\u5e94\u5230\u81ea\u5df1\u7684\u6709\u6548\u6743\u5a01\uff1b\u7ee7\u627f\u503c\u987b\u663e\u793a\u6765\u6e90\u3002\u7f3a\u5931\u6216\u51b2\u7a81\u65f6\u5148\u8865\u9f50\u914d\u7f6e\uff0c\u4e0d\u6309\u76ee\u5f55\u4f4d\u7f6e\u3001\u9876\u5c42\u9879\u76ee\u6216\u8bb0\u5fc6\u731c\u6d4b\u3002\n2. \u5148\u67e5\u5df2\u6709\u7ec4\u4ef6\u4e0e\u89c4\u8303\u3002\u6839\u636e\u8be5\u6743\u5a01\u7684\u5df2\u53d1\u5e03\u5951\u7ea6\uff0c\u6838\u5bf9\u7ec4\u4ef6\u5bb6\u65cf\u3001\u53d8\u4f53\u3001\u72b6\u6001\u3001\u5e03\u5c40\u548c\u4ea4\u4e92\u89c4\u8303\uff0c\u518d\u51b3\u5b9a\u5982\u4f55\u5b9e\u73b0\u3002\u5df2\u6709\u80fd\u529b\u76f4\u63a5\u590d\u7528\uff1b\u7f3a\u5c11\u80fd\u529b\u8bb0\u5165\u8bbe\u8ba1\u6743\u5a01\u7684\u6539\u52a8\u8303\u56f4\u3002\n3. \u8bbe\u8ba1\u6743\u5a01\u5148\u6539\u3002\u4efb\u4f55\u7ec4\u4ef6\u3001\u89c6\u89c9\u8bbe\u8ba1\u6216\u8bbe\u8ba1\u89c4\u8303\u7684\u65b0\u589e\u4e0e\u6539\u52a8\uff0c\u5148\u5411\u6743\u5a01\u4ed3\u5e93\u63d0 PR\uff0c\u5728\u6743\u5a01\u4e2d\u8865\u9f50\u5b9e\u73b0\u3001\u8bbe\u8ba1\u89c4\u8303\u3001\u5b9e\u9645\u793a\u4f8b\u548c\u9002\u7528\u9a8c\u8bc1\uff1b\u4e0d\u5f97\u5148\u5728\u5e94\u7528\u4e2d\u53e6\u9020\u4e00\u5957\u518d\u8865\u89c4\u8303\u3002\n4. \u53d1\u5e03\u901a\u8fc7\u540e\u518d\u63a5\u5165\u3002\u6743\u5a01 PR \u5408\u5e76\u3001\u58f0\u660e\u7684\u751f\u4ea7\u6587\u6863\u6216\u7ec4\u4ef6\u5e93\u53d1\u5e03\u6210\u529f\u3001\u58f0\u660e\u7684\u6784\u5efa\u90e8\u7f72\u670d\u52a1\u6210\u529f\uff0c\u5e76\u6838\u5bf9\u8fd9\u4e9b\u8bc1\u636e\u5bf9\u5e94\u540c\u4e00\u63d0\u4ea4\u6216\u4ea7\u7269\u7248\u672c\u540e\uff0c\u5e94\u7528\u624d\u80fd\u63a5\u5165\u65b0\u80fd\u529b\u3002\u672c\u5730\u901a\u8fc7\u3001\u9884\u89c8\u90e8\u7f72\u6216\u53ea\u6709\u9875\u9762\u80fd\u6253\u5f00\uff0c\u90fd\u4e0d\u4ee3\u8868\u751f\u4ea7\u53d1\u5e03\u901a\u8fc7\u3002\u8fd9\u4e2a\u53d1\u5e03\u4f9d\u8d56\u5e94\u5728\u6279\u6b21\u5206\u5305\u65f6\u660e\u786e\uff0c\u672a\u6ee1\u8db3\u65f6\u4e0d\u8d8a\u8fc7\u4f9d\u8d56\u3002\n5. \u4fdd\u6301\u7ec4\u4ef6\u5bb6\u65cf\u4e00\u81f4\u3002\u65b0\u589e\u548c\u4fee\u6539\u7684\u7ec4\u4ef6\u6cbf\u7528\u539f\u5bb6\u65cf\u7684\u989c\u8272\u3001\u5b57\u4f53\u3001\u95f4\u8ddd\u3001\u5c3a\u5bf8\u3001\u5706\u89d2\u3001\u8fb9\u6846\u3001\u56fe\u6807\u3001\u52a8\u6548\u53ca\u4ea4\u4e92\u72b6\u6001\uff1b\u589e\u91cf\u529f\u80fd\u6cbf\u7528\u5df2\u6709\u9009\u7528\u65b9\u5f0f\u3001\u53cd\u9988\u548c\u952e\u76d8\u64cd\u4f5c\u3002\u7528\u540c\u7c7b\u7ec4\u4ef6\u9010\u9879\u5bf9\u7167\uff0c\u907f\u514d\u4ea7\u751f\u660e\u663e\u4e0d\u540c\u7684\u89c6\u89c9\u6216\u4ea4\u4e92\u8bed\u8a00\uff1b\u8f83\u5927\u7684\u98ce\u683c\u53d8\u5316\u5148\u53d6\u5f97 Owner \u660e\u786e\u540c\u610f\u3002 \u628a\u660e\u663e\u504f\u79bb\u539f\u5bb6\u65cf\u7684\u5b9e\u73b0\u8865\u8fdb\u8bbe\u8ba1\u6743\u5a01\uff0c\u4e0d\u80fd\u4f5c\u4e3a\u98ce\u683c\u4e00\u81f4\u6216 Owner \u76ee\u89c6\u901a\u8fc7\u7684\u8bc1\u660e\u3002 \u68c0\u67e5\u5168\u90e8\u65b0\u589e\u6216\u4fee\u6539\u7684\u7ec4\u4ef6\u4e0e\u53d8\u4f53\uff1a\u540c\u7c7b\u4efb\u52a1\u5e94\u4f7f\u7528\u540c\u7c7b\u63a7\u4ef6\uff0c\u4fdd\u6301\u9009\u62e9\u3001\u5bfc\u822a\u3001\u4fdd\u5b58\u3001\u64a4\u9500\u3001\u91cd\u7f6e\u3001\u9519\u8bef\u53cd\u9988\u548c\u952e\u76d8\u64cd\u4f5c\u7684\u542b\u4e49\u4e0e\u9884\u671f\u4e00\u81f4\u3002\n6. \u901a\u8fc7\u6b63\u5f0f\u5951\u7ea6\u6d88\u8d39\u3002\u5e94\u7528\u4f7f\u7528\u5df2\u53d1\u5e03\u7ec4\u4ef6\u3001\u4ee4\u724c\u6216\u6743\u5a01\u8ba4\u53ef\u7684\u9759\u6001\u6d88\u8d39\u65b9\u5f0f\uff0c\u7ed1\u5b9a\u5b9e\u9645\u7248\u672c\u5e76\u540c\u6b65\u751f\u6210\u7684\u5951\u7ea6\u4e0e\u6837\u5f0f\u5feb\u7167\uff1b\u4e0d\u590d\u5236\u6587\u6863\u7ad9\u79c1\u6709\u6837\u5f0f\u3001\u4e0d\u5728\u5e94\u7528\u5185\u91cd\u9020\u901a\u7528\u7ec4\u4ef6\u3001\u4e0d\u7528\u5c40\u90e8\u8986\u76d6\u63a9\u76d6\u6743\u5a01\u7f3a\u53e3\u3002\n7. \u6838\u5bf9\u73b0\u5b58\u7f3a\u53e3\u3002\u53d1\u73b0\u5e94\u7528\u5df2\u4f7f\u7528\u6743\u5a01\u672a\u63d0\u4f9b\u6216\u672a\u53d1\u5e03\u7684\u7ec4\u4ef6\u3001\u53d8\u4f53\u3001\u8bbe\u8ba1\u89c4\u8303\u65f6\uff0c\u5217\u51fa\u4f7f\u7528\u5904\u548c\u7f3a\u5c11\u7684\u6743\u5a01\u8bc1\u636e\uff0c\u5148\u6309\u540c\u4e00 PR\u3001\u751f\u4ea7\u53d1\u5e03\u548c\u6784\u5efa\u6d41\u7a0b\u8865\u9f50\u6743\u5a01\uff0c\u518d\u7ee7\u7eed\u53d7\u5f71\u54cd\u7684\u5e94\u7528\u6539\u52a8\u3002\u673a\u5668\u9a8c\u8bc1\u4e0e Owner \u76ee\u89c6\u9a8c\u6536\u5206\u522b\u8bb0\u5f55\u3002\n8. \u89c4\u5219\u4e0e\u53d8\u91cf\u5206\u79bb\u3002\u89c4\u5219\u6b63\u6587\u53ea\u5f15\u7528\u7cfb\u7edf\u53d8\u91cf\u53ca\u5176\u6743\u5a01\u5951\u7ea6\uff0c\u4e0d\u5199\u6b7b\u9879\u76ee\u540d\u3001\u4ed3\u5e93\u5730\u5740\u3001\u6587\u6863 URL\u3001\u90e8\u7f72\u5382\u5546\u3001\u7248\u672c\u53f7\u6216\u7ec4\u4ef6\u6570\u503c\u3002\u5f53\u524d\u9879\u76ee\u4f7f\u7528\u7684\u5177\u4f53\u503c\u5c5e\u4e8e\u9879\u76ee\u6216\u5b50\u9879\u76ee\u914d\u7f6e\uff1b\u914d\u7f6e\u80fd\u529b\u5c1a\u672a\u5b9e\u73b0\u6216\u8bc1\u636e\u65e0\u6cd5\u8bfb\u53d6\u65f6\uff0c\u660e\u786e\u8bb0\u5f55\u4e3a\u672a\u914d\u7f6e\u6216\u672a\u9a8c\u8bc1\u3002\u63d0\u4ea4\u548c\u53d1\u5e03\u52a8\u4f5c\u4f7f\u7528\u5f53\u524d\u4efb\u52a1\u5df2\u7ecf\u83b7\u5f97\u7684\u6388\u6743\u3002\n";
const DESIGN_AUTHORITY_EN = "## Design Authority and Consistency Principle v1\n\n1. Resolve the design authority first. Read the current project's and target subproject's system variable `design.authority`, together with the authority repository, production documentation, and build and deployment bindings declared in the same configuration. Each project and subproject must resolve to its own effective authority; inherited values must identify their source. Resolve missing or conflicting bindings before design work, without guessing from directory placement, the parent project, or memory.\n2. Inspect existing components and standards. Use the authority's published contract to identify component families, variants, states, layouts, and interactions before implementation. Reuse existing capabilities and include missing ones in the authority's change scope.\n3. Change the authority first. Every addition or change to a component, visual design, or design standard starts with a PR to the authority repository, covering implementation, standards, working examples, and applicable validation. Do not create a separate design in the application and document it afterwards.\n4. Consume changes after production succeeds. The application may use the new capability only after the authority PR is merged, its declared production documentation or component library is published successfully, and its declared build and deployment service succeeds, with all evidence bound to the same source commit or artifact version. A local pass, preview deployment, or reachable page does not establish production success. Include this dependency when organizing the batch and do not consume the change before it is satisfied.\n5. Keep component families consistent. Preserve the family's colors, typography, spacing, sizing, radii, borders, icons, motion, and interaction states. Added features follow existing selection, feedback, and keyboard patterns. Compare equivalent components directly to prevent a substantially different visual or interaction language; obtain explicit Owner agreement before a substantial style change. Adding a substantially divergent implementation to the authority does not establish family consistency or Owner visual acceptance. Check every added or changed component and variant: equivalent tasks use equivalent controls, with consistent meanings and expectations for selection, navigation, saving, undoing, resetting, error feedback, and keyboard interaction.\n6. Consume the published contract. Use published components, tokens, or an authority-approved static consumption method, bind the actual version, and refresh generated contracts and stylesheet snapshots together. Do not copy documentation-only styles, recreate reusable components in the application, or conceal missing authority support with local overrides.\n7. Reconcile existing gaps. When the application already uses a component, variant, or design standard absent from the authority or its production release, identify the consumer locations and missing evidence. Complete the same authority PR, production publication, and build sequence before continuing affected application changes. Record machine verification and Owner visual acceptance separately.\n8. Separate rules from values. Reference system variables and their authority contracts in the rule body instead of hard-coding project names, repository addresses, documentation URLs, deployment vendors, versions, or component measurements. Store actual values in project or subproject configuration. Mark unavailable configuration capabilities or unreadable evidence as unconfigured or unverified. Use the current task's existing authorization for commits and publication.\n";

function builtIn(id: BuiltInRuleId, version: number, title: RuleText, body: RuleText): BuiltInRule {
  return Object.freeze({ id, version, title: Object.freeze({ ...title }), body: Object.freeze({ ...body }) });
}

/** The built-in rules, in the order of BUILT_IN_RULE_IDS. */
export const BUILT_IN_RULES: readonly BuiltInRule[] = Object.freeze([
  builtIn("autonomy", 1, { zh: "自主运行原则", en: "Autonomous Operation Principle" }, { zh: AUTONOMY_ZH, en: AUTONOMY_EN }),
  builtIn("batch", 3, { zh: "批量处理原则", en: "Batch Processing Principle" }, { zh: BATCH_ZH, en: BATCH_EN }),
  builtIn(
    "unattended-commands",
    1,
    { zh: "无人值守指令原则", en: "Unattended Commands Principle" },
    { zh: UNATTENDED_COMMANDS_ZH, en: UNATTENDED_COMMANDS_EN },
  ),
  builtIn("silent-reporting", 1, { zh: "静默汇报原则", en: "Silent Reporting Principle" }, { zh: SILENT_REPORTING_ZH, en: SILENT_REPORTING_EN }),
  builtIn("design-authority", 1, { zh: "\u8bbe\u8ba1\u6743\u5a01\u4e0e\u4e00\u81f4\u6027\u539f\u5219", en: "Design Authority and Consistency Principle" }, { zh: DESIGN_AUTHORITY_ZH, en: DESIGN_AUTHORITY_EN }),
]);

/** The built-in rule with this id, or null when the engine ships no rule by that id. */
export function builtInRule(id: string): BuiltInRule | null {
  return BUILT_IN_RULES.find((rule) => rule.id === id) ?? null;
}

/**
 * A rule's body in the language a project writes its artifacts in: the Chinese body when
 * artifact.language is zh-CN, and the English body for every other value and when it is not set.
 */
export function ruleBody(id: BuiltInRuleId, language: string | null): string {
  const rule = builtInRule(id);
  if (rule === null) throw new RangeError(`no built-in rule has the id ${JSON.stringify(id)}`);
  return language === "zh-CN" ? rule.body.zh : rule.body.en;
}
