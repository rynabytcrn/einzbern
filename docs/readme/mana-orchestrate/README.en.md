<div align="center">

# Mana Orchestrate

The Grail grants wishes; Mana Orchestrate makes the mana flow to the right place at the right moment.

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[It does three things](#it-does-three-things) · [Install](#install) · [Once it is in](#once-it-is-in) · [How we reduce your usage](#how-we-reduce-your-usage) · [Version](#version) · [What is inside](#what-is-inside)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate`, then tell your host "install Einzbern" inside the project.

---

It is the skill that brings Einzbern into Claude Code, Codex and DeepSeek Harness. Einzbern is project memory for those three hosts: work items, knowledge, and minutes appear in front of the model before the prompt that needs them. Mana is the memory in circulation; orchestrate is directing when it flows where. This skill tells the model when to call which engine feature, and it carries the install wizard.

## It does three things

**Brings Einzbern in.** You tell your host "install Einzbern" and the wizard takes over: one screen of questions, one confirmation, engine downloaded and verified, hook wired, both hosts done in one pass.

**Tells the model when to do what.** One navigation table: recall before starting, write results back to the work item when done, record decisions as minutes, write lessons as cards. The engine generates the table for its own version, so every verb the model reads matches one in the engine.

**Holds nothing of its own.** No data, no rules, no configuration. Memory lives in the shared `Ether` library under a parent you choose; projects are separated by project identity, and existing project `.ether` libraries remain usable. Principles and variables live in Atelier, a magus's workshop, here the local management page. The skill is only that table and that wizard.

## Install

With the skills command:

```
npx skills add tpmoonchefryan/mana-orchestrate
```

Or tell your host: find a skill called Mana Orchestrate and install it.

It lands in the host's skills directory, `~/.claude/skills` for Claude Code and `~/.agents/skills` for Codex and DeepSeek Harness. In DeepSeek Harness, recall before each prompt comes through the dsh-mana-orchestrate plugin; no hook file is written. Then, in the project directory, say: install Einzbern.

The wizard asks: fresh install or restore from an existing library, where `Ether` goes, whether that folder is cloud-synced, which language, and whether to write a navigation section into AGENTS.md. `Ether` is the folder name; you choose its parent on a local disk, external disk or in a synced folder. Later projects reuse the saved location by default. It then lists every file it is about to write, and you confirm once. The engine is downloaded from the release that matches this skill's version and verified against its digest before anything lands; with a local archive it installs offline.

Everything after that is a mode of the same wizard: update, repair, migrate from TCRN Workflow, uninstall, health check. Say "update Einzbern" and that is it.

It does not commit, push, edit your .gitignore, or delete anything, and it touches the network only to download the engine.

## Once it is in

You work as usual. Before every prompt, the host hands it to the engine for one lookup; strongly relevant headlines enter the context, otherwise nothing happens. The model records at the right moments, following the navigation table. To look or change anything, open Atelier.

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

## Version

Same version number as Einzbern, same release. Currently {{version}}. This README and the navigation table in SKILL.md are generated when Einzbern is released; documents in this repository are not edited by hand.

## What is inside

- `SKILL.md`: the navigation table and the three-step routine. Everyday sessions load only this file.
- `references/`: the wizard text for install, restore, update, migrate, uninstall, and health check. Loaded only during installation.

## Full documentation

Einzbern's README and Wiki.

## License

Apache-2.0
