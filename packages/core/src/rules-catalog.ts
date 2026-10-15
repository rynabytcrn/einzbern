// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-483 R1 (MIN-228 D3, MIN-229 D6): the Command Spell rules this engine ships
// with. A rule is a principle a project may switch on for the agents that work in it. The engine
// carries four, each with an id, a version, and a Chinese and an English title and body. MIN-228
// D3 fixed the set at four; MIN-229 D6 supplied batch v2, and the INIT-053 Owner supplement adds communication and waiting at v3.
//
// The Chinese texts are the Owner's final wording, word for word. tests/fixtures/rules/ holds
// copies of them, and tests/rules-catalog.test.mjs compares each constant here with its copy, so
// an edit to either side is a red test rather than a quiet drift. The English text of
// silent-reporting is the Owner's final translation as well, apart from its last sentence (below).
// The English texts of autonomy, batch and unattended-commands were translated when this module
// was written and await the Owner's correction; a correction changes the text here and nothing else.
//
// INIT-053 R40 (the Owner's third supplement of 2026-10-08): the Owner revised two texts at the
// same version, recorded as rev 2 of their sections in the Owner's own AGENTS.md. Batch v3 gains
// clause 7 ("once" counts per round) and silent-reporting v1 gains its last sentence (no report
// between rounds). Both Chinese texts equal the Owner's archived wording; the English of the two
// additions is an agent's translation that awaits the Owner's correction. As with every correction,
// the versions stay: a project that enabled batch v3 or silent-reporting v1 still reads enabled, an
// unchanged section of it takes the revised text at its next agents-render with its section
// revision raised by one, and a section the user changed is left as it is and waits (pending).
//
// INIT-053 R48 (MIN-242 D10, the Owner's fifth round): batch v3 gains clause 8 (knowledge is
// captured per round), recorded as rev 3 of its section in the Owner's own AGENTS.md. The Chinese
// text equals the Owner's archived wording again; the English of clause 8 is an agent's translation
// that awaits the Owner's correction. The version stays at 3, with the same consequences as above.
//
// INIT-053 R52 (MIN-246 D11): batch v3 gains the merging of small rounds at the end of clause 6 (a
// round with at most two implementation packages or one acceptance slice has one main-tier agent
// do acceptance and judgment, and a round without an implementation package dispatches no
// decomposition or acceptance agent) and clause 9 (evidence is read in excerpts), recorded as rev 4
// of its section in the Owner's own AGENTS.md. The Chinese text equals the Owner's archived wording
// again; the English of both additions is an agent's translation that awaits the Owner's
// correction. The version stays at 3, with the same consequences as above.
//
// TCRN-CROSS-STORY-540 (MIN-258 D3(c), MIN-259 D1): the Owner's two immediate rules join the
// catalog at v1 after design-authority, the fifth (INC-399 R6): residue-cleanup and goal-writing,
// seven rules in all. Their Chinese texts are the Owner's wording in part two, section eight of the
// Owner's own AGENTS.md, word for word under the catalog's heading. The English of residue-cleanup
// is an agent's translation that awaits the Owner's correction. The three clauses of goal-writing
// are the English original of TCRN-CROSS-INC-225 that the Owner adopted, without the last sentence
// of its clause 3, which the Chinese does not carry; its opening paragraph is an agent's
// translation that awaits the Owner's correction.
//
// TCRN-CROSS-STORY-541 (MIN-258 D3, MIN-259 D2): unattended-commands rises to v2. Clause 1 gains
// one sentence: with the Owner's authorization, the trash-empty tool that ships with the skill
// empties the named trash directories under the session's scratch directory, and each
// authorization covers one report of their paths and sizes. Everything else is v1 word for word.
// The Chinese sentence is the wording the Owner agreed to; its English is an agent's translation
// that awaits the Owner's correction. A new version is not a correction: a project that enabled
// v1 reads update-available and keeps its v1 section until rule-enable takes v2.
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
export const BUILT_IN_RULE_IDS = Object.freeze(["autonomy", "batch", "unattended-commands", "silent-reporting", "design-authority", "residue-cleanup", "goal-writing"] as const);
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
6. 派工按批段。拆分一个代理，实施每包一个代理，集成一个代理，验收一个代理，验收可按 Epic 分片同批并行。不为单步派代理，不为确认读数派代理。小轮合并：本轮实施包不超过 2 个或验收只有一片时，验收与判断由一个主力档代理一次完成，仍按原格式写验收、判断与 lessons 三份文件，并顺带写出下一轮的拆分文件，不另派拆分代理；验收两片以上的轮维持验收分片并行、判断单独、拆分单独。没有实施包、只有链写或文档动作的轮，不派拆分与验收代理，主线程完成动作后派一个主力档代理读回并判断。
7. 「一次」按轮计，不是整个会话只做一轮。一轮（一个批次）内，拆分、每包实施、集成、名册、验收、判断各做一遍，不逐红重复；一轮做完，判断列出的问题清单与排队项就是下一轮的输入，loop 立即开下一轮（R41、R42……），直到 goal 写明的终态达成，或剩余工作全部阻塞于只有 Owner 能做的决定。轮与轮之间不等 Owner 答复、不换会话、不汇报。
8. 知识采集按轮。每轮的单名判断代理在判断报告旁产出 lessons.json：每条含 subject、summary、snippet、body、tags 与来源证据路径，只写本轮新确立的事实与教训，不超过 5 条；主线程在同一轮的链写里用引擎 knowledge-capture 逐条落卡并读回，卡被预算拒绝就记阻塞、迁移后补写。不依赖 Stop 钩子的标记行采集。
9. 证据按摘录读。治理代理与主线程只读派工指明的摘录文件、节号或行号范围，不整读拆分、计划、判断、台账与 routing 文件；工具输出先写进文件再按需读入，每次不超过 200 行；超过 32 KB 的文件不整读，宿主的读取守卫会拒绝并给出改法。

