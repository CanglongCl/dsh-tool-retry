/**
 * Eval control panel: a dependency-free HTTP server that gives the user a
 * clickable trigger for the real-harness evaluation plus live progress.
 *
 * - POST /start — spawns the harness-eval batch (one at a time; 409 while a
 *   batch runs). Body (JSON): { repeat, concurrency, scenario?, arm?, mode?, force? }.
 * - GET /api/status — live state: running pid/stamp/elapsed, the output ring
 *   buffer, and per-run progress parsed from results.jsonl + run dirs.
 * - GET /reports/* — the committed report catalog (open the finished report).
 * - GET / — the control panel (vanilla JS, 2s polling).
 *
 * Usage: DSH_HARNESS=<harness> pnpm eval:web   (port 8090 by default)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSessionLines, type SessionLine } from './eval-report.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.DSH_EVAL_WEB_PORT ?? 8090)
const HARNESS = process.env.DSH_HARNESS?.trim() ?? ''
const RUNS_DIR = join(ROOT, '.artifacts', 'eval', 'runs')
const ARCHIVE_DIR = process.env.DSH_EVAL_ARCHIVE_DIR?.trim() || join(homedir(), '.dsh', 'eval-archives')

/** Serve one evidence file from the live runs tree, then the archive (plain
 * or .gz). Returns undefined when neither machine location has it. */
function readEvidence(rel: string): Buffer | undefined {
  if (rel === '' || rel.includes('..') || rel.startsWith('/')) return undefined
  const candidates = [
    { root: RUNS_DIR, path: join(RUNS_DIR, rel), gz: false },
    { root: ARCHIVE_DIR, path: join(ARCHIVE_DIR, rel), gz: false },
    { root: ARCHIVE_DIR, path: join(ARCHIVE_DIR, `${rel}.gz`), gz: true },
  ]
  for (const candidate of candidates) {
    const path = resolve(candidate.path)
    if (!path.startsWith(candidate.root + sep)) continue
    if (existsSync(path) && statSync(path).isFile()) {
      const raw = readFileSync(path)
      return candidate.gz ? gunzipSync(raw) : raw
    }
  }
  return undefined
}

function serveEvidence(res: ServerResponse, urlPath: string): void {
  const rel = urlPath.slice('/evidence/'.length).split('?')[0] ?? ''
  if (rel.endsWith('/session.html')) {
    const base = rel.slice(0, -'/session.html'.length)
    const session = readEvidence(`${base}/session.jsonl`)
    if (session === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('evidence not available on this machine (no live run dir and no archive entry)')
      return
    }
    let breakpoint = 0
    const record = readEvidence(`${base}/record.json`)
    if (record !== undefined) {
      try {
        breakpoint = (JSON.parse(record.toString('utf8')) as { summary?: { prefixEventCount?: number } }).summary?.prefixEventCount ?? 0
      } catch { /* keep 0 */ }
    }
    let lines: SessionLine[] = []
    try {
      lines = session.toString('utf8').split('\n').filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as SessionLine)
    } catch { /* render empty on parse failure */ }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderSessionLines(lines, breakpoint))
    return
  }
  const file = readEvidence(rel)
  if (file === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('evidence not found')
    return
  }
  const type = rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/x-ndjson; charset=utf-8'
  res.writeHead(200, { 'content-type': type })
  res.end(file)
}

interface BatchState {
  pid: number | undefined
  stamp: string | undefined
  startedAt: number | undefined
  finishedAt: number | undefined
  exitCode: number | undefined
  config: { repeat: number; concurrency: number; scenario?: string; arm?: string; mode?: string; force?: boolean }
  ring: string[]
}
const state: BatchState = {
  pid: undefined,
  stamp: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  exitCode: undefined,
  config: { repeat: 1, concurrency: 6 },
  ring: [],
}

function pushRing(line: string): void {
  state.ring.push(line)
  if (state.ring.length > 400) state.ring.shift()
}

function readRecords(stamp: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(ROOT, '.artifacts', 'eval', 'results.jsonl'), 'utf8')
      .split('\n').filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(record => record.stamp === stamp)
  } catch {
    return []
  }
}

