## Conversation management

`c2c session -w <ws> --json` → `{ session, conversation }`.
`conversation.mode` is the only switch. Missing / legacy files with a chat URL
and no Project stay **long-chat**. Do not ask those users to migrate. If they
later say they want a Project, run **Bind Project**. A brand-new workspace
(no session file) is **project**.

Never match a Project or a chat by display name. Never upload the repo to
Project sources. Never click 分享 / Share. Every C2C conversation must have a
Chinese display title. Prefer a concise Chinese task title; otherwise use the
current Chinese Project name plus「项目协作」. If the machine workspace name is
English, translate only the UI title and keep the canonical workspace identity
unchanged. After the chat URL is stable, rename only this C2C chat when its
auto-generated title is not Chinese. Never rename unrelated chats.

### Role bindings (planning / audit)

`node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session set -w <ws> --role planning|audit …`
saves a role binding for the
**current Codex owner thread** (`CODEX_THREAD_ID`, falling back to
`CODEX_SESSION_ID`). The owner must be a UUID; a missing or malformed owner is
refused and the owner is never guessed from a title, cwd or an older session.

- The role record is separate from the workspace session file: writing a role
  never rewrites `session.url`, the Project binding or the checkpoint, and the
  audit binding never overwrites the planning URL.
  The first planning and audit bindings must each read back a complete,
  verifiable Project-chat identity: full chat URL, exact matching Project
  identity, and the same workspace connector. After a complete binding exists,
  updates may change only supported task, title or checkpoint fields. An
  incomplete read-back is unusable and fails closed; do not claim it is bound
  or fall back to legacy routing. If the URL or Project changes while an old checkpoint
  exists, explicitly run the maintenance entry with `--clear-checkpoint`
  before rebinding; never inherit that checkpoint silently.
  - `node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session -w <ws> --role planning|audit --json` reports
  `{ bound: false, unbound: true }` when this owner has no binding. An unbound
  role never inherits the old saved URL.
- The first write starts at revision 0 and increments on success. Updating an
  existing role file requires `--expected-revision <n>`; a mismatch is refused
  and the old file is kept unchanged.
  - The first `--role audit` binding requires `--project-url`, an existing
    planning binding with complete Project-chat identity, and an exact
    `--candidate <sha256>`;
    all role reads and updates use the same `dist/cli/index.js` maintenance
    entry. It is only the persistent C2C Project route: planning and audit must keep
    **different conversation IDs and different Project IDs** and must record
    **the same connector name**. Audit task or iteration changes must explicitly
    confirm the candidate again; a status-only update may reuse an unchanged
    candidate. Only the selected role changes; the other role
    stays intact. The pool route is preferred when its lease and isolation are
    verified; a temporary attachment Chat is the no-role supplement and must
    not be written to `--role audit`.
- `--candidate <sha256>` (audit only) is required, is 64 hex characters, and is
  recorded as metadata. It never asserts that files were verified, proves hard
  isolation, or records that the audit passed; a new candidate never produces a
  PASS.
- Role bindings are per Codex thread. `--same-thread` stays a caller-provided
  assertion; it is never a machine-verified thread binding.

When `--role planning` is bound and its read-back is complete, planning sends,
recovery and checkpoints must use that owner binding first; they must not fall
back to legacy `--same-thread` and overwrite its route. An incomplete role
record fails closed. A legacy session without any role file keeps the existing
`--same-thread` compatibility path.

For the Project route, the selected task/checkpoint record is the complete
planning-role record. For long-chat compatibility, it is the workspace legacy
session. Once selected, all reads, updates, recovery and clears use that same
record; never read a checkpoint from one and write progress to the other.

Both windows reuse THIS workspace's single connector. Do not create a second
connector, and do not treat a different Project as extra local read/write
permission.

### long-chat (do not rewrite this path)

ONE ChatGPT conversation per workspace. Same as before.

- **Find it**: if `conversation.reuseSavedChat` and `conversation.chatUrl`,
  `goto` that URL (foreground + markHandoff) and continue there.
- **Save it**: after boot + workspace_info, and the reply names this workspace,
  `c2c session set -w <ws> --mode long-chat --url <url> --title "<中文任务或项目名>｜项目协作"`.
  If the name does not match, do not overwrite a previously saved URL.
