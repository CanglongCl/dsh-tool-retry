# DeepSeek-Harness 工具调用优化实施计划（自动暂存 · 局部编辑 · 重放）

> 状态：proposed（待评审）· 版本 v12（按十轮评审：失败通知极简化——只告知「已保存 + id + 用法」，不重复失败原因）
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

- **每一次模型 tool call block（无论成功或失败）**，Harness 把模型在该 block 下输入的**全部内容**（即整个工具调用的参数字符串）自动落盘到统一管理的临时目录（`<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/`）；**native 与 PTC 的逻辑完全一致**——都只落盘模型直调（`exec.parent === undefined`）；PTC 下模型唯一的直调是 `run_code`（落整个程序参数），**程序内部调用的工具（含嵌套 run_code）一律不落盘**；两种模式只是提示词文案不同；
- 落盘分**两种 access 方式 + 一个索引**（六轮评审定稿）：
  1. **id 文件（唯一真实存储）**：每次直调按 callId 落 `<id>.json`，会话内不覆盖——失败通知注入 id，模型可对同一调用做**多次重试**；
  2. **顺序 id（编号别名，相当于软链接/快捷方式）**：上一步的全部并行 block 按模型消息内顺序暴露为 `previous/1.json`、`previous/2.json`…，**软链指向对应 id 文件**（Windows 无权限降级为副本，见 §3.2），新一轮**重建**别名指向新调用的 id 文件（最常用路径）；
  3. **`history.jsonl`**：每次直调 append 一行索引，模型可用 `tail` 读最后几条来确定要重放哪一个；
- **使用矩阵（七轮评审）**：修改**上一个**调用（无论成败，路径相同）→ 顺序 id 别名（`previous/1.json`/`previous/2.json`…）；修改**更早**的调用 → id——失败调用的 id 在它失败时的通知里注入过（模型在 context 中可见，可直接用），也可查 `history.jsonl`；成功调用的 id 只能查 `history.jsonl`；
- **静态注入**：在 system prompt 中写入该机制说明（目录、编号约定、id/jsonl 约定、重放工具用法），让 AI 提前知悉「可以修改并重试」；
- **动态注入**：通过 `tools/post-execute` 生命周期钩子，在调用失败后向模型注入**极简提示**——只写「已保存 + 调用 id（+ 上一步序号）+ 用 `editPreviousToolCalling` 重放」三件事，不做其他解释（失败原因由 harness 的 tool/result 自行返回）；**每次失败都注入，不做任何工具名/错误码过滤**（五轮评审：覆盖发生在工具体执行之后，零过滤无时序问题，见 §3.3）；
- 重放：
  - **native 模式**：工具 `editPreviousToolCalling`，输入 **id**（真实 callId 或上一步序号 `"1"/"2"…`）+ `old_string/new_string/replace_all`，内部路由到对应文件完成「编辑 → 读取 → 以新参数重放原工具」，模型无需填路径；
  - **PTC 模式（code）**：**不注册、不注入该工具**——模型在 `run_code` 程序内用 fs 工具读/编辑 checkpoint 文件，把内容作为新程序或其他工具的输入。

量化目标（第五阶段评测验证）：失败重试的 token 消耗显著下降（建议基线目标：重试步输出 token 节省 ≥ 40%，见 §6），重试成功率不低于「全量重新生成参数」的基线；暂存/通知的固定开销最小化（单条通知 + 顺序 id 别名维护）。

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

- 结果判别式：`ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`，`isError: true/false`：`packages/core/tools/src/index.ts:556-580`；错误码 `ABORTED`/`ABORTED_BEFORE_DISPATCH`（:469-472）、`UNKNOWN_TOOL`、`INVALID_ARGS`（`schema.ts:461-470`）均为失败，**均经过 post-execute**。
- **落盘口径（五轮评审定稿：native 与 PTC 逻辑完全一致）**：**只落盘模型直调（`exec.parent === undefined`）**——落盘内容是模型在该 block 下输入的**全部内容**（整个工具调用的参数字符串）：
  - native：每个工具调用都落盘；
  - PTC：模型唯一的直调是 `run_code`（collapse 只允许直调它，`collapses` :1324-1326）→ 落整个程序参数；**程序内部调用的工具一律不落盘，包括程序内嵌套调用的 run_code**（它们 `exec.parent` 存在）；
  - **零过滤**（五轮评审讨论结论）：不按工具名、不按错误码过滤——`editPreviousToolCalling`/`read`/`write`/`edit` 以及 `ABORTED`/`UNKNOWN_TOOL` 的直调同样落盘并（失败时）通知。无时序问题：编号别名的重建发生在**该轮首条直调的 post-execute**，此时工具体已执行完毕——native 的重放是单次调用（编辑与重放都在 `editPreviousToolCalling` 体内完成），旧文件在重放前已被消费；PTC 的替换在 `run_code` 程序整体执行完后才发生，程序执行期间先 edit/read 后替换，互不冲突（§3.3）。
- **callId 实证结论（实测本会话日志确认）**：
  - `tool/call` 事件带 `callId`（如本会话实测 `call_00_UIZK3UTd84uighVQ0QPb5398`）：`packages/core/session/src/types.ts:279`；模型历史里的 assistant tool-call block 与 tool/result 的 `toolCallId` 也都带 id（`llm/src/message.ts:234`）——**模型在历史里能看见 id**；
  - **但 id 不是模型输入的内容**：id 来自流式 chunk（`tool-call-delta.id`，`llm/src/types.ts:295`）或 assembler 兜底合成 `call-<index>`（`llm/src/assembler.ts:70,113`）；实测本会话（agentPreset=code）中模型的 `run_code` 参数只有 `{code, description}` 两个键，模型**从不书写 id**，也无法在后续回合可靠复述/复算这个 id；
  - ⇒ **id 由 harness 注入给模型、模型原样回传**（通知注入 id、`history.jsonl` 提供历史 id），模型不需要自己构造或记忆 id。

### 2.3 上下文注入通道（评审点 1：已定，采用 `tools/post-execute`）

- **采用**：`tools/post-execute` 监听器对失败结果返回 `{ ...next决策, additionalContexts: [通知] }`（失败结果同样支持 `additionalContexts`：`tools/index.ts:575`）。经 2.1 的链路，通知在下一步出现在模型上下文中；监听器内无条件 `await next()` 保持瀑布链（不占据决策槽）。
- 静态协议说明：`ctx.systemPrompt.section({ name, order, text })`（`packages/core/system-prompt/src/index.ts:375-384`；`PromptSection` :53-75）。order 约定：-100 harness 身份、0 persona、**100-199 工具指引带**（:56-60）；`text` 支持 `(AssembleContext) => string` 动态函数（可随 scope 切换文案，`AssembleContext` 含 `scope`/`agent`）。工具自带指引段范例：`packages/fs/tool-fs/src/edit.ts:77-81`（order 102）。

### 2.4 fs 观察策略与「免读直接编辑」的绕过

