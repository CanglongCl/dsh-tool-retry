/**
 * `editPreviousToolCalling` unit tests: ordinal/call_id routing, selector
 * validation, edit errors, JSON-parse failure, replay passthrough, and the
 * code-mode registration suppression (mirrors the tool-fs edit template).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'
import { FakeFs, MockLinks, call, fakeAgent, newSession, noticeText, resetCalls, textOf } from './support/fakes.ts'

async function setup(): Promise<{ ctx: Context; fs: FakeFs }> {
  const ctx = new Context()
  ToolRetry.internals.linkOps = new MockLinks()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRetry)
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'echoes text',
    parameters: {
      text: { type: 'string', required: true, description: 'text to echo' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { echoed: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `echoed: ${value.echoed}` }],
    },
    async execute(args) {
      return { echoed: String(args.text) }
    },
  }))
  const fs = ctx.fs as FakeFs
  return { ctx, fs }
}

function rootOf(sessionId: string): string {
  return join(CHECKPOINT_ROOT, sessionId)
}

/** One checkpointed failing `echo` call (typo key `tex`), then the replay. */
async function failingEcho(ctx: Context, agent: Agent): Promise<void> {
  const result = await call(ctx, 'echo', { tex: 'hi' }, agent)
  expect(result.isError).toBe(true)
}

beforeEach(() => {
  resetCalls()
})

describe('editPreviousToolCalling', () => {
  it('edits by previous_ordinal and replays the original tool in one call', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: '"tex":"hi"',
      new_string: '"text":"hi"',
    }, agent, { step: 2 })
    if (replay.isError) throw new Error(`expected replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('Replayed echo with the edited arguments')
    expect(textOf(replay.content)).toContain('echoed: hi')
    expect(replay.meta).toMatchObject({ replayedCallId: 'call-1:replay', toolName: 'echo' })

    // The by-id file holds the edited arguments.
    const root = rootOf(String(session.id))
    expect(fs.files.get(`key:${join(root, 'by-id', 'call-1.json')}`)?.content).toBe('{"text":"hi"}')

    // Zero filtering + nested skip: the edit tool itself is checkpointed,
    // the nested replay is not.
    const history = fs.files.get(`key:${join(root, 'history.jsonl')}`)?.content ?? ''
    const lines = history.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('editPreviousToolCalling')
    expect(fs.files.has(`key:${join(root, 'by-id', 'call-1_replay.json')}`)).toBe(false)
    expect(fs.files.has(`key:${join(root, 'by-id', 'call-1:replay.json')}`)).toBe(false)
  })

  it('routes call_id through history.jsonl for an older call', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)
    // A later round replaces the round map, so call_id must resolve through
    // the history index.
    await call(ctx, 'echo', { text: 'later' }, agent, { step: 2 })

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      old_string: '"tex":"hi"',
      new_string: '"text":"fixed"',
    }, agent, { step: 3 })
    if (replay.isError) throw new Error(`expected replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('echoed: fixed')
  })

  it('rejects both and neither selector', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const both = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1, call_id: 'call-x', old_string: 'a', new_string: 'b',
    }, agent)
    expect(both.isError).toBe(true)
    expect(textOf(both.content)).toContain('exactly one')
    const neither = await call(ctx, 'editPreviousToolCalling', {
      old_string: 'a', new_string: 'b',
    }, agent, { step: 2 })
    expect(neither.isError).toBe(true)
    expect(textOf(neither.content)).toContain('exactly one')
  })

  it('reports a missing ordinal and a missing call id', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const ordinal = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 5, old_string: 'a', new_string: 'b',
    }, agent)
    expect(ordinal.isError).toBe(true)
    expect(textOf(ordinal.content)).toContain('no checkpoint for previous_ordinal 5')
    const unknown = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'no-such-id', old_string: 'a', new_string: 'b',
    }, agent, { step: 2 })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown.content)).toContain('no checkpoint found for call_id "no-such-id"')
  })

  it('surfaces an old_string mismatch from the literal edit', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: 'does-not-appear',
      new_string: 'x',
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('old_string not found')
  })

  it('rejects an edit that breaks the checkpoint JSON', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: '{"tex":"hi"}',
      new_string: 'not json',
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('must remain valid JSON')
  })

  it('propagates a replay failure and still checkpoints/notifies itself', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: '"tex":"hi"',
      new_string: '"text":42',
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('Replay of echo failed')
    // Zero filtering: the failing edit call itself got a notice.
    expect(noticeText(replay.additionalContexts)).toContain('call id: call-2')
  })
})

describe('mode detection', () => {
  it('does not register the replay tool in code mode and injects the PTC section', async () => {
    const ctx = new Context()
    ToolRetry.internals.linkOps = new MockLinks()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    ctx.provide('codeRuntime' as never, { language: 'typescript' } as never)
    await ctx.plugin(FakeFs)
    await ctx.plugin(FsPolicy)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ToolRetry)
    expect(ctx.tools.get('editPreviousToolCalling')).toBeUndefined()

    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const rendered = renderPrompt(assembly)
    expect(rendered).toContain('Tools called INSIDE a program')
    expect(rendered).not.toContain('editPreviousToolCalling')
    // The PTC retry guidance: JSON.parse + literal replace + AsyncFunction-run
    // with return support, plus the loader-checkpoint caveat — no tools.edit.
    expect(rendered).toContain('JSON.parse(r.lines.map(line => line.text)')
    expect(rendered).toContain('prev.code.replace("const retries = 3"')
    expect(rendered).toContain('run the corrected program as a real function and')
    expect(rendered).toContain('const AsyncFunction = (async () => {}).constructor;')
    expect(rendered).toContain('return await run(tools, console);')
    expect(rendered).toContain('its file_path still points at your original program')
    expect(rendered).not.toContain('eval the corrected program in place')
    expect(rendered).not.toContain('eval(fixed);')
    expect(rendered).not.toContain('fix it in place with tools.edit')

    // A failing outer run_code gets the PTC notice: saved + by-id path + the
    // verified retry route (submit the corrected program as the new run).
    // The fake codeRuntime has no worker, so the transport's execute throws
    // and the failure passes through post-execute.
    const failed = await call(ctx, 'run_code', { code: 'throw new Error("boom")' }, agent)
    expect(failed.isError).toBe(true)
    const notice = noticeText(failed.additionalContexts)
    expect(notice).toContain('Your failed `run_code` program was saved.')
    expect(notice).toContain('/by-id/call-1.json')
    expect(notice).toContain('run the corrected program as a function and return')
  })

  it('registers the replay tool and the native section by default', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeFs)
    await ctx.plugin(FsPolicy)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ToolRetry)
    expect(ctx.tools.get('editPreviousToolCalling')).toBeDefined()

    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const rendered = renderPrompt(assembly)
    expect(rendered).toContain('TOOL-CALL CHECKPOINT & REPLAY')
    expect(rendered).toContain('editPreviousToolCalling')
    expect(rendered).not.toContain('Tools called INSIDE a program')
  })
})
