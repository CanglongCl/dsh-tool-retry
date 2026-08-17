/**
 * Per-session checkpoint store: `by-id/<id>.json` is the only real content
 * store, `previous/N.json` are order aliases rebuilt per round, and
 * `history.jsonl` is the append-only index. All content I/O goes through
 * `ctx.fs`; alias link/unlink goes through {@link LinkOps} because the fs
 * service has no link API (the host process path is used, so non-local
 * backends skip aliases silently).
 * @module dsh-tool-retry/checkpoint
 */

import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { checkpointRootDir, sanitizeId } from './invariant.ts'
import type { ToolCallData } from './invariant.ts'

/** Node-fs link primitives behind an interface (mocked in unit tests). */
export interface LinkOps {
  /** Create the symlink `linkPath` → `target` (atomic temp+rename). */
  symlink(target: string, linkPath: string): void
  /** Remove one file or symlink; missing targets are a no-op. */
  unlink(path: string): void
  /** Basenames under a directory; a missing directory lists empty. */
  list(path: string): string[]
}

let aliasSeq = 0

/** Production link ops on the backend's host process path. */
export const nodeLinkOps: LinkOps = {
  symlink(target: string, linkPath: string): void {
    // The alias parent may not exist yet (first call of a round); the
    // atomic rename below also covers Windows replace-over-existing.
    mkdirSync(dirname(linkPath), { recursive: true })
    const temp = `${linkPath}.tmp-${process.pid}-${aliasSeq++}`
    try {
      symlinkSync(target, temp)
      try {
        renameSync(temp, linkPath)
      } catch {
        rmSync(linkPath, { force: true })
        renameSync(temp, linkPath)
      }
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  },
  unlink(path: string): void {
    rmSync(path, { force: true })
  },
  list(path: string): string[] {
    try {
      return readdirSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  },
}

/** Everything a checkpoint operation needs from the plugin context. */
export interface CheckpointIo {
  readonly fs: FileSystem
  readonly links: LinkOps
  /** Synchronous observation recording (fs/observed) with the caller actor. */
  emitObserved(target: FsTarget, version: FsVersion, actor: object): void
  warn(message: string): void
}

/** One round's ordinal mapping (model order = commit order). */
export interface RoundOrdinal {
  callId: string
  tool: string
}

/** In-memory round state; rebuilt from the session log after a restart. */
export interface RoundState {
  turn: number
  step: number
  ordinals: Map<number, RoundOrdinal>
  size: number
}

/** Per-session checkpoint store; one instance per session under the plugin. */
export class SessionCheckpoint {
  readonly rootDir: string
  round?: RoundState

  constructor(sessionId: string) {
    this.rootDir = checkpointRootDir(sessionId)
  }

  get byIdDir(): string {
    return join(this.rootDir, 'by-id')
  }

  get previousDir(): string {
    return join(this.rootDir, 'previous')
  }

  get historyPath(): string {
    return join(this.rootDir, 'history.jsonl')
  }

  /**
   * Checkpoint one model-direct call: round rebuild/switch, the by-id write,
   * the previous/N alias, the history line, and observation recording.
   * @param io - fs/link/observation facades.
   * @param exec - the call that just ran (the observation actor + signal).
   * @param call - raw `tool/call` data from the session log.
   * @param sessionEvents - the live session log (restart rebuild source).
   */
  async checkpoint(
    io: CheckpointIo,
    exec: ToolExecution,
    call: ToolCallData,
    sessionEvents: readonly unknown[],
  ): Promise<void> {
    // Idempotent: a call already recorded for this round is already stored.
    const live = this.round
    if (live !== undefined
      && live.turn === call.turn && live.step === call.step
      && this.lookupTool(call.callId) !== undefined) {
      return
    }

    if (live === undefined) {
      // Process restart: rebuild the round map from the persisted log tail,
      // keeping only calls whose by-id files really exist on disk (the log
      // also contains the CURRENT call, whose file is being written NOW).
      await this.rebuildFromLog(io, sessionEvents)
      const rebuilt = this.round
      if (rebuilt !== undefined && rebuilt.turn === call.turn && rebuilt.step === call.step) {
        // Resumed mid-round: restore its aliases; a call already recorded
        // there was checkpointed before the restart.
        await this.restoreAliases(io, exec)
        if (this.lookupTool(call.callId) !== undefined) return
      } else {
        await this.startRound(io, call)
      }
    } else if (live.turn !== call.turn || live.step !== call.step) {
      await this.startRound(io, call)
    }

    const round = this.round
    if (round === undefined) {
      // Unreachable: every non-return path above establishes a round.
      throw new Error('dsh-tool-retry: round state lost before checkpoint write')
    }
    const ordinal = round.size + 1
    const idFileName = `${sanitizeId(call.callId)}.json`

    // by-id: the only real content store; call ids are unique per session,
    // so a session never overwrites an earlier call's content.
    const idTarget = await io.fs.resolve(join(this.byIdDir, idFileName))
    const write = await io.fs.writeText(idTarget, call.arguments, undefined, exec.signal)
    io.emitObserved(idTarget, write.version, exec)

    // Record the round mapping as soon as the content store holds the call:
    // alias or history failures must not break ordinal/call_id routing.
    round.ordinals.set(ordinal, { callId: call.callId, tool: call.name })
    round.size = ordinal

    await this.publishAlias(io, exec, ordinal, idFileName, call.arguments)
    await this.appendHistory(io, exec, call, ordinal)
  }

  /** Resolve one ordinal to its call identity, or undefined. */
  lookupOrdinal(ordinal: number): RoundOrdinal | undefined {
    return this.round?.ordinals.get(ordinal)
  }

  /**
   * Lazy round-map recovery (plan decision 11): rebuild the map from the
   * session log when it is absent. The map normally rebuilds at the first
   * direct call's post-execute — which runs AFTER that call's tool body —
   * so the very first ordinal replay after a process restart would miss
   * without this; the replay tool calls it before giving up on an ordinal.
   */
  async ensureRound(io: CheckpointIo, sessionEvents: readonly unknown[]): Promise<void> {
    if (this.round !== undefined) return
    await this.rebuildFromLog(io, sessionEvents)
  }

  /** Resolve one call id to its tool name from the current round. */
  lookupTool(callId: string): string | undefined {
    if (this.round === undefined) return undefined
    for (const entry of this.round.ordinals.values()) {
      if (entry.callId === callId) return entry.tool
    }
    return undefined
  }

  /**
   * Rebuild the round map from the persisted log tail: the last `tool/call`
   * group in model order, filtered to entries whose by-id file exists on
   * disk (a fresh session's log already contains the in-flight call, whose
   * file is not written yet). Memory only — aliases are restored separately.
   */
  async rebuildFromLog(io: CheckpointIo, sessionEvents: readonly unknown[]): Promise<void> {
    const calls: ToolCallData[] = []
    for (const event of sessionEvents) {
      const candidate = event as { type?: string; data?: ToolCallData } | undefined
      if (candidate?.type === 'tool/call' && candidate.data !== undefined) {
        calls.push({ ...candidate.data })
      }
    }
    const last = calls.at(-1)
    if (last === undefined) return
    const group = calls.filter(call => call.turn === last.turn && call.step === last.step)
    const ordinals = new Map<number, RoundOrdinal>()
    let size = 0
    for (const call of group) {
      const idTarget = await io.fs.resolve(join(this.byIdDir, `${sanitizeId(call.callId)}.json`))
      if (await io.fs.stat(idTarget) === undefined) continue
      size += 1
      ordinals.set(size, { callId: call.callId, tool: call.name })
    }
    if (size === 0) return // nothing persisted for this round: treat as fresh
    this.round = { turn: last.turn, step: last.step, ordinals, size }
  }

  /** Switch to a new round: drop every old alias, then start fresh. */
  async startRound(io: CheckpointIo, call: ToolCallData): Promise<void> {
    const previousTarget = await io.fs.resolve(this.previousDir)
    const dir = io.fs.processPath(previousTarget)
    for (const name of io.links.list(dir)) {
      io.links.unlink(join(dir, name))
    }
    this.round = { turn: call.turn, step: call.step, ordinals: new Map(), size: 0 }
  }

  /** Recreate the previous/N aliases of the current round (restart path). */
  async restoreAliases(io: CheckpointIo, exec: ToolExecution): Promise<void> {
    const round = this.round
    if (round === undefined) return
    for (const [ordinal, entry] of round.ordinals.entries()) {
      const idFileName = `${sanitizeId(entry.callId)}.json`
      const idTarget = await io.fs.resolve(join(this.byIdDir, idFileName))
      const content = await io.fs.readText(idTarget, exec.signal)
      await this.publishAlias(io, exec, ordinal, idFileName, content)
    }
  }

  private async publishAlias(
    io: CheckpointIo,
    exec: ToolExecution,
    ordinal: number,
    idFileName: string,
    content: string,
  ): Promise<void> {
    const aliasPath = join(this.previousDir, `${ordinal}.json`)
    const aliasTarget = await io.fs.resolve(aliasPath)
    const aliasHost = io.fs.processPath(aliasTarget)
    const target = join('..', 'by-id', idFileName)
    try {
      io.links.symlink(target, aliasHost)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        // Windows without Developer Mode/admin: degrade to a content copy
        // (content-equal, and observed so edits through it stay permitted).
        const outcome = await io.fs.writeText(aliasTarget, content, undefined, exec.signal)
        io.emitObserved(aliasTarget, outcome.version, exec)
        return
      }
      // Non-local fs backends (e2b): the process path is not local — skip
      // aliases silently; by-id files and notices still carry exact paths.
      io.warn(`dsh-tool-retry: previous/${ordinal}.json alias skipped: ${errorMessage(error)}`)
    }
  }

  private async appendHistory(
    io: CheckpointIo,
    exec: ToolExecution,
    call: ToolCallData,
    ordinal: number,
  ): Promise<void> {
    const historyTarget = await io.fs.resolve(this.historyPath)
    let existing = ''
    try {
      existing = await io.fs.readText(historyTarget, exec.signal)
    } catch (error) {
      // Duck-typed on purpose: the bundle inlines its own FsError class, so
      // `instanceof FsError` never matches the runtime backend's error.
      if ((error as { code?: unknown } | null)?.code !== 'FS_NOT_FOUND') throw error
    }
    const line = `${JSON.stringify({ id: call.callId, tool: call.name, turn: call.turn, step: call.step, ordinal })}\n`
    const outcome = await io.fs.writeText(historyTarget, existing + line, undefined, exec.signal)
    io.emitObserved(historyTarget, outcome.version, exec)
  }
}

/** Best-effort message from an unknown throw. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
