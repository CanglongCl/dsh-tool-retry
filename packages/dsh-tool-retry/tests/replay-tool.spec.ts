/**
 * `editPreviousToolCalling` unit tests: ordinal/call_id routing, selector
 * validation, patch entry validation (value | old/new), path errors,
 * JSON-parse failure, replay passthrough, and the code-mode registration
 * suppression (mirrors the tool-fs edit template).
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
  ctx.tools.register(defineTool({
    name: 'submit',
    description: 'submits a mode; the body rejects any mode other than "prod"',
    parameters: {
      mode: { type: 'string', required: true, description: 'the mode to submit' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `submit ok: ${String(value.ok)}` }],
    },
    async execute(args) {
      if (String(args.mode) !== 'prod') throw new Error('mode must be "prod"')
      return { ok: true }
    },
  }))
  const fs = ctx.fs as FakeFs
  return { ctx, fs }
}

function rootOf(sessionId: string): string {
  return join(CHECKPOINT_ROOT, sessionId)
}

/** One checkpointed failing `submit` call (`mode: "dev"`). */
async function failingSubmit(ctx: Context, agent: Agent): Promise<void> {
  const result = await call(ctx, 'submit', { mode: 'dev' }, agent)
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
    await failingSubmit(ctx, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', value: 'prod' }],
    }, agent, { step: 2 })
    if (replay.isError) throw new Error(`expected replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('Replayed submit with the edited arguments')
    expect(textOf(replay.content)).toContain('submit ok: true')
    expect(replay.meta).toMatchObject({ replayedCallId: 'call-1:replay', toolName: 'submit' })

    // The by-id file holds the edited arguments.
    const root = rootOf(String(session.id))
    expect(fs.files.get(`key:${join(root, 'by-id', 'call-1.json')}`)?.content).toBe('{"mode":"prod"}')

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
    await failingSubmit(ctx, agent)
    // A later round replaces the round map, so call_id must resolve through
    // the history index.
    await call(ctx, 'submit', { mode: 'prod' }, agent, { step: 2 })

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.mode', value: 'prod' }],
    }, agent, { step: 3 })
    if (replay.isError) throw new Error(`expected replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('submit ok: true')
  })

  it('rejects both and neither selector', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const both = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1, call_id: 'call-x', patch: [{ path: '.mode', value: 'prod' }],
    }, agent)
    expect(both.isError).toBe(true)
    expect(textOf(both.content)).toContain('exactly one')
    const neither = await call(ctx, 'editPreviousToolCalling', {
      patch: [{ path: '.mode', value: 'prod' }],
    }, agent, { step: 2 })
    expect(neither.isError).toBe(true)
    expect(textOf(neither.content)).toContain('exactly one')
  })

  it('reports a missing ordinal and a missing call id', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const ordinal = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 5, patch: [{ path: '.mode', value: 'prod' }],
    }, agent)
    expect(ordinal.isError).toBe(true)
    expect(textOf(ordinal.content)).toContain('no checkpoint for previous_ordinal 5')
    const unknown = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'no-such-id', patch: [{ path: '.mode', value: 'prod' }],
    }, agent, { step: 2 })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown.content)).toContain('no checkpoint found for call_id "no-such-id"')
  })

  it('surfaces an old_string mismatch from a string-internal edit', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingSubmit(ctx, agent)
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', old_string: 'does-not-appear', new_string: 'x' }],
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('old_string was not found in the value at ".mode"')
  })

  it('propagates a replay failure and still checkpoints/notifies itself', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingSubmit(ctx, agent)
    // The patched args break the schema (mode must be a string) — the nested
    // replay fails, and the failing edit call itself is checkpointed and
    // notified (zero filtering).
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', value: 42 }],
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('Replay of submit failed')
    expect(noticeText(replay.additionalContexts)).toContain('call id: call-2')
  })
})

