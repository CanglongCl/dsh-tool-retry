# dsh-tool-retry

[English](./README_en.md)

> ⭐ 如果这个项目对你有帮助，欢迎点个 Star 支持一下！你的支持是我持续维护和改进的动力。

为 DeepSeek Harness（DSH）提供**工具调用检查点与重放**：每一次模型发出的 tool call block（无论成功或失败）都会自动暂存到系统临时目录；调用失败后，模型会收到一条极简通知，之后可以对暂存的参数做**局部编辑并重放**，而不必重新生成整段长参数。

- **PTC（Code Mode / run_code）与 native 模式逻辑统一**：都只暂存模型的 tool call block——PTC 下即整个 run_code 程序的参数，不暂存程序内部调用的工具。
- **两种 access 方式**：按调用 id 访问（by-id/，全量保留），或按「上一条消息」中的并行 block 顺序访问（previous/1.json、previous/2.json…，软链/快捷方式，每轮重建）。
- **落盘零过滤、通知按字节阈值门控**：每个直调都落盘（任何工具、任何错误码）；失败通知只在原始参数 ≥150 字节时注入——更短时重发新调用比重放的路由结构更便宜，提示是净亏。通知只写「已保存 + id + 用法」，失败原因由 harness 自身的 tool/result 返回。
- **不改动 harness 仓库任何代码**：独立 npm 插件 + 用户预设注册。

## 安装

包尚未发布到 npm 前，从本地 tarball 安装到 web profile：

```sh
pnpm package:official   # 生成 dist/canglongcl-dsh-tool-retry-<版本>.tgz
dsh plugin --profile web add file:$PWD/dist/canglongcl-dsh-tool-retry-<版本>.tgz
pnpm install-presets --official   # 安装 tool-retry-standard / tool-retry-code 用户预设（行名指向官方包）
dsh web
```

发布到 npm 后可直接：

```sh
dsh plugin --profile web add @canglongcl/dsh-tool-retry
dsh web
```

- `dsh plugin add` 会把包写入 profile 的依赖，并因 manifest 声明 `dsh.bundle.patch` 自动注册进 `dsh.profile.bundles`——插件以 **profile bundle** 挂载，`dsh web` 重启后对整个 web 实例生效（会话会持久化恢复）。
- 会话侧能力（失败通知、重放工具、提示词段）通过**用户预设**注册（harness 内置预设不可修改）：安装脚本已把本仓库的 tool-retry-standard / tool-retry-code 模板装到 ~/.dsh/.agent-presets/，新会话选择对应预设即可生效；native 用「标准模式 + 调用重试」，PTC 用「PTC 模式 + 调用重试」。

## 使用方法

### Native（标准）模式

1. 某个工具调用失败后，你会收到一条极简通知，内含 call id（如 call_00_…）。
2. 需要小幅修正重试时，调用一次 editPreviousToolCalling：

```yaml
call_id: "call_00_…"         # 定位：call id 或 previous_ordinal（二选一，恰填一个）
patch:                       # 唯一的编辑载荷：按路径改一处
  - path: ".plan"            # 点号段 + [n] 数组下标，从参数顶层 key 出发
    old_string: "继续使用 Python 2 运行时"   # 字符串值内的片段替换（匹配解码后文本，无需处理 JSON 转义）
    new_string: "改为 Rust 运行时"
  # 或整值替换 / 改类型：{ path: ".version", value: 2 }
  # 或删除字段：{ path: ".config.legacy" }（value 与 old/new 都省略）
```

工具内部完成「解析 checkpoint → 应用补丁 → 持久化 → 立即重放原工具」，无需先 read、无需填路径。

3. 修改更早的成功调用：用 bash tail 查看 <checkpoint-dir>/history.jsonl 取 id，再按 call_id 重放。

### PTC（Code Mode）模式

不注册任何新工具。程序失败后通知给出 checkpoint 路径；在新的 run_code 程序里 `tools.read` 读回它、`JSON.parse` 后在真实程序文本上做字面 `replace`（修正片段无需处理 JSON 转义），再用 `AsyncFunction` 构造器把修正后的程序作为**函数**执行并 `return` 其值（顶层 `return`/`await` 与原生 run_code 语义一致；裸 eval 在 strict 模式拒绝 return）。若这次重试再失败，新 checkpoint 存的是 loader，其中的 `file_path` 仍指回原程序。也可从 checkpoint 提取长参数数据传给其他工具。静态段附完整示例。

