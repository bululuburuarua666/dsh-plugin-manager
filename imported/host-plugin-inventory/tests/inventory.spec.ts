import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []
const tempDirs: string[] = []
const timestampMatcher = expect.any(Number) as unknown as number
const emptyCard = { title: null, description: null } as const
const builtinOrigin = {
  kind: 'official',
  customized: false,
  upstream: null,
  fork: null,
  branch: null,
  note: null,
  declaredBy: 'heuristic',
} as const

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
  it('publishes one direct list method under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
    ])
  })

  it('projects current non-group Loader entries on every call', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = inventory.list()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
        updatedAt: timestampMatcher,
        card: emptyCard,
        origin: builtinOrigin,
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
        updatedAt: timestampMatcher,
        card: emptyCard,
        origin: builtinOrigin,
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
        updatedAt: timestampMatcher,
        card: emptyCard,
        origin: builtinOrigin,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect(inventory.list().entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
      updatedAt: timestampMatcher,
      card: emptyCard,
      origin: builtinOrigin,
    })

    await ctx.loader.remove(pendingId)
    expect(inventory.list().entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('tracks the latest observed change time and falls back to first observation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { ctx, inventory } = await harness()

    now.mockReturnValue(2_000)
    const activeId = await ctx.loader.create({ name: 'cordis:active' })

    now.mockReturnValue(3_000)
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })

    now.mockReturnValue(4_000)
    const snapshot = inventory.list()
    expect(snapshot.entries.find(entry => entry.entryId === activeId)?.updatedAt).toBe(2_000)
    expect(snapshot.entries.find(entry => entry.entryId === disabledId)?.updatedAt).toBe(4_000)

    now.mockReturnValue(5_000)
    await ctx.loader.update(activeId, { disabled: true })
    expect(inventory.list().entries.find(entry => entry.entryId === activeId)?.updatedAt).toBe(5_000)
  })
})

