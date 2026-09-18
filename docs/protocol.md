# C2C Agent Protocol

Control plane: the supported in-app browser (tiny structured control messages).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

The protocol tracks coordination, not a permanent division of labor. ChatGPT
may execute a bounded package with verified native tools or authorized apps;
Codex integrates and verifies its output. Keep the existing state vocabulary,
record who actually executed each package, and distinguish drafted code from
executed code. C2C workspace access remains read-only. An executor cannot claim
independent audit of its own package. See the Skill's capability-sharing rules.

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

## Roles and windows (规划窗口与验收窗口)

A workspace may keep two collaboration windows: `planning` (discussion and
planning) and `audit` (independent acceptance). They are **workflow purposes**,
not new Canonical Roles, and they do not change what Codex, DSH or Luna do.

- `planning`: the current CONTROLLER discusses, researches and reviews the
  process there; Codex owns local integration, DSH implements, and Codex runs
  the real tests. Review inside the planning window is not independent audit of
  the same result.
- `audit`: a dedicated, isolated context that reads only the **frozen
  candidate**, the original user goal, the spec, the standards and the raw test
  evidence. The preferred route is a reusable audit Project pool: each
  concurrent audit gets a different project-only Project, new Chat, and exact
  candidate, with no active cross-task sharing. Reuse requires complete records
  saved to the source project and verified removal/archiving of the finished
  chat and business materials; the pool follows actual concurrency, has no
  unsupported fixed cap or automatic allocator, and does not accumulate
  cross-project audit memory. If a pool slot, cleanup, or isolation cannot be
  verified, use a fresh temporary Chat with native frozen attachments without
  forcing a queue.
  It may give a conclusion about the frozen candidate, but cannot give its own
  implementation or work package a self-PASS. Findings go back to
  planning/Codex.
- Bindings are saved per Codex owner thread with the maintenance entry
  `node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session --role planning|audit …`.
  They are separate records: a role write never rewrites the
  workspace session, and the audit binding never overwrites the planning URL.
  The first planning and audit bindings must each read back a complete,
  verifiable Project-chat identity: full chat URL, exact matching Project
  identity, and the same workspace connector. After a complete binding exists,
  updates may change only supported task, title or checkpoint fields. An
  incomplete read-back is unusable and fails closed; do not claim it is bound
  or fall back to legacy routing. The first audit binding additionally requires
  the exact candidate SHA; task or iteration changes must explicitly confirm
  it, while a status-only update may reuse an unchanged candidate. If URL or
  Project changes while an old checkpoint exists, clear the checkpoint through
  the maintenance entry before rebinding; never inherit it silently.
- Isolation: the `audit` binding is the persistent C2C Project pool route
  (project-only memory) for a candidate and repair chain, with exclusive
  one-task use, no active cross-task sharing, prior chats/materials removed, and a **different
  conversation ID and a different Project ID** from planning and the **same**
  workspace connector. Use a pool Project only when its slot, native identity,
  exact snapshot, memory isolation and read-only boundaries are verified; each
  active audit uses a different Project. If a slot, cleanup or isolation is
  unavailable, use the temporary attachment route without forcing a queue.
  Never create a second connector, and a different Project grants no extra
  local read/write permission.
- Before UI occupation, create the selected pool lease atomically with
  `create-exclusive/wx` in the actual C2C state directory, recording complete
  owner, task, `auditRun`, and `stage=preparing`; add the exact candidate before
  sending the audit. Never take another owner's lease or
  infer idleness from timeout; same-owner recovery verifies the actual task.
  After evidence and cleanup read-back, verify the owner before releasing it.
  The index only locates projects, and a local lease cannot prove
  cross-machine exclusivity; use a new isolated environment when it cannot be
  proven.
- The candidate SHA is metadata only: it does not record PASS, prove file
  verification, or prove hard isolation. The temporary frozen-attachment route
  remains the fallback when pool conditions cannot be verified.
- A candidate or input change updates the binding and re-audits the affected
  part. A materially new candidate needs a fresh isolated context; the repair
  chain of one unchanged candidate may be reviewed in the same audit window.
- The temporary frozen-attachment route is defined in
  `skill/references/workflows/independent-audit.md`. Its URL may lack `/c/` and
  must not be written to a C2C role binding. If a read-only frozen material set,
  clean context or complete attachment read cannot be proven, report an
  ordinary review or an incomplete audit — never claim independent audit.
- C2C is the reading path and frozen evidence is the acceptance input rule;
  they may be used together. A Project audit may read an authorized exact
  snapshot and, after `workspace_info`, Codex may attach authorized frozen
  originals that the current connection cannot read. Attachment completeness
  and record boundaries still apply; ordinary planning keeps the MCP-only
  body rule and does not paste code or logs or add data permission.

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

