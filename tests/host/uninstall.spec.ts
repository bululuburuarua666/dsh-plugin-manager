import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lifecycleFailure } from '../../src/host/failure.ts'
import {
  clearSettledPendingRemovals,
  lockImporterHas,
  readPendingRemovals,
  runUninstallTransaction,
  type PackageRunner,
  type UninstallIo,
  type UninstallOptions,
} from '../../src/host/uninstall.ts'

/** In-memory filesystem implementing the transaction IO boundary. */
class MemIo implements UninstallIo {
  readonly files = new Map<string, string>()
  readonly writes: string[] = []

  constructor(seed: Record<string, string>) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content)
  }

  readText(path: string): string {
    return this.files.get(path) ?? ''
  }

  exists(path: string): boolean {
    return this.files.has(path)
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    this.writes.push(path)
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path)
    this.writes.push(path)
  }

  async mkdir(_path: string): Promise<void> {}

  digest(path: string): string {
    const content = this.files.get(path) ?? ''
    return createHash('sha256').update(content).digest('hex')
  }
}

/** A fake pnpm that actually performs the removal like the real one would. */
class SuccessfulRunner implements PackageRunner {
  constructor(private readonly io: MemIo, private readonly profileDir: string) {}

  async remove(packageName: string, _cwd: string): Promise<void> {
    const manifest = JSON.parse(this.io.readText(join(this.profileDir, 'package.json'))) as Record<string, unknown>
    const previous = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? manifest.dependencies as Record<string, unknown>
      : {}
    manifest.dependencies = Object.fromEntries(
      Object.entries(previous).filter(([name]) => name !== packageName),
    )
    this.io.files.set(join(this.profileDir, 'package.json'), JSON.stringify(manifest))
    const lock = this.io.readText(join(this.profileDir, 'pnpm-lock.yaml'))
      .replace(new RegExp(`\\s+${packageName.replace(/[/@]/g, '\\$&')}:\\s*\\n(?:\\s+[^\\n]*\\n)*`), '\n')
    this.io.files.set(join(this.profileDir, 'pnpm-lock.yaml'), lock)
    this.io.files.delete(join(this.profileDir, 'node_modules', ...packageName.split('/')))
  }

  async installFrozen(_cwd: string): Promise<void> {}
}

/** The dependency-free option surface; per-test overrides fill the gaps. */
function baseOptions(overrides: Partial<UninstallOptions> & {
  io: MemIo
  runner: PackageRunner
}): UninstallOptions {
  const profileDir = 'C:\\tmp\\profile'
  return {
    operationId: 'op-1',
    packageName: 'dsh-vision-router',
    profileDir,
    profileName: 'web',
    patchPath: join(profileDir, 'cordis.patch.yml'),
    manifestPath: join(profileDir, 'package.json'),
    lockfilePath: join(profileDir, 'pnpm-lock.yaml'),
    workspacePolicyPath: null,
    backupsRoot: 'C:\\tmp\\backups',
    pendingPath: join(profileDir, 'plugin-lifecycle-pending-removals.json'),
    affectedEntryIds: ['vision-router'],
    affectedDataIds: ['vision-router'],
    moduleNames: ['dsh-vision-router'],
    waitForDispose: async () => {},
    probeEntryIds: ids => ids,
    withPatchLock: async operation => operation(),
    ...overrides,
  }
}

function seedFiles(profileDir: string, options: { manualInsert?: boolean } = {}): Record<string, string> {
  const files: Record<string, string> = {
    [join(profileDir, 'package.json')]: JSON.stringify({
      dependencies: { 'dsh-vision-router': '1.4.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-router'] } },
    }),
    [join(profileDir, 'pnpm-lock.yaml')]: [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      dsh-vision-router:',
      '        specifier: 1.4.0',
      '        version: 1.4.0',
      '',
    ].join('\n'),
    [join(profileDir, 'cordis.patch.yml')]: options.manualInsert
      ? [
        '# handwritten',
        '- insert:',
        '    - id: vision-router',
        '      name: \'dsh-vision-router\'',
        '',
      ].join('\n')
      : ['# handwritten', '- id: other', '  disabled: true', ''].join('\n'),
    [join(profileDir, 'node_modules', 'dsh-vision-router')]: '{}',
  }
  return files
}

