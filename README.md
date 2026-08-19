# dsh-tool-retry

[English](./README_en.md)

> ⭐ 如果这个项目对你有帮助，欢迎点个 Star 支持一下！你的支持是我持续维护和改进的动力。

为 DeepSeek Harness（DSH）提供**工具调用检查点与重放**：每一次模型发出的 tool call block（无论成功或失败）都会自动暂存；调用失败后，模型会收到一条极简通知，随后可以只改暂存参数里的一处，重放原工具——而不必重新生成整段长参数。

## 安装

```sh
dsh plugin --profile web add @canglongcl/dsh-tool-retry
```

会话侧能力（失败通知、重放工具、提示词段）通过**用户预设**注册：从本仓库安装预设后，新会话选择「标准模式 + 调用重试」（native）或「PTC 模式 + 调用重试」（code）即可生效。

```sh
pnpm install-presets --official   # 把 tool-retry-standard / tool-retry-code 用户预设装到 ~/.dsh/.agent-presets/
dsh web
```

## 使用方法

### Native（标准）模式

1. 某个工具调用失败、且原始参数 ≥150 字节时，你会收到一条极简通知，内含 call id。
2. 需要小幅修正重试时，调用一次 `editPreviousToolCalling`：定位（call id 或上一条消息里的序号，二选一）+ `patch` 数组，按路径改一处——字符串值内替换用 `old_string`/`new_string`（写真实引号即可，无需处理 JSON 转义），整值替换或改类型用 `value`。
3. 工具内部自动完成「解析 checkpoint → 应用补丁 → 持久化 → 立即重放原工具」——无需先 read、无需填路径。
4. 修改更早的成功调用：查 history.jsonl 里的 id，再按 call id 重放。

### PTC（Code Mode）模式

不注册新工具。程序失败后通知给出 checkpoint 路径；在新的 `run_code` 程序里读回它、`JSON.parse` 后在真实程序文本上做字面 `replace`（修正片段无需处理 JSON 转义），再用 `AsyncFunction` 构造器把修正后的程序作为函数执行并 `return` 其值（顶层 `return`/`await` 与原生 run_code 语义一致）。

## 主要功能

### 自动暂存

- 每次直调按调用 id 全量保留（by-id/），同时提供「上一条消息」里并行 block 的序号快捷方式（previous/1.json、previous/2.json…，每轮重建）；
- 内容与模型发送的原始参数字符串逐字节一致，不做任何包装。

### 失败通知

- 只写三件事：「已保存 + call id + 一个用占位符写成的重试示例」，不重复失败原因、不做解释；
- 按字节阈值门控：原始参数 ≥150 字节才提示——更短时重发新调用比重放更便宜，提示是净亏；
- 重放工具自身失败始终通知，并把重试目标指回原 call id（纠错而非经济性）。

### 重放工具 `editPreviousToolCalling`（仅 native）

- 一次调用完成「改一处 + 重放」：补丁按路径直达目标字段，嵌套 JSON 的转义完全不进入模型视野；
- 支持整值替换（任意 JSON 类型、可改类型）、字符串片段替换（重复出现时报次数、可全替换）、删字段与数组下标；
- 重放走完整工具管线，审批等策略对修改后的参数重新生效。

### 模式适配

- 探测到 run_code 可见 + codeRuntime 已加载即按 code 模式处理：不注册重放工具、改用 PTC 文案与 checkpoint 读取配方；
- 不改动 harness 仓库任何代码：独立 npm 插件 + 用户预设注册。

## 插件能力评测

项目包含一套面向真实使用流程的评测，用于验证模型在收到通知后是否真的采用重放路径、每次重试实际少重发多少参数、任务是否照常完成。评测覆盖：

- 长/短参数、计划驳回、参数类型错误、旧片段过期、整值替换、文件覆盖拒绝等失败形状；
- 真实会话裁剪的断点恢复（含真实 10.5K 字 plan）；
- ON/OFF 双臂对照、重复采样、keyless 机制 A/B（进 CI）。

最近一批结论：长参数「改一处」型失败采用 ≈94%，单次重试少重发 190 ~ 10,700 字节参数；短参数不提示、零负账；全部场景任务成功率接近全绿。

评测设计、运行方式和结果解释见 [Eval suite](./eval/README.md)；各期报告见 [reports/index.html](./reports/index.html)。

## 参与开发

开发环境、加载模型、设计不变量与验证流程见 [AGENTS.md](./AGENTS.md)；完整设计见 [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md)。
