/**
 * `editPreviousToolCalling` unit tests: ordinal/call_id routing, selector
 * validation, edit errors, JSON-parse failure, replay passthrough, and the
 * code-mode registration suppression (mirrors the tool-fs edit template).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
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

  it('patch mode: edits a nested field without touching escapes and replays the patched object', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'hi', config: { mode: 'dev', retry: { max: 3 } } }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.text', value: 'patched' }, { path: '.config.mode', value: 'prod' }, { path: '.config.retry.max', value: 5 }],
    }, agent, { step: 2 })
    if (replay.isError) throw new Error(`expected patch replay success: ${textOf(replay.content)}`)
    // The nested echo saw the PATCHED object (text → 'patched'), not the
    // checkpointed one.
    expect(textOf(replay.content)).toContain('echoed: patched')
    // The patch persisted back into the checkpoint without escaping changes.
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"patched","config":{"mode":"prod","retry":{"max":5}}}')
  })

  it('patch mode: deleting a field (no value) and array-index paths', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'hi', config: { mode: 'dev', legacy: 'x', items: ['a', 'b', 'c'] } }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.config.legacy' }, { path: '.config.items[1]' }, { path: '.config.items[0].nope' }],
    }, agent, { step: 2 })
    // .config.items[0].nope fails first — path errors abort the batch.
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('not found')

    const replay2 = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.config.legacy' }, { path: '.config.items[1]' }],
    }, agent, { step: 3 })
    if (replay2.isError) throw new Error(`expected deletion replay success: ${textOf(replay2.content)}`)
    expect(textOf(replay2.content)).toContain('echoed: hi')
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"hi","config":{"mode":"dev","items":["a","c"]}}')
  })

  it('patch mode: rejects a missing path and lists the checkpoint keys', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { config: { mode: 'dev' } }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.config.nope', value: 1 }],
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('not found')
    expect(textOf(replay.content)).toContain('config')
  })

  it('patch mode: non-JSON checkpoint suggests the raw edit mode', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { tex: 'hi' }, agent)
    // Corrupt the checkpoint to non-JSON.
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    fs.files.get(idFile)!.content = 'not json'
    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: idFile.split('/').at(-1)!.replace('.json', ''),
      patch: [{ path: '.x', value: 1 }],
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('not JSON')
  })

  it('patch mode: exactly one edit payload (raw xor patch)', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingEcho(ctx, agent)
    const both = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: '"tex":"hi"',
      new_string: '"text":"hi"',
      patch: [{ path: '.tex', value: 'hi' }],
    }, agent, { step: 2 })
    expect(both.isError).toBe(true)
    expect(textOf(both.content)).toContain('exactly one edit payload')
    const neither = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
    }, agent, { step: 3 })
    expect(neither.isError).toBe(true)
    expect(textOf(neither.content)).toContain('exactly one edit payload')
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
    // with return support, trimmed to the minimal example — no tools.edit.
    expect(rendered).toContain('JSON.parse((await tools.read({ file_path:')
    expect(rendered).toContain('prev.code.replace("const retries = 3"')
    expect(rendered).toContain('run the corrected program as a real function and')
    expect(rendered).toContain('const AsyncFunction = (async () => {}).constructor;')
    expect(rendered).toContain('return await new AsyncFunction("tools", "console",')
    expect(rendered).toContain('Use this only when a small correction is needed')
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
    expect(notice).toContain('apply a literal replace to the real program text')
    expect(notice).toContain('new AsyncFunction("tools", "console"')
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

describe('restart recovery', () => {
  it('resolves the FIRST previous_ordinal after a resume by lazily rebuilding the round map', async () => {
    const { ctx, fs } = await setup()
    // Simulate a resumed session: the log already holds an earlier call whose
    // by-id file exists on disk, but NO direct call has run in this process
    // yet (the round map is still empty — no post-execute ever fired).
    const root = join(CHECKPOINT_ROOT, 'resume-ordinal-session')
    const session = ctx.sessions.create(SessionId('resume-ordinal-session'), {
      seed: [{
        type: 'tool/call', seq: 0, time: 1,
        data: { turn: 1, step: 1, callId: 'old-1', name: 'echo', arguments: '{"tex":"hi"}' },
      }] as never,
    })
    const agent = fakeAgent(session)
    // Pre-seed the checkpoint store exactly as the plugin leaves it on disk.
    fs.files.set(`key:${join(root, 'by-id', 'old-1.json')}`, { content: '{"tex":"hi"}', version: FsVersion('v0') })
    const target = await ctx.fs.resolve(join(root, 'by-id', 'old-1.json'))
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v0') }, { agent })

    // The FIRST call in this process targets the previous message's ordinal —
    // before this fix it always failed (the map rebuilds at post-execute,
    // which runs after the tool body).
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      old_string: '"tex":"hi"',
      new_string: '"text":"hi"',
    }, agent, { turn: 2, step: 1 })
    if (replay.isError) throw new Error(`expected resume replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('Replayed echo with the edited arguments')
    expect(textOf(replay.content)).toContain('echoed: hi')
    // The edit landed on the by-id file (the only real store).
    expect(fs.files.get(`key:${join(root, 'by-id', 'old-1.json')}`)?.content).toBe('{"text":"hi"}')
  })
})
