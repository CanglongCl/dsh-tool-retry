/**
 * Checkpoint pipeline unit tests: direct-only checkpointing, zero-filtered
 * notices, round/alias rebuild, EPERM copy fallback, write-failure degrade,
 * nested-call skip, and restart rebuild — over a FakeFs and the real policy
 * registry (mirrors packages/fs/tool-fs/tests/tools.spec.ts).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsObservation } from '@deepseek-ai/dsh-fs'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { join } from 'node:path'
import * as ToolRetry from '../src/index.ts'
import { CHECKPOINT_ROOT, sanitizeId } from '../src/invariant.ts'
import { FakeFs, MockLinks, call, fakeAgent, newSession, noticeText, resetCalls } from './support/fakes.ts'

async function setup(): Promise<{ ctx: Context; fs: FakeFs; links: MockLinks }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(SessionStore)
  const links = new MockLinks()
  ToolRetry.internals.linkOps = links
  await ctx.plugin(ToolRetry)
  // Register one failing and one succeeding tool for pipeline runs.
  ctx.tools.register(defineTool({
    name: 'boom',
    description: 'always fails',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'boom output' }],
    },
    execute: () => {
      throw new Error('boom failed')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'ok',
    description: 'always succeeds',
    parameters: {
      value: { type: 'string', required: true, description: 'value' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `ok: ${value.value}` }],
    },
    async execute(args) {
      return { value: String(args.value) }
    },
  }))
  const fs = ctx.fs as FakeFs
  return { ctx, fs, links }
}

function rootOf(sessionId: string): string {
  return join(CHECKPOINT_ROOT, sessionId)
}

beforeEach(() => {
  resetCalls()
})

describe('checkpoint pipeline', () => {
  it('checkpoints a successful direct call (by-id + alias + history) and stays silent', async () => {
    const { ctx, fs, links } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const observed: { path: string; kind: FsObservation['kind'] }[] = []
    ctx.on('fs/observed', (target, observation) => {
      observed.push({ path: String(target.targetKey), kind: observation.kind })
    })
    const result = await call(ctx, 'ok', { value: 'hi' }, agent)
    expect(result.isError).toBe(false)
    expect(result.additionalContexts).toBeUndefined()

    const root = rootOf(String(session.id))
    const idKey = [...fs.files.keys()].find(key => key.startsWith(`key:${join(root, 'by-id')}/`))
    expect(idKey).toBeDefined()
    const id = idKey!.slice(`key:${join(root, 'by-id')}/`.length)
    expect(fs.files.get(`key:${join(root, 'by-id', id)}`)?.content).toBe('{"value":"hi"}')

    const aliasTarget = links.entries.get(`key:${join(root, 'previous', '1.json')}`)
    expect(aliasTarget).toBe(`../by-id/${id}`)

    const history = fs.files.get(`key:${join(root, 'history.jsonl')}`)?.content ?? ''
    expect(history.trim().split('\n')).toHaveLength(1)
    const line = JSON.parse(history.trim()) as { id: string; tool: string; turn: number; step: number; ordinal: number }
    expect(line).toMatchObject({ tool: 'ok', turn: 1, step: 1, ordinal: 1 })

    // The by-id file was pre-observed (kind: present).
    expect(observed.some(entry => entry.path === `key:${join(root, 'by-id', id)}` && entry.kind === 'present')).toBe(true)
  })

  it('attaches a minimal notice to every failing direct call (zero filtering)', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)

    // Plain tool failure.
    const failed = await call(ctx, 'boom', {}, agent)
    expect(failed.isError).toBe(true)
    const notice = noticeText(failed.additionalContexts)
    expect(notice).toContain("Your failed call's arguments were saved.")
    expect(notice).toContain('call id: call-1')
    expect(notice).toContain('editPreviousToolCalling')

    // UNKNOWN_TOOL.
    const unknown = await call(ctx, 'no-such-tool', {}, agent, { step: 2 })
    expect(unknown.isError).toBe(true)
    expect(noticeText(unknown.additionalContexts)).toContain('call id: call-2')

    // INVALID_ARGS (the registry rejects the args before the body).
    const invalid = await call(ctx, 'ok', {}, agent, { step: 3 })
    expect(invalid.isError).toBe(true)
    expect(noticeText(invalid.additionalContexts)).toContain('call id: call-3')

    const root = rootOf(String(session.id))
    const history = fs.files.get(`key:${join(root, 'history.jsonl')}`)?.content ?? ''
    expect(history.trim().split('\n')).toHaveLength(3)
  })

  it('documents that an aborted-before-dispatch call bypasses post-execute', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const id = 'call-aborted'
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId(id), name: 'boom', arguments: '{}',
    })
    const aborted = new AbortController()
    aborted.abort()
    const result = await ctx.tools.execute({
      signal: aborted.signal,
      callId: CallId(id),
      name: 'boom',
      arguments: {},
      agent,
    })
    // Registry fact (tools/index.ts): a call cancelled at entry takes the
    // `final-result` stage, which bypasses `tools/post-execute` — the
    // waterfall can never see it, so no checkpoint and no notice exist for
    // this variant. Post-body ABORTED still checkpoints (the waterfall saw
    // the call) but its result replacement happens after our decision.
    expect(result.isError).toBe(true)
    expect(result.additionalContexts).toBeUndefined()
    const root = rootOf(String(session.id))
    expect([...fs.files.keys()].some(key => key.includes(join(root, 'by-id')))).toBe(false)
  })

  it('numbers parallel blocks in model order and re-points aliases on a new round', async () => {
    const { ctx, links } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'ok', { value: 'a' }, agent)
    await call(ctx, 'ok', { value: 'b' }, agent)
    await call(ctx, 'boom', {}, agent)
    const root = rootOf(String(session.id))
    expect(links.entries.get(`key:${join(root, 'previous', '1.json')}`)).toMatch(/^\.\.\/by-id\/call-1\.json$/)
    expect(links.entries.get(`key:${join(root, 'previous', '2.json')}`)).toMatch(/^\.\.\/by-id\/call-2\.json$/)
    expect(links.entries.get(`key:${join(root, 'previous', '3.json')}`)).toMatch(/^\.\.\/by-id\/call-3\.json$/)

    // New round (step 2): the old aliases are dropped before the new one lands.
    await call(ctx, 'ok', { value: 'c' }, agent, { step: 2 })
    expect(links.entries.get(`key:${join(root, 'previous', '1.json')}`)).toMatch(/^\.\.\/by-id\/call-4\.json$/)
    expect(links.entries.has(`key:${join(root, 'previous', '2.json')}`)).toBe(false)
    expect(links.entries.has(`key:${join(root, 'previous', '3.json')}`)).toBe(false)
  })

  it('degrades to an observed content copy when the link layer reports EPERM', async () => {
    const { ctx, fs, links } = await setup()
    links.eperm = true
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    await call(ctx, 'ok', { value: 'copy-me' }, agent)
    const root = rootOf(String(session.id))
    expect(links.entries.size).toBe(0)
    const copy = fs.files.get(`key:${join(root, 'previous', '1.json')}`)
    expect(copy?.content).toBe('{"value":"copy-me"}')
  })

  it('skips the notice when the checkpoint write fails, never blocking the pipeline', async () => {
    const { ctx, fs } = await setup()
    fs.rejectWith = new FsError('read-only', 'FS_SANDBOX_DENIED')
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const result = await call(ctx, 'boom', {}, agent)
    expect(result.isError).toBe(true)
    expect(result.additionalContexts).toBeUndefined()
  })

  it('treats a plain-object FS_NOT_FOUND as a missing history (bundled-class boundary)', async () => {
    const { ctx, fs } = await setup()
    // The built bundle inlines its own FsError class, so the runtime backend
    // throws a DIFFERENT class instance — consumers must duck-type the code.
    fs.plainReadFailures = 1
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    const result = await call(ctx, 'boom', {}, agent)
    expect(result.isError).toBe(true)
    // The history write succeeded despite the foreign-class read error, so
    // the failure still got its notice.
    expect(noticeText(result.additionalContexts)).toContain('call id: call-1')
    const root = rootOf(String(session.id))
    const history = fs.files.get(`key:${join(root, 'history.jsonl')}`)?.content ?? ''
    expect(history).toContain('"id":"call-1"')
  })

  it('never checkpoints or notifies nested sub-dispatches', async () => {
    const { ctx, fs } = await setup()
    const session = newSession(ctx)
    const agent = fakeAgent(session)
    // A real nested dispatch: the outer tool body re-invokes `boom` with a
    // parent token (exactly what the replay tool does).
    ctx.tools.register(defineTool({
      name: 'nested-maker',
      description: 'dispatches a nested failing call',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'nested made' }],
      },
      async execute(_args, exec) {
        if (exec.agent === undefined) throw new Error('nested-maker needs an agent')
        const nested = await ctx.tools.execute({
          callId: CallId('nested-1'),
          name: 'boom',
          arguments: {},
          agent: exec.agent,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          signal: exec.signal,
        })
        if (nested.isError) throw new Error('nested boom failed')
        return {}
      },
    }))
    const result = await call(ctx, 'nested-maker', {}, agent)
    expect(result.isError).toBe(true)
    // Only the outer call is checkpointed; the notice is the outer's.
    const notice = noticeText(result.additionalContexts)
    expect(notice).toContain('call id: call-1')
    const root = rootOf(String(session.id))
    expect(fs.files.has(`key:${join(root, 'by-id', 'nested-1.json')}`)).toBe(false)
    const history = fs.files.get(`key:${join(root, 'history.jsonl')}`)?.content ?? ''
    expect(history.trim().split('\n')).toHaveLength(1)
    expect(history).not.toContain('nested-1')
  })

  it('rebuilds the round map from a resumed session log and resumes mid-round numbering', async () => {
    const first = await setup()
    const session = first.ctx.sessions.create(SessionId('session-resume-1'))
    const agent = fakeAgent(session)
    await call(first.ctx, 'ok', { value: 'one' }, agent)
    await call(first.ctx, 'ok', { value: 'two' }, agent)
    const root = rootOf('session-resume-1')

    // A fresh process: new context, new plugin instance, same session id,
    // same on-disk state (by-id files + aliases copied into the new world).
    const second = await setup()
    for (const [key, stored] of first.fs.files.entries()) {
      if (key.startsWith(`key:${join(root, 'by-id')}/`)) second.fs.files.set(key, stored)
    }
    for (const [linkPath, target] of first.links.entries.entries()) {
      second.links.entries.set(linkPath, target)
    }
    const resumed = second.ctx.sessions.create(SessionId('session-resume-1'), { seed: session.events })
    const resumedAgent = fakeAgent(resumed)

    // Same round continues (same turn/step, new call id): the rebuilt map
    // keeps ordinals 1-2 and the new call takes ordinal 3.
    await call(second.ctx, 'ok', { value: 'three' }, resumedAgent)
    expect(second.links.entries.get(`key:${join(root, 'previous', '1.json')}`)).toMatch(/^\.\.\/by-id\/call-1\.json$/)
    expect(second.links.entries.get(`key:${join(root, 'previous', '3.json')}`)).toMatch(/^\.\.\/by-id\/call-3\.json$/)

    // A later round re-points: the rebuilt aliases get dropped like live ones.
    await call(second.ctx, 'ok', { value: 'four' }, resumedAgent, { step: 2 })
    expect(second.links.entries.get(`key:${join(root, 'previous', '1.json')}`)).toMatch(/^\.\.\/by-id\/call-4\.json$/)
    expect(second.links.entries.has(`key:${join(root, 'previous', '3.json')}`)).toBe(false)
  })
})

describe('invariants', () => {
  it('sanitize makes traversal through call ids impossible', () => {
    expect(sanitizeId('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeId('a:b/c')).toBe('a_b_c')
    expect(sanitizeId('call_00_UIZK3UTd84uighVQ0QPb5398')).toBe('call_00_UIZK3UTd84uighVQ0QPb5398')
  })
})
