/**
 * Keyless resume-mechanics smoke (plan §6 eval infrastructure, exercised
 * without a provider key): every breakpoint prefix fixture resumes through
 * the published session-persistence backend, the ON arm's pre-seeded
 * checkpoint store resolves (the scripted retry succeeds), and the post-break
 * metrics pipeline reports the expected shape. A scripted mock adapter plays
 * the model's retry, so this validates the RESUME + METRICS mechanics — real
 * model behavior is measured by the key-gated eval runner instead.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { loadEvalFixture, runEvalScenario } from './support/real-eval-runner.ts'

const EVAL_FIXTURES = fileURLToPath(new URL('./eval-fixtures', import.meta.url))
const DEADLINE_MS = 30_000

/** The PTC retry program (reads previous/1.json, replaces the marker, runs). */
function ptcRetryProgram(checkpointDir: string): string {
  return [
    '// RETRY-GUARD',
    'const text = (await tools.read({ file_path: "<CP>/previous/1.json" }))',
    '  .lines.map(line => line.text).join("\\n")',
    'const prev = JSON.parse(text)',
    'if (prev.code.includes("RETRY-GUARD")) return { selfRead: true }',
    'const AsyncFunction = (async () => {}).constructor',
    'const fixed = prev.code.replace("v1-" + "marker", "v2-good")',
    'return await new AsyncFunction("tools", "console", "\'use strict\';\\n" + fixed)(tools, console)',
  ].join('\n').replace('<CP>', checkpointDir)
}

/** The PTC from-scratch program (OFF-arm baseline: no checkpoint involved). */
const ptcFreshProgram = 'return await tools.boom({ value: "v2-good" })'

describe('eval resume mechanics (keyless smoke)', () => {
  it('resumes native-invalid-args: ON arm replays the pre-seeded checkpoint, OFF arm regenerates', async () => {
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, 'native-invalid-args'))
    const checkpointDir = join(CHECKPOINT_ROOT, fixture.header.id)

    const on = await runEvalScenario({
      fixture,
      arm: 'on',
      model: 'mock',
      deadlineMs: DEADLINE_MS,
      deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_edit', 'editPreviousToolCalling', {
          call_id: 'break_1',
          old_string: '"label":"payments"',
          new_string: '"kind":"valid","label":"payments"',
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
    expect(on.toolCalls).toEqual(['editPreviousToolCalling'])
    expect(on.noticeCount).toBe(0) // no post-break failures, so no new notices

    const off = await runEvalScenario({
      fixture,
      arm: 'off',
      model: 'mock',
      deadlineMs: DEADLINE_MS,
      deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_retry', 'deploy', { config: { kind: 'valid', label: 'payments' } }),
        textResponse('done'),
      ]),
    })
    expect(off.completed).toBe(true)
    expect(off.adopted).toBe(false)
    expect(off.retrySuccess).toBe(true)
    expect(off.toolCalls).toEqual(['deploy'])
    void checkpointDir
  })

  it('resumes native-invalid-json: the verbatim broken string is edited back to valid JSON', async () => {
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, 'native-invalid-json'))
    const on = await runEvalScenario({
      fixture,
      arm: 'on',
      model: 'mock',
      deadlineMs: DEADLINE_MS,
      deployCalls: [],
      adapter: new MockAdapter([
        // The stored raw string is the BROKEN JSON, stored verbatim; the edit
        // closes the truncated object and the replay parses the fixed text.
        toolCallResponse('sm_edit', 'editPreviousToolCalling', {
          call_id: 'break_2',
          old_string: 'Deployment\\n"',
          new_string: 'Deployment\\n"}}',
        }),
        textResponse('done'),
      ]),
    })
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
    expect(on.noticeCount).toBe(0)
  })

  it('resumes ptc-program-error: ON arm reads the checkpoint in the retry program', async () => {
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, 'ptc-program-error'))
    const checkpointDir = join(CHECKPOINT_ROOT, fixture.header.id)
    const boomCalls: { value: string }[] = []

    const on = await runEvalScenario({
      fixture,
      arm: 'on',
      model: 'mock',
      deadlineMs: DEADLINE_MS,
      boomCalls,
      adapter: new MockAdapter([
        toolCallResponse('sm_rc', 'run_code', {
          code: ptcRetryProgram(checkpointDir),
          description: 'retry with a small correction',
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
    expect(boomCalls).toEqual([{ value: 'v2-good' }])

    const off = await runEvalScenario({
      fixture,
      arm: 'off',
      model: 'mock',
      deadlineMs: DEADLINE_MS,
      boomCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_rc2', 'run_code', { code: ptcFreshProgram, description: 'run the corrected program' }),
        textResponse('done'),
      ]),
    })
    expect(off.adopted).toBe(false)
    expect(off.retrySuccess).toBe(true)
  })
})
