/**
 * Test-local code runtime: executes model programs in-process as async
 * function bodies with the `tools` bindings the code-mode bridge supplied.
 * This mirrors the harness's own FakeRuntime seam (packages/core/tools/tests/
 * code-mode.spec.ts) — the run_code transport, sub-dispatch, parent tokens,
 * and deferContext forwarding all come from the REAL registry, so only the
 * program substrate is faked. Programs are plain JavaScript (no TypeScript
 * transform); top-level `await`/`return` keep their native run_code
 * semantics because the body runs through the AsyncFunction constructor.
 */

import type { Context } from '@deepseek-ai/cordis'
import CodeRuntime from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/** Per-run inspection hook the specs use to observe mid-execution state. */
export type RunObserver = (request: CodeRunRequest) => void

/**
 * In-process code runtime for integration tests. `beforeRun` observers run
 * synchronously before the program executes — the moment a spec needs to
 * assert on-disk state DURING a run_code body (e.g. the previous/ alias
 * still points at the prior round).
 */
export class InlineRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'inline'
  beforeRun?: RunObserver
  requests: CodeRunRequest[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.requests.push(request)
    this.beforeRun?.(request)
    const logs: string[] = []
    const consoleLike = {
      log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
      error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
      warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
      info: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    }
    const globals: string[] = []
    const values: unknown[] = []
    for (const namespace of request.bindings) {
      globals.push(namespace.global)
      // Null-prototype namespace with own properties, mirroring the worker:
      // names like `__proto__` stay ordinary members, and member rejections
      // become instances of the declared error class carrying the member name.
      const members: Record<string, unknown> = Object.create(null)
      for (const [member, fn] of Object.entries(namespace.functions)) {
        let wrapped = fn
        if (namespace.errorClass !== undefined) {
          const ErrorClass = class extends Error {
            [key: string]: unknown
          }
          Object.defineProperty(ErrorClass, 'name', { value: namespace.errorClass.name })
          const memberKey = namespace.errorClass.memberNameProperty
          wrapped = async (args: unknown) => {
            try {
              return await fn(args)
            } catch (error) {
              const failure = new ErrorClass(error instanceof Error ? error.message : String(error)) as Error & { [key: string]: unknown }
              failure[memberKey] = member
              throw failure
            }
          }
        }
        Object.defineProperty(members, member, { enumerable: true, value: wrapped })
      }
      values.push(members)
    }
    try {
      globals.push('console')
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as
        new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
      const fn = new AsyncFunction(...globals, `"use strict";\n${request.program}`)
      const value = await fn(...values, consoleLike)
      return value === undefined ? { logs } : { value: value as never, logs }
    } catch (error) {
      return {
        logs,
        error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}
