<div align="center">

# Einzbern

The Grail grants wishes. Einzbern remembers the wishes you made, the decisions you took, and the traps you fell into,<br>and puts them in front of the model right before the prompt that needs them.

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-3.0.3-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-informational?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

[What happened on Wednesday afternoon](#what-happened-on-wednesday-afternoon) · [What it remembers](#what-it-remembers) · [When you will want it](#when-you-will-want-it) · [Why this and not a memory plugin](#why-this-and-not-a-memory-plugin) · [Install](#install) · [Day to day](#day-to-day) · [Several devices and cloud folders](#several-devices-and-cloud-folders) · [How we use it ourselves](#how-we-use-it-ourselves) · [How the preset rules make your tokens go further](#how-the-preset-rules-make-your-tokens-go-further) · [Why it is designed this way](#why-it-is-designed-this-way) · [Glossary](#glossary)

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
hosts, one memory<br><sub>Claude Code, Codex and DeepSeek Harness read the same .ether</sub>

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

Work items, knowledge, minutes, and variables are the mana flowing through this machine. They are fixed in place in a folder in your project called `.ether`, after ether, the medium that lets mana take a fixed form in the real world. The model draws from it before every prompt and writes back to it when work is done.

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
| Switching hosts | Each keeps its own | Claude Code, Codex and DeepSeek Harness read the same .ether |
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

Then, in the project directory, say: install Einzbern. The wizard asks one screen of questions: fresh install or restore from an existing `.ether`, where the artifacts go, whether that folder is cloud-synced, which language, and whether to write a navigation section into AGENTS.md. It then lists every file it is about to write, and you confirm once. Update, repair, migrate from the previous version, uninstall, and health check are modes of the same wizard.

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

`.ether` can live in a synced folder such as OneDrive or iCloud. Each device writes only its own record stream, and reads merge all streams. Two devices can write at the same time: no locks, nobody waits. If both devices change the same work item, the later change is recorded as rejected: not lost, not silently overwritten. Indexes and snapshots stay on the local machine; only the records themselves are in the cloud. The engine does not encrypt; the security of your cloud account is on your side.

## How we use it ourselves

This is how Einzbern develops itself, and the usage we suggest. You can adopt any one layer alone.

**Two conversations.** A design conversation on the flagship tier discusses direction with you, records decisions as minutes, and splits the work into Initiative, Epic and Story in .ether. An implementation conversation on the main tier reads the Stories from .ether and writes no code: it dispatches, records, runs gates and reports.

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

The tier table below is what we run right now; model names go stale as vendors update, so treat the models.tiers you maintain in Atelier as the authority.

| Host | Flagship | Main | Economy |
|---|---|---|---|
| Claude Code | claude-fable-5-1, max, design conversation only, never dispatched | claude-opus-5-5, max, subagent orchestration and acceptance | claude-opus-5-5, low, splitting and package implementation |
| Codex | gpt-6-astra, max | gpt-6-sol, max | gpt-6-luna, max |

## How the preset rules make your tokens go further

The four principles of the time are not only discipline; each one plugs a measured leak. The numbers come from Einzbern's own development record, 2026-09-26, same batch of work, same model.

| Where it leaks | Measured | The rule that plugs it |
|---|---|---|
| One subagent runs on and on, its context keeps growing, and it re-reads all of it every turn | One subagent doing 30 Subtasks: average context 526k, 3,740 turns, 221M weighted tokens, 7.4M per Subtask | Batch processing: packages in parallel, one fresh subagent per package, retired when done. A fresh package subagent costs 2.9M per Subtask, 39% of that |
| Fixing a red as soon as it appears, then another red, and gates rerun again and again | In the previous version, nine defect tickets circled one budget gate, and one hook defect took four commits | Batch processing: reds are recorded, not fixed on the spot; handled once at the batch end; one root cause counts once |
| Dispatching a wave right at the end of a quota window, and losing all of it | Eight parallel subagents filled the 5-hour quota in 12 minutes, zero commits, about 15M wasted | Quota gating: read the quota before dispatching; parallelism drops at 75%, waiting starts at 90% |
| A confirmation dialog pops up and the session waits for a human forever | One wait lasted 2 hours 12 minutes | Unattended commands: no command forms that raise dialogs |
| The main conversation writes a report after every dispatch | A few thousand tokens each, all kept in the main context and re-read every turn afterwards | Silent reporting: report only when everything is done or everything is blocked |
| Asking "shall I continue?" and waiting for an answer | With nobody present, the wait lasts all night | Autonomous operation: reversible actions are simply done |

Eighty to ninety percent of the cost is cache reads, that is, re-reading the context every turn. The system prompt and rules injected when a subagent starts are only 52k, under 1% of a subagent's cost. So saving tokens is not about injecting less; it is about keeping each subagent's context short and its turns few: one excerpt file per package instead of the whole split, command output written to files with only the tail read back, large files read in ranges, adjacent commands merged. All of this is written into the batch processing principle and the implementation conversation's start file.

Parallelism by itself saves no tokens; it only changes how fast they are spent. What saves tokens is a fresh context. That is why the parallel cap follows your subscription and quota gating shrinks it automatically when the quota runs low.

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
| Ether | The artifacts directory `.ether` | Ether, the medium that lets mana take a fixed form in the real world |
| Akasha | `.ether/akasha/`, the append-only event record from which every derived state is rebuilt | Akasha, the Root, where every record resides |
| Crest | `.ether/crest/`, the knowledge store; the project-level and user-level stores share the name | The Magic Crest, craft inherited across generations |
| Command Spell | The seven built-in principles, off by default, enabled by choice | Command Spells, the commands a Servant cannot refuse |
| Atelier | The local management page | A magus's workshop |

## Full documentation

Wiki: concepts and glossary, the install wizard, the `.ether` layout, several devices and cloud folders, the principles in full, migrating from TCRN Workflow, CLI reference.

## License

Apache-2.0
