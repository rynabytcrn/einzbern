// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-483 R1 (MIN-228 D3, MIN-229 D6): the Command Spell rules this engine ships
// with. A rule is a principle a project may switch on for the agents that work in it. The engine
// carries four, each with an id, a version, and a Chinese and an English title and body. MIN-228
// D3 fixed the set at four; MIN-229 D6 supplied batch v2, and the INIT-053 Owner supplement adds communication and waiting at v3.
//
// The historical Chinese texts are the Owner's wording; later supplements identify their source. tests/fixtures/rules/ holds
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
export const BUILT_IN_RULE_IDS = Object.freeze(["autonomy", "batch", "unattended-commands", "silent-reporting", "design-authority", "residue-cleanup", "goal-writing", "incremental-update", "privacy-publication"] as const);
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

// INIT-062 Owner supplements (2026-10-21): same-version clarifications of authorization
// counts and existing residue/branch responsibilities. The added wording implements the
// Owner's instructions; it is not a verbatim historical quotation. Keep the previous bodies
// in *-v1-rev1 fixtures. Enabled records stay enabled; managed render raises the section rev,
// while user-edited sections remain pending. Dot consumes these same bilingual additions.
export const AUTONOMY_AUTHORIZATION_BODY: RuleText = Object.freeze({
  "zh": "不得在模型自行拟定的方案、建议或授权请求中先加上「一次」「本次只做一次」等措辞，再将用户对整个方案的「同意」「继续」「按此执行」等一般答复推定为用户施加的授权次数上限。对原任务范围内的常规完成工作，只有用户在自己的指令中明确要求「临时授权一次」「仅执行一次」或其他等价的次数限制时，才能采用该限制；用户对模型方案的一般同意不等于明确施加其中由模型自行添加的次数限制。不得借这种写法人为耗尽授权，再反复请求同一范围内的继续许可。\n\n本条只校正授权次数的解释，不创造新的授权，也不撤销用户明确规定的对象、用途、时段、次数、预算或停止条件。平台要求的逐次确认、破坏性动作、权限变化，以及实际范围、目标、风险或对外影响的实质变化，仍按适用规则处理。实际拒绝不得通过更换工具、路径或身份绕过；只有出现实质新增且相关的证据、已确认该动作未执行、且现行规则允许时，才按适用的有限重试规则处理。结果不明先读回核实，不盲目重试；不得把本条解释为无限重试、无限外部执行或发布许可。",
  "en": "Do not add wording such as “once” or “just this one time” to a model-authored plan, proposal or authorization request and then infer from the user's general assent to the whole plan, such as “agreed”, “continue” or “proceed”, that the user imposed a limit on how many times authorization may be used. For ordinary work completing the original task within its scope, apply a count limit only when the user explicitly requests “temporary authorization for one execution”, “execute only once” or an equivalent restriction in the user's own instructions. General assent to a model-authored plan does not explicitly impose a count limit that the model itself inserted. Do not manufacture exhausted authorization this way and repeatedly ask for permission to continue within the same scope.\n\nThis clause corrects the interpretation of authorization counts only. It grants no new authorization and does not remove user-imposed limits on targets, purposes, time periods, counts, budgets or stopping conditions. Platform-required confirmation for each action, destructive actions, permission changes and material changes in actual scope, target, risk or external effect remain governed by the applicable rules. Never bypass an actual denial by changing tools, paths or identities. Only when materially new and relevant evidence exists, the action is known not to have executed and current rules permit it may the applicable bounded-retry rule be used. Read back an uncertain outcome before acting; do not retry blindly. This clause is not permission for unlimited retries, unlimited external execution or publication."
});

