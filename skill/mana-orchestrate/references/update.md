# Update, repair, or roll back Einzbern

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

It is the wizard for an installation that already runs on this device: update it to a newer
engine (`setup --mode update`), repair this device's wiring (`setup --mode repair`), or roll back
to the engine version that ran before (`setup --mode update --rollback true`). Run the engine
verbs below the way SKILL.md says to invoke the engine. Supply two flags yourself:
`--project <dir>`, the root of the project (ask only when it is unclear which project), and
`--at <UTC>`, the current instant written `YYYY-MM-DDTHH:MM:SSZ`.

## Questions (one screen)

Ask the whole list at once, in one message. The list is the same on both hosts: Claude Code asks
it in one AskUserQuestion call, Codex asks it in the conversation as one numbered message. Skip a
question the request already answers, never ask again for an answer the user already gave, and
never guess an answer.

1. Action. Update to a newer engine, repair this device's wiring, or roll back to the previous
   engine? Flags: `--mode update`, `--mode repair`, or `--mode update --rollback true`.
2. Source, for an update only. Is there a release archive on this device, a file named
   `einzbern-<version>.tar.gz` with its `.sha256` file beside it, or the directory it unpacks to?
   If so, pass it with `--archive <local archive>`. If not, getting one is a separate step: name
   the file and where it would come from, and fetch it only after the user agrees.

Repair and rollback ask nothing more unless the plan reports an open question: a repair may take
the cloud-drive and navigation answers again (`--cloud`, `--navigation`).

The navigation answer belongs to this device, not to one project. After a repair or an install
changes it, repair each other project this device has registered (`library-list` names them,
each entry's `projectPath`) with the same `--navigation` answer, as below. Until then that
project's instruction files keep the old choice, so agents there get the navigation twice or not
at all, and doctor does not report it.

## Before you plan

- Repair. Run `doctor --project <dir>` first and show which checks fail. Repair puts back what
  this device's installation of the project should have: the registry entry, the hooks, the skill
  copies, the launchers, the project's write permissions and its managed sections. It needs the
  project registered on this device (`LIBRARY_NOT_REGISTERED` otherwise: install or restore
  instead); for the other checks, follow `doctor.md`.
- Rollback. This device keeps the engine versions it installed and switches between them, so a
  rollback fetches nothing. It is refused with `ENGINE_ROLLBACK_UNAVAILABLE` when no earlier
  version is still installed.

## Plan, final confirmation, apply

1. Plan. Run `setup --mode <mode> --project <dir> --at <UTC>` with the flags of the chosen action
   and without `--yes`. It writes nothing and returns `SETUP_PLAN_READY`: the decided answers, the
   open questions, the files it would write, and any blockers. An update or a rollback names the
   version it moves from and to (`engineSwitch`). An update without `--archive` or
   `--rollback true` names that question and cannot be applied (`SETUP_ANSWER_REQUIRED`). A
   release that does not match the sha256 beside it (`INSTALL_ARCHIVE_DIGEST_MISMATCH`), has none
   (`INSTALL_SHA256_MISSING`), is not a release (`INSTALL_ARCHIVE_INVALID`), or whose files do not
   hash as its manifest states (`INSTALL_TREE_DIGEST_MISMATCH`) is a blocker: get the release again
   and never edit it.
2. Ask any open question on one screen, then plan again with the answers until none is open.
3. Final confirmation. Show the action, the engine version it moves to as the plan names it, and
   every file the plan would write, as the plan lists them, and ask once whether to apply.
   Continue only on a clear yes. A repair plan's `warnings` name each project host file that Git
   tracks and that the wiring writes this device's library path into
   (`HOST_WRITABLE_ROOTS_TRACKED_BY_GIT`): show each with its file and message before asking, and
   again from `SETUP_APPLIED`, as `install.md` does.
4. Apply. Run the same command with `--yes true`. It returns `SETUP_APPLIED`: the files written,
   the backup directory, the switch it made (`engineSwitch`, for an update or a rollback), and
   `selfCheck`.
5. Report the result, the eight checks in `selfCheck.checks`, and what the hook added for the
   project's name as a sample prompt (`selfCheck.injected`). Handle any check that is not ok with
   `doctor.md`.

## What an update leaves alone

- It never rewrites managed sections or rules by itself. When newer text is available, say so and
  leave it until the user asks for it.
- It does not move a shared library to a newer format behind other devices: while another device
  that uses the library runs an older engine, a write that would raise the format is refused with
  `LIBRARY_UPGRADE_NOT_READY`, and its hint names the devices to update first.
- After a rollback, the older engine refuses a library that a newer engine already moved to a
  newer format (`LIBRARY_FORMAT_UNSUPPORTED` or `ENGINE_TOO_OLD`). Tell the user; do not work
  around the refusal.
- The release it unpacked stays in the device directory's `trash/`; nothing is deleted.

## Flags

| Answer | `setup` flag |
| --- | --- |
| Update | `--mode update` |
| Repair | `--mode repair` |
| Roll back | `--mode update --rollback true` |
| Release archive on this device, or its unpacked directory | `--archive <local archive>` |
| Cloud drive, for a repair | `--cloud true` or `--cloud false` |
| Navigation section, for a repair | `--navigation true` or `--navigation false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task. Anything it replaces is backed up first, and the result names the backup
directory.