修完一条又红一条的循环，本身就是违反本原则的信号：停下，把清单列全，再动手。

### 代理通信与等待

1. 子代理按包交付。普通进度、阶段小结、可延后的问题集中在完成时报告；已有宿主完成通知时，不再用 send_message 重复发送同一结果。派工时确保子代理收到本条约束。
2. 中途通信限定例外。安全问题、无法继续的硬阻塞，以及不立即协调就会阻塞其他代理的依赖或冲突，可以立即上报；保留解决这些问题所需的事实澄清，不禁止必要通信。
3. 主代理减少往返。不回复纯确认，不催问普通进度；收到需要决策或行动的信息时直接处理。普通状态消息不触发额外的全体状态查询或重复汇报。
4. 等待避免空轮询。使用宿主支持的完成通知与阻塞等待；连续没有新状态时延长查询间隔，遵守宿主等待上限和用户中断要求；有独立可做的工作时继续该工作。
`;

// Translated when this module was written, clause 7 with the Owner's revision (INIT-053 R40),
// clause 8 with the Owner's fifth round (INIT-053 R48, MIN-242 D10), and the end of clause 6 and
// clause 9 with MIN-246 D11 (INIT-053 R52); awaits the Owner's correction.
const BATCH_EN = `## Batch Processing Principle v3

This applies to all work in this workspace: decomposition, implementation, running gates, testing, acceptance, chain writes, reporting and dispatch.

1. The unit of a batch. All open Stories under one INIT form one batch. One subagent does the whole decomposition in one pass, and every Subtask states the files it changes and what it depends on. New work found during a batch goes on this batch's problem list and into the next batch; it is not inserted into this one.
2. Implementation runs in parallel packages. Once decomposition is done, group the Subtasks into packages first: Subtasks that depend on one another or change the same files go into the same package and are done in order within it; Subtasks that do not affect one another each form a package of their own. Each package goes to one economy-tier subagent, which works in its own worktree and branch, and several packages run at the same time. The concurrency limit is execution.maxConcurrentSubagents; when that value exceeds the host's limit or is not set, dispatch by the host's rules. A package retires as soon as it is finished: it runs no gates, does no acceptance and writes nothing to the chain. When every package is finished, merge them into the integration branch in dependency order and hand any conflicts to one integration subagent.
3. Record red results; do not fix them. When gates, tests or acceptance within a batch turn up a red result or a defect, it only goes on this batch's problem list: do not stop to fix it, do not rerun gates for it, and do not open a work item for each one. Once the merge is done, run the gates once and acceptance once at the end of the batch, dispose of the whole list in one pass, and after that run the relevant gates once more. Several findings with one root cause count as one. Only two things may interrupt a batch: a safety refusal, and a hard blocker that makes further work impossible.
4. Generated output is regenerated at the end of the batch. Tool-generated things such as coverage baselines, proof artifacts, hook renderings and budget-ceiling raises are each done once at the end of the batch as a fixed closing step, not redone with every individual change.
5. One chain write and one report per batch. Status transitions and annotations are written in one pass through the batch entry point. Items awaiting the Owner's decision are listed together in the closing report, each with a recommendation. Items that do not block the work are done first as recommended; the report echoes the choices made, and the Owner corrects them afterwards.
6. Dispatch follows the batch stages. One agent for decomposition, one agent per package for implementation, one agent for integration and one agent for acceptance; acceptance may be split by Epic and run in parallel within the same batch. Do not dispatch an agent for a single step, and do not dispatch an agent to confirm a reading. Merging small rounds: when a round has no more than 2 implementation packages or only one acceptance slice, one main-tier agent does acceptance and judgment in one pass, still writes the three files of acceptance, judgment and lessons in their usual format, and writes the next round's decomposition file along the way, so no separate decomposition agent is dispatched; a round with two or more acceptance slices keeps acceptance split and run in parallel, with judgment and decomposition each done on their own. A round with no implementation package, only chain writes or documentation actions, dispatches no decomposition or acceptance agent: once the main thread has completed the actions, it dispatches one main-tier agent to read them back and judge.
7. "Once" counts per round, not once for the whole session. Within a round (one batch), decomposition, the implementation of each package, integration, the gate roster, acceptance and judgment are each done once, not repeated for every red result. When a round is done, the problem list and the queued items that the judgment lists are the input to the next round, and the loop starts the next round at once (R41, R42 and so on), until the end state written in the goal is reached or all remaining work is blocked on decisions only the Owner can make. Between rounds, do not wait for the Owner's reply, do not change sessions, and do not report.
8. Knowledge is captured per round. Beside its judgment report, each round's one judgment agent produces lessons.json with at most 5 entries, each carrying subject, summary, snippet, body, tags and the paths of its source evidence, and holding only facts and lessons newly established in that round. In the same round's chain write, the main thread records the entries one by one as cards with the engine's knowledge-capture and reads each one back; a card the budget refuses is recorded as blocked and written after the migration. Capture does not rely on the Stop hook's marker lines.
9. Evidence is read in excerpts. Governance agents and the main thread read only the excerpt files, section numbers or line ranges that the dispatch names, and do not read decomposition, plan, judgment, ledger or routing files whole; tool output is first written to a file and then read in as needed, no more than 200 lines at a time; a file larger than 32 KB is not read whole, and the host's read guard refuses such a read and says how to read it instead.

