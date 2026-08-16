# DeepSeek-Harness 工具调用优化实施计划（自动暂存 · 局部编辑 · 重放）

> 状态：proposed（待评审）
> 目标仓库：`/Users/canglong/Program/deepseek-harness`（pnpm monorepo，cordis 插件架构）
> 本文档落盘位置：`docs/tool-calling-checkpoint-replay-plan.md`（本工作区）
> 特性代号：tool-call checkpoint & replay（建议 npm 包名 `@deepseek-ai/dsh-tool-retry`）

---

## 1. 目标概述

本特性解决 DeepSeek-Harness 在处理**长参数 Tool Calling** 与复杂规划任务时的两类问题：

1. **Token 浪费**：工具调用失败后，模型为了重试通常重新生成整段长参数（例如数百行的 JSON 配置、大批量编辑指令）。
2. **编辑困难**：局部修正一段超长参数时，模型必须整段重写，既慢又容易引入新的不一致。

方案：引入「自动暂存（auto-checkpointing）→ 提示注入（context injection）→ 局部编辑 → 重放（replay）」闭环：

- 工具调用失败时，Harness 把该次调用的**原始参数字符串**自动落盘到统一管理的临时目录；
- 通过「after-tool-calling」生命周期钩子在失败后向模型注入一次性系统提示（仅失败时注入，每 20% 上下文最多注入一次），告知：参数已完整保存在 XX 文件，内容与输入 arg **字节级同构**，可直接编辑后重放；
- 重放分两种模式：
  - **PTC 模式**（Code Mode / `run_code`，即 UI 中的「PTC 模式」预设）：**不新增工具**——ptc 可以把 fs 工具的输出直接作为其他工具的输入；
  - **其他模式**（native 标准模式）：新增工具 `editPreviousToolCalling`，签名与内置 `edit` 完全一致，但 instruction 不同、执行流程为「编辑 checkpoint 文件 → 读取编辑后内容作为新 arguments → 以新参数重新 invoke 原工具」。

量化目标（第五阶段评测验证）：失败重试的 token 消耗显著下降（建议基线目标：重试步输出 token 节省 ≥ 40%，见 §6），重试成功率不低于「全量重新生成参数」的基线；暂存/通知的固定开销最小化（节流 + 单次通知）。

---

## 2. 现状调研结论（第一阶段成果）

> 调研结论按「设计决策所依赖的代码事实」组织，全部附文件:行号。代码地图速查表见附录 A。
> 关键澄清：代码库中**不存在**名为 `after-tool-calling` / `ToolCallingHandler` 的符号；其等价物是 `tools/post-execute` 瀑布钩子（详见 §2.1），本计划即以它实现「after-tool-calling」语义。

### 2.1 工具执行管线与生命周期钩子

- 工具注册表服务 `ToolRuntime`（cordis 服务名 `tools`）：`packages/core/tools/src/index.ts`
  - `'tools/pre-execute'`（waterfall，allow/deny/ask）：:152
  - `'tools/execute'`（waterfall，around-dispatch）：:163
  - **`'tools/post-execute'`（waterfall）：:175** —— 接收 `(exec, result, next)`，返回 `PostToolDecision`（`accept`/带 `additionalContexts` 或 `block`，:597-600）。异步、被 await、结果决策有序提交。**这就是「after-tool-calling」钩子**：每一次工具调用（含 code-mode 嵌套子调用）都会经过它，失败结果同样到达（"thrown tools still reach this waterfall as errors"）。
  - `'tools/result'`（emit，冻结最终结果观察点，监听器异常被包含）：:197
  - `ToolRuntime.execute(exec): Promise<ToolExecutionResult>`（公开的程序化调用入口，重放用）：:1342
  - `ToolRuntime.get(name, scope?)`（按 scope 解析可见工具）：:1204；`schemas(scope?)`：:1234
- 循环执行器：`packages/core/agent-loop/src/tool-calls.ts`
  - `appendToolCall` 把模型调用落盘为 `tool/call` 事件，**含原始参数字符串**：:262-264
  - 结果提交后，`result.additionalContexts` 经 `acceptContext` 送入下一步 inbox：:155-156；`agent.ts` 在下一步 preStep 领取并追加为 user 消息：:395-398
- **code-mode 桥转发嵌套上下文**：`packages/core/tools/src/code-mode.ts:560-562` 把子调用的 `additionalContexts` 经 `exec.deferContext` 转发到外层 `run_code` 结果。⇒ 用 `tools/post-execute` + `additionalContexts` 注入通知，在 **native 与 PTC 两种模式下都成立**，且时序天然位于该次失败的 `tool/result` 之后。

### 2.2 失败判定

