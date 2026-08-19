# Eval suite

dsh-tool-retry 的真实环境评测：在真实 DSH CLI 里逐场景跑 ON（挂载插件）与 OFF（基线）双臂，测量「模型是否真的会用重放路径、每次重试实际少重发多少参数、任务是否照常完成」。报告结论持久化在仓库 `reports/`，完整会话证据留在本机归档。

## 布局

| 位置 | 内容 |
|---|---|
| `packages/dsh-tool-retry/tests/eval-fixtures-src/` | 场景定义源（任务文本、工作区文件、成功判据） |
| `packages/dsh-tool-retry/tests/eval-fixtures/` | 生成后的场景定义（`pnpm build:fixtures`，check 校验幂等） |
| `packages/dsh-tool-retry/tests/replay-fixtures/` | keyless 机制 A/B 的断点语料（CI 用，不测模型行为） |
| `.artifacts/eval/` | 运行产物：`results.jsonl`（累计记录）、`batch.json`、每批 `runs/<stamp>/…`（本地，gitignore） |
| `~/.dsh/eval-archives/` | 证据归档（`DSH_EVAL_ARCHIVE_DIR` 可改）：每轮 `session.jsonl.gz` + `record.json` |
| `reports/` | 结论报告（`NNN-<stamp>-<model>.html` + `index.html` 目录），随每次改动重生成并提交 |

## 运行

```sh
# 前置：key 走 环境 → 仓库 .env → ~/.dsh/.env 凭据链；DSH_HARNESS 指向 harness 检出
pnpm eval:real    # 全量批次（每场景 × 双臂 × native/code）；--scenario a,b 过滤；--repeat N 压方差；--arm/--mode 单臂；--force 忽略已完成实验
pnpm eval:web     # 评测控制台（127.0.0.1:8090）：网页触发批次、看实时进度、开报告
pnpm eval:report  # 生成 HTML 报告入库（--batch <stamp> 指定历史批次）
pnpm eval:archive # 归档证据到 ~/.dsh/eval-archives 并清理 runs/（--keep 保留；--stamp 指定批次）
pnpm eval:smoke   # keyless CLI 冒烟（脚本化 mock 走真实 CLI：恢复+wake+采集合+评分）
```

每次改完插件，标准收尾是 `pnpm eval:real` → `pnpm eval:report` → `pnpm eval:archive`。

## 评测设计

- **双臂对照**：ON 臂只比 OFF 臂多挂插件一行（通知通道含在内）；失败发生在**运行中**，保证通知真实触发、重放工具真实可用。实验身份哈希包含场景/臂/模式/模型/推理强度/重复序号/仓库 commit，重跑自动跳过已完成实验。
- **场景语料**：
  - *最小实况场景*（`mini-*`、`real-plan-fix-section`）：fresh 启动，目标工具体在运行中拒绝一次——覆盖长/短参数、计划驳回、参数类型错误、旧片段过期、整值替换、文件覆盖拒绝等形状；
  - *真实会话裁剪*（`real-*`）：真实 session.jsonl 逐字节裁剪为断点前缀，恢复后续跑（保真度偏差清单见 AGENTS.md「Eval fidelity」）；
  - *keyless 机制 A/B*（`replay-fixtures/`）：固定剧本、无 key、进 CI——验证落盘/通知/重放路径与固定开销，不测模型行为。
- **核心指标**：
  - `adopted`：断点后是否出现过**成功**的 `editPreviousToolCalling` 重放（PTC 为 checkpoint 读取配方）；
  - `replayAttempts`：尝试次数（含失败的尝试——区分「采用」与「一次成功」）；
  - `retrySuccess`：任务是否最终完成（评分器按场景类型检查产物/文件/评审通过）；
  - 重发参数字节：断点后各次工具调用的参数长度（ON 的重放调用 vs OFF 的整份重发）——这是本特性最直接的经济账；
  - token 与通知计数：断点后输入/输出/推理 token、通知条数（阈值门控的验证点）。

## 证据与报告分离

报告 HTML 只含结论表（每份几百 KB）；点开任意一轮的「查看调用」，弹窗按需向本机面板的 `/evidence/<runDir>/session.html` 加载完整会话（断点前/恢复后两个 tab 的逐事件视图）。面板先查 `.artifacts/eval/runs`，取不到再从归档目录解压现取；都不在时弹窗降级提示。因此证据不复制进 git、仓库永不超限，归档目录可整个同步到任意存储。

## 结果解释

最新一批核心结论（deepseek-v4-flash、reasoning high，详见 `reports/index.html` 各期报告）：

- **长参数 + 「改一处」型失败：采用 ≈94%**——mini 五个长场景 ×3 重复 14/15，真实 10.5K 字 plan 一行修复 2/2；每次重试少重发 190 ~ 10,700 字节参数（OFF 整份重发，ON 的 patch 仅数十到数百字节）。
- **短参数（<150 字节）：不提示、0 尝试、0 负账**——重发新调用比带路由结构的重放更便宜，通知阈值按设计生效。
- **研究型反馈 0 采用，且是设计内行为**——模型推理中逐字引用「仅小修正才用、否则重发」的指引后整份重写，重放路径被约束在它真正省钱的失败上。
- **成功率**：全部可测场景 retrySuccess 接近全绿。诚实底线：mini 规模下通知/示例约 +1K 输入开销使总 token 账时正时负，净节省出现在单次重发参数量级 ≥数百字节的失败上，10K 规模为决定性节省。