// INIT065 / MIN358 later Owner requirements, not a new rule or runtime gate.
export const AUTONOMY_RESTRICTION_SCOPE_BODY: RuleText = Object.freeze({
  "zh": "不设立非用户主动要求或明确批准的禁令。模型提出限制时，必须说明具体计划、动作、对象、适用范围、期限与解除条件，并取得用户对该项限制的明确批准；对整体方案的一般同意，不得扩展成永久或跨计划禁令。一次观察到的拒绝只说明其实际边界内的当时结果，不自动禁止无关动作或永久禁止后续工作。真实平台安全要求和工具权限拒绝仍须遵守，不得换工具、路径或身份绕过；结果不明先核对，后续重试依现行规则及实质新增相关证据判断。\n\n已有授权明确覆盖的常规治理落链与同步，不因数据持久化或目的地是外部存储本身，再要求用户重复确认；实际数据、目的地、范围、权限、风险或法律承诺发生实质变化时，仍按适用规则取得必要批准。此内置原则属于可选的自主运行规则，用户通过现有受支持的规则启用或停用入口决定是否采用；开关不创造授权，也不能关闭平台安全与真实权限边界。",
  "en": "Do not establish a prohibition unless the user actively requested or explicitly approved it. A proposed restriction must identify its specific plan, action, target, scope, duration and release conditions, and obtain explicit approval of that restriction. General agreement to a whole plan must not become a permanent or cross-plan prohibition. An observed refusal establishes the outcome within its actual boundary at that time, not a permanent ban or a ban on unrelated work. Actual platform safety requirements and tool permission denials still apply; never bypass them by changing tools, paths or identities. Reconcile uncertain results first; later retries follow current rules and materially new relevant evidence.\n\nRoutine governance recording and synchronization already covered by explicit authorization do not require redundant confirmation merely because data persists or the destination is external storage. Material changes in actual data, destination, scope, permission, risk or legal commitment still require applicable approval. This built-in principle belongs to the selectable autonomy rule; users choose whether to enable it through existing supported rule enable/disable entries. A toggle grants no authority and cannot disable platform safety or actual permission boundaries."
});

export const BRANCH_LIFECYCLE_BODY: RuleText = Object.freeze({
  "zh": "每个新批开始、推送前及相关 PR 合并后，刷新并核对实际基线、当前分支、工作树、上游默认分支与贡献目标的当前头及 ahead/behind；采用 fork 时还须核对 fork 默认分支，不能把旧检查或“可快进”判断当作已同步。仅在已有授权和现行权限内，对已证实可安全快进、无独有提交且无活动依赖冲突的同步目标执行同步，并读回实际目标头；有分叉、独有历史、冲突或未知项则保留并报告，不为归零计数而强推、reset、rebase、丢提交或制造同步合并。成功、失败或取消后均核对本批分支；仅当交付已合入已核验的目标、分支不再含目标中没有的独有提交、没有活动 PR、运行或待执行 CI、工作树、后续交付或证据引用依赖，且必要历史、备份和失败证据已有可靠保留位置时，才在对应本地或远端清理已获授权的范围内，通过正常 Git 或宿主管理入口清理逐条核实的退役分支，并读回本地引用及适用的远端头确认结果。内容相同或 squash 合并不单独证明独有历史已保全；工作树退役不等于其分支已删除。默认、受保护、备份或恢复分支不因本条被视为残余；未合并、含独有历史、仍被消费或归属和状态不明的分支继续保留，并记录归属、原因及可清理条件。不得按名称、年龄、ahead 数或通配符批量删分支，不强制删除绕过保护或脏状态，不删除必要证据或改写旧验收；本条不新增远端写入、合并、发布或永久删除权限。",
  "en": "At the start of each new batch, before pushing and after a related PR merges, refresh and check the actual baseline, current branch, worktree, upstream default branch, current contribution-target heads and ahead/behind state. For fork contributions, also check the fork's default branch. An old check or a finding that fast-forward is possible is not evidence that synchronization occurred. Within existing authorization and current permissions, synchronize only a target verified to permit a safe fast-forward, with no unique commits or conflicting active dependencies, and read back the actual target head. Preserve and report divergence, unique history, conflicts and unknowns; never force-push, reset, rebase, drop commits or manufacture a synchronization merge merely to zero a count. Audit this batch's branches after success, failure or cancellation. Clean an individually verified retired branch through normal Git or host management only when its delivery is merged into a verified target, the branch contains no unique commits absent from that target, no active PR, running or pending CI, worktree, later delivery or evidence reference depends on it, necessary history, backups and failure evidence have a reliable preservation location, and the corresponding local or remote cleanup is within existing authorization. Read back local refs and applicable remote heads to confirm the result. Identical content or a squash merge alone does not prove preservation of unique history; retiring a worktree does not mean its branch was deleted. Default, protected, backup and recovery branches are not residue under this clause. Keep unmerged branches, unique history, active consumers and branches with unknown ownership or status, recording their owner, retention reason and safe cleanup condition. Do not delete branches in bulk by name, age, ahead count or wildcard, force deletion past protection or dirty state, delete needed evidence or rewrite old acceptance results. This clause grants no new permission for remote writes, merges, publication or permanent deletion."
});

