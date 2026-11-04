# unattended-execution-v1

Load only when the corresponding principle is enabled and this task needs its procedures. Existing task authorization and approved methods remain authoritative; this reference adds no agents, stages or permissions to an ordinary task.


## Unattended Commands Principle v2

When running unattended, a confirmation dialog is a stall: the dialog returns no error, and the session simply waits forever. For authorized actions permitted by the host, choose an equivalent noninteractive form without probing for a dialog first. Actual permission denials, required user confirmations and unauthorized actions still stop the affected path; equivalent syntax must not bypass them.

1. Move instead of deleting. To clear away a file or directory, first mv it into the trash subdirectory of this session's scratch directory. For files a repository tracks, use git rm. Do not use rm or rmdir. With the Owner's authorization, empty the named trash directories under the session's scratch directory with the trash-empty tool that ships with the skill (it deletes only directories named trash or trash-<name> that sit under the given scratch root and are not symbolic links, and it lists its plan before it acts); each authorization covers one report that lists the paths and sizes, answered once by the Owner.
2. Keep working directories explicit through the host working-directory option or git -C. Persist paths relative to their declared project, device or document base; resolve them only at execution. Do not bake a device path into generated files.
3. Write only to the working directory and the scratch directory. To create a clone or a mirror somewhere else, first add that directory to the session with a launch argument or /add-dir, and only then begin.
4. Never touch a path or command that the permission rules list under deny or ask, and do not copy them elsewhere to deal with them there.
5. Classify a dialog and verify the execution outcome first. Respect an actual permission or authorization stop. Use a permitted equivalent form only for an interaction problem in an authorized action known not to have executed; never retry blindly.

Host notes. Claude Code: rm or rmdir aimed at the root directory, home or the working directory itself raises a dialog, and so does running git after a cd into another directory; both raise a dialog under bypass as well.

## 无人值守指令原则 v2

无人值守时，弹出确认框等于停摆：确认框不返回错误，会话只是无限等待。对已获授权且权限允许的动作，选择不会弹出交互确认的等价写法，不先试探。真实权限拒绝、必须由用户完成的确认与未获授权动作仍停止相应路径；等价写法不能用于绕过它们。

1. 删除改为移动。要清掉的文件或目录先 mv 到本会话 scratch 目录下的 trash 子目录。仓库里已跟踪的文件用 git rm。不用 rm 与 rmdir。经 Owner 授权后，用技能自带的 trash-empty 工具清空会话 scratch 下点名的 trash 目录（只删名为 trash 或 trash-<名>、位于给定 scratch 根下、不是符号链接的目录，先列计划再执行）；授权的粒度为每次汇报列出路径与体积、Owner 答复一次。
2. 通过宿主工作目录参数或 git -C 明确命令的基准目录。持久文件使用相对于已声明项目、设备或文档基准的路径，执行时再解析；生成物不得固化设备绝对路径。
3. 只写工作目录与 scratch 目录。要在别处建克隆或镜像，先用启动参数或 /add-dir 把那个目录加入会话再动手。
4. 权限规则里 deny 或 ask 列出的路径与命令一概不碰，也不把它们复制到别处再处理。
5. 弹了框先核对性质与执行结果。属于实际权限或授权停点时按该边界处理；只是已获授权动作的交互写法问题且已确认未执行时，才换允许的等价写法继续，不盲目重试。

宿主说明。Claude Code：rm 或 rmdir 指向根目录、home、工作目录本身会弹框，cd 进另一个目录再跑 git 会弹框，两者在 bypass 下同样弹。
