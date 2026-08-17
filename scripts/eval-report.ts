/**
 * HTML evaluation report generator (`pnpm eval:report`): reads the latest
 * `.artifacts/eval/batch.json` + `results.jsonl` (written by
 * `pnpm eval:real`), renders one self-contained HTML report styled with
 * shadcn/ui (New York design tokens, Tailwind v4 compiled offline and
 * inlined), and PERSISTS it into the repository under
 * `reports/NNN-<stamp>-<model>.html` with a sequential zero-padded number
 * (001, 002, …). The report records the eval metadata — git head,
 * model/provider/reasoning, package versions, timestamps, and the
 * per-run/per-scenario token (reasoning-decomposed), adoption, and
 * retry-success numbers — with click-to-expand drill-down of every tool call
 * read from each run's persisted full session. `reports/index.html` is
 * regenerated as the catalog.
 *
 * Flags: --batch <stamp> selects a historical batch (default: newest).
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EVAL_DIR = join(ROOT, '.artifacts', 'eval')
const REPORTS_DIR = join(ROOT, 'reports')
const FIXTURES_DIR = join(ROOT, 'packages', 'dsh-tool-retry', 'tests', 'eval-fixtures')
const TAILWIND_CSS = join(ROOT, 'scripts', 'report.css')
const TAILWIND_CLI = join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs')

interface BatchMeta {
  stamp: string
  model: string
  provider: string
  reasoning?: string
  stopAt?: string
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
    retryStepReasoningTokens?: number
    postBreakInputTokens: number
    retrySuccess: boolean
    adopted: boolean
    noticeCount: number
    noticeBytes: number
    toolCalls: string[]
    toolCallArguments: string[]
    completed: boolean
    stoppedEarly: boolean
    status: 'completed' | 'cutoff' | 'timeout' | 'error'
    grader: { criterion: string; checks: { name: string; pass: boolean }[] }
    revisions: { scenario: string; grader: string; execution: string; experiment: string }
    resultTexts: string[]
  }
}

interface SessionLine {
  type?: string
  data?: {
    callId?: string
    name?: string
    arguments?: string
    usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
  }
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

/** Post-break assistant messages (the prefix occupies turn 1; the followup starts turn 2). */
function postBreakMessages(record: RunRecord): SessionLine[] {
  const lines = readRunSession(record)
  if (lines === undefined) return []
  return lines.filter(line =>
    line.type === 'assistant/message' && (line.data as { turn?: number }).turn === 2)
}

/** Total output tokens across every post-break model step (the full cost). */
function totalPostBreakOutput(record: RunRecord): number {
  return postBreakMessages(record)
    .reduce((sum, line) => sum + (line.data?.usage?.outputTokens ?? 0), 0)
}

/** Content tokens of one run's retry step (output minus reasoning). */
function contentTokensForRecord(record: RunRecord): number {
  const lines = readRunSession(record)
  const first = lines?.find(line =>
    line.type === 'assistant/message' && (line.data as { turn?: number }).turn === 2)
  const reasoning = first?.data?.usage?.reasoningTokens
    ?? record.summary.retryStepReasoningTokens ?? 0
  return record.summary.retryStepOutputTokens - reasoning
}

