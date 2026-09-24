## In-app browser (ChatGPT)

Use the current in-app browser tool documentation, not remembered APIs.

1. **Surface.** Discover and select the bound conversation using the available
   browser entry point. With the current CUA tool, use `cua.getState()` for an
   inventory and `cua.getTab(tabId, { browser: browserId })` for the matching
   in-app tab; follow its first-call requirements and returned documentation.
   Use only APIs actually exposed by the runtime. A missing legacy browser
   skill or API is not a reason to reinstall tools or invent a substitute call.

2. **One tab.** Reuse the verified tab. Create an in-app tab only if the bound
   tab is absent and the session rules authorize it. Navigate only when the
   required URL differs. Never reuse another task's chat merely because it is
   open, and do not control unrelated browser surfaces.

   **项目入口兼容恢复。** 保存网页实际提供且已验证打开的完整项目 URL，
   保留项目 ID 后的名称后缀；不要手工删除后缀或猜名称。项目身份比较使用
   稳定的 `g-p-<id>`，名称变化不代表另一个项目。项目页直接加载或刷新可能
   仅显示“重试”，即使完整 URL 正确也如此；使用已加载页面中的项目链接
   进行站内跳转，不把链接再交给 `goto`。新线程优先只读打开该工作区已保存
   的旧对话，从页面的“打开项目”链接进入同一项目。旧对话仅用于取入口，
   不发送消息、不据此绑定当前任务。没有可用旧对话时，可打开首页，待侧栏
   加载后选择可核实的同一项目；不得在首页发送协作消息。此恢复路径是下文
   直接项目导航及禁止首页/侧栏规则的限定例外。确认项目 ID 一致、标题及
   “项目中的新聊天”输入框后，只更新 `--project-url`，保留原对话和任务
   检查点。找不到可验证的入口则停止此路径并报告；不要重建连接器或循环重试。

3. **Visible and retained.** Keep the collaboration tab visible and retained.
   Use `markHandoff` / `markDeliverable` or visibility controls only if the
   runtime documents them. Do not close the user's collaboration tab or let a
   legacy helper requirement block an otherwise usable connection.

4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     (skip when `c2c prefs --json` has `developerModeEnabled: true`)
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - 新对话 (long-chat only, and only if no saved chat): `https://chatgpt.com/`
   - Saved C2C chat: `conversation.chatUrl` / `session.url` (long-chat, or
     the chat already bound in THIS Codex conversation)
    - Saved Project collection: `conversation.projectUrl`
      (`https://chatgpt.com/g/g-p-…/project`)
    - 临时独立验收 Chat: only the temporary URL actually returned by the
      current supported UI for the independent-audit workflow. It may not contain
      `/c/`; use it only for the frozen-attachment route, never guess a session
      ID and never save it as a `--role audit` binding or ordinary chat.
   Connector recovery decisions belong only to `references/workflows/recovery.md`. Use a
   fresh Doctor result, the exact workspace identity and the current supported
   action; do not infer that an address changed, delete a connector, or forbid
   an in-place action from an old failure pattern. If current evidence and
   authorization require recreation, operate only on this workspace's exact
   `connectorName`. Never put a public address into Project instructions —
   write the connector **name** only.

5. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation, Chat mode.** The first ChatGPT chat is the C2C
   conversation. Chat and Work (聊天 / 工作) are separate: a Work conversation
   cannot become Chat. On every NEW conversation, if a Chat/Work switcher is
   visible (often top-left), confirm **Chat** is selected before the boot
   prompt. If it is Work, do not continue there — Switch to a new Chat
   conversation (HANDOFF). If no switcher is visible, do not hunt menus; continue.
   Send the boot prompt and the workspace_info check in that Chat conversation.
   Confirm the reply names the current workspace **before** saving or replacing
   the session URL. If validation fails, keep the old saved URL. Do not open a
   throwaway verify chat and later another C2C chat.

   **两个窗口。** 一个工作区可以有规划窗口（`--role planning`，讨论、研究
   和过程复核）与独立验收窗口；持久 C2C 验收窗口使用池中独占的
   project-only Project 和 `--role audit`，池按实际并发复用。池空位、独占、
   清理或隔离未核实时，用专项流程的无 role 临时 Chat 补位，不强制排队。
   规划/持久 C2C 验收使用各自 URL，临时验收使用专项流程实际提供的 URL，
   两者不得互相覆盖；`--same-thread` 只是调用方断言，不是机器可验证的线程
   绑定。验收窗口是独立的新上下文；规划与持久 C2C 验收复用同一连接器，
   不因另一个 Project 获得额外本地读写权限。`--role audit` 仍只支持持久
   C2C Project 路线；planning 和 audit 初次绑定都须有完整 Project-chat
   身份，audit 另须精确候选。已有完整绑定后才可部分更新支持字段；不完整
   读回必须 fail-closed，不得冒称可用或自动回退 legacy。默认模型与 Pro
   回切规则不变。

8. **等待 ChatGPT 完整回复。** 委派时一次性要求完成或阻断后在原绑定对话返回结果。发送后保留同一标签，优先等原生完成事件；无独立已授权工作就直接等待。
   - 思考或生成期间不发送任何进度询问、催促、重复提示词或无必要的补充消息，不要求对方定期汇报。
   - 网页没有完成事件时，静默等待后才做最少只读完成检查：通常约两分钟后首次检查，仍生成则延长到约五分钟；通过现有等待接口分段等待，单次阻塞不超过 60 秒，不在每段等待后读取 DOM、截图、日志或发消息。没有新事实不重复向用户播报等待状态。
   - 完整 PLAN / DONE / BLOCKED 或工作区验证回复到达后，一次性读取必要内容，再验收并继续依赖工作。
   - 仅实际错误、明确阻断、用户新指令或达到既定截止条件时介入。单次浏览器等待超时不证明生成失败；保持原对话，不重发、不另建聊天或后台观察者。
   普通 ChatGPT 的返回是原对话中的回复；仅使用实际支持的接收通道，不声称它能主动唤醒 Codex 或应用关闭后持续运行。

## 模型与思考档位

适用所有已授权的普通 ChatGPT 协作，包括 planning 与 audit。目标档位取当前全局约定及本次明确指定：默认 GPT-5.6 Sol Pro，深入推理确有收益时使用 GPT-6 Pro。网页模型与 Codex、DSH、Luna 的执行模型分别管理；用户本次明确指定优先。失配、额度不足或工具缺失时报告真实情况，不静默降级。

### GPT-6 Pro 的使用判断

预计 GPT-6 Pro 的深入推理能改善方案或发现实质遗漏即可选择，不要求同时具备高影响和高难度，也不要求 GPT-5.6 Sol Pro 先失败。总控简记问题和预期价值，自主选档，不额外发一轮消息让 Chat 批准选择。

- 优先 GPT-6 Pro：有实质难度的需求梳理、多方案比较、跨模块或多约束规划、研究方法与关键假设推敲；需要综合判断的重要阶段复核或独立验收；证据冲突、难解释反例或隐藏风险分析。不能仅凭“架构”“审核”“重要”等名称升级。
- 保持 GPT-5.6 Sol Pro：连接/身份核验、启动与交接、简单整理、进度汇总、常规文案、按明确标准即可完成的复核、普通计算、机械修复及已被测试裁决的问题。长文本、一次报错或“最终报告”本身不构成 GPT-6 Pro 理由。
- 同一 GPT-6 Pro 请求合并相关问题与必要依据；问题处理完成后回切 GPT-5.6 Sol Pro。后续新问题重新判档，不沿用上一次型号作为理由。

结合当前账户可见的剩余额度、重置时间与待办关键任务安排；余量未知时按任务价值选择，不编造剩余次数，不为探测额度发送模型消息，不创建新对话或切换产品规避限制。GPT-5.6 Sol Pro 与 GPT-6 Pro 的额度关系以当前账户提示为准，不用 Codex 用量推断 Chat 余量。
### 切换与验证

