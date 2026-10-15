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

## Clearing after a version change

Each install and update leaves its unpacked release in the device directory's `trash/`, and each
update leaves the copies it took in `backups/`. Once the new version runs and its checks are ok,
`device-clean --at <UTC>` lists them: each staging in `trash/` and each entry of `backups/`, with its
size and why it would be kept or cleared (`DEVICE_CLEAN_PLAN_READY`), an entry of `backups/` also
with what it holds one level down (`contents`), and writes nothing. It always keeps the pre-update
backups of the current and the previous version that `engine/current` names (the previous one is
what a rollback goes back to) and the staging of the current version; any other entry of `trash/` is
not a staging and stays too. Of the other entries of `backups/` it clears only one that holds the
skill copies alone (`skill-copies`), and only when, read further down without following a link,
all they hold is each host's copy as an update replaced it (`<host skill root>/mana-orchestrate`
under `.claude/skills` or `.agents/skills`), which a release places again (`skill-copies-backup`).
One that holds an original a write replaced (`host-hooks`, `writable-roots`, `managed-sections`,
`crest-bodies`, `launchers`, `registry`, `registry.json`) stays (`holds-originals`), and so does
one whose `skill-copies` holds anything the migration moved there, the old helper's copies or the
install markers of its retired trust chain, since those are the only copies there are. Anything
else it does not know stays too (`unrecognised-backup`): a name it does not know, a file or a link
where a directory belongs, or an empty directory. A symbolic link, or an area that leads out
of the device directory, is listed as refused and never touched. Show the plan with `removeBytes`,
and run the same command with `--yes true` only once the user agreed: it deletes what the plan
clears, each checked again, and `DEVICE_CLEANED` names each entry it deleted with its size, and any
it could not (`failed`). Without `engine/current` it judges nothing (`DEVICE_CLEAN_ENGINE_UNKNOWN`).

## Emptying a session's trash

An unattended session never runs rm or rmdir: whatever it clears it moves into a `trash` directory
under its scratch directory (the unattended-commands principle). Emptying that trash needs the
Owner's authorization, given once for each report that lists the paths and sizes. The skill's
`scripts/trash-empty.mjs` makes the report: `node <skill directory>/scripts/trash-empty.mjs
--scratch <scratch root> <trash directory>...` prints the plan and deletes nothing
(`TRASH_EMPTY_PLAN_READY`): each named directory's real path, how many entries it holds and their
size in bytes. A named directory is a path relative to the scratch root whose last segment is
`trash` or `trash-<name>`. It is refused (`TRASH_EMPTY_REFUSED`), and then nothing at all is deleted,
when it is written with a wildcard, an absolute path or a `.` or `..` segment, when it is a symbolic
link or not a directory, when its real path leads out of the scratch root, or when it is the same
as another named directory or lies inside one. A scratch root that is the filesystem root, the
user's home or a directory above it is refused as well (`TRASH_EMPTY_SCRATCH_ROOT_REFUSED`). Only
once the Owner has answered the report, run the same command with `--yes`: it checks each directory
again, deletes what it holds, keeps the directory itself, and answers `TRASH_EMPTIED` with how many
entries of each it deleted, or `TRASH_EMPTY_INCOMPLETE` with each one it could not.

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
| Clear old stagings and the backups that can be rebuilt after a version change: older pre-update backups and the skill copies an update replaced, never originals or what the migration moved | `device-clean --at <UTC>`, then `--yes true` once the user agreed |
| Empty the named trash directories under a session's scratch directory, never anything else | `node <skill directory>/scripts/trash-empty.mjs --scratch <scratch root> <trash directory>...`, then `--yes` once the Owner authorized the report |

## Boundaries

The wizard never commits, pushes, edits `.gitignore`, or deletes anything, and neither do you
during this task. Anything it replaces is backed up first, and the result names the backup
directory. The one deletion is `device-clean --yes true`, after the update and once the user
agreed: only the stagings and backups its plan clears, inside the device directory; a backup that
holds an original stays, the `launchers` and `registry` a write replaced and the old helper's copies
and install markers the migration moved among them, and so does a backup it does not know.
Emptying a session's trash is not part of this task: `trash-empty.mjs --yes` runs only after the
Owner authorized the report its plan made, and deletes only what the named trash directories hold.
