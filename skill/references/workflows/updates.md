## Daily update check

At the start of a connection/coding session, a cached `c2c update-check --json`
may discover updates; reuse that result within the task. An explicit update
request uses the update workflow. Do not trigger updates when disconnecting,
stopping, rolling back, or merely reading state. Update discovery alone does
not broaden the current task's installation authority.

Run `c2c sandbox-allow --json` only when authorized setup/repair needs state-dir
access and the existing configuration does not already allow it. It writes the
C2C state directory into Codex's
   sandbox `writable_roots` (macOS: `~/Library/Application Support/codex-with-chatgpt`;
   Windows: `%LOCALAPPDATA%\codex-with-chatgpt`; config file is
   `~/.codex/config.toml` on both, or `%USERPROFILE%\.codex\config.toml` on Windows).
   If already allowlisted, this is a no-op and does not trigger elevation.

- `{ "updateAvailable": false }` → continue silently. Never mention the check.
- `{ "updateAvailable": true }` → this is version information, not installation authority. If the current request explicitly asks to update, or a verified standing authorization clearly covers this exact update, enter the workflow below. Otherwise keep the current version, record the available update, continue the original task, and only mention it when relevant; do not download, build, install, switch versions or restart anything.
- `{ "updateDeferred": true }` → keep the current version and local changes;
  do not start the update workflow or mention the check during an unrelated task.

## Workflow: update（仅限明确或已核实持续授权覆盖的更新）

明确更新（老板本次要求“更新”，或已核实的持续授权覆盖当前版本与操作范围）统一调用 `c2c update --json`；该命令
负责候选目录、三方合并、测试门槛和原子版本指针。日检仅负责发现版本，不得直接在
活动目录执行更新，也不得被解释为授权来源；检测到本地改动时只返回 `updateDeferred`，等待明确更新触发。

若老板明确指定一个本地候选版本，必须同时提供该候选的完整 Git 提交和实际已安装
checkout 的路径；使用
`node "<candidate>/dist/cli/index.js" update --candidate "<candidate>" --commit "<40-char-sha>" --installed-source "<installed-checkout>" --json`。
`--installed-source` 必须是与候选不同、可读取且通过 Git HEAD、入口、package.json
和依赖树校验的已安装 source；候选自身不能被猜作旧版本来源。该路径会由同一更新器
先核对候选工作树、精确 HEAD 和干净的已跟踪文件，再在 state 目录的 `candidates/`
下建立隔离副本，执行与普通更新相同的测试、类型检查和构建，最后走同一把更新锁、
Skill 备份和原子版本指针流程。已安装 Skill 会先与已验证 installed source 的旧模板
比较（只规范化 checkout 路径）；只有检测到真实本地定制才保留现有内容，否则写入候选
模板并绑定回退备份。不要把工作树路径直接写入活动指针，也不要用普通
`c2c update` 把非上游候选重新生成成另一版本。

Inside the checkout directory (see Locations):

1. **保护现场（强制）**：先执行 `git status --porcelain=v1 --untracked-files=all`。
   只要有任何已跟踪或未跟踪改动，禁止 `git stash`、`git pull`、`git reset`、
   `git clean`、`git restore`、`git checkout`、rebase、覆盖文件或在当前目录
   直接安装新版本。原目录必须继续保持原样；不要删除现有 stash。
2. **准备隔离候选**：在 checkout 同级创建带时间戳的独立候选目录（优先
   `git worktree add --detach <candidate> origin/HEAD`，不可用时使用全新
   clone），只在候选目录获取远端版本。把原 checkout 的已跟踪差异以
   `git diff --binary` 生成的补丁做三方应用；若本地分支相对远端基线还有
   未推送提交，先在候选中以“远端基线 → 本地 HEAD”的差异叠加工作树差异，
   不改写原分支。只复制参与构建的普通未跟踪源/测试文件，其他未跟踪数据
   留在原目录；`.env`、密钥、凭据、证书和其他敏感文件不得复制。应用冲突时停止候选，
   保留当前版本继续运行，不修改原目录。
3. **候选验证**：只在候选目录运行 `corepack pnpm install`、测试、类型检查
   和 `corepack pnpm build`。任何失败、超时、依赖锁文件变化异常或候选无法
   证明包含本地改动时，放弃切换并保留原版本；不得用覆盖或强制合并“修复”。
4. **原子切换**：候选全部通过后，先在 state 目录的 `candidates/` 下保留当前
   可运行版本，并备份当前生效的 Skill；若已安装 Skill 与仓库模板存在本地定制
   差异，也必须在候选中做三方合并，冲突时保留当前 Skill，不得静默覆盖。只有
   合并无冲突且校验通过，才原子写入 `active-version.json` 和
   `previous-version.json`。两个版本指针都绑定对应的 Skill 备份；首次更新无法
   物化完整旧版本时必须阻断。稳定启动器只从 state 目录 `candidates/` 下的正规
   候选入口加载，并把指针中的精确提交传入运行时。`c2c update --json` 会明确
   返回需要激活；只有确认 Bridge 的 workspace 身份和当前工作区完全匹配时，
   才对该工作区执行一次 `c2c restart -w <workspace>`。状态未知、workspace
   不匹配或无法确认活动版本时，不自动重启。原 checkout、旧 Skill 和旧候选
   目录都保留，作为回滚版本。
5. **回滚门槛**：切换后运行 `c2c doctor -w <workspace> --json` 及一次
   工作区读取/搜索/Git 检查。任一失败立即执行 `c2c rollback --json`，再只重启
   一次已确认工作区的现有连接并复核；`rollback` 在同一更新锁下只交换已验证的
   `active-version.json` 与 `previous-version.json`，并恢复目标版本绑定的 Skill
   备份；指针、候选目录或 Skill 备份不完整时保持当前状态并报告阻断。不会删除
   候选或触碰用户项目目录，禁止循环重启。
6. 通过上述验证后执行 `c2c sandbox-allow --json`，再运行
   `c2c update-check --force --json` 刷新缓存。只在真实切换成功后告诉用户
   `✓ 已更新到最新版本`，然后继续触发更新的原任务。

如果当前 checkout 有本地改动，更新仍可通过“隔离候选 + 三方合并 + 测试 +
原子切换”完成；它不会把本地改动暂存、隐藏或覆盖。若存在冲突，更新会安全
延期，而不是强行升级。后续新建项目自动使用当前通过验证的候选版本；项目本身
不需要复制更新配置。
   (The updated SKILL.md takes effect from the next Codex session; that's expected.)