describe('patch entries', () => {
  it('value form: edits nested fields and replays the patched object', async () => {
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
    // The patch persisted back into the checkpoint.
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"patched","config":{"mode":"prod","retry":{"max":5}}}')
  })

  it('old/new form: matches the DECODED text of a stringified-JSON value (no escaping)', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'hi', payload: '{"mode":"dev"}' }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.payload', old_string: '"mode":"dev"', new_string: '"mode":"prod"' }],
    }, agent, { step: 2 })
    if (replay.isError) throw new Error(`expected old/new replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('echoed: hi')
    // The checkpoint stores the RAW string: the inner quotes are escaped
    // there, but the model wrote plain quotes — the replace ran on the
    // decoded value and the escaped form was never touched by hand.
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"hi","payload":"{\\"mode\\":\\"prod\\"}"}')
  })

  it('old/new form: long string values edit only the changed fragment', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const plan = 'Section A — 1000 chars of surrounding text. THE MARKER TO FIX. Section Z — more text.'
    await call(ctx, 'echo', { text: 'hi', plan }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.plan', old_string: 'THE MARKER TO FIX', new_string: 'FIXED' }],
    }, agent, { step: 2 })
    if (replay.isError) throw new Error(`expected fragment replay success: ${textOf(replay.content)}`)
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toContain('FIXED')
    expect(fs.files.get(idFile)!.content).toContain('Section Z')
  })

  it('old/new form: multiple matches require uniqueness or replace_all; empty new_string deletes', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'a a b' }, agent)

    const ambiguous = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.text', old_string: 'a', new_string: 'x' }],
    }, agent, { step: 2 })
    expect(ambiguous.isError).toBe(true)
    expect(textOf(ambiguous.content)).toContain('appears 2 times')

    const replaceAll = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.text', old_string: 'a', new_string: 'x', replace_all: true }],
    }, agent, { step: 3 })
    if (replaceAll.isError) throw new Error(`expected replace_all success: ${textOf(replaceAll.content)}`)
    expect(textOf(replaceAll.content)).toContain('echoed: x x b')
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"x x b"}')

    const deleted = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.text', old_string: 'x x b', new_string: '' }],
    }, agent, { step: 4 })
    if (deleted.isError) throw new Error(`expected empty-new_string success: ${textOf(deleted.content)}`)
    expect(fs.files.get(idFile)!.content).toBe('{"text":""}')
  })

  it('old/new form: rejects a non-string target and points at value', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'hi', count: 3 }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.count', old_string: 'a', new_string: 'b' }],
    }, agent, { step: 2 })
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('does not point to a string')
    expect(textOf(replay.content)).toContain('use value')
  })

  it('deleting a field (no value, no old/new) and array-index paths', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'echo', { text: 'hi', config: { mode: 'dev', legacy: 'x', items: ['a', 'b', 'c'] } }, agent)

    const replay = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.config.legacy' }, { path: '.config.items[1]' }, { path: '.config.items[0].nope' }],
    }, agent, { step: 2 })
    // .config.items[0].nope fails — path errors abort the batch.
    expect(replay.isError).toBe(true)
    expect(textOf(replay.content)).toContain('not found')
    // The failed replay's own notice points back at the ORIGINAL call id
    // (retry the original, not the failed attempt) — and no keys line.
    const chase = noticeText(replay.additionalContexts)
    expect(chase).toContain('To retry with a small fix:')
    expect(chase).toContain('call id "call-1"')
    expect(chase).not.toContain('checkpoint keys')

    const replay2 = await call(ctx, 'editPreviousToolCalling', {
      call_id: 'call-1',
      patch: [{ path: '.config.legacy' }, { path: '.config.items[1]' }],
    }, agent, { step: 3 })
    if (replay2.isError) throw new Error(`expected deletion replay success: ${textOf(replay2.content)}`)
    expect(textOf(replay2.content)).toContain('echoed: hi')
    const idFile = [...fs.files.keys()].find(key => key.includes('by-id'))!
    expect(fs.files.get(idFile)!.content).toBe('{"text":"hi","config":{"mode":"dev","items":["a","c"]}}')
  })

  it('rejects a missing path and lists the checkpoint keys', async () => {
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

  it('rejects a non-JSON checkpoint', async () => {
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

  it('validates entry payloads (value xor old/new, empty patch)', async () => {
    const { ctx } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await failingSubmit(ctx, agent)
    const both = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', value: 'prod', old_string: 'dev', new_string: 'prod' }],
    }, agent, { step: 2 })
    expect(both.isError).toBe(true)
    expect(textOf(both.content)).toContain('must carry exactly one of: value, or old_string + new_string')
    const half = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', old_string: 'dev' }],
    }, agent, { step: 3 })
    expect(half.isError).toBe(true)
    expect(textOf(half.content)).toContain('old_string and new_string must be provided together')
    const empty = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [],
    }, agent, { step: 4 })
    expect(empty.isError).toBe(true)
    expect(textOf(empty.content)).toContain('patch must contain at least one entry')
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

    // A failing outer run_code gets the PTC notice: saved + by-id path, and
    // the recipe pointer (the recipe itself lives in the static section).
    const failed = await call(ctx, 'run_code', { code: 'throw new Error("boom")' }, agent)
    expect(failed.isError).toBe(true)
    const notice = noticeText(failed.additionalContexts)
    expect(notice).toContain('Your failed `run_code` program was saved.')
    expect(notice).toContain('/by-id/call-1.json')
    expect(notice).toContain('follow the retry recipe in the "TOOL-CALL')
    expect(notice).not.toContain('apply a literal replace to the real program text')
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
    // The static section carries three XML-shaped retry examples (one field,
    // not the whole call); the rules live in the tool's own description.
    expect(rendered).toContain('plan rejected — fix the section the user pointed out and resubmit')
    expect(rendered).toContain('{ path: ".plan", old_string: "继续用 Python 实现", new_string: "改为 Rust 实现" }')
    expect(rendered).toContain('<tool_call>editPreviousToolCalling')
    expect(rendered).toContain('{ path: ".old_string", old_string: "2.0.0。", new_string: "2.1.0。" }')
    expect(rendered).toContain('{ path: ".offset", value: 1 }')
    expect(rendered).not.toContain('patch (preferred for JSON arguments)')
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
        data: { turn: 1, step: 1, callId: 'old-1', name: 'submit', arguments: '{"mode":"dev"}' },
      }] as never,
    })
    const agent = fakeAgent(session)
    // Pre-seed the checkpoint store exactly as the plugin leaves it on disk.
    fs.files.set(`key:${join(root, 'by-id', 'old-1.json')}`, { content: '{"mode":"dev"}', version: FsVersion('v0') })
    const target = await ctx.fs.resolve(join(root, 'by-id', 'old-1.json'))
    ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion('v0') }, { agent })

    // The FIRST call in this process targets the previous message's ordinal —
    // before this fix it always failed (the map rebuilds at post-execute,
    // which runs after the tool body).
    const replay = await call(ctx, 'editPreviousToolCalling', {
      previous_ordinal: 1,
      patch: [{ path: '.mode', value: 'prod' }],
    }, agent, { turn: 2, step: 1 })
    if (replay.isError) throw new Error(`expected resume replay success: ${textOf(replay.content)}`)
    expect(textOf(replay.content)).toContain('Replayed submit with the edited arguments')
    expect(textOf(replay.content)).toContain('submit ok: true')
    // The edit landed on the by-id file (the only real store).
    expect(fs.files.get(`key:${join(root, 'by-id', 'old-1.json')}`)?.content).toBe('{"mode":"prod"}')
  })
})