每一条发送（既有/新对话、boot/INIT/REVIEW/普通消息，以及浏览器、C2C、应用或连接器通道）都必须按当前任务重新判档，形成：`TARGET_CHAT→CLASSIFY→SELECT_IF_NEEDED→READ_BACK→SEND→VERIFY_RESPONSE`。

- `TARGET_CHAT`：在 C2C 规划和持久验收路线中，既有对话必须锁定同一标签页内目标具体 `/c/` 对话的输入区；新建首条消息仅可在已授权且已核验、符合当前绑定会话模式的新聊天输入区执行（项目模式须在已绑定项目内），创建后立即绑定具体 `/c/` 并再次核对。临时不个性化附件验收路线以当前受支持界面实际返回且已核验的临时 URL 和同一标签页输入区为目标，不要求 `/c/`，不保存为持久角色或普通聊天绑定。各路线都须确认没有生成中、他任务占用或用户草稿。对既有对话，项目首页、侧栏、其他窗口、旧消息模型标签和回复下方的“切换模型”菜单都不是本条路由入口；旧对话只作入口时不操作，只有用户明确授权该既有对话为验证目标才做最小测试。
- `CLASSIFY`：按这条消息的当前任务判档，不只沿用首次发送或阶段转换的判断；提示词中写“使用 Pro”不能切换网页模型。先确定目标档及理由，再读取当前型号；当前已经是 Pro 不能反过来充当继续使用 Pro 的理由。
- `SELECT_IF_NEEDED`：仅在目标与输入区当前选择不一致时切换；已显示相同值时复用这次新鲜读回，不重复点击。
- `READ_BACK`：在该输入区读回模型和强度。读回不明或不匹配即停止，不能发送；新会话创建后，无论创建时默认值如何，发送前必须再次读回。
- `SEND`：门通过后才发送。应用 `send_message_to_thread` 的 `model`/`thinking` 参数只支持 Codex，不能给普通 ChatGPT 切档；需要切档必须先用本流程的浏览器控件，否则不得声称完成。
- `VERIFY_RESPONSE`：分别记录选择器成功、收到回复、回复产品标注的实际模型、连接器实际调用；模型自报不算证据。回复下方“切换模型”菜单可能重生成旧回答，只能只读查看标注，不用于切换后续消息。

实际发送调用要把保护检查和点击放在同一段 CUA `tab.playwright` 脚本中；下面的 `targetUrl`、`targetLabel` 必须来自本条已核实目标和任务判档，草稿由调用方预先准备：

```javascript
if (await tab.url() !== targetUrl) throw new Error("目标对话不匹配，停止发送");
const modelButton = tab.playwright.getByRole("button", { name: targetLabel, exact: true });
if (!await modelButton.isVisible()) throw new Error("输入区模型或强度读回不匹配，停止发送");
const stop = tab.playwright.getByRole("button", { name: "停止回答", exact: true });
if (await stop.count() !== 0 && await stop.isVisible()) {
  throw new Error("目标对话仍在生成，停止发送");
}
// 草稿已在本段脚本外准备；发送门不覆盖或重填用户输入。
const send = tab.playwright.getByTestId("send-button");
if (!await send.isEnabled()) throw new Error("发送按钮不可用，停止发送");
await send.click();
const afterSend = await tab.playwright.domSnapshot();
```

任一断言失败都不得点击发送；发送后用 `afterSend` 和后续同一标签页读回验证。此段是本次协作的发送保护步骤，不是软件全局拦截器；不得用隐藏请求、页面注入、后台守护进程或新的 CLI 开关替代它。


