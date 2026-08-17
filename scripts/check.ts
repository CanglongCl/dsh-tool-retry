/**
 * Quality gate (`pnpm check`): the strict verification surface for this repo.
 * Runs after `pnpm install`; generated/build artifacts may be absent:
 *  1. bootstrap — generate deterministic development configuration;
 *  2. replay-fixture corpus — regenerate and demand byte-identical output;
 *  3. typecheck — source/scripts solution plus every test;
 *  4. build — tsdown produces the self-contained node half;
 *  5. unit suite — vitest over a real Cordis context (incl. the keyless
 *     llm-replay A/B with snapshot-asserted JSON summaries);
 *  6. config/package contracts — generated config is deterministic, the dev
 *     alias is shared by overlay and launchers, package publication boundary,
 *     pinned public dependencies, native-ESM entry, self-contained bundle;
 *  7. preset templates — both ids carry exactly one tool-retry placeholder row;
 *  8. official package — stable bundle id, dsh.bundle declaration, exact
 *     staging allowlist, tarball output, and checksum.
 * Flags: --fast skips official-package assembly.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEVELOPMENT_ENTRY_NAME, OFFICIAL_PACKAGE_NAME } from './development-entry.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = join(ROOT, 'packages', 'dsh-tool-retry')
const DIST = join(ROOT, 'dist')
const OFFICIAL = join(DIST, 'package')
const EXPECTED_PACKAGE_NAME = OFFICIAL_PACKAGE_NAME
const EXPECTED_REGISTRY = 'https://registry.npmjs.org/'
const LOCKFILE = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
const EXPECTED_PUBLIC_DEVELOPMENT_VERSIONS: Record<string, string> = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
  '@deepseek-ai/dsh-code-runtime': '0.1.0-rc.6',
  '@deepseek-ai/dsh-credentials-local': '0.1.0-rc.6',
  '@deepseek-ai/dsh-fs': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm-replay': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session': '0.1.0-rc.6',
  '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tool-fs': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
  '@deepseek-ai/dsh-scope': '0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-loop': '0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-loop-testkit': '0.1.0-rc.6',
  '@deepseek-ai/dsh-fs-local': '0.1.0-rc.6',
  '@deepseek-ai/dsh-fs-observation-policy': '0.1.0-rc.6',
  '@deepseek-ai/schemastery': '3.18.1',
}
const fast = process.argv.includes('--fast')

const FAILURES: string[] = []

/** Run one command; a non-zero exit records a failure. */
function run(label: string, command: string, args: readonly string[]): boolean {
  process.stdout.write(`check: ${label} ... `)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })
  if (result.status === 0) {
    console.log('ok')
    return true
  }
  console.log(`FAILED (${String(result.status)})`)
  if (result.stdout !== '') process.stdout.write(`${result.stdout.slice(-2000)}\n`)
  if (result.stderr !== '') process.stdout.write(`${result.stderr.slice(-2000)}\n`)
  FAILURES.push(label)
  return false
}

/** Assert a boolean contract; a violation records a failure. */
function assert(label: string, check: () => boolean, detail: () => string): void {
  process.stdout.write(`check: ${label} ... `)
  try {
    if (check()) {
      console.log('ok')
      return
    }
    console.log('FAILED')
    console.log(`  ${detail()}`)
  } catch (error) {
    console.log('FAILED')
    console.log(`  ${error instanceof Error ? error.message : String(error)}`)
  }
  FAILURES.push(label)
}

/** List files beneath a generated package root using POSIX-style separators. */
function listFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(root, path))
    else files.push(relative(root, path).replaceAll('\\', '/'))
  }
  return files.sort()
}

/** Static/dynamic ESM imports emitted by tsdown (builtins are allowed). */
function esmImports(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/^\s*import(?:.+?\sfrom\s+)?["']([^"']+)["'];?\s*$/gmu),
    ...source.matchAll(/\bimport\(["']([^"']+)["']\)/gu),
  ]
  return specifiers.flatMap(match => match[1] === undefined ? [] : [match[1]])
}

