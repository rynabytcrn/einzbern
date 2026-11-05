# Disconnect a project or uninstall traditional device wiring

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

## Project disconnect

Run `library-unregister --project <dir> --at <UTC>` to preview removal of that project's device
registration. The plan names the registration and the registry backup directory. Apply with
`--yes true` after authorization. The project disconnect preserves shared hooks, Skill copies,
instruction files, and library records.

## Traditional device uninstall

Run `setup --mode uninstall` to remove traditional hooks and Skill copies shared by the device.
The `--project <dir>` argument selects the project for registration cleanup and managed-section
handling. Follow the engine invocation in SKILL.md. For both operations, use the project root and
the current UTC instant written `YYYY-MM-DDTHH:MM:SSZ`. The dot target follows its own
installation instructions.

## Questions (one screen)

There is one question, asked once for all managed sections together, never section by section.
It is the same on both hosts: Claude Code asks it in one AskUserQuestion call, Codex asks it in
the conversation. Skip it if the user already answered it, and never guess the answer.

1. Managed sections. These are the sections Einzbern wrote into the project's instruction files.
   Keep them as they are, markers included, or take the markers out and leave their text in the
   files as ordinary text the user owns? Flag: `--managed-sections keep` (the plan's default) or
   `--managed-sections remove`.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode uninstall --project <dir> --at <UTC>`, with the managed-sections flag
   if the user already answered, and without `--yes`. It writes nothing and returns
   `SETUP_PLAN_READY`: the decided answers, the open questions, and the files it would change:
   the hook files it takes the Einzbern hooks out of, the skill copies and their record it moves
   into the backups (`move`), the registry it takes the selected project's entry out of, and,
   with `remove`, the instruction files it takes the section markers out of. The plan's
   `uninstallImpact.affectedRegisteredProjectPaths` lists the registered paths at the time of
   the preview that will lose access to the shared wiring being removed.
   `uninstallImpact.selectedProjectRegistration` describes the cleanup for the selected
   `projectRoot`.
2. Ask the managed-sections question if the plan reports it open, then plan again with the
   answer.
3. Final confirmation. Show the affected registered paths, the selected registration cleanup,
   and every file and backup in the plan. Say that the libraries stay where they are with all
   their records. Ask once whether to apply. Continue only on a clear yes.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files changed,
   the backup directory, the observed `uninstallImpact`, and `selfCheck`, whose hooks-present,
   skill-copies and registry checks now report what was taken out.
5. Report the impact, the files changed, the backup directory, and where the library still is.
   Both answers carry `coordination`, which is `released` when the registration setup made for the
   coordination chain the library names goes with this project, `retained` when another
   registration still names it (or one does not read), or null when the library names none; the
   coordination library itself is never touched.

## What stays

- The library is never deleted, moved, or written. Connecting a project to it again later is a
  restore: `restore.md`.
- Nothing is deleted: what the uninstall takes out is backed up into the device directory first,
  and the result names the backup directory.
- If the user also wants the library itself gone, that is the user's own step outside the wizard;
  do not do it as part of this task.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Keep the managed sections | `--managed-sections keep` |
| Take the section markers out | `--managed-sections remove` |
| Yes at the final confirmation | `--yes true` |

Afterwards, `doctor --project <dir>` shows what is left on this device.

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
