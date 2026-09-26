# Uninstall Einzbern from a project

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

It is the wizard for `setup --mode uninstall`: it takes Einzbern's wiring out of the project and
this device, as the plan lists it, and it never deletes the library. Run the engine verbs below
the way SKILL.md says to invoke the engine. Supply two flags yourself: `--project <dir>`, the root
of the project (ask only when it is unclear which project), and `--at <UTC>`, the current instant
written `YYYY-MM-DDTHH:MM:SSZ`.

## Questions (one screen)

There is one question, asked once for all managed sections together, never section by section.
It is the same on both hosts: Claude Code asks it in one AskUserQuestion call, Codex asks it in
the conversation. Skip it if the user already answered it, and never guess the answer.

1. Managed sections. These are the sections Einzbern wrote into the project's instruction files.
   Keep them in the files as ordinary text the user owns, or remove them? Flag:
   `--managed-sections keep` or `--managed-sections remove`.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode uninstall --project <dir> --at <UTC>`, with the managed-sections flag
   if the user already answered, and without `--yes`. It writes nothing and returns
   `SETUP_PLAN_READY`: the decided answers, the open questions, and the files it would change.
2. Ask the managed-sections question if the plan reports it open, then plan again with the
   answer.
3. Final confirmation. Show every file the plan would change, as the plan lists them, and say
   plainly that the library stays where it is with all of its records. Ask once whether to apply.
   Continue only on a clear yes.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files changed
   and the backup directory.
5. Report the files changed, the backup directory, and where the library still is.

## What stays

- The library is never deleted or moved. Connecting a project to it again later is a restore:
  `restore.md`.
- Nothing is deleted: what the uninstall takes out is backed up into the device directory first,
  and the result names the backup directory.
- If the user also wants the library itself gone, that is the user's own step outside the wizard;
  do not do it as part of this task.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Keep the managed sections | `--managed-sections keep` |
| Remove the managed sections | `--managed-sections remove` |
| Yes at the final confirmation | `--yes true` |

Afterwards, `doctor --project <dir>` shows what is left on this device.

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
