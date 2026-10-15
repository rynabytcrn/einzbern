# Einzbern 2.2.1 发行说明：知识与纪要

[发行说明](Release-Notes.md) › [Einzbern 2.2.1](Release-Notes-2.2.1.md) › 模块 1/2：知识与纪要

下一模块：[从 2.2.0 升级](Release-Notes-2.2.1-Upgrading-from-2.2.0.md)

## A coordination library's knowledge writes no longer take the write language policy

A coordination library's knowledge writes no longer take the write language policy
(TCRN-CROSS-STORY-543, TCRN-CROSS-SUB-523 and TCRN-CROSS-SUB-524, EPIC-151 R11, MIN-262 D1). Its
`artifact.language` decides only the language of its managed sections and variable sections; it has
no `models.*` (MIN-243 D1), so no economy-tier model can translate for it, and once it recorded a
language 2.2.0 refused every `knowledge-capture`, `knowledge-create` and `knowledge-batch` card
there with `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`. Its cards, and the article indexes of
`knowledge-article-create` and `knowledge-article-refresh`, are now written in the words they were
handed, untranslated and with no phrasings, as before it recorded a language; a `--language-bundle`
is still read and checked, and its answers are not used. recall still answers a query in another
language with the translation it is owed (`queryTranslation`, its `model` null), and the managed
sections still follow `artifact.language`. A project library, and a library with no chain identity,
keep the policy: once it records `artifact.language`, a card write there needs its economy-tier model
and a language bundle. No event, record, library format, flag, receipt field or reason code changes.

---

[返回模块目录](Release-Notes-2.2.1.md) · 下一模块：[从 2.2.0 升级](Release-Notes-2.2.1-Upgrading-from-2.2.0.md)
