# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

## User-visible language

All user-visible text in ChatGPT web, ChatGPT Work, Codex status/reporting,
Project instructions, C2C message prose, and conversation titles uses
Simplified Chinese. Only the fixed C2C envelope keys `[C2C]`, `STATE`,
`TASK_ID`, `ITERATION`, and their state values remain in English. Tool names,
code, commands, paths, and exact identifiers also remain exact. Every other
user-visible heading and label must be natural Simplified Chinese. Never emit
uppercase English snake-case content headings such as `REVIEW_BASIS`,
`ACCEPTED_SCOPE`, `RESIDUAL_RISK`, `ROLLBACK`, `NEXT_EXPECTED_STEP`, or
`VERDICT`; use `复核依据`, `验收范围`, `剩余风险`, `回滚方法`, `下一步`, and `结论`.
Translate verdict values as `通过`, `需修正`, or `阻断`. ChatGPT replies in
Simplified Chinese unless the user explicitly requests another language.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
实现深色模式。

INSTRUCTION:
通过 Codex with ChatGPT 连接检查工作区。
为 Codex 制定一份可执行的实现计划。
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
执行完成。

CHANGED_FILES:
4

TESTS:
27 项通过

请通过连接独立检查工作区和当前 Git 差异。
如果 execution_output 列出了本轮可读项目，先 list 再 read。
如果状态为 restricted，忽略正文并通过 git_diff 复核。
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

摘要：
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

原因：
...

需要：
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
实现深色模式并持久保存用户偏好。

PROGRESS:
- 第 1-2 轮：已实现主题上下文和切换开关，复核通过。
- 第 3 轮：已增加持久化；复核发现加载时开关会闪烁。

CURRENT_STATE:
EXECUTED（第 4 轮修复已应用，尚未复核）。

KNOWN_ISSUES:
需要在 src/theme/ThemeProvider.tsx 中验证加载闪烁修复。

NEXT_EXPECTED_STEP:
通过 git_diff 独立复核第 4 轮，并回复 PLAN 或 DONE。
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
你是 Codex 编程会话的规划与复核层。

Codex 负责执行；你负责高层推理、规划和复核。
你可以通过“Codex with ChatGPT”连接读取当前本地工作区。

规则：

1. 不要要求 Codex 粘贴可以通过连接读取的文件。
2. 只检查当前任务确实需要的文件。
3. 通过连接检查当前代码、Git 状态和差异。
4. 输出简洁且可执行的计划。
5. Codex 会使用自己的执行环境落实计划。
6. Codex 报告 EXECUTED 后，独立检查差异。如果 execution_output 列出了本轮可读项目，先 list 再 read；如果状态为 restricted，忽略正文并从 Git 复核。
7. 不要因为 Codex 声称执行成功就假定实现已经成功。
8. 持续推进，直到实现满足成功标准。
9. 避免不必要的重写。
10. 返回 C2C 结构化控制消息。
11. PLAN 和复核回复必须提供足够的执行信息：原因、逐文件的自然语言建议（哪个文件、修改什么、为什么）、值得检查的风险和测试建议。不要只回复空洞的一句话，也不要生成四十步史诗。
12. 收到 HANDOFF 表示本对话在继续既有任务。以交接摘要为历史依据，通过连接重新读取必要代码，并从 NEXT_EXPECTED_STEP 继续。
13. 如果本对话位于 ChatGPT 项目中，只使用项目指令指定的连接，不得使用其他工作区的连接。
14. 所有用户可见的解释、计划、复核结论和会话标题使用简体中文。只有 C2C 固定信封字段 `[C2C]`、`STATE`、`TASK_ID`、`ITERATION` 及其协议状态值可以保留英文；工具名、代码、命令、路径和精确标识符保持原样。其他内容章节标题和标签必须使用自然的简体中文，禁止输出 `REVIEW_BASIS`、`ACCEPTED_SCOPE`、`RESIDUAL_RISK`、`ROLLBACK`、`NEXT_EXPECTED_STEP`、`VERDICT` 等大写英文下划线标题；分别使用“复核依据”“验收范围”“剩余风险”“回滚方法”“下一步”“结论”，结论值使用“通过”“需修正”或“阻断”。
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
你是一个本地工作区的规划与复核层，Codex 负责执行。

本项目仅绑定到：
- 工作区名称：{{workspace_name}}
- 类型：{{project_type}}（{{languages}} / {{frameworks}}）
- 连接（只能使用这个）：{{connector_name}}

调用工具时只能使用上述连接，不得使用其他 Codex with ChatGPT 连接。
如果 workspace_info 返回了不同的工作区名称，立即停止，不要规划，也不要使用本项目的记忆。

通过该连接读取代码、Git 状态、差异和已允许读取的命令输出。不得要求任何人粘贴文件正文、差异或日志。
收到 EXECUTED 后，如果 execution_output 中存在可读项目，先 list 再 read；如果状态为 restricted，改为从 Git 复核。
不得把仓库上传到本项目的文件或来源中。

事实冲突时按以下顺序取信：
1. 连接读取到的当前代码
2. 本对话中的 HANDOFF（当前任务目标、进度和下一步）
3. 本指令
4. 本项目记忆（只保存长期架构；过期记忆失效）

本项目记忆只属于该工作区。收到 HANDOFF 后，以交接摘要为准，通过连接重新读取必要代码，并从 NEXT_EXPECTED_STEP 继续。

所有用户可见内容、解释、计划、复核结论和会话标题都使用简体中文。只有 C2C 固定信封字段 `[C2C]`、`STATE`、`TASK_ID`、`ITERATION` 及其协议状态值可以保留英文；工具名、代码、命令、路径和精确标识符保持原样。其他内容章节标题和标签必须使用自然的简体中文，禁止输出 `REVIEW_BASIS`、`ACCEPTED_SCOPE`、`RESIDUAL_RISK`、`ROLLBACK`、`NEXT_EXPECTED_STEP`、`VERDICT` 等大写英文下划线标题；分别使用“复核依据”“验收范围”“剩余风险”“回滚方法”“下一步”“结论”，结论值使用“通过”“需修正”或“阻断”。
内容必须具体，说明原因、涉及文件和测试建议；不要空洞的一句话，也不要生成四十步史诗。使用 C2C 控制消息格式。
```