interface ScenarioRow {
  scenario: string
  mode: 'native' | 'code'
  onTokens: number
  offTokens: number
  savingsPercent: number
  onContentTokens: number
  offContentTokens: number
  contentSavingsPercent: number
  adoptionRate: number
  onRetryRate: number
  offRetryRate: number
  notices: number
  noticeBytes: number
  onInput: number
  offInput: number
  onTotalOutput: number
  offTotalOutput: number
  totalSavingsPercent: number
  onSteps: number
  offSteps: number
  stepsRatio: number
  onRetryPp: number
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
    const onContentTokens = median(on.map(contentTokensForRecord))
    const offContentTokens = median(off.map(contentTokensForRecord))
    return {
      scenario,
      mode: runs[0]!.mode,
      onTokens,
      offTokens,
      savingsPercent: offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0,
      onContentTokens,
      offContentTokens,
      contentSavingsPercent: offContentTokens > 0 ? Math.round((1 - onContentTokens / offContentTokens) * 1000) / 10 : 0,
      adoptionRate: rate(on.map(run => run.summary.adopted)),
      onRetryRate: rate(on.map(run => run.summary.retrySuccess)),
      offRetryRate: rate(off.map(run => run.summary.retrySuccess)),
      notices: median(on.map(run => run.summary.noticeCount)),
      noticeBytes: median(on.map(run => run.summary.noticeBytes)),
      onInput: median(on.map(run => run.summary.postBreakInputTokens)),
      offInput: median(off.map(run => run.summary.postBreakInputTokens)),
      onTotalOutput: median(on.map(totalPostBreakOutput)),
      offTotalOutput: median(off.map(totalPostBreakOutput)),
      totalSavingsPercent: (() => {
        const onTotal = median(on.map(totalPostBreakOutput))
        const offTotal = median(off.map(totalPostBreakOutput))
        return offTotal > 0 ? Math.round((1 - onTotal / offTotal) * 1000) / 10 : 0
      })(),
      onSteps: median(on.map(run => postBreakMessages(run).length)),
      offSteps: median(off.map(run => postBreakMessages(run).length)),
      stepsRatio: (() => {
        const offSteps = median(off.map(run => postBreakMessages(run).length))
        return offSteps > 0 ? Math.round((median(on.map(run => postBreakMessages(run).length)) / offSteps) * 100) / 100 : 0
      })(),
      onRetryPp: Math.round(rate(on.map(run => run.summary.retrySuccess)) * 100)
        - Math.round(rate(off.map(run => run.summary.retrySuccess)) * 100),
      runs,
    }
  })
}

/* ------------------------------------------------------------------ */
/* shadcn-standard render helpers                                       */
/* ------------------------------------------------------------------ */

const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="size-3.5 shrink-0 transition-transform group-open:rotate-90"><path d="m6 12 4-4-4-4"/></svg>'

/** Badge: savings/adoption sign-colored, shadcn badge anatomy. */
function badge(label: string, tone: 'positive' | 'negative' | 'neutral' = 'neutral'): string {
  const tones = {
    positive: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    negative: 'border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive-foreground',
    neutral: 'border-border bg-muted text-muted-foreground',
  }
  return `<span class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}">${label}</span>`
}

/** Run-status badge (completed / cutoff / timeout / error). */
function statusBadge(status: string): string {
  const map: Record<string, { label: string; tone: 'positive' | 'negative' | 'neutral' }> = {
    completed: { label: '✅ 收敛', tone: 'positive' },
    cutoff: { label: '⏹ 截断', tone: 'neutral' },
    timeout: { label: '⏱ 超时', tone: 'negative' },
    error: { label: '❌ 错误', tone: 'negative' },
  }
  const entry = map[status] ?? { label: status, tone: 'neutral' }
  return badge(entry.label, entry.tone)
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Stat card (shadcn Card) for the overview row. */
function statCard(label: string, value: string, hint: string, tone: 'positive' | 'negative' | 'neutral' = 'neutral'): string {
  return [
    '<div class="rounded-xl border bg-card text-card-foreground shadow-xs p-5 space-y-1.5">',
    `<div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">${label}</div>`,
    `<div class="flex items-center gap-2"><span class="text-2xl font-semibold tracking-tight tabular-nums">${value}</span>${badge(hint, tone)}</div>`,
    '</div>',
  ].join('\n')
}

/** Scenario metadata (human-readable title + description) from scenario.json. */
interface ScenarioMeta { title: string; description: { input: string; expected: string } }

function loadScenarioMeta(name: string): ScenarioMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(FIXTURES_DIR, name, 'scenario.json'), 'utf8')) as ScenarioMeta
    return meta.title === undefined ? undefined : meta
  } catch {
    return undefined
  }
}