A cycle in which fixing one red result turns up another is itself a sign that this principle is being broken: stop, list everything, then act.

### Agent communication and waiting

1. Subagents deliver complete packages. Report ordinary progress, stage summaries and deferrable issues together when the package is complete. When the host already sends a completion notification, do not repeat the same result through send_message. Include this constraint when dispatching subagents.
2. Limit communication during a package to necessary exceptions. Immediately report safety issues, hard blockers that prevent further work, and dependencies or conflicts that would block other agents without immediate coordination. Keep the factual clarification needed to resolve these issues; necessary communication remains allowed.
3. The main agent reduces round trips. Do not reply with pure acknowledgments or ask for ordinary progress. Act directly on information that needs a decision or action. Ordinary status messages do not trigger extra queries of every agent's status or repeated reports.
4. Avoid empty polling while waiting. Use completion notifications and blocking waits supported by the host. Lengthen query intervals when there is repeatedly no new state, respect the host's wait limit and user interruption requirements, and continue independent work when it is available.
`;

const UNATTENDED_COMMANDS_ZH = `## 无人值守指令原则 v2

无人值守时，弹出确认框等于停摆：确认框不返回错误，会话只是无限等待。凡是可能弹框的写法按禁止处理，改用等价写法，不要先试试看。

1. 删除改为移动。要清掉的文件或目录先 mv 到本会话 scratch 目录下的 trash 子目录。仓库里已跟踪的文件用 git rm。不用 rm 与 rmdir。经 Owner 授权后，用技能自带的 trash-empty 工具清空会话 scratch 下点名的 trash 目录（只删名为 trash 或 trash-<名>、位于给定 scratch 根下、不是符号链接的目录，先列计划再执行）；授权的粒度为每次汇报列出路径与体积、Owner 答复一次。
2. 命令里不 cd。一律绝对路径。对别的目录跑 git 用 git -C 那个目录。
3. 只写工作目录与 scratch 目录。要在别处建克隆或镜像，先用启动参数或 /add-dir 把那个目录加入会话再动手。
4. 权限规则里 deny 或 ask 列出的路径与命令一概不碰，也不把它们复制到别处再处理。
5. 弹了框的写法不重试。记入本批问题清单，换等价写法继续。

宿主说明。Claude Code：rm 或 rmdir 指向根目录、home、工作目录本身会弹框，cd 进另一个目录再跑 git 会弹框，两者在 bypass 下同样弹。
`;

// Translated when this module was written, and the sentence clause 1 gains at v2 (MIN-259 D2) is an
// agent's translation as well; awaits the Owner's correction.
const UNATTENDED_COMMANDS_EN = `## Unattended Commands Principle v2

When running unattended, a confirmation dialog is a stall: the dialog returns no error, and the session simply waits forever. Treat every way of writing a command that might raise a dialog as forbidden and use an equivalent form instead; do not try it first to see what happens.

1. Move instead of deleting. To clear away a file or directory, first mv it into the trash subdirectory of this session's scratch directory. For files a repository tracks, use git rm. Do not use rm or rmdir. With the Owner's authorization, empty the named trash directories under the session's scratch directory with the trash-empty tool that ships with the skill (it deletes only directories named trash or trash-<name> that sit under the given scratch root and are not symbolic links, and it lists its plan before it acts); each authorization covers one report that lists the paths and sizes, answered once by the Owner.
2. No cd in commands. Always use absolute paths. To run git against another directory, use git -C with that directory.
3. Write only to the working directory and the scratch directory. To create a clone or a mirror somewhere else, first add that directory to the session with a launch argument or /add-dir, and only then begin.
4. Never touch a path or command that the permission rules list under deny or ask, and do not copy them elsewhere to deal with them there.
5. Do not retry a form that raised a dialog. Record it on this batch's problem list and carry on with an equivalent form.

Host notes. Claude Code: rm or rmdir aimed at the root directory, home or the working directory itself raises a dialog, and so does running git after a cd into another directory; both raise a dialog under bypass as well.
`;

const SILENT_REPORTING_ZH = `## 静默汇报原则 v1

工作进行期间，主对话不输出汇报。子代理之间的切换、派工、落链、跑门，回合里只有工具调用，没有进度文字，也没有一行小结。需要留痕的事实由发现它的子代理写进状态文件。

