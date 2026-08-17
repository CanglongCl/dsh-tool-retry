/**
 * Mechanism verification (plan §5.5): the keyless scripted A/B over
 * @deepseek-ai/dsh-llm-replay. Each scenario replays one breakpoint round
 * (a recorded failing tool call) plus scripted retry steps against the REAL
 * agent loop and tool registry, twice — once with the plugin mounted (ON),
 * once without (OFF). The failure comes from the real tool body, so both
 * arms consume byte-identical scripts and differ only in composition.
 *
 * Per arm the run produces a JSON summary (checkpoint store, notice count
 * and ordering, replay outcome, mechanism token arithmetic) compared against
 * the committed snapshot `<scenario>/<arm>.summary.json`; regenerate the
 * snapshots with MECHANISM_VERIFY_UPDATE=1 pnpm vitest run -- <this spec>.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installLlmReplay } from '@deepseek-ai/dsh-llm-replay'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT, PLUGIN_ID } from '../src/invariant.ts'
import { InlineRuntime } from './support/inline-runtime.ts'

const FIXTURES = fileURLToPath(new URL('./replay-fixtures', import.meta.url))
const UPDATE = process.env.MECHANISM_VERIFY_UPDATE === '1'

/** Structural view of the session log rows this spec reads. */
interface SessionRow {
  type: string
  data: {
    callId?: string
    arguments?: string
    message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[] }[] }
    content?: { type?: string; text?: string }[]
    source?: { plugin?: string }
    turn?: number
  }
}

interface ArmOptions {
  scenario: string
  mode: 'native' | 'code'
  plugin: boolean
}

/** Copy a fixture into a scratch dir, patching the checkpoint-dir token. */
function materialize(source: string, scratch: string, checkpointDir: string): string {
  const text = readFileSync(source, 'utf8').replaceAll('__CHECKPOINT_DIR__', checkpointDir)
  const target = join(scratch, source.split('/').at(-1)!)
  writeFileSync(target, text)
  return target
}