1. 在已核实的当前任务 Chat 或其项目新聊天输入区操作；只读用于恢复入口的旧对话不作切换目标。生成中、草稿待发、或由其他活跃任务使用时不抢占。切换只影响后续请求，不重生成旧答案、不为切换另建对话。
2. 每条发送前都读取当前具体输入区的模型控件并重新判档；首次发送、任务重要性改变、恢复/新建会话或发现额度/降档提示时不得省略。已有未变且明确的可见选择只能在本条目标输入区读回后复用；选择相同则不重复操作。发送前确认选中值与本次目标一致。
3. 使用当前浏览器文档支持的模型菜单与键盘操作；基于新鲜 DOM/可访问性状态定位，不硬编码坐标、菜单顺序、内部请求或浏览器存储。用户要求的两档内切换无需逐次询问。
4. 默认档需核实模型为 GPT-5.6 Sol、能力为 Pro，并在输入区读回 `5.6 Pro`；深入档需读回 `6 Pro`。只有“Pro”“最新”或单独的模型名称都不能确认完整组合。菜单变化或映射不清时先查当前官方说明，不把未来的“最新”自动等同 GPT-6 Pro。
5. 2026-09-16 当前界面与官方说明：模型菜单可选“GPT-5.6 Sol”，能力菜单可选“Pro”；GPT-5.6 Sol Pro 与 GPT-6 Pro 是两个不同的 Pro 模型。切换时先根据新鲜 DOM 展开实际模型/能力控件，再选择目标组合并读回输入区完整标签；不要依赖旧的“5.6 极高”操作顺序、固定方向键或菜单位置。
   - 回切目标是 GPT-5.6 Sol Pro：选择 GPT-5.6 Sol 与 Pro，读回 `5.6 Pro`。
   - GPT-6 Pro 目标读回 `6 Pro`。若菜单只显示“最新”或映射不明，停止发送并报告，不以点击成功代替型号证明。
6. 选择器可切换不证明该模型已成功调用连接器。模型或模式变化后，下一次本就需要的 workspace_info 等读取须核实实际工具能力和工作区；不额外发送无意义测试消息。遇到模型不可用、工具缺失、额度不足或自动降档，报告真实选择与限制，暂停依赖项，不静默换成其他模型或 Work。
7. 模型选择事实以界面/实际调用证据为准，回复自称某模型不算证明。仅在切换或影响结论时，在现有任务记录中简记目标档、读回值及限制，不新增长期观察器。

### GPT-6 Pro 回复后的回切收尾

每条 GPT-6 Pro 回复完成且已处理后，仅当同一关键问题还有马上要发送的必要 GPT-6 Pro 追问时才暂时保留，并简记未解问题及理由；否则立即回切 GPT-5.6 Sol Pro，不等下一次发送或整个项目结束，也不为回切发送测试消息。

结束本轮、暂停或移交意味着暂不继续发送，即使以后可能还需 GPT-6 Pro，也应先回切，恢复后再判档。本次用户明确要求保持指定型号时优先遵循，不强制回切。回切验收为目标对话正确、生成已结束、输入区读回 `5.6 Pro`；`6 Pro`、Medium/High/Extra High 或读回不明均不算完成。生成中、他任务占用或页面不可用时不抢占，记录回切待完成及原因。

调节能力时只操作新鲜 DOM 中已定位的控件，每次改变后读回实际组合；不要向不明确焦点连续发送方向键。操作标题、点击成功、回复自述和旧消息型号都不是成功证据。

C2C 当前 prefs/session CLI 没有普通 ChatGPT 网页模型参数。此流程由 Codex 的浏览器操作执行；不要向 config.toml、C2C prefs 或模型自述写入虚构开关，也不要声称这是软件原生的全项目自动路由功能。

官方依据（2026-09-16 核验）：[GPT-5.6 and GPT-6 Pro in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-5-6)。GPT-5.6 Sol 的 reasoning 选项包括 Medium、High、Extra High；Pro 选项可选择 GPT-5.6 Sol Pro，并在符合条件的方案中选择 GPT-6 Pro。额度和可用性以当前账户显示为准。