- 结果判别式：`ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`，`isError: true/false`：`packages/core/tools/src/index.ts:556-580`
- 预定义错误码：`TOOL_ABORTED = 'ABORTED'`、`TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`：:469-472；不可见工具报 `UNKNOWN_TOOL`（execute 文档 :1332）；参数 schema 校验失败为 `ToolArgsError`（code `INVALID_ARGS`，`schema.ts:461-470`）——**仍然经过 post-execute**，正是「长参数 schema 失败后局部修正重放」的主场景。
- 原始参数串的落盘位置（两种模式都拿得到）：
  - native 模型直调：`tool/call` 事件 `{ turn, step, callId, name, arguments: string }`（原始未解析串）：`packages/core/session/src/types.ts:279`
  - code-mode 子调用：`tool/code-dispatch` 事件 `arguments: normalized.logged`（与派发值 byte-identical 的 JSON）：`packages/core/tools/src/code-mode.ts:508-519`；等价于 `JSON.stringify(exec.arguments)`

### 2.3 上下文注入通道

- **首选**：`tools/post-execute` 监听器对失败结果返回 `{ ...next决策, additionalContexts: [通知] }`（失败结果同样支持 `additionalContexts`：`tools/index.ts:575`）。经 2.1 的链路，通知在下一步出现在模型上下文中。
- 备选（fallback）：`tools/result` 监听 + `agent.inject(userMessage)`（`agent.ts:130-132`）。缺点：写盘是异步的而 result 是同步 emit，通知可能先于文件落盘到达模型。仅在 post-execute 方案不可用时采用。
- 静态协议说明：`ctx.systemPrompt.section({ name, order, text })`（`packages/core/system-prompt/src/index.ts:375-384`；`PromptSection` :53-75）。order 约定：-100 harness 身份、0 persona、**100-199 工具指引带**（:56-60）；`text` 支持 `(AssembleContext) => string` 动态函数（可随 scope 切换文案）。工具自带指引段范例：`packages/fs/tool-fs/src/edit.ts:77-81`（order 102）。

### 2.4 fs 观察策略与「免读直接编辑」的绕过

- fs 服务与事件：`packages/fs/fs/src/index.ts` —— `Context.fs` :44-47；`'fs/edit-intent'`（waterfall，单决策槽）:66；`'fs/observed'`（emit，同步记录）:76；`writeText(target, content, expected?, signal?, sandboxPolicy?)` :222-228（**返回 `FsWriteOutcome.version`**）。
- 「edit 必须先 read」的限制来源：`packages/fs/fs-observation-policy` 的 `editIntent` 对无观察记录的目标抛 `FS_NOT_OBSERVED`（`src/index.ts:78-88`）；观察归属由 `actor.agent.session` 推导（:36-41），`FsObservationActor = { agent?: { session?: object } }`（`src/types.ts:23-29`），`ToolExecution` 天然满足该形状。
- **已验证的绕过方案（免改核心）**：插件自己写 checkpoint 后，**同步 emit 一条预观察记录**：

