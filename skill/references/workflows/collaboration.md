## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states sent to ChatGPT: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED | ERROR).
Local checkpoint states (session only, never a ChatGPT `STATE:` line):
`INIT`, `PLAN_RECEIVED`, `EXECUTING`, `EXECUTED_LOCAL`, `EXECUTED_SENT`, `DONE`, `BLOCKED`.
Do not invent `STATE: RESUME`. Do not invent `STATE: AUDIT_REQUEST` either:
needing independent acceptance is ordinary Chinese prose, not a protocol state.
If the original chat is gone, send HANDOFF.
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
Before each authorized send, apply the model/effort verification in browser.md, “模型与思考档位”; read back this message's current target composer before sending. This includes boot, INIT and REVIEW messages and never authorizes an extra message.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

### 每条发送的执行门

无论发送入口是浏览器、C2C、应用还是连接器，每条普通 ChatGPT 消息都执行 `TARGET_CHAT→CLASSIFY→SELECT_IF_NEEDED→READ_BACK→SEND→VERIFY_RESPONSE`，不能只在首次发送或阶段转换时检查。既有对话须锁定具体 `/c/` 输入区；新建首条仅可在已授权且已核验、符合当前绑定会话模式的新聊天输入区执行（项目模式须在已绑定项目内），创建后立即绑定 `/c/` 并再次核实。详细选择器步骤、同次 CUA 断言、应用 API 边界、证据拆分和禁止项统一见 browser.md；门未通过、读回不明或不匹配时不发送，不固定重复点击或抢占生成中的对话。

修复模型路由流程时，在用户已授权实测的范围内，以既有对话真实发送、收到回复及 GPT-6 Pro → GPT-5.6 Sol Pro 回切作为验收，不能只测项目首页选择器。平时用下一条必要任务验证，不额外发送消息做例行测试。

### TaskFile 短指针交接

ChatGPT 给出完整规划；Codex 采用前核当前用户授权、项目合同、工作区、候选、读写范围与实际路由。当前 C2C 只读，不把聊天声明、附件名称或下载按钮当作文件落地证据。

同机任务在项目认可位置物化。准备 DSH 长任务前，读取 `delegate-deepseek` 的 `references/task-interface.md` 与其引用模板，生成唯一 `dsh-contract` 块；机器字段使用本轮真实证据，与实际调用参数、profile 和 AgentPreset 一致。未确认字段不得猜填，旧无合同文件保留原件并按接口规定迁移。

定稿后计算完整原始字节的 SHA-256，通过 `-TaskFile` 与 `-TaskFileSha256` 交给现行入口；入口的实际校验不能由自报预检代替。版本或语义不明时停止，不盲目重算摘要以掩盖失配，不改用长 `-Task` 绕过校验。

返修由程序组合冻结原规范与本轮增量，或同时提供精确哈希绑定且已授权可读的原规范。最终输入只保留一份本轮有效机器合同；不得直接拼接出多个 `dsh-contract` 块。原规范缺失、摘要失配或授权改变时，先解决受影响绑定，不继承旧权限。

只使用已验证的文件取得或正文物化能力，不要求人工下载、上传、复制或粘贴。GitHub 只在授权的持久留存或跨设备场景使用，绑定精确提交、路径与摘要。路径和合同不授予权限；DSH 仍接收完整正文，结果仍由 Codex 核验。

### 检查点写入门

每次读取或写入检查点前，先用维护入口
`node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session -w <ws> --role planning --json`
查询当前 Codex owner 的 planning 角色绑定：

- 若返回完整且可核验的绑定，读取只用该角色记录；写入和清除使用
  `node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session set -w <ws> --role planning --expected-revision <当前revision> ...`。
  每次成功后读回新 revision，下一次使用该值。
- 首次创建 planning 角色记录只由会话绑定流程执行，从 revision 0 开始且不传
  `--expected-revision`；首次读回完整绑定后，所有后续更新都必须带当前 revision。
- 只有该 owner 明确 `unbound` 且当前任务本来就是既有 legacy 兼容路线时，才用
  `c2c session set -w <ws> ...`。Project 路线缺少角色记录时先按会话流程建立角色，
  不把“缺少记录”自动解释为 legacy 授权。
