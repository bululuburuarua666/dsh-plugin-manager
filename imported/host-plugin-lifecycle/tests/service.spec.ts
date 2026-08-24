import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import PluginLifecycleGateway from '../src/index.ts'
import { readManagedToggleRows } from '../src/patch-editor.ts'
import { PluginLifecycleTokenStore } from '../src/token-store.ts'
import { PluginLifecycleOperationStore } from '../src/operation-store.ts'
import { lifecycleFailure } from '../src/failure.ts'
import type { PluginLifecycleOperationView } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<PluginLifecycleGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginLifecycleGateway)
  return ctx.get('pluginLifecycle') as PluginLifecycleGateway
}

describe('PluginLifecycleGateway shell', () => {
  it('publishes the four Remote methods under the pluginLifecycle namespace', async () => {
    const gateway = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'pluginLifecycle',
      namespace: 'pluginLifecycle',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'capabilities', invocation: { kind: 'direct' } },
      { method: 'preview', invocation: { kind: 'direct' } },
      { method: 'execute', invocation: { kind: 'direct' } },
      { method: 'operation', invocation: { kind: 'direct' } },
    ])
  })

  it('fails unknown operations with a structured code', async () => {
    const gateway = await harness()
    const failureOf = (run: () => unknown): { code: string; message: string } => {
      try {
        run()
      } catch (error) {
        return (error as { failure: { code: string; message: string } }).failure
      }
      throw new Error('expected a structured failure')
    }
    expect(failureOf(() => gateway.operation({ operationId: 'nope' })).message).toMatch(/unknown operation/)
  })
})

describe('PluginLifecycleTokenStore', () => {
  const binding = {
    action: 'disable',
    entryId: 'entry-1',
    packageName: 'pkg',
    affectedEntryIds: ['entry-1'],
    restartRequired: false,
    revision: 'rev-1',
  } as const

  it('issues and consumes a token exactly once', () => {
    const tick = 1_000
    const store = new PluginLifecycleTokenStore({ now: () => tick, randomHex: () => 'a'.repeat(32) })
    const { token, expiresAt } = store.issue(binding)
    expect(token).toBe('a'.repeat(32))
    expect(expiresAt).toBe(61_000)
    expect(store.consume(token)).toMatchObject({ entryId: 'entry-1', action: 'disable' })
    expect(store.consume(token)).toBeNull()
  })

  it('expires tokens at the TTL and sweeps them lazily', () => {
    let tick = 0
    let counter = 0
    const store = new PluginLifecycleTokenStore({
      now: () => tick,
      randomHex: () => (counter++).toString(16).padStart(4, '0'),
      ttlMs: 100,
    })
    const first = store.issue(binding)
    tick = 101
    expect(store.consume(first.token)).toBeNull()
    // An expired token is deleted on first consume and never revives.
    expect(store.consume(first.token)).toBeNull()

    tick = 200
    store.issue(binding)
    tick = 400 // past the second token's expiry; issuing sweeps it
    store.issue(binding)
    tick = 401
    expect(store.consume('0001')).toBeNull()
  })

  it('evicts the oldest token beyond capacity', () => {
    let counter = 0
    const store = new PluginLifecycleTokenStore({
      randomHex: () => (counter++).toString(16),
      capacity: 2,
    })
    const first = store.issue(binding)
    store.issue(binding)
    const third = store.issue(binding)
    expect(store.consume(first.token)).toBeNull()
    expect(store.consume(third.token)).not.toBeNull()
  })
})

describe('PluginLifecycleOperationStore', () => {
  it('creates, updates, and reads operations', () => {
    let counter = 0
    const store = new PluginLifecycleOperationStore({ randomHex: () => `op-${counter++}` })
    const id = store.create('uninstall')
    expect(store.get(id)).toEqual({
      operationId: id,
      state: 'queued',
      action: 'uninstall',
      errorCode: null,
      restartRequired: false,
    })
    store.update(id, { state: 'running' })
    store.update(id, { state: 'succeeded', restartRequired: true })
    expect(store.get(id)).toMatchObject({ state: 'succeeded', restartRequired: true })
    store.update(id, { errorCode: null, restartRequired: false })
    expect(store.get(id)).toMatchObject({ errorCode: null, restartRequired: false })
    store.update('unknown', { state: 'failed' })
    expect(store.get('unknown')).toBeNull()
  })

  it('evicts the oldest operation beyond capacity', () => {
    let counter = 0
    const store = new PluginLifecycleOperationStore({ randomHex: () => `op-${counter++}`, capacity: 1 })
    const first = store.create('disable')
    const second = store.create('enable')
    expect(store.get(first)).toBeNull()
    expect(store.get(second)).not.toBeNull()
  })
})