- fs 服务与事件：`packages/fs/fs/src/index.ts` —— `Context.fs` :44-47；`'fs/edit-intent'`（waterfall，单决策槽）:66；`'fs/observed'`（emit，同步记录）:76；`writeText(target, content, expected?, signal?, sandboxPolicy?)` :222-228（**返回 `FsWriteOutcome.version`**）。
- 「edit 必须先 read」的限制来源：`packages/fs/fs-observation-policy` 的 `editIntent` 对无观察记录的目标抛 `FS_NOT_OBSERVED`（`src/index.ts:78-88`）；观察归属由 `actor.agent.session` 推导（:36-41），`FsObservationActor = { agent?: { session?: object } }`（`src/types.ts:23-29`），`ToolExecution` 天然满足该形状。
- **已验证的绕过方案（免改核心）**：插件自己写 checkpoint 后，**同步 emit 一条预观察记录**：

```ts
const target = await ctx.fs.resolve(checkpointAbsPath)   // 绝对路径：<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/…
const outcome = await ctx.fs.writeText(target, rawArgs)        // 无条件原子写（不占用 fs/write-intent 槽）
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

  要点：(a) 必须传 `outcome.version`（写操作返回的版本，作为后续 edit 的 CAS 基准，同 `write.ts:122` 的做法）；(b) actor 必须是本次调用的 `exec`（`undefined` 不记录任何东西）；(c) 观察表以 **Session 对象**为键（同进程同会话内有效——checkpoint 重放正是同进程场景）。
- 沙箱约束（插件直写同样受后端约束）：`SandboxedFileSystem.checkedTarget`（`packages/fs/fs-sandbox/src/index.ts:126-148`）按 `ctx.sandboxPolicy.resolve()` 的部署默认模式拦截；`workspace-write` 下可写根 = workspace root + `/tmp` + `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts:52-55`）——**本特性目录位于 `os.tmpdir()` 下，天然在可写根内**；`read-only` 下写盘被拒 → 特性自动降级（不落盘、不通知，仅记日志）。

### 2.5 动态注入时机（二轮评审：每次失败都注入）

- **每次失败都注入通知**，不设计数、不设节流、**不按工具名/错误码过滤**（五轮评审）：`result.isError === true` 即注入。
- 该方案不再依赖 tokenizer/tokenMeter/contextWindow 等任何用量口径，实现与测试最简单；通知开销受「单条、短文案、仅失败时」约束。

### 2.6 模式探测（评审点 3：不改 ds harness，仅用公开 API）

- **不新增/不修改任何 ds harness 代码**。探测采用**双条件**（九轮评审：探测 run_code 背后的插件，而非仅凭工具名）：
  ```ts
  const inCodeMode = (agent) => ctx.tools.get(RUN_CODE_NAME, agent) !== undefined   // ① run_code 对当前 scope 可见
                  && ctx.get('codeRuntime') !== undefined                          // ② run_code 背后的运行时插件已加载
  ```
  - **① 名字探测**：`RUN_CODE_NAME = 'run_code'` 已从 `@deepseek-ai/dsh-tools` 导出（`code-mode.ts:20`，`index.ts:104` re-export）；`ToolRuntime.get(name, scope?)` 是公开方法（:1204）；`view()` 只在 `modeFor !== 'native'` 时把 `run_code` 插入可见表（:1189-1191）。**同名伪造不可能**：`register()` 对保留名无条件拒绝（`index.ts:1053-1055`："tool name 'run_code' is reserved ... cannot be registered or shadowed"），用户无法在任何 layer 注册自己的 run_code，因此「get 到 run_code」只可能是注册表内建的 code-mode 传输；
  - **② 插件探测**：run_code 背后的运行时即 `codeRuntime` 服务（`Context.codeRuntime` 声明于 `packages/code-runtime/code-runtime/src/index.ts:91`，由 `@deepseek-ai/dsh-code-runtime-worker-thread` 等实现）；registry 自身同款用法 `ctx.get('codeRuntime')`（`index.ts:928,1020-1022`——缺失时 code 模式 prompt 组装直接报错）。加上该条件后，即使部署配置异常（run_code 可见但运行时插件未加载），本插件也会按 native 处理，不误注册/误注入；
  - code 与 both 的精确区分仍无法通过公开 API 获得；按五轮评审：**双条件命中即按 code 处理**——不注册 `editPreviousToolCalling`、用 PTC 版文案（both 模式损失直调该工具的便利，可接受；落盘/通知逻辑不受影响）。
- 模式差异**只影响**：(a) 是否注册重放工具；(b) 静态段与通知的文案选择。**落盘/通知的代码逻辑两种模式完全一致**（§2.2）。

### 2.7 独立插件模式（三轮评审修正：不进 harness monorepo，参照 limao-magic-ui）

- **本特性是独立插件**，参照 `/Users/canglong/Program/limao-magic-ui`（npm 名 `@canglongcl/dsh-web-review` 的 dsh-web-review 插件仓库）的注册与发布模式：
  - **独立仓库**（本工作区 `/Users/canglong/Program/dsh-tool-retry` 即插件仓库），**不向 harness monorepo 添加任何包、不修改 harness 任何文件**；
  - **插件包**：`packages/dsh-tool-retry/package.json`，npm 名 `@canglongcl/dsh-tool-retry`（用户 scope + `publishConfig.access=public`），依赖 harness 的**发布版 npm 包**（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`，版本对齐 `0.1.0-rc.x`，参照 dsh-web-review 的依赖写法），**不使用 workspace 链接**；
  - **注册机制（agent 级插件）**：走**用户预设**通道：`agent-presets` 默认自动挂载 DSH home 下的用户预设根 `USER_PRESET_DIR='.agent-presets'`（`packages/preset/agent-presets/src/discovery.ts:41`、`src/index.ts:133-134`）——在 `~/.dsh/.agent-presets/<preset-id>/agent.cordis.yml` 放置「复制自 standard/code + 一行本插件」的预设（两份：native 与 PTC），会话选择该预设即生效；
  - **开发期热迭代**（照搬 dsh-web-review 的链路）：仓库根生成 `cordis.yml`（`- insert:` 覆盖层，引用开发别名如 `@dsh-tool-retry-dev/plugin`）+ `scripts/profile-plugin-link.ts` 把插件包目录 symlink 进 `~/.dsh/profiles/<profile>/node_modules/<dev-alias>/`（参照 limao 的 `materializeProfilePluginLink`，`scripts/profile-plugin-link.ts`），再由 `scripts/dev.ts` 一键启动 harness CLI；
  - **发布**（参照 limao 的 `scripts/package-official.ts`）：staging manifest + `cordis.patch.yml`（`- insert:` 官方包名）+ `pnpm pack`/npm publish；harness 侧 profile 的 bundle patch 机制见 `packages/boot/app-boot/tests/profile.spec.ts:121-124`。注意：bundle patch 是 profile（host）图层的渠道；**agent 级工具插件的主渠道是用户预设**。
  - 插件形态本身仍遵循 harness 惯例：导出 `name`/`inject`/`Config`/`apply`，README 带 Model Experience 格式；独立仓库自带 CI（typecheck/lint/test）而非 harness 门禁。

---

## 3. 总体设计

### 3.1 架构总览