const AUTONOMY_ZH = `## 自主运行原则 v1

你在自主运行。使用者不在实时观看，无法在任务中途回答问题，所以问「要我……吗？」「是否继续？」只会让工作停摆。原始请求已涵盖的可逆动作，直接做。只有破坏性动作与真正的范围变更才停下来交给使用者定。任务做完后提出后续建议可以；动手前先请示不行。

${AUTONOMY_AUTHORIZATION_BODY.zh}

${AUTONOMY_RESTRICTION_SCOPE_BODY.zh}
`;

// Translated when this module was written; awaits the Owner's correction.
const AUTONOMY_EN = `## Autonomous Operation Principle v1

You are operating autonomously. The user is not watching in real time and cannot answer questions partway through a task, so asking "Do you want me to ...?" or "Should I continue?" only stalls the work. When a reversible action is already covered by the original request, just do it. Stop and leave the decision to the user only for destructive actions and genuine changes of scope. Suggesting follow-up work once the task is done is fine; asking for permission before you act is not.

${AUTONOMY_AUTHORIZATION_BODY.en}

${AUTONOMY_RESTRICTION_SCOPE_BODY.en}
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

const DESIGN_AUTHORITY_ZH = "## 设计权威与一致性原则 v1\n\n1. 先确定是否已配置设计权威。读取当前项目及目标子项目的系统变量 `design.authority`，以及同一配置中声明的权威仓库、生产文档和构建部署绑定。设计权威是可选项：项目或子项目未配置时，明确记录为未配置，且不阻塞不依赖设计权威的工作。模块身份本身不要求独立设计系统。配置了权威时，项目和目标子项目应解析各自的有效权威；继承值须显示来源。已声明绑定冲突或无法解析时，停止依赖该权威的设计工作，不按目录位置、顶层项目或记忆猜测。\n2. 先查已有组件与规范。根据已配置权威的已发布契约，核对组件家族、变体、状态、布局和交互规范，再决定如何实现。已有能力直接复用；缺少能力记入设计权威的改动范围。\n3. 设计权威先改。任何依赖已配置权威的组件、视觉设计或设计规范的新增与改动，先向权威仓库提 PR，在权威中补齐实现、设计规范、实际示例和适用验证；不得先在应用中另造一套再补规范。\n4. 发布通过后再接入。权威 PR 合并、声明的生产文档或组件库发布成功、声明的构建部署服务成功，并核对这些证据对应同一提交或产物版本后，应用才能接入新能力。本地通过、预览部署或只有页面能打开，都不代表生产发布通过。这个发布依赖应在批次分包时明确，未满足时不越过依赖。\n5. 保持组件家族一致。新增和修改的组件沿用原家族的颜色、字体、间距、尺寸、圆角、边框、图标、动效及交互状态；增量功能沿用已有选用方式、反馈和键盘操作。用同类组件逐项对照，避免产生明显不同的视觉或交互语言；较大的风格变化先取得 Owner 明确同意。把明显偏离原家族的实现补进设计权威，不能作为风格一致或 Owner 目视通过的证明。检查全部新增或修改的组件与变体：同类任务应使用同类控件，保持选择、导航、保存、撤销、重置、错误反馈和键盘操作的含义与预期一致。\n6. 通过正式契约消费。应用使用已发布组件、令牌或权威认可的静态消费方式，绑定实际版本并同步生成的契约与样式快照；不复制文档站私有样式、不在应用内重造通用组件、不用局部覆盖掩盖权威缺口。\n7. 核对现存缺口。发现应用已使用权威未提供或未发布的组件、变体、设计规范时，列出使用处和缺少的权威证据，先按同一 PR、生产发布和构建流程补齐权威，再继续受影响的应用改动。机器验证与 Owner 目视验收分别记录。\n8. 规则与变量分离。规则正文只引用系统变量及其权威契约，不写死项目名、仓库地址、文档 URL、部署厂商、版本号或组件数值。当前项目使用的具体值属于项目或子项目配置；项目或子项目可以没有设计绑定。配置能力尚未实现或证据无法读取时，明确记录为未配置或未验证。提交和发布动作使用当前任务已经获得的授权。\n";
const DESIGN_AUTHORITY_EN = "## Design Authority and Consistency Principle v1\n\n1. First determine whether a design authority is configured. Read the current project's and target subproject's system variable `design.authority`, together with the authority repository, production documentation, and build and deployment bindings declared in the same configuration. A design authority is optional: when a project or subproject has none, record it as unconfigured and do not block work that does not depend on a design authority. A module's identity does not itself require an independent design system. When an authority is configured, the project and target subproject must resolve their effective authority; inherited values must identify their source. When declared bindings conflict or cannot resolve, stop design work that depends on that authority, without guessing from directory placement, the parent project, or memory.\n2. Inspect existing components and standards. Use a configured authority's published contract to identify component families, variants, states, layouts, and interactions before implementation. Reuse existing capabilities and include missing ones in the authority's change scope.\n3. Change the authority first. Every addition or change to a component, visual design, or design standard that depends on a configured authority starts with a PR to the authority repository, covering implementation, standards, working examples, and applicable validation. Do not create a separate design in the application and document it afterwards.\n4. Consume changes after production succeeds. The application may use the new capability only after the authority PR is merged, its declared production documentation or component library is published successfully, and its declared build and deployment service succeeds, with all evidence bound to the same source commit or artifact version. A local pass, preview deployment, or reachable page does not establish production success. Include this dependency when organizing the batch and do not consume the change before it is satisfied.\n5. Keep component families consistent. Preserve the family's colors, typography, spacing, sizing, radii, borders, icons, motion, and interaction states. Added features follow existing selection, feedback, and keyboard patterns. Compare equivalent components directly to prevent a substantially different visual or interaction language; obtain explicit Owner agreement before a substantial style change. Adding a substantially divergent implementation to the authority does not establish family consistency or Owner visual acceptance. Check every added or changed component and variant: equivalent tasks use equivalent controls, with consistent meanings and expectations for selection, navigation, saving, undoing, resetting, error feedback, and keyboard interaction.\n6. Consume the published contract. Use published components, tokens, or an authority-approved static consumption method, bind the actual version, and refresh generated contracts and stylesheet snapshots together. Do not copy documentation-only styles, recreate reusable components in the application, or conceal missing authority support with local overrides.\n7. Reconcile existing gaps. When the application already uses a component, variant, or design standard absent from the authority or its production release, identify the consumer locations and missing evidence. Complete the same authority PR, production publication, and build sequence before continuing affected application changes. Record machine verification and Owner visual acceptance separately.\n8. Separate rules from values. Reference system variables and their authority contracts in the rule body instead of hard-coding project names, repository addresses, documentation URLs, deployment vendors, versions, or component measurements. Store actual values in project or subproject configuration; a project or subproject may have no design binding. Mark unavailable configuration capabilities or unreadable evidence as unconfigured or unverified. Use the current task's existing authorization for commits and publication.\n";

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
9. **分支生命周期与收尾。** ${BRANCH_LIFECYCLE_BODY.zh}
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
9. **Branch lifecycle and retirement.** ${BRANCH_LIFECYCLE_BODY.en}
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

// INIT062 B5: one versioned principle, with only the necessary transport paragraph
// adapted for dot. Catalog presence is not an enabled project rule or a published release.
const INCREMENTAL_OPEN_ZH = "先取得覆盖实际必需闭包的完整有效基线，再在明确范围内做最少必要读取和增量变更；完整性未知、基线失效或安全判断需要时，仍补必要全量核对，不把增量当作跳过验证的理由。所有工单、纪要、知识卡与受治理配置仍经受支持引擎入口变更，使用实际行动者并读回。";
const INCREMENTAL_CLOSE_ZH = "保留本机引擎互斥。共享标记仅告知占用、等待和交接，不授予跨设备原子排他；看不到标记不证明没有写入者。提交前核实当前写入者及本次串行交接，未知、占用或双写迹象只暂停受影响提交，不按超时擅自接管或删除标记。身份、基线、操作、发布和读回关联保存在动态记录，不放入本正文。增量原则不改变一个 INIT 全部待办 Story 的批单位、既定步骤、分包与角色。";
const INCREMENTAL_OPEN_EN = "Obtain a complete, valid baseline covering the necessary closure before making minimal reads and incremental changes within an explicit scope. Unknown completeness, an invalid baseline or a safety decision still requires the necessary full checks; incremental work never skips verification. Change work items, minutes, knowledge cards and governed configuration only through supported engine entries, using the actual actor and reading the receipts back.";
const INCREMENTAL_CLOSE_EN = "Preserve the local engine mutex. A shared marker only communicates occupancy, waiting and handoff; it grants no atomic exclusion across devices, and an absent marker does not establish that there is no writer. Confirm current writers and this operation's serial handoff before submitting. Unknown occupancy, an active writer or signs of concurrent writing pause only the affected submission; elapsed time never authorizes takeover or marker removal. Keep identity, baseline, operation, publication and readback associations in dynamic records, not in AGENTS. This principle does not change the batch unit of all open Stories under one INIT, its approved steps, packages or roles.";
const INCREMENTAL_UPDATE_ZH = `## 增量更新与共享提交原则 v1

