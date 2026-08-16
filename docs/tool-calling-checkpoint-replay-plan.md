# DeepSeek-Harness 工具调用优化实施计划（自动暂存 · 局部编辑 · 重放）

> 状态：proposed（待评审）· 版本 v2（按评审意见修订）
> 目标仓库：`/Users/canglong/Program/deepseek-harness`（pnpm monorepo，cordis 插件架构）——**本特性只新增插件包，不改动 ds harness 核心代码**
> 本文档落盘位置：`docs/tool-calling-checkpoint-replay-plan.md`（本工作区）
> 特性代号：tool-call checkpoint & replay（建议 npm 包名 `@deepseek-ai/dsh-tool-retry`）

---

## 1. 目标概述

本特性解决 DeepSeek-Harness 在处理**长参数 Tool Calling** 与复杂规划任务时的两类问题：

1. **Token 浪费**：工具调用失败后，模型为了重试通常重新生成整段长参数（例如数百行的 JSON 配置、大批量编辑指令）。
2. **编辑困难**：局部修正一段超长参数时，模型必须整段重写，既慢又容易引入新的不一致。
3. 附加能力：**执行成功的调用同样落盘**——agent 可能需要重放「被标注为成功、但结果不符合预期」的 tool calling。

方案：引入「自动暂存（auto-checkpointing）→ 提示注入（context injection）→ 局部编辑 → 重放（replay）」闭环：

- **每一次工具调用（无论成功或失败）**，Harness 把该次调用的原始参数字符串自动落盘到统一管理的临时目录，并维护「每个工具最近一次调用」的软链接；
- **静态注入**：在 system prompt 中写入该机制说明（目录约定、软链接约定、重放工具用法），让 AI 提前知悉「可以修改并重试」；
- **动态注入**：通过 `tools/post-execute` 生命周期钩子，在调用失败后向模型注入一次性提示，告知参数已完整保存在 XX 文件、内容与输入 arg **字节级同构**、可直接编辑后重放；注入节奏为**每 3 次失败注入一次（第 1、4、7… 次失败注入）**；
- 重放分两种模式：
  - **PTC 模式**（Code Mode / `run_code`，即 UI 中的「PTC 模式」预设）：**不新增工具**——ptc 可以把 fs 工具的输出直接作为其他工具的输入；
  - **其他模式**（native 标准模式）：新增工具 `editPreviousToolCalling`，签名与内置 `edit` 完全一致，但 instruction 不同、执行流程为「编辑 checkpoint 文件 → 读取编辑后内容作为新 arguments → 以新参数重新 invoke 原工具」。

量化目标（第五阶段评测验证）：失败重试的 token 消耗显著下降（建议基线目标：重试步输出 token 节省 ≥ 40%，见 §6），重试成功率不低于「全量重新生成参数」的基线；暂存/通知的固定开销最小化（通知节奏受控 + 单条通知）。

---

## 2. 现状调研结论（第一阶段成果）

> 调研结论按「设计决策所依赖的代码事实」组织，全部附文件:行号。代码地图速查表见附录 A。
> 关键澄清：代码库中**不存在**名为 `after-tool-calling` / `ToolCallingHandler` 的符号；其等价物是 `tools/post-execute` 瀑布钩子（详见 §2.1），本计划即以它实现「after-tool-calling」语义。

### 2.1 工具执行管线与生命周期钩子

- 工具注册表服务 `ToolRuntime`（cordis 服务名 `tools`）：`packages/core/tools/src/index.ts`
  - `'tools/pre-execute'`（waterfall，allow/deny/ask）：:152
  - `'tools/execute'`（waterfall，around-dispatch）：:163
  - **`'tools/post-execute'`（waterfall）：:175** —— 接收 `(exec, result, next)`，返回 `PostToolDecision`（`accept`/带 `additionalContexts` 或 `block`，:597-600）。异步、被 await、结果决策有序提交。**这就是「after-tool-calling」钩子**：每一次工具调用（含 code-mode 嵌套子调用）都会经过它，失败结果同样到达（"thrown tools still reach this waterfall as errors"）。
  - `'tools/result'`（emit，冻结最终结果观察点）：:197
  - `ToolRuntime.execute(exec): Promise<ToolExecutionResult>`（公开的程序化调用入口，重放用）：:1342
  - `ToolRuntime.get(name, scope?)`（按 scope 解析可见工具，**公开**）：:1204；`schemas(scope?)`：:1234
- 循环执行器：`packages/core/agent-loop/src/tool-calls.ts`
  - `appendToolCall` 把模型调用落盘为 `tool/call` 事件，**含原始参数字符串**：:262-264
  - 结果提交后，`result.additionalContexts` 经 `acceptContext` 送入下一步 inbox：:155-156；`agent.ts` 在下一步 preStep 领取并追加为 user 消息：:395-398
- **code-mode 桥转发嵌套上下文**：`packages/core/tools/src/code-mode.ts:560-562` 把子调用的 `additionalContexts` 经 `exec.deferContext` 转发到外层 `run_code` 结果。⇒ 用 `tools/post-execute` + `additionalContexts` 注入通知，在 **native 与 PTC 两种模式下都成立**，且时序天然位于该次调用的 `tool/result` 之后。

### 2.2 失败判定与调用标识（callId）

