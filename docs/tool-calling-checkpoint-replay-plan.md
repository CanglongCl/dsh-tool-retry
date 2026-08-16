# DeepSeek-Harness 工具调用优化实施计划（自动暂存 · 局部编辑 · 重放）

> 状态：proposed（待评审）· 版本 v6（按四轮评审：编号命名 + 仅上一步可重试，删除软链接机制）
> 目标仓库：`/Users/canglong/Program/deepseek-harness`（pnpm monorepo，cordis 插件架构）——**本特性为独立插件仓库，不改动 ds harness 仓库任何代码**
> 插件形态参考：`/Users/canglong/Program/limao-magic-ui`（dsh-web-review 独立插件仓库）
> 本文档落盘位置：`docs/tool-calling-checkpoint-replay-plan.md`（本工作区）
> 特性代号：tool-call checkpoint & replay（建议 npm 包名 `@canglongcl/dsh-tool-retry`）

---

## 1. 目标概述

本特性解决 DeepSeek-Harness 在处理**长参数 Tool Calling** 与复杂规划任务时的两类问题：

1. **Token 浪费**：工具调用失败后，模型为了重试通常重新生成整段长参数（例如数百行的 JSON 配置、大批量编辑指令）。
2. **编辑困难**：局部修正一段超长参数时，模型必须整段重写，既慢又容易引入新的不一致。
3. 附加能力：**执行成功的调用同样落盘**——agent 可能需要重放「被标注为成功、但结果不符合预期」的 tool calling。

方案：引入「自动暂存（auto-checkpointing）→ 提示注入（context injection）→ 局部编辑 → 重放（replay）」闭环：

- **每一次模型 tool call block（无论成功或失败）**，Harness 把模型在该 block 下输入的**全部内容**（即整个工具调用的参数字符串）自动落盘到统一管理的临时目录；**PTC 模式下模型的 tool call block 就是 `run_code` 这一个调用，因此落盘的是整个 `run_code` 程序的参数，不落盘程序内部调用的工具**；
- **命名与范围（四轮评审）**：**只保留「上一步」**——checkpoint 文件按模型在自己消息里的调用顺序编号（`1.json`、`2.json`、`3.json`…），上一步的**全部并行 block** 都可重放；新的一步开始暂存时，旧一步的文件被替换删除。**不引入任何软链接/别名文件**（模型知道自己调用的顺序，编号即定位手段）；
- **静态注入**：在 system prompt 中写入该机制说明（目录约定、编号约定、重放工具用法），让 AI 提前知悉「可以修改并重试」；
- **动态注入**：通过 `tools/post-execute` 生命周期钩子，在调用失败后向模型注入提示，告知参数已完整保存在 XX 文件、内容与输入 arg **字节级同构**、可直接编辑后重放；**每次失败都注入**；
- 重放分两种模式：
  - **PTC 模式**（Code Mode / `run_code`，即 UI 中的「PTC 模式」预设）：**不新增工具**——ptc 可以把 fs 的输出直接作为其他工具的输入（读/编辑 checkpoint 后把内容作为新程序或工具参数继续）；
  - **其他模式**（native 标准模式）：新增工具 `editPreviousToolCalling`，签名与内置 `edit` 完全一致，但 instruction 不同、执行流程为「编辑 checkpoint 文件 → 读取编辑后内容作为新 arguments → 以新参数重新 invoke 原工具」。

量化目标（第五阶段评测验证）：失败重试的 token 消耗显著下降（建议基线目标：重试步输出 token 节省 ≥ 40%，见 §6），重试成功率不低于「全量重新生成参数」的基线；暂存/通知的固定开销最小化（单条通知 + 仅一輪文件）。

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
  - **提交顺序 = 模型顺序（编号命名的依据）**：并行调用体可重叠执行，但 `post-execute`（finalize/finish）在 `commitReady` 中按模型顺序逐个提交（`tool-calls.ts:146-160`），因此每轮内 post-execute 的到达顺序与模型消息里 block 的顺序一致，可据此编 1、2、3… 号。
- **code-mode 桥转发嵌套上下文**：`packages/core/tools/src/code-mode.ts:560-562` 把子调用的 `additionalContexts` 经 `exec.deferContext` 转发到外层 `run_code` 结果。⇒ 用 `tools/post-execute` + `additionalContexts` 注入通知，在 **native 与 PTC 两种模式下都成立**，且时序天然位于该次调用的 `tool/result` 之后。

### 2.2 失败判定、tool call block 与调用标识（callId）

- 结果判别式：`ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`，`isError: true/false`：`packages/core/tools/src/index.ts:556-580`
- 预定义错误码：`TOOL_ABORTED = 'ABORTED'`、`TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`：:469-472；不可见工具报 `UNKNOWN_TOOL`（execute 文档 :1332）；参数 schema 校验失败为 `ToolArgsError`（code `INVALID_ARGS`，`schema.ts:461-470`）——**仍然经过 post-execute**，正是「长参数 schema 失败后局部修正重放」的主场景。
- **「tool calling」的落盘口径（二轮评审修正）**：**只落盘模型 tool call block 对应的调用，即模型直调（`exec.parent === undefined`）**——落盘内容是模型在该 block 下输入的**全部内容**（整个工具调用的参数字符串），而不是内部实际派发的工具：
  - native 模式：模型直调 = 每个工具调用，逐个落盘；
  - **PTC 模式：模型唯一的 tool call block 是 `run_code` 这一个调用（code 模式 collapse 只允许模型直调 `run_code`，`collapses` :1324-1326）——落盘的是整个 `run_code` 程序的参数，不落盘 `run_code` 程序内部调用的工具**（内部子调用 `exec.parent` 存在，一律跳过）；
  - 统一规则：`exec.parent === undefined` 才落盘/通知，与模式无关；PTC 下内部子调用被程序捕获的失败**不**触发通知，未捕获导致 `run_code` 整体失败（`code-mode.ts:629-632`）才触发。
