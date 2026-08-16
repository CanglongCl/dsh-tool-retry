# dsh-tool-retry

[English](./README_en.md)

> ⭐ 如果这个项目对你有帮助，欢迎点个 Star 支持一下！你的支持是我持续维护和改进的动力。

为 DeepSeek Harness（DSH）提供**工具调用检查点与重放**：每一次模型发出的 tool call block（无论成功或失败）都会自动暂存到系统临时目录；调用失败后，模型会收到一条极简通知，之后可以对暂存的参数做**局部编辑并重放**，而不必重新生成整段长参数。

- **PTC（Code Mode / run_code）与 native 模式逻辑统一**：都只暂存模型的 tool call block——PTC 下即整个 run_code 程序的参数，不暂存程序内部调用的工具。
- **两种 access 方式**：按调用 id 访问（by-id/，全量保留），或按「上一条消息」中的并行 block 顺序访问（previous/1.json、previous/2.json…，软链/快捷方式，每轮重建）。
- **零过滤、每次失败都注入**极简通知（只写「已保存 + id + 用法」，失败原因由 harness 自身的 tool/result 返回）。
- **不改动 harness 仓库任何代码**：独立 npm 插件 + 用户预设注册。

## 安装

```sh
npm i -g @canglongcl/dsh-tool-retry
```

插件是 agent 级能力，通过**用户预设**注册（harness 内置预设不可修改）：

1. 在 DSH 主页复制一份内置预设（native 用「标准模式」，PTC 用「PTC 模式」），或手动在 ~/.dsh/.agent-presets/ 下放置预设文件（本仓库提供 tool-retry-standard / tool-retry-code 两个模板）。
2. 在预设的 agent.cordis.yml 中加一行：

```yaml
- id: tool-retry
  name: '@canglongcl/dsh-tool-retry'
```

3. 会话选择该预设即可生效。

## 使用方法

### Native（标准）模式

1. 某个工具调用失败后，你会收到一条极简通知，内含 call id（如 call_00_…）。
2. 需要小幅修正重试时，调用一次 editPreviousToolCalling：

```yaml
previous_ordinal: 1          # 上一条消息里的第几个 block（也可以不用序号）
call_id: "call_00_…"         # 二选一：序号或 call id
old_string: "<原参数片段>"
new_string: "<修正后的片段>"
replace_all: false
```

工具内部完成「编辑 checkpoint → 解析为新参数 → 立即重放原工具」三步，无需先 read、无需填路径。

3. 修改更早的成功调用：用 bash tail 查看 <checkpoint-dir>/history.jsonl 取 id，再按 call_id 重放。

### PTC（Code Mode）模式

不注册任何新工具。程序失败后通知给出 checkpoint 路径；在新的 run_code 程序里用 fs 工具读/编辑该文件（内容与你上次提交的程序完全一致，可不先 read 直接 edit），基于它重建修正后的程序，或提取其中长参数继续。

## 主要功能

### 自动暂存

- by-id/<id>.json：每次调用的参数原串（字节级一致），会话内全量保留，多次重试都靠它；
- previous/1.json、previous/2.json…：上一条消息中各并行 block 的软链/快捷方式（Windows 无权限时自动降级为副本），每轮重建；
- history.jsonl：每次调用 append 一行索引（id/tool/turn/step/序号），tail 即可查历史。

### 失败通知

每次失败注入一条极简通知（已保存 + id + 用法），不重复失败原因、不做解释——完整机制说明只写在静态 system prompt 段中。

### 重放工具 editPreviousToolCalling（仅 native）

签名 { previous_ordinal?, call_id?, old_string, new_string, replace_all }，序号与 call id 二选一，内部路由到对应文件；重放走完整工具管线（审批等策略对新参数再次生效）。

### 模式适配

- 探测 run_code 可见 + codeRuntime 插件已加载即按 code 处理（保留名不可伪造，探测不会被同名工具干扰）；
- code 模式不注册 editPreviousToolCalling、不注入其用法，改用 PTC 文案。

## 存储与清理

- 目录：<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/；
- 会话结束时插件删除整目录；OS 回收临时目录是兜底；
- 内容为模型发送的原始参数字符串，不做任何包装。

## 插件能力评测

评测方案见 [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md) 的 §6：**机制验证**（llm-replay keyless 脚本化 A/B——固定剧本、无 key、进 CI，验证三轨落盘/通知/重放路径与固定开销，不测模型行为）+ **真模型评测**（python SDK jsonrpc-agent，独立 workspace/session-id 对照，唯一能回答「模型是否会使用、实际省多少」的手段）。实施后将落地为仓库内的 eval/ 套件（参照 dsh-web-review 的 eval 结构）。

## 参与开发

开发环境、加载模型、设计不变量与验证流程见 [AGENTS.md](./AGENTS.md)；完整设计（含四段提示词草稿与中文译文）见 [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md)。

## 已知限制

- Windows 无 Developer Mode/管理员权限时，previous/ 别名降级为副本（经别名编辑只改副本，by-id 文件不变）；
- both 模式按 code 处理（公开 API 无法区分），不注册重放工具；
- PTC 下 checkpoint 是完整程序 JSON，「免读直接 edit」的 old_string 存在格式化失配风险；
- UNKNOWN_TOOL 的重放会再次失败（预期行为）；
- 系统临时目录可能被 OS 回收（会话内不受影响）。
