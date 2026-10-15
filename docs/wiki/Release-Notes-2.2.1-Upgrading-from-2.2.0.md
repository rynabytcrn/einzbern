# Einzbern 2.2.1 发行说明：从 2.2.0 升级

[发行说明](Release-Notes.md) › [Einzbern 2.2.1](Release-Notes-2.2.1.md) › 模块 2/2：从 2.2.0 升级

上一模块：[知识与纪要](Release-Notes-2.2.1-Knowledge-and-Minutes.md)

## Readers still need 2.2.0 for a library that already exists, because 2.2.1 writes no new event, record or library format

- Readers still need 2.2.0 for a library that already exists, because 2.2.1 writes no new event,
  record or library format: after 2.2.1 writes to such a library, 2.2.0 still opens it, counts no
  rejected event and still writes there. 2.2.0 reads a card that 2.2.1 writes in a coordination
  library that recorded `artifact.language` like any other card, in the words it was written and
  with no phrasings, and its recall finds it. A library that 2.2.1 creates records
  `minEngineVersion` 2.2.1, and 2.2.0 refuses to open it with `ENGINE_TOO_OLD`, as with every
  release. Install 2.2.1 on every device that reads the same library, together.

## Rolling back to 2.2.0 leaves a library and the cards that 2.2.1 wrote there intact, but a coordination library that recorded `artifact.language` then refuses card writes again with `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`, and a library that 2.2.1 created does not open

- Rolling back to 2.2.0 leaves a library and the cards that 2.2.1 wrote there intact, but a
  coordination library that recorded `artifact.language` then refuses card writes again with
  `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE`, and a library that 2.2.1 created does not open.

## A gate run that 2.2.0 recorded still counts toward done

- A gate run that 2.2.0 recorded still counts toward done: 2.2.1 records and reads runs in the same
  shapes (`einzbern.gate-run.v1`, with `einzbern.gate-tree.v3` roots).

## Once 2.2.1 is installed, a coordination library that recorded `artifact.language` writes cards with no `--language-bundle`

- Once 2.2.1 is installed, a coordination library that recorded `artifact.language` writes cards
  with no `--language-bundle`; a project library that recorded it still needs its economy-tier model
  and a language bundle. A card that 2.2.0 refused in a coordination library with
  `KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE` was never written, so write it again (here, the six cards
  of TCRN-CROSS-EPIC-150 R10; MIN-262 D1).

---

[返回模块目录](Release-Notes-2.2.1.md) · 上一模块：[知识与纪要](Release-Notes-2.2.1-Knowledge-and-Minutes.md)