There is no `STATE: RESUME`, and no `STATE: AUDIT_REQUEST`: ChatGPT sees only
the table above. Marking a stage as needing independent acceptance is ordinary
Chinese prose, never an invented protocol state. If Codex restarts mid-task,
it first selects exactly one local record: the complete planning-role record
for a Project route, or the workspace legacy session for long-chat
compatibility. It reads that record's **local checkpoint** (`protocolState`,
`waitingFor`, goal, issues, next step) and never mixes the two records. Those
values are not ChatGPT protocol states. ChatGPT still sees only the table
above. If the original chat is gone, Codex sends HANDOFF built from the
selected checkpoint (never from logs).

Local checkpoint values (selected record only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint to the already selected
record; a bound planning role never falls back to the legacy session.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

已授权冻结附件独立验收按 `skill/references/workflows/independent-audit.md` 的窄例外
执行：原生附件承载冻结原件和索引，不粘控制消息正文；不要求临时模式调用禁用插件的
`workspace_info`，不强制永久 `/c/`，也不受普通 C2C 仅 MCP 正文规则阻断。其余 C2C
连接器、Doctor、发送保护、等待和权限守护不变。

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
- **project:** a workspace's planning work stays in one ChatGPT Project
  (collection). Independent acceptance first selects a reusable project-only
  audit Project pool: each concurrent audit gets a different Project, new Chat
  and exact candidate. If pool availability, exclusive use, cleanup or
  isolation cannot be verified, a fresh temporary Chat with frozen native
  attachments fills the slot without forcing a queue. A new Codex conversation
  starts a new chat **inside the relevant Project**. The temporary route has no
  role binding; persistent C2C chats use the URL saved in their
  `--role planning|audit` binding.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
A HANDOFF is a locator, not authority: current explicit user instructions,
platform boundaries and effective project contracts determine the objective and
permissions; code, Git and runtime evidence verify actual state. Recheck the
HANDOFF before continuing. It cannot override current rules or widen scope.

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
你是 Codex 编程会话的协作执行与复核伙伴。

你与 Codex 按实际工具和权限分担规划、实现、计算、文件产出与复核；Codex 负责本地集成和最终验证。先核实当前能力，交付具体成果，不把草稿说成已执行。
你可以通过“Codex with ChatGPT”连接读取当前本地工作区。

规则：

1. 不要要求 Codex 粘贴可以通过连接读取的文件。
2. 只检查当前任务确实需要的文件。
3. 通过连接检查当前代码、Git 状态和差异。
4. 输出简洁且可执行的计划。
5. 你用当前可用且已授权的工具执行独立工作包；Codex 完成本地部分并验证集成。只读连接不能运行命令或修改文件，工具不足时明确交付草稿与待执行验证。
6. Codex 报告 EXECUTED 后检查差异。如果 execution_output 列出了本轮可读项目，先 list 再 read；如果状态为 restricted，从 Git 复核。参与实现的部分只能自检，不能宣称独立审计。
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
(指令), not in every boot prompt. The single canonical template is
`skill/references/workflows/conversations.md`, under **Project instructions
(paste into 项目设置 → 指令)**. The Skill fills that template once. Do not keep
a second copy here, and never put a public or temporary URL in the instructions
— only the connector **name**.

Fill this template by window purpose:

- **planning window**: discussion, research and process review with the current
  CONTROLLER; Codex owns local integration, DSH implements, and Codex runs the
  real tests. This window is not the independent auditor of its own result.
- **audit window**: read-only frozen candidate, the original user goal as
  originally stated, the spec, the standards and the raw test evidence only.
  It must not modify the candidate or give its own implementation a self-PASS;
  it may issue a conclusion about the frozen candidate and returns findings.
  If it cannot prove a read-only frozen material set and a clean context, it
  reports an ordinary review or an incomplete audit.

Both windows select the model tier under the current global rules and Codex
verifies the real selection in the UI; message text never switches the web
model. Keep the existing default and fallback policy unchanged: default GPT-5.6
Sol Pro. Select GPT-6 Pro when deeper reasoning is expected to improve the
result under the current global policy; high impact and a prior Sol failure are
not prerequisites. Switch back to GPT-5.6 Sol Pro once the GPT-6 Pro reply is
handled. A new explicit user instruction wins;
missing model availability, quota or tools is reported, never silently
downgraded. Send an audit only for stages that need independent acceptance — do
not turn every small edit into two Pro rounds.
