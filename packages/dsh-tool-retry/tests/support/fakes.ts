/**
 * Shared test fakes: an in-memory fs provider (recording intents, versions,
 * and observations through the real policy), a mock link layer, and the
 * execute/session helpers every spec builds on.
 */

import { Context } from '@deepseek-ai/cordis'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LinkOps } from '../../src/checkpoint.ts'

export const testSignal = new AbortController().signal

interface StoredFile {
  content: string
  version: FsVersion
}

/** In-memory fs provider with real literal-edit semantics. */
export class FakeFs extends FileSystem {
  files = new Map<string, StoredFile>()
  rejectWith?: FsError
  /** When > 0, readText throws a PLAIN object (bundled-class boundary). */
  plainReadFailures = 0
  writeIntents: (FsWriteIntent | undefined)[] = []
  editIntents: ({ version: FsVersion } | undefined)[] = []
  private counter = 0

  private nextVersion(): FsVersion {
    this.counter += 1
    return FsVersion(`v${this.counter}`)
  }

  private throwIfArmed(): void {
    if (this.rejectWith) throw this.rejectWith
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(`key:${path}`), displayPath: `/abs/${path}` }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.targetKey}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.targetKey === parent.targetKey
      || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`)
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    this.throwIfArmed()
    const stored = this.files.get(target.targetKey)
    if (stored === undefined) return undefined
    return { version: stored.version, type: 'file', size: stored.content.length }
  }

  override async lstat(_path: string): Promise<FsPathInfo | undefined> {
    return undefined
  }

  override async readText(target: FsTarget): Promise<string> {
    this.throwIfArmed()
    if (this.plainReadFailures > 0) {
      this.plainReadFailures -= 1
      // A plain object, deliberately NOT an FsError instance: the built
      // bundle carries its own class identity, so consumers must duck-type.
      throw { code: 'FS_NOT_FOUND', message: `not found: ${target.displayPath}` }
    }
    const stored = this.files.get(target.targetKey)
    if (stored === undefined) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    return stored.content
  }

  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }

  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const content = await this.readText(target)
    const bytes = new TextEncoder().encode(content)
    if (bytes.length > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
    return bytes
  }

  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> {
    return []
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    this.throwIfArmed()
    this.writeIntents.push(expected)
    const before = this.files.get(target.targetKey)?.content ?? null
    const version = this.nextVersion()
    this.files.set(target.targetKey, { content, version })
    return { operation: before !== null ? 'update' : 'create', version, before, after: content }
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    this.throwIfArmed()
    this.editIntents.push(expected)
    const stored = this.files.get(target.targetKey)
    const before = stored?.content ?? ''
    if (!before.includes(edit.oldString)) {
      throw new FsError(`old_string not found in ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (!edit.replaceAll) {
      const count = before.split(edit.oldString).length - 1
      if (count > 1) {
        throw new FsError(`old_string appears ${count} times in ${target.displayPath}; use replace_all`, 'FS_NOT_FOUND')
      }
    }
    const after = before.split(edit.oldString).join(edit.newString)
    const version = this.nextVersion()
    this.files.set(target.targetKey, { content: after, version })
    return { version, before, after }
  }
}

/** In-memory link layer; `eperm` arms the Windows copy-fallback path. */
export class MockLinks implements LinkOps {
  entries = new Map<string, string>()
  calls: { target: string; linkPath: string }[] = []
  eperm = false
  failWith: NodeJS.ErrnoException | undefined

  symlink(target: string, linkPath: string): void {
    this.calls.push({ target, linkPath })
    if (this.eperm) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    if (this.failWith) throw this.failWith
    this.entries.set(linkPath, target)
  }

  unlink(path: string): void {
    this.entries.delete(path)
  }

  list(path: string): string[] {
    const prefix = `${path}/`
    return [...this.entries.keys()]
      .filter(linkPath => linkPath.startsWith(prefix))
      .map(linkPath => linkPath.slice(prefix.length))
  }
}

let sessionCounter = 0

/** Create one fresh in-store session for a test. */
export function newSession(ctx: Context, seed?: readonly SessionEvent[]): Session {
  sessionCounter += 1
  return ctx.sessions.create(SessionId(`session-test-${sessionCounter}`), seed === undefined ? undefined : { seed })
}

/** Minimal agent facade — everything the plugin reads lives on the session. */
export function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

let callCounter = 0

/** Reset the module-wide call-id counter (per-test stable ids). */
export function resetCalls(): void {
  callCounter = 0
}

/** Options for the execute helper. */
export interface ExecOptions {
  turn?: number
  step?: number
  raw?: string
}

/** Append the tool/call event and run one call through the real registry. */
export function call(ctx: Context, name: string, args: unknown, agent?: Agent, options: ExecOptions = {}) {
  callCounter += 1
  const id = `call-${callCounter}`
  if (agent !== undefined) {
    agent.session.append('tool/call', {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      callId: CallId(id),
      name,
      arguments: options.raw ?? JSON.stringify(args),
    })
  }
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(id),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Text content of a result's content blocks. */
export function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Text of one result's first attached additional context, or undefined. */
export function noticeText(contexts: readonly { content: readonly ContentBlock[] }[] | undefined): string | undefined {
  return contexts?.[0] === undefined ? undefined : textOf(contexts[0].content)
}
