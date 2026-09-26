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
   language tag such as `en` or `zh`. Flag: `--language <tag>`.
4. Navigation section. Add a short section that points agents to Einzbern in the project's
   instruction files? If not, the section is left out; the skill and the hooks are installed
   either way. Flag: `--navigation true` or `--navigation false`.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode fresh --project <dir> --at <UTC>`, with a flag for each answer already
   known and without `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: the decided
   answers, the open questions, and the files it would write.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the decided answers and every file the plan would write, as the plan
   lists them, and ask once whether to apply. Continue only on a clear yes; a changed answer goes
   back to step 2.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   the backup directory, and `selfCheck`.
5. Report the files written, the backup directory, and the eight checks in `selfCheck`. Handle
   any check that is not ok with `doctor.md`.

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
