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
export const BUILT_IN_RULE_IDS = Object.freeze(["autonomy", "batch", "unattended-commands", "silent-reporting"] as const);
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