- 不同时读写两条路径，不从不完整角色记录回退到 legacy，也不省略已有角色更新所需的
  `--expected-revision`。下文“按检查点写入门保存”表示只在上述选中的一条命令后追加所列字段。

0. `c2c tunnel status -w <workspace> --json`. If `needsChoice`, follow
   **Connection choice** first (existing installs: ask once, then remember).
   Then `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `namedRepair.needed` is true, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json` (their browser; Cloudflare exception), then doctor
   again. If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: reconnect after address
   reclaim**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 4 random hex chars — unless a checkpoint already
   has one (reuse that id; do not mint a second task).
1. `c2c session -w <workspace> --json`. Open ChatGPT on the same iab tab
   per **Conversation management** for `conversation.mode` (foreground +
   markHandoff). long-chat: saved chat, or `https://chatgpt.com/` if none.
    project: this thread's chat URL, or the collection page for a new chat,
    or **Bind Project** if `projectReady` is false. For independent acceptance,
    read `independent-audit.md`: select a distinct project-only Project, new
    Chat and exact candidate from the reusable pool when lease, cleanup and
    isolation are verified; otherwise use the frozen native-attachment route
    as a supplement without forcing a queue. On a NEW conversation
   confirm Chat mode (**In-app browser** §7), then send the boot prompt from
   `docs/protocol.md` §Boot Prompt and the workspace_info check (name the
   exact `connectorName`). Confirm the reply names the current workspace
   before saving the session URL. Do not use the browser to re-read code MCP
   already provides. After sending a control message, wait per
   **In-app browser** §8.

   If `--role planning` is bound and its read-back is complete, planning sends,
   recovery and checkpoints use that owner binding first; do not fall back to
   legacy `--same-thread` over it. An incomplete role record fails closed. A
   session with no role file keeps the legacy compatibility path.

   **Resume from the checkpoint in the selected planning-role or legacy record
   before any INIT.** Never mix the two records. A missing checkpoint in the
   selected legacy session continues as a normal new/continued loop. A browser/js
   timeout is not a lost task — claim the original tab; do not INIT, re-run,
   or resend EXECUTED just because a wait timed out.
   - `EXECUTED_SENT` + `waitingFor=GPT_REVIEW`: do not INIT, do not re-run,
     do not resend EXECUTED. Stay on the saved chat and wait for review. If
     that chat 404s: HANDOFF from checkpoint fields (no logs), then wait.
   - `EXECUTED_LOCAL`: local work is done; only send EXECUTED (record first
     if this iteration has no record yet). Do not re-run.
   - `EXECUTING`: not finished. Continue the current PLAN if you still have
     it; otherwise HANDOFF and ask ChatGPT to restate the last PLAN. Do not
     treat it as done and do not INIT a new task.
   - `PLAN_RECEIVED`: execute that plan. Do not INIT.
   - `INIT` / `waitingFor=GPT_PLAN`: claim the tab and wait. Do not resend INIT.
   - `DONE`: summarize to the user if needed; 按检查点写入门使用 `--clear-checkpoint` 清除当前路径的检查点。
   - `BLOCKED`: surface ChatGPT's reason; do not INIT.
   Never re-pair, never recreate the connector, and never rewrite Project
   instructions just to resume.
2. Send INIT with the user's goal (skip when the checkpoint says not to):

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<用一段中文概括用户目标>