- 结果判别式：`ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`，`isError: true/false`：`packages/core/tools/src/index.ts:556-580`
- 预定义错误码：`TOOL_ABORTED = 'ABORTED'`、`TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`：:469-472；不可见工具报 `UNKNOWN_TOOL`（execute 文档 :1332）；参数 schema 校验失败为 `ToolArgsError`（code `INVALID_ARGS`，`schema.ts:461-470`）——**仍然经过 post-execute**，正是「长参数 schema 失败后局部修正重放」的主场景。
- **调用 id 现状（评审点 6 的评估结论：有 id，可用）**：
  - native 模型直调：`ToolCallBlock.id`（`CallId`）由模型在回复中自己生成（API 格式的 tool_call id），**模型知道自己每个调用的 id**；`tool/call` 事件落盘 `{ turn, step, callId, name, arguments: string }`（原始未解析串）：`packages/core/session/src/types.ts:279`
  - code-mode（PTC）子调用：callId 由 harness 铸造为 `<parent>:code:<n>`（`code-mode.ts:468`），**模型不知道**；其参数以 byte-identical JSON 落盘于 `tool/code-dispatch` 事件（`code-mode.ts:508-519`），等价于 `JSON.stringify(exec.arguments)`
  - ⇒ 结论：native 下模型可凭 callId 直接定位 checkpoint 文件；PTC 子调用模型无法自算 callId，**需要「每个工具最近一次调用」的软链接兜底**（见 §3.2），失败场景则始终由通知给出精确路径。

### 2.3 上下文注入通道（评审点 1：已定，采用 `tools/post-execute`）

- **采用**：`tools/post-execute` 监听器对失败结果返回 `{ ...next决策, additionalContexts: [通知] }`（失败结果同样支持 `additionalContexts`：`tools/index.ts:575`）。经 2.1 的链路，通知在下一步出现在模型上下文中；监听器内无条件 `await next()` 保持瀑布链（不占据决策槽）。
- 静态协议说明：`ctx.systemPrompt.section({ name, order, text })`（`packages/core/system-prompt/src/index.ts:375-384`；`PromptSection` :53-75）。order 约定：-100 harness 身份、0 persona、**100-199 工具指引带**（:56-60）；`text` 支持 `(AssembleContext) => string` 动态函数（可随 scope 切换文案，`AssembleContext` 含 `scope`/`agent`）。工具自带指引段范例：`packages/fs/tool-fs/src/edit.ts:77-81`（order 102）。

### 2.4 fs 观察策略与「免读直接编辑」的绕过

- fs 服务与事件：`packages/fs/fs/src/index.ts` —— `Context.fs` :44-47；`'fs/edit-intent'`（waterfall，单决策槽）:66；`'fs/observed'`（emit，同步记录）:76；`writeText(target, content, expected?, signal?, sandboxPolicy?)` :222-228（**返回 `FsWriteOutcome.version`**）。
- 「edit 必须先 read」的限制来源：`packages/fs/fs-observation-policy` 的 `editIntent` 对无观察记录的目标抛 `FS_NOT_OBSERVED`（`src/index.ts:78-88`）；观察归属由 `actor.agent.session` 推导（:36-41），`FsObservationActor = { agent?: { session?: object } }`（`src/types.ts:23-29`），`ToolExecution` 天然满足该形状。
- **已验证的绕过方案（免改核心）**：插件自己写 checkpoint 后，**同步 emit 一条预观察记录**：

