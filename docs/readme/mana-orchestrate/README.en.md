<div align="center">

# Mana Orchestrate

The Grail grants wishes; Mana Orchestrate makes the mana flow to the right place at the right moment.

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[It does three things](#it-does-three-things) · [Install](#install) · [Once it is in](#once-it-is-in) · [Version](#version) · [What is inside](#what-is-inside)

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

## Version

Same version number as Einzbern, same release. Currently {{version}}. This README and the navigation table in SKILL.md are generated when Einzbern is released; documents in this repository are not edited by hand.

## What is inside

- `SKILL.md`: the navigation table and the three-step routine. Everyday sessions load only this file.
- `references/`: the wizard text for install, restore, update, migrate, uninstall, and health check. Loaded only during installation.

## Full documentation

Einzbern's README and Wiki.

## License

Apache-2.0
