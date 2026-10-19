<div align="center">

# Mana Orchestrate

圣杯实现愿望，Mana Orchestrate 让魔力在对的时刻流到对的地方。

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[它做三件事](#它做三件事) · [安装](#安装) · [装好之后](#装好之后) · [版本](#版本) · [里面有什么](#里面有什么)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate`，然后在项目里对宿主说「安装 Einzbern」。

---

它是把 Einzbern 接进 Claude Code、Codex 与 DeepSeek Harness 的 skill。Einzbern 是给这三个宿主的项目记忆：工单、知识、纪要，在需要的那条 prompt 前出现在模型面前。Mana 是在其中流转的记忆，Orchestrate 是指挥它何时流向哪里。这个 skill 告诉模型什么时候该调引擎的哪个功能，并带着安装向导。

## 它做三件事

**把 Einzbern 装进来。** 你对宿主说一句「安装 Einzbern」，向导接手：一屏问题，一次确认，下载与校验引擎，接好钩子，两个宿主一次装完。

**告诉模型什么时候做什么。** 一张导航表：开工先取记忆，做完把结果记回工单，有决定记纪要，有教训写卡片。表由引擎按版本生成，模型读到的动词与引擎里的一一对应。

**自己什么都不持有。** 没有数据，没有规则，没有配置。记忆保存在使用者选择父目录中的 `Ether` 共享总库，多项目按项目身份区分；已有的项目 `.ether` 库仍可使用。原则与变量在 Atelier 里，魔术师的工房，也就是本机的管理页面。它只是那张表和那个向导。

## 安装

用 skills 命令：

```
npx skills add tpmoonchefryan/mana-orchestrate
```

或者对宿主说：找一个叫 Mana Orchestrate 的 skill，装上。

它会落在宿主的 skills 目录里，Claude Code 是 `~/.claude/skills`，Codex 与 DeepSeek Harness 是 `~/.agents/skills`。DeepSeek Harness 的每条 prompt 前召回由插件 dsh-mana-orchestrate 接入，不写钩子文件。然后在项目目录里说：安装 Einzbern。

向导会问：全新安装还是从已有库恢复，`Ether` 放哪，是否在云同步文件夹里，用什么语言，要不要在 AGENTS.md 写导航段。`Ether` 是文件夹名称，父目录由你选择，可以在本地磁盘、外置磁盘或同步文件夹中；后续项目默认复用已选位置。最后列出将写入的文件，你确认一次。引擎从与本 skill 同版本的发布下载，校验摘要后才落地；有本地压缩包也可以离线装。

之后的事都是同一个向导的模式：更新、修复、从 TCRN Workflow 迁移、卸载、体检。对宿主说「更新 Einzbern」就行。

它不提交、不推送、不改你的 .gitignore、不删任何东西，除下载引擎外不联网。

## 装好之后

你正常工作。每条 prompt 前，宿主把它交给引擎检索一次，有强相关的标题就进上下文，没有就什么都不发生。模型按导航表在对的时刻记录。你想看或想改，打开 Atelier。

## 版本

与 Einzbern 同一版本号，同一次发布。当前 {{version}}。本 README 与 SKILL.md 里的导航表都由 Einzbern 发布时生成，这个仓库里不手改文档。

## 里面有什么

- `SKILL.md`：导航表与三步用法。日常会话只加载这一份。
- `references/`：安装、恢复、更新、迁移、卸载、体检的向导文本。只在安装时加载。

## 完整文档

Einzbern 的 README 与 Wiki。

## 许可

Apache-2.0