/** npm's deterministic tarball basename for one package identity. */
function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`
}

// Bootstrap is deliberately part of the gate: a clean git worktree carries
// neither generated launch config nor built bundles.
run('gen-config initial generation', process.execPath, [
  '--import', 'tsx', join(ROOT, 'scripts/gen-config.ts'),
])
const entryBefore = readFileSync(join(PKG, 'entry-name.json'), 'utf8')
const cordisBefore = readFileSync(join(ROOT, 'cordis.yml'), 'utf8')
run('gen-config regeneration', process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/gen-config.ts')])
assert(
  'gen-config deterministic (entry-name.json + cordis.yml unchanged)',
  () => readFileSync(join(PKG, 'entry-name.json'), 'utf8') === entryBefore
    && readFileSync(join(ROOT, 'cordis.yml'), 'utf8') === cordisBefore,
  () => 'generated development config changed across two consecutive runs',
)

// The replay fixture corpus is committed data generated by a builder; the
// gate regenerates it and demands byte-identical output (no hand edits).
run('regenerate replay fixtures', process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/build-replay-fixtures.ts')])
assert(
  'replay fixtures deterministic (tests/replay-fixtures/ unchanged)',
  () => spawnSync('git', ['diff', '--exit-code', '--', join(ROOT, 'packages', 'dsh-tool-retry', 'tests', 'replay-fixtures')], { encoding: 'utf8' }).status === 0,
  () => 'replay fixture corpus changed across a regeneration run',
)

run('source + scripts typecheck (tsc -b --force)', process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-b', '--force',
])
run('test typecheck (tsc -p)', process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', join(ROOT, 'tsconfig.tests.json'),
])
run('build (tsdown)', 'pnpm', ['--filter', './packages/dsh-tool-retry', 'build'])
run('unit suite (vitest)', 'pnpm', ['vitest', 'run'])

// Launch/overlay contract: dev alias shared by overlay, banner id, launchers.
const entryName = (JSON.parse(entryBefore) as { name: string }).name
assert(
  'development launch uses the profile-local package alias',
  () => entryName === DEVELOPMENT_ENTRY_NAME
    && cordisBefore.includes(`- id: tool-retry`)
    && cordisBefore.includes(`name: ${JSON.stringify(DEVELOPMENT_ENTRY_NAME)}`)
    && [join(ROOT, 'scripts', 'dev.ts'), join(ROOT, 'scripts', 'dev-headless.ts')]
      .map(file => readFileSync(file, 'utf8')).every(source =>
        source.includes('materializeProfilePluginLink')
        && (source.includes('harnessWebLaunch(') || source.includes('harnessHeadlessLaunch('))),
  () => 'entry-name.json, cordis.yml, and every launcher must share and materialize the development alias',
)
assert(
  'launchers use the built app-owned CLI',
  () => [join(ROOT, 'scripts', 'harness-cli.ts')]
    .map(file => readFileSync(file, 'utf8')).every(source =>
      source.includes('resolveHarnessCli') && !source.includes("'--dev'") && !source.includes("'--import', 'tsx'")),
  () => 'launchers must resolve apps/cli/lib/bin.js and never pass --dev or a tsx hook',
)

const packageManifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  name: string
  version: string
  private?: boolean
  publishConfig?: { access?: string; registry?: string }
  repository?: { type?: string; url?: string }
  devDependencies?: Record<string, string>
  exports?: Record<string, unknown>
}
assert(
  'source package keeps the public publication boundary',
  () => packageManifest.name === EXPECTED_PACKAGE_NAME
    && packageManifest.private === true
    && packageManifest.publishConfig?.access === 'public'
    && packageManifest.publishConfig.registry === EXPECTED_REGISTRY
    && packageManifest.repository?.type === 'git'
    && packageManifest.repository.url === 'git+https://github.com/CanglongCl/dsh-tool-retry.git',
  () => `source manifest must guard direct workspace publication while staging public ${EXPECTED_PACKAGE_NAME}`,
)
assert(
  'source package exposes only the runtime entrypoint',
  () => JSON.stringify(Object.keys(packageManifest.exports ?? {}).sort())
    === JSON.stringify(['.', './package.json'].sort()),
  () => 'package.json exports must not expose private src/* modules or missing declaration artifacts',
)
assert(
  'source package uses the public runtime packages',
  () => {
    const dependencies = packageManifest.devDependencies ?? {}
    const deepseekDependencies = Object.entries(dependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/'))
    return deepseekDependencies.length === Object.keys(EXPECTED_PUBLIC_DEVELOPMENT_VERSIONS).length
      && deepseekDependencies.every(([name, specifier]) =>
        EXPECTED_PUBLIC_DEVELOPMENT_VERSIONS[name] === specifier)
      && dependencies.cordis === undefined
      && dependencies['@cordisjs/plugin-loader'] === undefined
      && dependencies['@cordisjs/plugin-include'] === undefined
  },
  () => 'public npm dependencies must use the exact pinned @deepseek-ai package line',
)
assert(
  'lockfile is registry-backed and machine-independent',
  () => !LOCKFILE.includes('link:') && !LOCKFILE.includes('/Users/') && !LOCKFILE.includes('C:\\Users\\'),
  () => 'pnpm-lock.yaml must not contain link: dependencies or machine-local user paths',
)
assert(
  'native-ESM package entry exists',
  () => packageManifest.exports?.['.'] === './lib/index.js'
    && existsSync(join(PKG, 'lib', 'index.js')),
  () => 'package.json must export the built lib/index.js entry used by the profile-local alias',
)
assert(
  'built node half is self-contained',
  () => esmImports(readFileSync(join(PKG, 'lib', 'index.js'), 'utf8'))
    .every(specifier => specifier.startsWith('node:')),
  () => `lib/index.js has non-builtin imports: ${esmImports(readFileSync(join(PKG, 'lib', 'index.js'), 'utf8'))
    .filter(specifier => !specifier.startsWith('node:')).join(', ')}`,
)

// Plugin form compliance (harness packages/AGENTS.md): the cordis shape,
// HMR-safe disposal, and the canonical Model Experience README.
assert(
  'source entry declares the cordis plugin shape without a default export',
  () => {
    const source = readFileSync(join(PKG, 'src', 'index.ts'), 'utf8')
    return source.includes("export const name = 'tool-retry'")
      && source.includes("export const inject = ['tools', 'fs', 'systemPrompt']")
      && source.includes('export const Config')
      && source.includes('export function apply(')
      && !source.includes('export default')
  },
  () => 'src/index.ts must export name/inject/Config/apply and never a default (unwrapExports collapse)',
)
assert(
  'apply unwinds with ctx.effect (HMR-safe disposal)',
  () => readFileSync(join(PKG, 'src', 'index.ts'), 'utf8').includes('ctx.effect('),
  () => 'the plugin must register a ctx.effect teardown for HMR safety',
)
assert(
  'package README follows the canonical Model Experience format',
  () => {
    const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
    return readme.includes('## Model Experience')
      && readme.includes('#### What the model sees')
      && readme.includes('#### Token effect')
      && readme.includes('#### KV Cache effect')
      && readme.includes('## Known Limitations and Deferred Work')
  },
  () => 'README.md must carry the Model Experience block and the Known Limitations section',
)
{
  // The built artifact must expose the same shape over the class-identity
  // boundary (the bundle inlines its own copies of the DSH classes).
  const shape = await import(pathToFileURL(join(PKG, 'lib', 'index.js')).href) as Record<string, unknown>
  assert(
    'built entry exposes name/inject/Config/apply and no default',
    () => typeof shape.name === 'string'
      && Array.isArray(shape.inject)
      && typeof shape.apply === 'function'
      && (typeof shape.Config === 'function' || typeof shape.Config === 'object')
      && shape.default === undefined,
    () => 'lib/index.js must export the cordis plugin shape without a default export',
  )
}

// Preset templates: two copies of the shipped compositions + one tool-retry row.
const presetIds = ['tool-retry-standard', 'tool-retry-code']
assert(
  'preset templates carry exactly one tool-retry placeholder row',
  () => presetIds.every((id) => {
    const source = readFileSync(join(ROOT, 'presets', id, 'agent.cordis.yml'), 'utf8')
    const rows = [...source.matchAll(/- id: tool-retry\b/gu)]
    return rows.length === 1
      && source.includes('@dsh-tool-retry-entry/placeholder')
      && existsSync(join(ROOT, 'presets', id, 'preset.yml'))
  }),
  () => 'each preset template must add one `- id: tool-retry` row naming the placeholder entry',
)
assert(
  'install-presets targets the DSH user preset root',
  () => {
    const source = readFileSync(join(ROOT, 'scripts', 'install-presets.ts'), 'utf8')
    return source.includes("'.agent-presets'") && source.includes('tool-retry-standard')
      && source.includes('tool-retry-code') && source.includes('@dsh-tool-retry-entry/placeholder')
  },
  () => 'install-presets.ts must copy both templates under $DSH_HOME/.agent-presets and rewrite the placeholder',
)

// Official DSH profile bundle: stable id plus an exact prebuilt tarball.
if (!fast) run('assemble official DSH package', process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/package-official.ts')])
const expectedOfficialFiles = [
  'README.md',
  'README_zh.md',
  'README_en.md',
  'cordis.patch.yml',
  'lib/index.js',
  'package.json',
  'presets/tool-retry-code/agent.cordis.yml',
  'presets/tool-retry-code/preset.yml',
  'presets/tool-retry-standard/agent.cordis.yml',
  'presets/tool-retry-standard/preset.yml',
].sort()
if (!fast) {
  assert(
    'official package contains only the distribution allowlist',
    () => JSON.stringify(listFiles(OFFICIAL)) === JSON.stringify(expectedOfficialFiles),
    () => `dist/package files differ: ${listFiles(OFFICIAL).join(', ')}`,
  )
  assert(
    'official package declares the DSH bundle and its entries exist',
    () => {
      const manifest = JSON.parse(readFileSync(join(OFFICIAL, 'package.json'), 'utf8')) as {
        name: string
        version: string
        private?: boolean
        main: string
        publishConfig?: { access?: string; registry?: string }
        repository?: { type?: string; url?: string }
        dependencies?: unknown
        devDependencies?: unknown
        dsh?: { bundle?: { patch?: string } }
      }
      return manifest.name === packageManifest.name
        && manifest.private === undefined
        && manifest.publishConfig?.access === 'public'
        && manifest.publishConfig.registry === EXPECTED_REGISTRY
        && manifest.repository?.type === 'git'
        && manifest.repository.url === packageManifest.repository?.url
        && manifest.dependencies === undefined
        && manifest.devDependencies === undefined
        && manifest.dsh?.bundle?.patch === './cordis.patch.yml'
        && existsSync(join(OFFICIAL, manifest.main))
        && existsSync(join(OFFICIAL, manifest.dsh.bundle.patch))
        && readFileSync(join(OFFICIAL, 'cordis.patch.yml'), 'utf8')
          .includes(`name: ${JSON.stringify(EXPECTED_PACKAGE_NAME)}`)
        && readFileSync(join(OFFICIAL, 'presets', 'tool-retry-code', 'agent.cordis.yml'), 'utf8')
          .includes(EXPECTED_PACKAGE_NAME)
        && !readFileSync(join(OFFICIAL, 'presets', 'tool-retry-code', 'agent.cordis.yml'), 'utf8')
          .includes('@dsh-tool-retry-entry/placeholder')
    },
    () => 'staged package.json must publish the public package and declare valid dsh.bundle entries',
  )
  assert(
    'official package text contains no credentials or machine paths',
    () => expectedOfficialFiles
      .filter(file => /\.(?:js|json|map|md|yml)$/u.test(file))
      .map(file => readFileSync(join(OFFICIAL, file), 'utf8'))
      .every(source => !/\bnpm_[0-9A-Za-z]{20,}\b/u.test(source)
        && !/_authToken\s*=\s*(?!\$\{[A-Z][A-Z0-9_]*\})\S+/u.test(source)
        && !source.includes(ROOT)),
    () => 'dist/package contains credential configuration or this checkout absolute path',
  )
  const packageName = tarballName(packageManifest.name, packageManifest.version)
  assert(
    'official tarball exists',
    () => existsSync(join(DIST, packageName)),
    () => 'pnpm pack did not produce the expected dist/*.tgz file',
  )
  assert(
    'official tarball checksum is current',
    () => {
      const packagePath = join(DIST, packageName)
      if (!existsSync(packagePath) || !existsSync(join(DIST, 'SHA256SUMS'))) return false
      const checksum = createHash('sha256').update(readFileSync(packagePath)).digest('hex')
      return readFileSync(join(DIST, 'SHA256SUMS'), 'utf8') === `${checksum}  ${packageName}\n`
    },
    () => 'dist/SHA256SUMS is missing or does not match the official tarball',
  )
}

if (FAILURES.length > 0) {
  console.error(`\ncheck: ${FAILURES.length} gate(s) failed: ${FAILURES.join(', ')}`)
  process.exit(1)
}
console.log('\ncheck: all gates passed.')