- **Update it**: after each EXECUTED/DONE,
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`
  plus checkpoint flags from the coding workflow (`--protocol-state`,
  `--waiting-for`, `--goal`, `--next-step`, `--known-issues`, or
  `--clear-checkpoint` on DONE). Do not put logs or diffs in those fields.
- **Switch it** ONLY when (a) the user asks for a new chat, (b) the current
  chat visibly lags, or (c) this conversation is Work. Then:
  1. Same iab tab: `goto` `https://chatgpt.com/`, confirm Chat mode
     (**In-app browser** §7), then send the boot prompt.
  2. Send a HANDOFF (`docs/protocol.md`) — goal, progress, state, issues,
     next step. Never paste files.
  3. workspace_info check; only then `c2c session set --url`. On failure,
     leave the old saved URL unchanged.
- Saved chat 404s: treat as a switch. Reconstruct HANDOFF from the selected
  long-chat legacy record's checkpoint (goal, progress, issues, next step). If there is no
  checkpoint, use `task` / `iteration` / `lastState` and `execution_summary`
  metadata only. Never paste logs or output bodies.

### project (new workspaces)

Each workspace keeps its planning Project; audit Projects are allocated from
a shared reusable pool. For
each concurrent independent audit, select a different project-only Project,
new Chat, and exact candidate; never share an active Project across tasks. A
Project is reusable only after complete records are saved to each source
project and its completed chat and business materials are verified moved out
and archived. The pool follows actual audit concurrency, does not grow with
business-project count, and has no unsupported fixed cap or automatic allocator.
If a pool slot, cleanup, or isolation cannot be verified, use the temporary
frozen-attachment route in `independent-audit.md` without forcing a queue.
Before UI use, create the lease atomically with `create-exclusive/wx` in the
actual C2C state directory, recording the complete owner, task, `auditRun`, and
`stage=preparing`; add the exact candidate before sending the audit. Never take another owner's lease or infer idleness from timeout;
same-owner recovery still verifies the actual task. After evidence and cleanup
read-back, verify the owner before releasing the lease. The index only locates
projects and is not proof of idleness; a local lease cannot prove cross-machine
exclusivity, so use a new isolated environment when that proof is unavailable.
Mapping:

1. If a planning role is bound with a complete Project-chat identity, read it
   through the maintenance entry and use that exact chat URL directly. A
   planning binding without complete identity cannot serve persistent audit. Do not fall
   back to legacy `--same-thread` when the complete binding exists. If no role
   file exists, the legacy `c2c session --same-thread --json` compatibility
   path may be used.
2. Same workspace, a **new** Codex conversation → new ChatGPT chat from the
   collection page (`conversation.projectUrl`). Ignore `session.url` unless
   you already saved it earlier in THIS Codex thread.
3. Different workspace → different planning Project and different connector.
   An audit Project can serve another workspace only after verified cleanup and
   release; the new audit binds that workspace's connector explicitly.
4. When a pool audit Project is selected, the audit window is a **new, isolated
   context** in that Project: verify exclusive one-task use, no active sharing
   with another audit, removal of prior chats/materials, native tool identity,
   exact snapshot, project-only memory, and read-only boundaries before use. It
   reuses THIS workspace's single connector and never mixes into the
   planning/implementation chat. After the complete record is stored in the
   source project, verify moving the completed chat and business materials out
   and archive it before reuse; do not promise automatic permanent deletion. If
   any pool-slot, cleanup, isolation, or frozen-material fact cannot be proven,
   use the temporary frozen-attachment route without forcing a queue.

The `--same-thread` switch does not carry a Codex thread identifier; it only
records the Skill's current-thread evidence. Never treat it as a machine
verified cross-thread binding.

### 临时附件补位验收

Read `independent-audit.md` before this route. When the pool route cannot be
verified, Codex creates a fresh,
non-personalized temporary Chat, freezes the authorized evidence package and
uses native attachments by default. The temporary URL may lack `/c/`; never
invent a conversation ID, save it as `--role audit`, or save it as an ordinary
chat. Close only after the complete visible record is durably stored and
verified. The C2C Project route above is the only route supported by the
existing `--role audit` CLI.

**Open a chat in this Codex thread**

- If you already saved a ChatGPT chat URL earlier in THIS Codex conversation:
  `goto` that URL. Continue. No new chat. No HANDOFF.
