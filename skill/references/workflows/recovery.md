## Workflow: reconnect after Doctor confirms address reclaim

Quitting Codex, a terminal or the machine does not by itself prove that the public address changed. Enter this workflow only when a fresh Doctor result for the exact workspace reports `chatgptRepair.needed: true` and identifies the required connector action. Do not infer authentication, endpoint or connector failure from a generic tool error.

For the currently verified implementation, `connectorAction: "update"` means the exact connector must be recreated with the new endpoint. This is a statement about the current Doctor contract, not a permanent claim that every future ChatGPT UI lacks a supported reconnect/update path.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green. Never "try a message first to see if it works".
   Reuse `c2c prefs --json`. Do not re-ask setup mode. If `setupMode` is
   `manual`, use **Guided manual ChatGPT setup** (chosen) instead of automating.
2. Same one iab tab as setup (foreground + markHandoff). Settings URLs only
   until Connected — never hunt menus:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. If create/delete then says developer
     mode is required, open it, enable, `c2c prefs set --developer-mode`.
   - 插件总管（只用来 Delete）: `https://chatgpt.com/plugins`
   - 加插件（Delete 之后必走）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Operate ONLY on `chatgptRepair.connectorName` and only when the current task has the required authorization for that connector change. Never touch another
   workspace's connector.
   - If Doctor explicitly returns `connectorAction: "update"` and that exact name exists on the plugins hub, use the currently verified delete-and-recreate path. Apply the UI confirmation policy to deletion. Do not click unrelated controls or assume a similarly named connector is the target. If Doctor or the current supported UI provides a different verified repair action, follow that exact fresh evidence instead of this historical path.
   - Then `goto` the 加插件 URL and create that **same** `connectorName`
     (do not invent a second name):
      - Description: `把 ChatGPT 安全连接到当前 Codex 工作区，用于规划与复核。`
      - Server URL: `chatgptRepair.mcpUrl`
      - Authentication: OAuth
     Then Connect / Authorize and type `chatgptRepair.pairingCode`
     (or `c2c pair --json` if it expired). Continue as soon as it is Connected —
     do not wait for 8 tools on the settings page.
   - If the name is already gone, skip Delete and only create.
4. `c2c doctor --json` again. Same tab: only after the Doctor gate is green,
   reopen the chat this Codex thread was already using (`session.url` /
   the URL you saved earlier in THIS thread). Do not start a new
   audit/task chat just because the address changed. Do not rewrite Project
   instructions — they store the connector **name**, which did not change.
5. If the ChatGPT conversation was lost: long-chat → Conversation
   management switch. project → collection page, new chat, boot + HANDOFF.
   No file re-uploading (the workspace lives in MCP). After recreating the
   same-name connector, the Project still uses that name. If tools point at
   the wrong connector, open 项目设置 and confirm 指令 still names
   `connectorName` (never paste the new public address).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `namedRepair.needed`, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json`, then doctor again. Do not Delete the connector.
3. If `chatgptRepair.needed`, follow **reconnect after address reclaim**, then
   doctor again.
4. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable | Run `c2c doctor` for the exact workspace. If `namedRepair.needed`, use its login repair and rerun Doctor without changing the connector. If `chatgptRepair.needed`, follow its returned action and the workflow above. Unknown state preserves the connector; it does not trigger speculative deletion or recreation. |
| ChatGPT says a tool call failed | Read the structured error and verify workspace identity, endpoint, tool name/schema and requested material first. A generic failure does not authorize authentication or connector changes. |
| Explicit 401 / unauthorized / revoked pairing evidence | Run Doctor and use the returned authentication repair. Generate a new pairing code only when the current evidence says pairing expired or was revoked. |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Same explicit ChatGPT setup/reconnect browser configuration step fails twice after repair | Stop automating ChatGPT settings and use **Guided manual ChatGPT setup fallback**. Do not count browser/js timeout, loading/generating, or login/2FA waiting as failures. |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | Reuse a verified existing installation. Install with brew/winget only when this task has explicit installation authorization and the existing isolated candidate rules are satisfied; otherwise report the exact missing dependency and use an existing capability (or stop if none exists). |
| Sidebar has no「项目」 | Ask the user to hover「聊天」, click the …, choose「按项目整理」 |
| Collection page is the wrong Project | Ask the user to open the named collection and say「已找到」, or accept long-chat |
| Windows 黑色终端窗口闪现或抢焦点 | 先区分来源：C2C 自身子进程必须以 `windowsHide: true` 启动；Codex 普通、非交互命令使用 `tty: false`，只在确需交互终端时使用 `tty: true`。不要修改 Windows Terminal、注册表或系统默认终端。终止已经卡住的旧 TTY 命令，并让已打开的任务在下一次工具调用前加载此策略。 |
