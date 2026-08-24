import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleEngine, type EngineHost } from '../../src/host/engine.ts'
import { runPnpm } from '../../src/host/package-runner.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'
import type { PackageRunner } from '../../src/host/uninstall.ts'

interface MutableRow extends LoaderEntry {
  options: { name: string; group?: unknown; disabled?: unknown }
  disabled: boolean
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * A recording PackageRunner double that simulates what `pnpm remove` really
 * does: drops the manifest dependency and the lockfile importer entry. (The
 * engine's postconditions verify exactly these effects.)
 */
function fakeRunner(calls: string[], profileDir: string): PackageRunner {
  return {
    remove: async (packageName) => {
      calls.push(`remove:${packageName}`)
      const manifestPath = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      delete manifest.dependencies?.[packageName]
      if (manifest.dsh?.profile?.bundles !== undefined) {
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== packageName)
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      // Drop the lockfile importer entry for the removed package.
      const lockPath = join(profileDir, 'pnpm-lock.yaml')
      const lines = readFileSync(lockPath, 'utf8').split('\n')
      const kept: string[] = []
      let skipping = false
      for (const line of lines) {
        if (/^      dsh-fixture-pkg:$/.test(line)) { skipping = true; continue }
        if (skipping) {
          if (/^ {6}\S/.test(line)) { skipping = false }
          else continue
        }
        kept.push(line)
      }
      writeFileSync(lockPath, kept.join('\n'))
      // pnpm also removes the installed package directory.
      rmSync(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
    },
    installFrozen: async () => { calls.push('install-frozen') },
  }
}

/** A PackageRunner double whose remove fails after mutating. */
function failingRemoveRunner(calls: string[]): PackageRunner {
  return {
    remove: async (packageName) => {
      calls.push(`remove:${packageName}`)
      throw Object.assign(new Error('pnpm failed'), { code: 'PACKAGE_MANAGER_FAILED' })
    },
    installFrozen: async () => { calls.push('install-frozen') },
  }
}

/**
 * Uninstall harness: temp profile with a direct fixture dependency, fake
 * loader rows, and a recording runner. The patch driver applies managed
 * disable rows (disposal) unless withDriver is false.
 */
async function uninstallHarness(options: { withDriver?: boolean; runner?: PackageRunner } = {}): Promise<{
  engine: LifecycleEngine
  rows: MutableRow[]
  profileDir: string
  patchPath: string
  runnerCalls: string[]
}> {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-uninstall-'))
  tempDirs.push(profileDir)
  const calls: string[] = []
  const fixtureDir = join(profileDir, 'node_modules', 'dsh-fixture-pkg')
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
    name: 'dsh-fixture-pkg',
    version: '1.0.0',
    main: 'index.js',
  }))
  writeFileSync(join(fixtureDir, 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture',
    dependencies: { 'dsh-fixture-pkg': 'file:./node_modules/dsh-fixture-pkg' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-fixture-pkg'] } },
  }))
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
    'lockfileVersion: \'9.0\'',
    '',
    'importers:',
    '  .:',
    '    dependencies:',
    '      dsh-fixture-pkg:',
    '        specifier: file:./node_modules/dsh-fixture-pkg',
    '        version: file:./node_modules/dsh-fixture-pkg',
    '',
  ].join('\n'))
  // No pnpm-workspace.yaml here: the transaction's workspace-policy arm takes
  // its null path (the with-workspace variant lives below).
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const rows: MutableRow[] = []
  const runner = options.runner ?? fakeRunner(calls, profileDir)
  const host: EngineHost = {
    entries: () => rows,
    persistence: () => 'writable',
    engineTreeRoot: null,
    createPackageRunner: () => runner,
  }
  const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, host)

  if (options.withDriver !== false) {
    const timer = setInterval(() => {
      const text = readText(patchPath)
      const match = /^- id: "([^"]+)"\n  disabled: true$/m.exec(text)
      if (match === null) return
      const row = rows.find(candidate => candidate.id === match[1])
      if (row !== undefined && !row.disabled) row.disabled = true
    }, 10)
    ;(engine as unknown as { __timer?: unknown }).__timer = timer
  }
  return { engine, rows, profileDir, patchPath, runnerCalls: calls }
}

async function settle(engine: LifecycleEngine, operationId: string) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const view = engine.operation({ operationId })
    if (view.state !== 'queued' && view.state !== 'running') return view
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