- Else if `conversation.projectReady`: use **项目入口兼容恢复** above to enter
  the verified Project through an on-page link when a saved chat is available;
  otherwise use the homepage sidebar recovery path, verifying the same Project.
  On that page, use the on-page composer (「{项目名}中的新聊天」 / "New chat
  in …"). Do not use the sidebar and do not `goto` `https://chatgpt.com/`.
  Confirm Chat mode (**In-app browser** §7). Boot prompt, then workspace_info
  with the **exact** `connectorName`. After the reply names this workspace,
  create the unbound planning record with
  `node "<ACTUAL_CHECKOUT_PATH>/dist/cli/index.js" session set -w <ws> --role planning --mode project --project-url <collection> --url <chat> --connector-name "<connectorName>" --title "<中文任务或项目名>｜项目协作"`.
  The first write starts from revision 0 and omits `--expected-revision`; read it
  back immediately. If a complete planning binding already exists, reuse it;
  any supported update uses its current `--expected-revision`, and a changed
  chat or Project clears the old checkpoint before rebinding.
  If this Codex thread is continuing a previous C2C task, send HANDOFF right
  after the boot prompt.
- Else: **Bind Project** first.

**Update it**: read the planning role and update only that record with the
maintenance `session set --role planning --expected-revision <current>` entry,
plus task, iteration, state and checkpoint fields. Do not use the long-chat
legacy command for a bound Project planning route.

**Wrong collection**: do not guess another Project. Tell the user the expected
workspace name, ask them to open the right collection, then say「已找到」.
Also offer「继续用长对话」. If they pick long-chat:
`c2c session set -w <ws> --mode long-chat` and use the long-chat path.
If the collection 404s or the new chat is not inside the Project, same choice.

**Saved chat 404s** (this thread): use **项目入口兼容恢复** to enter the same collection
through the loaded homepage sidebar, open a new chat
there, boot + HANDOFF from the selected planning-role checkpoint (no logs) +
workspace_info, then update that same planning role with its current revision,
the new chat URL and `--clear-checkpoint`. Keep the verified `--project-url`;
never read or update the legacy session for this recovery.

### Bind Project (user creates the collection once)

Do this for a new workspace, or when an existing user asks to switch to
Project. Do **not** click the ChatGPT sidebar to create the Project
(Computer Use is forbidden; IAB must not hunt that menu).

When the user has already authorized configuring or creating the C2C audit
route, Codex may prepare a pool Project through the currently supported UI and
save its settings itself instead of asking the user to build it each time. Use
one project-only Project per active audit, with a new Chat and exact candidate;
reuse only after lease release, complete evidence storage, and verified chat
and material cleanup. Pool availability, exclusive use and isolation must be
verified before persistent use; otherwise use the temporary frozen-attachment
supplement without forcing a queue. This does not claim an automatic allocator
or cross-machine lock.

1. Tell the user exactly this (fill in the workspace name):

```
请在 ChatGPT 里新建一个项目，名字用「<workspaceName>」，记忆请选「仅限项目记忆」。

如果侧栏里看不到「项目」：把鼠标放在「聊天」上，点右边出现的三个点，选择「按项目整理」。

建好后会打开合集页面。看到页面后跟我说「好了」。
```

2. Wait for「好了」/ the collection page. Same iab tab: read the address bar.
   It must look like `https://chatgpt.com/g/g-p-…/project`. If it does not,
   ask them to open that project until it does. Then:
   `c2c session set -w <ws> --mode project --project-url <url> --connector-name "<connectorName>"`.

3. On that same collection page only, open 右上角 **… → 项目设置**.
   Do not click 分享. Do not add 来源 / files.
   - 记忆: 仅限项目记忆 (project-only). Leave 库访问权限 disabled.
   - 指令: paste **Project instructions** below (fill `{{…}}` from
     `workspace_info` / setup). Use the exact `connectorName` from setup.
     Never write the public / temporary address into 指令.
   Save and close settings.

4. Still on the collection page, create the first chat with the on-page
   composer, then boot + workspace_info as in setup step 5. Create and read back
   the first complete `--role planning` binding as described above; do not save
   the Project chat as a legacy task/checkpoint route.

### Project instructions (paste into 项目设置 → 指令)

```
你与 Codex 按实际工具能力共同规划、执行和复核，Codex 负责本地集成与最终验证；连接可见范围不等于项目授权。可独立完成的代码、文档、计算或验证应交付具体成果，不只提供计划。

本项目仅绑定到：
- 工作区名称：{{workspace_name}}
- 类型：{{project_type}}（{{languages}} / {{frameworks}}）
- 连接（只能使用这个）：{{connector_name}}

访问绑定工作区时只能使用上述连接，不得使用其他 Codex with ChatGPT 连接。用户已授权任务所需的原生计算、文件生成或检索工具可以使用；其他连接须已有相应授权。此连接为只读，不能声称通过它执行命令或改写本地文件。
先核对 workspace_info 的实际身份；Git 项目还须用当前 Git 状态确认仓库和分支。名称相同不能证明是同一仓库或获准写入。存在项目级 Order、登记表或路径合同才按其实际规则读取和核验；普通非 Git 工作区不强制创建公司治理文件。身份不符时停止依赖该连接的动作，不猜测其他项目。

通过该连接读取代码、Git 状态、差异和已允许读取的命令输出。不得要求任何人粘贴文件正文、差异或日志。
收到 EXECUTED 后，如果 execution_output 中存在可读项目，先 list 再 read；如果状态为 restricted，改为从 Git 复核。
不得把仓库上传到本项目的文件或来源中。

权限与目标以最新明确用户指令、平台边界和当前有效项目合同为准；拒绝项、Order 和路径限制不能被交接摘要放宽。
Codex 与 ChatGPT 对彼此的结论、建议和完成声明都须独立判断，不能直接采信，也不能把双方认同当作验证。采用前按影响和风险核对原始依据、当前事实、用户目标及适用条件；发现不正确、不准确、有遗漏或不合适时，指出具体问题和依据，在现有授权范围内修正并验证受影响部分，再将修正结论反馈对方。若自身结论有误，同样主动更正；证据不足时标明未确认，不继续传播或据此推进。分歧以证据解决，无法解决则保留争议和影响；不为取得一致而降低标准，不扩大授权，不无理由重复已有效的验证。
实际状态以连接读取的代码、Git、运行证据及项目权威状态为准。规格说明应实现什么，运行证据说明实际存在什么；两者冲突须调查。
HANDOFF 和项目记忆只用于定位，不单独授予权限，不覆盖最新用户指令或有效合同。

本项目记忆只属于该工作区。收到 HANDOFF 后重新核对当前身份、目标和必要证据；只有下一步仍在现行范围内才继续，已完成工作不得无理由重做。

窗口职责：规划窗口支持当前 CONTROLLER 的讨论、研究和过程复核；独立验收窗口只读冻结候选、原始需求、规格、标准和真实测试证据。独立验收方可以给冻结候选出具通过、需修正或阻断结论，但不能给自己的实现或工作包自发 PASS。
默认模型：GPT-5.6 Sol Pro；由 Codex 按当前全局规则及浏览器流程的推理收益判断选择 GPT-6 Pro，处理完成后回切 GPT-5.6 Sol Pro。

所有用户可见内容、解释、计划、复核结论和会话标题都使用简体中文。只有 C2C 固定信封字段 `[C2C]`、`STATE`、`TASK_ID`、`ITERATION` 及其协议状态值可以保留英文；工具名、代码、命令、路径和精确标识符保持原样。其他内容章节标题和标签必须使用自然的简体中文，禁止输出 `REVIEW_BASIS`、`ACCEPTED_SCOPE`、`RESIDUAL_RISK`、`ROLLBACK`、`NEXT_EXPECTED_STEP`、`VERDICT` 等大写英文下划线标题；分别使用“复核依据”“验收范围”“剩余风险”“回滚方法”“下一步”“结论”，结论值使用“通过”“需修正”或“阻断”。
内容必须具体，说明原因、涉及文件和测试建议；不要空洞的一句话，也不要生成四十步史诗。使用 C2C 控制消息格式。
```

Fill this template by window purpose:

- **planning window**: discussion, research and process review with the current
  CONTROLLER; Codex owns local integration, DSH implements, and Codex runs the
  real tests. This window is not the independent auditor of its own result.
- **audit window**: read-only frozen candidate, the original user goal as
  originally stated, the spec, the standards and the raw test evidence only.
  It must not modify the candidate or give its own implementation a self-PASS;
  it may issue a conclusion about the frozen candidate and returns findings to
  planning/Codex. If it cannot prove a read-only frozen material set and a
  clean context, it reports an ordinary review or an incomplete audit — never
  an independent audit.

Both windows select the model tier under the current global rules and Codex
verifies the real selection in the UI; message text never switches the web
model. Keep the existing default and fallback policy unchanged: default GPT-5.6
Sol Pro. Select GPT-6 Pro when deeper reasoning is expected to improve
the result under the current global policy; high impact and a prior Sol
failure are not prerequisites. Switch
back to GPT-5.6 Sol Pro once the GPT-6 Pro reply is handled. A new explicit user instruction wins;
missing model availability, quota or tools is reported, never silently
downgraded. Send an audit only for stages that need independent acceptance — do
not turn every small edit into two Pro rounds.