describe('lifecycleFailure', () => {
  it('carries the structured payload the gateway preserves', () => {
    const failure = lifecycleFailure('PROFILE_CHANGED', 'evidence drifted')
    expect(failure.failure).toEqual({ code: 'PROFILE_CHANGED', message: 'evidence drifted', details: {} })
  })

  it('maps every capability block reason to its wire code', async () => {
    const { blockReasonToCode } = await import('../src/index.ts')
    expect(blockReasonToCode('read-only-remote')).toBe('READ_ONLY_REMOTE')
    expect(blockReasonToCode('protected-plugin')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('engine-owned')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('template-bundle')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('ambiguous-package')).toBe('AMBIGUOUS_PACKAGE')
    expect(blockReasonToCode('manual-insert-unsupported')).toBe('UNSUPPORTED_PATCH_SHAPE')
    expect(blockReasonToCode('not-direct-dependency')).toBe('NOT_DIRECT_DEPENDENCY')
    expect(blockReasonToCode('anything-else')).toBe('NOT_DIRECT_DEPENDENCY')
  })
})

/** The fixture plugin every toggled entry mounts. */
const noopPlugin: Plugin.Function = () => {}

/** Read a patch file, tolerating its absence. */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Simulate the profile patch watcher: poll the patch file and drive managed
 * rows into the live Loader, exactly as the HMR reapply would.
 */
function startPatchDriver(ctx: Context, patchPath: string): () => void {
  let last = ''
  const timer = setInterval(() => {
    const text = readText(patchPath)
    if (text === last) return
    last = text
    const rows = readManagedToggleRows(text)
    if (rows === null || !rows.ok) return
    for (const row of rows.rows) {
      const entry = [...ctx.loader.entries()].find(candidate => candidate.id === row.entryId)
      if (entry === undefined || entry.disabled === row.disabled) continue
      void ctx.loader.update(row.entryId, { disabled: row.disabled ? true : null }).catch(() => {})
    }
  }, 10)
  return () => { clearInterval(timer) }
}

interface ToggleHarness {
  ctx: Context
  gateway: PluginLifecycleGateway
  profileDir: string
  patchPath: string
}

const toggleTempDirs: string[] = []
const stopDrivers: Array<() => void> = []

