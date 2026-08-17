/**
 * Keyless resume-mechanics smoke (plan §6 eval infrastructure, exercised
 * without a provider key): every REAL breakpoint prefix (cropped from actual
 * persisted session logs) resumes through the published persistence backend,
 * the ON arm's pre-seeded checkpoint store resolves (the scripted retry
 * succeeds), and the post-break metrics pipeline reports the expected shape.
 * A scripted mock adapter plays the model's retry, so this validates the
 * RESUME + METRICS mechanics — real model behavior is measured by the
 * key-gated eval runner instead.
 *
 * Scripting note: editPreviousToolCalling edits the checkpoint file's RAW
 * argument text, so its old_string/new_string are matched against the
 * JSON-escaped form (jsonEsc), and the file's current first line anchors the
 * replayed edit in the failure-time workspace state.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { loadEvalFixture, runEvalScenario, type EvalFixture } from './support/real-eval-runner.ts'

const EVAL_FIXTURES = fileURLToPath(new URL('./eval-fixtures', import.meta.url))
const DEADLINE_MS = 30_000

/** Escape a string for matching the checkpoint file's raw JSON text. */
function jsonEsc(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')
}

function fsFixture(name: string): { fixture: EvalFixture; args: Record<string, unknown>; file: { path: string; content: string } } {
  const fixture = loadEvalFixture(join(EVAL_FIXTURES, name))
  const args = JSON.parse(fixture.blocks[0]!.rawArguments) as Record<string, unknown>
  const file = fixture.workspaceFiles![0]!
  return { fixture, args, file }
}

/** The first line of a string-typed argument value (raw-text-safe anchor). */
function firstLine(value: unknown): string {
  return String(value).split('\n')[0]!
}

describe('eval resume mechanics (keyless smoke, REAL corpus)', () => {
  it('real-plan-dismissed: ON revises the checkpointed plan, OFF resubmits fresh', async () => {
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, 'real-plan-dismissed'))
    const args = JSON.parse(fixture.blocks[0]!.rawArguments) as { plan: string }
    const heading = args.plan.split('\n').find(line => line.startsWith('#'))!
    const on = await runEvalScenario({
      fixture, arm: 'on', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_p_on', 'editPreviousToolCalling', {
          call_id: fixture.blocks[0]!.callId,
          old_string: jsonEsc(heading),
          new_string: jsonEsc(`${heading}（修订版）`),
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
    expect(on.noticeCount).toBe(0)

    const off = await runEvalScenario({
      fixture, arm: 'off', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_p_off', 'exit_plan_mode', { plan: `${heading}（修订版）\n\n修订后的计划。` }),
        textResponse('done'),
      ]),
    })
    expect(off.adopted).toBe(false)
    expect(off.retrySuccess).toBe(true)
  })

  it('real-edit-stale: ON re-points the stale old_string at the real file content', async () => {
    const { fixture, args, file } = fsFixture('real-edit-stale')
    // The grader's ground truth is the session's OWN eventual fix (the later
    // edit's new_string), not the recorded failed call's superseded one — the
    // scripted retry re-points old_string at the real file's first line, then
    // swaps the checkpoint's new_string for that fix (each edit replays).
    const fix = fixture.successChecks![0]!.fragment!
    const on = await runEvalScenario({
      fixture, arm: 'on', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_s_read', 'read', { file_path: file.path }),
        toolCallResponse('sm_s_edit1', 'editPreviousToolCalling', {
          call_id: fixture.blocks[0]!.callId,
          old_string: jsonEsc(String(args.old_string)),
          new_string: jsonEsc(firstLine(file.content)),
        }),
        toolCallResponse('sm_s_edit2', 'editPreviousToolCalling', {
          call_id: fixture.blocks[0]!.callId,
          old_string: jsonEsc(String(args.new_string)),
          new_string: jsonEsc(fix),
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
  })

  it('real-edit-unobserved: ON reads first, then replays a corrected edit', async () => {
    const { fixture, args, file } = fsFixture('real-edit-unobserved')
    const on = await runEvalScenario({
      fixture, arm: 'on', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_u_read', 'read', { file_path: file.path }),
        toolCallResponse('sm_u_edit', 'editPreviousToolCalling', {
          call_id: fixture.blocks[0]!.callId,
          old_string: jsonEsc(String(args.old_string)),
          new_string: jsonEsc(firstLine(file.content)),
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)
  })

  it('real-write-overwrite: ON reads first, then replays the write; OFF regenerates', async () => {
    const { fixture, args, file } = fsFixture('real-write-overwrite')
    const contentFirstLine = firstLine(args.content)
    const on = await runEvalScenario({
      fixture, arm: 'on', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_w_read', 'read', { file_path: file.path }),
        toolCallResponse('sm_w_edit', 'editPreviousToolCalling', {
          call_id: fixture.blocks[0]!.callId,
          old_string: jsonEsc(contentFirstLine),
          new_string: jsonEsc(`${contentFirstLine}\n<!-- retry-noop -->`),
        }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)

    const off = await runEvalScenario({
      fixture, arm: 'off', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_w2_read', 'read', { file_path: file.path }),
        toolCallResponse('sm_w2_write', 'write', { file_path: file.path, content: `${String(args.content)}\n// overwrite-fixed` }),
        textResponse('done'),
      ]),
    })
    expect(off.adopted).toBe(false)
    expect(off.retrySuccess).toBe(true)
  })

  it('real-run-code-missing-desc: ON reads the checkpoint and resubmits with a description', async () => {
    const fixture = loadEvalFixture(join(EVAL_FIXTURES, 'real-run-code-missing-desc'))
    const checkpointDir = join(CHECKPOINT_ROOT, fixture.header.id)
    const loader = [
      'const text = (await tools.read({ file_path: "<CP>/previous/1.json" }))',
      '  .lines.map((line) => line.text).join("\\n")',
      'const prev = JSON.parse(text)',
      'if (prev.code.includes("RETRY-GUARD")) return { selfRead: true }',
      'return { codeLength: prev.code.length }',
    ].join('\n').replace('<CP>', checkpointDir)
    const on = await runEvalScenario({
      fixture, arm: 'on', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_rc_on', 'run_code', { code: loader, description: 'retry with the missing description added' }),
        textResponse('done'),
      ]),
    })
    expect(on.completed).toBe(true)
    expect(on.adopted).toBe(true)
    expect(on.retrySuccess).toBe(true)

    const off = await runEvalScenario({
      fixture, arm: 'off', model: 'mock', deadlineMs: DEADLINE_MS, deployCalls: [],
      adapter: new MockAdapter([
        toolCallResponse('sm_rc_off', 'run_code', { code: 'return { ok: true }', description: 'fixed program' }),
        textResponse('done'),
      ]),
    })
    expect(off.adopted).toBe(false)
    expect(off.retrySuccess).toBe(true)
  })
})
