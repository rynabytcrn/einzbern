# Retrieval evaluation corpus

The frozen corpus `scripts/retrieval-eval.mjs` scores (TCRN-CROSS-STORY-368), re-recorded for
TCRN-CROSS-STORY-474 by TCRN-CROSS-SUB-303: the index is now built the way
`packages/core/src/recall-inputs.ts` builds it, and the strong-hit threshold is calibrated here.
Since MIN-235 D9 the threshold is calibrated at both ends of a library's size: on this recorded
corpus and on a four-record library written with the goal and body fields (`small-library.json`).
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

## The small library (MIN-235 D9)

`small-library.json` is the library the R13 acceptance probe measured: one Initiative, one Epic
and two Stories, written through the engine's own write path (`work-create` with `--goal`,
`--acceptance` and `--body`; the file's `written` list holds what was written), then recorded by
the same recorder. Its `work` list is the recorder's `work-compact.json` record for record, and
the gate checks each list against the digest the recording names.

| Item | Value |
| --- | --- |
| Source | a scratch library, `library:dcd85a91b9cabedb10d1e94a`, chain version 5 |
| Head | `4241b0b69bd8c5a74d2bf5375bf46050778c4f3df53d4dbb14f84bb9439a68e9` |
| Recorded at | `2026-09-28T15:00:00Z` (`--at`), `--sample 1` so every Story is kept |
| Engine | commit `58e0b6d1e956a3b19be6d91c9eef9ee38f2bf931` (TCRN-CROSS-SUB-302) |
| Command | `node --import tests/helpers/fs-write-tripwire.mjs scripts/retrieval-eval-record.mjs --library <library> --out <dir> --sample 1 --at 2026-09-28T15:00:00Z`, with `EINZBERN_TRIPWIRE_ROOT` set to the chain container and `EINZBERN_HOME` set to a scratch directory |
| Records | 4 work records (Initiative 1, Epic 1, Story 2), 0 minutes, 0 cards; recorder digest `5611d4297000b5601776e672dbac48daab3bff61ddda4f71ade4a24c6af0026e` |
| Redactions | 0 of every kind; the privacy scan found nothing |

Its two query groups were written before the threshold was chosen:

- **related**: a Story's goal words ("pangolin sighting tally"), its body words ("quokka moult
  calendar") and its title ("Offline tally sheet"), and the other Story's goal words ("nest
  photo") and title ("Photo attachment"); each must be answered with its own Story first.
- **unrelated**: ten prompts, six of them sharing exactly one word with the library (calendar,
  photo, tablet, sheet, signal, offline) and four sharing none; each must be answered with
  nothing.

## The two unrelated groups, the related group and the strong-hit threshold

`negative-queries.json` holds sixteen everyday prompts, eight in English and eight in Chinese,
written before any score was read; `small-library.json` holds the small library's two groups.
`strong-threshold.json` holds the threshold, the unit it is counted in, the rule that gave it,
every score the rule read and the digest of the files it was calibrated on.

bm25 grows with the logarithm of a library's size, so no bm25 number serves both libraries: the
small library's lowest related score is 2.9811 and the recorded corpus's highest unrelated score
is 16.9767. The threshold is therefore counted in `recallScoreUnit`, the bm25 weight of a word
exactly one of the library's N records carries, ln((N - 0.5) / 1.5): 5.9906 over the 600 records
of the mixed index, 0.8473 over the small library's 4. A score in the tables below is bm25 divided
by the unit of its own index.

- The rule: the smallest whole number above the best score any unrelated prompt of either group
  reaches (2.8339), provided it is no higher than the lowest score a related query reaches for its
  own Story (3.5184). That gives 3; in bm25 it is a floor of 17.9719 on the mixed index and 2.5419
  on the small library. Whole numbers, because `retrieval.tau` takes whole numbers.
- At 3, all sixteen prompts of the recorded group and all ten of the small library's are answered
  with nothing, and all five related queries are answered with their Story first. At 0, thirteen
  and six of them are answered: the gate's mutation check (`RETRIEVAL_EVAL_THRESHOLD_DETACHED`
  when either group answers none).
