import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { InventoryAssembler, type RosterEntry } from '../../src/host/inventory.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profileFixture(): { home: string; profileDir: string; baseUrl: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mgr-inv-'))
  tempDirs.push(home)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
  return { home, profileDir, baseUrl }
}

function withPackage(profileDir: string, name: string, extra: Record<string, unknown> = {}): string {
  const pkg = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, ...extra }))
  return pkg
}

describe('InventoryAssembler', () => {
  it('returns an empty roster for an empty Loader', () => {
    const { baseUrl } = profileFixture()
    const assembler = new InventoryAssembler(baseUrl)
    expect(assembler.list([])).toEqual({ entries: [], diagnostics: [] })
  })

  it('classifies cordis: builtins as official', () => {
    const { baseUrl } = profileFixture()
    const assembler = new InventoryAssembler(baseUrl)
    const roster: RosterEntry[] = [{ entryId: 'include:timer', moduleName: 'cordis:timer', disabled: false }]
    const snapshot = assembler.list(roster)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]!.origin.kind).toBe('official')
    expect(snapshot.entries[0]!.origin.declaredBy).toBe('heuristic')
  })

  it('classifies a local-plugins file: dependency as personal', () => {
    const { home, profileDir } = profileFixture()
    // A file: dependency whose real location sits under $DSH_HOME/plugins/local.
    const localPkg = join(home, 'plugins', 'local', 'my-local-plugin')
    mkdirSync(localPkg, { recursive: true })
    writeFileSync(join(localPkg, 'package.json'), JSON.stringify({ name: 'my-local-plugin' }))
    // Link it into the profile's node_modules. A Windows junction needs no
    // privilege and matches how pnpm links file: dependencies on Windows.
    if (process.platform === 'win32') {
      symlinkSync(localPkg, join(profileDir, 'node_modules', 'my-local-plugin'), 'junction')
    } else {
      symlinkSync(localPkg, join(profileDir, 'node_modules', 'my-local-plugin'), 'dir')
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'my-local-plugin': 'file:../plugins/local/my-local-plugin' },
    }))
    // pnpm-lock with a matching file: resolution.
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      'lockfileVersion: \'9.0\'',
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      my-local-plugin:',
      "        specifier: file:../plugins/local/my-local-plugin",
      "        version: file:../plugins/local/my-local-plugin",
      '',
    ].join('\n'))

    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'x1', moduleName: 'my-local-plugin', disabled: false }])
    expect(snapshot.entries[0]!.origin.kind).toBe('personal')
  })

  it('applies profile plugin-origins.json overrides over heuristics', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    writeFileSync(join(profileDir, 'plugin-origins.json'), JSON.stringify({
      schemaVersion: 1,
      packages: { 'dsh-vision-router': { kind: 'personal', note: { zh: '本地维护', en: 'locally maintained' } } },
    }))
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'include:vision-router', moduleName: 'dsh-vision-router', disabled: false }])
    expect(snapshot.entries[0]!.origin.kind).toBe('personal')
    expect(snapshot.entries[0]!.origin.declaredBy).toBe('user-override')
    expect(snapshot.entries[0]!.origin.note?.zh).toBe('本地维护')
  })

  it('reports opensource with the repository upstream for third-party registry packages', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'include:vision-router', moduleName: 'dsh-vision-router', disabled: false }])
    expect(snapshot.entries[0]!.origin.kind).toBe('opensource')
    expect(snapshot.entries[0]!.origin.upstream).toBe('https://github.com/example/vision-router')
  })

  it('rejects an official claim from a package outside trusted locations', () => {
    const { profileDir } = profileFixture()
    // Package name looks official, manifest declares official, but its real
    // path is the profile's own node_modules (not the engine tree).
    withPackage(profileDir, '@deepseek-ai/dsh-fake-official', {
      repository: 'https://github.com/example/not-official',
      dsh: { origin: { kind: 'official' } },
    })
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'include:fake', moduleName: '@deepseek-ai/dsh-fake-official', disabled: false }])
    expect(snapshot.entries[0]!.origin.kind).toBe('opensource')
    expect(snapshot.diagnostics).toContainEqual({
      code: 'official-claim-rejected',
      packageName: '@deepseek-ai/dsh-fake-official',
    })
  })

  it('carries disabled rows as enabled=false with canToggle=false on the T02 surface', () => {
    const { baseUrl } = profileFixture()
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'd1', moduleName: 'cordis:timer', disabled: true }])
    expect(snapshot.entries[0]!.enabled).toBe(false)
    expect(snapshot.entries[0]!.canToggle).toBe(false)
    // Uninstall gating is the T03 engine's job; T02 fails closed everywhere.
    expect(snapshot.entries[0]!.canUninstall).toBe(false)
  })

  it('splits detectedOrigin from the overridden effective origin', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    writeFileSync(join(profileDir, 'plugin-origins.json'), JSON.stringify({
      schemaVersion: 1,
      packages: { 'dsh-vision-router': { kind: 'personal' } },
    }))
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'include:vision-router', moduleName: 'dsh-vision-router', disabled: false }])
    const entry = snapshot.entries[0]!
    // Effective: the user override wins. Detected: the automatic chain only.
    expect(entry.origin.kind).toBe('personal')
    expect(entry.origin.declaredBy).toBe('user-override')
    expect(entry.detectedOrigin.kind).toBe('opensource')
    expect(entry.detectedOrigin.declaredBy).toBe('heuristic')
  })

  it('reports identical detected and effective origins without an override', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const snapshot = assembler.list([{ entryId: 'include:vision-router', moduleName: 'dsh-vision-router', disabled: false }])
    expect(snapshot.entries[0]!.detectedOrigin).toBe(snapshot.entries[0]!.origin)
  })
})

describe('InventoryAssembler.describeOrigin', () => {
  it('returns null for cordis: builtins (no package name to key an override on)', () => {
    const { baseUrl } = profileFixture()
    const assembler = new InventoryAssembler(baseUrl)
    expect(assembler.describeOrigin('cordis:timer')).toBeNull()
  })

  it('describes both origin layers and the stored override entry', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    writeFileSync(join(profileDir, 'plugin-origins.json'), JSON.stringify({
      schemaVersion: 1,
      packages: { 'dsh-vision-router': { kind: 'opensource', customized: true, note: '定制说明' } },
    }))
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const description = assembler.describeOrigin('dsh-vision-router')
    expect(description).not.toBeNull()
    expect(description!.packageName).toBe('dsh-vision-router')
    expect(description!.detected.kind).toBe('opensource')
    expect(description!.detected.customized).toBe(false)
    expect(description!.effective.kind).toBe('opensource')
    expect(description!.effective.customized).toBe(true)
    expect(description!.effective.declaredBy).toBe('user-override')
    expect(description!.override).toEqual({ kind: 'opensource', customized: true, note: '定制说明' })
  })

  it('describes a package without an override (detected === effective)', () => {
    const { profileDir } = profileFixture()
    withPackage(profileDir, 'dsh-vision-router', { repository: 'https://github.com/example/vision-router' })
    const baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
    const assembler = new InventoryAssembler(baseUrl)
    const description = assembler.describeOrigin('dsh-vision-router')
    expect(description).not.toBeNull()
    expect(description!.override).toBeNull()
    expect(description!.detected).toBe(description!.effective)
  })
})
