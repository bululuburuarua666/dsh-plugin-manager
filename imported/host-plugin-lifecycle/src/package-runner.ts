/**
 * No-shell package-manager runner: the deployment's own pnpm JavaScript entry
 * is resolved from the trusted `npm_execpath` environment and executed through
 * `process.execPath` with a fixed argument list — never a command string,
 * `exec()`, or a shell.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { lifecycleFailure } from './failure.ts'

/** How long one package-manager invocation may run. */
export const PACKAGE_MANAGER_TIMEOUT_MS = 600_000

/** Classify a child-process failure into a sanitized lifecycle error. */
function classify(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ABORT_ERR' || code === 'ERR_CANCELED') {
    throw lifecycleFailure('TIMEOUT', 'the package manager did not finish in time')
  }
  throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'the package manager reported a failure')
}

/** Resolve the deployment's pnpm JavaScript entry; null when unusable. */
export function resolvePnpmEntry(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.npm_execpath
  if (typeof raw !== 'string' || raw.length === 0) return null
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  if (!existsSync(path)) return null
  if (!/\.(c|m)?js$/.test(path)) return null
  return path
}

/** Run one pnpm invocation with a fixed argv inside the profile directory. */
export async function runPnpm(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = PACKAGE_MANAGER_TIMEOUT_MS,
): Promise<void> {
  const entry = resolvePnpmEntry(env)
  if (entry === null) {
    throw lifecycleFailure('PNPM_UNAVAILABLE', 'no usable pnpm JavaScript entry is available to this deployment')
  }
  const signal = AbortSignal.timeout(timeoutMs)
  await new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { encoding: 'utf8', signal, windowsHide: true, cwd },
      (error) => {
        if (error !== null) {
          const failure = Object.assign(new Error('the package manager invocation failed'), {
            code: error.code,
          })
          rejectRun(failure)
          return
        }
        resolveRun()
      },
    )
  }).catch(classify)
}
