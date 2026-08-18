/**
 * Harness-eval support: the per-run staging/seeding/overlay/spawn/harvest and
 * the post-run grading/metrics. Mirrors dsh-web-review's eval runner with the
 * plan's three deltas (resume instead of create, pre-seeded verbatim prefix,
 * real-repo workspace) — everything here runs in the PARENT process; the
 * child is the REAL DSH CLI with the eval driver plugin.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const EVAL_FIXTURES = join(ROOT, 'packages', 'dsh-tool-retry', 'tests', 'eval-fixtures')
export const OUT_DIR = join(ROOT, '.artifacts', 'eval')
export const DRIVER_PKG = join(ROOT, 'packages', 'dsh-tool-retry-eval-driver')
export const PLUGIN_PKG = join(ROOT, 'packages', 'dsh-tool-retry')
export const DRIVER_ALIAS = '@dsh-tool-retry-dev/eval-runner'
export const PLUGIN_ALIAS = '@dsh-tool-retry-dev/plugin'

export interface ScenarioMeta {
  name: string
  mode: 'native' | 'code'
  kind: 'deploy' | 'boom' | 'fs' | 'plan'
  blocks: { callId: string; tool: string; rawArguments: string; errorText: string; turn?: number; step?: number }[]
  continuation: string
  workspaceFiles?: { path: string; content: string }[]
  successChecks?: { kind: 'fileExists' | 'fileContains' | 'writeSucceeded'; path: string; fragment?: string }[]
  workspaceRepo?: { path: string; commit: string }
  model?: { provider: string; model: string; reasoningEffort: string }
  /** Fresh-start minimal scenarios: no recorded prefix; the failure happens
   * inside THIS run so the plugin's notice channel fires for real. */
  fresh?: boolean
  task?: string
  targetTool?: boolean
  /** Scripted plan-review answers for plan scenarios: the first
   * `rejectCount` live reviews are rejected with `feedback` (the recorded
   * user's own words), later reviews auto-approve — the headless profile
   * has no interactive user-questions channel. */
  planReview?: { rejectCount?: number; feedback?: string }
}

export interface LoadedScenario {
  scenario: ScenarioMeta
  header: { id: string; createdAt: number }
  prefixText: string
  /** Rows after the header line (verbatim stored rows, chunk runs included). */
  rows: Record<string, unknown>[]
  /** Seeded row count = the post-break boundary in the harvested log. */
  seededRows: number
}

export function loadScenario(dir: string): LoadedScenario {
  const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as ScenarioMeta
  if (scenario.fresh === true) {
    return {
      scenario,
      header: { id: scenario.name, createdAt: 1 },
      prefixText: '',
      rows: [],
      seededRows: 0,
    }
  }
  const lines = readFileSync(join(dir, 'session-prefix.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '')
  const header = JSON.parse(lines[0]!) as { id: string; createdAt: number }
  return {
    scenario,
    header,
    prefixText: `${lines.join('\n')}\n`,
    rows: lines.slice(1).map(line => JSON.parse(line) as Record<string, unknown>),
    seededRows: lines.length - 1,
  }
}

// --- session-store path derivation (exact ports of the harness format.ts,
// which the backend derives from cwd + id; the parent must seed the SAME
// paths the child will read).

/** Port of the harness's projectKey(cwd). */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** Port of the harness's encodeSegment(id). */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export function sessionLogPath(sessionsRoot: string, cwd: string, sessionId: string): string {
  return join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId), 'session.jsonl')
}

// --- per-run staging ---

/** One batch-shared cache clone per repo (hardlink clones per run). */
const repoCaches = new Map<string, string>()

