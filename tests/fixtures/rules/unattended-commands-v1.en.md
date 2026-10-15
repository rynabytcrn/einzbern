## Unattended Commands Principle v1

When running unattended, a confirmation dialog is a stall: the dialog returns no error, and the session simply waits forever. Treat every way of writing a command that might raise a dialog as forbidden and use an equivalent form instead; do not try it first to see what happens.

1. Move instead of deleting. To clear away a file or directory, first mv it into the trash subdirectory of this session's scratch directory. For files a repository tracks, use git rm. Do not use rm or rmdir.
2. No cd in commands. Always use absolute paths. To run git against another directory, use git -C with that directory.
3. Write only to the working directory and the scratch directory. To create a clone or a mirror somewhere else, first add that directory to the session with a launch argument or /add-dir, and only then begin.
4. Never touch a path or command that the permission rules list under deny or ask, and do not copy them elsewhere to deal with them there.
5. Do not retry a form that raised a dialog. Record it on this batch's problem list and carry on with an equivalent form.

Host notes. Claude Code: rm or rmdir aimed at the root directory, home or the working directory itself raises a dialog, and so does running git after a cd into another directory; both raise a dialog under bypass as well.
