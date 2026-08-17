/**
 * Layered-env credential loading for the key-gated drivers (eval:real /
 * e2e:real). Mirrors the product's credential chain order — the process
 * environment wins, then the repository `.env`, then `~/.dsh/.env` — so a
 * key staged in the DSH home env file flows into the in-process DeepSeek
 * adapter without ever being printed, committed, or persisted.
 *
 * Only the DEEPSEEK_API_KEY variable is materialized (the one ref the
 * llm-deepseek adapter resolves); other variables are ignored.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The single credential ref this repo's drivers consume. */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Parse one dotenv-style file into a plain record (no interpolation). */
function parseEnvFile(path: string): Record<string, string> {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const entries: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(trimmed)
    if (match === null) continue
    entries[match[1]!] = match[2]!.replace(/^['"]|['"]$/gu, '')
  }
  return entries
}

/**
 * Load the layered env chain into `process.env` for the named variable.
 * The existing environment always wins; nothing is printed.
 * @returns whether the variable is set after loading.
 */
export function loadLayeredEnv(variable: string = API_KEY_ENV): boolean {
  if ((process.env[variable] ?? '').trim() !== '') return true
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  for (const path of [join(repoRoot, '.env'), join(homedir(), '.dsh', '.env')]) {
    const value = parseEnvFile(path)[variable]
    if (value !== undefined && value.trim() !== '') {
      process.env[variable] = value
      return true
    }
  }
  return false
}