${INCREMENTAL_OPEN_ZH}

一般同步目录宿主直接使用其已验证的同步工作目录，不增加无必要的下载或上传。在本地经引擎工作，提交前刷新一次完整基线，以受支持的重放或重应用合并本轮差异，再串行提交并核对目的端读回。不能手拼事件流、覆盖他人新事件，或把工作副本回执称为生产完成。

${INCREMENTAL_CLOSE_ZH}
`;
const INCREMENTAL_UPDATE_EN = `## Incremental Update and Shared Submission Principle v1

${INCREMENTAL_OPEN_EN}

Ordinary synchronized-directory hosts use their verified synchronized working directory directly, without unnecessary downloads or uploads. Work locally through the engine, refresh the complete baseline once before submission, merge this round's changes with supported replay or reapplication, submit serially and verify destination readback. Never splice event streams, overwrite another writer's new events or call a working-copy receipt production completion.

${INCREMENTAL_CLOSE_EN}
`;

/** The dot transport adaptation of the same incremental-update v1 source. */
export const INCREMENTAL_UPDATE_DOT_BODY: RuleText = Object.freeze({
  zh: `## 增量更新与共享提交原则 · incremental-update

${INCREMENTAL_OPEN_ZH}

一般同步目录宿主直接使用其已验证的同步工作目录；dot 仅在环境实际需要时取得完整副本，在本地经引擎工作，提交前刷新一次完整基线，再以受支持的重放或重应用合并本轮差异，串行提交并核对远端读回。不能手拼事件流、覆盖他人新事件，或把工作副本回执称为生产完成。

