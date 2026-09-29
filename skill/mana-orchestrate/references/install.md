# Install Einzbern in a project

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

It is the wizard for a first installation, `setup --mode fresh`: one screen of questions, one final
confirmation, then the apply. Run the engine verbs below the way SKILL.md says to invoke the
engine. Supply two flags yourself: `--project <dir>`, the root of the project being set up (ask
only when it is unclear which project), and `--at <UTC>`, the current instant written
`YYYY-MM-DDTHH:MM:SSZ`.

## Use another reference when

- The user already has a library, from another device or a backup: `restore.md`.
- The plan reports an installation from before the rename: `migrate.md`.
- Einzbern already runs here and the user wants a newer engine, a repair, or a rollback:
  `update.md`.

## Before the plan: an engine on this device

The wizard installs from the engine that is current on this device. When
`<device directory>/engine/einzbern.mjs` does not exist, or a plan reports the blocker
`SETUP_ENGINE_NOT_INSTALLED`, put an engine there first with this skill's fetch step:
`node <skill directory>/scripts/install.mjs --archive <local archive>` installs a release archive
the user already has and fetches nothing, and `--version <version>` downloads that release. The
download is the only network use of the whole installation, so ask the user before it. The step
answers `INSTALL_ENGINE_READY`; then plan as below.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Ask
only the questions the plan reports as open, offer the plan's suggestion as the first choice,
never ask again for an answer the user already gave, and never guess an answer.

1. Library location. The library is the directory that holds all of this project's records. It
   can sit inside the project, in a cloud-drive folder (by default
   `<cloud drive>/Ether/<project name>/`), or in a directory the user names.
   Flag: `--artifacts <library path>`.
2. Cloud drive. Is the library's folder synced by a cloud drive? The plan suggests an answer from
   the location. Flag: `--cloud true` or `--cloud false`.
3. Language. The language of the text Einzbern writes into the project's instruction files, as a
   language tag the plan lists among the question's choices, such as `en` or `zh-CN`.
   Flag: `--language <tag>`.
4. Navigation section. Add a short section that points agents to Einzbern in the project's
   instruction files? If not, the section is left out and the hooks point agents to Einzbern
   instead; the skill and the hooks are installed either way. Flag: `--navigation true` or
   `--navigation false`. The answer belongs to this device, not to the project, and each project
   registered here follows it only once it is repaired: when the answer changes, repair each
   other project `library-list` names with the same `--navigation` answer, as `update.md` says.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode fresh --project <dir> --at <UTC>`, with a flag for each answer already
   known and without `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: the decided
   answers, the open questions, the files it would write, the originals it would back up first,
   any warnings, and any blockers. A plan with blockers is refused on apply (`SETUP_BLOCKED`): show
   each blocker and resolve it before going on. A warning does not stop the apply:
   `HOST_WRITABLE_ROOTS_TRACKED_BY_GIT` names a project host file, `.claude/settings.local.json`
   or `.codex/config.toml`, that Git tracks and that the apply writes this device's library path
   into, because the library sits outside the project; committing that file would publish the path.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the decided answers and every file the plan would write, as the plan
   lists them, then each entry of `warnings` with its file and message, and ask once whether to
   apply. Whether such a file stays tracked is the user's call: say so, and change nothing in Git.
   Continue only on a clear yes; a changed answer goes back to step 2.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   the backup directory, the same `warnings`, and `selfCheck`.
5. Knowledge store. A new library has none yet: until it has one, no card can be written to it,
   `knowledge-list` refuses with `KNOWLEDGE_PATH_INVALID`, and `recall` reports the project's
   store that way under `knowledgeStores`. Create it once with
   `knowledge-init --workspace <library path> --acknowledge-disposable true`, the library path
   being the one the plan decided; it answers `KNOWLEDGE_STORE_INITIALIZED`. A library that
   already has a store answers `KNOWLEDGE_ALREADY_EXISTS`, and that store stays as it is.
6. Report the files written, the backup directory, each warning again, and the self-check: the
   eight checks in `selfCheck.checks`, and what the hook added when it ran once with the project's
   name as the prompt (`selfCheck.injected`; nothing is added until the library holds something
   that matches). Handle any check that is not ok with `doctor.md`.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Library location | `--artifacts <library path>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Language | `--language <tag>` |
| Navigation section | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

Check the installation again at any time with `doctor --project <dir>`.

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task. Whether a library inside the project is committed or ignored is the user's
call; say so if it comes up and change nothing.
