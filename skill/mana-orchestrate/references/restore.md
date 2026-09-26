# Restore Einzbern from an existing library

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

It is the wizard for `setup --mode restore`: the user already has a library, made on another
device, left from before a reinstall, or kept in a backup or a cloud drive, and wants this device
and project to use it. Run the engine verbs below the way SKILL.md says to invoke the engine.
Supply two flags yourself: `--project <dir>`, the root of the project (ask only when it is unclear
which project), and `--at <UTC>`, the current instant written `YYYY-MM-DDTHH:MM:SSZ`.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Ask
only the questions the plan reports as open, never ask again for an answer the user already gave,
and never guess an answer.

1. Library path. Where is the library to restore from? If the user is unsure, offer the usual
   places: inside the project, or the cloud-drive default `<cloud drive>/Ether/<project name>/`.
   Flag: `--restore <library path>`.
2. Cloud drive. Is that folder synced by a cloud drive? The plan suggests an answer from the
   location. Flag: `--cloud true` or `--cloud false`.

Do not ask for the project's settings: they come back from the library, and the plan shows them
among the decided answers.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode restore --project <dir> --at <UTC> --restore <library path>` without
   `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: the decided answers, the open
   questions, and the files it would write. If the library sits in a cloud-drive folder that is
   still syncing, let the sync finish first.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the library path, the decided answers, and every file the plan would
   write, as the plan lists them, and ask once whether to apply. Continue only on a clear yes.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   two columns of settings, the backup directory, and `selfCheck`.
5. Report the two columns and the eight checks as the next two sections say.

## Two columns

Show the settings side by side:

- Restored for the project: project-level settings that came back from the library. Nothing more
  to do for them.
- To set again on this device: device-level settings, which never travel with the library. Tell
  the user each of them has to be set on this device and offer to do it; those that match a flag
  in the table below go on one new question screen.

## Eight checks

Report the eight checks from `selfCheck`, or from `doctor --project <dir>` run right after:
engine-version, hooks-present, skill-copies, registry, library-format, device-stream,
managed-sections, cloud-flag. For each check that is not ok, name it, quote its reasonCode and
detail as they are, say in one plain sentence what went wrong, and give the handling in
`doctor.md`. The failures a restore meets most:

- library-format: a newer engine wrote the library (`ENGINE_TOO_OLD`,
  `LIBRARY_FORMAT_UNSUPPORTED`). Update this device's engine with `update.md`, then restore again.
- registry: the path holds no library, or another library than the one recorded
  (`LIBRARY_NOT_FOUND`, `LIBRARY_REGISTRY_MISMATCH`). Ask for the right path and restore again.
  A path that holds an old-layout workspace instead is a migration: use `migrate.md`.
- registry: the library moved and its old place refuses writes (`LIBRARY_TOMBSTONED`, naming the
  new place). Restore from the new place.
- cloud-flag: the answer does not match where the library sits. Ask the cloud-drive question
  again.

Never retry a failed restore unchanged, and never edit files inside the library to make a check
pass.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Library path | `--restore <library path>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