```ts
const target = await ctx.fs.resolve(checkpointPath, { cwd: session.header.cwd })
const outcome = await ctx.fs.writeText(target, rawArgs)        // 无条件原子写（不占用 fs/write-intent 槽）
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

  要点：(a) 必须传 `outcome.version`（写操作返回的版本，作为后续 edit 的 CAS 基准，同 `write.ts:122` 的做法）；(b) actor 必须是本次调用的 `exec`（`undefined` 不记录任何东西）；(c) 观察表以 **Session 对象**为键（同进程同会话内有效——checkpoint 重放正是同进程场景）；(d) code-mode 子调用的 exec 同样携带 `agent`（`code-mode.ts:474`），**两种模式都适用**。
- 沙箱约束（插件直写同样受后端约束）：`SandboxedFileSystem.checkedTarget`（`packages/fs/fs-sandbox/src/index.ts:126-148`）按 `ctx.sandboxPolicy.resolve()` 的部署默认模式拦截；`workspace-write` 下可写根 = workspace root + `/tmp` + `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts:52-55`）；`read-only` 下写盘被拒 → 特性自动降级（不落盘、不通知，仅记日志）。

### 2.5 通知节奏（评审点 2：每 3 次失败注入一次）

- **不再使用上下文百分比节流**（原「每 20% context 最多一次」方案删除），改用简单的**按失败次数计数**：
  - 每会话维护失败计数 `failCount`（`WeakMap<Session, number>`，仅统计排除名单之外的失败）；
  - 注入条件：`failCount % notifyEveryFailures === 1`，即**第 1、4、7… 次失败注入，第 2、3、5、6… 次不注入**（`notifyEveryFailures` 默认 3，Config 可配）；
  - 计数只门控「模型可见的通知」——**checkpoint 落盘不受限**（每次调用都落盘，见 §3.2）；
  - 进程重启后 `WeakMap` 归零 → 节奏重新开始，通知幂等，可接受。
- 该方案不再依赖 tokenizer/tokenMeter/contextWindow 等任何用量口径，实现与测试都显著简化。

### 2.6 模式探测（评审点 3：不改 ds harness，仅用公开 API）

- **不新增/不修改任何 ds harness 代码**。探测手段：`ctx.tools.get(RUN_CODE_NAME, agent)` 是否返回可见定义。
  - `RUN_CODE_NAME = 'run_code'` 已从 `@deepseek-ai/dsh-tools` 导出（`code-mode.ts:20`，`index.ts:104` re-export）；
  - `ToolRuntime.get(name, scope?)` 是公开方法（:1204）；`view()` 只在 `modeFor !== 'native'` 时把 `run_code` 插入可见表（:1189-1191）⇒ **get 到 run_code ⇔ 当前 scope 非 native（code 或 both）**；
  - code 与 both 的精确区分无法通过公开 API 获得，也**不需要**：只要 run_code 可见，就下发 PTC 版文案——both 模式下 `run_code` 同样可调用，文案成立。
- 使用位置：(a) 静态 system prompt 段的 `text` 提供函数里，用 `context.scope` 探测并切换 A/B 两版文案；(b) post-execute 监听器里，用 `exec.agent` 探测并选择 C/D 两版通知。

### 2.7 插件包脚手架与 preset 接线（要点）

- 新包位置建议 `packages/core/tool-retry`（npm 名 `@deepseek-ai/dsh-tool-retry`）。脚手架完整清单见附录 A（package.json 不变式、tsconfig 引用、tsdown 自动纳入 `packages/*/*`、`pnpm-workspace.yaml` 双级 glob）。
- preset 是**全量拷贝的 cordis.yml**（非合并）：`apps/cli/config/agent-presets/{standard,code,cordis,minimal}/agent.cordis.yml`；PTC（code）预设 = standard + 一行 `tool-presentation`（`mode: code`，code 版 :259-262）；接线即向 standard 与 code 两个 yml 各加一行插件行（参考 tool-fs 行 standard :56-57）。注：这是 preset 配置文件的增行，不改 harness 核心代码。
- 仓库合规要求（后续 PR 必须满足）：根 `AGENTS.md:122`（非平凡变更必须带 Agent Note，格式 `.agents/notes/proposed/feature/yyyy-mm-dd-<topic>.{md,zh.md,i18n.yaml}`，骨架 `## Problem / ## Proposal / ## Alternatives considered / ## Acceptance criteria / ## Risks`）；`packages/AGENTS.md`（插件导出形状 `name`/`inject`/`Config`/`apply`、HMR disposal 测试、`./invariant`、README 的 Model Experience 格式）；`docs/cookbook/adding-a-package.md` 逐文件清单。

---

## 3. 总体设计

### 3.1 架构总览

```text
模型发出工具调用（长参数）
   │  native: 直调工具；PTC: run_code 程序内 tools.<name>(args)
   ▼
agent-loop 调度执行（tools/pre-execute → tools/execute → 工具体）
   ▼ 每次调用（成功或失败，非排除名单）
tools/post-execute 瀑布  ← 本特性监听器（"after-tool-calling"）
   ├─ ① 自动暂存：写 <checkpoint-dir>/<callId>-<toolName>.json（原始参数字符串）
   │        原子更新软链接 latest@<toolName>.json → 本次 checkpoint（每工具一条）
   │        + ctx.emit('fs/observed', ...) 预观察（免读可直接 edit）
   ├─ ② 仅失败时计数：failCount++；failCount % 3 === 1 才继续（1、4、7… 次失败）
   └─ ③ 注入通知：返回 next决策 + additionalContexts[createUserMessage(通知)]
   ▼
会话落盘顺序：…tool/result（成功或失败）→（下一步）user/message（通知，仅命中节奏时）
   ▼
模型下一步（system prompt 静态段已提前告知机制与目录/软链接约定）：
   ├─ native：edit(<checkpoint 或 latest@ 别名>) → editPreviousToolCalling(file_path, old, new, ...)
   │            └─ 插件内：内置 edit 机制改文件 → readText → JSON.parse → 嵌套 ctx.tools.execute 重放原工具
   └─ PTC：新 run_code 程序内 tools.edit(checkpoint/latest@) → tools.read → JSON.parse → tools.<name>(fixed)
              （fs 输出直接作为其他工具输入，无需新工具）
```

### 3.2 自动暂存（Auto-Checkpointing）——成功与失败都落盘

| 项 | 设计（默认值，均可配置） |
| --- | --- |
| 触发 | **每一次合格调用都落盘（成功 + 失败）**（评审点 5）——agent 可重放「成功但结果不符预期」的调用。排除名单见 §3.3 |
| 目录 | `<session.header.cwd>/.dsh/tool-checkpoints/<sessionId>/`（推荐：位于 workspace 根内，沙箱 `workspace-write` 可写、模型可直接寻址）；备选 `os.tmpdir()` 全局临时目录（spill 惯例 `mkdtempSync(join(tmpdir(),'dsh-checkpoint-'))`，`packages/spill/spill-local/src/store.ts:27-30`）——见 §7 决策点 2 |
| 文件名 | `<sanitize(callId)>-<toolName>.json`，sanitize = 非 `[A-Za-z0-9._-]` 字符替换为 `_`。native 直调模型知道自己的 callId，可自行拼路径；文件名自带原工具名映射 |
| **软链接** | **每工具一条**：`latest@<toolName>.json` → 指向该工具最近一次 checkpoint（评审点 6 的兜底）。解决：(a) PTC 子调用 callId 模型不知道；(b) 「刚才那个调用是哪个文件」的快速定位。**并发**：不同工具各更新各的软链接、互不竞争；同工具并发（同工具并行调用，罕见）last-wins，每次替换本身原子（临时名 + rename）；用 `node:fs` 在 `ctx.fs.processPath()` 上建链；后端非本地（如 e2b）时建链失败 → 静默降级（无别名，通知仍带精确路径，native 仍可凭 callId 拼路径），记日志 |
| 文件内容 | **仅原始参数字符串，不做任何包装**——native：从本会话 `tool/call` 事件按 `callId` 取 `arguments` 原串（字节级一致）；code-mode 子调用：`JSON.stringify(exec.arguments)`（与 `tool/code-dispatch` 的 byte-identical JSON 一致）。**这是「与输入 arg 完全同构、免重读直接编辑」的前提** |
| 写入 | `ctx.fs.writeText(target, raw, undefined, signal)`（无条件原子写，不占 `fs/write-intent` 槽） |
| 预观察 | `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)`（§2.4 已验证的绕过；同步 emit，不得 await） |
| 容量 | 每会话保留最近 N=64 个 checkpoint（LRU 按 mtime 淘汰）；软链接指向的文件被淘汰时删除该软链接 |
| 清理 | `session/disposed`（`core/session/src/index.ts:64`）删除该会话整目录；插件 `ctx.effect` teardown 兜底（HMR 安全） |
| 写盘失败 | 静默降级：记日志、跳过通知，**绝不阻断工具管线**（post-execute 监听器必须 try/catch 后仍调用 next()） |

### 3.3 Hook 层（"after-tool-calling" 实现）

- **监听点（评审点 1 已定）**：`ctx.on('tools/post-execute', listener)`（全局注册即可，Scoped 派发按 `exec.agent` 路由；监听器内自行过滤）。
- **必须保持链**：无条件 `await next()` 拿到决策后修改并返回（本插件不占据决策槽，与 fs-observation-policy 那种「不调 next()」的占有式监听不同）。
- **落盘条件**：`exec.agent?.session` 与 `session.header.cwd` 存在（成功与失败都落盘）。
- **排除名单**（Config 可配，落盘与通知共用）：
  - 错误码：`ABORTED`、`ABORTED_BEFORE_DISPATCH`、`UNKNOWN_TOOL`（取消/未知工具没有可重放的参数）；
  - 工具名：`editPreviousToolCalling`、`read`、`write`、`edit`（防自触发递归与 fs 工具噪音）。
  - **保留 `INVALID_ARGS`**：参数校验失败正是「长参数局部修正重放」的核心场景。
- **流程**：每次合格调用 → 写 checkpoint + 更新 `latest@<toolName>` 软链接 + 预观察（§3.2）→ 若 `result.isError` → 计数并按下述节奏注入通知。
- **通知节奏（评审点 2 已定）**：`failCount++` 后，`failCount % notifyEveryFailures === 1` 才把通知附加到 `next` 决策的 `additionalContexts`（`createUserMessage`，source `{ kind:'plugin', plugin:'@deepseek-ai/dsh-tool-retry', form:'notice' }`）；默认 `notifyEveryFailures = 3`（第 1、4、7… 次失败注入）。`WeakMap<Session, number>` 存计数。
- **通知文案按模式选择**（§3.4 草稿 C/D；模式经 §2.6 的 run_code 可见性判定）：run_code 可见 → PTC 版；否则 native 版。
- **重放自身失败的行为**：重放调用走完整管线（嵌套子调用），其失败也会再次触发本监听器——修正后的参数成为新一轮 checkpoint（通知受节奏保护，次数有界）。这是期望行为，保留。
- 通知文本中的错误摘要取 `result.error.message` 截断（建议 ≤200 字符，完整错误已在 tool/result 中）。

### 3.4 提示词注入（⚠️ 待审阅草稿，见附录 B 全文）

注入分两层、四个草稿（评审点 4：**两层都必须有**，静态层让 AI 提前知悉机制，动态层给出具体路径）：

| 层 | 位置 | 草稿 | 时机 |
| --- | --- | --- | --- |
| **静态 system prompt 段**（让 AI 提前知悉可修改重试、目录与 `latest@` 软链接约定、重放工具用法） | `ctx.systemPrompt.section({ name:'tool:checkpoint-replay', order: 149, text: 按 scope 模式动态切换 })`（149 位于工具指引带 100-199 内、SDK 段 150 之前） | A（native）/ B（PTC） | 每次组装，随模式切换 |
| **动态失败通知**（给出本次失败 checkpoint 的精确路径） | post-execute 决策的 `additionalContexts`（仅失败 + 命中节奏） | C（native）/ D（PTC） | 每 3 次失败一次 |

四段草稿的共同要点（也是评审重点）：

1. 明确告知「**每次调用（无论成败）都会暂存**」，成功但结果不符预期同样可重放；
2. 明确告知 checkpoint 内容与上次发送的参数**字节级相同/同构**，因此**无需先 read 即可 edit**（预观察机制已在 §3.2 保证 edit 不会被 `FS_NOT_OBSERVED` 拒绝）；
3. 明确告知定位方式：失败 → 通知给精确路径；其他情况 → `latest@<toolName>.json` 软链接（每工具最近一次）；
4. 明确「仅在需要小修时使用；否则直接重新调用」，防止模型滥用；
5. native 版强调 `editPreviousToolCalling` 与 `edit` 参数完全一致；PTC 版强调在 `run_code` 程序内用 fs 工具完成编辑、读取、解析、重放（`tools.edit` 输出 → 读取 → `JSON.parse` → `tools.<name>(parsed)`）。
6. **已知风险（PTC 版）**：程序内构造的对象经 `JSON.stringify` 后，模型对其格式化记忆可能不可靠，「免读直接 edit」的 old_string 可能失配。两个缓解选项供评审：见 §7 决策点 7。

### 3.5 重放

#### 3.5.1 PTC 模式（不新增工具）

- 复用现有 `run_code` + fs 工具即可：模型在新程序里 `tools.edit`（checkpoint 已预观察，免先读）→ `tools.read` → `JSON.parse` → `tools.<name>(parsed)`。fs 的输出直接作为其他工具的输入，满足「ptc 可以将 fs 作为其他 tool 输入」。
- 不新增任何工具；通知文案（草稿 D）与静态段（草稿 B）承担全部引导职责。
- 注意：PTC 下子调用失败时，外层 `run_code` 只有未捕获才整体失败（模型可 `try/catch ToolCallError` 就地恢复）；子调用的成功/失败**独立**经过 `tools/post-execute`/`tools/result`，因此本特性的 checkpoint（含成功落盘）+ 通知在「程序崩溃后的下一步重试」与「重放成功但不符预期」场景仍然有效（通知经 `deferContext` 转发，§2.1）。

#### 3.5.2 其他模式：`editPreviousToolCalling` 工具

- **签名**：与内置 `edit` **完全一致**——`file_path` / `old_string` / `new_string` / `replace_all`（不引入沙箱升级字段：checkpoint 是 Harness 自有的临时文件，无需模型升级权限）。
- **instruction 不同**：描述为「编辑上一次失败（或任意一次）工具调用的 checkpoint 文件并立即以编辑后内容重新调用原工具」；专属系统指引段 `ctx.systemPrompt.section({ name:'tool:editPreviousToolCalling', order: 103, text })`（紧邻 `tool:edit` 的 102）。
- **file_path 支持两种形式**：精确文件 `<callId>-<toolName>.json`，或别名 `latest@<toolName>.json`（resolve 跟随软链接定位真实文件；原工具名一律从文件名解析）。
- **执行流程**（`defineTool` 注册，`execute(args, exec)`）：
  1. 路径校验：`file_path` 解析后的**真实目标**必须位于**本会话**的 checkpoint 目录内（防越权编辑任意文件；别名形式解析软链接后校验真实目标）；
  2. 从文件名解析原工具名（两种形式都能解析出 `<toolName>`），缺失/非法 → 明确错误结果；
  3. **调用内置 edit 机制**：`ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` + `ctx.fs.editText(...)`（与 `packages/fs/tool-fs/src/edit.ts:124-139` 同一路径；checkpoint 已预观察，策略通过；失败按同款 remediate）；
  4. `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)` 更新观察版本；
  5. `ctx.fs.readText(target)` 读取编辑后内容；
  6. `JSON.parse` → 新 arguments；解析失败 → 错误结果「checkpoint 内容必须保持合法 JSON」；
  7. **嵌套重放**：`ctx.tools.execute({ callId: CallId(`${文件名callId部分}:replay`), name: toolName, arguments: newArgs, agent: exec.agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal })`；
  8. 结果渲染：成功 → `"Replayed <toolName> with the edited arguments:"` + 重放结果的 content；失败 → 抛错使本工具结果为 `isError: true`（模型可继续修正重试）。
- **关键设计点 `parent: exec.token`**：把重放标记为嵌套子调用——(a) 在 code 模式下（本工具被 `run_code` 程序内调用时）穿透 `UNKNOWN_TOOL` collapse（`collapses` 只拦无 parent 的直调，`tools/index.ts:1324-1326`）；(b) 重放完整走 pre/execute/post/result 管线，审批等策略对新参数再次生效。
- **审计日志**：v1 不新增 session 事件类型；重放结果随本工具 `tool/result` 的 content 与 `meta`（`{ replayedCallId, toolName, checkpointPath }`）落盘。可选迭代：新增 `tool/replay` 事件类型（需 core/session schema + UI 卡片，属于改 harness 核心——除非必要否则不做）——见 §7 决策点 5。
- **并发**：不声明 `isConcurrencySafe` → 默认独占执行（`executionMode` 分类 fail-closed，:1276-1285）。

### 3.6 模式探测（评审点 3：仅用公开 API，不改 ds harness）

- 实现即 §2.6：`ctx.tools.get(RUN_CODE_NAME, agent) !== undefined` ⇔ 非 native。静态段 `text` 提供函数用 `context.scope`、通知选择用 `exec.agent` 调用该探测。
- **本特性不包含任何对 `packages/core` / `packages/llm` / `packages/fs` 等 harness 代码的修改**；全部能力在一个新插件包 + preset 配置增行内完成。

### 3.7 新插件包与 preset 接线

- **新包**：`packages/core/tool-retry`，npm 名 `@deepseek-ai/dsh-tool-retry`。
  - 插件导出：`export const name = 'tool-retry'`、`export const inject = ['tools', 'fs', 'systemPrompt']`、`export const Config: z<Config>`、`export function apply(ctx, config)`。
  - `Config`：`{ enabled=true, checkpointDir='.dsh/tool-checkpoints', notifyEveryFailures=3, maxCheckpoints=64, excludeToolNames=['editPreviousToolCalling','read','write','edit'], excludeErrorCodes=['ABORTED','ABORTED_BEFORE_DISPATCH','UNKNOWN_TOOL'] }`。
  - 遵循 `packages/AGENTS.md`：`./invariant`（invariant.ts）、HMR disposal 测试、README Model Experience 格式（What the model sees / Token effect / KV Cache effect）。
- **preset 接线**（preset 文件是全量拷贝，需复制到每个目标）：
  - `apps/cli/config/agent-presets/standard/agent.cordis.yml`（tool-fs 行 :56-57 之后）
  - `apps/cli/config/agent-presets/code/agent.cordis.yml`（同位置；PTC 预设）
  - （可选）`cordis/agent.cordis.yml`（创造模式）
```yaml
- id: tool-retry
  name: '@deepseek-ai/dsh-tool-retry'
```

---

## 4. 实施步骤（五阶段）

### 阶段一：确认上述需要的所有信息 ✅（已完成，成果即本计划 v2）

- 全部代码事实见 §2 与附录 A；遗留决策点清单见 §7，需评审确认后进入阶段二。

### 阶段二：Hook 层开发（先跑通 native 路径）

1. 建包 `packages/core/tool-retry`（package.json / tsconfig.json / src/index.ts / src/invariant.ts，按附录 A 脚手架清单）。
2. 实现 `tools/post-execute` 监听器：合格调用过滤与排除名单 → 原始参数串提取（`session.events` 中 `tool/call` 按 `callId` 查找；子调用用 `JSON.stringify(exec.arguments)`）→ checkpoint 写盘 + `latest@` 软链接 + 预观察（§3.2）→ 失败计数与节奏判定（§3.3，`WeakMap<Session, number>`）→ 通知附加（§3.3）。
3. `Config` schema 与 `inject` 声明；`apply()` 注册监听与 teardown（HMR 安全）。
4. 静态段与动态通知先落 native 草稿（附录 B 的 A/C），PTC 版文案阶段三补齐。
5. **验收**：单测通过（§5.1）；keyless 快照跑通「长参数工具失败 → checkpoint 落盘 → 命中节奏时下一步收到通知」最小链路。

### 阶段三：插件开发（重放 + 双模式 + 接线）

1. 实现并注册 `editPreviousToolCalling`（§3.5.2，含路径校验、`latest@` 别名解析、内置 edit 复用、嵌套重放）。
2. 模式探测（§2.6/§3.6，仅公开 API）；静态段与通知补 PTC 版文案（附录 B 的 B/D），按 run_code 可见性切换；静态段 order 149、工具指引段 order 103。
3. preset 接线（standard + code 两个 yml，§3.7）。
4. **验收**：native 与 code 双模式集成测试通过（§5.2）；「编辑→重放→原工具成功执行」全链路在两种模式下可复现；`run_code` 程序内调用 `tools.editPreviousToolCalling` 亦能穿透 collapse。

### 阶段四：测试与验证

- 完整测试清单见 §5；快照与 e2e 纳入仓库门禁（`test:snapshot` / `test:e2e`）。
- **验收**：§5 全部通过；AGENTS/packages-AGENTS 合规检查通过（`doc-sync` / `constraints` / `typecheck` / `lint` / `build` / `hygiene`）。

### 阶段五：评测

- 评测方案见 §6。
- **验收**：离线 A/B 报告（token 节省、重试成功率、开销）+ 真模型评测数据；结论支持/否定目标（§1）。

---

## 5. 测试与验证

1. **插件单测**（模板：`packages/fs/fs-observation-policy/tests/policy.spec.ts` 的 `new Context() + ctx.plugin` 方式）：
   - 成功与失败调用都触发落盘与预观察；排除名单各分支；`ABORTED`/取消不落盘；
   - 通知节奏：第 1 次失败注入、第 2/3 次不注入、第 4 次注入；`notifyEveryFailures` 可配；计数按会话隔离；进程重启后节奏重置；
   - `latest@<toolName>` 软链接：每次调用后指向最新 checkpoint；不同工具互不影响；同工具并发 last-wins；目标被 LRU 淘汰时软链接删除；建链失败（模拟非本地后端）时静默降级；
   - 写盘失败/沙箱拒绝 → 不通知、管线不受影响。
2. **工具单测**（模板：`packages/fs/tool-fs/tests/tools.spec.ts:38-120` 的 `FakeFs extends FileSystem` + `ctx.tools.execute`；edit 工具用例模板 :422-471）：
   - `editPreviousToolCalling`：正常编辑+重放成功；`latest@` 别名解析；`old_string` 失配报错；编辑后内容非法 JSON；`file_path`（含别名解析后的真实目标）越出 checkpoint 目录被拒；原工具未注册/重放失败透传；`fs/observed` 版本更新。
3. **agent-loop 集成**（`packages/fs/tool-fs/tests/harness.ts:15-24` 的 `fsHarness` + `packages/test-support/agent-loop-testkit` `mountAgentLoopTestDependencies` :37-46）：真实循环内「成功调用也落盘 → 失败 → 通知 user 消息时序（位于该 tool/result 之后）→ edit+replay → 结果」全链路。
4. **code-mode 集成**：`run_code` 子调用（成功与失败）→ checkpoint 内容 = byte-identical JSON → 下一步程序内 `tools.edit`（无需先 read，验证预观察生效）→ 重放成功；`additionalContexts` 经 `deferContext` 正确转发到外层结果；PTC 下模型凭 `latest@` 别名定位「刚调用的那个文件」。
5. **keyless 快照/回放**：`packages/test-support/llm-replay` + `replay.override.json` 强制注入失败并脚本化两臂重试；纳入 `pnpm run test:snapshot`。
6. **真实 API e2e**：`test:e2e`（无 key 自动跳过）；PTC 与 native 各一例。
7. **合规**：根 AGENTS.md（Agent Note 三语三元组随 PR）、packages/AGENTS.md（导出形状/HMR disposal/`invariant`/Model Experience README）、`docs/cookbook/adding-a-package.md` 逐项清单、`verify-translation-pairing`。

---

## 6. 评测方案（第五阶段）

**指标**（数据源 = session JSONL 权威日志，无需新埋点）：

- 重试步输出 token：`assistant/message.usage.outputTokens`（`packages/core/session/src/types.ts:266-273`），或 `tokenMeter` 的 `tokenUsage` 投影（仅评测读取，特性运行时不依赖）；
- 重试成功率：通知所在下一步内，原工具名再次出现且 `tool/result` 无 `error`（`types.ts:291-297`）；
- 「成功但重放」场景成功率：模型对成功调用发起重放后，重放调用无 `error`；
- 任务成功率：`turn/end.reason` 非 `error`/非 `max-tokens`（`types.ts:146-168`）；
- 开销：checkpoint 写盘耗时与文件量、通知注入条数（应恒等于 `⌈失败次数/3⌉`）。

**A. 离线确定性 A/B（首选，无 API key、可进 CI）**：

1. 语料：构造/采集 `tool/call.arguments` 超长（按字节数阈值筛选）的 `session.jsonl` fixtures；
2. 用 `llm-replay` 的 `replay.override.json`（`packages/test-support/llm-replay`）在该调用后强制注入 `tool/result{error}`，并脚本化两臂完全相同的重试脚本；
3. 特性 ON/OFF 两种 cordis 组合各回放一遍（`installLlmReplay` 驱动真实 agent-loop）；
4. 逐场景对比输出 token 与重试成功布尔值，输出 JSON 摘要（对齐 `examples/jsonrpc-agent/tests/snapshots/*` 的 `result.expected.json` 布局），作为快照断言常驻。

**B. 真模型评测（第五阶段对外数据）**：

- 驱动：`examples/jsonrpc-agent/minimal.py`（`BENCHMARK.md` 唯一指引路径）或 `DeepSeekHarness` SDK；每臂/每任务独立 workspace 与 session-id（BENCHMARK.md 要求）；
- 场景集建议：长 JSON 配置编辑、大批量文件改写、schema 校验失败修正、PTC 程序内子调用失败后重试、**「成功但不符预期」后的重放重试**；
- 每轮结束解析产出 JSONL：聚合「重试步 token 节省 %」「重试成功率」「任务成功率」「注入开销」对比基线（特性关闭、模型全量重生成参数）。
- 报告建议基线目标：重试步输出 token 节省 ≥ 40%；重试成功率不劣于基线；通知条数 = `⌈失败次数/3⌉`（节奏有效性证据）。

> 注：仓库目前**没有**专门 eval 框架（无 swebench/terminal-bench；`python/` 仅为 SDK+runtime，`BENCHMARK.md` 仅指向 `jsonrpc-agent`）。若后续要扩大规模，`llm-replay` 的 keyless A/B 是最贴近现成基建的扩展点。

---

## 7. 风险与待决问题（请评审决策）

1. **四段提示词文案**（附录 B）需人工审阅定稿——特别是「免读直接 edit」的措辞与边界、静态段中目录/软链接约定的详细程度。
2. **checkpoint 目录**：推荐 `<cwd>/.dsh/tool-checkpoints/`（沙箱安全、模型可寻址）；备选 `os.tmpdir()` 全局目录（更贴近「temp」字面，但跨进程清理与模型寻址性稍差）。
3. **通知节奏**：每 3 次失败注入一次（默认，`notifyEveryFailures` 可配）——已按评审采纳，请确认 3 这个默认值。
4. **失败范围/排除名单**：是否保留 `INVALID_ARGS`（建议保留，是主场景）；排除名单 `read/write/edit` 是否合适；成功落盘是否也套用同一排除名单（建议是）。
5. **重放审计**：v1 结果内嵌 `meta`（不新增 session 事件、不改 harness 核心）vs 新增 `tool/replay` 事件类型（更利于评测与 UI 展示，但需改 core/session，违反「不改 harness」约束——建议不做）。
6. **checkpoint 保留策略**：会话结束删除（建议）vs 保留供事后分析；成功后是否即时删除该文件（建议保留到会话结束，否则「成功但想重放」场景落空）。
7. **PTC「免读编辑」风险**：`JSON.stringify` 格式化可能与模型记忆不符 → 选项 (a) 保持「可直接 edit，格式不确定时先 read」的折中措辞（推荐）；(b) 写盘时固定 `JSON.stringify(args, null, 2)` 并在文案中声明序列化规则。
8. **软链接别名**：命名 `latest@<toolName>.json` 是否合适（备选 `previous-<toolName>.json`）；非本地后端（e2b 等）无法建链时的降级策略是否可接受（无别名，失败靠通知、native 靠 callId 拼路径）。
9. **成功调用全量落盘**：是否对所有调用落盘（默认，评审点 5 语义）还是按参数长度阈值（如 ≥64 字符才落盘）以省 I/O。
10. **包名/位置**：`packages/core/tool-retry`（建议）vs `packages/extensions/tool-checkpoint`。
11. **重放的安全语义**：重放走完整管线（审批策略对新参数再次生效）——确认这是期望行为（而非「已批准调用重放免审」）。
12. **写盘/通知失败路径**：写盘失败静默跳过通知（建议）；是否需要可观测的 telemetry 事件（session-telemetry 已有 error 预映射，可扩展）。

---

## 8. 附录 A：代码地图（文件:行号 速查）

**执行管线 / 钩子 / 调用标识**
- `packages/core/tools/src/index.ts`：`tools/pre-execute` :152 · `tools/execute` :163 · `tools/post-execute` :175 · `tools/result` :197 · PostToolDecision :597-600 · ToolExecutionResult :556-580 · ToolExecutionInput :314-338 · ToolRunContext（deferContext/concludeTurn）:404-421 · ToolRuntime.execute :1342 · get :1204 · schemas :1234 · executionMode :1276-1285 · view() 插入 run_code 条件 :1189-1191 · collapses :1324-1326 · 错误码 :469-472 · RUN_CODE_NAME re-export :104
- `packages/core/tools/src/code-mode.ts`：run_code 工具 :292-652 · 子调用 callId `<parent>:code:<n>` :468 · 子调用构造（携带 agent/parent/rootCallId）:469-477 · settle :485-522 · `tool/code-dispatch` 落盘（byte-identical arguments）:508-519 · 嵌套 additionalContexts 经 deferContext 转发 :560-562 · 未捕获抛 CodeRunFailedError :629-632 · ToolCallError 描述符 :617
- `packages/core/tools/src/schema.ts`：defineTool :545-617 · INVALID_ARGS :461-470
- `packages/core/agent-loop/src/tool-calls.ts`：executeToolCalls :59-101 · appendToolCall（原始参数串落盘）:262-264 · appendToolResult :268-289 · additionalContexts → acceptContext :155-156
- `packages/core/agent-loop/src/agent.ts`：preStep（assemble+pre-step 瀑布）:225-243 · step 循环 :332-401 · inbox splice :395-398 · inject :130-132

**系统提示 / 上下文**
- `packages/core/system-prompt/src/index.ts`：Context.systemPrompt :13-38 · AssembleContext :42-50 · PromptSection :53-75（order 约定 :56-60）· PromptContext :78-85 · section() :375-384 · context() :392-401 · assemble() :447-513 · renderContextSections :249-253
- `packages/core/agent-loop/src/runtime-context.ts`：快照投影（仅变更时输出 user 消息）:25-75
- 动态段/通知范例：`packages/sandbox/sandbox-policy/src/index.ts:112-123` · `packages/guard/repeat-tool-reminder/src/index.ts:203-224`（additionalContexts 通知范例）

**fs / 观察策略 / 沙箱**
- `packages/fs/fs/src/index.ts`：Context.fs :44-47 · fs/edit-intent :66 · fs/observed :76 · writeText :222-228 · editText :243-249 · readText :176 · resolve :116 · processPath :126
- `packages/fs/fs-observation-policy/src/index.ts`：ObservedStateGate :21-95 · editIntent 抛 FS_NOT_OBSERVED :78-88 · owner 推导 :36-41；`src/types.ts` FsObservationActor :23-29
- `packages/fs/tool-fs/src/edit.ts`：注册+指引段 :77-81 · 参数 DSL :86-92 · execute（intent+editText+observed）:112-147
- `packages/fs/fs-sandbox/src/index.ts` checkedTarget :126-148 · `packages/sandbox/sandbox/src/roots.ts` writableRoots :52-55

**会话 / 事件**
- `packages/core/session/src/index.ts`：requestContext :691-699 · session/disposed :64；`src/types.ts`：tool/call（callId/name/arguments 原串）:279 · tool/result :291-297 · assistant/message usage :266-273 · request/context :309

**脚手架 / 接线 / 测试范本**
- `packages/fs/fs-observation-policy/package.json`（包不变式范本）· 根 `tsdown.config.ts`（`packages/*/*` 自动纳入）· `pnpm-workspace.yaml`（双级 glob）
- `apps/cli/config/agent-presets/standard/agent.cordis.yml:56-57`（tool-fs 行）· `code/agent.cordis.yml:259-262`（mode: code）
- `packages/fs/tool-fs/tests/tools.spec.ts:38-120`（FakeFs+execute 范本）、:422-471（edit 用例模板）· `packages/fs/tool-fs/tests/harness.ts:15-24` · `packages/test-support/agent-loop-testkit/src/index.ts:37-46`
- `packages/test-support/llm-replay`（keyless A/B 引擎，`replay.override.json`）· `examples/jsonrpc-agent`（BENCHMARK.md 指引的最小基准）· `packages/spill/spill-local/src/store.ts:27-30`（临时目录惯例）

---

## 9. 附录 B：提示词草稿（集中审阅区）

> 全部为**模型可见英文文本**草稿；`<...>` 为运行时填充值。评审意见请直接标注到对应草稿编号。
> 静态段（A/B）写入 system prompt，让 AI 提前知悉机制、目录与 `latest@` 软链接约定；动态通知（C/D）仅在失败且命中节奏（每 3 次失败一次）时注入，给出精确路径。

### A. 静态 system prompt 段 —— native 模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every tool call you make has its arguments checkpointed to a file under
<checkpoint-dir>, whether the call succeeds or fails. You can retry or adjust
any previous call by editing its checkpoint and replaying it:
- After a FAILED call, a notice tells you the exact checkpoint path.
- For any other call (including one that succeeded but produced an unexpected
  result), use the per-tool pointer file latest@<toolName>.json in the same
  directory — it always links to the most recent checkpoint of that tool.
- A checkpoint's content is byte-for-byte identical to the arguments you sent
  for that call, so you can edit it with the `edit` tool directly, WITHOUT
  reading it first.
After editing, call `editPreviousToolCalling` with the checkpoint path (or its
latest@... alias) and the same file_path / old_string / new_string /
replace_all parameters as `edit`: the harness applies your edit, parses the
edited content as the new arguments, and immediately re-invokes the original
tool with them. Use this only when a small correction is needed; otherwise
call the tool again with fresh arguments.
```

