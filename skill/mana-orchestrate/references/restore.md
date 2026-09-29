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
   places: inside the project (the plan suggests it when one is there), or the cloud-drive default
   `<cloud drive>/Ether/<project name>/`. Flag: `--restore <library path>`.
2. Cloud drive. Is that folder synced by a cloud drive? The plan suggests an answer from the
   location. Flag: `--cloud true` or `--cloud false`.

Do not ask for the project's settings: they come back from the library, and the plan shows them
among the decided answers.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode restore --project <dir> --at <UTC> --restore <library path>` without
   `--yes`. It writes nothing. It first runs eight checks of the library, and the first that fails
   stops the restore with its reason code, naming the check (next section). When all pass it
   returns `SETUP_PLAN_READY`: the eight checks, the decided answers, the open questions, and the
   files it would write. Without `--restore` the plan names that question and cannot be applied
   (`SETUP_ANSWER_REQUIRED`). If the library sits in a cloud-drive folder that is still syncing,
   let the sync finish first.
2. Ask the open questions on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the library path, the decided answers, and every file the plan would
   write, as the plan lists them, and ask once whether to apply. Continue only on a clear yes. The
   plan's `warnings` name each project host file that Git tracks and that the wiring writes this
   device's library path into (`HOST_WRITABLE_ROOTS_TRACKED_BY_GIT`): show each with its file and
   message before asking, and again from `SETUP_APPLIED`, as `install.md` does.
4. Apply. Run the same command with `--yes true`. It runs the eight checks again, then returns
   `SETUP_APPLIED`: the files written, two columns of settings, the backup directory, and
   `selfCheck`.
5. Report the two columns and the self-check as the sections below say.

## Eight checks before anything is written

A failed check is reported as its reason code with `check` naming it; quote both and the message.

1. `RESTORE_UNREADABLE` (`readable`): nothing is at the path, or a file did not arrive in time
   (a cloud-drive placeholder: `AKASHA_READ_TIMEOUT`). Let the sync finish, or ask for the path.
2. `RESTORE_NOT_A_LIBRARY` (`library`): the path holds no library. An old-layout workspace
   there is a migration instead: `migrate.md`.
3. `RESTORE_FORMAT_UNSUPPORTED` (`format`): a newer engine wrote the library. Update this device's
   engine with `update.md`, then restore again.
4. `RESTORE_STREAM_INVALID` (`streams`): an event stream in the library breaks, or a sync client
   kept a conflicted copy of one of its files. Stop and report it.
5. `RESTORE_PROJECT_MISMATCH` (`project`): the library belongs to another repository. Ask for the
   right library.
6. `RESTORE_REGISTRY_BOUND_ELSEWHERE` (`registry`): this device already uses another library, or
   another copy of this one, for the project. Uninstall that first with `uninstall.md`, or keep
   using it.
7. `RESTORE_DEVICE_STREAM` (`device-stream`): this device cannot write its own stream there: the
   library was moved (`LIBRARY_TOMBSTONED`, naming the new place: restore from there), or its
   folder is not writable.
8. `RESTORE_SECTIONS_DIVERGED` (`sections`): a managed section in the project's files differs from
   the library's record of it, or a file's marker is broken. Settle it as `doctor.md` says under
   managed-sections, then restore again. A broken marker is a line the user fixes. The
   managed-section verb works only in a project this device has registered, and a stopped restore
   has registered nothing, so on a device where the project is not registered yet (the verb
   refuses `LIBRARY_NOT_REGISTERED`) register the library first:
   `library-register --project <dir> --library <library path> --at <UTC>` answers
   `LIBRARY_REGISTERED`. Then settle the section with the managed-section verb and restore again:
   check 6 accepts the entry, because it binds the project to this same library.

Never retry a failed restore unchanged, and never edit files inside the library to make a check
pass.

## Two columns

Show the settings side by side:

- Restored for the project (`columns.project`): the project-level settings and records that came
  back from the library. Nothing more to do for them.
- To set again on this device (`columns.device`): device-level settings, which never travel with
  the library, each with its value on this device now. Tell the user each of them belongs to this
  device and offer to change it; those that name a setup flag go on one new question screen and
  are applied with `setup --mode repair`.

## Self-check

Report the eight checks from `selfCheck.checks`, or from `doctor --project <dir>` run right after:
engine-version, hooks-present, skill-copies, registry, library-format, device-stream,
managed-sections, cloud-flag. For each check that is not ok, name it, quote its reasonCode and
detail as they are, say in one plain sentence what went wrong, and give the handling in
`doctor.md`. Report also what the hook added for the project's name as a sample prompt
(`selfCheck.injected`).

## Flags

| Answer | `setup` flag |
| --- | --- |
| Library path | `--restore <library path>` |
| Cloud drive | `--cloud true` or `--cloud false` |
| Navigation section on this device | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task.