/** Flat text of one tool/result content in the session log. */
function resultText(events: readonly SessionRow[], toolCallId: string): string {
  const event = events.find(candidate =>
    candidate.type === 'tool/result' && candidate.data.message?.content?.[0]?.toolCallId === toolCallId)
  expect(event).toBeDefined()
  const blocks = event!.data.message!.content![0]!.content ?? []
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/** Scripted post-break output tokens (deltas of the retry steps). */
function scriptedRetryTokens(overrideFile: string): number {
  const entries = JSON.parse(readFileSync(overrideFile, 'utf8')) as {
    kind: 'chunks'
    chunks: { type: string; text?: string; argumentsDelta?: string }[]
  }[]
  let tokens = 0
  // Entry 0 is the breakpoint round; every later entry is a scripted retry step.
  for (const entry of entries.slice(1)) {
    for (const chunk of entry.chunks) {
      if (chunk.type === 'text-delta') tokens += (chunk.text ?? '').length
      if (chunk.type === 'tool-call-delta') tokens += (chunk.argumentsDelta ?? '').length
    }
  }
  return tokens
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Run one arm of one scenario to completion and summarize the outcome. */
async function runArm(options: ArmOptions): Promise<Record<string, unknown>> {
  const sessionId = `mechanism-${options.scenario}-${options.plugin ? 'on' : 'off'}`
  const checkpointDir = join(CHECKPOINT_ROOT, sessionId)
  rmSync(checkpointDir, { recursive: true, force: true })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-mech-'))
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-fix-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, {
      tools: options.mode === 'code' ? { mode: 'code' } : {},
      systemPrompt: { persona: 'mechanism verification agent' },
    })
    if (options.mode === 'code') await ctx.plugin(InlineRuntime)
    const deployCalls: { label: string; kind: string }[] = []
    const boomCalls: { value: string }[] = []
    if (options.mode === 'native') {
      ctx.tools.register(defineTool({
        name: 'deploy',
        description: 'deploy a service configuration',
        parameters: { config: { type: 'object', required: true, additionalProperties: true, description: 'the full deployment config' } },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `deployed ${String(value.ok)}` }],
        },
        async execute(args) {
          const config = args.config as { kind: string; label: string }
          deployCalls.push({ label: config.label, kind: config.kind })
          if (config.kind === 'invalid') throw new Error(`deploy rejected config ${config.label}`)
          return { ok: true }
        },
      }))
    } else {
      ctx.tools.register(defineTool({
        name: 'boom',
        description: 'fails when value is "v1-marker"',
        parameters: { value: { type: 'string', required: true, description: 'value' } },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: `boom ok: ${String(value.ok)}` }],
        },
        async execute(args) {
          const value = String(args.value)
          boomCalls.push({ value })
          if (value === 'v1-marker') throw new Error('boom failed on v1-marker')
          return { ok: true }
        },
      }))
    }
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(FsPolicy)
    if (options.mode === 'code') await ctx.plugin(ToolFs)
    if (options.plugin) await ctx.plugin(ToolRetry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const fixtureDir = join(FIXTURES, options.scenario)
    const file = materialize(join(fixtureDir, 'session.jsonl'), scratch, checkpointDir)
    const overrideFile = materialize(join(fixtureDir, 'replay.override.json'), scratch, checkpointDir)
    const replay = installLlmReplay(ctx, {
      file,
      overrideFile,
      providers: [{ id: 'replay', name: 'Replay', models: [{ id: 'replay-1', contextWindow: 128000 }] }],
    })
    const handle: AgentHandle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: workspace },
      agentOptions: { provider: 'replay', model: 'replay-1' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    replay.assertConsumed()

    const events = handle.agent.session.events as unknown as SessionRow[]
    const scrub = (text: string): string => text.replaceAll(checkpointDir, '<checkpoint>')
    const editIds = ['edit_1', 'edit_2', 'rc_2'].filter(id =>
      events.some(event => event.type === 'tool/call' && event.data.callId === id))
    const notices = events.filter(event =>
      event.type === 'user/message' && event.data.source?.plugin === PLUGIN_ID)

    const summary: Record<string, unknown> = {
      scenario: options.scenario,
      arm: options.plugin ? 'on' : 'off',
      mode: options.mode,
      checkpoint: { exists: existsSync(checkpointDir) },
      notices: notices.map((notice) => {
        const text = scrub(notice.data.content?.[0]?.text ?? '')
        // One notice per failed direct call, always after ITS OWN tool/result.
        const id = (/call id: (\S+)/u.exec(text)?.[1] ?? /by-id\/(\S+\.json)/u.exec(text)?.[1] ?? '')
          .replace(/\.json$/u, '')
        const callEvents = events.map((event, index) => ({ event, index }))
        const resultIndex = callEvents.find(({ event }) =>
          event.type === 'tool/result' && event.data.message?.content?.[0]?.toolCallId === id)?.index
        const noticeIndex = events.indexOf(notice)
        const nextAssistant = events.findIndex((event, index) =>
          index > noticeIndex && event.type === 'assistant/message')
        return {
          id,
          afterItsOwnResult: resultIndex !== undefined && noticeIndex > resultIndex,
          beforeNextAssistantMessage: nextAssistant === -1 || noticeIndex < nextAssistant,
          text,
        }
      }),
      replay: {
        edits: editIds.map((id) => ({
          callId: id,
          succeeded: !scrub(resultText(events, id)).toLowerCase().includes('error')
            && resultText(events, id) !== '',
          text: scrub(resultText(events, id)).slice(0, 300),
        })),
        deployCalls: options.mode === 'native' ? deployCalls : undefined,
        boomCalls: options.mode === 'code' ? boomCalls : undefined,
      },
    }
    if (existsSync(checkpointDir)) {
      const byId: Record<string, string> = {}
      for (const name of readdirSync(join(checkpointDir, 'by-id')).sort()) {
        byId[name] = scrub(readFileSync(join(checkpointDir, 'by-id', name), 'utf8'))
      }
      const aliases: Record<string, string> = {}
      for (const name of readdirSync(join(checkpointDir, 'previous')).sort()) {
        const path = join(checkpointDir, 'previous', name)
        aliases[`previous/${name}`] = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : 'copy'
      }
      summary.checkpoint = {
        exists: true,
        history: readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8').trim().split('\n')
          .map(line => JSON.parse(line) as unknown),
        byId,
        aliases,
      }
    }
    // Mechanism token arithmetic (a scripted demonstration, not model data).
    const breakpointArgs = events.find(event =>
      event.type === 'tool/call' && (event.data.callId === 'deploy_1' || event.data.callId === 'rc_1'))
    if (breakpointArgs !== undefined) {
      const regenerate = breakpointArgs.data.arguments ?? ''
      const retryTokens = scriptedRetryTokens(overrideFile)
      summary.tokens = {
        scriptedRetryOutputTokens: retryTokens,
        fullRegenerationOutputTokens: regenerate.length,
        savingsPercent: Math.round((1 - retryTokens / regenerate.length) * 1000) / 10,
        noticeOutputTokens: notices
          .map(notice => (notice.data.content?.[0]?.text ?? '').length)
          .reduce((sum, length) => sum + length, 0),
      }
    }
    await handle.dispose()
    replay.dispose()
    return summary
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    rmSync(checkpointDir, { recursive: true, force: true })
  }
}

