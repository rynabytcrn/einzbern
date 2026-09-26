# Migrate an installation from before the rename

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

Use it when a plan or `doctor` reports an installation from before the engine was named Einzbern:
an older engine copy, its helper skill copies or hooks, or an old-layout workspace. It is the
wizard for `setup --mode migrate`. Run the engine verbs below the way SKILL.md says to invoke the
engine. Supply two flags yourself: `--project <dir>`, the root of the project (ask only when it is
unclear which project), and `--at <UTC>`, the current instant written `YYYY-MM-DDTHH:MM:SSZ`.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Ask
only the questions the plan reports as open, never ask again for an answer the user already gave,
and never guess an answer.

1. Mapping. Which library each old workspace the plan found moves into. Show the plan's proposed
   mapping as a table (old workspace, project, library location) and ask whether it is right. If
   the user changes it, write the changed mapping as a JSON file in the shape the plan shows, in a
   temporary directory outside the project, and pass it with `--mapping <file>`.
2. Cloud drive. Is a library location synced by a cloud drive? The plan suggests an answer from
   the location. Flag: `--cloud true` or `--cloud false`.
3. Language. The language of the text Einzbern writes into the project's instruction files, as a
   language tag such as `en` or `zh`. Flag: `--language <tag>`.
4. Navigation section. Add a short section that points agents to Einzbern in the project's
   instruction files? Flag: `--navigation true` or `--navigation false`.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode migrate --project <dir> --at <UTC>`, with a flag for each answer
   already known and without `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: what it
   found, the decided answers, the open questions, and the files it would write or move.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the mapping, the decided answers, and every file the plan would write
   or move, as the plan lists them, and ask once whether to apply. Continue only on a clear yes.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   two columns of settings, the backup directory, and `selfCheck`.
5. Report the backup directory, the two columns (settings carried into the library, and settings
   to set again on this device), and the eight checks in `selfCheck`. Handle any check that is
   not ok with `doctor.md`.

## Backup, and move but never delete

- Before it changes anything, the migration backs up every file it will touch into the device
  directory's backups; the result names the backup directory.
- What it retires, such as old hooks, templates, and skill copies, is moved into that backup and
  never deleted.
- The old workspace stays where it is. Its history is imported into the new library's first
  stream; afterwards the old workspace still opens, read-only, and a write to it is refused with
  `LEGACY_WORKSPACE_READ_ONLY`. Point the user at the new library instead.
- Never edit, move, or copy files inside the old workspace yourself; only the engine reads it.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Mapping changed by the user | `--mapping <file>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Language | `--language <tag>` |
| Navigation section | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