- **callId 实证结论（实测本会话日志确认，评审点 6 的最终答案）**：
  - `tool/call` 事件带 `callId`（如本会话实测 `call_00_UIZK3UTd84uighVQ0QPb5398`）：`packages/core/session/src/types.ts:279`；模型历史里的 assistant tool-call block 与 tool/result 的 `toolCallId` 也都带 id（`llm/src/message.ts:234`）——**模型在历史里能看见 id**；
  - **但 id 不是模型输入的内容**：id 来自流式 chunk（`tool-call-delta.id`，`llm/src/types.ts:295`）或 assembler 兜底合成 `call-<index>`（`llm/src/assembler.ts:70,113`）；实测本会话（agentPreset=code）中模型的 `run_code` 参数只有 `{code, description}` 两个键，模型**从不书写 id**，也无法在后续回合可靠复述/复算这个 id；
  - ⇒ **callId 只能用于 harness 内部（映射、审计），不能作为模型定位 checkpoint 的手段**。模型定位只靠两条路径：(a) 失败通知给出的精确文件路径；(b) **编号约定**——上一步第 n 个 block 就是 `<n>.json`（模型知道自己消息里调用的顺序，见 §3.2）。

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

  要点：(a) 必须传 `outcome.version`（写操作返回的版本，作为后续 edit 的 CAS 基准，同 `write.ts:122` 的做法）；(b) actor 必须是本次调用的 `exec`（`undefined` 不记录任何东西）；(c) 观察表以 **Session 对象**为键（同进程同会话内有效——checkpoint 重放正是同进程场景）。
- 沙箱约束（插件直写同样受后端约束）：`SandboxedFileSystem.checkedTarget`（`packages/fs/fs-sandbox/src/index.ts:126-148`）按 `ctx.sandboxPolicy.resolve()` 的部署默认模式拦截；`workspace-write` 下可写根 = workspace root + `/tmp` + `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts:52-55`）；`read-only` 下写盘被拒 → 特性自动降级（不落盘、不通知，仅记日志）。

### 2.5 动态注入时机（二轮评审：每次失败都注入）

- **每次失败都注入通知**（删除 v2 的「每 3 次失败一次」节奏）：`result.isError === true` 且通过排除名单（§3.3）即注入，不设计数、不设节流。
- 该方案不再依赖 tokenizer/tokenMeter/contextWindow 等任何用量口径，实现与测试最简单；通知开销受「单条、短文案、仅失败时」约束。

### 2.6 模式探测（评审点 3：不改 ds harness，仅用公开 API）

- **不新增/不修改任何 ds harness 代码**。探测手段：`ctx.tools.get(RUN_CODE_NAME, agent)` 是否返回可见定义。
  - `RUN_CODE_NAME = 'run_code'` 已从 `@deepseek-ai/dsh-tools` 导出（`code-mode.ts:20`，`index.ts:104` re-export）；
  - `ToolRuntime.get(name, scope?)` 是公开方法（:1204）；`view()` 只在 `modeFor !== 'native'` 时把 `run_code` 插入可见表（:1189-1191）⇒ **get 到 run_code ⇔ 当前 scope 非 native（code 或 both）**；
  - code 与 both 的精确区分无法通过公开 API 获得，也**不需要**：只要 run_code 可见，就下发 PTC 版文案——both 模式下 `run_code` 同样可调用，文案成立。
- 使用位置：(a) 静态 system prompt 段的 `text` 提供函数里，用 `context.scope` 探测并切换 A/B 两版文案；(b) post-execute 监听器里，用 `exec.agent` 探测并选择 C/D 两版通知。

### 2.7 独立插件模式（三轮评审修正：不进 harness monorepo，参照 limao-magic-ui）

- **本特性是独立插件**，参照 `/Users/canglong/Program/limao-magic-ui`（npm 名 `@canglongcl/dsh-web-review` 的 dsh-web-review 插件仓库）的注册与发布模式：
  - **独立仓库**（本工作区 `/Users/canglong/Program/dsh-tool-retry` 即插件仓库），**不向 harness monorepo 添加任何包、不修改 harness 任何文件**；
  - **插件包**：`packages/dsh-tool-retry/package.json`，npm 名 `@canglongcl/dsh-tool-retry`（用户 scope + `publishConfig.access=public`），依赖 harness 的**发布版 npm 包**（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`，版本对齐 `0.1.0-rc.x`，参照 dsh-web-review 的依赖写法），**不使用 workspace 链接**；
  - **注册机制（agent 级插件）**：本插件注册工具、监听 `tools/post-execute`，属于**会话级（agent）组成**，走**用户预设**通道：`agent-presets` 默认自动挂载 DSH home 下的用户预设根 `USER_PRESET_DIR='.agent-presets'`（`packages/preset/agent-presets/src/discovery.ts:41`、`src/index.ts:133-134`）——在 `~/.dsh/.agent-presets/<preset-id>/agent.cordis.yml` 放置「复制自 standard/code + 一行本插件」的预设（两份：native 与 PTC），会话选择该预设即生效；
  - **开发期热迭代**（照搬 dsh-web-review 的链路）：仓库根生成 `cordis.yml`（`- insert:` 覆盖层，引用开发别名如 `@dsh-tool-retry-dev/plugin`）+ `scripts/profile-plugin-link.ts` 把插件包目录 symlink 进 `~/.dsh/profiles/<profile>/node_modules/<dev-alias>/`（参照 limao 的 `materializeProfilePluginLink`，`scripts/profile-plugin-link.ts`），再由 `scripts/dev.ts` 一键启动 harness CLI；
  - **发布**（参照 limao 的 `scripts/package-official.ts`）：staging manifest + `cordis.patch.yml`（`- insert:` 官方包名）+ `pnpm pack`/npm publish；harness 侧 profile 的 bundle patch 机制见 `packages/boot/app-boot/tests/profile.spec.ts:121-124`（`dsh.profile.bundles` → `dsh.bundle.patch` 补丁层按序应用）。注意：bundle patch 是 profile（host）图层的渠道（limao 的 client 插件用它）；**agent 级工具插件的主渠道是用户预设**，bundle patch 仅作为官方安装器的可选辅助。
  - 插件形态本身仍遵循 harness 惯例：导出 `name`/`inject`/`Config`/`apply`，README 带 Model Experience 格式；独立仓库自带 CI（typecheck/lint/test）而非 harness 门禁。

---

## 3. 总体设计

### 3.1 架构总览

```text
模型发出 tool call block（长参数）
   │  native: 每个工具调用是一个 block（按消息内顺序 1,2,3…）；PTC: 唯一 block 是 run_code（整个程序）
   ▼
agent-loop 调度执行（tools/pre-execute → tools/execute → 工具体）
   ▼ 模型直调（exec.parent === undefined；成功或失败，非排除名单）
tools/post-execute 瀑布  ← 本特性监听器（"after-tool-calling"）
   ├─ ① 自动暂存：写 <checkpoint-dir>/<n>.json（n = 该 block 在模型消息中的序号；
   │        提交顺序即模型顺序，编号天然确定；PTC 下即 1.json = 整个 run_code 程序参数）
   │        + ctx.emit('fs/observed', ...) 预观察（免读可直接 edit）
   ├─ ② 仅保留上一步：新一步首条「可暂存直调」到来时，删除旧一步全部文件并重置编号；
   │        （read/edit/editPreviousToolCalling 等排除名单工具不触发替换，模型可先 edit 再重放）
   └─ ③ 每次失败 → 注入通知：返回 next决策 + additionalContexts[createUserMessage(通知)]
   ▼
