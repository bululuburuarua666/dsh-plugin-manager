import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runPnpm, resolvePnpmEntry } from '../src/package-runner.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch {
      // A just-aborted child may still hold its cwd briefly on Windows; the
      // OS temp directory reaps the residue.
    }
  }
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-runner-'))
  tempDirs.push(root)
  return root
}

/** Write a fake pnpm JS entry that records its argv/cwd or sleeps. */
function fakeEntry(dir: string, behavior: 'ok' | 'fail' | 'record' | 'sleep'): string {
  const entry = join(dir, 'pnpm.cjs')
  const recordPath = join(dir, 'record.json')
  let body: string
  switch (behavior) {
    case 'ok': body = ''; break
    case 'fail': body = 'process.exit(3)'; break
    case 'record':
      body = `require('fs').writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }))`
      break
    case 'sleep': body = 'setTimeout(() => {}, 60_000)'; break
    default: body = ''
  }
  writeFileSync(entry, body)
  return entry
}

describe('resolvePnpmEntry', () => {
  it('accepts only absolute existing JavaScript entries', () => {
    const dir = fixture()
    const entry = fakeEntry(dir, 'ok')

    expect(resolvePnpmEntry({})).toBeNull()
    expect(resolvePnpmEntry({ npm_execpath: undefined })).toBeNull()
    expect(resolvePnpmEntry({ npm_execpath: join(dir, 'missing.cjs') })).toBeNull()
    writeFileSync(join(dir, 'pnpm.exe'), 'not javascript')
    expect(resolvePnpmEntry({ npm_execpath: join(dir, 'pnpm.exe') })).toBeNull()
    expect(resolvePnpmEntry({ npm_execpath: entry })).toBe(entry)
    // A relative path resolves against the process cwd.
    const relative = 'pnpm.cjs'
    writeFileSync(join(process.cwd(), 'pnpm.cjs'), '')
    try {
      expect(resolvePnpmEntry({ npm_execpath: relative })).toBe(join(process.cwd(), 'pnpm.cjs'))
    } finally {
      rmSync(join(process.cwd(), 'pnpm.cjs'), { force: true })
    }
    expect(resolvePnpmEntry({ npm_execpath: 'relative-missing.cjs' })).toBeNull()
  })
})

/** Capture the structured failure code of a throwing runner call. */
async function runnerFailureCode(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { failure: { code: string } }).failure.code
  }
  throw new Error('expected a structured failure')
}

describe('runPnpm', () => {
  it('refuses to run without a usable pnpm entry', async () => {
    expect(await runnerFailureCode(() => runPnpm(['remove', 'x'], fixture(), {}))).toBe('PNPM_UNAVAILABLE')
  })

  it('runs the entry with fixed argv inside the profile directory', async () => {
    const dir = fixture()
    const entry = fakeEntry(dir, 'record')
    const cwd = join(dir, 'profile')
    mkdirSync(cwd, { recursive: true })
    await runPnpm(['remove', '--save-prod', 'dsh-x'], cwd, { npm_execpath: entry })
    const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as { argv: string[]; cwd: string }
    expect(record.argv.slice(1)).toEqual(['remove', '--save-prod', 'dsh-x'])
    expect(record.cwd).toBe(cwd)
  })

  it('maps nonzero exits to PACKAGE_MANAGER_FAILED', async () => {
    const dir = fixture()
    const entry = fakeEntry(dir, 'fail')
    expect(await runnerFailureCode(() => runPnpm(['remove', 'x'], dir, { npm_execpath: entry })))
      .toBe('PACKAGE_MANAGER_FAILED')
  })

  it('aborts a hung invocation with TIMEOUT', async () => {
    const dir = fixture()
    const entry = fakeEntry(dir, 'sleep')
    expect(await runnerFailureCode(() => runPnpm(['remove', 'x'], dir, { npm_execpath: entry }, 100)))
      .toBe('TIMEOUT')
  })

  it('runs successfully on a clean exit', async () => {
    const dir = fixture()
    const entry = fakeEntry(dir, 'ok')
    await expect(runPnpm(['install'], dir, { npm_execpath: entry })).resolves.toBeUndefined()
    expect(existsSync(entry)).toBe(true)
  })
})