```text
模型发出 tool call block（长参数）
   │  native: 每个工具调用是一个 block（按消息内顺序 1,2,3…）；PTC: 唯一直调是 run_code（整个程序）
   ▼
agent-loop 调度执行（tools/pre-execute → tools/execute → 工具体）
   ▼ 模型直调（exec.parent === undefined；成功或失败；零过滤）
tools/post-execute 瀑布  ← 本特性监听器（"after-tool-calling"；工具体已执行完毕）
   ├─ ① 落盘（目录 = <os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/）：
   │      - id 文件（唯一真实存储）：写 <id>.json（会话内不覆盖）
   │      - 顺序 id（别名）：新轮首调 → 删除旧别名 → 建 previous/1.json→by-id/<id>.json、previous/2.json→…（软链/快捷方式）
   │      - history.jsonl：append 一行索引 {id, tool, turn, step, ordinal}
   │      + 每个文件写后 ctx.emit('fs/observed', ...) 预观察（免读可直接 edit）
   ├─ ② 每次失败 → 注入通知（含调用 id + 上一步序号；PTC 版含文件路径）
   │       返回 next决策 + additionalContexts[createUserMessage(通知)]
   ▼
会话落盘顺序：…tool/result（成功或失败）→（下一步）user/message（通知，每次失败）
   ▼
模型下一步（system prompt 静态段已提前告知机制与两种 access 约定）：
   ├─ native：editPreviousToolCalling({ id: '<通知注入的id>' 或 '上一步序号', old, new, replace_all })
   │            └─ 插件内：id 路由到文件 → 内置 edit 机制改文件 → readText → JSON.parse
   │                         → 嵌套 ctx.tools.execute 重放原工具（单次调用，无需先 edit）
   ├─ 历史/成功场景：bash tail history.jsonl 取 id → editPreviousToolCalling({ id, ... })
   └─ PTC：不注册工具；新 run_code 程序内 tools.read/tools.edit(previous/1.json 或 by-id/<id>.json)
              → 基于读到的旧程序构造修正后的新程序（或提取长参数继续）
```

### 3.2 自动暂存（Auto-Checkpointing）——id 文件唯一存储 + 顺序 id 别名 + jsonl 索引，成功与失败都落盘

| 项 | 设计（五轮评审定稿） |
| --- | --- |
| 触发 | **每一次模型直调（`exec.parent === undefined`）都落盘（成功 + 失败）**，零过滤（不按工具名/错误码排除）。native = 每个工具调用；PTC = 只有 `run_code`（整个程序参数）；内部子调用（含嵌套 run_code）一律不落盘 |
| 目录 | **`<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/`**（五轮评审：固定用系统临时目录，**不使用 `session.header.cwd`**）。**八轮评审：内部两个子文件夹，避免 id 文件与顺序别名同名冲突**——`by-id/`（id 文件，唯一真实存储）与 `previous/`（顺序 id 别名），根下另有 `history.jsonl`。位于沙箱 `workspace-write` 可写根内（`os.tmpdir()` 是 writableRoots 之一，§2.4）；系统重启可被 OS 回收，会话结束时插件主动删除 |
| **顺序 id（编号别名，六轮评审：相当于软链接/快捷方式）** | `previous/1.json`、`previous/2.json`… = 指向**上一步**对应调用的 **`by-id/` 下 id 文件**的软链（按模型消息内顺序，提交顺序 = 模型顺序，§2.1）。**不产生第二份内容**。每轮：新轮首条直调的 post-execute 到达时删除上一轮全部别名，随后每完成一条直调就建 `previous/n.json` → `../by-id/<id>.json` 软链。**Windows**：`fs.symlink` 需 Developer Mode/管理员权限，`EPERM` 时降级为**副本文件**（内容与 id 文件一致、同样预观察；经副本编辑只改副本、id 文件不变——native 下模型不编辑别名、无影响；PTC 下模型经别名编辑后读取同一副本，自洽）。不用 hardlink（后端原子写可能 rename 落盘，硬链会分叉）也不用 .lnk（Node fs 不跟随）。重建发生在工具体执行完毕之后：native 重放是单次调用、PTC 在程序整体执行完后才替换——无时序问题（§2.2） |
| **id 文件（唯一真实存储，`by-id/`）** | `by-id/<sanitize(id)>.json`（sanitize = 非 `[A-Za-z0-9._-]` → `_`）：每次直调各一份，**会话内不覆盖，是全部内容的唯一落盘**（顺序别名只是指向它的软链）。用途：失败通知注入 id 后模型可对同一调用**多次重试**；重放工具按 call_id 路由到该文件。**模型不构造 id**——id 来自通知注入或 `history.jsonl`，原样回传（§2.2） |
| **jsonl 索引（history.jsonl）** | 目录下 `history.jsonl`，每次直调 **append 一行** JSON：`{ id, tool, turn, step, ordinal }`（索引用途；参数内容在 id 文件中，编号别名指向同一文件）。模型用 `bash tail`（native）或 `tools.read`（PTC）读最后若干行，确定要重放哪一次调用——**主要给成功场景**（失败场景 id 已自动注入通知）。行内是否内嵌 arguments 见 §7 决策点 5 |
| 文件内容 | **仅 block 的原始参数字符串，不做任何包装**——统一从本会话 `tool/call` 事件按 `callId` 取 `arguments` 原串（字节级一致；PTC 下即 `run_code` 的完整参数 JSON，含整个程序）。**这是「与输入 arg 完全同构、免重读直接编辑」的前提** |
| 写入 | 每次直调**只写一次**：`ctx.fs.writeText(idTarget, raw, undefined, signal)`（无条件原子写，不占 `fs/write-intent` 槽）到 `by-id/` 下 id 文件；随后建/更新 `previous/n.json` 别名软链（临时名 + rename 原子替换；EPERM 降级为副本写） |
| 预观察 | 对 **id 文件**（真实目标）`ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)`（§2.4 已验证的绕过；同步 emit，不得 await）；`resolve` 跟随软链得到同一 targetKey，模型经 `previous/1.json` 别名 edit 同样命中观察记录；Windows 副本降级时对副本也 emit 一次 |
| 清理 | `session/disposed`（`core/session/src/index.ts:64`）删除该会话整目录；插件 `ctx.effect` teardown 兜底（HMR 安全）；id 文件与 jsonl 全量保留至会话结束 |
| 写盘失败 | 静默降级：记日志、跳过通知，**绝不阻断工具管线**（post-execute 监听器必须 try/catch 后仍调用 next()） |

### 3.3 Hook 层（"after-tool-calling" 实现）