INSTRUCTION:
通过 Codex with ChatGPT 连接检查工作区。
完成后在本对话一次性返回结果；受阻时主动说明原因和所需输入，不必等待 Codex 催问，不需要定期汇报进度。
输出一条 C2C PLAN 消息。除 `[C2C]`、`STATE`、`TASK_ID`、`ITERATION` 及协议状态值外，所有标题、标签和说明文字都使用简体中文，禁止大写英文下划线内容标题。
```

   Then 按检查点写入门保存：`--task <id> --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --goal "<short goal>" --next-step "wait for PLAN"`。
3. Wait for ChatGPT's `STATE: PLAN` reply (**In-app browser** §8 — minimal, infrequent read-only completion
   checks, same tab; do not treat a 5-minute browser timeout as failure).
   Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   “请补充计划依据，并给出具体的逐文件修改建议。”
   Then 按检查点写入门保存：`--protocol-state PLAN_RECEIVED --waiting-for none --next-step "execute PLAN"`。
4. Split the accepted work by verified capability and independent deliverable.
   Let ChatGPT execute its bounded package with available authorized tools;
   execute the local/integration package in Codex. Follow **Capability-based
   execution sharing** and do not create a second writer for the same files.
   If no suitable ChatGPT execution tool is available, adopt its concrete draft
   only after local validation and report the capability gap explicitly.
   Before you start, 按检查点写入门保存：`--protocol-state EXECUTING --waiting-for none --next-step "finish PLAN then record"`。
5. Record the execution so ChatGPT can read it via MCP. Metadata always:
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
   If this iteration ran a **test / build / lint / typecheck** command, also
   pass that command's output. Write stdout/stderr to a local temp file first,
   then:
   `c2c record … --command "pnpm test" --output-file <temp> --exit-code <n>`
   Record both success and failure. Do not record shell history, `.env`,
   keys, or unrelated dumps. Never paste that file (or any log) into ChatGPT.
   If the CLI says the output was not released, still send EXECUTED; ChatGPT
   reviews from git. Then 按检查点写入门保存：`--iteration 1 --state EXECUTED --protocol-state EXECUTED_LOCAL --waiting-for none --next-step "send EXECUTED"`。
6. Send EXECUTED (no diffs, no logs). Tell ChatGPT to use MCP, including
   `execution_output` when a readable item exists:

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
如果 execution_output 列出了本轮可读项目，先 list 再 read。read 默认返回
64 KiB 的 UTF-8 分页；如果 `hasMore` 为 true，使用 `offset=nextOffset`
继续读取，直到 `hasMore=false`。正文在安全上限 4 MiB 内完整保存并分页；
超过上限会明确标记 source-truncated。restricted 项目始终不提供正文。
如果状态为 restricted，忽略正文并通过 git_diff 复核。
回复时除 `[C2C]`、`STATE`、`TASK_ID`、`ITERATION` 及协议状态值外，所有标题、标签和说明文字都使用简体中文；不得使用 `REVIEW_BASIS`、`ACCEPTED_SCOPE`、`RESIDUAL_RISK`、`ROLLBACK`、`NEXT_EXPECTED_STEP`、`VERDICT` 等英文内容标题。
```

   Then 按检查点写入门保存：`--protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --next-step "wait for PLAN or DONE"`。
7. ChatGPT reviews via MCP (`git_diff`, `read_file`, `test_status`,
   `execution_output`) and replies DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language. 按检查点写入门保存：`--state DONE --clear-checkpoint`。
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make. 按检查点写入门保存：`--protocol-state BLOCKED --waiting-for USER --known-issues "<short reason>"`。

### 独立验收阶段（audit 窗口）

只有确实需要独立验收的阶段才发送审核；不要把每次小改都变成两轮 Pro。
规划窗口继续使用 `--role planning` owner 绑定，支持讨论、研究和过程
复核，不是同成果的独立审核方。详细步骤统一读取
`skill/references/workflows/independent-audit.md`：优先从可复用池选择独占
project-only Project、新 Chat 和精确候选；池位、独占、清理或隔离不可核实时，
用 fresh 临时普通 Chat 加冻结原生附件补位，不强制排队。

- 临时附件 Chat 的 URL 可能没有 `/c/`，不伪造会话 ID，不写 `--role audit`，
  不点保存成普通聊天；记录完整落盘并核验后才关闭窗口。
- C2C 池路线才执行
  `node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session -w <ws> --role audit --json`；
  该维护入口只支持持久 Project，需精确候选、原生身份、项目记忆隔离和只读边界证据。
- 审核方可就冻结候选给出通过、需修正或阻断结论，但不能给自身工作包自发
  PASS；候选或输入改变立即使旧结论失效。证据、隔离或只读边界无法证明时，
  报普通复核或独立审核未完成。
