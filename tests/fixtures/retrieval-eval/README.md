# Retrieval evaluation corpus

The frozen corpus `scripts/retrieval-eval.mjs` scores (TCRN-CROSS-STORY-368), re-recorded for
TCRN-CROSS-STORY-474 by TCRN-CROSS-SUB-303: the index is now built the way
`packages/core/src/recall-inputs.ts` builds it, and the strong-hit threshold is calibrated here.
Every file below is content-addressed by the gate (`CORPUS_FILES`), so a byte that moves is
refused by name until the policy is measured again.

## Where the corpus came from

| Item | Value |
| --- | --- |
| Source | the cross-project chain, old layout, read-only |
| Chain version and head | 9124, `c0ca7416385150e2eb1a00e35c15dac0b0c433884c3f7770e32ed3100e9d9366` |
| Card read | `knowledge-list` as the recall verb reads it, digest `40b65ac68d834f33a1c9898e36c137fd906dc00f59f8516030c6d4cbfc3e0f70` |
| Recorded at | `2026-09-26T13:00:00Z` (`--at`) |
| Engine | commit `d70dce7a4b2cf53d6b6c01513d633d7d31432e8f` with `scripts/retrieval-eval-record.mjs` as committed beside this file |
| Command | `node --import tests/helpers/fs-write-tripwire.mjs scripts/retrieval-eval-record.mjs --legacy <workspace> --out <dir> --at 2026-09-26T13:00:00Z`, with `EINZBERN_TRIPWIRE_ROOT` set to the chain container and `EINZBERN_HOME` set to a scratch directory |

The recorder replays the old-layout chain from genesis without writing a byte (the tripwire
refuses any write under the chain container, and none was attempted). The four corpus files
are its output byte for byte; a second run at the same chain version reproduced them exactly.
`corpus-snapshot.json` carries the same facts in machine form.

## Sampling

What `recall-inputs.ts` indexes, and nothing else: work records of the kinds recall indexes
(Story, Incident, Initiative, Epic), every minutes record, every card the recall verb reads.
Each work record keeps its goal, body and parent titles; its scope is kept to the 512-byte
excerpt the index reads.

| Rule | Records |
| --- | --- |
| Work records on the chain | 1454, of which 1072 are of an indexed kind |
| Every Initiative and Epic | 198 |
| A Story or Incident an evaluation fixture names (a judged candidate, a development-set source) | 36 |
| Any other Story or Incident whose `sha256(id)`, first four bytes as an unsigned integer, is divisible by 4 | 201 |
| A record of the pre-registered holdout, never kept (the holdout scores records the corpus has not seen) | 20 dropped |
| Kept in `work-compact.json` | 435: Initiative 52, Epic 146, Story 128, Incident 109 |
| Minutes records in `minutes-compact.json` | 257 |
| Cards in `cards-compact.json` | 66 |

## Redaction

Before anything was written, every text field had these replaced; the repository's own privacy
scanner then ran over the output and found nothing.

| Replaced | Placeholder | Count |
| --- | --- | --- |
| Absolute paths | `[path]` | 150 |
| claude.ai links | `[link]` | 3 |
| URLs carrying credentials | `[url]` | 2 |
| E-mail addresses | `[email]` | 5 |
| Logins at a host | `[user]@[host]` | 3 |
| Private IPv4 addresses | `[ip]` | 0 |
| Password-like literals | `[secret]` | 2 |
| Thread identifiers | `[thread-id]` | 0 |
| This machine's user names | `[user]` | 9 |
| Host names the chain names as an ssh target or after a login | `[host]` | 8 |

## Labels

| File | What changed |
| --- | --- |
| `synthetic-queries.json` | 37 targets re-mapped. Every card the old corpus held was re-created by the knowledge migration and the original retired; each target now names the live card that supersedes it. 0 targets named a Subtask. |
| `gold-labels.json` | Unchanged. Its 26 relevant labels name 20 minutes records and 6 Incidents, all indexed: 0 named a Subtask, 0 named a kind recall does not index, 0 deleted. |
| `judge-sheet.json` | Unchanged. |
| `translations-sonnet.json` | Unchanged: a historical model product, not re-recorded. Its 36 targets are the retired cards, and the gate follows each to its successor through the `supersedes` links in `corpus-snapshot.json`. |
| `card-expansions.json` | Removed. Its phrasings belonged to the retired cards; the live cards carry their own expansions in `cards-compact.json`, which is what the recall verb indexes. |

## Re-checked under the new index

- `incident-replay-frozen.json`: the twenty Incidents are all in the corpus and are indexed as
  Stories are. Prompts, labels and identities are unchanged; the source digests are re-bound to
  the recorded records (`rebound` in the file), and two statuses moved from active to done
  (INC-274, INC-275). Its frozen floors hold as measured: 19, 20, 20.
- `holdout-source.json` is unchanged, and `holdout-preregistered.json` keeps its twenty records,
  labels and pre-registered floors (8, 12, 16; measured 14, 17, 17). Only `priorPromptDigest` is
  re-bound, to the 385 prompts the new corpus knows; the holdout prompts stay disjoint from them.
- Incident replay (`scripts/incident-replay.mjs`) pairs only records the index holds: 277 pairs,
  19 records without a summary, 139 records not indexed (an Initiative or an Epic carrying
  nothing but a scope).

## The unrelated group and the strong-hit threshold

`negative-queries.json` holds sixteen everyday prompts, eight in English and eight in Chinese,
written before any score was read. `strong-threshold.json` holds the threshold, the rule that
gave it and the digest of the files it was calibrated on:

- the best score any of them reaches on the mixed index is 16.9767 ("recommend a good novel for
  a long train ride" meeting "good" and "train" in a Story written in English), so the threshold
  is 17, the smallest multiple of 0.25 above it;
- at 17 all sixteen are answered with nothing; at 0, thirteen are answered, which is the gate's
  mutation check (`RETRIEVAL_EVAL_THRESHOLD_DETACHED` when none are);
- `node scripts/retrieval-eval.mjs --calibrate` recomputes it, and the gate refuses a threshold
  the rule does not give on the corpus it names, or one the engine does not ship
  (`RECALL_STRONG_TAU`).

English function words are left out of a query (`STOP_WORDS` in `recall.ts`): on this corpus they
are rare, so each carried a high inverse document frequency, and "what is the weather like in
Paris today" reached 30.14 on the few records written in English. A key fragment that names one
record by whole tokens and carries a digit (`INIT019-C12`, `STORY-474`) is answered as its key
is.

## Measured on this corpus

The floors in `scripts/policy/retrieval-eval-thresholds.json` are these values, with no margin.

| Group | @1 | @3 | @8 | Other |
| --- | --- | --- | --- | --- |
| Cards only, 37 synthetic questions | 21 | 28 | 32 | |
| Mixed index at the threshold, same questions | 18 | 22 | 22 | 24 at @8 with a threshold of 1 |
| Language, 36 English renderings | 14 | 21 | 24 | |
| Real prompts, 30 judged | | | | precision@3 0.1 (0.1222 with a threshold of 1) |
| Incident replay, 277 pairs | 203 | 233 | 235 | |
| Development set, 20 Incidents | 19 | 20 | 20 | |
| Pre-registered holdout, 20 records | 14 | 17 | 17 | |