### B. 静态 system prompt 段 —— PTC（code）模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every tool call made inside your `run_code` programs has its arguments
checkpointed to a file under <checkpoint-dir>, whether the call succeeds or
fails. You can retry or adjust any previous call from a new program:
- After a FAILED call, a notice tells you the exact checkpoint path.
- For any other call (including one that succeeded but produced an unexpected
  result), use the per-tool pointer file latest@<toolName>.json in the same
  directory — it always links to the most recent checkpoint of that tool.
- A checkpoint's content is the lossless JSON of the argument object you
  passed to that tool, so you can edit it with `tools.edit` directly, without
  reading it first.
To replay: edit the checkpoint (or its latest@... alias), read the edited
file, JSON.parse it, and pass the result to the original tool:
`await tools.<name>(parsed)`. Use this only when a small correction suffices;
otherwise construct fresh arguments.
```

### C. 失败通知（动态注入）—— native 模式

```text
A tool call of yours just failed, and its arguments were saved for replay:
- tool: <name> (call_id <callId>)
- failure: <one-line error summary>
- checkpoint: <path>
The checkpoint contains byte-for-byte the arguments you sent for that call.
To retry with a small correction: edit <path> with the `edit` tool (no need
to read it first), then call `editPreviousToolCalling` with file_path "<path>"
and the same old_string / new_string / replace_all you used in the edit. The
edited content is parsed as the new arguments and the original tool is
re-invoked immediately. If the fix is not a small edit of the previous
arguments, ignore this notice and call the tool again with fresh arguments.
```

### D. 失败通知（动态注入）—— PTC（code）模式

```text
A tool call inside one of your `run_code` programs just failed, and its
arguments were saved for replay:
- tool: <name> (call_id <callId>)
- failure: <one-line error summary>
- checkpoint: <path>
The checkpoint contains the lossless JSON of the argument object you passed
to tools.<name>. To retry in a new `run_code` program: edit <path> with
tools.edit (you may edit without reading it first), read the edited file,
JSON.parse it, and pass the result to tools.<name> again. If the fix is not a
small edit, construct fresh arguments instead.
```

### 评审要点备注

- C/D 中的「failure」取 `result.error.message` 截断（≤200 字符）；「call_id」对 PTC 子调用是 `<parent>:code:<n>` 形式的子调用 id，模型无法自算（仅作展示），是否展示可评审。
- A/C 的「byte-for-byte identical」在 native 下严格成立（落盘即模型发送的原串）；B/D 的「lossless JSON」在 PTC 下成立，但**格式化（空白/键序）依赖模型程序内的构造方式**——「免读直接 edit」存在 old_string 失配风险，两个缓解选项见 §7 决策点 7（评审建议：折中措辞「可直接 edit；不确定格式时先 read」）。
- 静态段（A/B）提到 `latest@<toolName>.json` 与 <checkpoint-dir>（运行时填实际目录），这是模型在无通知情况下定位「刚调用的那个文件」的唯二途径（native 下还可凭 call_id 拼文件名，但软链接更简单，文案中不要求模型拼路径）。
- 四段文案长度约 90-140 token；静态段随 system prompt 常驻，动态通知受「每 3 次失败一次」节奏限制，注入开销有界。
