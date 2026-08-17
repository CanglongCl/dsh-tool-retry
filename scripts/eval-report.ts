/**
 * HTML evaluation report generator (`pnpm eval:report`): reads the latest
 * `.artifacts/eval/batch.json` + `results.jsonl` (written by
 * `pnpm eval:real`), renders one self-contained HTML report, and PERSISTS it
 * into the repository under `reports/NNN-<stamp>-<model>.html` with a
 * sequential zero-padded number (001, 002, …). The report records the eval
 * metadata — git head, model/provider, package versions, timestamps, and the
 * per-run/per-scenario token/adoption/retry-success numbers — and the
 * `reports/index.html` catalog is regenerated after each run.
 *
 * Flags: --batch <stamp> selects a historical batch (default: newest).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EVAL_DIR = join(ROOT, '.artifacts', 'eval')
const REPORTS_DIR = join(ROOT, 'reports')

interface BatchMeta {
  stamp: string
  model: string
  provider: string
  reasoning?: string
  repeats: number
  repoHead: string
  packages: Record<string, string>
  startedAt: string
  finishedAt: string
  scenarios: string[]
}

interface RunRecord {
  stamp: string
  scenario: string
  arm: 'on' | 'off'
  mode: 'native' | 'code'
  repetition: number
  model: string
  provider: string
  reasoning?: string
  runDir?: string
  startedAt: string
  finishedAt: string
  summary: {
    retryStepOutputTokens: number
    postBreakInputTokens: number
    retrySuccess: boolean
    adopted: boolean
    noticeCount: number
    noticeBytes: number
    toolCalls: string[]
    toolCallArguments: string[]
    completed: boolean
    resultTexts: string[]
  }
}


interface SessionLine {
  type?: string
  data?: {
    callId?: string
    name?: string
    arguments?: string
    usage?: { inputTokens?: number; outputTokens?: number }
    message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
  }
}

/** Read one run's persisted full session log (the drill-down evidence). */
function readRunSession(record: RunRecord): SessionLine[] | undefined {
  if (record.runDir === undefined) return undefined
  try {
    return readFileSync(join(EVAL_DIR, record.runDir, 'session.jsonl'), 'utf8')
      .split('\n').filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as SessionLine)
  } catch {
    return undefined
  }
}

/** Render every tool call of one run with its raw arguments and result. */
function renderRunDetails(record: RunRecord): string {
  const lines = readRunSession(record)
  const calls: { callId: string; name: string; arguments: string; result: string; isError: boolean }[] = []
  const results = new Map<string, { text: string; isError: boolean }>()
  if (lines !== undefined) {
    for (const line of lines) {
      const content = line.data?.message?.content?.[0]
      if (line.type === 'tool/result' && content?.toolCallId !== undefined) {
        const text = (content.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
        results.set(content.toolCallId, { text, isError: content.isError === true })
      }
    }
    for (const line of lines) {
      if (line.type !== 'tool/call' || line.data?.callId === undefined) continue
      const result = results.get(line.data.callId)
      calls.push({
        callId: line.data.callId,
        name: line.data.name ?? '',
        arguments: line.data.arguments ?? '',
        result: result?.text ?? '',
        isError: result?.isError === true,
      })
    }
  }
  if (calls.length === 0) {
    // Old batches without a persisted session: fall back to the summary.
    for (const [index, argumentsText] of (record.summary.toolCallArguments ?? []).entries()) {
      calls.push({
        callId: `call-${index + 1}`,
        name: record.summary.toolCalls[index] ?? 'unknown',
        arguments: argumentsText,
        result: record.summary.resultTexts[index] ?? '',
        isError: false,
      })
    }
  }
  const blocks = calls.map((call, index) => [
    '<div class="call">',
    `<div class="call-head">#${index + 1} <code>${escapeHtml(call.name)}</code> · callId ${escapeHtml(call.callId)}${call.isError ? ' · <span class="err">失败</span>' : ''}</div>`,
    '<div class="call-label">参数（原始字符串）：</div>',
    `<pre>${escapeHtml(call.arguments)}</pre>`,
    '<div class="call-label">结果：</div>',
    `<pre>${escapeHtml(call.result)}</pre>`,
    '</div>',
  ].join('\n'))
  if (blocks.length === 0) return '<div class="call">（无工具调用）</div>'
  return blocks.join('\n')
}

/** HTML-escape one user/data string. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Median of a numeric list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function rate(values: boolean[]): number {
  return values.length === 0 ? 0 : values.filter(value => value).length / values.length
}

/**
 * Report number for one batch: regeneration of the same batch is idempotent
 * (an existing report carrying the batch stamp keeps its number); a new batch
 * gets the next sequential zero-padded number (001, 002, …).
 */
function numberForBatch(stamp: string): number {
  const files = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{3}-.+\.html$/u.test(entry.name))
  const existing = files.find(entry => entry.name.includes(stamp))
  if (existing !== undefined) return Number(existing.name.slice(0, 3))
  const numbers = files.map(entry => Number(entry.name.slice(0, 3)))
  return (numbers.length === 0 ? 0 : Math.max(...numbers)) + 1
}