会话落盘顺序：…tool/result（成功或失败）→（下一步）user/message（通知，每次失败）
   ▼
模型下一步（system prompt 静态段已提前告知机制与编号约定）：
   ├─ native：edit(<通知路径 n.json>) → editPreviousToolCalling(file_path='.../n.json', old, new, ...)
   │            └─ 插件内：内置 edit 机制改文件 → readText → JSON.parse → 嵌套 ctx.tools.execute 重放原工具
   └─ PTC：新 run_code 程序内 tools.read/tools.edit(1.json) → 基于读到的旧程序构造修正后的
              新程序（或提取其中长参数继续），fs 输出直接作为其他工具输入，无需新工具
```

### 3.2 自动暂存（Auto-Checkpointing）——模型 tool call block 的完整内容，成功与失败都落盘，仅保留上一步

| 项 | 设计（默认值，均可配置） |
| --- | --- |
| 触发 | **每一次模型直调（`exec.parent === undefined`）都落盘（成功 + 失败）**——落盘的是模型在该 tool call block 下输入的**全部内容**。native = 每个工具调用；**PTC = 只有 `run_code` 这个调用（整个程序参数）**；内部子调用（`exec.parent` 存在）一律不落盘。排除名单见 §3.3 |
| 目录 | `<session.header.cwd>/.dsh/tool-checkpoints/<sessionId>/`（推荐：位于 workspace 根内，沙箱 `workspace-write` 可写、模型可直接寻址）；备选 `os.tmpdir()` 全局临时目录（spill 惯例 `mkdtempSync(join(tmpdir(),'dsh-checkpoint-'))`，`packages/spill/spill-local/src/store.ts:27-30`）——见 §7 决策点 2 |
| **命名（四轮评审）** | **`<n>.json`**——n = 该 block 在模型上一条消息里的 1-based 序号。模型知道自己的调用顺序，编号即定位手段，**不引入软链接/别名/清单文件**。harness 侧依据：post-execute 按模型顺序提交（§2.1），并行调用体可重叠但提交有序，编号与模型视角一致 |
| 文件内容 | **仅 block 的原始参数字符串，不做任何包装**——统一从本会话 `tool/call` 事件按 `callId` 取 `arguments` 原串（字节级一致；PTC 下即 `run_code` 的完整参数 JSON，含整个程序）。**这是「与输入 arg 完全同构、免重读直接编辑」的前提** |
| **范围/替换（四轮评审新增决策点）** | **只保留「上一步」**：目录内恒为上一步（最近一个有工具调用的 step）的全部 block 文件（含全部并行 block）。新一步首条**可暂存的模型直调**（排除名单不触发）的 post-execute 到达时：删除旧一步全部文件、重置编号，再写入新文件。⇒ 模型看到结果后的下一步里，先 `edit` 再重放不会触发替换（edit 在排除名单）；若模型先调用其他真实工具，旧一步即被替换（符合「仅上一步可重试」语义） |
| **映射** | 插件内存态 `currentRound`：`{ stepKey, entries: [{ ordinal, callId, toolName, fileName }] }`——编号 → 原工具名/callId 的映射（重放工具用），无需落盘清单；进程重启后可从会话日志尾部的 `tool/call` 事件重建（最后一个有工具调用的 step，按事件顺序编号） |
| 写入 | `ctx.fs.writeText(target, raw, undefined, signal)`（无条件原子写，不占 `fs/write-intent` 槽） |
| 预观察 | `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)`（§2.4 已验证的绕过；同步 emit，不得 await） |
| 清理 | `session/disposed`（`core/session/src/index.ts:64`）删除该会话整目录；插件 `ctx.effect` teardown 兜底（HMR 安全）；新一步替换时删除旧文件 |
| 写盘失败 | 静默降级：记日志、跳过通知，**绝不阻断工具管线**（post-execute 监听器必须 try/catch 后仍调用 next()） |

### 3.3 Hook 层（"after-tool-calling" 实现）

- **监听点（评审点 1 已定）**：`ctx.on('tools/post-execute', listener)`（全局注册即可，Scoped 派发按 `exec.agent` 路由；监听器内自行过滤）。
- **必须保持链**：无条件 `await next()` 拿到决策后修改并返回（本插件不占据决策槽，与 fs-observation-policy 那种「不调 next()」的占有式监听不同）。
- **处理对象**：仅**模型直调**（`exec.parent === undefined`）；`exec.agent?.session` 与 `session.header.cwd` 存在。
- **排除名单**（Config 可配，落盘与通知共用；**排除名单内的调用不触发旧轮替换**）：
  - 错误码：`ABORTED`、`ABORTED_BEFORE_DISPATCH`、`UNKNOWN_TOOL`（取消/未知工具没有可重放的参数）；
  - 工具名：`editPreviousToolCalling`、`read`、`write`、`edit`（防自触发递归与 fs 工具噪音；也保证「先 edit 再重放」的流程不被替换逻辑破坏）。
  - **保留 `INVALID_ARGS`**：参数校验失败正是「长参数局部修正重放」的核心场景。
- **流程**：每次模型直调 → 从 `tool/call` 事件取 `(turn, step)` 与 `arguments` 原串 → 若为**新一步**：删除旧一步文件、重置 `currentRound` → 按提交顺序编号 `n`、写 `<n>.json` + 预观察（§3.2）→ 记录映射 → 若 `result.isError` → 注入通知。
- **通知时机（二轮评审已定）**：**每次失败都注入**，无计数、无节流——把通知附加到 `next` 决策的 `additionalContexts`（`createUserMessage`，source `{ kind:'plugin', plugin:'@canglongcl/dsh-tool-retry', form:'notice' }`）。
- **通知文案按模式选择**（§3.4 草稿 C/D；模式经 §2.6 的 run_code 可见性判定）：run_code 可见 → PTC 版；否则 native 版。
- **重放自身失败的行为**：重放调用走完整管线（嵌套子调用，`parent` 存在 → 不会被再次落盘/通知），无递归风险。
- 通知文本中的错误摘要取 `result.error.message` 截断（建议 ≤200 字符，完整错误已在 tool/result 中）。

### 3.4 提示词注入（⚠️ 待审阅草稿，见附录 B 全文）

注入分两层、四个草稿（评审点 4：**两层都必须有**，静态层让 AI 提前知悉机制，动态层给出具体路径）：

| 层 | 位置 | 草稿 | 时机 |
| --- | --- | --- | --- |
| **静态 system prompt 段**（让 AI 提前知悉可修改重试、目录与编号约定、重放工具用法、PTC 下 checkpoint 即整个程序） | `ctx.systemPrompt.section({ name:'tool:checkpoint-replay', order: 149, text: 按 scope 模式动态切换 })`（149 位于工具指引带 100-199 内、SDK 段 150 之前） | A（native）/ B（PTC） | 每次组装，随模式切换 |
| **动态失败通知**（给出本次失败 checkpoint 的精确路径与编号） | post-execute 决策的 `additionalContexts`（每次失败） | C（native）/ D（PTC） | 每次失败 |

四段草稿的共同要点（也是评审重点）：

1. 明确告知「**每次 model tool call block（无论成败）都会暂存**」，且内容即模型在该 block 下输入的全部内容（PTC 下是整个 `run_code` 程序）；成功但结果不符预期同样可重放；
2. 明确告知 checkpoint 内容与上次发送的参数**字节级相同/同构**，因此**无需先 read 即可 edit**（预观察机制已在 §3.2 保证 edit 不会被 `FS_NOT_OBSERVED` 拒绝）；
3. 明确告知定位方式（**只有两条，不给模型任何 id 计算要求**，§2.2）：失败 → 通知给精确路径（含编号）；其他情况 → **编号约定**（上一步第 n 个 block = `<n>.json`，模型知道自己消息里的调用顺序）；文案中**不出现 callId**；
4. 明确「仅在需要小修时使用；否则直接重新调用」，防止模型滥用；并说明**仅上一步可重试**（新一步开始后旧 checkpoint 会被替换）；
5. native 版强调 `editPreviousToolCalling` 与 `edit` 参数完全一致；PTC 版强调 checkpoint 里是**上一次 `run_code` 的整个程序**（`1.json`），重试时用 fs 读/编辑它，基于它构造修正后的新程序（或提取其中长参数继续）。
6. **已知风险（PTC 版）**：程序参数经 `JSON.stringify` 后，模型对其格式化记忆可能不可靠，「免读直接 edit」的 old_string 可能失配。两个缓解选项供评审：见 §7 决策点 8。

### 3.5 重放

#### 3.5.1 PTC 模式（不新增工具）

- checkpoint = **上一步 `run_code` 调用的完整程序参数**（模型 tool call block 的全部内容，即 `1.json`）。失败通知（草稿 D）给出该文件路径。
- 重试流程（不新增任何工具）：模型在新 `run_code` 程序内用 fs 工具处理 checkpoint——`tools.read`/`tools.edit`（checkpoint 已预观察，免先读）读回/修正旧程序，然后**基于读到的内容构造修正后的新程序作为新 `run_code` 调用提交**，或提取其中的长参数片段直接作为 `tools.<name>(parsed)` 的输入。fs 的输出直接作为其他工具的输入，满足「ptc 可以将 fs 作为其他 tool 输入」。
- 无失败通知时（如「成功但想重放」），模型用编号 `1.json` 定位最近一次程序。
- 时序保障：新 `run_code` 的 post-execute 在其程序执行完毕后到达，替换旧文件发生在程序读完之后——程序执行期间 `1.json` 仍是旧程序（§3.2/§3.3 的替换时机）。
- 通知文案（草稿 D）与静态段（草稿 B）承担全部引导职责。
- 失败判定：PTC 下内部子调用失败若被程序 `try/catch ToolCallError` 捕获，**不**构成「tool calling 失败」（不通知）；未捕获导致 `run_code` 整体失败才通知（§2.2）。
- 附：`editPreviousToolCalling` 在 code 模式下仍注册，可从 `run_code` 程序内以 `tools.editPreviousToolCalling(...)` 调用（SDK 暴露除 `run_code` 外的可见工具），对 `run_code` checkpoint 使用时即以编辑后的程序**嵌套执行一次 `run_code`**（§3.5.2 的 `parent: exec.token` 穿透 collapse）——这是可选便捷路径，非 PTC 主路径。

#### 3.5.2 其他模式：`editPreviousToolCalling` 工具

- **签名**：与内置 `edit` **完全一致**——`file_path` / `old_string` / `new_string` / `replace_all`（不引入沙箱升级字段：checkpoint 是 Harness 自有的临时文件，无需模型升级权限）。
- **instruction 不同**：描述为「编辑上一步工具调用的 checkpoint 文件（`<n>.json`）并立即以编辑后内容重新调用原工具」；专属系统指引段 `ctx.systemPrompt.section({ name:'tool:editPreviousToolCalling', order: 103, text })`（紧邻 `tool:edit` 的 102）。
- **file_path = 编号文件**：`<checkpoint-dir>/<n>.json`（通知给的精确路径，或模型按编号约定自己写）。工具从 basename 解析序号 n，经插件 `currentRound` 映射取 `{ toolName, callId }`；**模型不需要理解或构造 callId，也不需要知道工具名映射**。
- **执行流程**（`defineTool` 注册，`execute(args, exec)`）：
  1. 路径校验：`file_path` 解析后的**实际目标**必须位于**本会话**的 checkpoint 目录内，且 basename 匹配 `^(d+).json$`（防越权编辑任意文件）；
  2. 序号 → `currentRound` 映射解析 `toolName`/`callId`；映射缺失（文件已被替换/重启未重建）→ 明确错误结果「该 checkpoint 已失效，请重试最近一步」；
  3. **调用内置 edit 机制**：`ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` + `ctx.fs.editText(...)`（与 `packages/fs/tool-fs/src/edit.ts:124-139` 同一路径；checkpoint 已预观察，策略通过；失败按同款 remediate）；
  4. `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)` 更新观察版本；
  5. `ctx.fs.readText(target)` 读取编辑后内容；
  6. `JSON.parse` → 新 arguments；解析失败 → 错误结果「checkpoint 内容必须保持合法 JSON」；
  7. **嵌套重放**：`ctx.tools.execute({ callId: CallId('<原callId>:replay'), name: toolName, arguments: newArgs, agent: exec.agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal })`；
  8. 结果渲染：成功 → `"Replayed <toolName> with the edited arguments:"` + 重放结果的 content；失败 → 抛错使本工具结果为 `isError: true`（模型可继续修正重试）。
- **关键设计点 `parent: exec.token`**：把重放标记为嵌套子调用——(a) 在 code 模式下（本工具被 `run_code` 程序内调用时）穿透 `UNKNOWN_TOOL` collapse（`collapses` 只拦无 parent 的直调，`tools/index.ts:1324-1326`）；(b) 重放完整走 pre/execute/post/result 管线，审批等策略对新参数再次生效；(c) 重放是嵌套子调用，**不会**被本插件再次落盘/通知。
- **审计日志**：v1 不新增 session 事件类型；重放结果随本工具 `tool/result` 的 content 与 `meta`（`{ replayedCallId, toolName, checkpointPath }`）落盘。可选迭代：新增 `tool/replay` 事件类型（需 core/session schema + UI 卡片，属于改 harness 核心——除非必要否则不做）——见 §7 决策点 6。
- **并发**：不声明 `isConcurrencySafe` → 默认独占执行（`executionMode` 分类 fail-closed，:1276-1285）。

### 3.6 模式探测（评审点 3：仅用公开 API，不改 ds harness）

- 实现即 §2.6：`ctx.tools.get(RUN_CODE_NAME, agent) !== undefined` ⇔ 非 native。静态段 `text` 提供函数用 `context.scope`、通知选择用 `exec.agent` 调用该探测。
- **本特性不包含任何对 `packages/core` / `packages/llm` / `packages/fs` 等 harness 代码的修改**；全部能力在一个独立插件仓库内完成（§2.7）。

### 3.7 插件包与注册/发布（独立插件，参照 dsh-web-review）

- **插件仓库**：本工作区 `/Users/canglong/Program/dsh-tool-retry`，结构参照 `limao-magic-ui`：
  - 根：`package.json`（repo scripts：`gen-config` / `profile-plugin-link` / `dev` / `build` / `package-official` / `test` / `typecheck`）、生成的 `cordis.yml`（`- insert:` 开发别名覆盖层）、`scripts/`（`gen-config.ts`、`development-entry.ts`、`profile-plugin-link.ts`、`dev.ts`、`package-official.ts` 等，照搬 limao 同名脚本模式）；
  - `packages/dsh-tool-retry/`：插件包本体。
- **插件包**（`packages/dsh-tool-retry/package.json`）：
  - `name: '@canglongcl/dsh-tool-retry'`、`publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' }`、`type: module`、`main: lib/index.js`、exports `./package.json`；
  - 依赖（发布版，非 workspace）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`；
  - 插件导出：`export const name = 'tool-retry'`、`export const inject = ['tools', 'fs', 'systemPrompt']`、`export const Config: z<Config>`、`export function apply(ctx, config)`；
  - `Config`：`{ enabled=true, checkpointDir='.dsh/tool-checkpoints', excludeToolNames=['editPreviousToolCalling','read','write','edit'], excludeErrorCodes=['ABORTED','ABORTED_BEFORE_DISPATCH','UNKNOWN_TOOL'] }`。
- **注册（agent 级，不改 harness）**：
  - **用户预设主渠道**：`~/.dsh/.agent-presets/<id>/agent.cordis.yml`（两份：`tool-retry-standard` 与 `tool-retry-code`，即 standard/code 预设的全量拷贝 + 一行 `- id: tool-retry / name: '@canglongcl/dsh-tool-retry'`），会话选择该预设（§2.7）；
  - **开发期**：预设行名用 dev 别名 `@dsh-tool-retry-dev/plugin`，`scripts/profile-plugin-link.ts` 把 `packages/dsh-tool-retry` symlink 进 `~/.dsh/profiles/<profile>/node_modules/@dsh-tool-retry-dev/plugin`，`pnpm dev` 起 harness（照搬 limao `scripts/dev.ts`）；
  - **发布/安装**：`pnpm package:official`（staging + `cordis.patch.yml` insert + `pnpm pack`）→ npm publish `@canglongcl/dsh-tool-retry`；用户安装后预设行名用官方包名。bundle patch（`dsh.bundle.patch`，`packages/boot/app-boot` 的 profile 补丁层机制，`tests/profile.spec.ts:121-124`）作为官方安装器可选辅助，主渠道仍是用户预设。

---

## 4. 实施步骤（五阶段）

### 阶段一：确认上述需要的所有信息 ✅（已完成，成果即本计划 v6）

- 全部代码事实见 §2 与附录 A；遗留决策点清单见 §7，需评审确认后进入阶段二。

### 阶段二：Hook 层开发（独立仓库脚手架 + 先跑通 native 路径）

1. 建独立插件仓库骨架（参照 limao-magic-ui）：根 `package.json` scripts、`scripts/{gen-config,development-entry,profile-plugin-link,dev,harness-path,harness-cli,package-official}.ts`、`packages/dsh-tool-retry/` 插件包（package.json / tsconfig / src/index.ts / src/invariant.ts）。
2. 实现 `tools/post-execute` 监听器：仅模型直调（`exec.parent === undefined`）→ 排除名单过滤 → 从 `tool/call` 事件取 `(turn, step)` 与 `arguments` 原串 → 新一步替换旧文件 + 编号（§3.2/§3.3）→ 写 `<n>.json` + 预观察 → 记录映射 → 每次失败注入通知（§3.3）。
3. `Config` schema 与 `inject` 声明；`apply()` 注册监听与 teardown（HMR 安全）；重启时从会话日志重建映射（§3.2）。
4. 静态段与动态通知先落 native 草稿（附录 B 的 A/C），PTC 版文案阶段三补齐。
5. 用户预设两份（§3.7）+ dev 别名 symlink 链路打通。
6. **验收**：单测通过（§5.1）；keyless 快照跑通「长参数工具失败 → checkpoint 落盘 → 下一步收到通知」最小链路。

### 阶段三：插件开发（重放 + 双模式 + 注册发布）

1. 实现并注册 `editPreviousToolCalling`（§3.5.2，含路径/编号校验、映射解析、内置 edit 复用、嵌套重放）。
2. 模式探测（§2.6/§3.6，仅公开 API）；静态段与通知补 PTC 版文案（附录 B 的 B/D），按 run_code 可见性切换；静态段 order 149、工具指引段 order 103。
3. `pnpm package:official` 打包链路（staging + `cordis.patch.yml`）就绪。
4. **验收**：native 与 code 双模式集成测试通过（§5.2）；「编辑→重放→原工具成功执行」全链路在两种模式下可复现；`run_code` 程序内调用 `tools.editPreviousToolCalling` 亦能穿透 collapse。

### 阶段四：测试与验证

- 完整测试清单见 §5；独立仓库自身 CI：typecheck / lint / unit / 集成；keyless 快照与真实 e2e 纳入仓库脚本。
- **验收**：§5 全部通过；插件包形态符合 harness 惯例（`name`/`inject`/`Config`/`apply` 导出、README Model Experience 格式）。

### 阶段五：评测

- 评测方案见 §6。
- **验收**：离线 A/B 报告（token 节省、重试成功率、开销）+ 真模型评测数据；结论支持/否定目标（§1）。

---

## 5. 测试与验证

1. **插件单测**（模板：`packages/fs/fs-observation-policy/tests/policy.spec.ts` 的 `new Context() + ctx.plugin` 方式）：
   - 模型直调（成功与失败）都触发落盘与预观察；**嵌套子调用（`parent` 存在）不落盘不通知**（PTC 下验证 `run_code` 内部工具调用被跳过、`run_code` 自身整体落盘）；排除名单各分支；`ABORTED`/取消不落盘；
   - 通知：**每次失败都注入**，成功不注入；
   - **编号与替换**：同一 step 内并行调用按模型顺序编号 `1.json`/`2.json`/…（提交顺序 = 模型顺序）；新 step 首条可暂存直调触发旧文件删除与编号重置；**read/edit/editPreviousToolCalling 不触发替换**（先 edit 再重放的流程可用）；重放后旧映射仍可用；
   - 写盘失败/沙箱拒绝 → 不通知、管线不受影响。
2. **工具单测**（模板：`packages/fs/tool-fs/tests/tools.spec.ts:38-120` 的 `FakeFs extends FileSystem` + `ctx.tools.execute`；edit 工具用例模板 :422-471）：
   - `editPreviousToolCalling`：正常编辑+重放成功；编号解析（`2.json` → 第 2 个 block）；`old_string` 失配报错；编辑后内容非法 JSON；`file_path` 越出 checkpoint 目录/非法编号被拒；映射缺失（文件已被替换）报「checkpoint 已失效」；原工具未注册/重放失败透传；`fs/observed` 版本更新。
3. **agent-loop 集成**（`packages/fs/tool-fs/tests/harness.ts:15-24` 的 `fsHarness` + `packages/test-support/agent-loop-testkit` `mountAgentLoopTestDependencies` :37-46，依赖自发布版 npm 包）：真实循环内「成功调用也落盘 → 失败 → 通知 user 消息时序（位于该 tool/result 之后）→ edit+replay → 结果」全链路；**上一步全部并行 block 均落盘且各自可重放**。
4. **code-mode 集成**：`run_code` 调用整体落盘（`1.json` = 完整程序参数）→ 未捕获失败 → 通知；内部子调用失败被捕获 → 不通知；下一步程序内 `tools.read`/`tools.edit` `1.json`（无需先 read，验证预观察生效；程序执行期间 `1.json` 仍为旧程序）→ 基于旧程序重建修正程序；`additionalContexts` 经 `deferContext` 正确转发到外层结果。
5. **keyless 快照/回放**：`packages/test-support/llm-replay` + `replay.override.json` 强制注入失败并脚本化两臂重试；纳入仓库自身 CI（对照 harness `pnpm run test:snapshot` 的用法）。
6. **真实 API e2e**：PTC 与 native 各一例（无 key 自动跳过）。
7. **插件形态合规**：导出形状/HMR disposal/`invariant`/Model Experience README 对齐 harness `packages/AGENTS.md` 惯例（独立仓库自建门禁，不提交进 harness）。

---

## 6. 评测方案（第五阶段）

**指标**（数据源 = session JSONL 权威日志，无需新埋点）：

- 重试步输出 token：`assistant/message.usage.outputTokens`（`packages/core/session/src/types.ts:266-273`），或 `tokenMeter` 的 `tokenUsage` 投影（仅评测读取，特性运行时不依赖）；
- 重试成功率：通知所在下一步内，原工具名（或 `run_code`）再次出现且 `tool/result` 无 `error`（`types.ts:291-297`）；
- 「成功但重放」场景成功率：模型对上一步成功调用发起重放后，重放调用无 `error`；
- 并行覆盖：上一步存在多个并行 block 时，各编号文件齐全且各自可重放；
- 任务成功率：`turn/end.reason` 非 `error`/非 `max-tokens`（`types.ts:146-168`）；
- 开销：checkpoint 写盘耗时与文件量（恒 ≤ 上一步 block 数）、通知注入条数（应恒等于失败次数）。

**A. 离线确定性 A/B（首选，无 API key、可进 CI）**：

1. 语料：构造/采集 `tool/call.arguments` 超长（按字节数阈值筛选）的 `session.jsonl` fixtures（native 与 PTC 各若干，含多并行 block 场景）；
2. 用 `llm-replay` 的 `replay.override.json`（`packages/test-support/llm-replay`）在该调用后强制注入 `tool/result{error}`，并脚本化两臂完全相同的重试脚本；
3. 特性 ON/OFF 两种 cordis 组合各回放一遍（`installLlmReplay` 驱动真实 agent-loop）；
4. 逐场景对比输出 token 与重试成功布尔值，输出 JSON 摘要（对齐 `examples/jsonrpc-agent/tests/snapshots/*` 的 `result.expected.json` 布局），作为快照断言常驻。

**B. 真模型评测（第五阶段对外数据）**：

- 驱动：`examples/jsonrpc-agent/minimal.py`（`BENCHMARK.md` 唯一指引路径）或 `DeepSeekHarness` SDK；每臂/每任务独立 workspace 与 session-id（BENCHMARK.md 要求）；
- 场景集建议：长 JSON 配置编辑、大批量文件改写、schema 校验失败修正、PTC 下 `run_code` 程序失败后的重试（读 `1.json` 重建程序）、**「成功但不符预期」后的重放重试**、**并行多 block 中单个失败的重试**；
- 每轮结束解析产出 JSONL：聚合「重试步 token 节省 %」「重试成功率」「任务成功率」「注入开销」对比基线（特性关闭、模型全量重生成参数）。
- 报告建议基线目标：重试步输出 token 节省 ≥ 40%；重试成功率不劣于基线；通知条数 = 失败次数。

> 注：仓库目前**没有**专门 eval 框架（无 swebench/terminal-bench；`python/` 仅为 SDK+runtime，`BENCHMARK.md` 仅指向 `jsonrpc-agent`）。若后续要扩大规模，`llm-replay` 的 keyless A/B 是最贴近现成基建的扩展点；limao-magic-ui 的 `eval/` 目录（capture/smoke/batch/report）可作为独立插件自建评测套件的范本。

---

## 7. 风险与待决问题（请评审决策）

1. **四段提示词文案**（附录 B）需人工审阅定稿——特别是「免读直接 edit」的措辞与边界、静态段中目录/编号约定的详细程度、PTC 版「checkpoint = 整个程序」的引导方式。
2. **checkpoint 目录**：推荐 `<cwd>/.dsh/tool-checkpoints/`（沙箱安全、模型可寻址）；备选 `os.tmpdir()` 全局目录（更贴近「temp」字面，但跨进程清理与模型寻址性稍差）。
3. **失败范围/排除名单**：是否保留 `INVALID_ARGS`（建议保留，是主场景）；排除名单 `read/write/edit` 是否合适；成功落盘是否也套用同一排除名单（建议是）；**排除名单不触发旧轮替换**（保证先 edit 再重放）是否认可。
4. **【四轮评审新增】可重试范围仅限「上一步」**：只保留上一步（最近一个有工具调用的 step）的全部并行 block（成功+失败），新一步首条可暂存直调到达时替换删除旧文件——请确认该语义；推论：模型若先调用其他真实工具，上一步的 checkpoint 即失效（通知已引导「先 edit 再重放」）。
5. **【四轮评审新增】编号命名 `<n>.json`**：按模型消息内 block 顺序编号（harness 提交顺序 = 模型顺序），**不再使用 latest@ 软链接/别名**（模型知道自己的调用顺序，编号即定位；顺带消除 Windows symlink 权限问题）——请确认。
6. **轮的定义**：编号按 assistant step 的 tool-call 批次（`tool/call` 事件 `(turn, step)`）分组；step 内若存在独占屏障的多组串行调用，编号仍按模型消息内全局顺序 1..N（建议，与模型视角一致）——请确认。
7. **重放审计**：v1 结果内嵌 `meta`（不新增 session 事件、不改 harness 核心）vs 新增 `tool/replay` 事件类型（更利于评测与 UI 展示，但需改 core/session，违反「不改 harness」约束——建议不做）。
8. **checkpoint 保留策略**：新一步替换删除旧文件（既定）；会话结束删除整个目录（建议）vs 保留供事后分析。
9. **PTC「免读编辑」风险**：`JSON.stringify` 格式化可能与模型记忆不符 → 选项 (a) 保持「可直接 edit，格式不确定时先 read」的折中措辞（推荐）；(b) 写盘时固定 `JSON.stringify(args, null, 2)` 并在文案中声明序列化规则。
10. **进程重启后的映射状态**：`currentRound` 映射为内存态，重启后可从会话日志尾部 `tool/call` 事件重建（按最后一步顺序编号）——建议 v1 直接实现重建（实现简单），请确认。
11. **独立插件仓库**：仓库即本工作区 `/Users/canglong/Program/dsh-tool-retry`（参照 limao-magic-ui 布局）；npm 包名 `@canglongcl/dsh-tool-retry`（用户 scope）；注册主渠道 = 用户预设 `~/.dsh/.agent-presets/`（两份：standard/code）——请确认命名与渠道。
12. **重放的安全语义**：重放走完整管线（审批策略对新参数再次生效）——确认这是期望行为（而非「已批准调用重放免审」）。
13. **写盘/通知失败路径**：写盘失败静默跳过通知（建议）；是否需要可观测的 telemetry 事件（session-telemetry 已有 error 预映射，可扩展）。

---

## 8. 附录 A：代码地图（文件:行号 速查）

**执行管线 / 钩子 / 调用标识（harness）**
- `packages/core/tools/src/index.ts`：`tools/pre-execute` :152 · `tools/execute` :163 · `tools/post-execute` :175 · `tools/result` :197 · PostToolDecision :597-600 · ToolExecutionResult :556-580 · ToolExecutionInput（`parent` 字段：嵌套子调用标记）:314-338 · ToolRunContext（deferContext/concludeTurn）:404-421 · ToolRuntime.execute :1342 · get :1204 · schemas :1234 · executionMode :1276-1285 · view() 插入 run_code 条件 :1189-1191 · collapses :1324-1326 · 错误码 :469-472 · RUN_CODE_NAME re-export :104
- `packages/core/tools/src/code-mode.ts`：run_code 工具 :292-652 · 子调用构造（携带 parent）:469-477 · 嵌套 additionalContexts 经 deferContext 转发 :560-562 · 未捕获抛 CodeRunFailedError :629-632
- `packages/core/tools/src/schema.ts`：defineTool :545-617 · INVALID_ARGS :461-470
- `packages/llm/llm/src/assembler.ts`：tool-call id 来自 chunk（:70）或兜底合成（:113）；`llm/src/types.ts`：tool-call-delta 携带 id :295；`llm/src/message.ts`：tool 结果引用 `toolCallId` :234
- `packages/core/agent-loop/src/tool-calls.ts`：executeToolCalls :59-101 · commitReady 按模型顺序提交（编号依据）:146-160 · appendToolCall（原始参数串落盘，含 turn/step）:262-264 · appendToolResult :268-289 · additionalContexts → acceptContext :155-156
- `packages/core/agent-loop/src/agent.ts`：preStep（assemble+pre-step 瀑布）:225-243 · step 循环 :332-401 · inbox splice :395-398 · inject :130-132

**系统提示 / 上下文（harness）**
- `packages/core/system-prompt/src/index.ts`：Context.systemPrompt :13-38 · AssembleContext :42-50 · PromptSection :53-75（order 约定 :56-60）· PromptContext :78-85 · section() :375-384 · context() :392-401 · assemble() :447-513 · renderContextSections :249-253
- `packages/core/agent-loop/src/runtime-context.ts`：快照投影（仅变更时输出 user 消息）:25-75
- 动态段/通知范例：`packages/sandbox/sandbox-policy/src/index.ts:112-123` · `packages/guard/repeat-tool-reminder/src/index.ts:203-224`（additionalContexts 通知范例）

**fs / 观察策略 / 沙箱（harness）**
- `packages/fs/fs/src/index.ts`：Context.fs :44-47 · fs/edit-intent :66 · fs/observed :76 · writeText :222-228 · editText :243-249 · readText :176 · resolve :116
- `packages/fs/fs-observation-policy/src/index.ts`：ObservedStateGate :21-95 · editIntent 抛 FS_NOT_OBSERVED :78-88 · owner 推导 :36-41；`src/types.ts` FsObservationActor :23-29
- `packages/fs/tool-fs/src/edit.ts`：注册+指引段 :77-81 · 参数 DSL :86-92 · execute（intent+editText+observed）:112-147
- `packages/fs/fs-sandbox/src/index.ts` checkedTarget :126-148 · `packages/sandbox/sandbox/src/roots.ts` writableRoots :52-55

**会话 / 事件（harness）**
- `packages/core/session/src/index.ts`：requestContext :691-699 · session/disposed :64；`src/types.ts`：tool/call（turn/step/callId/name/arguments 原串）:279 · tool/result :291-297 · assistant/message usage :266-273 · request/context :309

**独立插件注册 / 发布（harness 侧机制 + limao 范本）**
- `packages/preset/agent-presets/src/discovery.ts:41`（`USER_PRESET_DIR='.agent-presets'`）· `src/index.ts:133-134`（includeUserRoot 自动挂载 `~/.dsh/.agent-presets`）
- `packages/boot/app-boot/tests/profile.spec.ts:121-124`（profile `dsh.profile.bundles` → `dsh.bundle.patch` 补丁层机制）
- limao-magic-ui 范本：`packages/dsh-web-review/package.json`（npm 身份/publishConfig/发布版依赖写法）· `cordis.yml`（`- insert:` 覆盖层）· `scripts/gen-config.ts` · `scripts/development-entry.ts` · `scripts/profile-plugin-link.ts`（materializeProfilePluginLink）· `scripts/package-official.ts` · `scripts/dev.ts` · `eval/`（自建评测套件范本）

**测试范本（harness）**
- `packages/fs/tool-fs/tests/tools.spec.ts:38-120`（FakeFs+execute 范本）、:422-471（edit 用例模板）· `packages/fs/tool-fs/tests/harness.ts:15-24` · `packages/test-support/agent-loop-testkit/src/index.ts:37-46`
- `packages/test-support/llm-replay`（keyless A/B 引擎，`replay.override.json`）· `examples/jsonrpc-agent`（BENCHMARK.md 指引的最小基准）· `packages/spill/spill-local/src/store.ts:27-30`（临时目录惯例）

---

## 9. 附录 B：提示词草稿（集中审阅区）

> 全部为**模型可见英文文本**草稿；`<...>` 为运行时填充值。评审意见请直接标注到对应草稿编号。
> 静态段（A/B）写入 system prompt，让 AI 提前知悉机制、目录与编号约定；动态通知（C/D）**每次失败**注入，给出精确路径与编号。**文案中不出现 callId**（模型不书写 id，见 §2.2 实证）。

### A. 静态 system prompt 段 —— native 模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every tool call you make has its full arguments (everything you wrote in the
tool call block) checkpointed to a file under <checkpoint-dir>, whether the
call succeeds or fails. The files are named by your call order in your
previous message: your 1st call is 1.json, your 2nd call is 2.json, and so
on. Only the previous message's calls are kept — new calls replace them.
- After a FAILED call, a notice tells you the exact checkpoint file.
- Any other call of the previous message (including one that succeeded but
  produced an unexpected result) can be replayed the same way, by its number.
- A checkpoint's content is byte-for-byte identical to the arguments you sent
  for that call, so you can edit it with the `edit` tool directly, WITHOUT
  reading it first.
To retry: edit the checkpoint file, then call `editPreviousToolCalling` with
file_path "<checkpoint-dir>/<n>.json" and the same old_string / new_string /
replace_all you used in the edit — the harness applies your edit, parses the
edited content as the new arguments, and immediately re-invokes the original
tool with them. Use this only when a small correction is needed; otherwise
call the tool again with fresh arguments.
```

### B. 静态 system prompt 段 —— PTC（code）模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every `run_code` call you make — i.e. everything you wrote in your tool call
block, which is the full program — is checkpointed to `<checkpoint-dir>/1.json`
(always 1.json: your previous message has one tool call block), whether it
succeeds or fails. Tools called INSIDE a program are not checkpointed
separately. Only the previous message's program is kept.
- After a FAILED run, a notice tells you the exact checkpoint path.
- To retry: in a new `run_code` program, read the checkpoint with tools.read
  (or fix it in place with tools.edit — the content is exactly the program
  you submitted, so you may edit it without reading it first), then use the
  content to reconstruct your corrected program (or extract long argument
  data from it and pass it to other tools). Use this only when a small
  correction is needed; otherwise write a fresh program.
```

### C. 失败通知（动态注入）—— native 模式

```text
A tool call of yours just failed, and its arguments were saved for replay:
- tool: <name> (the <n>-th call of your previous message)
- failure: <one-line error summary>
- checkpoint: <path to n.json>
The checkpoint contains byte-for-byte the arguments you sent for that call.
To retry with a small correction: edit the checkpoint file with the `edit`
tool (no need to read it first), then call `editPreviousToolCalling` with
file_path "<path>" and the same old_string / new_string / replace_all you
used in the edit. The edited content is parsed as the new arguments and the
original tool is re-invoked immediately. If the fix is not a small edit of
the previous arguments, ignore this notice and call the tool again with
fresh arguments.
```

### D. 失败通知（动态注入）—— PTC（code）模式

```text
Your `run_code` program just failed, and it was saved for replay:
- failure: <one-line error summary>
- checkpoint: <path to 1.json>
The checkpoint contains byte-for-byte the full program you submitted for that
call. To retry with a small correction: in a new `run_code` program, edit
the checkpoint with tools.edit (no need to read it first), then read the
edited file and reconstruct your corrected program from it (or extract the
long argument data you need and pass it to other tools). If the fix is not a
small edit, write a fresh program instead.
```

### 评审要点备注

- C/D 中的「failure」取 `result.error.message` 截断（≤200 字符）；文案**不含 call_id**——模型不书写 id、无法可靠复述（§2.2 实证），展示它只会浪费 token；审计需要的 id 已在 `tool/call`/`tool/result` 事件与重放 `meta` 中落盘。
- 编号约定（四轮评审）：`<n>.json` = 模型上一条消息里第 n 个 tool call block；并行调用也按消息内顺序编号（harness 提交顺序 = 模型顺序，§2.1）。通知同时给出序号与路径，双重定位。
- A/C 的「byte-for-byte identical」在 native 下严格成立（落盘即模型发送的原串）；B/D 在 PTC 下落盘的是 `run_code` 的完整参数 JSON（整个程序），模型对格式化记忆可能不可靠——「免读直接 edit」存在 old_string 失配风险，两个缓解选项见 §7 决策点 9（评审建议：折中措辞「可直接 edit；不确定格式时先 read」）。
- 静态段（A/B）明确「仅上一步可重试、新调用会替换旧文件」，防止模型在过期文件上做无谓编辑。
- 四段文案长度约 90-160 token；静态段随 system prompt 常驻，动态通知每次失败注入（短文案）。