${INCREMENTAL_CLOSE_ZH}
`,
  en: `## Incremental Update and Shared Submission · incremental-update

${INCREMENTAL_OPEN_EN}

Ordinary synchronized-directory hosts use their verified working directory directly. Only when its environment requires transport does dot obtain a complete copy. Work locally through the engine, refresh the complete baseline once before submission, merge the round's changes with supported replay or reapplication, submit serially and verify remote readback. Never splice events, overwrite another writer's new events or call working-copy receipts production completion.

${INCREMENTAL_CLOSE_EN}
`,
});

/** INIT068 R21: one optional principle for both ordinary and independent dot consumers.
 * Wording implements the approved requirement, not a claim of verbatim historical text. */
export const PRIVACY_PUBLICATION_BODY = Object.freeze({
  zh: `## 隐私与发布身份原则 v1

1. 提交或发布前核验实际贡献者、获准使用的账号和作者/提交者身份；不得未经授权切换为 owner 或其他身份。需要隐私保护时使用已核验贡献者的 noreply 地址，不编造身份，不把某次任务指定账号固化为全局规则。
2. 按数据最小化审查将发布的源码、文档、生成物、附件及 Git 元数据；检查秘密、凭据和个人信息，不因内容来自工具或历史提交而豁免。仅保留任务必要且获准发布的数据。
3. 发布前运行实际适用的隐私检查，保存实际调用、结果和对应候选版本；检查通过、机器结构验证、原稿语义验收与发布授权互不替代。未执行、不可用或未知保持未验证，不以 passed 标签代替证据。
4. 检查失败时保留原分支、提交及失败证据，沿实际授权流程处理；不弱化门、不隐匿失败、不换身份绕过拒绝，不擅改远端历史。获准的本地身份元数据纠正须保留原件、源码树与提交顺序，随后重新核验相关检查。
5. 本原则不授予提交、推送、PR、身份重写、外部发布或额外工具权限。用户对一次任务的身份与操作授权不成为通用自动批准；真实拒绝和不明结果按现行权限与核实规则处理。
`,
  en: `## Privacy and Publication Identity Principle v1