只有两种时刻输出汇报：全部任务完成，或剩余任务全部阻塞。汇报按 owner-output-contract 写，待 Owner 决定的事项一次列全并附建议。安排唤醒源不算汇报。一轮做完、下一轮开始之间不算这两种时刻，同样不汇报。
`;

// The Owner's final translation, except its last sentence: the Owner's revision (INIT-053 R40)
// added it in Chinese, and the English here is an agent's translation that awaits the Owner's correction.
const SILENT_REPORTING_EN = `## Silent Reporting Principle v1

While work is in progress, the main conversation produces no reports. Between subagents, when dispatching, writing to the chain, or running gates, a turn contains tool calls only: no progress prose, no one-line summaries. Facts that must be kept are written to the state file by the subagent that found them.

Reports are produced at exactly two moments: when every task is complete, or when every remaining task is blocked. A report follows the owner-output-contract and lists every item awaiting the Owner's decision at once, each with a recommendation. Scheduling a wake-up does not count as a report. The time between finishing one round and starting the next is not one of these two moments, so no report is produced then either.
`;

const DESIGN_AUTHORITY_ZH = "## \u8bbe\u8ba1\u6743\u5a01\u4e0e\u4e00\u81f4\u6027\u539f\u5219 v1\n\n1. \u5148\u786e\u5b9a\u8bbe\u8ba1\u6743\u5a01\u3002\u8bfb\u53d6\u5f53\u524d\u9879\u76ee\u53ca\u76ee\u6807\u5b50\u9879\u76ee\u7684\u7cfb\u7edf\u53d8\u91cf `design.authority`\uff0c\u4ee5\u53ca\u540c\u4e00\u914d\u7f6e\u4e2d\u58f0\u660e\u7684\u6743\u5a01\u4ed3\u5e93\u3001\u751f\u4ea7\u6587\u6863\u548c\u6784\u5efa\u90e8\u7f72\u7ed1\u5b9a\u3002\u6bcf\u4e2a\u9879\u76ee\u3001\u5b50\u9879\u76ee\u90fd\u5e94\u80fd\u5bf9\u5e94\u5230\u81ea\u5df1\u7684\u6709\u6548\u6743\u5a01\uff1b\u7ee7\u627f\u503c\u987b\u663e\u793a\u6765\u6e90\u3002\u7f3a\u5931\u6216\u51b2\u7a81\u65f6\u5148\u8865\u9f50\u914d\u7f6e\uff0c\u4e0d\u6309\u76ee\u5f55\u4f4d\u7f6e\u3001\u9876\u5c42\u9879\u76ee\u6216\u8bb0\u5fc6\u731c\u6d4b\u3002\n2. \u5148\u67e5\u5df2\u6709\u7ec4\u4ef6\u4e0e\u89c4\u8303\u3002\u6839\u636e\u8be5\u6743\u5a01\u7684\u5df2\u53d1\u5e03\u5951\u7ea6\uff0c\u6838\u5bf9\u7ec4\u4ef6\u5bb6\u65cf\u3001\u53d8\u4f53\u3001\u72b6\u6001\u3001\u5e03\u5c40\u548c\u4ea4\u4e92\u89c4\u8303\uff0c\u518d\u51b3\u5b9a\u5982\u4f55\u5b9e\u73b0\u3002\u5df2\u6709\u80fd\u529b\u76f4\u63a5\u590d\u7528\uff1b\u7f3a\u5c11\u80fd\u529b\u8bb0\u5165\u8bbe\u8ba1\u6743\u5a01\u7684\u6539\u52a8\u8303\u56f4\u3002\n3. \u8bbe\u8ba1\u6743\u5a01\u5148\u6539\u3002\u4efb\u4f55\u7ec4\u4ef6\u3001\u89c6\u89c9\u8bbe\u8ba1\u6216\u8bbe\u8ba1\u89c4\u8303\u7684\u65b0\u589e\u4e0e\u6539\u52a8\uff0c\u5148\u5411\u6743\u5a01\u4ed3\u5e93\u63d0 PR\uff0c\u5728\u6743\u5a01\u4e2d\u8865\u9f50\u5b9e\u73b0\u3001\u8bbe\u8ba1\u89c4\u8303\u3001\u5b9e\u9645\u793a\u4f8b\u548c\u9002\u7528\u9a8c\u8bc1\uff1b\u4e0d\u5f97\u5148\u5728\u5e94\u7528\u4e2d\u53e6\u9020\u4e00\u5957\u518d\u8865\u89c4\u8303\u3002\n4. \u53d1\u5e03\u901a\u8fc7\u540e\u518d\u63a5\u5165\u3002\u6743\u5a01 PR \u5408\u5e76\u3001\u58f0\u660e\u7684\u751f\u4ea7\u6587\u6863\u6216\u7ec4\u4ef6\u5e93\u53d1\u5e03\u6210\u529f\u3001\u58f0\u660e\u7684\u6784\u5efa\u90e8\u7f72\u670d\u52a1\u6210\u529f\uff0c\u5e76\u6838\u5bf9\u8fd9\u4e9b\u8bc1\u636e\u5bf9\u5e94\u540c\u4e00\u63d0\u4ea4\u6216\u4ea7\u7269\u7248\u672c\u540e\uff0c\u5e94\u7528\u624d\u80fd\u63a5\u5165\u65b0\u80fd\u529b\u3002\u672c\u5730\u901a\u8fc7\u3001\u9884\u89c8\u90e8\u7f72\u6216\u53ea\u6709\u9875\u9762\u80fd\u6253\u5f00\uff0c\u90fd\u4e0d\u4ee3\u8868\u751f\u4ea7\u53d1\u5e03\u901a\u8fc7\u3002\u8fd9\u4e2a\u53d1\u5e03\u4f9d\u8d56\u5e94\u5728\u6279\u6b21\u5206\u5305\u65f6\u660e\u786e\uff0c\u672a\u6ee1\u8db3\u65f6\u4e0d\u8d8a\u8fc7\u4f9d\u8d56\u3002\n5. \u4fdd\u6301\u7ec4\u4ef6\u5bb6\u65cf\u4e00\u81f4\u3002\u65b0\u589e\u548c\u4fee\u6539\u7684\u7ec4\u4ef6\u6cbf\u7528\u539f\u5bb6\u65cf\u7684\u989c\u8272\u3001\u5b57\u4f53\u3001\u95f4\u8ddd\u3001\u5c3a\u5bf8\u3001\u5706\u89d2\u3001\u8fb9\u6846\u3001\u56fe\u6807\u3001\u52a8\u6548\u53ca\u4ea4\u4e92\u72b6\u6001\uff1b\u589e\u91cf\u529f\u80fd\u6cbf\u7528\u5df2\u6709\u9009\u7528\u65b9\u5f0f\u3001\u53cd\u9988\u548c\u952e\u76d8\u64cd\u4f5c\u3002\u7528\u540c\u7c7b\u7ec4\u4ef6\u9010\u9879\u5bf9\u7167\uff0c\u907f\u514d\u4ea7\u751f\u660e\u663e\u4e0d\u540c\u7684\u89c6\u89c9\u6216\u4ea4\u4e92\u8bed\u8a00\uff1b\u8f83\u5927\u7684\u98ce\u683c\u53d8\u5316\u5148\u53d6\u5f97 Owner \u660e\u786e\u540c\u610f\u3002 \u628a\u660e\u663e\u504f\u79bb\u539f\u5bb6\u65cf\u7684\u5b9e\u73b0\u8865\u8fdb\u8bbe\u8ba1\u6743\u5a01\uff0c\u4e0d\u80fd\u4f5c\u4e3a\u98ce\u683c\u4e00\u81f4\u6216 Owner \u76ee\u89c6\u901a\u8fc7\u7684\u8bc1\u660e\u3002 \u68c0\u67e5\u5168\u90e8\u65b0\u589e\u6216\u4fee\u6539\u7684\u7ec4\u4ef6\u4e0e\u53d8\u4f53\uff1a\u540c\u7c7b\u4efb\u52a1\u5e94\u4f7f\u7528\u540c\u7c7b\u63a7\u4ef6\uff0c\u4fdd\u6301\u9009\u62e9\u3001\u5bfc\u822a\u3001\u4fdd\u5b58\u3001\u64a4\u9500\u3001\u91cd\u7f6e\u3001\u9519\u8bef\u53cd\u9988\u548c\u952e\u76d8\u64cd\u4f5c\u7684\u542b\u4e49\u4e0e\u9884\u671f\u4e00\u81f4\u3002\n6. \u901a\u8fc7\u6b63\u5f0f\u5951\u7ea6\u6d88\u8d39\u3002\u5e94\u7528\u4f7f\u7528\u5df2\u53d1\u5e03\u7ec4\u4ef6\u3001\u4ee4\u724c\u6216\u6743\u5a01\u8ba4\u53ef\u7684\u9759\u6001\u6d88\u8d39\u65b9\u5f0f\uff0c\u7ed1\u5b9a\u5b9e\u9645\u7248\u672c\u5e76\u540c\u6b65\u751f\u6210\u7684\u5951\u7ea6\u4e0e\u6837\u5f0f\u5feb\u7167\uff1b\u4e0d\u590d\u5236\u6587\u6863\u7ad9\u79c1\u6709\u6837\u5f0f\u3001\u4e0d\u5728\u5e94\u7528\u5185\u91cd\u9020\u901a\u7528\u7ec4\u4ef6\u3001\u4e0d\u7528\u5c40\u90e8\u8986\u76d6\u63a9\u76d6\u6743\u5a01\u7f3a\u53e3\u3002\n7. \u6838\u5bf9\u73b0\u5b58\u7f3a\u53e3\u3002\u53d1\u73b0\u5e94\u7528\u5df2\u4f7f\u7528\u6743\u5a01\u672a\u63d0\u4f9b\u6216\u672a\u53d1\u5e03\u7684\u7ec4\u4ef6\u3001\u53d8\u4f53\u3001\u8bbe\u8ba1\u89c4\u8303\u65f6\uff0c\u5217\u51fa\u4f7f\u7528\u5904\u548c\u7f3a\u5c11\u7684\u6743\u5a01\u8bc1\u636e\uff0c\u5148\u6309\u540c\u4e00 PR\u3001\u751f\u4ea7\u53d1\u5e03\u548c\u6784\u5efa\u6d41\u7a0b\u8865\u9f50\u6743\u5a01\uff0c\u518d\u7ee7\u7eed\u53d7\u5f71\u54cd\u7684\u5e94\u7528\u6539\u52a8\u3002\u673a\u5668\u9a8c\u8bc1\u4e0e Owner \u76ee\u89c6\u9a8c\u6536\u5206\u522b\u8bb0\u5f55\u3002\n8. \u89c4\u5219\u4e0e\u53d8\u91cf\u5206\u79bb\u3002\u89c4\u5219\u6b63\u6587\u53ea\u5f15\u7528\u7cfb\u7edf\u53d8\u91cf\u53ca\u5176\u6743\u5a01\u5951\u7ea6\uff0c\u4e0d\u5199\u6b7b\u9879\u76ee\u540d\u3001\u4ed3\u5e93\u5730\u5740\u3001\u6587\u6863 URL\u3001\u90e8\u7f72\u5382\u5546\u3001\u7248\u672c\u53f7\u6216\u7ec4\u4ef6\u6570\u503c\u3002\u5f53\u524d\u9879\u76ee\u4f7f\u7528\u7684\u5177\u4f53\u503c\u5c5e\u4e8e\u9879\u76ee\u6216\u5b50\u9879\u76ee\u914d\u7f6e\uff1b\u914d\u7f6e\u80fd\u529b\u5c1a\u672a\u5b9e\u73b0\u6216\u8bc1\u636e\u65e0\u6cd5\u8bfb\u53d6\u65f6\uff0c\u660e\u786e\u8bb0\u5f55\u4e3a\u672a\u914d\u7f6e\u6216\u672a\u9a8c\u8bc1\u3002\u63d0\u4ea4\u548c\u53d1\u5e03\u52a8\u4f5c\u4f7f\u7528\u5f53\u524d\u4efb\u52a1\u5df2\u7ecf\u83b7\u5f97\u7684\u6388\u6743\u3002\n";
const DESIGN_AUTHORITY_EN = "## Design Authority and Consistency Principle v1\n\n1. Resolve the design authority first. Read the current project's and target subproject's system variable `design.authority`, together with the authority repository, production documentation, and build and deployment bindings declared in the same configuration. Each project and subproject must resolve to its own effective authority; inherited values must identify their source. Resolve missing or conflicting bindings before design work, without guessing from directory placement, the parent project, or memory.\n2. Inspect existing components and standards. Use the authority's published contract to identify component families, variants, states, layouts, and interactions before implementation. Reuse existing capabilities and include missing ones in the authority's change scope.\n3. Change the authority first. Every addition or change to a component, visual design, or design standard starts with a PR to the authority repository, covering implementation, standards, working examples, and applicable validation. Do not create a separate design in the application and document it afterwards.\n4. Consume changes after production succeeds. The application may use the new capability only after the authority PR is merged, its declared production documentation or component library is published successfully, and its declared build and deployment service succeeds, with all evidence bound to the same source commit or artifact version. A local pass, preview deployment, or reachable page does not establish production success. Include this dependency when organizing the batch and do not consume the change before it is satisfied.\n5. Keep component families consistent. Preserve the family's colors, typography, spacing, sizing, radii, borders, icons, motion, and interaction states. Added features follow existing selection, feedback, and keyboard patterns. Compare equivalent components directly to prevent a substantially different visual or interaction language; obtain explicit Owner agreement before a substantial style change. Adding a substantially divergent implementation to the authority does not establish family consistency or Owner visual acceptance. Check every added or changed component and variant: equivalent tasks use equivalent controls, with consistent meanings and expectations for selection, navigation, saving, undoing, resetting, error feedback, and keyboard interaction.\n6. Consume the published contract. Use published components, tokens, or an authority-approved static consumption method, bind the actual version, and refresh generated contracts and stylesheet snapshots together. Do not copy documentation-only styles, recreate reusable components in the application, or conceal missing authority support with local overrides.\n7. Reconcile existing gaps. When the application already uses a component, variant, or design standard absent from the authority or its production release, identify the consumer locations and missing evidence. Complete the same authority PR, production publication, and build sequence before continuing affected application changes. Record machine verification and Owner visual acceptance separately.\n8. Separate rules from values. Reference system variables and their authority contracts in the rule body instead of hard-coding project names, repository addresses, documentation URLs, deployment vendors, versions, or component measurements. Store actual values in project or subproject configuration. Mark unavailable configuration capabilities or unreadable evidence as unconfigured or unverified. Use the current task's existing authorization for commits and publication.\n";

const RESIDUE_CLEANUP_ZH = `## 无效残余收尾原则 v1

