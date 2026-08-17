/**
 * Code-mode (PTC) integration over the REAL agent loop and the REAL run_code
 * transport: the registry's code-mode bridge sub-dispatches program tools
 * with parent tokens, and only the program substrate is faked (InlineRuntime,
 * the same seam the harness's own code-mode.spec uses). Verifies the plan's
 * §5.4 contract — the outer run_code is checkpointed whole, inner tools
 * (including their failures) never checkpoint or notify, caught failures
 * stay silent while uncaught ones notify with the by-id path, the previous/
 * shortcut still points at the prior round DURING the retry program (the
 * round switch happens after the program body), and the retry loop
 * read → JSON.parse → literal replace → AsyncFunction-run works with
 * top-level return/await semantics.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT, PLUGIN_ID } from '../src/invariant.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { InlineRuntime } from './support/inline-runtime.ts'

const SESSION = 'code-mode-integration-session'

/** One run_code call as the model would emit it (code + description). */
function runCodeResponse(rawCallId: string, code: string, description = 'Run the test program'): ReturnType<typeof toolCallResponse> {
  return toolCallResponse(rawCallId, 'run_code', { code, description })
}

async function harness(): Promise<{
  ctx: Context
  workspace: string
  checkpointDir: string
  adapter: MockAdapter
  runtime: InlineRuntime
  boomCalls: { value: string }[]
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-code-'))
  const checkpointDir = join(CHECKPOINT_ROOT, SESSION)
  rmSync(checkpointDir, { recursive: true, force: true })
  const ctx = new Context()
  // Code mode: the wire surface collapses to run_code (the registry's mode
  // config), and InlineRuntime supplies the service behind it.
  await mountAgentLoopTestDependencies(ctx, {
    tools: { mode: 'code' },
    systemPrompt: { persona: 'code-mode integration test agent' },
  })
  await ctx.plugin(InlineRuntime)
  const runtime = ctx.codeRuntime as InlineRuntime
  const adapter = new MockAdapter([])
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(ToolRetry)
  const boomCalls: { value: string }[] = []
  ctx.tools.register(defineTool({
    name: 'boom',
    description: 'fails when value is "v1-marker"',
    parameters: {
      value: { type: 'string', required: true, description: 'value' },
    },
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
  return { ctx, workspace, checkpointDir, adapter, runtime, boomCalls }
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

/** Text of every message block in one model request. */
function requestText(request: { messages: readonly { content: readonly { type: string; text?: string }[] }[] }): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Text of one tool/result content in the session log. */
function resultText(events: readonly { type: string; data: { message: { content: { toolCallId?: string; content?: { type: string; text?: string }[] }[] } } }[], toolCallId: string): string {
  const event = events.find(candidate =>
    candidate.type === 'tool/result' && candidate.data.message.content[0]?.toolCallId === toolCallId)
  expect(event).toBeDefined()
  return (event!.data.message.content[0].content ?? [])
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

let liveHandle: AgentHandle | undefined
let liveWorkspace: string | undefined

afterEach(async () => {
  if (liveHandle !== undefined) {
    await liveHandle.dispose()
    liveHandle = undefined
  }
  if (liveWorkspace !== undefined) {
    rmSync(liveWorkspace, { recursive: true, force: true })
    liveWorkspace = undefined
  }
})

describe('code-mode integration', () => {
  it('checkpoints the whole run_code program, skips inner tools, and only notifies uncaught failures', async () => {
    const { ctx, workspace, checkpointDir, adapter } = await harness()
    liveWorkspace = workspace
    const caught = [
      'try {',
      '  await tools.boom({ value: "bad" })',
      '} catch (error) {',
      '  return { caught: error.name ?? "Error" }',
      '}',
      'return { uncaught: true }',
    ].join('\n')
    adapter.script.push(
      runCodeResponse('c1', caught, 'call boom and catch the failure'),
      runCodeResponse('c2', 'throw new Error("uncaught-boom")', 'throw uncaught'),
      textResponse('done'),
    )
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = liveHandle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'exercise the program' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // c1 succeeded (the inner boom failure was caught): no error, no notice.
    const c1Text = resultText(agent.session.events, 'c1')
    expect(c1Text).toContain('caught')
    expect(requestText(adapter.requests[1]!)).not.toContain('program was saved')

    // c2 failed uncaught: the NEXT request carries the PTC notice with the
    // by-id path, after c2's tool result.
    const c2Text = resultText(agent.session.events, 'c2')
    expect(c2Text).toContain('uncaught-boom')
    const afterFailure = requestText(adapter.requests[2]!)
    expect(afterFailure).toContain('Your failed `run_code` program was saved.')
    expect(afterFailure).toContain(`${checkpointDir}/by-id/c2.json`)

    // Exactly the two outer run_code calls are checkpointed; the inner boom
    // sub-call never was (its minted id never appears under by-id).
    const history = readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8').trim().split('\n')
    expect(history.map(line => (JSON.parse(line) as { id: string }).id)).toEqual(['c1', 'c2'])
    expect(readdirSync(join(checkpointDir, 'by-id')).sort()).toEqual(['c1.json', 'c2.json'])
    // Byte-identical to the model's raw argument string (the whole program).
    for (const id of ['c1', 'c2']) {
      const callEvent = agent.session.events.find(event => event.type === 'tool/call' && event.data.callId === id)
      expect(callEvent).toBeDefined()
      expect(readFileSync(join(checkpointDir, 'by-id', `${id}.json`), 'utf8'))
        .toBe(callEvent!.data.arguments)
      expect(JSON.parse(readFileSync(join(checkpointDir, 'by-id', `${id}.json`), 'utf8')).code).toBeTruthy()
    }
    // The final round's shortcut points at c2's program.
    expect(readlinkSync(join(checkpointDir, 'previous', '1.json'))).toBe('../by-id/c2.json')
  })

  it('replays through previous/1.json: read during execution, parse, literal replace, AsyncFunction-run', async () => {
    const { ctx, workspace, checkpointDir, adapter, runtime, boomCalls } = await harness()
    liveWorkspace = workspace
    const original = [
      '// RETRY-TARGET',
      'return await tools.boom({ value: "v1-marker" })',
    ].join('\n')
    const retry = [
      '// RETRY-GUARD',
      'const text = (await tools.read({ file_path: "<CP>/previous/1.json" }))',
      '  .lines.map(line => line.text).join("\\n")',
      'const prev = JSON.parse(text)',
      'if (prev.code.includes("RETRY-GUARD")) return { selfRead: true }',
      'const AsyncFunction = (async () => {}).constructor',
      'const fixed = prev.code.replace("v1-" + "marker", "v2-good")',
      'return await new AsyncFunction("tools", "console", "\'use strict\';\\n" + fixed)(tools, console)',
    ].join('\n').replace('<CP>', checkpointDir)
    adapter.script.push(
      runCodeResponse('r1', original, 'run the failing program'),
      runCodeResponse('r2', retry, 'retry with a small correction'),
      textResponse('done'),
    )
    // The plan's timing claim: the round switch (alias re-point) happens at
    // the retry call's POST-execute — while its body runs, previous/1.json
    // still names the prior round's checkpoint.
    runtime.beforeRun = (request) => {
      if (request.program.includes('RETRY-GUARD')) {
        expect(lstatSync(join(checkpointDir, 'previous', '1.json')).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(checkpointDir, 'previous', '1.json'))).toBe('../by-id/r1.json')
      }
    }
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = liveHandle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // r1 failed (notice), r2 succeeded — and the corrected program re-ran
    // boom with the replaced value, the behavioral proof of the retry loop.
    const r1Text = resultText(agent.session.events, 'r1')
    expect(r1Text).toContain('v1-marker')
    const r2Text = resultText(agent.session.events, 'r2')
    expect(r2Text).not.toContain('selfRead')
    expect(r2Text).not.toContain('code run failed')
    expect(boomCalls.map(call => call.value)).toEqual(['v1-marker', 'v2-good'])

    // After the retry program finished, its own post-execute re-pointed the
    // shortcut at its own checkpoint (the loader).
    expect(readlinkSync(join(checkpointDir, 'previous', '1.json'))).toBe('../by-id/r2.json')
    expect(existsSync(join(checkpointDir, 'by-id', 'r2.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(checkpointDir, 'by-id', 'r2.json'), 'utf8')).code).toContain('RETRY-GUARD')
  })

  it('registers no replay tool in code mode and rejects a direct call to it', async () => {
    const { ctx, workspace, adapter } = await harness()
    liveWorkspace = workspace
    expect(ctx.tools.get('editPreviousToolCalling')).toBeUndefined()
    adapter.script.push(
      toolCallResponse('d1', 'editPreviousToolCalling', {
        previous_ordinal: 1, old_string: 'a', new_string: 'b',
      }),
      textResponse('done'),
    )
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = liveHandle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'try the native tool' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The registry's code-mode wire surface collapses to run_code, so the
    // direct call errors out (UNKNOWN_TOOL) — and the failure itself was
    // checkpointed + noticed per zero filtering.
    const d1Text = resultText(agent.session.events, 'd1')
    expect(d1Text.toLowerCase()).toMatch(/unknown|not registered|not found/)
    const notice = agent.session.events.find(event =>
      event.type === 'user/message'
      && (event.data.source as { kind?: string; plugin?: string }).plugin === PLUGIN_ID)
    expect(notice).toBeDefined()
  })
})
