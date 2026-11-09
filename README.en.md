<div align="center">

# Einzbern

The Grail grants wishes. Einzbern remembers the wishes you made, the decisions you took, and the traps you fell into,<br>and puts them in front of the model right before the prompt that needs them.

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-4.5.0-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

[What happened on Wednesday afternoon](#what-happened-on-wednesday-afternoon) · [What it remembers](#what-it-remembers) · [When you will want it](#when-you-will-want-it) · [Why this and not a memory plugin](#why-this-and-not-a-memory-plugin) · [Install](#install) · [Day to day](#day-to-day) · [Several devices and cloud folders](#several-devices-and-cloud-folders) · [How we use it ourselves](#how-we-use-it-ourselves) · [How we reduce your usage](#how-we-reduce-your-usage) · [Why it is designed this way](#why-it-is-designed-this-way) · [Glossary](#glossary)

</div>

<table>
<tr>
<td align="center" width="33%">

### 1
hook<br><sub>one lookup before every prompt, silent unless strongly relevant</sub>

</td>
<td align="center" width="33%">

### 0
runtime dependencies<br><sub>a single zero-dependency file, no database, no network</sub>

</td>
<td align="center" width="33%">

### 3
hosts, one memory<br><sub>Claude Code, Codex and DeepSeek Harness read the same Ether</sub>

</td>
</tr>
</table>

> [!TIP]
> No need to read it all first. Add Mana Orchestrate, tell your host "install Einzbern" inside the project, and the wizard asks one screen of questions.

---

## What happened on Wednesday afternoon

On Monday, in Claude Code, you settled something: the login page switches to the design system's new button, and the old style stays until 1.4.

On Wednesday, in Codex, you say "do the sign-up page while you're at it." Before it touches anything, three lines are already in its context: Monday's Story with its acceptance criteria, the decision that the old style stays until 1.4, and a card from last week: this component needs one extra property on Safari.

You pasted nothing and reminded no one to look. That is everything Einzbern does: write it down, bring it out at the right moment.

## A wish machine

The Grail is a wish machine: make a wish, get a result. Wish machines share one trait: a wish stated vaguely is very likely to come true as something other than what you wanted.

Einzbern follows that. It enforces exactly two things: a work item must state its goal, and it must state what counts as done. How it is written, split, and carried out is up to the model. Einzbern stays out of it.

Work items, knowledge, minutes, and variables are the mana flowing through this machine. They are fixed in place in one shared library at your chosen location called `Ether`, after ether, the medium that lets mana take a fixed form in the real world. The model draws from it before every prompt and writes back to it when work is done.

## What it remembers

**Wishes: work items.** Four levels: Initiative, Epic, Story, Subtask. A Story is the smallest complete intent, and it is the only level indexed. Relations between work items are fields, not prose: what blocks what, what implements what, what supersedes what, which minutes decided it.

> Story: switch the login button to the DS component. Acceptance: default, hover, and disabled states match Storybook.

**Decisions: minutes.** Your decisions, and the technical decisions the model makes. Every decision has a number; work items and cards cite it by number. The model is not asked to hold meetings, only to write decisions down.

> Minutes D3: keep the old button style until 1.4, remove in 1.5.

**Traps: knowledge.** One card holds one fact about the environment or one lesson: the kind of thing no work item or minutes carries as a field. The model decides what is worth keeping, and a card is searchable the moment it is written. An old card retires only when a new card contradicts it. Age is not a reason, and neither is capacity.

> Card: the DS button needs appearance: none on Safari, or the rounded corners are lost.

**Variables.** The model tier table per host, the project's design system address, and key-value pairs you define yourself. They are rendered into AGENTS.md, so when you write "implementation uses the main tier" in AGENTS.md, Claude Code and Codex each resolve it to their own model.

## How it reaches the model

Before every prompt is sent, the host hands it to the engine for one lookup. If something is strongly relevant, its headline goes into the context:

```
[Story done] Login button switched to DS component · Acceptance: three states match Storybook
[Minutes D3] Old button style stays until 1.4, removed in 1.5
[Card] DS button needs appearance: none on Safari
```

If nothing is strongly relevant, nothing happens. The model fetches full bodies itself when it needs them. When a piece of work is finished, the model writes the result back to the work item, records a decision if one was made, and writes a card if there was a lesson.

## When you will want it

- A task spans three days and five sessions, and the model on day four still knows what was settled on day one.
- You alternate between Claude Code, Codex and DeepSeek Harness and want all of them reading the same memory.
- An unattended batch runs overnight, and in the morning you can trace what each step did and which decision it followed.
- The desktop keeps working while you take the laptop out and continue.

Built for one person with several devices. Sharing one memory among several people is not done.

## Why this and not a memory plugin

Most memory solutions are a vector store or a stack of notes: they save fragments of conversation and fish them back by similarity. They remember what was said. Einzbern remembers what was decided, what is to be done, and what was learned, three kinds of record with their own structure, citing each other by number.

| What you need | A memory plugin | Einzbern |
|---|---|---|
| A decision and how it came about | A similar chat fragment | Numbered minutes; work items and cards point to them by number |
| How far a piece of work has got | Nothing | Four levels of work items; relations are fields: what blocks what, what supersedes what, which minutes decided it |
| Switching hosts | Each keeps its own | Claude Code, Codex and DeepSeek Harness read the same Ether |
| Switching devices | Manual sync, or none | Put it in a cloud folder; one stream per device; simultaneous writes never conflict |
| Looking and changing | Open files | Atelier: variables, rules, gate configuration and store state on one page; changes render into AGENTS.md at once |
| How the model works | Not the plugin's concern | Not policed; seven principles, off by default, chosen per project |
| Can the record be tampered with | Yes | An append-only hash chain; change one entry and everything after it stops matching |

Variables are the other half that sets it apart: the model tier table per host, the design system address, your own key-value pairs, all edited in Atelier and rendered into AGENTS.md, so one rule text resolves on each host to its own models.

## Install

Einzbern arrives through a skill: Mana Orchestrate. Mana is the memory in circulation; orchestrate is directing when it flows where. The skill teaches the model when to call which engine feature, and it carries the install wizard.

Install it with the skills command:

```
npx skills add tpmoonchefryan/mana-orchestrate
```

Or tell your host: find a skill called Mana Orchestrate and install it.

Then, in the project directory, say: install Einzbern. The wizard asks one screen of questions: fresh install or restore from an existing `Ether`, where the artifacts go, whether that folder is cloud-synced, which language, and whether to write a navigation section into AGENTS.md. It then lists every file it is about to write, and you confirm once. Update, repair, migrate from the previous version, uninstall, and health check are modes of the same wizard.

It does not commit, push, edit your .gitignore, or delete anything, and it touches the network only to download the engine.

## Day to day

You work as usual. Memory shows up on its own.

When you want to look or change something, open Atelier. A magus's workshop; here, a web page on your machine: which principles are enabled, what the variables are, how gates are configured, and the state of the memory store. It is not resident; open it when you need it.

AGENTS.md is yours. Einzbern writes only marked sections: the principles you enabled and the variables rendered for the model. Once you edit a section, it stops overwriting it, and you choose in Atelier what happens next.

There are seven built-in principles, called Command Spells, the commands a Servant cannot refuse. They are not mandatory: all are off by default, you enable them per project in Atelier, and memory works the same without them.

- Autonomous operation: no "shall I continue?" mid-task; reversible actions are simply done; only destructive actions and scope changes stop.
- Batch processing: the work items from one split are one batch; reds are recorded, not fixed on the spot; the batch end handles them once; one report per batch.
- Unattended commands: no command forms that raise confirmation dialogs; delete by moving, no cd inside commands, write only inside the working directory.
- Silent reporting: no reports while work is in progress; report only when everything is done or everything left is blocked.
- Design authority and consistency: read the project's design authority and its published component specifications first; component and visual changes go to the authority first and are taken up only once it is published; components of one kind stay consistent.
- Residue cleanup: whoever creates a temporary directory, copy, worktree or background process answers for it; when a batch ends, failed batches included, clear them by what they were for; keep evidence apart from copies that can be rebuilt.
- Goal writing contract: a goal states only a verifiable end state, never an authorization; every goal carries the exit "blocked on a decision only you can make".

## Several devices and cloud folders

`Ether` is the name of the shared-library folder. You choose its parent: a local disk, an external disk, or a synced folder such as OneDrive or iCloud. Projects remain distinct by identity inside one library, and later projects reuse the selected location by default. Events live in `akasha/<device-id>/`; caches, write locks and backups live in `Ether/.einzbern/<device-id>/`, separately for each device. Device identity, registry, host configuration and installed engines remain local in `~/.einzbern/`. Existing `.ether` libraries remain compatible.

## How we use it ourselves

This is how Einzbern develops itself, and the usage we suggest. You can adopt any one layer alone.

**Two conversations.** A design conversation on the flagship tier discusses direction with you, records decisions as minutes, and splits the work into Initiative, Epic and Story in Ether. An implementation conversation on the main tier reads the Stories from Ether and writes no code: it dispatches, records, runs gates and reports.

**One batch at a time.** The implementation conversation sends one economy-tier subagent to split every Story of the Initiative into Subtasks at once, each naming the files it touches and what it depends on. Then it packages by dependency and file overlap: related Subtasks go into one package in order, unrelated ones into packages of their own. Each package gets one economy-tier subagent working in its own git worktree, in parallel, retired when the package is done. When all packages are done, one integration subagent merges them in dependency order; gates run once and acceptance happens once at the end of the batch, and defects are reworked as a batch.

**All four principles of the time on.** Autonomous operation: reversible actions are simply done. Batch processing: reds are recorded, not fixed on the spot, and handled once at the batch end. Unattended commands: no command forms that raise confirmation dialogs. Silent reporting: report only when everything is done or everything left is blocked.

**You appear at two moments.** Deciding in the design conversation, and reading one report when the implementation conversation closes a batch, with every item awaiting your decision listed at once, each with a recommendation.

### Subscriptions and model tiers (as of 2026-09-26)

Suggested subscriptions: Claude Max 5x or ChatGPT Pro 5x. Set the parallel subagent cap by subscription; above the suggested value the weekly quota drains too fast. The cap is execution.maxConcurrentSubagents in Atelier.

| Subscription | Parallel subagent cap |
|---|---|
| Claude Pro or ChatGPT Plus | 1 or 2 |
| Claude Max 5x or ChatGPT Pro 5x | 3 |
| 20x plans | 8 or more |

More parallelism is not always better; when the quota runs low it should shrink on its own. Four system variables decide when, all edited in Atelier:

| Variable | Default | Meaning |
|---|---|---|
| quota.fiveHourParallelOffPercent | 75 | At this percentage of the 5-hour quota, the parallel subagent cap drops to 1 |
| quota.fiveHourWaitPercent | 90 | At this percentage of the 5-hour quota, no more subagents are dispatched until the window resets |
| quota.weeklyParallelOffPercent | 95 | At this percentage of the weekly quota, the parallel subagent cap drops to 1 |
| quota.weeklyWaitPercent | unset | No waiting threshold on the weekly quota; it only applies if you set it |

The table below preserves an example model configuration; it is not a set of defaults or workflow bindings. The actual models and reasoning effort are determined by the models.tiers you maintain in Atelier.

| Host | Flagship | Main | Economy |
|---|---|---|---|
| Claude Code | claude-fable-5-1, max, design conversation only, never dispatched | claude-opus-5-5, max, subagent orchestration and acceptance | claude-opus-5-5, low, splitting and package implementation |
| Codex | gpt-6-astra, max | gpt-6-sol, max | gpt-6-luna, max |

## How we reduce your usage

> **The Codex-specific workflow is available.** Codex Desktop uses separate main-tier decision and economy-tier coordination conversations. Other hosts retain their native paths. The cost figures below were calculated from historical samples on 2026-10-31; they are comparisons under stated estimation assumptions, not a promise of fixed quota savings.

Long-running tasks consume resources beyond writing code. Dispatch, continuation after a wait, state recovery, log reads and receiving subagent results can all make the model process context repeatedly. Einzbern and Mana Orchestrate control these costs through task allocation, batch boundaries and context scope.

- **Choose a model category for the task.** Planning, complex judgment and independent acceptance start in the main category; bounded execution and routine coordination use the configured economy category. The host policy selects the actual model and reasoning effort, without a fixed model binding.
- **Work toward a whole-batch goal.** After decomposition, group work by dependency. Workers complete their assigned tasks; acceptance and issue handling take place together at the end of the batch, reducing repeated completion, dispatch and acceptance exchanges for individual items.
- **Read only what is needed.** Issues and evidence stay in the batch records. The main conversation receives the results and evidence locations needed for decisions; large files, logs and plans are read as excerpts.
- **Include every role in the cost.** Count the main conversation, economy coordination conversations and workers together, including failures, retries and reporting. A reduction in main-conversation usage must be assessed against total workflow usage.

### Different hosts use different coordination paths

| Host | Approach | Optimization focus and evidence |
| :--- | :--- | :--- |
| **Codex Desktop: dedicated two-conversation workflow** | An independent main-tier decision conversation hands over a whole-batch goal. An independent economy-tier coordinator dispatches worker subagents, waits for and receives their results, then reports to the main conversation once at batch end. | Historical runs show a substantial cost impact when frequent coordination remains in a long main-tier conversation. Assigning this work to the economy category controls how often the main conversation is invoked. |
| **Claude Code: native path retained** | One main conversation coordinates worker subagents using the host's background execution and completion notifications. | Native notifications return results. Further optimization focuses on model categories, scheduled wakeups, returned content and acceptance cadence. Current samples do not establish a general need for a separate coordination conversation. |
| **DeepSeek Harness: native path retained** | One main conversation uses runtime-managed subagents; the Mana Orchestrate plugin provides memory integration and bridge deduplication. | The runtime handles completion notifications and resource cleanup. Historical logs already show multiple returns coalesced into one main-conversation response. Further optimization depends on actual models and the share of coordination costs. |

The two-conversation arrangement is **the sole Codex workflow** and has replaced the previous collector-hook path. Other hosts are unaffected. The economy coordinator receives worker results directly, with no separate collector agent. The corresponding workers handle implementation, integration and independent acceptance. The main and economy model categories are required; flagship is optional.

The model performs this orchestration through host-supported tools. The engine records batches and receipts; it does not create conversations, dispatch work or send messages on its own.

Codex itself also supports subagents, waiting and result aggregation. The dedicated workflow addresses observed coordination costs. Retaining native paths for CC and DSH does not mean they have no context callbacks or will never need optimization. See the [Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude Code background subagent documentation](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) and [DSH native delegation documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md).

### A Codex case: three approaches estimated on the same usage over 29.3 hours

One design-system development record covers **29.3 hours, 81 conversations and 7,763 unique model responses**, including main-tier decisions, economy coordination and all workers. Work was still in progress at the cutoff. These figures describe usage within the sampling window, not the full cost of a delivery that passed final acceptance.

| Approach | Standard reference credits | Main-tier coordination = 100% | Nature of the data |
| :--- | ---: | ---: | :--- |
| **Main-tier decisions + economy coordination + workers assigned by category** | **2,610.58** | **49.3%** | Observed requests and usage, priced at the actual model rate of each response |
| Main tier handles all coordination and waiting; workers remain unchanged | About 5,300.52 | 100% | Same requests, tokens and cache composition; economy coordination is repriced at the main-tier model rate |
| No subagents; the main conversation performs all work | About 5,116.83 | 96.5% | Identifiable agent-only communication is removed; retained work is repriced at the main-tier model rate |

Under these assumptions, the two-conversation approach costs about **50.7%** less than main-tier coordination and **49.0%** less than main-only execution. Workers account for **80.5%** of cumulative reference cost, main-tier decisions for **10.8%**, and economy coordination for **8.7%**.

The main-tier comparison model is GPT-6.1 Sol. The observed records also include GPT-6 Luna and a small amount of GPT-6.1 Terra usage. These names are measurement conditions for this case, not fixed product bindings. Rates are referenced from [OpenAI's official pricing](https://learn.chatgpt.com/docs/pricing).

**50.7% is the difference from repricing all coordination work at unchanged usage.** It covers dispatch, waiting, recovery, result collection and reporting. It cannot be described as “batch returns alone reduced tokens by 50.7%.” Neither alternative was actually rerun; differences in context growth, cache behavior, serial execution time and delivery quality remain unknown.

### How much context does the main conversation process after a subagent returns?

Counting only dispatch and wait tools misses the processing that follows result delivery. We also count the first unique metered response after a return event. Multiple returns coalesced into one response are counted once, without duplicating streaming content blocks. This measures processing near a return; it does not prove that the notification alone caused the entire response cost.

| Sample / role | Return events received | First receiving responses | Mean input per response, including cache | Cache-read share |
| :--- | ---: | ---: | ---: | ---: |
| CC: four main conversations | 212 completion notifications | **207** | About 636k tokens | 96.5% |
| DSH: official Pro main conversation | 112 completion notifications + 69 result relays | **120** | About 395k tokens | 99.1% |
| Codex: main-tier decision conversation | 12 batch-end reports | **12** | About 272k tokens | 98.2% |
| Codex: all economy coordination layers | 78 final returns + 9 agent messages | **87** | About 165k tokens | 97.8% |

DSH's 112 completion notifications alone correspond to **61** first receiving responses, demonstrating that the existing path already coalesces returns. Separate result relays also trigger responses, bringing the combined count to 120.

Codex's economy layer still receives individual returns; the main conversation receives batch-end reports. Requests and costs from both layers are included. Tasks, durations and models differ across the table, so subtracting counts or input volumes cannot establish savings across hosts. Cumulative input also includes repeated cache reads.

### Why not extend Codex's two-conversation arrangement to CC and DSH for now?

Adding post-return processing to each host's historical usage, then repricing selected work at economy-model rates, estimates the cost opportunity worth further testing. CC is compared with **Haiku 5.5**, and DSH with official **Flash 4.1-1017**. No additional model runs were started.

| Historical sample | Total cost difference when coordination checks + first receiving responses are repriced at economy rates | Broader estimate including the post-return handling interval |
| :--- | ---: | ---: |
| CC: four conversation trees, Opus 5.5 → Haiku 5.5 | **About 3.8%** | **About 6.6%** |
| DSH: official Pro → official Flash | **At most 6.8%** | **At most 11.2%** |
| DSH: small official Flash sample → Flash at the same price | **0% model-rate difference** | **0% model-rate difference** |

The broader estimate runs from a return event to the next new dispatch, the end of the current turn or an independent user input. It includes reading, integration and judgment. Whether all this work can move to the economy category, and the startup, handoff, cache, quality and maintenance costs of an additional coordination layer, have not been measured. These differences are not realized savings.

The four CC conversations individually yield about **2.9%, 3.0%, 2.4% and 11.1%**; 3.8% is their weighted aggregate. In two more recent DSH samples with Claude main conversations, repricing coordination and first receiving responses at Flash rates yields about **0.7%–1.4%** and **5.3%–7.8%**, respectively. Benefits depend on the model and task; no single percentage can be promised for every project.

These samples support a dedicated two-conversation optimization for Codex while CC and DSH retain their native paths and continue checking duplicate notifications, avoidable wakeups, returned content and cache behavior. Native completion notifications establish integration capabilities. Adding an independent coordinator still requires evidence covering its additional costs and delivery quality.

### Meter waiting separately from model calls after waiting

Time spent blocked in a wait tool does not itself generate new model input. Calling the model again after a timeout processes context again and generates output.

Across this Codex record, the main conversation produced **244 responses at 281.14 Standard reference credits**; economy coordination produced **4,430 responses at 226.68 credits**. Both are included in the 2,610.58-credit total. The count of 12 refers only to first responses after batch-end reports, not to all main-conversation calls.

The economy layer still had **567 metered responses after wait timeouts**, processing about **91.81 million input tokens**, of which about **98.9%** were cache reads, at **26.95 reference credits**. This run shows the cost advantage of moving frequent continuations to an economy model, while also showing room to reduce timeout continuations. It does not establish that all empty polling has been eliminated.

<details>
<summary><b>Sample scope, rates and estimation limits</b></summary>
<br>

**Sample scope.** The Codex window runs from 2026-10-29 21:28:39 to 2026-10-31 02:46:01, China Standard Time (UTC+8), covering two independent chats and all their native workers. Other projects, workflow development and this usage audit are excluded. The CC sample contains 4 main conversations, 210 subagent logs and 27,767 unique responses. DSH comprises 4 conversation trees, 115 sessions and 4,672 responses across different months and model routes. Private source conversation logs are not published with this explanation.

**Changes over time.** The first 11.6 hours of Codex usage cost 932.03 reference credits, an estimated 58.5% reduction against the same-usage main-tier coordination comparison. The additional 17.7 hours cost 1,678.55 credits, with a 45.1% reduction; the cumulative reduction is 50.7%. Repricing coordination work alone yields a model-rate difference of about 92.2%; that figure is not a full-workflow reduction.

**The three Codex calculations.** The main-tier coordination comparison preserves observed request frequency, tokens and cache composition, changing only the model rate for economy coordination duties. The main-only comparison removes 1,083 identifiable responses devoted solely to agent dispatch, waiting, status queries and communication. It retains governance reads, implementation, integration, validation and process waiting. Repeated startup context that cannot be reliably separated is retained. Cache behavior, serial execution time and independent acceptance quality in one long conversation have not been measured.

**Post-return counting.** CC background-command notifications and subagent notifications are identified separately; parent-message relationships can verify successor responses. Other hosts are associated by native event order. Complete request bodies are insufficient for a uniform replay across hosts, so the “first metered response after a return” does not mean every token was caused by that event alone. CC coordination candidates also include separately identified scheduled, notification and background-monitoring checks. DSH includes identifiable agent coordination and the first responses after completion notifications or result relays. Overlapping selections are counted once.

**Rate date and units.** Rates were consulted on 2026-10-31. Codex uses [official Standard reference credits](https://learn.chatgpt.com/docs/pricing), Claude uses [official Global Standard API rates](https://platform.claude.com/docs/en/about-claude/pricing), and DeepSeek is normalized to [current official off-peak rates](https://api-docs.deepseek.com/quick_start/pricing/). Historical peak or holiday bills were not reconstructed. API-rate reference values across hosts and Codex credits are not a single currency, and do not equal actual invoices or subscription weekly quotas.

**Cache and missing data.** Under [official Haiku 5.5 pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview), requests with full input above 100k tokens use higher rates; the threshold includes cache reads and writes. Rates were assigned per request. Rates for 7 Qwen responses in the DSH Pro tree are unknown and were not assumed to be zero, so whole-tree percentages are upper bounds. Some DSH Claude records lack cache-write duration; a range using 5-minute and 1-hour rates is retained. Actual third-party charges are unverified. Reasoning is included in output and is not charged a second time.

**Meaning of the bounds.** Repricing every main-conversation task gives an arithmetic upper bound of about 15.2% for CC using Haiku and a whole-tree upper bound of about 30.7% for DSH Pro using Flash. This includes planning, implementation, critical judgment and acceptance; it does not establish that all such work suits economy models. The 0% for same-priced Flash means only that the model rate is unchanged. Fewer requests or improved context may still help.

**Quality and causality.** All cost comparisons statically reprice historical usage; there was no controlled rerun of the same task. Causal savings from reducing repeated context, changing models or adding a coordinator remain unknown. Parallelism and additional subagents may improve speed, but may also add startup, communication and rework. Savings must be assessed against usage by all roles, completion time and delivery quality.

</details>

### How the preset rules make your tokens go further

The four principles of the time are not only discipline; each one plugs a measured leak. The numbers come from Einzbern's own development record, 2026-09-26, same batch of work, same model.

| Where it leaks | Measured | The rule that plugs it |
|---|---|---|
| One subagent runs on and on, its context keeps growing, and it re-reads all of it every turn | One subagent doing 30 Subtasks: average context 526k, 3,740 turns, 221M weighted tokens, 7.4M per Subtask | Batch processing: packages in parallel, one fresh subagent per package, retired when done. A fresh package subagent costs 2.9M per Subtask, 39% of that |
| Fixing a red as soon as it appears, then another red, and gates rerun again and again | In the previous version, nine defect tickets circled one budget gate, and one hook defect took four commits | Batch processing: reds are recorded, not fixed on the spot; handled once at the batch end; one root cause counts once |
| Dispatching a wave right at the end of a quota window, and losing all of it | Eight parallel subagents filled the 5-hour quota in 12 minutes, zero commits, about 15M wasted | Quota gating: read the quota before dispatching; parallelism drops at 75%, waiting starts at 90% |
| A confirmation dialog pops up and the session waits for a human forever | One wait lasted 2 hours 12 minutes | Unattended commands: no command forms that raise dialogs |
| The main conversation writes a report after every dispatch | A few thousand tokens each, all kept in the main context and re-read every turn afterwards | Silent reporting: report only when everything is done or everything is blocked |
| Asking "shall I continue?" and waiting for an answer | With nobody present, the wait lasts all night | Autonomous operation: reversible actions are simply done |

Under the weighted-cost calculation for the 2026-09-26 sample above, cache reads accounted for roughly 80–90% of cost. The system prompt and rules injected at startup were about 52k, less than 1% of a single subagent's cost. These proportions apply only to that historical sample; they cannot be generalized to other models, current usage or subscription quotas. Package-specific excerpts, command output saved to files with only the needed portions read back, range reads of large files and grouping adjacent commands were the context-control practices used in that batch.

Parallelism, agent count and context boundaries can all change total usage. This case supports controlling context and round trips by package. A fresh context or higher concurrency alone does not prove savings; total workflow cost and delivery quality still need to be checked.

## Why it is designed this way

**Provide memory, do not police method.** The previous version tried to fence the model in with gates, proofs, and Stop hooks: more than a hundred verbs, sixteen gates. We used it ourselves for two months. The cost far exceeded the benefit, and the model forgot what it was going to forget anyway. This version removes all of it and keeps records and retrieval.

**One hook only.** A model does not know what it does not know, so retrieval must be triggered by the host before every prompt rather than waiting for the model to think of it. But the hook contains no rules. What to fetch and how much is the engine's decision.

**AGENTS.md is your file.** Rules that must hold on both hosts can only live where both hosts read. So Einzbern does write to it, but only marked sections, only what you enabled, and never over your edits.

**Index only Stories.** Initiatives and Epics are too coarse, Subtasks too fine. What you need to know, a Story can tell you.

**Records are append-only.** Every derived state can be rebuilt from the records. That is why indexes can stay local and why devices can merge.

**Configuration in two layers.** Project configuration travels with the records; device configuration stays on the machine. Setting up a new device means setting up the device, not the project.

## Glossary

| Name | What it is | Where the name comes from |
|---|---|---|
| Einzbern | The engine: the program that holds records and performs retrieval and recording | The body of the Grail |
| Mana Orchestrate | The skill that brings Einzbern into the host: tells the model when to call which engine feature, and carries the install wizard | Mana, the greater source of magical energy; here, memory in circulation |
| Ether | The artifacts directory `Ether` | Ether, the medium that lets mana take a fixed form in the real world |
| Akasha | `Ether/akasha/`, the append-only event record from which every derived state is rebuilt | Akasha, the Root, where every record resides |
| Crest | `Ether/crest/`, the knowledge store; the project-level and user-level stores share the name | The Magic Crest, craft inherited across generations |
| Command Spell | The seven built-in principles, off by default, enabled by choice | Command Spells, the commands a Servant cannot refuse |
| Atelier | The local management page | A magus's workshop |

## Full documentation

Wiki: concepts and glossary, the install wizard, the `Ether` layout, several devices and cloud folders, the principles in full, migrating from TCRN Workflow, CLI reference.

## License

Apache-2.0