Owner 于 2026-10-05 要求加入，适用于本工作区所有项目的实施、测试、验收、构建、派工与交付。清理是既有任务和批次的收尾义务，不另开规划轮、子代理或验收门；不授予跨项目清理、生产操作或变更既定执行方法的权限。

1. **创建者负责，主代理接续。** 创建临时目录、测试数据库、复制树、构建副本、依赖副本、工作树或后台进程时，在现有任务记录中明确归属与用途。子代理交付时说明已清理项和仍被消费的保留项；退役后由主代理承接剩余责任，不能因代理结束而留下无人管理的资源。
2. **按用途判定残余。** 只有确认属于本次获准范围、没有存活进程或打开文件占用、没有当前及待执行任务依赖，且可重建或已完成用途而无唯一数据需要保留的资源，才能清理。目录名含 \`tmp\`、\`cache\`、\`test\`，文件较旧或体积较大，都不能单独作为删除依据；共用缓存也不能按单个任务的临时文件处理。
3. **结束即收尾，失败也收尾。** 成功、失败、取消的批次在进程结束、证据采集及必要交接完成后，立即清理已无用途的副本，不等整个 INIT 全绿或部署完成。测试夹具通过 \`finally\` 或等价生命周期回收；失败时先保留必要的最小复现。异常中断留下的资源由恢复执行者优先核对，在下一轮大量复制前处理；阻塞或失败不构成永久保留整套副本的理由。
4. **证据与可重建副本分开。** 正式日志、结果、回执、清单、必要复现、唯一数据、当前交付输入、待部署产物和生产恢复资产，不按无用缓存删除。证据位于临时目录时，先识别实际引用并保留；已绑定的路径、字节、权限及引用关系不得擅自破坏，迁移或到期清除遵循既有保留契约。每个大体积保留项写明用途、消费方及可清理条件，不用“以后可能有用”无限期保留全部副本。
5. **限定清理边界。** 使用核实后的准确路径清单，检查真实路径、符号链接和嵌套仓库，防止越界；仅处理有权管理且已确认归属的资源。不递归清空整个项目、证据根或工作区，不清理其他项目、其他代理的活动资源、共享安装和生产备份。控制树仍只能通过引擎治理；归属或依赖不明时保留该项并说明原因，继续清理其他已确认项。
6. **工作树通过管理入口退出。** 删除工作树前确认交付已集成或有可靠保留位置，没有未提交、未跟踪的唯一内容，也没有后续任务或证据引用依赖。宿主管理的工作树使用宿主归档入口，普通工作树使用 Git 工作树管理入口；保留必要提交和忽略文件，不用强制删除绕过脏状态、共享占用或未完成交接。
7. **容量与下一轮接续。** 大量复制、构建或验收前，按实际需求和已知峰值检查可用容量，先处理已确认的历史残余。容量不足时停止依赖该容量的动作，保留其他可推进工作；不靠删除无关目录腾空间，也不继续复制直到磁盘耗尽。未知峰值如实记录，不编造足够空间的保证。
8. **核验实际结果，合并一次汇报。** 清理后复核删除范围、保留证据及绑定、Git 状态和进程状态；在现有收尾记录中留下简短的删除清单、保留原因及清理前后目录体积和文件系统可用空间。以 \`df\` 等实际读数报告可用空间变化；共享块、快照和并发写入的影响不明时说明限制，不把 \`du\` 总量或删除文件数等同于实际释放量。只结束进程、关闭代理或归档对话不算文件清理完成；部分保留或清理失败须明确回显，不重写历史验收结果。
`;