## 主要功能

### 自动暂存

- by-id/<id>.json：每次调用的参数原串（字节级一致），会话内全量保留，多次重试都靠它；
- previous/1.json、previous/2.json…：上一条消息中各并行 block 的软链/快捷方式（Windows 无权限时自动降级为副本），每轮重建；
- history.jsonl：每次调用 append 一行索引（id/tool/turn/step/序号），tail 即可查历史。

### 失败通知

失败且原始参数 ≥150 字节时注入一条极简通知（已保存 + id + 一个用占位符写成的重试示例），不重复失败原因、不做解释。`editPreviousToolCalling` 自身失败始终通知：其通知把重试目标切回原 call id（纠错而非经济性）。静态 system prompt 段附三个 XML 形状示例（plan 驳回改一节 / edit 片段过期 / 整值改类型），用法规则的唯一出处是工具自身的 description。

### 重放工具 editPreviousToolCalling（仅 native）

签名 { previous_ordinal?, call_id?, patch }，序号与 call id 二选一；patch 为唯一载荷（必填、非空），条目 { path, value? | old_string?, new_string?, replace_all? }：value 整值替换（任意 JSON 类型；省略即删字段，数组下标 splice）；old/new 在路径处字符串值的**解码文本**上替换（JSON 转义不进模型视野；出现多次时报出次数，replace_all 可全替换）。路径缺失时报错并列出顶层 key。内部路由到对应文件；重放走完整工具管线（审批等策略对新参数再次生效）。

### 模式适配

- 探测 run_code 可见 + codeRuntime 插件已加载即按 code 处理（保留名不可伪造，探测不会被同名工具干扰）；
- code 模式不注册 editPreviousToolCalling、不注入其用法，改用 PTC 文案。

## 存储与清理

- 目录：<os.tmpdir()>/.dsh/tool-checkpoints/<sessionId>/；
- 会话结束时插件删除整目录；OS 回收临时目录是兜底；
- 内容为模型发送的原始参数字符串，不做任何包装。

## 插件能力评测

评测套件已落地并随每次改动重跑（`scripts/eval-harness*.ts`；HTML 报告持久化在 [reports/](./reports/index.html)，含每轮完整工具调用可点击展开）：

- **跑法**：`pnpm eval:real` 在真实 DSH CLI 中逐场景跑 ON/OFF 双臂——ON 臂只多挂本插件一行，失败发生在运行中（保证通知通道真实触发）；`--repeat N` 压方差，`pnpm eval:report` 生成报告入库；另有 keyless 机制 A/B（固定剧本、进 CI，验证落盘/通知/重放路径，不测模型行为）。
- **证据分离**：报告 HTML 只含结论表（每份几百 KB），完整会话证据不塞进 HTML——报告弹窗按需向本地面板（`pnpm eval:web` 的 `/evidence/` 路由）加载，面板先从 `.artifacts/eval/runs` 取、取不到再从 `pnpm eval:archive` 归档目录（gzip）解压取。因此证据不复制进 git：仓库永远只有轻量报告，归档目录可自由同步到任何存储。
- **语料**：最小实况场景（长/短参数、计划驳回、类型错误等形状）+ 真实会话裁剪（真实 10.5K 字 plan 等）。
- **最近一批核心结论**（报告 019/022，deepseek-v4-flash，reasoning high）：
  - **长参数 +「改一处」型失败：采用 ≈94%**——mini 五个长场景 ×3 重复为 14/15，真实 10.5K 字 plan 一行修复为 2/2；每次重试少重发 190 ~ 10,700 字节参数（OFF 臂整份重发，ON 臂 patch 仅数十到数百字节）；
  - **短参数（<150 字节）：不提示、0 尝试、0 负账**——重发新调用比带路由结构的重放更便宜，阈值门控按设计生效；
  - **研究型反馈（真实 plan 驳回）0 采用，且是设计内行为**：模型推理中逐字引用「仅小修正才用、否则重发」的指引，选择整份重写（改动约 40% 内容）——重放的经济区间被引导文案精确约束在它真正省钱的失败上；
  - **成功率**：全部可测场景 retrySuccess 接近全绿；诚实底线：mini 规模下通知/示例约 +1K 输入开销使总 token 账时正时负，净节省出现在单次重发参数量级 ≥数百字节的失败上，10K 规模为决定性节省。

