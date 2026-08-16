/**
 * Real agent-loop integration: the full plugin stack over the local
 * filesystem, driven by a scripted mock adapter. Verifies the end-to-end
 * contract — checkpoint + notice land after the failed tool result, the
 * one-call edit replays the original tool, the nested replay is invisible to
 * the checkpoint store, and session disposal removes the directory.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

const SESSION = 'integration-session-1'

async function harness(): Promise<{ ctx: Context; workspace: string; checkpointDir: string; adapter: MockAdapter }> {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-int-'))
  const checkpointDir = join(CHECKPOINT_ROOT, SESSION)
  // A crashed earlier run could leave a stale directory behind; the fixed
  // session id must start clean.
  rmSync(checkpointDir, { recursive: true, force: true })
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'integration test agent' } })
  const adapter = new MockAdapter([])
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolRetry)
  ctx.tools.register(defineTool({
    name: 'boom',
    description: 'fails on value "bad"',
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
      if (String(args.value) === 'bad') throw new Error('boom failed on bad')
      return { ok: true }
    },
  }))
  return { ctx, workspace, checkpointDir, adapter }
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

/** Flat text of every message block in one model request. */
function requestText(request: { messages: readonly { content: readonly { type: string; text?: string }[] }[] }): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
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

describe('agent-loop integration', () => {
  it('checkpoints a failure, injects the notice, and replays the edited call in one step', async () => {
    const { ctx, workspace, checkpointDir, adapter } = await harness()
    liveWorkspace = workspace
    adapter.script.push(
      toolCallResponse('t1', 'boom', { value: 'bad' }),
      textResponse('acknowledged'),
      toolCallResponse('t2', 'editPreviousToolCalling', {
        previous_ordinal: 1,
        old_string: '"bad"',
        new_string: '"good"',
      }),
      textResponse('done'),
    )
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = liveHandle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'call boom with bad' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // 1. The failing call is checkpointed three ways on disk.
    expect(readFileSync(join(checkpointDir, 'by-id', 't1.json'), 'utf8')).toBe('{"value":"bad"}')
    const alias = join(checkpointDir, 'previous', '1.json')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readlinkSync(alias)).toBe('../by-id/t1.json')
    expect(readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8')).toContain('"id":"t1"')

    // 2. The notice reached the NEXT model request, after the tool result.
    const second = adapter.requests[1]
    expect(second).toBeDefined()
    const afterFailure = requestText(second!)
    expect(afterFailure).toContain("Your failed call's arguments were saved.")
    expect(afterFailure).toContain('call id: t1')

    // 3. One editPreviousToolCalling call replays the original tool.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'retry it with a small fix' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    const replayed = results.find((event) => {
      const block = event.data.message.content[0]
      return block?.type === 'tool-result' && block.toolCallId === 't2'
    })
    expect(replayed).toBeDefined()
    const replayBlock = replayed!.data.message.content[0]
    const replayText = replayBlock?.type === 'tool-result'
      ? replayBlock.content.map((block: { type: string; text?: string }) => block.type === 'text' ? block.text ?? '' : '').join('\n')
      : ''
    expect(replayText).toContain('Replayed boom with the edited arguments')
    expect(replayText).toContain('boom ok: true')

    // 4. The edited arguments replaced the checkpoint; the nested replay was
    // not checkpointed itself.
    expect(readFileSync(join(checkpointDir, 'by-id', 't1.json'), 'utf8')).toBe('{"value":"good"}')
    expect(existsSync(join(checkpointDir, 'by-id', 't1:replay.json'))).toBe(false)
    const history = readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8').trim().split('\n')
    expect(history).toHaveLength(2)
    expect(history[1]).toContain('"id":"t2"')
  })

  it('removes the checkpoint directory when the session is disposed', async () => {
    const { ctx, workspace, checkpointDir, adapter } = await harness()
    liveWorkspace = workspace
    adapter.script.push(toolCallResponse('t1', 'boom', { value: 'bad' }), textResponse('ok'))
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent0: {
      const agent = liveHandle.agent
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'call boom' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
    }
    expect(existsSync(join(checkpointDir, 'by-id', 't1.json'))).toBe(true)
    await liveHandle.dispose()
    liveHandle = undefined
    expect(existsSync(checkpointDir)).toBe(false)
  })
})