- `node scripts/retrieval-eval.mjs --calibrate` recomputes it. The gate refuses a threshold the
  rule does not give on the corpus it names, a window the corpus no longer gives, or one the
  engine does not ship (`RECALL_STRONG_TAU`); and when no whole number lies between the two ends
  it fails rather than choose, because that trade-off belongs to the Owner (MIN-235 D9).
- Before D9 the threshold was 17 in raw bm25, the smallest multiple of 0.25 above 16.9767; at 17
  the small library's goal words, body words and title were each answered with nothing.

| Recorded corpus, unrelated | bm25 | Score |
| --- | --- | --- |
| how do I cook the rice and the beans | 0 | 0 |
| I want to book a flight to Tokyo in May | 0 | 0 |
| can I get a refund for a pair of shoes | 9.5002 | 1.5858 |
| what is the weather like in Paris today | 9.069 | 1.5139 |
| write a short poem about the sea and the sky | 10.6612 | 1.7796 |
| name the capital of Australia and the capital of Peru | 5.9929 | 1.0004 |
| how many calories are in a banana | 0 | 0 |
| recommend a good novel for a long train ride | 16.9767 | 2.8339 |
| 今天的天气怎么样 | 15.0682 | 2.5153 |
| 推荐一部好看的电影 | 10.8381 | 1.8092 |
| 红烧肉怎么做才好吃 | 7.0476 | 1.1764 |
| 周末去爬山要带些什么 | 10.7263 | 1.7905 |
| 帮我写一首关于春天的诗 | 8.9226 | 1.4894 |
| 北京到上海的高铁要多久 | 8.3769 | 1.3983 |
| 猫咪不爱喝水怎么办 | 9.4241 | 1.5731 |
| 明天早上七点叫我起床 | 11.437 | 1.9091 |

"recommend a good novel for a long train ride" meets "good" and "train" in a Story written in
English.

| Small library, related | Field | bm25 | Score |
| --- | --- | --- | --- |
| pangolin sighting tally | goal | 3.648 | 4.3055 |
| quokka moult calendar | body | 3.1608 | 3.7304 |
| Offline tally sheet | title | 4.4343 | 5.2334 |
| nest photo | goal (the other Story) | 2.9811 | 3.5184 |
| Photo attachment | title (the other Story) | 3.28 | 3.8712 |

| Small library, unrelated | bm25 | Score |
| --- | --- | --- |
| what is on the football calendar this season | 1.0536 | 1.2435 |
| how long does a photo print take to dry | 1.6712 | 1.9724 |
| is the new tablet worth buying | 1.0536 | 1.2435 |
| sheet music for a beginner piano piece | 1.4467 | 1.7075 |
| best signal booster for a rural house | 1.0536 | 1.2435 |
| can I watch films offline on a plane | 1.4467 | 1.7075 |
| how do I cook the rice and the beans | 0 | 0 |
| 今天的天气怎么样 | 0 | 0 |
| 推荐一部好看的电影 | 0 | 0 |
| 明天早上七点叫我起床 | 0 | 0 |

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
| Mixed index at the threshold (bm25 floor 17.9719), same questions | 18 | 22 | 22 | 24 at @8 with a bm25 floor of 1 |
| Language, 36 English renderings | 14 | 21 | 24 | |
| Real prompts, 30 judged | | | | precision@3 0.1 (0.1222 with a bm25 floor of 1) |
| Incident replay, 277 pairs | 203 | 233 | 235 | |
| Development set, 20 Incidents | 19 | 20 | 20 | |
| Pre-registered holdout, 20 records | 14 | 17 | 17 | |
| Small library, 5 related queries | 5 | 5 | 5 | 0 of 10 unrelated answered (6 at a threshold of 0) |

Re-measured when the threshold moved to `recallScoreUnit` (MIN-235 D9): every floor above is
unchanged. At 600 records the new default is a bm25 floor of 17.9719, and every group measures the
same there as at the old 17.