/**
 * Apply the plan §6 retry-success criterion to code-mode records recorded by
 * an older runner build that used the fixture marker value: "the next
 * run_code call completes without error" = at least one post-break run_code
 * result whose text is not a code-run failure. (The PTC corpus's only
 * post-break tool is run_code, so the flat result texts are sufficient.)
 */
function regradeCodeRetrySuccess(record: RunRecord): RunRecord {
  if (record.mode !== 'code') return record
  const succeeded = record.summary.resultTexts
    .some(text => !text.startsWith('Error:') && !text.includes('code run failed'))
  return { ...record, summary: { ...record.summary, retrySuccess: succeeded } }
}

function loadBatch(stampFilter?: string): { batch: BatchMeta; records: RunRecord[] } {
  const batch = JSON.parse(readFileSync(join(EVAL_DIR, 'batch.json'), 'utf8')) as BatchMeta
  const stamp = stampFilter ?? batch.stamp
  const lines = readFileSync(join(EVAL_DIR, 'results.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '')
  const records = lines
    .map(line => JSON.parse(line) as RunRecord)
    .filter(record => record.stamp === stamp)
    .map(regradeCodeRetrySuccess)
  if (records.length === 0) {
    throw new Error(`eval:report — no run records for batch ${stamp}; run pnpm eval:real first`)
  }
  return { batch: { ...batch, stamp }, records }
}

interface ScenarioRow {
  scenario: string
  mode: 'native' | 'code'
  onTokens: number
  offTokens: number
  savingsPercent: number
  adoptionRate: number
  onRetryRate: number
  offRetryRate: number
  notices: number
  noticeBytes: number
  onInput: number
  offInput: number
  runs: RunRecord[]
}

function buildScenarioRows(records: RunRecord[]): ScenarioRow[] {
  const byScenario = new Map<string, RunRecord[]>()
  for (const record of records) {
    const list = byScenario.get(record.scenario) ?? []
    list.push(record)
    byScenario.set(record.scenario, list)
  }
  return [...byScenario.entries()].map(([scenario, runs]) => {
    const on = runs.filter(run => run.arm === 'on')
    const off = runs.filter(run => run.arm === 'off')
    const onTokens = median(on.map(run => run.summary.retryStepOutputTokens))
    const offTokens = median(off.map(run => run.summary.retryStepOutputTokens))
    return {
      scenario,
      mode: runs[0]!.mode,
      onTokens,
      offTokens,
      savingsPercent: offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0,
      adoptionRate: rate(on.map(run => run.summary.adopted)),
      onRetryRate: rate(on.map(run => run.summary.retrySuccess)),
      offRetryRate: rate(off.map(run => run.summary.retrySuccess)),
      notices: median(on.map(run => run.summary.noticeCount)),
      noticeBytes: median(on.map(run => run.summary.noticeBytes)),
      onInput: median(on.map(run => run.summary.postBreakInputTokens)),
      offInput: median(off.map(run => run.summary.postBreakInputTokens)),
      runs,
    }
  })
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function renderReport(number: number, batch: BatchMeta, rows: ScenarioRow[]): string {
  const title = `dsh-tool-retry 评测报告 ${String(number).padStart(3, '0')}`
  const scenarioTable = (mode: 'native' | 'code'): string => {
    const group = rows.filter(row => row.mode === mode)
    if (group.length === 0) return ''
    const head = [
      '<h2>', mode === 'native' ? 'native 模式' : 'PTC（code）模式', '</h2>',
      '<table><thead><tr>',
      '<th>场景</th><th>ON 重试步输出 token（中位）</th><th>OFF 重试步输出 token（中位）</th>',
      '<th>token 节省 %</th><th>采用率</th><th>重试成功率 ON</th><th>重试成功率 OFF</th>',
      '<th>通知条数（中位）</th><th>通知字节（中位）</th><th>ON 断点后输入 token（中位）</th>',
      '</tr></thead><tbody>',
    ]
    for (const row of group) {
      head.push(
        '<tr>',
        `<td>${escapeHtml(row.scenario)}</td>`,
        `<td class="num">${row.onTokens}</td>`,
        `<td class="num">${row.offTokens}</td>`,
        `<td class="num ${row.savingsPercent >= 40 ? 'good' : ''}">${row.savingsPercent}%</td>`,
        `<td class="num">${percent(row.adoptionRate)}</td>`,
        `<td class="num">${percent(row.onRetryRate)}</td>`,
        `<td class="num">${percent(row.offRetryRate)}</td>`,
        `<td class="num">${row.notices}</td>`,
        `<td class="num">${row.noticeBytes}</td>`,
        `<td class="num">${row.onInput}</td>`,
        '</tr>',
      )
    }
    head.push('</tbody></table>')
    return head.join('\n')
  }
  const runTable = rows.map((row) => {
    const runRows = row.runs.map((run) => {
      const s = run.summary
      const details = renderRunDetails(run)
      return [
        '<tr>',
        `<td>${run.arm === 'on' ? 'ON' : 'OFF'}</td>`,
        `<td class="num">${run.repetition}</td>`,
        `<td class="num">${s.retryStepOutputTokens}</td>`,
        `<td class="num">${s.postBreakInputTokens}</td>`,
        `<td>${s.adopted ? '✅ 采用' : '—'}</td>`,
        `<td>${s.retrySuccess ? '✅' : '❌'}</td>`,
        `<td>${s.completed ? '✅' : '❌'}</td>`,
        `<td class="num">${s.noticeCount}</td>`,
        `<td>${escapeHtml(s.toolCalls.join(', '))}</td>`,
        '<td>',
        `<details><summary>完整调用详情（点击展开）</summary>${details}</details>`,
        '</td>',
        '</tr>',
      ].join('\n')
    })
    return [
      `<h3>${escapeHtml(row.scenario)} — 每次运行明细</h3>`,
      '<table class="runs"><thead><tr>',
      '<th>臂</th><th>重复</th><th>重试步输出 token</th><th>断点后输入 token</th>',
      '<th>采用</th><th>重试成功</th><th>收敛</th><th>通知条数</th><th>工具调用</th><th>详情</th>',
      '</tr></thead><tbody>',
      ...runRows,
      '</tbody></table>',
    ].join('\n')
  })
  const packages = Object.entries(batch.packages)
    .map(([name, version]) => `<li><code>${escapeHtml(name)}</code> = ${escapeHtml(version)}</li>`)
    .join('')
  const overall = ((): string => {
    const onRows = rows.flatMap(row => row.runs.filter(run => run.arm === 'on'))
    const offRows = rows.flatMap(row => row.runs.filter(run => run.arm === 'off'))
    const onTokens = median(onRows.map(run => run.summary.retryStepOutputTokens))
    const offTokens = median(offRows.map(run => run.summary.retryStepOutputTokens))
    const savings = offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0
    return [
      '<h2>总体（全部场景合并）</h2>',
      '<table><tbody>',
      `<tr><th>ON 重试步输出 token（中位）</th><td class="num">${onTokens}</td></tr>`,
      `<tr><th>OFF 重试步输出 token（中位）</th><td class="num">${offTokens}</td></tr>`,
      `<tr><th>token 节省 %（中位）</th><td class="num ${savings >= 40 ? 'good' : ''}">${savings}%</td></tr>`,
      `<tr><th>采用率</th><td class="num">${percent(rate(onRows.map(run => run.summary.adopted)))}</td></tr>`,
      `<tr><th>重试成功率 ON</th><td class="num">${percent(rate(onRows.map(run => run.summary.retrySuccess)))}</td></tr>`,
      `<tr><th>重试成功率 OFF</th><td class="num">${percent(rate(offRows.map(run => run.summary.retrySuccess)))}</td></tr>`,
      '</tbody></table>',
    ].join('\n')
  })()
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
body { font-family: ui-sans-serif, system-ui, "PingFang SC", sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1d21; line-height: 1.6; }
h1 { font-size: 1.5rem; border-bottom: 2px solid #2f6fed; padding-bottom: .4rem; }
h2 { margin-top: 2rem; font-size: 1.2rem; }
h3 { margin-top: 1.6rem; font-size: 1rem; }
table { border-collapse: collapse; width: 100%; margin: .6rem 0 1.4rem; font-size: .9rem; }
th, td { border: 1px solid #d9dee5; padding: .35rem .55rem; text-align: left; vertical-align: top; }
thead th { background: #eef3fb; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.good { color: #0b7a3e; font-weight: 600; }
.meta { background: #f6f8fa; border: 1px solid #d9dee5; border-radius: 6px; padding: .8rem 1rem; font-size: .85rem; }
.meta ul { margin: .3rem 0; padding-left: 1.2rem; }
.meta code { background: #eef1f4; padding: 0 .25rem; border-radius: 3px; }
table.runs td { font-size: .8rem; }
details { margin: .1rem 0; }
details summary { cursor: pointer; color: #2f6fed; font-weight: 600; }
.call { border-left: 3px solid #d9dee5; padding: .2rem .6rem; margin: .4rem 0; background: #fbfcfd; }
.call-head { font-weight: 600; }
.call-head .err { color: #b42318; }
.call-label { color: #6b7280; font-size: .78rem; margin-top: .3rem; }
.call pre { white-space: pre-wrap; word-break: break-word; background: #f6f8fa; border: 1px solid #e5e9ee; border-radius: 4px; padding: .4rem .5rem; margin: .15rem 0; max-height: 24em; overflow: auto; }
footer { margin-top: 2rem; color: #6b7280; font-size: .8rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">
<ul>
<li><strong>编号</strong>：${String(number).padStart(3, '0')}（批次 stamp：<code>${escapeHtml(batch.stamp)}</code>）</li>
<li><strong>模型</strong>：${escapeHtml(batch.model)}（provider ${escapeHtml(batch.provider)}）· 思考强度 <strong>${escapeHtml(batch.reasoning ?? '默认')}</strong> · 每场景每臂重复 <strong>${batch.repeats}</strong> 次</li>
<li><strong>仓库 git head</strong>：<code>${escapeHtml(batch.repoHead)}</code></li>
<li><strong>运行时间</strong>：${escapeHtml(batch.startedAt)} → ${escapeHtml(batch.finishedAt)}</li>
<li><strong>运行期依赖版本</strong>：<ul>${packages}</ul></li>
<li><strong>场景</strong>：${batch.scenarios.map(escapeHtml).join('、')}</li>
</ul>
</div>
${overall}
${scenarioTable('native')}
${scenarioTable('code')}
${runTable.join('\n')}
<footer>
方法说明：每场景 × 臂（ON=挂载插件 / OFF=基线）× ${batch.repeats} 次独立运行；断点快照为持久化的失败工具调用前缀（恢复式续跑），
指标取自断点后的权威会话日志：重试步输出 token = 断点后第一条 assistant/message 的 usage.outputTokens（含推理 token，adapter 默认档）；
采用 = native 出现 editPreviousToolCalling 调用 / PTC 后续 run_code 参数引用 checkpoint 路径；重试成功 = native 断点工具以合法输入重跑（行为级）/ PTC 按 plan §6 判据「断点后的 run_code 调用无 error」。
原始逐条记录见 .artifacts/eval/results.jsonl。本报告由 pnpm eval:report 生成并持久化于仓库 reports/。
</footer>
</body>
</html>
`
}

/** Regenerate the catalog listing every persisted report. */
function renderIndex(batch: BatchMeta, latestNumber: number): void {
  const files = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{3}-.+\.html$/u.test(entry.name))
    .map(entry => entry.name)
    .sort()
  const items = files.map((name) => {
    return `<li><a href="${escapeHtml(name)}">${escapeHtml(name)}</a></li>`
  }).join('\n')
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>dsh-tool-retry 评测报告目录</title></head>
<body style="font-family: ui-sans-serif, system-ui, 'PingFang SC', sans-serif; max-width: 800px; margin: 2rem auto;">
<h1>dsh-tool-retry 评测报告目录</h1>
<p>最新批次：<code>${escapeHtml(batch.stamp)}</code> · 最新报告编号 <strong>${String(latestNumber).padStart(3, '0')}</strong> · 模型 ${escapeHtml(batch.model)}</p>
<ul>${items}</ul>
<p style="color:#6b7280; font-size:.8rem;">由 pnpm eval:report 自动生成。</p>
</body>
</html>
`
  writeFileSync(join(REPORTS_DIR, 'index.html'), html)
}

// --- main ---------------------------------------------------------------
const stampFilter = process.argv.includes('--batch')
  ? process.argv[process.argv.indexOf('--batch') + 1]
  : undefined
const { batch, records } = loadBatch(stampFilter)
const rows = buildScenarioRows(records)
mkdirSync(REPORTS_DIR, { recursive: true })
const number = numberForBatch(batch.stamp)
const fileName = `${String(number).padStart(3, '0')}-${batch.stamp}-${batch.model}.html`
const path = join(REPORTS_DIR, fileName)
writeFileSync(path, renderReport(number, batch, rows))
renderIndex(batch, number)
console.log(`eval:report — wrote ${path}`)
console.log(`eval:report — catalog refreshed at ${join(REPORTS_DIR, 'index.html')}`)