afterEach(() => {
  for (const stop of stopDrivers.splice(0)) stop()
  for (const dir of toggleTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function toggleHarness(options: { withDriver?: boolean; webHost?: string } = {}): Promise<ToggleHarness> {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-toggle-'))
  toggleTempDirs.push(profileDir)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fixture' }))
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
  if (options.webHost !== undefined) {
    ctx.provide('webServer', { host: options.webHost })
  }
  await ctx.plugin(Loader)
  ctx.loader.builtins.noop = noopPlugin
  await ctx.plugin(PluginLifecycleGateway)
  const gateway = ctx.get('pluginLifecycle') as PluginLifecycleGateway
  if (options.withDriver !== false) stopDrivers.push(startPatchDriver(ctx, patchPath))
  return { ctx, gateway, profileDir, patchPath }
}

async function settle(gateway: PluginLifecycleGateway, operationId: string): Promise<PluginLifecycleOperationView> {
  const deadline = Date.now() + 8_000
  for (;;) {
    const view = gateway.operation({ operationId })
    if (view.state !== 'queued' && view.state !== 'running') return view
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/** Capture the structured failure payload of a throwing call. */
async function failureCodeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { failure: { code: string } }).failure.code
  }
  throw new Error('expected a structured failure')
}

describe('PluginLifecycleGateway toggle flow', () => {
  it('disables and re-enables an entry with the managed block persisted', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness()
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })

    const capabilities = gateway.capabilities()
    expect(capabilities.persistence).toBe('writable')
    const capability = capabilities.entries.find(entry => entry.entryId === entryId)
    expect(capability?.canToggle).toBe(true)
    expect(capability?.canUninstall).toBe(false)

    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    expect(preview.restartRequired).toBe(false)
    expect(preview.affectedEntryIds).toEqual([entryId])
    const started = gateway.execute({ token: preview.token })
    const done = await settle(gateway, started.operationId)
    expect(done.state).toBe('succeeded')
    expect([...ctx.loader.entries()].find(entry => entry.id === entryId)?.disabled).toBe(true)

    const rows = readManagedToggleRows(readText(patchPath))
    expect(rows !== null && rows.ok ? rows.rows : []).toEqual([{ entryId, disabled: true }])

    // Enable again: the row flips to the explicit null override.
    const next = gateway.capabilities()
    const enable = gateway.preview({ entryId, action: 'enable', expectedRevision: next.revision })
    const enabled = await settle(gateway, (gateway.execute({ token: enable.token })).operationId)
    expect(enabled.state).toBe('succeeded')
    expect([...ctx.loader.entries()].find(entry => entry.id === entryId)?.disabled).toBe(false)
    const after = readManagedToggleRows(readText(patchPath))
    expect(after !== null && after.ok ? after.rows : []).toEqual([{ entryId, disabled: false }])
  })

  it('rejects stale revisions, unknown entries, and unknown tokens', async () => {
    const { ctx, gateway } = await toggleHarness()
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()

    expect(await failureCodeOf(() => gateway.preview({ entryId, action: 'disable', expectedRevision: 'stale' })))
      .toBe('PROFILE_CHANGED')
    expect(await failureCodeOf(() => gateway.preview({ entryId: 'nope', action: 'disable', expectedRevision: capabilities.revision })))
      .toBe('ENTRY_NOT_FOUND')
    expect(await failureCodeOf(() => gateway.execute({ token: 'never-issued' }))).toBe('PROFILE_CHANGED')

    // Evidence drift between preview and execute is caught at execute time.
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    await ctx.loader.create({ name: 'cordis:noop' })
    expect(await failureCodeOf(() => gateway.execute({ token: preview.token }))).toBe('PROFILE_CHANGED')
  })

  it('refuses mutations on a read-only (non-loopback) surface', async () => {
    const { ctx, gateway } = await toggleHarness({ webHost: '0.0.0.0' })
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    expect(capabilities.persistence).toBe('read-only')
    expect(capabilities.entries.find(entry => entry.entryId === entryId)?.canToggle).toBe(false)
    expect(await failureCodeOf(() => gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })))
      .toBe('READ_ONLY_REMOTE')
  })

  it('refuses an uninstall preview for non-direct entries', async () => {
    const { ctx, gateway } = await toggleHarness()
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    try {
      gateway.preview({ entryId, action: 'uninstall', expectedRevision: capabilities.revision })
      throw new Error('unreachable')
    } catch (error) {
      expect((error as { failure: { code: string } }).failure.code).toBe('NOT_DIRECT_DEPENDENCY')
    }
  })

  it('maps protected and template bundles to PROTECTED_PLUGIN on uninstall preview', async () => {
    const { ctx, gateway, profileDir } = await toggleHarness()
    const protectedDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-host-plugin-lifecycle')
    mkdirSync(protectedDir, { recursive: true })
    writeFileSync(join(protectedDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host-plugin-lifecycle' }))
    const entryId = await ctx.loader.create({ name: '@deepseek-ai/dsh-host-plugin-lifecycle', disabled: true })
    const capabilities = gateway.capabilities()
    expect(await failureCodeOf(() => gateway.preview({
      entryId, action: 'uninstall', expectedRevision: capabilities.revision,
    }))).toBe('PROTECTED_PLUGIN')

    // Template bundle: listed in dsh.profile.bundles but not a dependency.
    const templateDir = join(profileDir, 'node_modules', 'dsh-template-pkg')
    mkdirSync(templateDir, { recursive: true })
    writeFileSync(join(templateDir, 'package.json'), JSON.stringify({ name: 'dsh-template-pkg' }))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-fixture',
      dsh: { profile: { bundles: ['dsh-template-pkg'] } },
    }))
    const templateId = await ctx.loader.create({ name: 'dsh-template-pkg', disabled: true })
    const next = gateway.capabilities()
    expect(await failureCodeOf(() => gateway.preview({
      entryId: templateId, action: 'uninstall', expectedRevision: next.revision,
    }))).toBe('PROTECTED_PLUGIN')
  })

  it('times out and restores the before image when the Loader never applies', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness({ withDriver: false })
    writeFileSync(patchPath, '# handwritten\n- id: other\n  disabled: true\n')
    const before = readText(patchPath)
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const started = gateway.execute({ token: preview.token })
    const done = await settle(gateway, started.operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    expect(readText(patchPath)).toBe(before)
  }, 15_000)

  it('keeps the null row and reports BLOCKED_BY_ANCESTOR under a disabled group', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness()
    const { default: Group } = await import('@deepseek-ai/cordis-plugin-group')
    ctx.loader.builtins.group = Group
    const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, disabled: true, config: [] })
    const childId = await ctx.loader.create({ name: 'cordis:noop' }, groupId)
    expect([...ctx.loader.entries()].find(entry => entry.id === childId)?.disabled).toBe(true)

    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId: childId, action: 'enable', expectedRevision: capabilities.revision })
    const done = await settle(gateway, (gateway.execute({ token: preview.token })).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('BLOCKED_BY_ANCESTOR')
    const rows = readManagedToggleRows(readText(patchPath))
    expect(rows !== null && rows.ok ? rows.rows : []).toEqual([{ entryId: childId, disabled: false }])
  }, 15_000)

  it('fails cleanly when the managed block is malformed', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness()
    writeFileSync(patchPath, [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '# END DSH PLUGIN LIFECYCLE',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const done = await settle(gateway, (gateway.execute({ token: preview.token })).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('MANAGED_BLOCK_INVALID')
  })

  it('fails cleanly when the patch around the managed block is invalid', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness({ withDriver: false })
    writeFileSync(patchPath, [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      '- id: prior',
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '- 42',
      '',
    ].join('\n'))
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const done = await settle(gateway, (gateway.execute({ token: preview.token })).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('INVALID_PATCH')
  })

  it('reports ENTRY_CHANGED when the entry leaves the tree mid-toggle', async () => {
    const { ctx, gateway } = await toggleHarness()
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const started = gateway.execute({ token: preview.token })
    await ctx.loader.remove(entryId)
    const done = await settle(gateway, started.operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('ENTRY_CHANGED')
  })

  it('refuses execute on a surface that turned read-only and a vanished entry', async () => {
    // (a) Read-only flip between preview and execute.
    {
      const { ctx, gateway } = await toggleHarness()
      const entryId = await ctx.loader.create({ name: 'cordis:noop' })
      const capabilities = gateway.capabilities()
      const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
      ctx.provide('webServer', { host: '0.0.0.0' })
      expect(await failureCodeOf(() => gateway.execute({ token: preview.token }))).toBe('READ_ONLY_REMOTE')
    }
    // (b) A previewed entry that vanishes before execute: the loader-fact
    //     change also flips the revision, so the drift refusal fires first.
    {
      const { ctx, gateway } = await toggleHarness()
      const entryId = await ctx.loader.create({ name: 'cordis:noop' })
      const capabilities = gateway.capabilities()
      const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
      await ctx.loader.remove(entryId)
      expect(await failureCodeOf(() => gateway.execute({ token: preview.token }))).toBe('PROFILE_CHANGED')
    }
  })

  it('reports ROLLBACK_INCOMPLETE when the restore lock cannot be taken', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness({ withDriver: false })
    writeFileSync(patchPath, '# handwritten\n- id: other\n  disabled: true\n')
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const started = gateway.execute({ token: preview.token })
    // The initial write has already released its lock by now; squatting the
    // lock path makes the timed-out toggle's restore acquisition fail.
    await new Promise(resolve => setTimeout(resolve, 300))
    mkdirSync(`${patchPath}.lock`)
    const done = await settle(gateway, started.operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('ROLLBACK_INCOMPLETE')
  }, 15_000)

  it('keeps the original code when a drifted patch is never overwritten on restore', async () => {
    const { ctx, gateway, patchPath } = await toggleHarness({ withDriver: false })
    writeFileSync(patchPath, '# handwritten\n- id: other\n  disabled: true\n')
    const entryId = await ctx.loader.create({ name: 'cordis:noop' })
    const capabilities = gateway.capabilities()
    const preview = gateway.preview({ entryId, action: 'disable', expectedRevision: capabilities.revision })
    const started = gateway.execute({ token: preview.token })
    // An external writer replaces the patch during the apply window.
    await new Promise(resolve => setTimeout(resolve, 300))
    writeFileSync(patchPath, '# foreign drift\n- id: alien\n  disabled: true\n')
    const done = await settle(gateway, started.operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    expect(readText(patchPath)).toBe('# foreign drift\n- id: alien\n  disabled: true\n')
  }, 15_000)

  it('derives empty evidence from an invalid base URL', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = ':::'
    await ctx.plugin(Loader)
    await ctx.plugin(PluginLifecycleGateway)
    const gateway = ctx.get('pluginLifecycle') as PluginLifecycleGateway
    const capabilities = gateway.capabilities()
    expect(capabilities.entries).toEqual([])
    expect(capabilities.persistence).toBe('writable')
    expect(capabilities.revision).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('PluginLifecycleGateway uninstall flow', () => {
  /** A gateway whose package runner is fully faked for unit tests. */
  class FakedGateway extends PluginLifecycleGateway {
    public readonly runnerCalls: string[] = []
    public failRunner = false

    protected override createPackageRunner() {
      const runnerCalls = this.runnerCalls
      const failRunner = () => this.failRunner
      return {
        remove: async (packageName: string, cwd: string): Promise<void> => {
          runnerCalls.push(`remove:${packageName}`)
          if (failRunner()) throw lifecycleFailure('PACKAGE_MANAGER_FAILED', 'faked failure')
          const manifestPath = join(cwd, 'package.json')
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
          const previous = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
            ? manifest.dependencies as Record<string, unknown>
            : {}
          manifest.dependencies = Object.fromEntries(
            Object.entries(previous).filter(([name]) => name !== packageName),
          )
          writeFileSync(manifestPath, JSON.stringify(manifest))
          const lockfile = join(cwd, 'pnpm-lock.yaml')
          const lock = readFileSync(lockfile, 'utf8').split('\n').filter(line => !line.includes(packageName)).join('\n')
          writeFileSync(lockfile, lock)
          rmSync(join(cwd, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
        },
        installFrozen: async (_cwd: string): Promise<void> => {
          runnerCalls.push('install-frozen')
        },
      }
    }
  }

  interface UninstallHarness {
    ctx: Context
    gateway: FakedGateway
    profileDir: string
    patchPath: string
  }

  async function uninstallHarness(options: { withDriver?: boolean } = {}): Promise<UninstallHarness> {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-uninstall-'))
    toggleTempDirs.push(profileDir)
    const pkgDir = join(profileDir, 'node_modules', 'dsh-fixture-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-fixture-pkg', main: 'index.js' }))
    // A real entry point so an enabled entry can import cleanly in tests.
    writeFileSync(join(pkgDir, 'index.js'), 'export function apply() {}\n')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-fixture-pkg': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-fixture-pkg'] } },
    }))
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      dsh-fixture-pkg:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
    const patchPath = join(profileDir, 'cordis.patch.yml')

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.noop = noopPlugin
    await ctx.plugin(FakedGateway)
    const gateway = ctx.get('pluginLifecycle') as FakedGateway
    if (options.withDriver !== false) stopDrivers.push(startPatchDriver(ctx, patchPath))
    return { ctx, gateway, profileDir, patchPath }
  }

  it('uninstalls a direct dependency package-scoped and records restart state', async () => {
    const { ctx, gateway, profileDir } = await uninstallHarness()
    // Disabled at creation so the Loader never imports the fixture package.
    const entryId = await ctx.loader.create({ name: 'dsh-fixture-pkg', disabled: true })

    const capabilities = gateway.capabilities()
    const capability = capabilities.entries.find(entry => entry.entryId === entryId)
    expect(capability?.canUninstall).toBe(true)
    expect(capability?.canToggle).toBe(true)

    const preview = gateway.preview({ entryId, action: 'uninstall', expectedRevision: capabilities.revision })
    expect(preview.packageName).toBe('dsh-fixture-pkg')
    expect(preview.restartRequired).toBe(true)

    const done = await settle(gateway, (gateway.execute({ token: preview.token })).operationId)
    if (done.state !== 'succeeded') {
      expect(done).toEqual('uninstall-should-succeed')
      return
    }
    expect(done.restartRequired).toBe(true)
    expect(gateway.runnerCalls).toEqual(['remove:dsh-fixture-pkg'])

    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.dependencies).toEqual({})
    expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(existsSync(join(profileDir, 'node_modules', 'dsh-fixture-pkg'))).toBe(false)
    const pending = JSON.parse(readFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), 'utf8')) as {
      records: Array<{ packageName: string; entryIds: string[] }>
    }
    expect(pending.records[0]).toMatchObject({ packageName: 'dsh-fixture-pkg', entryIds: [entryId] })
  }, 20_000)

  it('fails with TIMEOUT when disposal never happens and rolls back', async () => {
    const { ctx, gateway, profileDir, patchPath } = await uninstallHarness({ withDriver: false })
    // Enabled (the fixture entry point imports cleanly) so disposal is
    // genuinely pending; no patch driver means the Loader never applies it.
    await ctx.loader.create({ name: 'dsh-fixture-pkg' })
    const beforePatch = readText(patchPath)
    const beforeManifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const capabilities = gateway.capabilities()
    const entryId = capabilities.entries[0]?.entryId ?? 'missing'
    const preview = gateway.preview({ entryId, action: 'uninstall', expectedRevision: capabilities.revision })
    const done = await settle(gateway, (gateway.execute({ token: preview.token })).operationId)
    expect(done.state).toBe('failed')
    expect(done.errorCode).toBe('TIMEOUT')
    expect(gateway.runnerCalls).toEqual(['install-frozen'])
    // The patch and manifest were restored by the rollback path.
    expect(readText(patchPath)).toBe(beforePatch)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(beforeManifest)
  }, 20_000)

  it('cleans settled pending removals on startup', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-cleanup-'))
    toggleTempDirs.push(profileDir)
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
    writeFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    await ctx.plugin(Loader)
    await ctx.plugin(PluginLifecycleGateway)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(readText(patchPath)).toBe('- id: other\n  disabled: true\n')
    expect(JSON.parse(readFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), 'utf8')) as { records: unknown[] })
      .toEqual({ schemaVersion: 1, records: [] })
  })

  it('cleans settled pending removals even without a patch file', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-cleanup-nopatch-'))
    toggleTempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: ['gone-entry'], operationId: 'op-1', createdAt: 1 }],
    }))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    await ctx.plugin(Loader)
    await ctx.plugin(PluginLifecycleGateway)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(JSON.parse(readFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), 'utf8')) as { records: unknown[] })
      .toEqual({ schemaVersion: 1, records: [] })
  })

  it('keeps pending records whose entries still exist on startup', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-cleanup-keep-'))
    toggleTempDirs.push(profileDir)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    // The manifest still declares the package: the record must be kept.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-gone': '1.0.0' },
    }))

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.noop = noopPlugin
    const entryId = await ctx.loader.create({ name: 'cordis:noop', disabled: true })
    // The pending record references a real, still-present Loader entry.
    writeFileSync(patchPath, [
      '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit',
      `- id: ${entryId}`,
      '  disabled: true',
      '# END DSH PLUGIN LIFECYCLE',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{ packageName: 'dsh-gone', entryIds: [entryId], operationId: 'op-1', createdAt: 1 }],
    }))

    await ctx.plugin(PluginLifecycleGateway)
    await new Promise(resolve => setTimeout(resolve, 50))

    const pending = JSON.parse(readFileSync(join(profileDir, 'plugin-lifecycle-pending-removals.json'), 'utf8')) as {
      records: Array<{ entryIds: string[] }>
    }
    expect(pending.records).toEqual([expect.objectContaining({ entryIds: [entryId] })])
    expect(readText(patchPath)).toContain(`- id: ${entryId}`)
  })

  it('exposes the real no-shell package runner for production wiring', async () => {
    class ExposedGateway extends PluginLifecycleGateway {
      expose() {
        return this.createPackageRunner()
      }
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(ExposedGateway)
    const gateway = ctx.get('pluginLifecycle') as ExposedGateway
    const runner = gateway.expose()
    expect(typeof runner.remove).toBe('function')
    expect(typeof runner.installFrozen).toBe('function')
    // A nonexistent working directory fails closed through the real runner
    // boundary without spawning anything meaningful; the exact code depends
    // on whether this process itself runs under pnpm.
    const removeCode = await failureCodeOf(() => runner.remove('dsh-x', 'C:\\nowhere'))
    expect(['PNPM_UNAVAILABLE', 'PACKAGE_MANAGER_FAILED']).toContain(removeCode)
    const installCode = await failureCodeOf(() => runner.installFrozen('C:\\nowhere'))
    expect(['PNPM_UNAVAILABLE', 'PACKAGE_MANAGER_FAILED']).toContain(installCode)
  })
})

