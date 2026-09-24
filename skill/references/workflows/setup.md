## Connection choice (once per workspace)

Ask this **before** the public address exists (`c2c setup` / first `doctor --fix`
that starts a tunnel). Do not mention tunnels, wrangler, DNS, or hostnames.
Speak only of 临时地址 / 固定域名 / 登录 Cloudflare.

The CLI result is authoritative. Never infer that a choice is needed from the
user saying “首次配置”, from a new Codex conversation, from a stopped bridge, or
from an unavailable public address. A saved choice survives restarts and later
repairs. Never synthesize or repeat the choice prompt when `needsChoice` is
false or when `userPrompt` is absent.

1. `c2c tunnel status -w <workspace> --json`
2. If `needsChoice` is false: do not ask again.
3. If `needsChoice` is true: tell the user exactly `userPrompt` and wait.
   - 没有账号 / 没有域名 / 临时 / 不用 →
     `c2c tunnel choose -w <ws> --mode quick --json`
   - 有域名（例如 example.com）→ first tell them `loginPrompt`, then
     `c2c tunnel choose -w <ws> --mode named --zone <domain> --json`.
      This may open the user's own browser for Cloudflare login; follow the
      current user authorization and platform login boundary. Wait until the command finishes.
     If they said they have an account but gave no domain: ask once for the
     domain. If the command returns `need: "zone"`, ask once and retry.
     If `fallback` is true: tell them `userMessage` and continue on the
     temporary address. Do not retry named unless they ask.
4. Never put connection credentials in the project. The CLI stores them in
   the C2C state directory.

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

0. **Existing-setup guard (always run before any setup question).** Run
   `c2c tunnel status -w <workspace> --json` and
   `c2c session -w <workspace> --json`.
   - If `needsChoice` is false, reuse the saved connection preference without
     asking the user again. This applies even when the user literally invokes
     “使用 Codex with ChatGPT 完成首次配置” in a new Codex conversation.
   - If `needsChoice` is false and a saved session has `connectorName` plus a
     ready Project or chat URL, this workspace is already configured. Do not
     run the first-time connector creation flow. Run **Workflow: repair**
     (`c2c doctor`) and resume/verify the saved conversation instead.
   - If `needsChoice` is false but the saved session is incomplete, continue
     the remaining setup steps without repeating the connection-choice prompt.
   - Only when `needsChoice` is true may you show the exact returned
     `userPrompt` and wait for an answer.

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   If missing, reuse a verified existing installation first. Install a required
   dependency only when the user's setup request or prior instructions authorize
   it; otherwise explain the exact missing dependency and necessary action.
   Do not install unrelated packages or silently expand permissions.
2. If build output or dependencies are missing, follow the root `SKILL.md`
   **维护位置** section and `references/workflows/updates.md`; preserve the active source.
3. Run `c2c sandbox-allow --json`, then **Connection choice**, then
   `c2c setup -w <workspace> --json`.
   `sandbox-allow` edits Codex `config.toml` only — it adds C2C's state directory
   to `[sandbox_workspace_write].writable_roots` so later chats can write logs
    without elevation. If denied, follow the root `SKILL.md` **安全设置不变量**
    and the actual runtime permission policy; never invent an elevation path.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title (legacy installs stay
   `Codex with ChatGPT`; additional workspaces get `Codex with ChatGPT · <name>`).
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one if you're slow.
4. `c2c prefs --json` (this machine, not this workspace).
   - If `setupMode` is null: tell the user exactly `setupChoicePrompt`. Wait
     for「1」or「2」. Then `c2c prefs set --setup-mode auto` or `--setup-mode manual`.
     Do not open ChatGPT settings and do not start automatic configuration
     until they answer. Do not default to auto.
   - If they later ask to switch: same `c2c prefs set --setup-mode` command.
     Do not re-ask on a later workspace or on reconnect.
   - `setupMode: "manual"`: skip step 5's automatic ChatGPT settings. Go to
     **Guided manual ChatGPT setup** (chosen). Opening line:
     `接下来用手动教学配置。一次只需要做一个操作。`
     Do not say 自动配置没有成功.
   - `setupMode: "auto"`: continue with step 5. Keep the two-failure fallback.