/** Hard invariants each arm must hold, beyond the snapshot equality. */
function assertInvariants(summary: Record<string, unknown>, options: ArmOptions): void {
  const checkpoint = summary.checkpoint as { exists: boolean }
  const notices = summary.notices as { afterItsOwnResult: boolean }[]
  const replay = summary.replay as {
    edits: { succeeded: boolean }[]
    deployCalls?: { label: string; kind: string }[]
    boomCalls?: { value: string }[]
  }
  if (options.plugin) {
    expect(checkpoint.exists).toBe(true)
    for (const notice of notices) expect(notice.afterItsOwnResult).toBe(true)
    for (const edit of replay.edits) expect(edit.succeeded).toBe(true)
    if (options.mode === 'native') {
      expect(replay.deployCalls?.map(call => call.kind))
        .toEqual(expect.arrayContaining(['valid']))
    } else {
      expect(replay.boomCalls?.map(call => call.value)).toContain('v2-good')
    }
  } else {
    expect(checkpoint.exists).toBe(false)
    expect(notices).toHaveLength(0)
    for (const edit of replay.edits) expect(edit.succeeded).toBe(false)
  }
}

const SCENARIOS: { scenario: string; mode: 'native' | 'code'; failures: number }[] = [
  { scenario: 'native-long-args', mode: 'native', failures: 1 },
  { scenario: 'native-parallel', mode: 'native', failures: 2 },
  { scenario: 'ptc-run-code', mode: 'code', failures: 1 },
]

describe('mechanism verification (keyless llm-replay A/B)', () => {
  for (const { scenario, mode, failures } of SCENARIOS) {
    it(`${scenario}: ON arm checkpoints, notifies, and replays; OFF arm has none of it`, async () => {
      const on = await runArm({ scenario, mode, plugin: true })
      const off = await runArm({ scenario, mode, plugin: false })
      assertInvariants(on, { scenario, mode, plugin: true })
      assertInvariants(off, { scenario, mode, plugin: false })
      // One notice per failed direct call, exactly; the OFF arm injects none.
      expect((on.notices as unknown[]).length).toBe(failures)
      expect((off.notices as unknown[]).length).toBe(0)

      for (const [arm, summary] of [['on', on], ['off', off]] as const) {
        const snapshotPath = join(FIXTURES, scenario, `${arm}.summary.json`)
        if (UPDATE) {
          writeFileSync(snapshotPath, `${JSON.stringify(summary, null, 2)}\n`)
          continue
        }
        const expected = JSON.parse(readFileSync(snapshotPath, 'utf8')) as unknown
        expect(summary).toEqual(expected)
      }
    })
  }
})