// MIN-259 D1: an agent's translation that awaits the Owner's correction.
const RESIDUE_CLEANUP_EN = `## Residue Cleanup Principle v1

Added at the Owner's request on 2026-10-05, this applies to implementation, testing, acceptance, building, dispatch and delivery in every project of this workspace. Cleanup is the closing duty of the task and batch already under way: it opens no planning round, subagent or acceptance gate of its own, and it grants no permission to clean across projects, to act on production, or to change an established execution method.

1. **The creator is responsible; the main agent takes over.** Whoever creates a temporary directory, test database, copied tree, build copy, dependency copy, worktree or background process records its owner and purpose in the existing task record. A subagent's handoff states what it cleaned and which kept items are still in use; once it retires, the main agent takes over the remaining responsibility, so no resource is left unmanaged because an agent ended.
2. **Judge residue by its purpose.** A resource may be cleaned only when it is confirmed to belong to the approved scope at hand, no live process or open file holds it, no current or pending task depends on it, and it can be rebuilt or has served its purpose with no unique data to keep. A directory name containing \`tmp\`, \`cache\` or \`test\`, an old file or a large one is never on its own a reason to delete; a shared cache is not to be treated as one task's temporary files.
3. **Clean up when work ends, and when it fails.** Once its processes have ended, its evidence is collected and the necessary handoff is done, a batch that succeeded, failed or was cancelled at once cleans up the copies it no longer needs, without waiting for the whole INIT to turn green or for deployment. Test fixtures are reclaimed through \`finally\` or an equivalent lifecycle; on failure, the minimal reproduction needed is kept first. Resources left by an abnormal interruption are checked first by whoever resumes the work and are dealt with before the next round copies in bulk; being blocked or failing is no reason to keep a whole set of copies forever.
4. **Keep evidence apart from copies that can be rebuilt.** Formal logs, results, receipts, manifests, needed reproductions, unique data, current delivery inputs, artifacts awaiting deployment and production recovery assets are not deleted as useless cache. When evidence sits in a temporary directory, its actual references are identified and kept first; bound paths, bytes, permissions and references are not broken at will, and moving or expiring them follows the existing retention contract. Each large kept item states its purpose, its consumer and when it may be cleaned; "it might be useful later" does not keep every copy forever.
5. **Bound what is cleaned.** Use a verified list of exact paths and check real paths, symbolic links and nested repositories so as not to go out of bounds; handle only resources you may manage and whose ownership is confirmed. Do not recursively empty a whole project, evidence root or workspace, and do not clean other projects, other agents' active resources, shared installations or production backups. Control trees are still governed only through the engine; where ownership or dependency is unclear, keep the item, say why, and go on cleaning the other confirmed items.
6. **Retire worktrees through their management entry.** Before deleting a worktree, confirm that its delivery is integrated or kept somewhere reliable, that it holds no uncommitted or untracked unique content, and that no later task or evidence reference depends on it. Use the host's archive entry for worktrees the host manages and Git's worktree commands for ordinary ones; keep the necessary commits and ignored files, and do not force a deletion past a dirty state, a shared use or an unfinished handoff.
7. **Capacity and the next round.** Before copying, building or accepting in bulk, check available capacity against actual need and the known peak, and deal with confirmed historical residue first. When capacity runs short, stop the actions that depend on it and keep the other work that can proceed; do not free space by deleting unrelated directories, and do not keep copying until the disk is full. Record an unknown peak as unknown; do not invent a guarantee of enough space.
8. **Verify the actual result and report it once.** After cleaning, recheck what was deleted, the evidence and bindings kept, the Git state and the process state; leave in the existing closing record a short list of what was deleted, why items were kept, and the directory sizes and file-system free space before and after. Report the change in free space from actual readings such as \`df\`; where the effect of shared blocks, snapshots or concurrent writes is unclear, say so, and do not equate a \`du\` total or a count of deleted files with space actually freed. Ending processes, closing agents or archiving a conversation does not complete file cleanup; partial keeps and failed cleanups are stated plainly, and historical acceptance results are not rewritten.
`;