1. Before committing or publishing, verify the actual contributor, the account authorized for publication, and author/committer identity. Never substitute the owner or another identity without authorization. When privacy requires it, use the verified contributor's noreply address; do not invent an identity or turn a task-specific account choice into a global rule.
2. Minimize and inspect the source, documents, generated outputs, attachments and Git metadata intended for publication for secrets, credentials and personal information. Tool output and historical commits are not exempt. Retain only necessary data authorized for that destination.
3. Before publication run the actually applicable privacy checks and retain their real invocation, result and candidate version. Passing checks, structural validation, source-semantic acceptance and publication authorization are separate. Not run, unavailable or unknown remains unverified; a passed label is not evidence.
4. On failure preserve the original branch, commits and failure evidence and follow the authorized repair process. Never weaken gates, hide failures, substitute identities to bypass a refusal or rewrite remote history without authorization. Authorized local identity-metadata correction preserves originals, source trees and commit order, then rechecks the affected checks.
5. This principle grants no commit, push, PR, identity-rewrite, external-publication or additional tool permission. Task-specific identity and action authorization is not universal automatic approval. Respect actual refusals and verify uncertain outcomes under the applicable permissions.
`,
});

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
  builtIn("incremental-update", 1, { zh: "增量更新与共享提交原则", en: "Incremental Update and Shared Submission Principle" }, { zh: INCREMENTAL_UPDATE_ZH, en: INCREMENTAL_UPDATE_EN }),
  builtIn("privacy-publication", 1, { zh: "隐私与发布身份原则", en: "Privacy and Publication Identity Principle" }, PRIVACY_PUBLICATION_BODY),
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