/** Seed files minus one omitted path. */
function seedWithout(profileDir: string, omit: string): Record<string, string> {
  const seed = seedFiles(profileDir)
  const kept: Record<string, string> = {}
  for (const [path, content] of Object.entries(seed)) {
    if (path !== omit) kept[path] = content
  }
  return kept
}

describe('runUninstallTransaction', () => {
  it('uninstalls a bundle dependency and records pending restart state', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.survivingEntryIds).toEqual(['vision-router'])

    const manifest = JSON.parse(io.readText(join(profileDir, 'package.json'))) as Record<string, unknown>
    expect(manifest.dependencies).toEqual({})
    expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(io.exists(join(profileDir, 'node_modules', 'dsh-vision-router'))).toBe(false)
    expect(io.readText(join(profileDir, 'cordis.patch.yml'))).toContain('disabled: true')

    const pending = readPendingRemovals(io, join(profileDir, 'plugin-lifecycle-pending-removals.json'))
    expect(pending).toEqual([
      expect.objectContaining({ packageName: 'dsh-vision-router', entryIds: ['vision-router'] }),
    ])
  })

  it('splices a manual insert, drops its managed row, and skips pending state', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir, { manualInsert: true }))
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
      probeEntryIds: ids => (ids[0] === 'vision-router' ? [] : ids),
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      expect(outcome).toEqual('splice-should-succeed')
      return
    }
    expect(outcome.splicedEntryIds).toEqual(['vision-router'])
    expect(outcome.survivingEntryIds).toEqual([])
    expect(io.readText(join(profileDir, 'cordis.patch.yml'))).not.toContain('dsh-vision-router')
    expect(readPendingRemovals(io, join(profileDir, 'plugin-lifecycle-pending-removals.json'))).toEqual([])
  })

  it('rolls back touched files when the package manager fails', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    const io = new MemIo(seed)
    let installFrozenCalls = 0
    const failingRunner: PackageRunner = {
      remove: async () => {
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => { installFrozenCalls++ },
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner: failingRunner }))
    expect(outcome).toEqual({ ok: false, code: 'PACKAGE_MANAGER_FAILED' })
    expect(installFrozenCalls).toBe(1)
    // Every touched file is byte-identical to its pre-mutation image.
    for (const path of Object.keys(seed)) {
      expect(io.readText(path)).toBe(seed[path])
    }
  })

  it('maps a timed-out package manager to TIMEOUT and still restores', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => {
        throw lifecycleFailure('TIMEOUT', 'deadline exceeded')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(io.readText(join(profileDir, 'cordis.patch.yml'))).toBe(seed[join(profileDir, 'cordis.patch.yml')])
  })

  it('reports POSTCONDITION_FAILED when the lockfile keeps the dependency', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const runner: PackageRunner = {
      remove: async (packageName) => {
        const manifest = JSON.parse(io.readText(join(profileDir, 'package.json'))) as Record<string, unknown>
        const previous = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
          ? manifest.dependencies as Record<string, unknown>
          : {}
        manifest.dependencies = Object.fromEntries(
          Object.entries(previous).filter(([name]) => name !== packageName),
        )
        io.files.set(join(profileDir, 'package.json'), JSON.stringify(manifest))
        // Deliberately leaves the lockfile importer entry behind.
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'POSTCONDITION_FAILED' })
  })

  it('fails closed when the lockfile becomes unreadable', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async (packageName) => {
        const manifest = JSON.parse(io.readText(join(profileDir, 'package.json'))) as Record<string, unknown>
        const previous = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
          ? manifest.dependencies as Record<string, unknown>
          : {}
        manifest.dependencies = Object.fromEntries(
          Object.entries(previous).filter(([name]) => name !== packageName),
        )
        io.files.set(join(profileDir, 'package.json'), JSON.stringify(manifest))
        io.files.set(join(profileDir, 'pnpm-lock.yaml'), '- [unclosed')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'POSTCONDITION_FAILED' })
  })

  it('merges pending records with existing, malformed, and over-capacity state', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const pendingPath = join(profileDir, 'plugin-lifecycle-pending-removals.json')
    // Existing valid state: another package's record survives, the target's
    // record is replaced, and 33 records trim to the 32 newest.
    const seed = seedFiles(profileDir)
    seed[pendingPath] = JSON.stringify({
      schemaVersion: 1,
      records: [
        { packageName: 'other-pkg', entryIds: ['other'], operationId: 'op-old', createdAt: 1 },
        { packageName: 'dsh-vision-router', entryIds: ['old-entry'], operationId: 'op-stale', createdAt: 2 },
        ...Array.from({ length: 31 }, (_unused, index) => ({
          packageName: `filler-${index}`,
          entryIds: [`filler-${index}`],
          operationId: `op-filler-${index}`,
          createdAt: index,
        })),
      ],
    })
    const io = new MemIo(seed)
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    if (!outcome.ok) {
      expect(outcome).toEqual('pending-merge-should-succeed')
      return
    }
    const pending = JSON.parse(io.readText(pendingPath)) as {
      records: Array<{ packageName: string; entryIds?: string[] }>
    }
    expect(pending.records.some(record => record.packageName === 'dsh-vision-router')).toBe(true)
    expect(pending.records.find(record => record.packageName === 'dsh-vision-router')?.entryIds)
      .toEqual(['vision-router'])
    expect(pending.records).toHaveLength(32)
    // The oldest record (other-pkg) was evicted by the capacity bound.
    expect(pending.records.some(record => record.packageName === 'other-pkg')).toBe(false)

    // Malformed pending state degrades to a fresh record set.
    const brokenSeed = seedFiles(profileDir)
    brokenSeed[pendingPath] = '{not json'
    const brokenIo = new MemIo(brokenSeed)
    const brokenOutcome = await runUninstallTransaction(baseOptions({
      io: brokenIo,
      runner: new SuccessfulRunner(brokenIo, profileDir),
    }))
    expect(brokenOutcome.ok).toBe(true)
  })

  it('never overwrites third-party drift and reports ROLLBACK_INCOMPLETE', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const runner: PackageRunner = {
      remove: async () => {
        // Another writer rewrote the patch while we were running.
        io.files.set(patchPath, '# foreign drift\n- id: alien\n  disabled: true\n')
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'ROLLBACK_INCOMPLETE' })
    expect(io.readText(patchPath)).toBe('# foreign drift\n- id: alien\n  disabled: true\n')
  })

  it('reports ROLLBACK_INCOMPLETE when the frozen reinstall fails', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => {
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => {
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'reinstall failed')
      },
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'ROLLBACK_INCOMPLETE' })
  })

  it('removes a workspace policy file the failing run created during rollback', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const policyPath = join(profileDir, 'pnpm-workspace.yaml')
    const runner: PackageRunner = {
      remove: async () => {
        // The package manager created a policy file we never had before.
        io.files.set(policyPath, 'packages: []')
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner,
      workspacePolicyPath: policyPath,
    }))
    expect(outcome).toEqual({ ok: false, code: 'PACKAGE_MANAGER_FAILED' })
    expect(io.exists(policyPath)).toBe(false)
  })

  it('replaces pre-existing managed rows for the affected entries', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'cordis.patch.yml')] = [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: vision-router',
      '  disabled: true',
      '- id: unrelated',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n')
    const io = new MemIo(seed)
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const patch = io.readText(join(profileDir, 'cordis.patch.yml'))
    expect(patch).toContain('- id: unrelated')
    expect(patch).toContain('- id: vision-router')
  })

  it('refuses a managed block whose surrounding patch fails validation', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'cordis.patch.yml')] = [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: vision-router',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '- 42',
      '',
    ].join('\n')
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => { throw new Error('must not run') },
      installFrozen: async () => { throw new Error('must not run') },
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'INVALID_PATCH' })
  })

  it('tolerates an absent lockfile during postconditions', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedWithout(profileDir, join(profileDir, 'pnpm-lock.yaml'))
    const io = new MemIo(seed)
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    expect(outcome.ok).toBe(true)
  })

  it('tolerates non-object lockfile shapes during postconditions', async () => {
    for (const text of ['42', 'lockfileVersion: 9\nimporters:\n  .: null']) {
      const profileDir = 'C:\\tmp\\profile'
      const seed = seedFiles(profileDir)
      seed[join(profileDir, 'pnpm-lock.yaml')] = text
      const io = new MemIo(seed)
      const outcome = await runUninstallTransaction(baseOptions({
        io,
        runner: new SuccessfulRunner(io, profileDir),
      }))
      expect(outcome.ok).toBe(true)
    }
  })

  it('rolls a missing-at-backup policy file back to absence without a write', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedWithout(profileDir, join(profileDir, 'cordis.patch.yml'))
    const io = new MemIo(seed)
    const policyPath = join(profileDir, 'pnpm-workspace.yaml')
    const runner: PackageRunner = {
      remove: async () => {
        // Fails without ever creating the policy file.
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner,
      workspacePolicyPath: policyPath,
    }))
    expect(outcome).toEqual({ ok: false, code: 'PACKAGE_MANAGER_FAILED' })
    expect(io.exists(policyPath)).toBe(false)
    expect(io.exists(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('rolls a missing-at-backup patch back to absence', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedWithout(profileDir, join(profileDir, 'cordis.patch.yml'))
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => {
        throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'pnpm exited nonzero')
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'PACKAGE_MANAGER_FAILED' })
    expect(io.exists(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('maps unexpected internal errors to INTERNAL and rolls back', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const runner: PackageRunner = {
      remove: async () => {},
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner,
      waitForDispose: async () => {
        throw new Error('unexpected internal fault')
      },
    }))
    expect(outcome).toEqual({ ok: false, code: 'INTERNAL' })
    // Every touched file is restored to its pre-mutation image.
    expect(io.readText(join(profileDir, 'cordis.patch.yml')))
      .toBe(seedFiles(profileDir)[join(profileDir, 'cordis.patch.yml')])
  })

  it('tolerates a manifest without a dsh profile section', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'package.json')] = JSON.stringify({
      dependencies: { 'dsh-vision-router': '1.4.0' },
    })
    const io = new MemIo(seed)
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    expect(outcome.ok).toBe(true)
  })

  it('tolerates a manifest without a dependencies section', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'package.json')] = JSON.stringify({ name: 'dsh-profile-fixture' })
    const io = new MemIo(seed)
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
    }))
    expect(outcome.ok).toBe(true)
  })

  it('refuses without mutation when the patch is malformed', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'cordis.patch.yml')] = 'not: a-map\n'
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => { throw new Error('must not run') },
      installFrozen: async () => { throw new Error('must not run') },
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(['INVALID_PATCH', 'UNSUPPORTED_PATCH_SHAPE']).toContain(outcome.code)
    expect(io.writes.filter(path => !path.includes('manifest.json'))).toEqual([])
  })

  it('refuses a malformed managed block before any mutation', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    seed[join(profileDir, 'cordis.patch.yml')] = [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '# END DSH PLUGIN LIFECYCLE',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n')
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => { throw new Error('must not run') },
      installFrozen: async () => { throw new Error('must not run') },
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'MANAGED_BLOCK_INVALID' })
    expect(io.writes.filter(path => !path.includes('manifest.json'))).toEqual([])
  })

  it('fails the postcondition when the dependency declaration survives', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const seed = seedFiles(profileDir)
    const io = new MemIo(seed)
    const runner: PackageRunner = {
      remove: async () => {
        // Removes the installed link but leaves the manifest dependency alone.
        io.files.delete(join(profileDir, 'node_modules', 'dsh-vision-router'))
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'POSTCONDITION_FAILED' })
  })

  it('fails the postcondition when the installed link survives', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir))
    const runner: PackageRunner = {
      remove: async (packageName) => {
        const manifest = JSON.parse(io.readText(join(profileDir, 'package.json'))) as Record<string, unknown>
        const previous = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
          ? manifest.dependencies as Record<string, unknown>
          : {}
        manifest.dependencies = Object.fromEntries(
          Object.entries(previous).filter(([name]) => name !== packageName),
        )
        io.files.set(join(profileDir, 'package.json'), JSON.stringify(manifest))
        const lock = io.readText(join(profileDir, 'pnpm-lock.yaml'))
          .split('\n').filter(line => !line.includes(packageName)).join('\n')
        io.files.set(join(profileDir, 'pnpm-lock.yaml'), lock)
        // Deliberately leaves the installed link behind.
      },
      installFrozen: async () => {},
    }
    const outcome = await runUninstallTransaction(baseOptions({ io, runner }))
    expect(outcome).toEqual({ ok: false, code: 'POSTCONDITION_FAILED' })
  })

  it('fails the postcondition when a spliced entry stays in the tree', async () => {
    const profileDir = 'C:\\tmp\\profile'
    const io = new MemIo(seedFiles(profileDir, { manualInsert: true }))
    const outcome = await runUninstallTransaction(baseOptions({
      io,
      runner: new SuccessfulRunner(io, profileDir),
      // The Loader never dropped the spliced entry.
      probeEntryIds: ids => ids,
    }))
    expect(outcome).toEqual({ ok: false, code: 'POSTCONDITION_FAILED' })
  })
})

