/**
 * Install the two agent-preset templates under the DSH user preset root:
 * `$DSH_HOME/.agent-presets/tool-retry-standard` and `tool-retry-code` — each
 * a full copy of the shipped standard/code composition plus one `tool-retry`
 * row. Development presets name the profile-local alias
 * (`@dsh-tool-retry-dev/plugin`); `--official` rewrites the row to the npm
 * package name (`@canglongcl/dsh-tool-retry`).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVELOPMENT_ENTRY_NAME, OFFICIAL_PACKAGE_NAME } from './development-entry.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const presetsRoot = join(root, 'presets')
const presetIds = ['tool-retry-standard', 'tool-retry-code'] as const

const dshHome = process.env.DSH_HOME?.trim() === '' || process.env.DSH_HOME === undefined
  ? join(homedir(), '.dsh')
  : process.env.DSH_HOME
const targetRoot = join(dshHome, '.agent-presets')

const official = process.argv.includes('--official')
const entryName = official ? OFFICIAL_PACKAGE_NAME : DEVELOPMENT_ENTRY_NAME
if (!official) {
  console.log(`install-presets: development rows name ${DEVELOPMENT_ENTRY_NAME} (link the package first: pnpm dev or materializeProfilePluginLink)`)
}

for (const id of presetIds) {
  const sourceDir = join(presetsRoot, id)
  const sourceYml = join(sourceDir, 'agent.cordis.yml')
  if (!existsSync(sourceYml)) {
    console.error(`install-presets: template not found at ${sourceYml}`)
    process.exit(1)
  }
  const targetDir = join(targetRoot, id)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    const path = join(sourceDir, file)
    if (existsSync(path)) cpSync(path, join(targetDir, file))
  }
  // Rewrite the placeholder entry row to the selected channel's package name.
  const composed = join(targetDir, 'agent.cordis.yml')
  const text = readFileSync(composed, 'utf8')
    .replaceAll('@dsh-tool-retry-entry/placeholder', entryName)
  writeFileSync(composed, text)
  console.log(`install-presets: installed ${id} -> ${composed} (row name ${entryName})`)
}
