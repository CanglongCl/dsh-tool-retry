# dsh-tool-retry

[English](./README_en.md)

> ⭐ 如果这个项目对你有帮助，欢迎点个 Star 支持一下！你的支持是我持续维护和改进的动力。

为 DeepSeek Harness 提供**工具调用重试**：每一次模型发出的 tool call block 都会自动暂存；调用失败后，模型可以修改原调用的一部分以重新调用工具，而不必重新生成整段长参数。

## 安装

```sh
dsh plugin --profile web add @canglongcl/dsh-tool-retry
```

## 工作方式

非 PTC 模式下，提供 `editPreviousToolCalling` 工具，允许模型使用该工具修改过往工具调用的部分参数。修改后会立刻以新参数调用过往工具。

PTC 模式下，不注册新工具。程序失败后通知给出 checkpoint 路径；Agent 可以在新的 `run_code` 程序里读回它，通过脚本修改后用 `AsyncFunction` 构造器把修正后的程序作为函数执行。

## 工作原理

### 自动暂存

- 每次直调按调用 id 全量保留储存至 `<tmpdir>/.../by-id/<tool-call-id>.json），内容与模型发送的原始参数字符串一致。

### 失败通知

- 在模型调用参数超过 150 字节的工具且失败时，向模型注入「已保存 + call id + 一个用占位符写成的重试示例」的提示。

### 重放工具 `editPreviousToolCalling`

- 允许模型通过失败的工具调用 `ID` 修改原调用的一部分参数，并重新执行该工具。
- 仅非 `PTC` 模式下注册该工具（`PTC`模式下使用脚本替换与重新执行）。

## 插件能力评测

项目包含一套面向真实使用流程的评测，用于验证模型在收到通知后是否真的采用重放路径、每次重试实际少重发多少参数、任务是否照常完成。评测覆盖：长/短参数、计划驳回、参数类型错误、旧片段过期、整值替换、文件覆盖拒绝等失败形状。

评测结果显示，模式在调用长参数工具失败后，本插件机制采用率 ≈94%，相比全量输入并重新调用工具，工具调用部分节省 Token 74%，总 Token 节省 42%。

评测设计、运行方式和结果解释见 [Eval suite](./eval/README.md)；各期报告见 [reports/index.html](./reports/index.html)。

## 参与开发

开发环境、加载模型、设计不变量与验证流程见 [AGENTS.md](./AGENTS.md)；完整设计见 [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md)。