- **监听点（评审点 1 已定）**：`ctx.on('tools/post-execute', listener)`（全局注册即可，Scoped 派发按 `exec.agent` 路由；监听器内自行过滤）。
- **必须保持链**：无条件 `await next()` 拿到决策后修改并返回（本插件不占据决策槽，与 fs-observation-policy 那种「不调 next()」的占有式监听不同）。
- **处理对象**：仅**模型直调**（`exec.parent === undefined`）；`exec.agent?.session` 存在。**零过滤**：任何工具名、任何错误码（`ABORTED`/`UNKNOWN_TOOL` 等）都落盘与通知——讨论结论：覆盖发生在工具体执行完毕之后，且 native 重放为单次调用、多次重试走 id 全量文件，零过滤无时序与递归问题（§2.2）。
- **流程**（每次直调）：从 `tool/call` 事件取 `(turn, step)` 与 `arguments` 原串 → 若为新一步首调：删除上一轮全部 `previous/n.json` 别名 → 写 `by-id/<id>.json` + 建 `previous/n.json` → `../by-id/<id>.json` 软链（EPERM 降级副本）+ `history.jsonl` append + 预观察（§3.2）→ 更新内存轮映射（`{ ordinal → { id, tool } }`）→ 若 `result.isError` → 注入通知。
- **通知时机（二轮+五轮评审已定）**：**每次失败都注入**，无计数、无节流、零过滤——把通知附加到 `next` 决策的 `additionalContexts`（`createUserMessage`，source `{ kind:'plugin', plugin:'@canglongcl/dsh-tool-retry', form:'notice' }`）。
- **通知内容（十轮评审：极简）**：只写三件事——① 已保存；② **调用 id**（+ 上一步序号；PTC 版加 checkpoint 路径）；③ 用 `editPreviousToolCalling`（PTC：新程序内 fs 工具）即可重放。**失败原因不注入**——harness 的 tool/result 本身已把失败原因返回给模型，通知只作为「可选纠错路径」的指引；native 版不要求模型填路径（工具按 id 内部路由，§3.5.2）。
- **通知文案按模式选择**（§3.4 草稿 C/D；模式经 §2.6 的 run_code 可见性判定）：run_code 可见 → PTC 版；否则 native 版。
- **重放自身失败的行为**：重放调用走完整管线（嵌套子调用，`parent` 存在 → 不会被再次落盘/通知）；`editPreviousToolCalling` 自身若失败（如 id 输错）→ 它是直调 → 落盘并通知（零过滤），模型可直接再调用一次修正，无递归风险。
- 通知不重复错误信息（tool/result 已含），因此也不存在摘要截断逻辑。

### 3.4 提示词注入（⚠️ 待审阅草稿，见附录 B 全文）

注入分两层、四个草稿（评审点 4：**两层都必须有**，静态层让 AI 提前知悉机制，动态层给出 id 与路径）：

| 层 | 位置 | 草稿 | 时机 |
| --- | --- | --- | --- |
| **静态 system prompt 段**（让 AI 提前知悉两种 access 约定（id 与顺序 id 别名）、`history.jsonl`、重放工具用法、PTC 下 checkpoint 即整个程序） | `ctx.systemPrompt.section({ name:'tool:checkpoint-replay', order: 149, text: 按 scope 模式动态切换 })`（149 位于工具指引带 100-199 内、SDK 段 150 之前） | A（native）/ B（PTC） | 每次组装，随模式切换 |
| **动态失败通知**（极简：已保存 + id + 用法，不含失败原因） | post-execute 决策的 `additionalContexts`（每次失败） | C（native）/ D（PTC） | 每次失败 |

四段草稿的共同要点（也是评审重点；**机制解释与使用边界只写在静态段 A/B，动态通知 C/D 极简**——只告知「已保存、id、怎么用」）：

1. 明确告知「**每次 model tool call block（无论成败）都会暂存**」，且内容即模型在该 block 下输入的全部内容（PTC 下是整个 `run_code` 程序）；成功但结果不符预期同样可重放；
2. 明确告知 checkpoint 内容与上次发送的参数**字节级相同/同构**，因此**无需先 read 即可 edit**（预观察机制已在 §3.2 保证 edit 不会被 `FS_NOT_OBSERVED` 拒绝）；
3. 使用矩阵（两种 access，七轮评审）：**上一个**调用（无论成败）→ 顺序 id 别名（`previous/1.json`/`previous/2.json`…）；**更早**的调用 → id：失败调用的 id 在其失败时的通知里注入过（模型在 context 中可见，可直接用），也可查 `history.jsonl`；成功调用的 id 只能查 `history.jsonl`；PTC 版文案给文件路径；
4. 明确「仅在需要小修时使用；否则直接重新调用」，防止模型滥用；说明顺序 id 别名只保留上一步、新一轮会重建指向；
5. native 版强调 `editPreviousToolCalling` 单次调用完成「编辑+重放」，输入 id 或序号；PTC 版强调 checkpoint 里是**上一次 `run_code` 的整个程序**，重试时用 fs 读/编辑它。
6. **已知风险（PTC 版）**：程序参数经 `JSON.stringify` 后，模型对其格式化记忆可能不可靠，「免读直接 edit」的 old_string 可能失配。两个缓解选项供评审：见 §7 决策点 10。

### 3.5 重放

#### 3.5.1 PTC 模式（不注册工具、不注入工具用法）

- **code 模式不注册 `editPreviousToolCalling`**（五轮评审点 6：在 code 模式不注册、不注入；run_code 可见即按 code 处理，含 both）。
- checkpoint = **上一步 `run_code` 调用的完整程序参数**（`previous/1.json`；同时有 `by-id/<id>.json` 全量文件）。失败通知（草稿 D）注入 id 与文件路径。
- 重试流程：模型在新 `run_code` 程序内用 fs 工具处理 checkpoint——`tools.read`/`tools.edit`（checkpoint 已预观察，免先读）读回/修正旧程序，然后**基于读到的内容构造修正后的新程序作为新 `run_code` 调用提交**，或提取其中的长参数片段直接作为 `tools.<name>(parsed)` 的输入。fs 的输出直接作为其他工具的输入，满足「ptc 可以将 fs 作为其他 tool 输入」。
- 无失败通知时（如「成功但想重放」），模型读 `previous/1.json`（最近一次程序）或 `tail history.jsonl` 取历史 id 再读 `by-id/<id>.json`。
- 时序（五轮评审确认）：替换发生在 `run_code` 整体执行完之后——程序执行期间先 edit/read checkpoint，随后才被替换，无冲突。
- 失败判定：PTC 下内部子调用失败若被程序 `try/catch ToolCallError` 捕获，**不**构成「tool calling 失败」（不通知）；未捕获导致 `run_code` 整体失败才通知（§2.2）。**程序内嵌套调用的 run_code 同样不落盘**（`exec.parent` 存在）。

#### 3.5.2 native 模式：`editPreviousToolCalling` 工具（输入 id，内部路由）

- **注册条件**：`run_code` 不可见（native）才注册；code/both 不注册（§3.5.1）。
- **签名（八轮评审修订）**：**`{ previous_ordinal?, call_id?, old_string, new_string, replace_all }`**——两个定位参数**二选一、恰填一个**（都填或都不填 → 明确错误结果）：
  - **`previous_ordinal`（数字）**：上一步序号 1/2/…（模型知道自己消息里的调用顺序；最常用路径）；
  - **`call_id`（字符串）**：真实 callId——通知注入的 id 或 `history.jsonl` 里的 id（历史场景、多次重试）。
  模型不需要填写任何文件路径，由工具内部路由。