## 参与开发

开发环境、加载模型、设计不变量与验证流程见 [AGENTS.md](./AGENTS.md)；完整设计（含四段提示词草稿与中文译文）见 [docs/tool-calling-checkpoint-replay-plan.md](./docs/tool-calling-checkpoint-replay-plan.md)。

```sh
pnpm install
pnpm gen-config        # 生成开发覆盖层（cordis.yml + entry-name.json）
pnpm install-presets   # 安装 tool-retry-standard / tool-retry-code 两个用户预设
pnpm dev               # 链接开发别名并启动 harness Web CLI（需 DSH_HARNESS）
pnpm dev:headless -- "<一句话任务>"   # 一次性自测：headless 会话跑完整闭环后退出
pnpm test              # 单测 + 集成 + 代码模式集成 + keyless A/B + eval 恢复机制冒烟（vitest）
pnpm build:fixtures    # 重新生成断点语料（replay-fixtures/ + eval-fixtures/，check 校验幂等）
pnpm e2e:real          # 真实 API e2e（native + PTC，需 DEEPSEEK_API_KEY，无 key 自动跳过）
pnpm eval:real         # 真实模型评测（§6：每场景 × 臂 × N 次；key 走 环境→仓库 .env→~/.dsh/.env 凭据链）
pnpm eval:report        # 生成 HTML 评测报告并持久化到仓库 reports/NNN-….html（结论表；完整会话证据在弹窗里按需从本地面板加载）
pnpm eval:archive       # 归档评测证据：只存每轮 session.jsonl(gzip)+record.json 到 ~/.dsh/eval-archives（DSH_EVAL_ARCHIVE_DIR 可改），并清理 runs/ 下已归档批次（--keep 保留；--stamp 指定批次）
pnpm check             # 仓库门禁：typecheck + 单测 + 语料/gen-config 幂等 + 官方包 allowlist
pnpm package:official  # 组装可发布的官方 tarball 到 dist/
pnpm release:verify   # 发布身份校验（CI 流水线第一步；tag 触发发布前强制）
```

## 发布到 npm

发版由 GitHub Actions 完成，本地只需要两步：

1. 同步版本号：`packages/dsh-tool-retry/package.json` 与根 `package.json` 的 `version` 保持一致，提交并推送 main；
2. 打版本标签：`git tag v<版本号> && git push origin v<版本号>`。

流水线 [.github/workflows/release-npm.yml](./.github/workflows/release-npm.yml) 自动执行：

1. `pnpm release:verify` —— 校验包身份（名称、公开权限、仓库元数据、根/包版本一致、tag 与版本匹配）；
2. `pnpm check` —— 仓库质量门禁（typecheck、单测、语料与生成配置幂等、官方包 allowlist）；
3. `pnpm package:official` —— 组装 tarball 并核对 SHA256，上传为构建产物；
4. publish 作业（仅 `v*` 标签触发）—— 用 npm Trusted Publishing（GitHub OIDC，无长期 token）把 **验证过的同一份产物** 发布到 npmjs.org；预发布版本自动走 `next` 标签。

前置条件：npm 账号为 `@canglongcl` scope 启用 Trusted Publishing 并授权 GitHub 仓库 `CanglongCl/dsh-tool-retry`；仓库内不存放任何 npm token。

## 已知限制

- Windows 无 Developer Mode/管理员权限时，previous/ 别名降级为副本（经别名编辑只改副本，by-id 文件不变）；
- both 模式按 code 处理（公开 API 无法区分），不注册重放工具；
- PTC 重试走 parse-first 路线（`JSON.parse` → `prev.code.replace`，匹配串无 JSON 转义），剩余风险是短片段歧义（JS replace 只替换首个匹配，文案提示用更长唯一片段）；
- UNKNOWN_TOOL 的重放会再次失败（预期行为）；
- 系统临时目录可能被 OS 回收（会话内不受影响）；
- ABORTED 边界（实证，见 AGENTS.md「Zero filtering」）：入口即被取消的调用走 final-result 阶段、不经过 post-execute——不落盘也不通知；工具体启动后被取消的调用在瀑布之后才被替换为 ABORTED——会落盘但无通知。
