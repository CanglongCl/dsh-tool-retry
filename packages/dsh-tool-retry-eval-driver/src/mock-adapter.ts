/**
 * Scripted mock LLM adapter for the keyless CLI smoke (mirrors the test
 * suite's mock-adapter): each model call consumes the next script entry.
 * The script rides the driver config as JSON chunk arrays, so the smoke
 * passes the same chunk protocol the in-process runner used.
 */

import type {
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Adapter driven by a script; records every request it receives. */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  script: StreamChunk[][] = []

  constructor(script: StreamChunk[][]) {
    super()
    this.script = script
  }

  override resolvedInfo(): LlmResolvedModelInfo {
    return { model: 'mock', reasoning: {} as LlmModelReasoningInfo }
  }

  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('mock adapter: script exhausted')
    for (const chunk of entry) {
      if (chunk.type === 'tool-call-delta' && typeof chunk.id === 'string') {
        yield { ...chunk, id: CallId(chunk.id) }
      } else {
        yield chunk
      }
    }
  }
}