- **使用约定（七轮评审）**：修改**上一个**调用（无论成败）用 `previous_ordinal`（对应 `previous/n.json` 别名）；修改**更早**调用用 `call_id`——失败调用的 id 已在其失败时的通知中注入（context 可见，直接用），成功调用的 id 只能查 `history.jsonl`。
- **instruction**：描述为「按 id 定位上一次（或历史）工具调用的 checkpoint，编辑后立即以编辑后内容重新调用原工具」；专属系统指引段 `ctx.systemPrompt.section({ name:'tool:editPreviousToolCalling', order: 103, text })`（紧邻 `tool:edit` 的 102）。
- **内部路由（`execute(args, exec)`）**：
  1. 定位（二选一参数）：`previous_ordinal` → 查内存轮映射（§3.3）得 `{ callId, toolName }`；`call_id` → sanitize 后在 `by-id/` 定位 `<sanitize(call_id)>.json` 并解出 `toolName`（从 history.jsonl / 内存映射）。两者目标都是对应 **id 文件**（`previous/n.json` 别名仅服务 fs 工具的模型路径，本工具一律直接编辑 id 文件）；无效或不存在 → 明确错误结果「checkpoint 不存在或已失效」；
  2. 校验目标文件位于**本会话** checkpoint 目录内（防越权）；
  3. **调用内置 edit 机制**：`ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` + `ctx.fs.editText(...)`（与 `packages/fs/tool-fs/src/edit.ts:124-139` 同一路径；checkpoint 已预观察，策略通过；失败按同款 remediate）；
  4. `ctx.emit('fs/observed', target, { kind:'present', version: outcome.version }, exec)` 更新观察版本；
  5. `ctx.fs.readText(target)` 读取编辑后内容；
  6. `JSON.parse` → 新 arguments；解析失败 → 错误结果「checkpoint 内容必须保持合法 JSON」；
  7. **嵌套重放**：`ctx.tools.execute({ callId: CallId('<原callId>:replay'), name: toolName, arguments: newArgs, agent: exec.agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal })`；
  8. 结果渲染：成功 → `"Replayed <toolName> with the edited arguments:"` + 重放结果的 content；失败 → 抛错使本工具结果为 `isError: true`（模型可继续修正重试，其失败本身也会被落盘+通知，零过滤）。
- **单次调用完成编辑+重放**（五轮评审）：模型**不需要**先用内置 `edit` 改 checkpoint——old_string/new_string 在工具体内应用；因此覆盖时序与重放无冲突（§2.2/§3.2）。
- **关键设计点 `parent: exec.token`**：把重放标记为嵌套子调用——(a) 重放完整走 pre/execute/post/result 管线，审批等策略对新参数再次生效；(b) 重放是嵌套子调用，**不会**被本插件再次落盘/通知。
- **审计日志**：v1 不新增 session 事件类型；重放结果随本工具 `tool/result` 的 content 与 `meta`（`{ replayedCallId, toolName, checkpointPath }`）落盘。可选迭代：新增 `tool/replay` 事件类型（需 core/session schema + UI 卡片，属于改 harness 核心——除非必要否则不做）——见 §7 决策点 8。
- **并发**：不声明 `isConcurrencySafe` → 默认独占执行（`executionMode` 分类 fail-closed，:1276-1285）。

### 3.6 模式探测（评审点 3：仅用公开 API，不改 ds harness）

- 实现即 §2.6：**双条件探测** `ctx.tools.get(RUN_CODE_NAME, agent) !== undefined && ctx.get('codeRuntime') !== undefined`。用于：(a) 是否注册 `editPreviousToolCalling`（命中则不注册，§3.5.1）；(b) 静态段与通知的文案选择（`context.scope` / `exec.agent`）。
- **本特性不包含任何对 `packages/core` / `packages/llm` / `packages/fs` 等 harness 代码的修改**；全部能力在一个独立插件仓库内完成（§2.7）。

### 3.7 插件包与注册/发布（独立插件，参照 dsh-web-review）

- **插件仓库**：本工作区 `/Users/canglong/Program/dsh-tool-retry`，结构参照 `limao-magic-ui`：
  - 根：`package.json`（repo scripts：`gen-config` / `profile-plugin-link` / `dev` / `build` / `package-official` / `test` / `typecheck`）、生成的 `cordis.yml`（`- insert:` 开发别名覆盖层）、`scripts/`（`gen-config.ts`、`development-entry.ts`、`profile-plugin-link.ts`、`dev.ts`、`package-official.ts` 等，照搬 limao 同名脚本模式）；
  - `packages/dsh-tool-retry/`：插件包本体。