describe('LifecycleEngine uninstall flow', () => {
  it('uninstalls a direct dependency package-scoped and records restart state', async () => {
    const h = await uninstallHarness()
    // Disabled at creation so the loader never imports the fixture package.
    h.rows.push({ id: 'include:fixture', options: { name: 'dsh-fixture-pkg' }, disabled: true })

    const capabilities = h.engine.capabilities()
    const capability = capabilities.entries.find(entry => entry.entryId === 'include:fixture')
    expect(capability?.canUninstall).toBe(true)
    expect(capability?.canToggle).toBe(true)

    const preview = h.engine.preview({ entryId: 'include:fixture', action: 'uninstall', expectedRevision: capabilities.revision })
    expect(preview.packageName).toBe('dsh-fixture-pkg')
    expect(preview.restartRequired).toBe(true)

    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('succeeded')
    expect(done.restartRequired).toBe(true)
    expect(h.runnerCalls).toEqual(['remove:dsh-fixture-pkg'])

    const manifest = JSON.parse(readFileSync(join(h.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.dependencies).toEqual({})
    expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(existsSync(join(h.profileDir, 'node_modules', 'dsh-fixture-pkg'))).toBe(false)
    const pending = JSON.parse(readFileSync(join(h.profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as {
      records: Array<{ packageName: string; entryIds: string[] }>
    }
    expect(pending.records[0]).toMatchObject({ packageName: 'dsh-fixture-pkg', entryIds: ['include:fixture'] })
  }, 20_000)

  it('uninstalls with a pnpm-workspace.yaml present (workspace-policy arm)', async () => {
    const h = await uninstallHarness()
    // The workspace twin: the policy file exists, so the transaction reads
    // and restores it (the null arm is covered by the default harness).
    writeFileSync(join(h.profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
    h.rows.push({ id: 'include:fixture', options: { name: 'dsh-fixture-pkg' }, disabled: true })
    const caps = h.engine.capabilities()
    const cap = caps.entries.find(entry => entry.entryId === 'include:fixture')
    expect(cap?.canUninstall).toBe(true)
    const preview = h.engine.preview({ entryId: 'include:fixture', action: 'uninstall', expectedRevision: caps.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('succeeded')
  }, 20_000)

  it('fails with TIMEOUT when disposal never happens and rolls back', async () => {
    const h = await uninstallHarness({ withDriver: false })
    // Enabled so disposal is genuinely pending; no driver applies the disable.
    h.rows.push({ id: 'include:fixture', options: { name: 'dsh-fixture-pkg' }, disabled: false })
    const beforePatch = readText(h.patchPath)
    const beforeManifest = readFileSync(join(h.profileDir, 'package.json'), 'utf8')
    const capabilities = h.engine.capabilities()
    const entryId = capabilities.entries[0]?.entryId ?? 'missing'
    const preview = h.engine.preview({ entryId, action: 'uninstall', expectedRevision: capabilities.revision })
    const done = await settle(h.engine, h.engine.execute({ token: preview.token }).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    expect(h.runnerCalls).toEqual(['install-frozen'])
    expect(readText(h.patchPath)).toBe(beforePatch)
    expect(readFileSync(join(h.profileDir, 'package.json'), 'utf8')).toBe(beforeManifest)
  }, 25_000)

  it('cleans settled pending removals on startup', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-cleanup-'))
    tempDirs.push(profileDir)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '- id: other',
      '  disabled: true',
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: gone-entry',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, {
      entries: () => [],
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    await engine.startupCleanup()

    expect(readText(patchPath)).toBe('- id: other\n  disabled: true\n')
    expect(JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] })
      .toEqual({ schemaVersion: 1, records: [] })
  })

  it('cleans settled pending removals even without a patch file', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-cleanup-nopatch-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, {
      entries: () => [],
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    await engine.startupCleanup()

    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as { records: unknown[] })
      .toEqual({ schemaVersion: 1, records: [] })
  })

  it('keeps pending records whose entries still exist on startup', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-cleanup-keep-'))
    tempDirs.push(profileDir)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-gone': '1.0.0' },
    }))
    const rows: MutableRow[] = [{ id: 'include:still', options: { name: 'cordis:noop' }, disabled: true }]
    writeFileSync(patchPath, [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: include:still',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['include:still'], operationId: 'op-1', createdAt: 1 }],
    }))

    const engine = new LifecycleEngine(pathToFileURL(join(profileDir, 'cordis.yml')).href, {
      entries: () => rows,
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    await engine.startupCleanup()

    const pending = JSON.parse(readFileSync(join(profileDir, 'dsh-plugin-manager-pending-removals.json'), 'utf8')) as {
      records: Array<{ entryIds: string[] }>
    }
    expect(pending.records).toEqual([expect.objectContaining({ entryIds: ['include:still'] })])
    expect(readText(patchPath)).toContain('- id: include:still')
  })

  it('exposes the real no-shell package runner for production wiring', async () => {
    const engine = new LifecycleEngine(undefined, {
      entries: () => [],
      persistence: () => 'writable',
      engineTreeRoot: null,
    })
    const runner = (engine as unknown as { createPackageRunner(): PackageRunner }).createPackageRunner()
    expect(typeof runner.remove).toBe('function')
    expect(typeof runner.installFrozen).toBe('function')
    const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run()
      } catch (error) {
        return (error as { code: string }).code
      }
      throw new Error('expected a structured failure')
    }
    const removeCode = await codeOf(() => runner.remove('dsh-x', 'C:\\nowhere'))
    expect(['PNPM_UNAVAILABLE', 'PACKAGE_MANAGER_FAILED']).toContain(removeCode)
    const installCode = await codeOf(() => runner.installFrozen('C:\\nowhere'))
    expect(['PNPM_UNAVAILABLE', 'PACKAGE_MANAGER_FAILED']).toContain(installCode)
    expect(typeof runPnpm).toBe('function')
  })
})