/** One A/B statistics table (v3): ROWS = evals (OFF/ON stuck together + a Δ
 * row below each pair), COLUMNS = output metrics. Details live elsewhere. */
function abDiffTable(row: ScenarioRow): string {
  const meta = loadScenarioMeta(row.scenario)
  const onRuns = row.runs.filter(run => run.arm === 'on')
  const offRuns = row.runs.filter(run => run.arm === 'off')
  const reps = [...new Set(row.runs.map(run => run.repetition))].sort((a, b) => a - b)
  const headlineTone = row.contentSavingsPercent >= 10 ? 'positive' : row.contentSavingsPercent <= -10 ? 'negative' : 'neutral'
  const verdict = row.contentSavingsPercent >= 10 ? '特性优势' : row.contentSavingsPercent <= -10 ? '特性劣势' : '中性'
  const pct1 = (value: number): string => `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}%`
  const tokenDiff = (on: number, off: number): { text: string; tone: 'positive' | 'negative' | 'neutral' } => {
    const diff = off - on
    const pct = off > 0 ? diff / off * 100 : 0
    return { text: `${diff > 0 ? '+' : ''}${diff} (${pct1(pct)})`, tone: diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral' }
  }
  const stepDiff = (on: number, off: number): { text: string; tone: 'positive' | 'negative' | 'neutral' } => {
    const diff = off - on
    const ratio = off > 0 ? Math.round(on / off * 10) / 10 : 0
    return { text: `${diff > 0 ? '+' : ''}${diff} (${ratio}×)`, tone: diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral' }
  }
  const ppDiff = (on: number, off: number): { text: string; tone: 'positive' | 'negative' | 'neutral' } => {
    const diff = on - off
    return { text: `${diff > 0 ? '+' : ''}${diff}pp`, tone: diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral' }
  }
  interface MetricSpec {
    name: string
    value: (run: RunRecord) => number
    format: (value: number) => string
    diff: (on: number, off: number) => { text: string; tone: 'positive' | 'negative' | 'neutral' }
  }
  const number = (value: number): string => String(value)
  const metrics: MetricSpec[] = [
    { name: '内容 token', value: contentTokensForRecord, format: number, diff: tokenDiff },
    { name: '断点后步数', value: run => postBreakMessages(run).length, format: number, diff: stepDiff },
    { name: '第一步输出(含推理)', value: run => run.summary.retryStepOutputTokens, format: number, diff: tokenDiff },
    { name: '全程输出(含推理)', value: totalPostBreakOutput, format: number, diff: tokenDiff },
    { name: '断点后输入 token', value: run => run.summary.postBreakInputTokens, format: number, diff: tokenDiff },
    { name: '重试成功率', value: run => run.summary.retrySuccess ? 100 : 0, format: value => percent(value / 100), diff: ppDiff },
    { name: '通知条数', value: run => run.summary.noticeCount, format: number, diff: (on, off) => {
      const diff = off - on
      return { text: diff === 0 ? '0' : `−${Math.abs(diff)}`, tone: diff < 0 ? 'negative' : 'neutral' }
    } },
  ]
  const runValue = (spec: MetricSpec, arm: 'on' | 'off', rep: number): number => {
    const run = (arm === 'on' ? onRuns : offRuns).find(run => run.repetition === rep)
    return run === undefined ? 0 : spec.value(run)
  }
  const medianOf = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  const group = (label: string, onValues: number[], offValues: number[], emphasized: boolean): string => {
    const onCells = metrics.map(spec => `<td class="p-2 text-right align-middle tabular-nums ${emphasized ? 'font-semibold' : ''}">${spec.format(onValues[metrics.indexOf(spec)] ?? 0)}</td>`).join('')
    const offCells = metrics.map(spec => `<td class="p-2 text-right align-middle tabular-nums ${emphasized ? 'font-semibold' : 'text-muted-foreground'}">`
      + `${spec.format(offValues[metrics.indexOf(spec)] ?? 0)}</td>`).join('')
    const diffCells = metrics.map(spec => {
      const d = spec.diff(onValues[metrics.indexOf(spec)] ?? 0, offValues[metrics.indexOf(spec)] ?? 0)
      return `<td class="p-2 text-center align-middle">${savingsCell(d.text, d.tone)}</td>`
    }).join('')
    return [
      '<tr>',
      `<td class="p-2 pl-3 text-right text-xs text-muted-foreground">${label} OFF</td>`,
      offCells,
      '</tr>',
      '<tr>',
      `<td class="p-2 pl-3 text-right text-xs font-medium">${label} ON</td>`,
      onCells,
      '</tr>',
      `<tr class="${emphasized ? 'bg-muted/40' : 'border-b-2'}">`,
      `<td class="p-2 pl-3 text-right text-[11px] font-semibold text-muted-foreground">Δ ${label}</td>`,
      diffCells,
      '</tr>',
    ].join('\n')
  }
  const rows = reps.map(rep =>
    group(`r${rep}`, metrics.map(spec => runValue(spec, 'on', rep)), metrics.map(spec => runValue(spec, 'off', rep)), false)).join('\n')
  const medGroup = group('中位',
    metrics.map(spec => medianOf(onRuns.map(run => spec.value(run)))),
    metrics.map(spec => medianOf(offRuns.map(run => spec.value(run)))),
    true)
  const descriptionBlock = meta === undefined ? '' : [
    '<div class="space-y-1 px-4 py-2 text-xs text-muted-foreground">',
    `<div><span class="font-medium">输入：</span>${escapeHtml(meta.description.input)}</div>`,
    `<div><span class="font-medium">预期结果：</span>${escapeHtml(meta.description.expected)}</div>`,
    '</div>',
  ].join('\n')
  return [
    '<div class="rounded-xl border bg-card text-card-foreground shadow-xs overflow-hidden">',
    '<div class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-3">',
    `<h3 class="text-sm font-semibold tracking-tight">${escapeHtml(meta?.title ?? row.scenario)}</h3>`,
    `<code class="text-xs text-muted-foreground">${escapeHtml(row.scenario)}</code>`,
    `<span class="text-xs text-muted-foreground">${row.mode === 'native' ? 'native' : 'PTC'}</span>`,
    '<span class="ml-auto flex items-center gap-2">',
    badge(`内容 token ${row.contentSavingsPercent >= 0 ? '省' : '多'} ${Math.abs(row.contentSavingsPercent)}%`, headlineTone),
    badge(verdict, headlineTone),
    badge(`采用率 ${percent(row.adoptionRate)}`, row.adoptionRate >= 0.5 ? 'positive' : 'neutral'),
    '</span>',
    '</div>',
    descriptionBlock,
    '<div class="overflow-x-auto">',
    '<table class="w-full caption-bottom text-sm">',
    '<thead class="bg-muted/50 [&_th]:h-10 [&_th]:px-3 [&_th]:text-left [&_th]:align-middle [&_th]:font-medium [&_th]:text-muted-foreground">',
    '<tr><th class="w-24">eval</th>',
    metrics.map(spec => `<th class="text-right">${spec.name}</th>`).join(''),
    '</tr>',
    '</thead>',
    `<tbody>${rows}${medGroup}</tbody>`,
    '</table>',
    '</div>',
    '</div>',
  ].join('\n')
}

/** Ratio cell with sign coloring. */
function savingsCell(ratio: string, tone: 'positive' | 'negative' | 'neutral'): string {
  const tones = {
    positive: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    negative: 'border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive-foreground',
    neutral: 'border-border bg-muted text-muted-foreground',
  }
  return `<span class="inline-flex w-full items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums ${tones[tone]}">${ratio}</span>`
}

/** Run metadata block: experiment identity, grader evidence, per-step tokens. */
function renderRunMeta(record: RunRecord): string {
  const s = record.summary
  const revisions = s.revisions
  const grader = (s.grader?.checks ?? []).map(check =>
    `<li class="flex items-center gap-2"><span>${check.pass ? '✅' : '❌'}</span><span>${escapeHtml(check.name)}</span></li>`).join('')
  const process = readRunProcess(record)
  const stepRows = (process?.perStepTokens ?? []).map(step =>
    `<tr><td class="num">${step.step}</td><td class="num">${step.input}</td><td class="num">${step.output}</td><td class="num">${step.reasoning}</td></tr>`).join('')
  return [
    '<div class="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">',
    `<div><span class="text-muted-foreground">判定准则</span> <code>${escapeHtml(s.grader?.criterion ?? 'unknown')}</code> · experiment <code>${escapeHtml(revisions?.experiment ?? 'unknown')}</code></div>`,
    `<div><span class="text-muted-foreground">修订</span> scenario <code>${escapeHtml(revisions?.scenario ?? '-')}</code> · grader <code>${escapeHtml(revisions?.grader ?? '-')}</code> · execution <code>${escapeHtml(revisions?.execution ?? '-')}</code></div>`,
    grader === '' ? '' : `<div><div class="font-medium text-muted-foreground">grader 证据</div><ul class="space-y-0.5">${grader}</ul></div>`,
    stepRows === '' ? '' : [
      '<div class="font-medium text-muted-foreground">每步 token（step | 输入 | 输出 | 推理）</div>',
      '<table class="w-full text-xs"><thead><tr><th class="text-left">step</th><th class="text-right">in</th><th class="text-right">out</th><th class="text-right">reasoning</th></tr></thead>',
      `<tbody>${stepRows}</tbody></table>`,
    ].join(''),
    '</div>',
  ].join('')
}

/** Read one run's process.json (written alongside the session log). */
function readRunProcess(record: RunRecord): { perStepTokens?: { step: number; input: number; output: number; reasoning: number }[] } | undefined {
  if (record.runDir === undefined) return undefined
  try {
    return JSON.parse(readFileSync(join(EVAL_DIR, record.runDir, 'process.json'), 'utf8')) as never
  } catch {
    return undefined
  }
}

/** Collapsible trace.md embed (dsh-web-review trace parity). */
function renderRunTrace(record: RunRecord): string {
  if (record.runDir === undefined) return ''
  let trace = ''
  try {
    trace = readFileSync(join(EVAL_DIR, record.runDir, 'trace.md'), 'utf8')
  } catch {
    return ''
  }
  return [
    '<details class="group rounded-lg border bg-muted/30">',
    '<summary class="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden [&::marker]:hidden">',
    CHEVRON,
    '<span>trace.md（完整过程轨迹）</span>',
    '</summary>',
    `<pre class="border-t p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto">${escapeHtml(trace)}</pre>`,
    '</details>',
  ].join('\n')
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
  if (calls.length === 0) return '<div class="text-sm text-muted-foreground">（无工具调用）</div>'
  return calls.map((call, index) => [
    '<div class="rounded-lg border bg-muted/30 p-3 space-y-1.5">',
    '<div class="flex items-center gap-2 text-sm font-medium">',
    `<span class="text-muted-foreground">#${index + 1}</span>`,
    `<code class="rounded bg-muted px-1.5 py-0.5 text-xs">${escapeHtml(call.name)}</code>`,
    `<span class="text-xs text-muted-foreground">callId ${escapeHtml(call.callId)}</span>`,
    call.isError ? '<span class="ml-auto"><span class="inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive dark:text-destructive-foreground">失败</span></span>' : '',
    '</div>',
    '<div class="text-xs font-medium text-muted-foreground">参数（原始字符串）</div>',
    `<pre class="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">${escapeHtml(call.arguments)}</pre>`,
    '<div class="text-xs font-medium text-muted-foreground">结果</div>',
    `<pre class="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">${escapeHtml(call.result)}</pre>`,
    '</div>',
  ].join('\n')).join('\n')
}

/** Per-run DETAILS, separated from the statistics table: one standalone
 * accordion card per run (arm/rep/status + meta + grader + per-step tokens +
 * tool calls + trace). */
function runDetailCards(rows: ScenarioRow[]): string {
  return rows.map((row) => {
    const cards = row.runs.map((run) => [
      '<details class="group rounded-lg border bg-card text-card-foreground">',
      '<summary class="flex flex-wrap cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden [&::marker]:hidden">',
      CHEVRON,
      `<span>${run.arm === 'on' ? 'ON' : 'OFF'} r${run.repetition}</span>`,
      statusBadge(run.summary.status ?? (run.summary.completed ? 'completed' : 'error')),
      `<span class="text-xs font-normal text-muted-foreground">工具：${escapeHtml(run.summary.toolCalls.join(', ') || '—')}</span>`,
      '</summary>',
      `<div class="border-t px-3 py-3 space-y-2">${renderRunMeta(run)}${renderRunDetails(run)}${renderRunTrace(run)}</div>`,
      '</details>',
    ].join('\n')).join('\n')
    const meta = loadScenarioMeta(row.scenario)
    return [
      `<section class="space-y-3">`,
      `<h3 class="text-base font-semibold tracking-tight">${escapeHtml(meta?.title ?? row.scenario)} · 每次运行详情</h3>`,
      `<div class="space-y-2">${cards}</div>`,
      `</section>`,
    ].join('\n')
  }).join('\n')
}

/** Minimal tabs: vanilla toggling, no framework (shadcn Tabs look). */
function tabPanels(rows: ScenarioRow[]): string {
  const presentModes = (['native', 'code'] as const).filter(mode => rows.some(row => row.mode === mode))
  const panels = (['native', 'code'] as const).map((mode) => {
    const group = rows.filter(row => row.mode === mode)
    if (group.length === 0) return ''
    const tables = group.map(abDiffTable).join('\n')
    const details = runDetailCards(group)
    // The first present panel is visible on load; the tab handler toggles
    // the rest (and re-hides/shows this one when switching).
    const initial = mode === presentModes[0] ? 'space-y-6' : 'hidden space-y-6'
    return `<div data-panel="${mode}" class="${initial}">${tables}<section class="space-y-6 pt-2">${details}</section></div>`
  })
  const tabs = (['native', 'code'] as const)
    .filter(mode => rows.some(row => row.mode === mode))
    .map((mode, index) => [
      `<button data-tab="${mode}" class="inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${index === 0
        ? 'bg-background text-foreground shadow-xs'
        : 'text-muted-foreground hover:text-foreground'}" aria-pressed="${index === 0}">`,
      mode === 'native' ? 'native 模式' : 'PTC（code）模式',
      '</button>',
    ].join(''))
  return [
    '<div class="space-y-4">',
    '<div class="inline-flex items-center rounded-lg bg-muted p-1 text-muted-foreground">',
    ...tabs,
    '</div>',
    ...panels,
    '</div>',
  ].join('\n')
}

function renderReport(number: number, batch: BatchMeta, rows: ScenarioRow[]): string {
  const onRows = rows.flatMap(row => row.runs.filter(run => run.arm === 'on'))
  const offRows = rows.flatMap(row => row.runs.filter(run => run.arm === 'off'))
  const onTokens = median(onRows.map(run => run.summary.retryStepOutputTokens))
  const offTokens = median(offRows.map(run => run.summary.retryStepOutputTokens))
  const savings = offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0
  const onContent = median(onRows.map(contentTokensForRecord))
  const offContent = median(offRows.map(contentTokensForRecord))
  const contentSavings = offContent > 0 ? Math.round((1 - onContent / offContent) * 1000) / 10 : 0
  const adoption = rate(onRows.map(run => run.summary.adopted))
  const packages = Object.entries(batch.packages)
    .map(([name, version]) => `<li class="text-xs"><code class="rounded bg-muted px-1 py-0.5">${escapeHtml(name)}</code> <span class="text-muted-foreground">${escapeHtml(version)}</span></li>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-tool-retry 评测报告 ${String(number).padStart(3, '0')}</title>
<script>
document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches);
addEventListener('DOMContentLoaded', () => {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[data-tab]')) {
        const active = other === tab;
        other.setAttribute('aria-pressed', String(active));
        other.className = active
          ? 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors bg-background text-foreground shadow-xs'
          : 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors text-muted-foreground hover:text-foreground';
      }
      for (const panel of document.querySelectorAll('[data-panel]')) {
        panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== tab.getAttribute('data-tab'));
      }
    });
  }
});
</script>
<style id="tailwind"></style>
</head>
<body class="min-h-screen bg-background font-sans antialiased">
<div class="mx-auto max-w-6xl space-y-8 px-6 py-10">

<header class="space-y-3">
  <div class="flex flex-wrap items-center gap-3">
    <h1 class="text-3xl font-semibold tracking-tight">dsh-tool-retry 评测报告</h1>
    <span class="inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 text-sm font-semibold tabular-nums">№ ${String(number).padStart(3, '0')}</span>
  </div>
  <p class="text-sm text-muted-foreground">工具调用自动暂存/失败通知/局部编辑重放插件的真实模型评测 —— 断点恢复式续跑，ON（挂载插件）vs OFF（基线）双臂对比。</p>
  <div class="flex flex-wrap items-center gap-2">
    ${badge(`模型 ${escapeHtml(batch.model)}`, 'neutral')}
    ${badge(`provider ${escapeHtml(batch.provider)}`, 'neutral')}
    ${badge(`思考强度 ${escapeHtml(batch.reasoning ?? '默认')}`, 'neutral')}
    ${badge(`每场景每臂重复 ${batch.repeats} 次`, 'neutral')}
    ${badge(`截断策略 ${escapeHtml(batch.stopAt ?? 'idle')}`, 'neutral')}
    ${badge(`git ${escapeHtml(batch.repoHead.slice(0, 12))}`, 'neutral')}
  </div>
</header>

<section class="rounded-xl border bg-card text-card-foreground shadow-xs">
  <div class="grid grid-cols-2 gap-x-8 gap-y-4 p-6 lg:grid-cols-4">
    <div class="space-y-1"><div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">批次 stamp</div><code class="text-sm">${escapeHtml(batch.stamp)}</code></div>
    <div class="space-y-1"><div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">运行时间</div><div class="text-sm tabular-nums">${escapeHtml(batch.startedAt)}</div><div class="text-xs text-muted-foreground tabular-nums">→ ${escapeHtml(batch.finishedAt)}</div></div>
    <div class="space-y-1"><div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">场景</div><div class="text-sm">${batch.scenarios.map(escapeHtml).join('、')}</div></div>
    <div class="space-y-1"><div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">运行期依赖版本</div><ul class="space-y-0.5">${packages}</ul></div>
  </div>
</section>

<section class="space-y-3">
  <h2 class="text-lg font-semibold tracking-tight">总体（全部场景合并，中位数）</h2>
  <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
    ${statCard('ON 内容 token', String(onContent), `${onTokens} 第一步含推理`)}
    ${statCard('OFF 内容 token', String(offContent), `${offTokens} 第一步含推理`)}
    ${statCard('内容 token 节省', `${contentSavings}%`, `${savings}% 含推理`, contentSavings >= 40 ? 'positive' : contentSavings < 0 ? 'negative' : 'neutral')}
    ${statCard('采用率', percent(adoption), `${percent(rate(onRows.map(run => run.summary.retrySuccess)))} 重试成功`, adoption > 0.5 ? 'positive' : 'neutral')}
    ${statCard('全程输出 token（中位）', String(median(onRows.map(totalPostBreakOutput))), `OFF ${median(offRows.map(totalPostBreakOutput))}`, median(onRows.map(totalPostBreakOutput)) <= median(offRows.map(totalPostBreakOutput)) ? 'positive' : 'negative')}
  </div>
</section>

${tabPanels(rows)}

<footer class="space-y-2 border-t pt-6 text-xs text-muted-foreground">
<p>方法说明：每场景 × 臂（ON=挂载插件 / OFF=基线）× ${batch.repeats} 次独立运行；断点快照为持久化的失败工具调用前缀（恢复式续跑）。指标取自断点后的权威会话日志：重试步输出 token = 断点后第一条 assistant/message 的 usage.outputTokens（含推理 token）；内容 token = 输出 token − reasoningTokens，衡量模型实际产出的编辑/重生成文本；「第一步输出」只取断点后第一条 assistant/message（plan §6 指标），「全程输出」合计断点后全部模型步（含推理），两列并看可区分「一轮想得更深」与「多轮重试」；采用 = native 出现 editPreviousToolCalling / PTC 后续 run_code 参数引用 checkpoint 路径；重试成功 = native 断点工具以合法输入重跑（行为级）/ PTC 按 plan §6 判据「断点后的 run_code 调用无 error」。</p>
<p>每次运行的完整会话（全部工具调用的原始参数与结果）已落盘于 .artifacts/eval/runs/，可在上表「完整调用详情」中点击展开；逐条记录见 .artifacts/eval/results.jsonl。本报告由 pnpm eval:report 生成并持久化于仓库 reports/。</p>
</footer>

</div>
</body>
</html>
`
}

/** Compile the shadcn/tailwind stylesheet for one HTML file and inline it. */
function inlineTailwind(htmlPath: string): void {
  const cssPath = `${htmlPath}.css`
  const result = spawnSync(process.execPath, [
    TAILWIND_CLI,
    '-i', TAILWIND_CSS,
    '-o', cssPath,
    '--content', htmlPath,
    '--minify',
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`eval:report — tailwind compile failed: ${result.stderr}`)
  }
  const css = readFileSync(cssPath, 'utf8')
  rmSync(cssPath, { force: true })
  const html = readFileSync(htmlPath, 'utf8').replace('<style id="tailwind"></style>', `<style id="tailwind">\n${css}\n</style>`)
  writeFileSync(htmlPath, html)
}

/** Regenerate the catalog listing every persisted report. */
function renderIndex(batch: BatchMeta, latestNumber: number): void {
  const files = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{3}-.+\.html$/u.test(entry.name))
    .map(entry => entry.name)
    .sort()
  const items = files.map((name) => [
    '<li>',
    '<a class="group block rounded-xl border bg-card text-card-foreground shadow-xs transition-colors hover:bg-muted/50 p-4 space-y-1" '
    + `href="${escapeHtml(name)}">`,
    `<div class="flex items-center gap-2"><span class="text-sm font-semibold tabular-nums">${escapeHtml(name)}</span>${name.includes(batch.stamp) ? badge('最新', 'positive') : ''}</div>`,
    '<div class="text-xs text-muted-foreground">dsh-tool-retry 真实模型评测报告</div>',
    '</a>',
    '</li>',
  ].join('\n')).join('\n')
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-tool-retry 评测报告目录</title>
<script>document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches);</script>
<style id="tailwind"></style>
</head>
<body class="min-h-screen bg-background font-sans antialiased">
<div class="mx-auto max-w-3xl space-y-8 px-6 py-10">
<header class="space-y-2">
  <h1 class="text-3xl font-semibold tracking-tight">dsh-tool-retry 评测报告目录</h1>
  <p class="text-sm text-muted-foreground">最新批次 <code class="rounded bg-muted px-1 py-0.5">${escapeHtml(batch.stamp)}</code> · 最新报告 № ${String(latestNumber).padStart(3, '0')} · 模型 ${escapeHtml(batch.model)}</p>
</header>
<ul class="space-y-3">${items}</ul>
<footer class="border-t pt-6 text-xs text-muted-foreground">由 pnpm eval:report 自动生成。</footer>
</div>
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
inlineTailwind(path)
const indexPath = join(REPORTS_DIR, 'index.html')
renderIndex(batch, number)
inlineTailwind(indexPath)
console.log(`eval:report — wrote ${path}`)
console.log(`eval:report — catalog refreshed at ${indexPath}`)
