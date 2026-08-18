/**
 * Bundle-boundary regression: load the BUILT lib/index.js (the artifact real
 * deployments load) against the real local filesystem. The bundle inlines its
 * own copies of the DSH classes, so class-identity checks inside the plugin
 * must never gate on runtime backend errors — the first real e2e run caught
 * exactly this with a never-written history.jsonl.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type * as SourcePlugin from '../src/index.ts'
import { CHECKPOINT_ROOT } from '../src/invariant.ts'

const SESSION = 'bundle-boundary-session'
const LIB_PATH = fileURLToPath(new URL('../lib/index.js', import.meta.url))

describe.skipIf(!existsSync(LIB_PATH))('built bundle boundary', () => {
  it('writes by-id + history and notifies across the real class-identity boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-bundle-'))
    const checkpointDir = join(CHECKPOINT_ROOT, SESSION)
    rmSync(checkpointDir, { recursive: true, force: true })
    const ctx = new Context()
    try {
      // The built artifact ships no declarations; it exports the same shape
      // as the source entry.
      // @ts-expect-error -- lib/index.js is a build output with no .d.ts
      const BundledPlugin = await import('../lib/index.js') as typeof SourcePlugin
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: workspace })
      await ctx.plugin(FsPolicy)
      await ctx.plugin(SessionStore)
      await ctx.plugin(BundledPlugin)
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
      const session = ctx.sessions.create(SessionId(SESSION))
      const agent = { id: session.id, session } as never
      const id = 'call-bundle-1'
      const longArgs = JSON.stringify({ detail: 'x'.repeat(200) })
      session.append('tool/call', {
        turn: 1, step: 1, callId: CallId(id), name: 'boom', arguments: longArgs,
      })
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(id),
        name: 'boom',
        arguments: { detail: 'x'.repeat(200) },
        agent,
      })
      expect(result.isError).toBe(true)
      expect(result.additionalContexts?.[0]).toBeDefined()
      expect(readFileSync(join(checkpointDir, 'by-id', `${id}.json`), 'utf8')).toBe(longArgs)
      expect(readFileSync(join(checkpointDir, 'history.jsonl'), 'utf8')).toContain(`"id":"${id}"`)
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