describe('PluginInventoryGateway origin resolution', () => {
  /**
   * A fixture profile layout: root/plugins/local holds the personal plugins
   * directory; root/profiles/web is the profile with its own node_modules,
   * package.json specs, pnpm-lock.yaml resolutions, and an override file.
   */
  function profileFixture(): { profileDir: string; baseUrl: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-profile-'))
    tempDirs.push(root)
    const profileDir = join(root, 'profiles', 'web')
    const modules = join(profileDir, 'node_modules')
    const writePackage = (relative: string, manifest: Record<string, unknown>): void => {
      const dir = join(modules, relative)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    }
    mkdirSync(join(root, 'plugins', 'local', 'dsh-update-checker'), { recursive: true })
    // An absolute file: target into the local plugins directory.
    const absTarget = join(root, 'plugins', 'local', 'dsh-abs')
    mkdirSync(absTarget, { recursive: true })
    writePackage('dsh-abs', { name: 'dsh-abs' })
    writePackage('dsh-vision-router', {
      name: 'dsh-vision-router',
      repository: { type: 'git', url: 'git+https://github.com/ysr666/dsh-vision-router.git' },
    })
    writePackage('dsh-update-checker', { name: 'dsh-update-checker' })
    writePackage('@omdsh-dev/dsh-genui', { name: '@omdsh-dev/dsh-genui', dsh: { origin: { kind: 'personal' } } })
    writePackage('dsh-forked', {
      name: 'dsh-forked',
      dsh: { origin: { kind: 'opensource', fork: 'https://github.com/me/dsh-forked', branch: 'my-tweaks' } },
    })
    writePackage('dsh-bad-manifest', { name: 'dsh-bad-manifest', dsh: { origin: { kind: 'bogus' } } })
    writePackage('@deepseek-ai/dsh-client-ui-context-panel', { name: '@deepseek-ai/dsh-client-ui-context-panel' })
    // An aliased package: manifest name differs from the module key, and the
    // override keys the module key.
    writePackage('dsh-aliased', { name: '@actual/aliased' })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-vision-router': '1.4.0',
        'dsh-update-checker': 'file:../../plugins/local/dsh-update-checker',
        '@omdsh-dev/dsh-genui': 'github:omdsh-dev/dsh-genui',
        'dsh-abs': `file:${absTarget}`,
      },
    }))
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      dsh-vision-router:',
      '        specifier: 1.4.0',
      '        version: 1.4.0',
      '      dsh-update-checker:',
      '        specifier: file:../../plugins/local/dsh-update-checker',
      '        version: file:../../plugins/local/dsh-update-checker(react@18.3.1)',
      '',
    ].join('\n'))
    writeFileSync(join(profileDir, 'plugin-origins.json'), JSON.stringify({
      schemaVersion: 1,
      packages: {
        '@deepseek-ai/dsh-client-ui-context-panel': { kind: 'personal', note: '用户自建面板' },
        'dsh-aliased': { kind: 'personal' },
        broken: { kind: 'bogus' },
      },
    }))
    return { profileDir, baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href }
  }

  async function originHarness(baseUrl: string): Promise<{ ctx: Context; inventory: PluginInventoryGateway }> {
    const ctx = new Context()
    contexts.push(ctx)
    // The gateway reads baseUrl through its own context chain (cordis service
    // ctx tracking), so the value must live on the root context, mirroring
    // how the CLI boot sets it.
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader, { baseUrl })
    await ctx.plugin(PluginInventoryGateway)
    return { ctx, inventory: ctx.get('pluginInventory') as PluginInventoryGateway }
  }

  it('resolves personal, official-override, opensource, and fork-customized origins', async () => {
    const { ctx, inventory } = await originHarness(profileFixture().baseUrl)
    // Disabled entries never import their modules, so real package names are
    // safe here; origin resolution does not depend on enablement.
    await ctx.loader.create({ name: 'dsh-update-checker', disabled: true })
    await ctx.loader.create({ name: 'dsh-vision-router', disabled: true })
    await ctx.loader.create({ name: '@omdsh-dev/dsh-genui', disabled: true })
    await ctx.loader.create({ name: 'dsh-forked', disabled: true })
    await ctx.loader.create({ name: 'dsh-bad-manifest', disabled: true })
    await ctx.loader.create({ name: '@deepseek-ai/dsh-client-ui-context-panel', disabled: true })
    await ctx.loader.create({ name: 'dsh-abs', disabled: true })

    const snapshot = inventory.list()
    const byName = (name: string) => snapshot.entries.find(entry => entry.moduleName === name)

    expect(byName('dsh-update-checker')?.origin).toMatchObject({ kind: 'personal', declaredBy: 'heuristic' })
    expect(byName('dsh-abs')?.origin).toMatchObject({ kind: 'personal', declaredBy: 'heuristic' })
    expect(byName('dsh-vision-router')?.origin).toMatchObject({
      kind: 'opensource',
      customized: false,
      upstream: 'git+https://github.com/ysr666/dsh-vision-router.git',
      declaredBy: 'heuristic',
    })
    expect(byName('@omdsh-dev/dsh-genui')?.origin).toMatchObject({ kind: 'personal', declaredBy: 'manifest' })
    expect(byName('dsh-forked')?.origin).toMatchObject({
      kind: 'opensource',
      customized: true,
      fork: 'https://github.com/me/dsh-forked',
      branch: 'my-tweaks',
      declaredBy: 'manifest',
    })
    expect(byName('@deepseek-ai/dsh-client-ui-context-panel')?.origin).toMatchObject({
      kind: 'personal',
      note: { zh: '用户自建面板', en: '用户自建面板' },
      declaredBy: 'user-override',
    })
    // Override keys fall back to the module key when the manifest name differs.
    await ctx.loader.create({ name: 'dsh-aliased', disabled: true })
    expect(inventory.list().entries.find(entry => entry.moduleName === 'dsh-aliased')?.origin)
      .toMatchObject({ kind: 'personal', declaredBy: 'user-override' })

    // Diagnostics stay sanitized: codes plus package names, no paths or specs.
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      { code: 'manifest-invalid', packageName: 'dsh-bad-manifest' },
      { code: 'override-entry-invalid', packageName: 'broken' },
    ]))
    for (const diagnostic of snapshot.diagnostics ?? []) {
      expect(Object.keys(diagnostic).sort()).toEqual(['code', 'packageName'])
    }
  })

  it('gives every Loader entry of one package the same origin', async () => {
    const { ctx, inventory } = await originHarness(profileFixture().baseUrl)
    await ctx.loader.create({ name: 'dsh-vision-router', disabled: true })
    await ctx.loader.create({ name: 'dsh-vision-router', disabled: true })
    const origins = inventory.list().entries
      .filter(entry => entry.moduleName === 'dsh-vision-router')
      .map(entry => entry.origin)
    expect(origins).toHaveLength(2)
    expect(origins[0]).toEqual(origins[1])
  })

  it('keeps heuristic results when no profile context exists', async () => {
    const { ctx, inventory } = await harness()
    await ctx.loader.create({ name: 'unresolvable-third-party', disabled: true })
    const snapshot = inventory.list()
    const entry = snapshot.entries.find(candidate => candidate.moduleName === 'unresolvable-third-party')
    expect(entry?.origin).toEqual({
      kind: 'opensource',
      customized: false,
      upstream: null,
      fork: null,
      branch: null,
      note: null,
      declaredBy: 'heuristic',
    })
    expect(snapshot.diagnostics).toBeUndefined()
  })

  it('degrades to profile-less behavior on an invalid base URL', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = ':::'
    await ctx.plugin(Loader)
    await ctx.plugin(PluginInventoryGateway)
    const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
    await ctx.loader.create({ name: 'unresolvable-third-party', disabled: true })
    const entry = inventory.list().entries.find(candidate => candidate.moduleName === 'unresolvable-third-party')
    expect(entry?.origin?.kind).toBe('opensource')
  })

  it('runs cleanly when the profile has no override file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-nooverride-'))
    tempDirs.push(root)
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    const { ctx, inventory } = await originHarness(pathToFileURL(join(profileDir, 'cordis.yml')).href)
    await ctx.loader.create({ name: 'unresolvable-third-party', disabled: true })
    const snapshot = inventory.list()
    expect(snapshot.entries[0]?.origin?.kind).toBe('opensource')
    expect(snapshot.diagnostics).toBeUndefined()
  })
})