/** Stage the real repository at the scenario's commit into a fresh dir. */
export function stageWorkspace(loaded: LoadedScenario): string {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-ws-'))
  const repo = loaded.scenario.workspaceRepo
  if (repo !== undefined) {
    let cache = repoCaches.get(repo.path)
    if (cache === undefined) {
      cache = mkdtempSync(join(tmpdir(), 'dsh-tool-retry-eval-repo-'))
      execFileSync('git', ['clone', '-q', '--no-local', repo.path, cache])
      repoCaches.set(repo.path, cache)
    }
    execFileSync('git', ['clone', '-q', '--shared', cache, workspace])
    execFileSync('git', ['-C', workspace, 'checkout', '-q', repo.commit])
  }
  // Failure-time file reconstructions on top of the checkout (the target
  // files' bytes the session actually saw — the only approximation left).
  for (const file of loaded.scenario.workspaceFiles ?? []) {
    const target = join(workspace, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
  return workspace
}

/** Seed the verbatim prefix as the session store file the child resumes.
 * The scrubbed history still names the real repository as ~<sub> (the
 * machine-path neutralization turned /Users/<user>/... into ~/...); the
 * model echoes those paths in its own commands, so the seed REWRITES them
 * to the staged workspace — the resumed run then works inside the eval's
 * workspace root exactly like the real session worked inside its repo. */
export function seedSession(loaded: LoadedScenario, sessionsRoot: string, sessionId: string, workspaceDir: string): string {
  const header = { ...loaded.header, id: sessionId, cwd: workspaceDir }
  const repoSub = loaded.scenario.workspaceRepo === undefined
    ? ''
    : loaded.scenario.workspaceRepo.path.replace(/^\/Users\/[^/]+\//u, '')
  const rewrite = (text: string): string => repoSub === '' ? text : text.replaceAll(`~/${repoSub}`, workspaceDir)
  const text = `${JSON.stringify(header)}\n${loaded.rows.map(row => rewrite(JSON.stringify(row))).join('\n')}\n`
  const path = sessionLogPath(sessionsRoot, workspaceDir, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** The ON arm's checkpoint store, seeded exactly like the plugin leaves it. */
export function seedCheckpoints(loaded: LoadedScenario, sessionId: string): void {
  const root = join(tmpdir(), '.dsh', 'tool-checkpoints', sessionId)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'by-id'), { recursive: true })
  mkdirSync(join(root, 'previous'), { recursive: true })
  const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_')
  const calls = loaded.rows
    .filter(row => row.type === 'tool/call')
    .map(row => row.data as { callId: string; name: string; arguments: string; turn?: number; step?: number })
  const byGroup = new Map<string, typeof calls>()
  for (const call of calls) {
    const key = `${call.turn ?? 1}/${call.step ?? 1}`
    const group = byGroup.get(key)
    if (group === undefined) byGroup.set(key, [call])
    else group.push(call)
  }
  let history = ''
  for (const call of calls) {
    const key = `${call.turn ?? 1}/${call.step ?? 1}`
    const ordinal = (byGroup.get(key) ?? []).indexOf(call) + 1
    writeFileSync(join(root, 'by-id', `${sanitize(call.callId)}.json`), call.arguments)
    history += `${JSON.stringify({ id: call.callId, tool: call.name, turn: call.turn ?? 1, step: call.step ?? 1, ordinal })}\n`
  }
  const lastGroup = [...byGroup.entries()].at(-1)?.[1] ?? []
  lastGroup.forEach((call, index) => {
    symlinkSync(`../by-id/${sanitize(call.callId)}.json`, join(root, 'previous', `${index + 1}.json`))
  })
  writeFileSync(join(root, 'history.jsonl'), history)
}

export interface RunConfig {
  sessionId: string
  arm: 'on' | 'off'
  mode: 'native' | 'code'
  provider: string
  model: string
  reasoningEffort: string
  wake: { kind: 'empty' } | { kind: 'user'; text: string }
  mockScript?: unknown[]
  /** Retry-success criterion JSON — the driver stop-at cut. */
  grader: { kind: 'deploy' | 'boom' | 'fs' | 'plan'; mode: 'native' | 'code'; checks: { kind: string; path: string; fragment?: string }[] }
  start: { kind: 'fresh'; task: string } | { kind: 'resume'; sessionId: string }
  targetTool: boolean
  /** JSON { rejectCount?, feedback? } — scripted plan-review answers. */
  planReview?: string
}

/** Write the per-run cordis overlay (the dsh-web-review writeOverlay port). */
export function writeOverlay(runDir: string, config: RunConfig, sessionsRoot: string): string {
  const rows: string[] = [
    '- id: headless-runner',
    '  disabled: true',
    '- insert:',
    '    - id: dsh-tool-retry-eval-runner',
    `      name: '${DRIVER_ALIAS}'`,
    '      config:',
    `        sessionId: ${config.sessionId}`,
    `        wake: '${JSON.stringify(config.wake).replaceAll("'", "''")}'`,
    `        provider: ${config.provider}`,
    `        model: ${config.model}`,
    ...(config.reasoningEffort === '' ? [] : [`        reasoningEffort: ${config.reasoningEffort}`]),
    ...(config.mockScript === undefined ? [] : [`        mock: '${JSON.stringify(config.mockScript).replaceAll("'", "''")}'`]),
    `        grader: '${JSON.stringify(config.grader).replaceAll("'", "''")}'`,
    `        start: '${JSON.stringify(config.start).replaceAll("'", "''")}'`,
    `        targetTool: '${config.targetTool ? 'true' : 'false'}'`,
    ...(config.planReview === undefined ? [] : [`        planReview: '${JSON.stringify(config.planReview).replaceAll("'", "''")}'`]),
  ]
  if (config.arm === 'on') {
    rows.push('    - id: tool-retry', `      name: '${PLUGIN_ALIAS}'`)
  }
  rows.push(
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${sessionsRoot}`,
    '    packChunks: false',
    '    compression: none',
    '- id: telemetry-otel',
    '  disabled: true',
    '',
  )
  const path = join(runDir, 'eval.cordis.yml')
  writeFileSync(path, rows.join('\n'))
  return path
}

export interface SpawnOutcome {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** Spawn the REAL DSH CLI headless with the overlay (web-review contract). */
export function spawnRun(bin: string, workspaceDir: string, overlayPath: string, dshHome: string, mode: 'native' | 'code', timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
        // The headless STARTUP still parses a positional task (the runner is
    // disabled by the overlay); pass a neutral constant the model never sees.
    const child = spawn(process.execPath, [bin, '--profile', 'headless', '--patch', overlayPath, 'evaluation run'], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_TOOLS_MODE: mode,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

// --- post-run harvest + grading ---

export interface RunRow {
  type: string
  data: {
    callId?: string
    name?: string
    arguments?: string
    content?: { type?: string; text?: string }[]
    source?: { plugin?: string }
    usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    message?: { content?: { toolCallId?: string; content?: { type?: string; text?: string }[]; isError?: boolean }[] }
    reason?: { kind?: string }
    turn?: number
    step?: number
  }
}

/** The per-kind retry-success criterion (ported from the runner). */
export function computeRetrySuccess(scenario: ScenarioMeta, mode: 'native' | 'code', postBreak: RunRow[], workspaceDir: string): boolean {
  const callNamesById = new Map(postBreak
    .filter(event => event.type === 'tool/call')
    .map(event => [event.data.callId, event.data.name ?? '']))
  const directOk = (toolName: string): boolean => postBreak.some(event =>
    event.type === 'tool/result'
    && event.data.message?.content?.some(block =>
      callNamesById.get(block.toolCallId) === toolName && block.isError !== true) === true)
  const resultTexts = postBreak
    .filter(event => event.type === 'tool/result')
    .map(event => (event.data.message?.content?.[0]?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n'))
  const fsChecksPass = (scenario.successChecks ?? []).every((check) => {
    const path = join(workspaceDir, check.path)
    if (check.kind === 'fileExists') return existsSync(path)
    if (check.kind === 'writeSucceeded') {
      const writeCallIds = postBreak
        .filter(event => event.type === 'tool/call' && event.data.name === 'write'
          && (event.data.arguments ?? '').includes(`"${check.path}"`))
        .map(event => event.data.callId)
      return postBreak.some(event =>
        event.type === 'tool/result'
        && event.data.message?.content?.some(block =>
          writeCallIds.includes(block.toolCallId) && block.isError !== true) === true)
        || resultTexts.some(text => text.includes('Replayed write'))
    }
    if (check.fragment === undefined) return false
    try {
      return readFileSync(path, 'utf8').includes(check.fragment)
    } catch {
      return false
    }
  })
  switch (scenario.kind) {
    case 'deploy':
      return false
    case 'boom':
      return mode === 'native' ? false : directOk('run_code')
    case 'fs':
      return mode === 'native' ? fsChecksPass : directOk('run_code') && fsChecksPass
    case 'plan':
      return mode === 'native'
        // A re-submission lands as a pending review (no headless user can
        // accept it) — landing without error IS the successful retry.
        ? directOk('exit_plan_mode') || resultTexts.some(text => text.includes('plan accepted: true'))
        : directOk('run_code')
  }
}

/** The immutable experiment identity (the web-review experimentId pattern):
 * the same (scenario, arm, mode, model, reasoning, repetition, repoHead,
 * execution) hashes identically across launches, so a batch re-run can skip
 * already-completed records. */
export function revisionsFor(
  loaded: LoadedScenario,
  mode: 'native' | 'code',
  arm: 'on' | 'off',
  reasoning: string,
  repetition: number,
  repoHead: string,
): { scenario: string; grader: string; execution: string; experiment: string } {
  const revisionInput = {
    scenario: readFileSync(join(EVAL_FIXTURES, loaded.scenario.name, 'scenario.json'), 'utf8'),
    grader: JSON.stringify({ kind: loaded.scenario.kind, mode, checks: loaded.scenario.successChecks ?? [] }),
    execution: readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  }
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  const experiment = sha(JSON.stringify({
    scenario: sha(revisionInput.scenario),
    arm,
    mode,
    model: loaded.scenario.model?.model ?? 'deepseek-v4-flash',
    reasoning,
    repetition,
    repoHead,
    execution: sha(revisionInput.execution),
  }))
  return {
    scenario: sha(revisionInput.scenario),
    grader: sha(revisionInput.grader),
    execution: sha(revisionInput.execution),
    experiment,
  }
}

/** Build the post-run summary record (the report's RunRecord.summary shape). */
export function buildSummary(
  loaded: LoadedScenario,
  mode: 'native' | 'code',
  arm: 'on' | 'off',
  sessionId: string,
  events: RunRow[],
  workspaceDir: string,
  runStatus: 'completed' | 'timeout' | 'error',
  revision: { repetition: number; repoHead: string },
  reasoning: string,
): Record<string, unknown> {
  const postBreak = events.slice(loaded.seededRows)
  const firstAssistant = postBreak.find(event => event.type === 'assistant/message')
  const retryStepOutputTokens = firstAssistant?.data.usage?.outputTokens ?? 0
  const retryStepReasoningTokens = firstAssistant?.data.usage?.reasoningTokens ?? 0
  const postBreakInputTokens = postBreak
    .filter(event => event.type === 'assistant/message')
    .reduce((sum, event) => sum + (event.data.usage?.inputTokens ?? 0), 0)
  const retrySuccess = computeRetrySuccess(loaded.scenario, mode, postBreak, workspaceDir)
  const toolCalls = postBreak.filter(event => event.type === 'tool/call').map(event => event.data.name ?? '')
  const toolCallArguments = postBreak.filter(event => event.type === 'tool/call').map(event => event.data.arguments ?? '')
  const nameByCallId = new Map(postBreak
    .filter(event => event.type === 'tool/call')
    .map(event => [event.data.callId, event.data.name ?? '']))
  const adopted = mode === 'native'
    ? postBreak.some(event =>
      event.type === 'tool/result'
      && nameByCallId.get(event.data.message?.content?.[0]?.toolCallId) === 'editPreviousToolCalling'
      && event.data.message?.content?.some(block => block.isError !== true) === true)
    : postBreak.some(event =>
      event.type === 'tool/result'
      && nameByCallId.get(event.data.message?.content?.[0]?.toolCallId) === 'run_code'
      && event.data.message?.content?.some(block => block.isError !== true) === true
      && toolCallArguments.some(text => text.includes('previous/1.json') || text.includes('/by-id/')))
  // Attempt adoption: how many times the model chose the replay path,
  // regardless of whether the attempt succeeded (adopted counts only
  // successful replays).
  const replayAttempts = mode === 'native'
    ? postBreak.filter(event => event.type === 'tool/call' && event.data.name === 'editPreviousToolCalling').length
    : postBreak.filter(event =>
      event.type === 'tool/call'
      && event.data.name === 'run_code'
      && ((event.data.arguments ?? '').includes('previous/1.json') || (event.data.arguments ?? '').includes('/by-id/'))).length
  const notices = postBreak.filter(event =>
    event.type === 'user/message' && event.data.source?.plugin === '@canglongcl/dsh-tool-retry')
  const lastTurnEnd = [...events].reverse().find(event => event.type === 'turn/end')
  const revisions = revisionsFor(loaded, mode, arm, reasoning, revision.repetition, revision.repoHead)
  return {
    scenario: loaded.scenario.name,
    arm,
    mode,
    sessionId,
    prefixEventCount: loaded.seededRows,
    retryStepOutputTokens,
    retryStepReasoningTokens,
    postBreakInputTokens,
    retrySuccess,
    adopted,
    replayAttempts,
    noticeCount: notices.length,
    noticeBytes: notices.reduce((sum, event) =>
      sum + (event.data.content?.find(block => block.type === 'text')?.text?.length ?? 0), 0),
    toolCalls,
    toolCallArguments,
    completed: lastTurnEnd?.data.reason?.kind === 'completed',
    stoppedEarly: false,
    status: runStatus,
    grader: {
      criterion: `${loaded.scenario.kind}/${mode}`,
      checks: (() => {
        if (loaded.scenario.kind === 'fs') {
          return (loaded.scenario.successChecks ?? []).map((check) => {
            const path = join(workspaceDir, check.path)
            if (check.kind === 'writeSucceeded') {
              return { name: `writeSucceeded ${check.path} (successful post-break write)`, pass: retrySuccess }
            }
            const pass = check.kind === 'fileExists'
              ? existsSync(path)
              : check.fragment !== undefined && (() => {
                try {
                  return readFileSync(path, 'utf8').includes(check.fragment)
                } catch {
                  return false
                }
              })()
            return { name: `${check.kind} ${check.path}${check.fragment === undefined ? '' : ` contains ${check.fragment.slice(0, 30)}`}`, pass }
          })
        }
        if (loaded.scenario.kind === 'plan') return [{ name: 'exit_plan_mode accepted / run_code ok', pass: retrySuccess }]
        if (loaded.scenario.kind === 'boom') return [{ name: 'post-break run_code completed without error', pass: retrySuccess }]
        return []
      })(),
    },
    revisions,
    resultTexts: postBreak
      .filter(event => event.type === 'tool/result')
      .map(event => (event.data.message?.content?.[0]?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n')),
  }
}

/** Copy the child's harvested session log + workspace into the run dir.
 * The exact session path is tried first; otherwise the sessions root is
 * scanned for the newest log (the web-review collectSessionLog fallback —
 * fresh sessions may derive a different project dir under the backend). */
export function collectArtifacts(sessionsRoot: string, workspaceDir: string, sessionId: string, runDir: string): void {
  mkdirSync(runDir, { recursive: true })
  const log = sessionLogPath(sessionsRoot, workspaceDir, sessionId)
  if (existsSync(log)) {
    copyFileSync(log, join(runDir, 'session.jsonl'))
  } else {
    const found: { path: string; mtime: number }[] = []
    const walk = (dir: string): void => {
      let entries: string[] = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
          .map(entry => join(dir, entry.name))
      } catch { return }
      for (const entry of entries) {
        try {
          if (statSync(entry).isDirectory()) walk(entry)
          else if (entry.endsWith('session.jsonl')) found.push({ path: entry, mtime: statSync(entry).mtimeMs })
        } catch { /* skip */ }
      }
    }
    walk(sessionsRoot)
    const newest = found.sort((a, b) => b.mtime - a.mtime)[0]
    if (newest !== undefined) copyFileSync(newest.path, join(runDir, 'session.jsonl'))
  }
  mkdirSync(join(runDir, 'workspace'), { recursive: true })
  cpSync(workspaceDir, join(runDir, 'workspace'), {
    recursive: true,
    filter: (source) => !source.includes(`${join('node_modules')}`) && !source.endsWith('.git'),
  })
}
