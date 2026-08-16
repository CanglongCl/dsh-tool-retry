/** Resolve the Harness built CLI launch vectors for this external plugin. */
import { resolveHarnessCli } from './harness-path.ts'

/** One fully resolved child-process launch. */
export interface HarnessCliLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Build the Web launch vector while preserving this repository as cwd.
 *
 * The installed-style CLI is the built `apps/cli/lib/bin.js`. The caller
 * materializes the source package under the profile-local development alias,
 * so the native-ESM Loader resolves the bare package name from the profile.
 */
export function harnessWebLaunch(
  harnessRoot: string,
  patchPath: string,
  host: string,
  port: string | number,
  environment: NodeJS.ProcessEnv = process.env,
): HarnessCliLaunch {
  const bin = resolveHarnessCli(harnessRoot)
  return {
    command: process.execPath,
    args: [
      bin,
      'web',
      '--patch', patchPath,
      '--host', host,
      '--port', String(port),
    ],
    env: { ...environment },
  }
}

/**
 * Build the one-shot headless launch vector: one task, one fresh persisted
 * session, the final answer on stdout, then exit. The `headless` profile
 * auto-initializes on first use; the `--patch` overlay carries the plugin row.
 */
export function harnessHeadlessLaunch(
  harnessRoot: string,
  patchPath: string,
  task: string,
  environment: NodeJS.ProcessEnv = process.env,
): HarnessCliLaunch {
  const bin = resolveHarnessCli(harnessRoot)
  return {
    command: process.execPath,
    args: [
      bin,
      '--profile', 'headless',
      '--patch', patchPath,
      task,
    ],
    env: { ...environment },
  }
}
