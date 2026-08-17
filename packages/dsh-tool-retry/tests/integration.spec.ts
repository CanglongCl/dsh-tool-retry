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
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

const SESSION = 'integration-session-1'

/** One scripted response carrying SEVERAL tool-call blocks (one assistant
 * message, model order = block order), mirroring a real parallel round. */
function parallelToolCallResponse(blocks: { rawCallId: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  blocks.forEach(({ rawCallId, name, args }, index) => {
    const callId = CallId(rawCallId)
    const argumentsJson = JSON.stringify(args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
      { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
      { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

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
    description: 'fails when value starts with "bad"',
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
      if (String(args.value).startsWith('bad')) throw new Error('boom failed on bad value')
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

  it('checkpoints every parallel block and replays each one by its ordinal', async () => {
    const { ctx, workspace, checkpointDir, adapter } = await harness()
    liveWorkspace = workspace
    adapter.script.push(
      parallelToolCallResponse([
        { rawCallId: 'p1', name: 'boom', args: { value: 'bad-one' } },
        { rawCallId: 'p2', name: 'boom', args: { value: 'bad-two' } },
      ]),
      // The second model request is generated BEFORE round 2's first direct
      // call runs its post-execute, so the aliases still point at round 1's
      // blocks while the retry message streams — assert the mid-run state.
      (options) => {
        expect(lstatSync(join(checkpointDir, 'previous', '1.json')).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(checkpointDir, 'previous', '1.json'))).toBe('../by-id/p1.json')
        expect(readlinkSync(join(checkpointDir, 'previous', '2.json'))).toBe('../by-id/p2.json')
        // The one next inbox holds BOTH notices (one per failure), after both
        // tool results.
        const afterFailure = requestText(options)
        expect(afterFailure).toContain('call id: p1')
        expect(afterFailure).toContain('call id: p2')
        // Round 2's first block addresses the previous message's first block
        // by ordinal; the SECOND block addresses by call_id (its id was in
        // the failure notice). By the time block 2's body runs, block 1's
        // post-execute has switched the round map — ordinals beyond the
        // first are gone, while call_id routing (by-id + history.jsonl) is
        // round-independent: this is the usage matrix the prompt teaches.
        return parallelToolCallResponse([
          {
            rawCallId: 'r1', name: 'editPreviousToolCalling',
            args: { previous_ordinal: 1, old_string: '"bad-one"', new_string: '"good-one"' },
          },
          {
            rawCallId: 'r2', name: 'editPreviousToolCalling',
            args: { call_id: 'p2', old_string: '"bad-two"', new_string: '"good-two"' },
          },
        ])
      },
      textResponse('done'),
    )
    liveHandle = await ctx.agents.create({
      sessionId: SessionId(SESSION),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = liveHandle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the parallel deploys' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Round 2's first direct call re-pointed the aliases at its own blocks.
    expect(readlinkSync(join(checkpointDir, 'previous', '1.json'))).toBe('../by-id/r1.json')
    expect(readlinkSync(join(checkpointDir, 'previous', '2.json'))).toBe('../by-id/r2.json')

    // Each ordinal replays its own original call with the edited arguments.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix both' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    const resultText = (toolCallId: string): string => {
      const event = results.find(candidate => candidate.data.message.content[0]?.toolCallId === toolCallId)
      expect(event).toBeDefined()
      return (event!.data.message.content[0].content as { type: string; text?: string }[])
        .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    }
    expect(resultText('r1')).toContain('Replayed boom with the edited arguments')
    expect(resultText('r1')).toContain('boom ok: true')
    expect(resultText('r2')).toContain('Replayed boom with the edited arguments')
    expect(resultText('r2')).toContain('boom ok: true')
    // The two replays were sub-dispatches: invisible to the checkpoint store.
    const history = readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8').trim().split('\n')
    expect(history).toHaveLength(4)
    expect(history.map(line => (JSON.parse(line) as { id: string }).id)).toEqual(['p1', 'p2', 'r1', 'r2'])
  })

  it('keeps a failed call editable across rounds: repeated call_id retries', async () => {
    const { ctx, workspace, checkpointDir, adapter } = await harness()
    liveWorkspace = workspace
    adapter.script.push(
      toolCallResponse('m1', 'boom', { value: 'bad' }),
      // First retry: the edited arguments still fail, so the replay errors.
      toolCallResponse('m2', 'editPreviousToolCalling', {
        call_id: 'm1', old_string: '"bad"', new_string: '"bad-again"',
      }),
      // Second retry against the SAME call id: the by-id file survived the
      // intervening rounds (call_id routing never touches the round map).
      toolCallResponse('m3', 'editPreviousToolCalling', {
        call_id: 'm1', old_string: '"bad-again"', new_string: '"good"',
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
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'retry with a small fix' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix it properly now' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const results = agent.session.events.filter(event => event.type === 'tool/result')
    const resultText = (toolCallId: string): string => {
      const event = results.find(candidate => candidate.data.message.content[0]?.toolCallId === toolCallId)
      expect(event).toBeDefined()
      return (event!.data.message.content[0].content as { type: string; text?: string }[])
        .filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    }
    // Retry 1: the edit applied, the replay itself failed (bad-again).
    expect(resultText('m2')).toContain('Replay of boom failed')
    // Retry 2: same call id, edited on top of the stored bad-again — success.
    expect(resultText('m3')).toContain('Replayed boom with the edited arguments')
    expect(resultText('m3')).toContain('boom ok: true')
    // The by-id file ends at the final edit; the failed edit itself was also
    // checkpointed and noticed (zero filtering), replay sub-calls were not.
    expect(readFileSync(join(checkpointDir, 'by-id', 'm1.json'), 'utf8')).toBe('{"value":"good"}')
    expect(existsSync(join(checkpointDir, 'by-id', 'm1:replay.json'))).toBe(false)
    const history = readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8').trim().split('\n')
    expect(history.map(line => (JSON.parse(line) as { id: string }).id)).toEqual(['m1', 'm2', 'm3'])
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