5. Open ChatGPT on the ONE iab tab (see **In-app browser**). Foreground +
   markHandoff immediately. Same tab, `goto` only:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. Otherwise open it, enable 开发人员模式
     ("Developer mode") if it is off, then `c2c prefs set --developer-mode`.
     Never record it as off. If creating the connector later says developer
     mode is required, open this page, enable it, save `--developer-mode`,
     and retry create — do not skip that recovery.
   - 已有该 `connectorName`：先核对精确工作区、端点和新鲜 Doctor 结果，按
     `references/workflows/recovery.md` 选择当前受支持动作。健康连接直接复用；不得因同名、
     旧故障经验或设置记录不完整而删除重建。
   - 确认不存在，或当前证据与授权明确要求重建时：
     `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists, do not change it until the identity, Doctor
        result, supported action and current authorization all agree.
      - If it does not exist, create one with that exact name.
      - Recreate only when the selected recovery action explicitly requires it;
        never guess that the old Server URL is dead.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `把 ChatGPT 安全连接到当前 Codex 工作区，用于规划与复核。`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Fill the known form in one script when you can. Then Connect / Authorize
     and type the pairing code. As soon as it shows Connected / authorized /
     pairing accepted, continue — do NOT wait for 8 tools on this page.
6. Same tab: open the first C2C chat per **Conversation management**
   (Project collection for a new workspace; `https://chatgpt.com/` only
   in long-chat). Confirm Chat mode per **In-app browser** §7 (if it is Work,
   open a new Chat conversation instead). Send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then (same chat) send:
   `使用“<connectorName>”连接：调用 workspace_info，并读取顶层说明文件（如 README）。只回复工作区名称。`
   Confirm the reply matches `workspaceName` (wait per **In-app browser** §8).
   Only then save the chat URL with `c2c session set` (see Conversation
   management). If the name does not match, do not save. markDeliverable.
7. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE thing
to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

### Guided manual ChatGPT setup

Enter this path when `setupMode` is `manual` (chosen at the start), or when
automatic ChatGPT browser configuration fails twice at the same explicit
setup/reconnect step after `c2c doctor` / repair. Do NOT enter the failure
path for a browser/js timeout without a visible error, a page that is
still loading/generating, or while waiting for login / 2FA / CAPTCHA.
A chosen manual path does not wait for those two failures.

Stop automating ChatGPT settings. Keep the current local C2C state and the
current `mcpUrl`, `pairingCode`, `workspaceName`, and `connectorName`. Do not
silently fall back to Codex-only execution and do not permanently disable C2C.
Do not change the saved `setupMode` when this is a failure fallback.

Opening line:

- Chosen (`setupMode: "manual"`): `接下来用手动教学配置。一次只需要做一个操作。`
- Failure fallback: `自动配置没有成功，我来带你手动完成。一次只需要做一个操作。`

Then guide ONE action at a time, waiting for the user to say「好了」before the
next action:

1. If `developerModeEnabled` is not true: ask them to open
   `https://chatgpt.com/#settings/Security` and enable 开发人员模式. After they
   say「好了」, `c2c prefs set --developer-mode`. If it is already remembered,
   skip this step.
2. Ask them to open `https://chatgpt.com/plugins`. If the exact `connectorName`
   exists, first verify the exact workspace and fresh Doctor result. Reuse a
   healthy connector; only ask for the current supported recovery action when
   the evidence and authorization require it. Never ask them to touch another
   workspace's connector.
3. Only when no exact connector exists, or the selected recovery action requires
   recreation, ask them to open
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   and create the exact `connectorName` with:
   - Description: `把 ChatGPT 安全连接到当前 Codex 工作区，用于规划与复核。`
   - Server URL: the current `mcpUrl`
   - Authentication: OAuth
4. Ask them to Connect / Authorize and enter the current pairing code. If it
   expired, run `c2c pair --json` and give them only the fresh pairing code.
5. When they report Connected / authorized / pairing accepted, resume the normal
   setup/reconnect flow at its ChatGPT verification step. If automatic browser
   verification then hits the same explicit failure twice, stop and report the
   exact failed step; do not loop indefinitely and do not continue without C2C.
