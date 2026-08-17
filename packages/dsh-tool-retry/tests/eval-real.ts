/**
 * Real-model evaluation (plan §6), runnable via `pnpm eval:real` (the
 * repo-level wrapper spawns this file) or `pnpm exec tsx
 * packages/dsh-tool-retry/tests/eval-real.ts`. Auto-skips (exit 0) when
 * DEEPSEEK_API_KEY is absent.
 *
 * For every breakpoint fixture (eval-fixtures/) × arm (ON/OFF) × N repeats,
 * the runner resumes the recorded prefix through the published persistence
 * backend and lets the real model continue from the breakpoint. Per-scenario
 * JSON and an aggregated native/PTC table (token savings, adoption rate,
 * retry success, notice overhead) land under .artifacts/eval/ (gitignored).
 *
 * Env: DEEPSEEK_API_KEY (required; absent = skip),
 *      DSH_EVAL_MODEL (default deepseek-v4-flash),
 *      DSH_EVAL_REPEATS (default 3),
 *      DSH_EVAL_TIMEOUT_MS (per-arm deadline, default 15 min).
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEvalFixture, runEvalScenario, type EvalRunSummary } from './support/real-eval-runner.ts'

const EVAL_FIXTURES = fileURLToPath(new URL('./eval-fixtures', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../../../.artifacts/eval', import.meta.url))
const MODEL = process.env.DSH_EVAL_MODEL ?? 'deepseek-v4-flash'
const REPEATS = Math.max(1, Number(process.env.DSH_EVAL_REPEATS ?? 3))
const DEADLINE_MS = Number(process.env.DSH_EVAL_TIMEOUT_MS ?? 15 * 60 * 1000)

if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.trim() === '') {
  console.log('eval:real SKIPPED — DEEPSEEK_API_KEY is not set (provider-key gated, not part of the commit gate)')
  process.exit(0)
}

const scenarios = readdirSync(EVAL_FIXTURES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

interface ScenarioReport {
  scenario: string
  mode: 'native' | 'code'
  model: string
  repeats: number
  arms: {
    on: EvalRunSummary[]
    off: EvalRunSummary[]
  }
  medians: {
    onRetryStepOutputTokens: number
    offRetryStepOutputTokens: number
    tokenSavingsPercent: number
    onAdoptionRate: number
    onRetrySuccessRate: number
    offRetrySuccessRate: number
    noticeCount: number
    noticeBytes: number
  }
}

const reports: ScenarioReport[] = []
for (const name of scenarios) {
  const fixture = loadEvalFixture(join(EVAL_FIXTURES, name))
  const on: EvalRunSummary[] = []
  const off: EvalRunSummary[] = []
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    console.log(`eval:real ${name} arm=on repeat=${rep}/${REPEATS} ...`)
    on.push(await runEvalScenario({
      fixture, arm: 'on', model: MODEL, deadlineMs: DEADLINE_MS, deployCalls: [], boomCalls: [],
    }))
  }
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    console.log(`eval:real ${name} arm=off repeat=${rep}/${REPEATS} ...`)
    off.push(await runEvalScenario({
      fixture, arm: 'off', model: MODEL, deadlineMs: DEADLINE_MS, deployCalls: [], boomCalls: [],
    }))
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  const onTokens = median(on.map(run => run.retryStepOutputTokens))
  const offTokens = median(off.map(run => run.retryStepOutputTokens))
  reports.push({
    scenario: name,
    mode: fixture.mode,
    model: MODEL,
    repeats: REPEATS,
    arms: { on, off },
    medians: {
      onRetryStepOutputTokens: onTokens,
      offRetryStepOutputTokens: offTokens,
      tokenSavingsPercent: offTokens > 0 ? Math.round((1 - onTokens / offTokens) * 1000) / 10 : 0,
      onAdoptionRate: on.filter(run => run.adopted).length / REPEATS,
      onRetrySuccessRate: on.filter(run => run.retrySuccess).length / REPEATS,
      offRetrySuccessRate: off.filter(run => run.retrySuccess).length / REPEATS,
      noticeCount: median(on.map(run => run.noticeCount)),
      noticeBytes: median(on.map(run => run.noticeBytes)),
    },
  })
}

mkdirSync(OUT_DIR, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
for (const report of reports) {
  writeFileSync(join(OUT_DIR, `${report.scenario}.${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`)
}

console.log('\n==== dsh-tool-retry real-model evaluation ====')
console.log(`model=${MODEL} repeats=${REPEATS} scenarios=${reports.length}`)
for (const mode of ['native', 'code'] as const) {
  const group = reports.filter(report => report.mode === mode)
  if (group.length === 0) continue
  console.log(`\n[${mode}]`)
  console.log('scenario                  tokenSave%  adopt%  retryOK(on)  retryOK(off)  notices  noticeBytes')
  for (const report of group) {
    const m = report.medians
    console.log(
      `${report.scenario.padEnd(24)} ${String(m.tokenSavingsPercent).padStart(9)} `
      + `${String(Math.round(m.onAdoptionRate * 100)).padStart(6)} `
      + `${String(Math.round(m.onRetrySuccessRate * 100)).padStart(11)} `
      + `${String(Math.round(m.offRetrySuccessRate * 100)).padStart(12)} `
      + `${String(m.noticeCount).padStart(7)} ${String(m.noticeBytes).padStart(11)}`,
    )
  }
}
console.log(`\nreports: ${OUT_DIR}`)
// The eval reports model behavior; exit non-zero only on runner-level failure
// (every run reached completion). Adoption/retry metrics are observations.
const allCompleted = reports.every(report => [...report.arms.on, ...report.arms.off].every(run => run.completed))
process.exit(allCompleted ? 0 : 1)
