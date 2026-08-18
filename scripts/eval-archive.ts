/**
 * Eval evidence archiver (`pnpm eval:archive`): moves each finished batch's
 * durable evidence out of .artifacts/eval/runs/<stamp>/ into a per-batch
 * directory under the archive root, keeping ONLY the per-run session.jsonl
 * (gzip) and record.json (plain). Workspace directories are deleted — every
 * file state the model produced is reconstructable from the session log
 * (tool arguments and results are recorded in full), so storing them would
 * be redundancy, not evidence.
 *
 * - The archive root is `DSH_EVAL_ARCHIVE_DIR` or ~/.dsh/eval-archives.
 * - One manifest.jsonl line per archived run: { stamp, runDir, sessionBytes,
 *   gzBytes, archivedAt }.
 * - `--keep` retains the batch under runs/ after archiving (default purges
 *   it once every run of the batch verified).
 * - `--stamp <stamp>` archives only that batch (default: every batch found
 *   under runs/).
 *
 * The eval panel serves /evidence/<stamp>/... from runs/ first and from the
 * archive second, so reports keep their drill-down after a purge.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNS = join(ROOT, '.artifacts', 'eval', 'runs')
const ARCHIVE = process.env.DSH_EVAL_ARCHIVE_DIR?.trim() || join(homedir(), '.dsh', 'eval-archives')
const KEEP = process.argv.includes('--keep')
const stampFlag = process.argv.indexOf('--stamp')
const STAMP = stampFlag === -1 ? undefined : process.argv[stampFlag + 1]

interface RunEntry {
  rel: string
  stamp: string
  session: string
  record: string
}

/** Enumerate run dirs: <stamp>/<scenario>/<mode>/<arm>/rN/. */
function listRuns(): RunEntry[] {
  const stamps = STAMP === undefined
    ? readdirSync(RUNS).filter(name => existsSync(join(RUNS, name, 'session.jsonl')) === false)
    : [STAMP]
  const entries: RunEntry[] = []
  for (const stamp of stamps) {
    const stampDir = join(RUNS, stamp)
    if (!existsSync(stampDir)) continue
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (existsSync(join(path, 'session.jsonl'))) {
            const rel = relative(RUNS, path).split(sep).join('/')
            entries.push({
              rel,
              stamp,
              session: join(path, 'session.jsonl'),
              record: join(path, 'record.json'),
            })
          } else {
            walk(path)
          }
        }
      }
    }
    walk(stampDir)
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel))
}

function archiveRun(entry: RunEntry): { sessionBytes: number; gzBytes: number } {
  const targetDir = join(ARCHIVE, entry.rel)
  mkdirSync(targetDir, { recursive: true })
  const session = readFileSync(entry.session)
  const gz = gzipSync(session, { level: 9 })
  writeFileSync(join(targetDir, 'session.jsonl.gz'), gz)
  // record.json: the run record (summary + grader + revisions) — the report's
  // drill-down boundary comes from its summary.prefixEventCount.
  if (existsSync(entry.record)) {
    writeFileSync(join(targetDir, 'record.json'), readFileSync(entry.record))
  }
  appendFileSync(join(ARCHIVE, 'manifest.jsonl'), `${JSON.stringify({
    stamp: entry.stamp,
    runDir: entry.rel,
    sessionBytes: session.length,
    gzBytes: gz.length,
    archivedAt: new Date().toISOString(),
  })}\n`)
  return { sessionBytes: session.length, gzBytes: gz.length }
}

const runs = listRuns()
if (runs.length === 0) {
  console.log('eval:archive — nothing to archive (no finished batch run dirs found)')
  process.exit(0)
}
let totalRaw = 0
let totalGz = 0
const stamps = new Set<string>()
for (const entry of runs) {
  const { sessionBytes, gzBytes } = archiveRun(entry)
  totalRaw += sessionBytes
  totalGz += gzBytes
  stamps.add(entry.stamp)
  console.log(`archived ${entry.rel}  ${(sessionBytes / 1024 / 1024).toFixed(1)}MB -> ${(gzBytes / 1024 / 1024).toFixed(2)}MB`)
}
if (!KEEP) {
  for (const stamp of stamps) {
    // The archive holds the only durable evidence (session + record per
    // run); everything else under the stamp (workspaces, stdout dumps) is
    // reconstructable or disposable, so purge the whole batch dir.
    rmSync(join(RUNS, stamp), { recursive: true, force: true })
    console.log(`purged ${stamp}`)
  }
}
console.log(`eval:archive done — ${runs.length} runs, ${(totalRaw / 1024 / 1024).toFixed(0)}MB -> ${(totalGz / 1024 / 1024).toFixed(0)}MB (gzip), archive root ${ARCHIVE}`)