describe('pending removals', () => {
  it('detects importer declarations across every dependency section', () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      dsh-a:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '    devDependencies:',
      '      dsh-b:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '    optionalDependencies:',
      '      dsh-c:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
    ].join('\n')
    expect(lockImporterHas(lockfile, 'dsh-a')).toBe(true)
    expect(lockImporterHas(lockfile, 'dsh-b')).toBe(true)
    expect(lockImporterHas(lockfile, 'dsh-c')).toBe(true)
    expect(lockImporterHas(lockfile, 'dsh-absent')).toBe(false)
    // Degenerate shapes: scalars, null importers, and empty text.
    expect(lockImporterHas('42', 'dsh-a')).toBe(false)
    expect(lockImporterHas('lockfileVersion: 9\nimporters:\n  .: null', 'dsh-a')).toBe(false)
    expect(lockImporterHas('importers:\n  x:\n    dependencies:\n      dsh-a: 1.0.0', 'dsh-a')).toBe(false)
    expect(lockImporterHas('', 'dsh-a')).toBe(false)
    // An unreadable lockfile reports the dependency as present: fail closed.
    expect(lockImporterHas('- [unclosed', 'dsh-a')).toBe(true)
  })

  it('reads and clears settled records', async () => {
    const io = new MemIo({
      'C:\\tmp\\profile\\plugin-lifecycle-pending-removals.json': JSON.stringify({
        schemaVersion: 1,
        records: [
          { packageName: 'gone-pkg', entryIds: ['a'], operationId: 'op-1', createdAt: 1 },
          { packageName: 'kept-pkg', entryIds: ['b'], operationId: 'op-2', createdAt: 2 },
        ],
      }),
    })
    const pendingPath = 'C:\\tmp\\profile\\plugin-lifecycle-pending-removals.json'
    expect(readPendingRemovals(io, pendingPath)).toHaveLength(2)
    await clearSettledPendingRemovals(io, pendingPath, record => record.packageName === 'gone-pkg')
    const records = readPendingRemovals(io, pendingPath)
    expect(records.map(record => record.packageName)).toEqual(['kept-pkg'])
    await clearSettledPendingRemovals(io, pendingPath, () => true)
    expect(readPendingRemovals(io, pendingPath)).toEqual([])

    // A missing file reads empty; malformed content degrades to empty too.
    expect(readPendingRemovals(new MemIo({}), 'missing.json')).toEqual([])
    const broken = new MemIo({ 'broken.json': '{not json' })
    expect(readPendingRemovals(broken, 'broken.json')).toEqual([])
    // A valid file whose records field is not an array degrades to empty.
    const odd = new MemIo({ 'odd.json': JSON.stringify({ schemaVersion: 1, records: 'nope' }) })
    expect(readPendingRemovals(odd, 'odd.json')).toEqual([])
    // Clearing an absent file with nothing kept is a no-op without writes.
    const emptyIo = new MemIo({})
    await clearSettledPendingRemovals(emptyIo, 'missing.json', () => true)
    expect(emptyIo.writes).toEqual([])
  })
})