```ts
const target = await ctx.fs.resolve(checkpointPath, { cwd: session.header.cwd })
const outcome = await ctx.fs.writeText(target, rawArgs)        // 无条件原子写（不占用 fs/write-intent 槽）
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

  要点：(a) 必须传 `outcome.version`（写操作返回的版本，作为后续 edit 的 CAS 基准，同 `write.ts:122` 的做法）；(b) actor 必须是失败的 `exec`（`undefined` 不记录任何东西）；(c) 观察表以 **Session 对象**为键（同进程同会话内有效——checkpoint 重放正是同进程场景）；(d) code-mode 子调用的 exec 同样携带 `agent`（`code-mode.ts:474`），**两种模式都适用**。
- 沙箱约束（插件直写同样受后端约束）：`SandboxedFileSystem.checkedTarget`（`packages/fs/fs-sandbox/src/index.ts:126-148`）按 `ctx.sandboxPolicy.resolve()` 的部署默认模式拦截；`workspace-write` 下可写根 = workspace root + `/tmp` + `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts:52-55`）；`read-only` 下写盘被拒 → 特性自动降级（不落盘、不通知，仅记日志）。

### 2.5 上下文用量与「每 20% context 最多注入一次」节流

- 仓库**没有 tokenizer**（无 `estimateTokens`/`countTokens`）。可用口径：
  - 分母（窗口）：`session.requestContext()?.contextWindow`（持久、由日志折叠）：`packages/core/session/src/index.ts:691-699`
  - 分子（用量）：**`ctx.tokenMeter.measure(session).totalTokens`**（重放感知折叠：provider usage 锚定 + 启发式补齐，`CHARS_PER_TOKEN=4`）：`packages/llm/token-meter/src/index.ts:116-147`
  - 时机：`tool/result` 提交时，同一步的 `assistant/message.usage` 已先落盘（`agent.ts:381-390` → `tool-calls.ts:281-288`），两个读数同步可用。
- 唯一百分比先例：compaction 的 `thresholdTokens = Math.floor(contextWindow * 0.8)`（`packages/compaction/compaction-basic/src/config.ts:144`、触发 `src/index.ts:304`）。仓库内**没有**任何 band/配额逻辑可复用。
- **采纳的节流定义（绝对 20% 分带）**：
```ts
band = Math.floor(totalTokens / Math.max(1, Math.floor(window * 0.2)))  // 0..4，超出窗口后 >4
注入条件：band > lastNotifiedBand   // WeakMap<Session, number>，初值 -1；注入后 lastNotifiedBand = band
```
  - 用 `>` 而非 `!==`：压缩（compaction）后用量回退并再次越过已通知带时**不会**重新武装；
  - 节流**只门控模型可见的通知**——checkpoint 落盘不限流（每次失败都落盘，代价极低）；
  - 窗口未知（`contextWindow === undefined`）：降级为「每会话最多注入一次」（布尔旗标，绝不除零）；
  - 进程重启/恢复后 `WeakMap` 归零 → 最多多通知一次，通知幂等，可接受（如需跨恢复精确节流，可在 `session.events` 落一个持久标记事件，留作可选迭代）。

### 2.6 模式探测（native / code(PTC) / both）

- 模式由 `ToolRuntime.modeFor(scope)` 解析，**目前是私有的**（`tools/index.ts:900-911`）；`defaultMode` 亦私有（:816）；没有 `ctx.tools.config` 之类的公开访问器。
- 可用信号：`ctx.tools.schemas(agent).some(s => s.name === 'run_code')` ⇔ 非 native（`view()` 只在 `modeFor !== 'native'` 时插入 `run_code`，:1189-1191）——但**无法区分 code 与 both**。
- 结论：本特性为 `ToolRuntime` 增加公开访问器 `presentationMode(scope?)`（包一层私有 `modeFor`，见 §3.6），以精确选择通知/静态段的文案（code → PTC 版；native → 原生版；both → 两者合述）。

### 2.7 插件包脚手架与 preset 接线（要点）

- 新包位置建议 `packages/core/tool-retry`（npm 名 `@deepseek-ai/dsh-tool-retry`）。脚手架完整清单见附录 A（package.json 不变式、tsconfig 引用、tsdown 自动纳入 `packages/*/*`、`pnpm-workspace.yaml` 双级 glob）。
- preset 是**全量拷贝的 cordis.yml**（非合并）：`apps/cli/config/agent-presets/{standard,code,cordis,minimal}/agent.cordis.yml`；PTC（code）预设 = standard + 一行 `tool-presentation`（`mode: code`，code 版 :259-262）；接线即向 standard 与 code 两个 yml 各加一行插件行（参考 tool-fs 行 standard :56-57）。
- 仓库合规要求（后续 PR 必须满足）：根 `AGENTS.md:122`（非平凡变更必须带 Agent Note，格式 `.agents/notes/proposed/feature/yyyy-mm-dd-<topic>.{md,zh.md,i18n.yaml}`，骨架 `## Problem / ## Proposal / ## Alternatives considered / ## Acceptance criteria / ## Risks`）；`packages/AGENTS.md`（插件导出形状 `name`/`inject`/`Config`/`apply`、HMR disposal 测试、`./invariant`、README 的 Model Experience 格式）；`docs/cookbook/adding-a-package.md` 逐文件清单。

---

## 3. 总体设计

### 3.1 架构总览

```text
模型发出工具调用（长参数）
   │  native: 直调工具；PTC: run_code 程序内 tools.<name>(args)
   ▼
agent-loop 调度执行（tools/pre-execute → tools/execute → 工具体）
   ▼ 失败（isError=true，非排除名单）
tools/post-execute 瀑布  ← 本特性监听器（"after-tool-calling"）
   ├─ ① 自动暂存：写 <checkpoint-dir>/<hash8>-<toolName>.json（原始参数字符串）
   │        + ctx.emit('fs/observed', ...) 预观察（免读可直接 edit）
   ├─ ② 节流判定：band = floor(totalTokens / floor(window*0.2))；band > lastBand 才继续
   └─ ③ 注入通知：返回 next决策 + additionalContexts[createUserMessage(通知)]
   ▼
会话落盘顺序：…tool/result（失败）→（下一步）user/message（通知）
   ▼
模型下一步：
   ├─ native：edit(checkpoint) → editPreviousToolCalling(file_path, old, new, ...)
   │            └─ 插件内：内置 edit 机制改文件 → readText → JSON.parse → 嵌套 ctx.tools.execute 重放原工具
   └─ PTC：新 run_code 程序内 tools.edit(checkpoint) → tools.read → JSON.parse → tools.<name>(fixed)
              （fs 输出直接作为其他工具输入，无需新工具）
```

### 3.2 自动暂存（Auto-Checkpointing）

| 项 | 设计（默认值，均可配置） |
| --- | --- |
| 目录 | `<session.header.cwd>/.dsh/tool-checkpoints/<sessionId>/`（推荐：位于 workspace 根内，沙箱 `workspace-write` 可写、模型可直接寻址）；备选 `os.tmpdir()` 全局临时目录（spill 惯例 `mkdtempSync(join(tmpdir(),'dsh-checkpoint-'))`，`packages/spill/spill-local/src/store.ts:27-30`）——见 §7 决策点 2 |
| 文件名 | `<sha256(callId+toolName) 前 8 位>-<toolName>.json`（文件名自带映射，无需并发易竞态的 index 文件；重放时由文件名解析原工具名） |
| 文件内容 | **仅原始参数字符串，不做任何包装**——native：从本会话 `tool/call` 事件按 `callId` 取 `arguments` 原串（字节级一致）；code-mode 子调用：`JSON.stringify(exec.arguments)`（与 `tool/code-dispatch` 的 byte-identical JSON 一致）。**这是「与输入 arg 完全同构、免重读直接编辑」的前提** |
| 写入 | `ctx.fs.writeText(target, raw, undefined, signal)`（无条件原子写，不占 `fs/write-intent` 槽） |
| 预观察 | `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)`（§2.4 已验证的绕过；同步 emit，不得 await） |
| 容量 | 每会话保留最近 N=64 个，超出按 mtime 淘汰最旧 |
| 清理 | `session/disposed`（`core/session/src/index.ts:64`）删除该会话整目录；插件 `ctx.effect` teardown 兜底（HMR 安全） |
| 写盘失败 | 静默降级：记日志、跳过通知，**绝不阻断工具管线**（post-execute 监听器必须 try/catch 后仍调用 next()） |

### 3.3 Hook 层（"after-tool-calling" 实现）

- **监听点**：`ctx.on('tools/post-execute', listener)`（全局注册即可，Scoped 派发按 `exec.agent` 路由；监听器内自行过滤）。
- **必须保持链**：无条件 `await next()` 拿到决策后修改并返回（本插件不占据决策槽，与 fs-observation-policy 那种「不调 next()」的占有式监听不同）。
- **触发条件**：`result.isError === true` 且 `exec.agent?.session` 与 `session.header.cwd` 存在。
- **排除名单**（Config 可配）：
  - 错误码：`ABORTED`、`ABORTED_BEFORE_DISPATCH`、`UNKNOWN_TOOL`（取消/未知工具没有可重放的参数）；
  - 工具名：`editPreviousToolCalling`、`read`、`write`、`edit`（防自触发递归与 fs 工具噪音）。
  - **保留 `INVALID_ARGS`**：参数校验失败正是「长参数局部修正重放」的核心场景。
- **流程**：取原始参数串 → 写 checkpoint + 预观察（§3.2）→ 节流判定（§2.5）→ 通过则把通知附加到 `next` 决策的 `additionalContexts`（`createUserMessage`，source `{ kind:'plugin', plugin:'@deepseek-ai/dsh-tool-retry', form:'notice' }`）。
- **通知文案按模式选择**（§3.4 草稿 C/D；模式经 §3.6 的 `presentationMode` 判定）：code → PTC 版；native → 原生版；both → 两版合述。
- **重放自身失败的行为**：重放调用走完整管线（嵌套子调用），其失败也会再次触发本监听器——修正后的参数成为新一轮 checkpoint（通知受节流保护，次数有界）。这是期望行为，保留。
- 通知文本中的错误摘要取 `result.error.message` 截断（建议 ≤200 字符，完整错误已在 tool/result 中）。

### 3.4 提示词注入（⚠️ 待审阅草稿，见附录 B 全文）

注入分两层，共四段文案：

| 层 | 位置 | 草稿 | 时机 |
| --- | --- | --- | --- |
| 静态 system prompt 段 | `ctx.systemPrompt.section({ name:'tool:checkpoint-replay', order: 149, text: 按 scope 模式动态切换 })`（149 位于工具指引带 100-199 内、SDK 段 150 之前） | A（native）/ B（PTC） | 每次组装，随模式切换 |
| 动态失败通知 | post-execute 决策的 `additionalContexts`（仅失败 + 节流通过） | C（native）/ D（PTC） | 每 20% 上下文带最多一次 |

四段草稿的共同要点（也是评审重点）：

1. 明确告知「checkpoint 内容与上次发送的参数**字节级相同/同构**」，因此**无需先 read 即可 edit**（预观察机制已在 §3.2 保证 edit 不会被 `FS_NOT_OBSERVED` 拒绝）；
2. 明确「仅在需要小修时使用；否则直接重新调用」，防止模型滥用；
3. native 版强调 `editPreviousToolCalling` 与 `edit` 参数完全一致；
4. PTC 版强调在 `run_code` 程序内用 fs 工具完成编辑、读取、解析、重放（`tools.edit` 输出 → 读取 → `JSON.parse` → `tools.<name>(parsed)`）。
5. **已知风险（PTC 版）**：程序内构造的对象经 `JSON.stringify` 后，模型对其格式化记忆可能不可靠，「免读直接 edit」的 old_string 可能失配。两个缓解选项供评审：见 §7 决策点 7。

### 3.5 重放

#### 3.5.1 PTC 模式（不新增工具）

- 复用现有 `run_code` + fs 工具即可：模型在新程序里 `tools.edit`（checkpoint 已预观察，免先读）→ `tools.read` → `JSON.parse` → `tools.<name>(parsed)`。fs 的输出直接作为其他工具的输入，满足「ptc 可以将 fs 作为其他 tool 输入」。
- 不新增任何工具；通知文案（草稿 D）承担全部引导职责。
- 注意：PTC 下子调用失败时，外层 `run_code` 只有未捕获才整体失败（模型可 `try/catch ToolCallError` 就地恢复）；子调用的失败**独立**经过 `tools/post-execute`/`tools/result`，因此本特性的 checkpoint + 通知在「程序崩溃后的下一步重试」场景仍然有效（通知经 `deferContext` 转发，§2.1）。

#### 3.5.2 其他模式：`editPreviousToolCalling` 工具

- **签名**：与内置 `edit` **完全一致**——`file_path` / `old_string` / `new_string` / `replace_all`（不引入沙箱升级字段：checkpoint 是 Harness 自有的临时文件，无需模型升级权限）。
- **instruction 不同**：描述为「编辑上一次失败工具调用的 checkpoint 文件并立即以编辑后内容重新调用原工具」；专属系统指引段 `ctx.systemPrompt.section({ name:'tool:editPreviousToolCalling', order: 103, text })`（紧邻 `tool:edit` 的 102）。
- **执行流程**（`defineTool` 注册，`execute(args, exec)`）：
  1. 路径校验：`file_path` 解析后必须位于**本会话**的 checkpoint 目录内（防越权编辑任意文件）；
  2. 从文件名解析原工具名（`<hash8>-<toolName>.json`），缺失/非法 → 明确错误结果；
  3. **调用内置 edit 机制**：`ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` + `ctx.fs.editText(...)`（与 `packages/fs/tool-fs/src/edit.ts:124-139` 同一路径；checkpoint 已预观察，策略通过；失败按同款 remediate）；
  4. `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)` 更新观察版本；
  5. `ctx.fs.readText(target)` 读取编辑后内容；
  6. `JSON.parse` → 新 arguments；解析失败 → 错误结果「checkpoint 内容必须保持合法 JSON」；
  7. **嵌套重放**：`ctx.tools.execute({ callId: CallId(`${原callId}:replay`), name: toolName, arguments: newArgs, agent: exec.agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal })`；
  8. 结果渲染：成功 → `"Replayed <toolName> with the edited arguments:"` + 重放结果的 content；失败 → 抛错使本工具结果为 `isError: true`（模型可继续修正重试）。
- **关键设计点 `parent: exec.token`**：把重放标记为嵌套子调用——(a) 在 code 模式下（本工具被 `run_code` 程序内调用时）穿透 `UNKNOWN_TOOL` collapse（`collapses` 只拦无 parent 的直调，`tools/index.ts:1324-1326`）；(b) 重放完整走 pre/execute/post/result 管线，审批等策略对新参数再次生效。
- **审计日志**：v1 不新增 session 事件类型；重放结果随本工具 `tool/result` 的 content 与 `meta`（`{ replayedCallId, toolName, checkpointPath }`）落盘。可选迭代：新增 `tool/replay` 事件类型（需 core/session schema + UI 卡片）——见 §7 决策点 5。
- **并发**：不声明 `isConcurrencySafe` → 默认独占执行（`executionMode` 分类 fail-closed，:1276-1285）。

### 3.6 模式探测访问器（core/tools 小改）

- `ToolRuntime` 新增公开方法 `presentationMode(scope?: ScopeKey): ToolPresentationMode`，即私有 `modeFor`（:900-911）的公开薄封装。本特性用它选择通知/静态段文案（native / code / both 三态精确判定）；也顺带填补了仓库「模式不可公开观测」的空缺。
- 改动面极小（一个方法 + JSDoc + 单测），与特性同 PR 提交。

### 3.7 新插件包与 preset 接线

- **新包**：`packages/core/tool-retry`，npm 名 `@deepseek-ai/dsh-tool-retry`。
  - 插件导出：`export const name = 'tool-retry'`、`export const inject = ['tools', 'fs', 'systemPrompt']`（tokenMeter 用 `ctx.inject(['tokenMeter'], ...)` 可选注入，缺失时节流降级 §2.5）、`export const Config: z<Config>`、`export function apply(ctx, config)`。
  - `Config`：`{ enabled=true, checkpointDir='.dsh/tool-checkpoints', notifyBandRatio=0.2, maxCheckpoints=64, excludeToolNames=['editPreviousToolCalling','read','write','edit'], excludeErrorCodes=['ABORTED','ABORTED_BEFORE_DISPATCH','UNKNOWN_TOOL'] }`。
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

### 阶段一：确认上述需要的所有信息 ✅（已完成，成果即本计划）

- 全部代码事实见 §2 与附录 A；遗留决策点清单见 §7，需评审确认后进入阶段二。

### 阶段二：Hook 层开发（先跑通 native 路径）

1. 建包 `packages/core/tool-retry`（package.json / tsconfig.json / src/index.ts / src/invariant.ts，按附录 A 脚手架清单）。
2. 实现 `tools/post-execute` 监听器：失败过滤与排除名单 → 原始参数串提取（`session.events` 中 `tool/call` 按 `callId` 查找）→ checkpoint 写盘 + 预观察（§3.2）→ 节流判定（§2.5，`WeakMap<Session, number>`）→ 通知附加（§3.3）。
3. `Config` schema 与 `inject` 声明；`apply()` 注册监听与 teardown（HMR 安全）。
4. 静态段与动态通知先落 native 草稿（附录 B 的 A/C），PTC 版文案阶段三补齐。
5. **验收**：单测通过（§5.1）；keyless 快照跑通「长参数工具失败 → checkpoint 落盘 → 下一步收到通知」最小链路。

### 阶段三：插件开发（重放 + 双模式 + 接线）

1. core/tools 小改：`ToolRuntime.presentationMode()` 公开访问器 + 单测（§3.6）。
2. 实现并注册 `editPreviousToolCalling`（§3.5.2，含路径校验、内置 edit 复用、嵌套重放）。
3. 静态段与通知补 PTC 版文案（附录 B 的 B/D），按 `presentationMode` 切换；静态段 order 149、工具指引段 order 103。
4. preset 接线（standard + code 两个 yml，§3.7）。
5. **验收**：native 与 code 双模式集成测试通过（§5.2）；「编辑→重放→原工具成功执行」全链路在两种模式下可复现；`run_code` 程序内调用 `tools.editPreviousToolCalling` 亦能穿透 collapse。

### 阶段四：测试与验证

- 完整测试清单见 §5；快照与 e2e 纳入仓库门禁（`test:snapshot` / `test:e2e`）。
- **验收**：§5 全部通过；AGENTS/packages-AGENTS 合规检查通过（`doc-sync` / `constraints` / `typecheck` / `lint` / `build` / `hygiene`）。

### 阶段五：评测

- 评测方案见 §6。
- **验收**：离线 A/B 报告（token 节省、重试成功率、开销）+ 真模型评测数据；结论支持/否定目标（§1）。

---

## 5. 测试与验证

1. **插件单测**（模板：`packages/fs/fs-observation-policy/tests/policy.spec.ts` 的 `new Context() + ctx.plugin` 方式）：
   - 失败触发落盘与预观察；排除名单各分支；`ABORTED`/取消不落盘；
   - 节流：同 band 内第二次失败不注入、跨 band 注入一次、窗口未知降级、压缩回退不重放武装；
   - 写盘失败/沙箱拒绝 → 不通知、管线不受影响。
2. **工具单测**（模板：`packages/fs/tool-fs/tests/tools.spec.ts:38-120` 的 `FakeFs extends FileSystem` + `ctx.tools.execute`；edit 工具用例模板 :422-471）：
   - `editPreviousToolCalling`：正常编辑+重放成功；`old_string` 失配报错；编辑后内容非法 JSON；`file_path` 越出 checkpoint 目录被拒；原工具未注册/重放失败透传；`fs/observed` 版本更新。
3. **agent-loop 集成**（`packages/fs/tool-fs/tests/harness.ts:15-24` 的 `fsHarness` + `packages/test-support/agent-loop-testkit` `mountAgentLoopTestDependencies` :37-46）：真实循环内「失败 → 通知 user 消息时序（位于该 tool/result 之后）→ edit+replay → 结果」全链路。
4. **code-mode 集成**：`run_code` 子调用失败 → checkpoint 内容 = byte-identical JSON → 下一步程序内 `tools.edit`（无需先 read，验证预观察生效）→ 重放成功；`additionalContexts` 经 `deferContext` 正确转发到外层结果。
5. **keyless 快照/回放**：`packages/test-support/llm-replay` + `replay.override.json` 强制注入失败并脚本化两臂重试；纳入 `pnpm run test:snapshot`。
6. **真实 API e2e**：`test:e2e`（无 key 自动跳过）；PTC 与 native 各一例。
7. **合规**：根 AGENTS.md（Agent Note 三语三元组随 PR）、packages/AGENTS.md（导出形状/HMR disposal/`invariant`/Model Experience README）、`docs/cookbook/adding-a-package.md` 逐项清单、`verify-translation-pairing`。

---

## 6. 评测方案（第五阶段）

**指标**（数据源 = session JSONL 权威日志，无需新埋点）：

- 重试步输出 token：`assistant/message.usage.outputTokens`（`packages/core/session/src/types.ts:266-273`），或 `tokenMeter` 的 `tokenUsage` 投影；
- 重试成功率：通知所在下一步内，原工具名再次出现且 `tool/result` 无 `error`（`types.ts:291-297`）；
- 任务成功率：`turn/end.reason` 非 `error`/非 `max-tokens`（`types.ts:146-168`）；
- 开销：checkpoint 写盘耗时、通知注入条数与字节数。

**A. 离线确定性 A/B（首选，无 API key、可进 CI）**：

1. 语料：构造/采集 `tool/call.arguments` 超长（按字节数阈值筛选）的 `session.jsonl` fixtures；
2. 用 `llm-replay` 的 `replay.override.json`（`packages/test-support/llm-replay`）在该调用后强制注入 `tool/result{error}`，并脚本化两臂完全相同的重试脚本；
3. 特性 ON/OFF 两种 cordis 组合各回放一遍（`installLlmReplay` 驱动真实 agent-loop）；
4. 逐场景对比输出 token 与重试成功布尔值，输出 JSON 摘要（对齐 `examples/jsonrpc-agent/tests/snapshots/*` 的 `result.expected.json` 布局），作为快照断言常驻。

**B. 真模型评测（第五阶段对外数据）**：

- 驱动：`examples/jsonrpc-agent/minimal.py`（`BENCHMARK.md` 唯一指引路径）或 `DeepSeekHarness` SDK；每臂/每任务独立 workspace 与 session-id（BENCHMARK.md 要求）；
- 场景集建议：长 JSON 配置编辑、大批量文件改写、schema 校验失败修正、PTC 程序内子调用失败后重试；
- 每轮结束解析产出 JSONL：聚合「重试步 token 节省 %」「重试成功率」「任务成功率」「注入开销」对比基线（特性关闭、模型全量重生成参数）。
- 报告建议基线目标：重试步输出 token 节省 ≥ 40%；重试成功率不劣于基线；每 20% 上下文带内注入次数 ≤ 1（节流有效性证据）。

> 注：仓库目前**没有**专门 eval 框架（无 swebench/terminal-bench；`python/` 仅为 SDK+runtime，`BENCHMARK.md` 仅指向 `jsonrpc-agent`）。若后续要扩大规模，`llm-replay` 的 keyless A/B 是最贴近现成基建的扩展点。

---

## 7. 风险与待决问题（请评审决策）

1. **四段提示词文案**（附录 B）需人工审阅定稿——特别是「免读直接 edit」的措辞与边界。
2. **checkpoint 目录**：推荐 `<cwd>/.dsh/tool-checkpoints/`（沙箱安全、模型可寻址）；备选 `os.tmpdir()` 全局目录（更贴近「temp」字面，但跨进程清理与模型寻址性稍差）。
3. **节流语义**：已采纳「绝对 20% 分带」（§2.5）；备选「距上次注入每消耗 20% 窗口最多一次」。
4. **失败范围**：是否保留 `INVALID_ARGS`（建议保留，是主场景）；排除名单 `read/write/edit` 是否合适；`both` 模式下通知文案合并方式。
5. **重放审计**：v1 结果内嵌 `meta`（不新增 session 事件）vs 新增 `tool/replay` 事件类型（更利于评测与 UI 展示，改动面更大）。
6. **checkpoint 保留策略**：会话结束删除（建议）vs 保留供事后分析；成功后是否即时删除该文件。
7. **PTC「免读编辑」风险**：`JSON.stringify` 格式化可能与模型记忆不符 → 选项 (a) 保持「可直接 edit，格式不确定时先 read」的折中措辞（推荐）；(b) 写盘时固定 `JSON.stringify(args, null, 2)` 并在文案中声明序列化规则。
8. **tokenMeter 缺失时**节流降级为「每会话一次」是否可接受（标准预设下 tokenMeter 恒在，实际影响面很小）。
9. **包名/位置**：`packages/core/tool-retry`（建议）vs `packages/extensions/tool-checkpoint`。
10. **`presentationMode()` 公开访问器**是否纳入本特性范围（建议纳入，否则 both 模式文案有歧义）。
11. **重放的安全语义**：重放走完整管线（审批策略对新参数再次生效）——确认这是期望行为（而非「已批准调用重放免审」）。
12. **checkpoint 写盘与通知的失败路径**：写盘失败静默跳过通知（建议）；是否需要可观测的 telemetry 事件（session-telemetry 已有 error 预映射，可扩展）。

---

## 8. 附录 A：代码地图（文件:行号 速查）

**执行管线 / 钩子**
- `packages/core/tools/src/index.ts`：`tools/pre-execute` :152 · `tools/execute` :163 · `tools/post-execute` :175 · `tools/result` :197 · PostToolDecision :597-600 · ToolExecutionResult :556-580 · ToolExecutionInput :314-338 · ToolRunContext（deferContext/concludeTurn）:404-421 · ToolRuntime.execute :1342 · get :1204 · schemas :1234 · executionMode :1276-1285 · modeFor（私有）:900-911 · view() 插入 run_code 条件 :1189-1191 · collapses :1324-1326 · 错误码 :469-472
- `packages/core/tools/src/code-mode.ts`：run_code 工具 :292-652 · 子调用构造（携带 agent/parent/rootCallId）:469-477 · settle :485-522 · `tool/code-dispatch` 落盘（byte-identical arguments）:508-519 · 嵌套 additionalContexts 经 deferContext 转发 :560-562 · 未捕获抛 CodeRunFailedError :629-632 · ToolCallError 描述符 :617
- `packages/core/tools/src/schema.ts`：defineTool :545-617 · INVALID_ARGS :461-470
- `packages/core/agent-loop/src/tool-calls.ts`：executeToolCalls :59-101 · appendToolCall（原始参数串落盘）:262-264 · appendToolResult :268-289 · additionalContexts → acceptContext :155-156
- `packages/core/agent-loop/src/agent.ts`：preStep（assemble+pre-step 瀑布）:225-243 · step 循环 :332-401 · inbox splice :395-398 · inject :130-132 · buildRequest（contextWindow→request/context）:407-495

**系统提示 / 上下文**
- `packages/core/system-prompt/src/index.ts`：Context.systemPrompt :13-38 · AssembleContext :42-50 · PromptSection :53-75（order 约定 :56-60）· PromptContext :78-85 · section() :375-384 · context() :392-401 · assemble() :447-513 · renderContextSections :249-253
- `packages/core/agent-loop/src/runtime-context.ts`：快照投影（仅变更时输出 user 消息）:25-75
- 动态段范例：`packages/sandbox/sandbox-policy/src/index.ts:112-123` · `packages/guard/repeat-tool-reminder/src/index.ts:203-224`（additionalContexts 通知范例）

**fs / 观察策略 / 沙箱**
- `packages/fs/fs/src/index.ts`：Context.fs :44-47 · fs/edit-intent :66 · fs/observed :76 · writeText :222-228 · editText :243-249 · readText :176 · resolve :116
- `packages/fs/fs-observation-policy/src/index.ts`：ObservedStateGate :21-95 · editIntent 抛 FS_NOT_OBSERVED :78-88 · owner 推导 :36-41；`src/types.ts` FsObservationActor :23-29
- `packages/fs/tool-fs/src/edit.ts`：注册+指引段 :77-81 · 参数 DSL :86-92 · execute（intent+editText+observed）:112-147
- `packages/fs/fs-sandbox/src/index.ts` checkedTarget :126-148 · `packages/sandbox/sandbox/src/roots.ts` writableRoots :52-55

**用量 / 节流 / 会话**
- `packages/llm/token-meter/src/index.ts`：measure :116-147 · estimate.ts 常量 :13-19
- `packages/core/session/src/index.ts`：requestContext :691-699 · session/disposed :64；`src/types.ts`：tool/call :279 · tool/result :291-297 · assistant/message usage :266-273 · request/context :309
- `packages/compaction/compaction-basic/src/config.ts:144`、`src/index.ts:304`（百分比先例）

**脚手架 / 接线 / 测试范本**
- `packages/fs/fs-observation-policy/package.json`（包不变式范本）· 根 `tsdown.config.ts`（`packages/*/*` 自动纳入）· `pnpm-workspace.yaml`（双级 glob）
- `apps/cli/config/agent-presets/standard/agent.cordis.yml:56-57`（tool-fs 行）· `code/agent.cordis.yml:259-262`（mode: code）· `packages/core/agent-tool-presentation/src/index.ts:59-71`（presentAs）
- `packages/fs/tool-fs/tests/tools.spec.ts:38-120`（FakeFs+execute 范本）、:422-471（edit 用例模板）· `packages/fs/tool-fs/tests/harness.ts:15-24` · `packages/test-support/agent-loop-testkit/src/index.ts:37-46`
- `packages/test-support/llm-replay`（keyless A/B 引擎，`replay.override.json`）· `examples/jsonrpc-agent`（BENCHMARK.md 指引的最小基准）

---

## 9. 附录 B：提示词草稿（集中审阅区）

> 全部为**模型可见英文文本**草稿；`<...>` 为运行时填充值。评审意见请直接标注到对应草稿编号。

### A. 静态 system prompt 段 —— native 模式

```text
TOOL-CALL CHECKPOINT & REPLAY
When one of your tool calls fails, the harness saves the failed call's exact
arguments to a checkpoint file and tells you the path and the original tool
name. The checkpoint content is byte-for-byte identical to the arguments you
sent for that call, so you can edit it with the `edit` tool directly, WITHOUT
reading it first. After the edit, call `editPreviousToolCalling` with the same
file_path / old_string / new_string / replace_all parameters as `edit`: the
harness applies your edit to the checkpoint, parses the edited content as the
new arguments, and immediately re-invokes the original tool with them. Use
this only when a small correction to the previous arguments is needed;
otherwise call the original tool again with fresh arguments.
```

### B. 静态 system prompt 段 —— PTC（code）模式

```text
TOOL-CALL CHECKPOINT & REPLAY
When a tool call inside one of your `run_code` programs fails, the harness
saves that call's exact arguments to a checkpoint file and tells you the path
and the tool name. The checkpoint content is the lossless JSON of the argument
object you passed to that tool. To retry inside a new `run_code` program, use
the fs tools: edit the checkpoint with `tools.edit` (you may edit without
reading it first — the content is exactly the arguments you passed), read the
edited file, JSON.parse it, and pass the result to the original tool:
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

- C/D 中的「failure」取 `result.error.message` 截断（≤200 字符）；「call_id」对 PTC 子调用是 `<parent>:code:<n>` 形式的子调用 id，是否展示给模型可见仁见智，可评审。
- A/C 的「byte-for-byte identical」在 native 下严格成立（落盘即模型发送的原串）；B/D 的「lossless JSON」在 PTC 下成立，但**格式化（空白/键序）依赖模型程序内的构造方式**——「免读直接 edit」存在 old_string 失配风险，两个缓解选项见 §7 决策点 7（评审建议：折中措辞「可直接 edit；不确定格式时先 read」）。
- 四段文案长度约 90-120 token/次，配合 §2.5 的 20% 分带节流，注入开销有界。