const GOAL_WRITING_ZH = `## 目标书写契约 v1

Owner 于 2026-10-08 采纳 TCRN-CROSS-INC-225「FIX, TYPE LEVEL」三条（原文为英文，记录在该 Incident 的 scope），适用于本工作区所有会话级 goal 的书写与 /loop 的 goal 文本。

1. goal 只写可验证的工作终态：某个文件存在、某套测试全绿、某条记录已落链。goal 永不写授权或同意；授权在对话里表达，不是 goal 的子句，写进去只会造出工作方无法达到的条件。
2. 每条 goal 都带一个可满足的退出分支：「或：阻塞于只有 Owner 能做的决定，且阻点已经说明」。
3. 遇到言语行为条件（要求某人说过某句话才算满足）时，工作方解释一次，之后最简回复，并点明唯一出口。
`;

// MIN-259 D1: the three clauses are the English original of TCRN-CROSS-INC-225 that the Owner
// adopted, without the last sentence of its clause 3; the opening paragraph is an agent's
// translation that awaits the Owner's correction.
const GOAL_WRITING_EN = `## Goal Writing Contract v1

On 2026-10-08 the Owner adopted the three clauses of TCRN-CROSS-INC-225 "FIX, TYPE LEVEL" (the original is in English and recorded in that Incident's scope); they apply to how every session-level goal and every /loop goal text in this workspace is written.

1. A goal states a verifiable end state of work — a file exists, a suite is green, a record has landed. It never states authorization or agreement. Authorization is expressed in conversation and is not a goal clause; putting it in one creates a condition the working party cannot reach.
2. Every goal carries a satisfiable escape clause: "or: blocked on a decision only the Owner can make, and the blocking point has been stated".
3. On encountering a speech-act condition, the working party explains once, replies minimally thereafter, and names the single exit.
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
    2,
    { zh: "无人值守指令原则", en: "Unattended Commands Principle" },
    { zh: UNATTENDED_COMMANDS_ZH, en: UNATTENDED_COMMANDS_EN },
  ),
  builtIn("silent-reporting", 1, { zh: "静默汇报原则", en: "Silent Reporting Principle" }, { zh: SILENT_REPORTING_ZH, en: SILENT_REPORTING_EN }),
  builtIn("design-authority", 1, { zh: "\u8bbe\u8ba1\u6743\u5a01\u4e0e\u4e00\u81f4\u6027\u539f\u5219", en: "Design Authority and Consistency Principle" }, { zh: DESIGN_AUTHORITY_ZH, en: DESIGN_AUTHORITY_EN }),
  builtIn("residue-cleanup", 1, { zh: "无效残余收尾原则", en: "Residue Cleanup Principle" }, { zh: RESIDUE_CLEANUP_ZH, en: RESIDUE_CLEANUP_EN }),
  builtIn("goal-writing", 1, { zh: "目标书写契约", en: "Goal Writing Contract" }, { zh: GOAL_WRITING_ZH, en: GOAL_WRITING_EN }),
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