- **插件包**（`packages/dsh-tool-retry/package.json`）：
  - `name: '@canglongcl/dsh-tool-retry'`、`publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' }`、`type: module`、`main: lib/index.js`、exports `./package.json`；
  - 依赖（发布版，非 workspace）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`；
  - 插件导出：`export const name = 'tool-retry'`、`export const inject = ['tools', 'fs', 'systemPrompt']`、`export const Config: z<Config>`、`export function apply(ctx, config)`；
  - `Config`（v8 精简）：`{ enabled = true }`——目录固定 `<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/`，零过滤（§3.2）。
- **注册（agent 级，不改 harness）**：
  - **用户预设主渠道**：`~/.dsh/.agent-presets/<id>/agent.cordis.yml`（两份：`tool-retry-standard` 与 `tool-retry-code`，即 standard/code 预设的全量拷贝 + 一行 `- id: tool-retry / name: '@canglongcl/dsh-tool-retry'`），会话选择该预设（§2.7）；
  - **开发期**：预设行名用 dev 别名 `@dsh-tool-retry-dev/plugin`，`scripts/profile-plugin-link.ts` 把 `packages/dsh-tool-retry` symlink 进 `~/.dsh/profiles/<profile>/node_modules/@dsh-tool-retry-dev/plugin`，`pnpm dev` 起 harness（照搬 limao `scripts/dev.ts`）；
  - **发布/安装**：`pnpm package:official`（staging + `cordis.patch.yml` insert + `pnpm pack`）→ npm publish `@canglongcl/dsh-tool-retry`；用户安装后预设行名用官方包名。bundle patch（`dsh.bundle.patch`，`packages/boot/app-boot` 的 profile 补丁层机制，`tests/profile.spec.ts:121-124`）作为官方安装器可选辅助，主渠道仍是用户预设。

---

## 4. 实施步骤（五阶段）

### 阶段一：确认上述需要的所有信息 ✅（已完成，成果即本计划 v7）

- 全部代码事实见 §2 与附录 A；遗留决策点清单见 §7，需评审确认后进入阶段二。

### 阶段二：Hook 层开发（独立仓库脚手架 + 先跑通 native 路径）

1. 建独立插件仓库骨架（参照 limao-magic-ui）：根 `package.json` scripts、`scripts/{gen-config,development-entry,profile-plugin-link,dev,harness-path,harness-cli,package-official}.ts`、`packages/dsh-tool-retry/` 插件包（package.json / tsconfig / src/index.ts / src/invariant.ts）。
2. 实现 `tools/post-execute` 监听器（逻辑与模式无关，§2.2）：仅模型直调（`exec.parent === undefined`）、零过滤 → 从 `tool/call` 事件取 `(turn, step)` 与 `arguments` 原串 → 新轮首调删除旧别名 → 写 id 文件 + 建/更新别名软链 + jsonl append + 预观察（§3.2）→ 更新轮映射 → 每次失败注入通知（含 id + 序号，§3.3）。
3. `Config` schema 与 `inject` 声明；`apply()` 注册监听与 teardown（HMR 安全）；重启时从会话日志重建轮映射（§3.2）。
4. 静态段与动态通知先落 native 草稿（附录 B 的 A/C），PTC 版文案阶段三补齐。
5. 用户预设两份（§3.7）+ dev 别名 symlink 链路打通。
6. **验收**：单测通过（§5.1）；keyless 快照跑通「长参数工具失败 → id 文件 + 别名 + jsonl 落盘 → 下一步收到含 id 的通知」最小链路。

### 阶段三：插件开发（重放 + 双模式文案 + 注册发布）

1. 实现并注册 `editPreviousToolCalling`（§3.5.2：id/序号路由、内置 edit 复用、嵌套重放；仅 run_code 不可见时注册）。
2. 模式探测（§2.6/§3.6，仅公开 API）；静态段与通知补 PTC 版文案（附录 B 的 B/D）；静态段 order 149、工具指引段 order 103。
3. `pnpm package:official` 打包链路（staging + `cordis.patch.yml`）就绪。
4. **验收**：native 与 code 双模式集成测试通过（§5.2）；「editPreviousToolCalling(id) → 编辑 → 重放」单次调用全链路可复现；code 模式确认不注册该工具、PTC 文案生效。

### 阶段四：测试与验证

- 完整测试清单见 §5；独立仓库自身 CI：typecheck / lint / unit / 集成；keyless 快照与真实 e2e 纳入仓库脚本。
- **验收**：§5 全部通过；插件包形态符合 harness 惯例（`name`/`inject`/`Config`/`apply` 导出、README Model Experience 格式）。

### 阶段五：评测

- 评测方案见 §6。
- **验收**：离线 A/B 报告（token 节省、重试成功率、开销）+ 真模型评测数据；结论支持/否定目标（§1）。

---

## 5. 测试与验证

1. **插件单测**（模板：`packages/fs/fs-observation-policy/tests/policy.spec.ts` 的 `new Context() + ctx.plugin` 方式）：
   - 模型直调（成功与失败）都落盘（id 文件 + 别名 + jsonl）与预观察；**嵌套子调用（`parent` 存在）不落盘不通知**（PTC 下验证程序内部工具调用与嵌套 run_code 被跳过、外层 run_code 整体落盘）；**零过滤**：editPreviousToolCalling/read/write/edit 与 ABORTED/UNKNOWN_TOOL 同样落盘+通知；
   - 通知：**每次失败都注入**，成功不注入；通知含 id 与上一步序号；
   - 顺序 id 别名：同轮并行按模型顺序建 `previous/n.json` 软链指向 `by-id/` 下各自 id 文件；新轮首调删除上一轮全部别名并重建；上一轮多余别名被删除；重建发生在工具体之后（native 单次重放不受影响、PTC 程序执行期间旧别名仍在）；**Windows `EPERM` → 副本降级（内容一致且副本已预观察）**；经别名 `edit` 解析到 id 文件同一 targetKey（软链时编辑落到 id 文件）；
   - 落盘一致性：id 文件是唯一真实存储、会话内不被覆盖；history.jsonl 每调一行 append（id/tool/turn/step/ordinal）；
   - 写盘失败/沙箱拒绝 → 不通知、管线不受影响。
2. **工具单测**（模板：`packages/fs/tool-fs/tests/tools.spec.ts:38-120` 的 `FakeFs extends FileSystem` + `ctx.tools.execute`；edit 工具用例模板 :422-471）：
   - `editPreviousToolCalling`：`previous_ordinal` 与 `call_id` 两条路由（**二选一、恰填一个，都填/都不填报错**）；越界/不存在的序号或 id 报错；`old_string` 失配报错；编辑后内容非法 JSON；目标越出 checkpoint 目录被拒；原工具未注册/重放失败透传；`fs/observed` 版本更新；run_code 可见时工具未注册。
3. **agent-loop 集成**（`packages/fs/tool-fs/tests/harness.ts:15-24` 的 `fsHarness` + `packages/test-support/agent-loop-testkit` `mountAgentLoopTestDependencies` :37-46，依赖自发布版 npm 包）：真实循环内「成功调用也落盘 → 失败 → 通知（含 id）时序位于该 tool/result 之后 → editPreviousToolCalling(id) 单次重放 → 结果」全链路；**上一步全部并行 block 各自可重放**；多次重试用 id 路径可复现。
4. **code-mode 集成**：外层 `run_code` 整体落盘（`previous/1.json` + `by-id/<id>.json`）→ 未捕获失败 → 通知（含 id 与路径）；内部子调用失败被捕获 → 不通知；程序执行期间 checkpoint 旧内容可读（替换在程序结束后）；下一步程序内 `tools.read`/`tools.edit` checkpoint（无需先 read，验证预观察生效）；**code 模式不注册 editPreviousToolCalling**。
5. **keyless 快照/回放**：`packages/test-support/llm-replay` + `replay.override.json` 强制注入失败并脚本化两臂重试；纳入仓库自身 CI（对照 harness `pnpm run test:snapshot` 的用法）。
6. **真实 API e2e**：PTC 与 native 各一例（无 key 自动跳过）。
7. **插件形态合规**：导出形状/HMR disposal/`invariant`/Model Experience README 对齐 harness `packages/AGENTS.md` 惯例（独立仓库自建门禁，不提交进 harness）。

---

## 6. 评测方案（第五阶段）

**指标**（数据源 = session JSONL 权威日志，无需新埋点）：

- 重试步输出 token：`assistant/message.usage.outputTokens`（`packages/core/session/src/types.ts:266-273`），或 `tokenMeter` 的 `tokenUsage` 投影（仅评测读取，特性运行时不依赖）；
- 重试成功率：通知所在下一步内，原工具名（或 `run_code`）再次出现且 `tool/result` 无 `error`（`types.ts:291-297`）；
- 「成功但重放」场景成功率：模型对成功调用发起重放后，重放调用无 `error`；
- 多次重试：同一 id 连续重试直至成功的能力（id 全量文件不被覆盖）；
- 并行覆盖：上一步存在多个并行 block 时，各顺序 id 别名齐全且各自可重放；
- 任务成功率：`turn/end.reason` 非 `error`/非 `max-tokens`（`types.ts:146-168`）；
- 开销：checkpoint 写盘耗时与文件量（编号文件 ≤ 上一步 block 数 + id 文件 + jsonl）、通知注入条数（应恒等于失败次数）。

**A. 离线确定性 A/B（首选，无 API key、可进 CI）**：

1. 语料：构造/采集 `tool/call.arguments` 超长（按字节数阈值筛选）的 `session.jsonl` fixtures（native 与 PTC 各若干，含多并行 block 场景）；
2. 用 `llm-replay` 的 `replay.override.json`（`packages/test-support/llm-replay`）在该调用后强制注入 `tool/result{error}`，并脚本化两臂完全相同的重试脚本；
3. 特性 ON/OFF 两种 cordis 组合各回放一遍（`installLlmReplay` 驱动真实 agent-loop）；
4. 逐场景对比输出 token 与重试成功布尔值，输出 JSON 摘要（对齐 `examples/jsonrpc-agent/tests/snapshots/*` 的 `result.expected.json` 布局），作为快照断言常驻。

**B. 真模型评测（第五阶段对外数据）**：

- 驱动：`examples/jsonrpc-agent/minimal.py`（`BENCHMARK.md` 唯一指引路径）或 `DeepSeekHarness` SDK；每臂/每任务独立 workspace 与 session-id（BENCHMARK.md 要求）；
- 场景集建议：长 JSON 配置编辑、大批量文件改写、schema 校验失败修正、PTC 下 `run_code` 程序失败后的重试（读 checkpoint 重建程序）、**「成功但不符预期」后的重放重试（tail history.jsonl 取 id）**、**并行多 block 中单个失败的重试**、**同一调用的多次重试（id 路径）**；
- 每轮结束解析产出 JSONL：聚合「重试步 token 节省 %」「重试成功率」「任务成功率」「注入开销」对比基线（特性关闭、模型全量重生成参数）。
- 报告建议基线目标：重试步输出 token 节省 ≥ 40%；重试成功率不劣于基线；通知条数 = 失败次数。

> 注：仓库目前**没有**专门 eval 框架（无 swebench/terminal-bench；`python/` 仅为 SDK+runtime，`BENCHMARK.md` 仅指向 `jsonrpc-agent`）。若后续要扩大规模，`llm-replay` 的 keyless A/B 是最贴近现成基建的扩展点；limao-magic-ui 的 `eval/` 目录（capture/smoke/batch/report）可作为独立插件自建评测套件的范本。

---

## 7. 风险与待决问题（请评审决策）

1. **四段提示词文案**（附录 B）需人工审阅定稿——特别是「免读直接 edit」的措辞与边界、静态段中两种 access 约定（id 与顺序 id 别名）的详细程度、**使用矩阵（上一个→顺序别名；更早→id：失败注入过/成功查 history）**、PTC 版「checkpoint = 整个程序」的引导方式。
2. **checkpoint 目录**：`<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/`（五轮评审已定：不用 `session.header.cwd`）——请确认；注意 tmp 目录可能被 OS 定期清理（会话内不受影响）。
3. **零过滤**（五轮评审讨论结论）：任何工具名（含 `editPreviousToolCalling`/`edit`/`read`/`write`）与任何错误码（含 `ABORTED`/`UNKNOWN_TOOL`）的模型直调都落盘、失败都通知——已确认无时序问题（覆盖在工具体之后；native 重放单调用；多次重试走 id），请最终确认。
4. **顺序 id 别名语义（六轮评审）**：`previous/1.json`/`previous/2.json`… 为指向 `by-id/` 下 id 文件的软链/快捷方式（唯一真实存储是 id 文件；**八轮评审：两个子文件夹分开存放，避免 id 文件与顺序别名同名冲突**），每轮重建指向；Windows `EPERM` 降级为副本（经副本编辑只改副本、id 文件不变）——请确认；重建粒度（每轮首调清空重建 vs 每调更新）是否认可。
5. **history.jsonl 行内容**：v1 建议 `{ id, tool, turn, step, ordinal }`（索引）；如需 `tail` 即可见参数可内嵌 arguments（行变长）——请选择。
6. **`editPreviousToolCalling` 签名（八轮评审修订）**：`{ previous_ordinal?, call_id?, old_string, new_string, replace_all }`——两个定位参数**二选一、恰填一个**（都填/都不填 → 明确错误）；`previous_ordinal`（数字）= 上一步序号，`call_id`（字符串）= 真实 callId（通知注入 / jsonl 查询）；参数命名请确认。撞形问题已由双文件夹消除（id 文件在 `by-id/`、别名在 `previous/`）。
7. **code 模式不注册、不注入**（五轮评审点 6）：run_code 可见（code 或 both）即不注册 `editPreviousToolCalling` 并用 PTC 文案——both 模式损失直调该工具的便利，请确认取舍。
8. **重放审计**：v1 结果内嵌 `meta`（不新增 session 事件、不改 harness 核心）vs 新增 `tool/replay` 事件类型（需改 core/session——建议不做）。
9. **保留策略**：id 文件与 history.jsonl 全量保留至会话结束（目录在 tmp 下，OS 可回收）；会话结束删除整目录（建议）。
10. **PTC「免读编辑」风险**：`JSON.stringify` 格式化可能与模型记忆不符 → 选项 (a) 折中措辞「可直接 edit；不确定格式时先 read」（推荐）；(b) 写盘固定 `JSON.stringify(args, null, 2)` 并在文案声明序列化规则。
11. **进程重启后的轮映射**：编号/轮映射为内存态，重启后从会话日志尾部 `tool/call` 事件重建（按最后一步顺序编号）；id 文件与 jsonl 在磁盘上天然可重建——建议 v1 直接实现。
12. **独立插件仓库**：仓库即本工作区 `/Users/canglong/Program/dsh-tool-retry`（参照 limao-magic-ui 布局）；npm 包名 `@canglongcl/dsh-tool-retry`；注册主渠道 = 用户预设 `~/.dsh/.agent-presets/`（两份：standard/code）——请确认命名与渠道。
13. **重放的安全语义**：重放走完整管线（审批策略对新参数再次生效）——确认这是期望行为（而非「已批准调用重放免审」）。
14. **写盘/通知失败路径**：写盘失败静默跳过通知（建议）；是否需要可观测的 telemetry 事件（session-telemetry 已有 error 预映射，可扩展）。

---

## 8. 附录 A：代码地图（文件:行号 速查）

**执行管线 / 钩子 / 调用标识（harness）**
- `packages/core/tools/src/index.ts`：`tools/pre-execute` :152 · `tools/execute` :163 · `tools/post-execute` :175 · `tools/result` :197 · PostToolDecision :597-600 · ToolExecutionResult :556-580 · ToolExecutionInput（`parent` 字段：嵌套子调用标记）:314-338 · ToolRunContext（deferContext/concludeTurn）:404-421 · ToolRuntime.execute :1342 · get :1204 · schemas :1234 · executionMode :1276-1285 · view() 插入 run_code 条件 :1189-1191 · collapses :1324-1326 · 错误码 :469-472 · RUN_CODE_NAME re-export :104 · register() 保留名拒绝 :1053-1055 · ctx.get('codeRuntime') :928,1020-1022
- `packages/code-runtime/code-runtime/src/index.ts:91`（`Context.codeRuntime` 服务声明；`@deepseek-ai/dsh-code-runtime-worker-thread` 为实现）
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
- `packages/fs/fs-sandbox/src/index.ts` checkedTarget :126-148 · `packages/sandbox/sandbox/src/roots.ts` writableRoots :52-55（`os.tmpdir()` 在可写根内）

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
> 静态段（A/B）写入 system prompt，让 AI 提前知悉两种 access 约定（id 文件与顺序 id 别名）与重放用法；动态通知（C/D）**每次失败**注入，含调用 id 与上一步序号（PTC 版加文件路径）。
> **每段草稿下附中文译文，仅供评审对照；实际注入文案的语种由评审决定（当前默认英文）。**

### A. 静态 system prompt 段 —— native 模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every tool call you make is checkpointed under <checkpoint-dir>, whether it
succeeds or fails:
- previous/1.json, previous/2.json, ... are shortcuts to the calls of your
  PREVIOUS message in your call order (your 1st call is previous/1.json,
  your 2nd call is previous/2.json, and so on). A new round of calls
  re-points them.
- Every call is also kept under its call id as by-id/<id>.json, and an index
  line is appended to history.jsonl.
- A checkpoint's content is byte-for-byte identical to the arguments you sent
  for that call.
To retry with a small correction, call `editPreviousToolCalling` once with
either previous_ordinal (the call's position 1/2/… in your previous message,
whether it succeeded or failed) or call_id (for an OLDER call — a failed
call's id was given in its failure notice, and any call's id can be looked
up in the tail of history.jsonl), plus old_string / new_string /
replace_all. It applies your edit and immediately re-invokes the original
tool with the edited arguments. Use this only when a small correction is
needed; otherwise call the tool again with fresh arguments.
```

**A · 中文译文（评审对照）：**

工具调用检查点与重放
你发出的每一次工具调用（无论成败），其参数都会保存在 <checkpoint-dir> 下：
- previous/1.json、previous/2.json… 是「上一条消息」中各次调用的快捷方式（第 1 次调用对应 previous/1.json，第 2 次对应 previous/2.json，以此类推）。新一轮调用会重新指向它们。
- 每次调用还会按 call id 保存为 by-id/<id>.json，并在 history.jsonl 中追加一行索引。
- 检查点内容与你当时发送的参数逐字节一致。
需要小幅修正重试时，调用一次 editPreviousToolCalling：修改「上一条消息」里的调用（无论成败）用 previous_ordinal（1/2/…）；修改更早的调用用 call_id（失败调用的 id 已在失败通知中给出；任何调用的 id 都可以用 tail 查看 history.jsonl 获得），并附 old_string / new_string / replace_all。它会应用你的修改并立即以编辑后的参数重新调用原工具。仅当只需小幅修正时使用；否则直接用新参数重新调用该工具。

### B. 静态 system prompt 段 —— PTC（code）模式

```text
TOOL-CALL CHECKPOINT & REPLAY
Every `run_code` call you make — i.e. everything you wrote in your tool call
block, which is the full program — is checkpointed under <checkpoint-dir>,
whether it succeeds or fails: previous/1.json is a shortcut to your most
recent program, which is kept as by-id/<id>.json, and an index line is
appended to history.jsonl. Tools called INSIDE a program (including nested
`run_code`) are not checkpointed separately.
- Your most recent program is always previous/1.json (whether it succeeded
  or failed); older programs are under by-id/<id>.json — a failed run's id
  was given in its failure notice, and any id can be looked up in the tail
  of history.jsonl.
- After a FAILED run, a notice tells you the call id and the checkpoint path.
- To retry: in a new `run_code` program, read the checkpoint with tools.read
  (or fix it in place with tools.edit — the content is exactly the program
  you submitted, so you may edit it without reading it first), then use the
  content to reconstruct your corrected program (or extract long argument
  data from it and pass it to other tools). Use this only when a small
  correction is needed; otherwise write a fresh program.
```

**B · 中文译文（评审对照）：**

工具调用检查点与重放
你的每一次 run_code 调用——即你在 tool call block 里写的全部内容（整个程序）——无论成败都会保存在 <checkpoint-dir> 下：previous/1.json 是最近一次程序的快捷方式，程序本体按 call id 保存为 by-id/<id>.json，并在 history.jsonl 中追加一行索引。程序内部调用的工具（包括嵌套的 run_code）不会单独保存。
- 最近一次程序永远是 previous/1.json（无论成败）；更早的程序在 by-id/<id>.json 下——失败程序的 id 已在失败通知中给出，任何 id 都可以用 tail 查看 history.jsonl 获得。
- 程序失败后，会收到一条通知，内含 call id 与 checkpoint 路径。
- 重试：在新 run_code 程序里用 tools.read 读取 checkpoint（或用 tools.edit 就地修改——内容与你提交的程序完全一致，可以不先 read 直接 edit），然后基于读到的内容重建修正后的程序（或提取其中长参数数据传给其他工具）。仅当只需小幅修正时使用；否则重写一个新程序。

### C. 失败通知（动态注入）—— native 模式

```text
TOOL-CALL CHECKPOINT (optional retry path)
Your failed call's arguments were saved.
- call id: <id>
- previous-message ordinal: <n>
To apply a small fix and re-run the call, use `editPreviousToolCalling`
(with previous_ordinal <n> now, or call_id "<id>" later — it stays valid).
```

**C · 中文译文（评审对照）：**

工具调用检查点（可选纠错路径）
你这次失败调用的参数已保存。
- call id：<id>
- 上一条消息中的序号：<n>
如需小幅修正后重跑该调用，使用 editPreviousToolCalling（现在可用 previous_ordinal=<n>，之后可用 call_id="<id>"——id 始终有效）。

### D. 失败通知（动态注入）—— PTC（code）模式

```text
TOOL-CALL CHECKPOINT (optional retry path)
Your failed `run_code` program was saved.
- call id: <id>
- checkpoint: <path to previous/1.json> (also by-id/<id>.json)
To apply a small fix, edit/read it inside a new `run_code` program.
```

**D · 中文译文（评审对照）：**

工具调用检查点（可选纠错路径）
你这次失败的 run_code 程序已保存。
- call id：<id>
- checkpoint：<previous/1.json 的路径>（同时有 by-id/<id>.json）
如需小幅修正，在新 run_code 程序里 edit/read 该文件即可。

### 评审要点备注

- C/D **不再包含「failure」**——harness 的 tool/result 已把失败原因返回给模型，通知只做可选纠错路径指引（十轮评审：注入文本过长，精简）；「call id」由 harness 注入、模型原样回传（§2.2 实证：模型不书写 id，但可回传注入值）；「ordinal」即模型上一条消息里的调用序号（模型知道自己调用的顺序）。
- 编号/序号约定：`previous/<n>.json` = 上一条消息里第 n 个 tool call block 的别名（软链指向 `by-id/` 下 id 文件）；并行调用也按消息内顺序编号（harness 提交顺序 = 模型顺序，§2.1）。别名每轮重建（新轮重建指向，旧序号失效）。
- A/C 的「byte-for-byte identical」在 native 下严格成立（落盘即模型发送的原串）；B/D 在 PTC 下落盘的是 `run_code` 的完整参数 JSON（整个程序），模型对格式化记忆可能不可靠——「免读直接 edit」存在 old_string 失配风险，两个缓解选项见 §7 决策点 10。
- 使用矩阵（七轮评审）：上一个调用（成败同路）→ 顺序 id 别名；更早 → id（失败：当时注入的 id 仍在 context 可见，或查 history.jsonl；成功：只能查 history.jsonl）。C/D 通知同时给序号与 id：序号用于当下修复，id 用于之后别名被重建后仍可多次重试。
- 静态段（A/B）明确两种 access 约定（顺序 id 别名 → id 文件，history.jsonl 索引）与「别名仅保留上一步、新轮重建指向」，防止模型在过期别名上做无谓编辑。
- 文案长度：静态段 A/B 约 100-180 token、随 system prompt 常驻；动态通知 C/D 约 20-40 token、每次失败注入（极简）。