function scenarioList(): string[] {
  try {
    return readdirSync(join(ROOT, 'packages', 'dsh-tool-retry', 'tests', 'eval-fixtures'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function serveReport(res: ServerResponse, urlPath: string): void {
  const name = urlPath.slice('/reports/'.length).split('?')[0] ?? ''
  if (name === '' || name.includes('..')) {
    res.writeHead(400)
    res.end('bad report path')
    return
  }
  const path = join(ROOT, 'reports', name)
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404)
    res.end('report not found')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(path))
}

const PANEL = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-tool-retry 评测控制台</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0e14;color:#e5e7eb;margin:0;padding:24px;max-width:960px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}.muted{color:#9ca3af;font-size:12px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}
input,select{background:#111827;border:1px solid #374151;color:#e5e7eb;border-radius:6px;padding:6px 10px;font-size:13px}
button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px 18px;font-size:14px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.running{background:#065f46;color:#6ee7b7}.idle{background:#1f2937;color:#9ca3af}.done{background:#1e3a8a;color:#93c5fd}.error{background:#7f1d1d;color:#fca5a5}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:12px}
th,td{border:1px solid #1f2937;padding:5px 8px;text-align:left}
th{background:#111827}
.ok{color:#34d399}.no{color:#f87171}
pre{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px;height:280px;overflow:auto;font-size:11px;line-height:1.5;white-space:pre-wrap}
a{color:#93c5fd}
</style></head><body>
<h1>dsh-tool-retry 评测控制台</h1>
<div class="muted">真实 harness 断点恢复 A/B 评测（ON=插件 / OFF=基线 × native/code）。</div>
<div class="row">
  <label>repeat <input id="repeat" value="1" style="width:56px"></label>
  <label>concurrency <input id="concurrency" value="6" style="width:56px"></label>
  <label>scenario <select id="scenario"><option value="">全部</option></select></label>
  <label><input type="checkbox" id="force"> 强制重跑（忽略已完成的实验）</label>
  <button id="start">启动评测</button>
</div>
<div class="row">
  <span>状态</span><span id="badge" class="badge idle">空闲</span>
  <span id="stamp" class="muted"></span><span id="elapsed" class="muted"></span>
  <span class="muted">报告目录：<a href="/reports/index.html" target="_blank">reports/index.html</a></span>
</div>
<table id="table"><thead><tr><th>scenario</th><th>mode</th><th>arm</th><th>rep</th><th>状态</th><th>retryOK</th><th>采用</th><th>通知</th></tr></thead><tbody></tbody></table>
<pre id="log">（未运行）</pre>
<script>
const $ = (id) => document.getElementById(id)
let polling = false
async function status() {
  const r = await fetch('/api/status')
  const s = await r.json()
  $('badge').textContent = s.running ? '运行中' : s.exitCode === 0 ? '已完成' : s.exitCode === null ? '空闲' : '失败'
  $('badge').className = 'badge ' + (s.running ? 'running' : s.exitCode === 0 ? 'done' : s.exitCode !== null ? 'error' : 'idle')
  $('stamp').textContent = s.stamp ? ('批次 ' + s.stamp) : ''
  $('elapsed').textContent = s.elapsedMs ? ('已用时 ' + Math.round(s.elapsedMs / 1000) + 's') : ''
  $('start').disabled = s.running
  $('log').textContent = s.ring.join('\\n')
  const tbody = $('table').querySelector('tbody')
  tbody.innerHTML = s.rows.map(r => '<tr><td>' + r.name + '</td><td>' + r.mode + '</td><td>' + r.arm + '</td><td>r' + r.rep + '</td><td>' + r.status + '</td><td class="' + (r.retryOK ? 'ok' : 'no') + '">' + (r.retryOK === undefined ? '—' : r.retryOK) + '</td><td>' + (r.adopted === undefined ? '—' : r.adopted) + '</td><td>' + (r.notices ?? '—') + '</td></tr>').join('')
  if (s.running && !polling) { polling = setInterval(status, 2000) }
  if (!s.running && polling) { clearInterval(polling); polling = false }
}
$('start').onclick = async () => {
  await fetch('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    repeat: Number($('repeat').value) || 1,
    concurrency: Number($('concurrency').value) || 6,
    scenario: $('scenario').value || undefined,
    force: $('force').checked,
  }) })
  setTimeout(status, 500)
}
fetch('/api/status').then((s) => s.json().then((data) => {
  data.scenarios.forEach((name) => { const o = document.createElement('option'); o.value = name; o.textContent = name; $('scenario').appendChild(o) })
  status()
}))
</script></body></html>`

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/'
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PANEL)
    return
  }
  if (url.startsWith('/reports/')) {
    serveReport(res, url)
    return
  }
  if (url.startsWith('/evidence/')) {
    serveEvidence(res, url)
    return
  }
  if (url === '/api/status') {
    const rows = state.stamp === undefined ? [] : readRecords(state.stamp).map(record => {
      const summary = record.summary as { status?: string; retrySuccess?: boolean; adopted?: boolean; noticeCount?: number }
      return {
        name: record.scenario, mode: record.mode, arm: record.arm, rep: record.repetition,
        status: summary.status ?? '?', retryOK: summary.retrySuccess, adopted: summary.adopted, notices: summary.noticeCount,
      }
    })
    sendJson(res, {
      running: state.pid !== undefined,
      pid: state.pid,
      stamp: state.stamp,
      exitCode: state.exitCode,
      elapsedMs: state.startedAt === undefined ? undefined : Date.now() - state.startedAt,
      harness: HARNESS,
      scenarios: scenarioList(),
      config: state.config,
      ring: state.ring,
      rows,
    })
    return
  }
  if (url === '/start' && req.method === 'POST') {
    if (state.pid !== undefined) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('a batch is already running')
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      let config: BatchState['config'] = { repeat: 1, concurrency: 6 }
      try {
        config = { ...config, ...(JSON.parse(body || '{}') as BatchState['config']) }
      } catch { /* keep defaults */ }
      if (HARNESS === '') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('DSH_HARNESS is not set on the server')
        return
      }
      const argv = [
        '--import', 'tsx', join(ROOT, 'scripts', 'eval-harness.ts'),
        '--repeat', String(config.repeat),
        '--concurrency', String(config.concurrency),
        ...(config.scenario === undefined || config.scenario === '' ? [] : ['--scenario', config.scenario]),
        ...(config.force === true ? ['--force'] : []),
      ]
      state.config = config
      state.ring = []
      state.stamp = undefined
      state.exitCode = undefined
      state.finishedAt = undefined
      const child = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, DSH_HARNESS: HARNESS } })
      state.pid = child.pid
      state.startedAt = Date.now()
      const onLine = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim() !== '') {
            pushRing(line)
            const match = /eval:real batch stamp (\S+)/u.exec(line)
            if (match !== null) state.stamp = match[1]
          }
        }
      }
      child.stdout.on('data', onLine)
      child.stderr.on('data', onLine)
      child.once('exit', (code) => {
        state.pid = undefined
        state.exitCode = code ?? 1
        state.finishedAt = Date.now()
      })
      sendJson(res, { started: true })
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, () => {
  console.log(`dsh-tool-retry eval panel: http://127.0.0.1:${PORT}`)
  console.log(`harness: ${HARNESS || '(DSH_HARNESS not set — set it and restart)'}`)
})
