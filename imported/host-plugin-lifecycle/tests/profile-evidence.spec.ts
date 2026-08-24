import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildEntryEvidence,
  capabilityOf,
  computeRevision,
  createEvidenceSession,
  engineTreeRootOf,
  fileDigest,
  isPathInside,
  manualInsertNames,
  packageKeyOf,
  PROTECTED_PACKAGES,
  readProfileManifestView,
  realpathOrNull,
  resolvePackageDir,
  type LifecycleEntryFacts,
} from '../src/profile-evidence.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-evidence-'))
  tempDirs.push(root)
  return root
}

function facts(overrides: Partial<LifecycleEntryFacts>): LifecycleEntryFacts {
  return {
    entryId: 'entry-1',
    moduleName: 'some-plugin',
    disabled: false,
    ownDisabled: false,
    ...overrides,
  }
}

describe('profile manifest view', () => {
  it('reads dependencies and bundles; tolerates missing or malformed files', () => {
    const dir = fixture()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({
      dependencies: { 'dsh-vision-router': '1.4.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-router'] } },
    }))
    const view = readProfileManifestView(manifestPath)
    expect(view.dependencies.has('dsh-vision-router')).toBe(true)
    expect(view.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-vision-router'])

    expect(readProfileManifestView(join(dir, 'missing.json')).dependencies.size).toBe(0)
    writeFileSync(manifestPath, '{broken')
    expect(readProfileManifestView(manifestPath).bundles).toEqual([])
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: [1, 'x'] } } }))
    expect(readProfileManifestView(manifestPath).bundles).toEqual(['x'])
  })
})

describe('path helpers', () => {
  it('maps module specifiers to package keys', () => {
    expect(packageKeyOf('@scope/name/sub')).toBe('@scope/name')
    expect(packageKeyOf('plain/sub')).toBe('plain')
    expect(packageKeyOf('plain')).toBe('plain')
  })

  it('resolves package directories through the profile anchor', () => {
    const dir = fixture()
    const pkg = join(dir, 'node_modules', 'resolvable-pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'resolvable-pkg' }))
    expect(resolvePackageDir(dir, 'resolvable-pkg')).toBe(pkg)
    expect(resolvePackageDir(dir, 'absent-pkg')).toBeNull()

    // A package without an exported ./package.json resolves via its entry.
    const noExport = join(dir, 'node_modules', 'no-export-pkg')
    mkdirSync(noExport, { recursive: true })
    writeFileSync(join(noExport, 'package.json'), JSON.stringify({
      name: 'no-export-pkg',
      exports: { '.': './index.js' },
    }))
    writeFileSync(join(noExport, 'index.js'), 'export {}')
    expect(resolvePackageDir(dir, 'no-export-pkg')).toBe(noExport)

    // A bare entry directory without any package.json never resolves.
    const bare = join(dir, 'node_modules', 'bare-pkg')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'index.js'), 'module.exports = {}')
    expect(resolvePackageDir(dir, 'bare-pkg')).toBeNull()
  })

  it('resolves realpaths and reports containment', () => {
    const dir = fixture()
    expect(realpathOrNull(dir)).not.toBeNull()
    expect(realpathOrNull(join(dir, 'missing'))).toBeNull()
    expect(isPathInside(join(dir, 'a'), dir)).toBe(true)
    expect(isPathInside(dir, join(dir, 'a'))).toBe(false)
    // Trailing separators normalize before comparison.
    expect(isPathInside(`${dir}/child/`, `${dir}/`)).toBe(true)
  })

  it('locates this package inside the engine tree', () => {
    const root = engineTreeRootOf()
    expect(root).not.toBeNull()
    expect(root!.replaceAll('\\', '/').endsWith('/packages')).toBe(true)
  })
})

describe('manual insert detection', () => {
  it('collects names from insert rows and tolerates malformed text', () => {
    const text = [
      '- insert:',
      '    - id: a',
      "      name: 'plugin-a'",
      '- id: other',
      '  disabled: true',
    ].join('\n')
    expect([...manualInsertNames(text)]).toEqual(['plugin-a'])
    expect(manualInsertNames('not: a-map').size).toBe(0)
    expect(manualInsertNames('- [unclosed').size).toBe(0)
    expect(manualInsertNames('- insert: not-a-list').size).toBe(0)
    expect(manualInsertNames('- 42').size).toBe(0)
    expect(manualInsertNames('- insert:\n    - 42').size).toBe(0)
    expect(manualInsertNames('- insert:\n    - name: 42').size).toBe(0)
  })
})

describe('entry evidence and capabilities', () => {
  function evidenceContext(dir: string) {
    return createEvidenceSession(
      dir,
      readProfileManifestView(join(dir, 'package.json')),
      '',
      engineTreeRootOf(),
    )
  }

  function withPackage(dir: string, name: string): void {
    const pkg = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name }))
  }

  it('classifies a direct third-party dependency as uninstallable', () => {
    const dir = fixture()
    withPackage(dir, 'dsh-vision-router')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vision-router': '1.4.0' } }))
    const evidence = buildEntryEvidence(facts({ moduleName: 'dsh-vision-router' }), evidenceContext(dir))
    expect(evidence.isDirectDependency).toBe(true)
    expect(evidence.insideEngineTree).toBe(false)
    const capability = capabilityOf(evidence, 'writable')
    expect(capability.canUninstall).toBe(true)
    expect(capability.canToggle).toBe(true)
  })

  it('blocks protected, engine-owned, template, indirect, and unresolvable packages', () => {
    const dir = fixture()

    withPackage(dir, '@deepseek-ai/dsh-host-plugin-lifecycle')
    const protectedEvidence = buildEntryEvidence(
      facts({ moduleName: PROTECTED_PACKAGES[0]! }),
      evidenceContext(dir),
    )
    expect(capabilityOf(protectedEvidence, 'writable').uninstallBlockReason).toBe('protected-plugin')

    const unresolvable = buildEntryEvidence(facts({ moduleName: 'totally-absent' }), evidenceContext(dir))
    expect(unresolvable.packageName).toBeNull()
    expect(capabilityOf(unresolvable, 'writable').uninstallBlockReason).toBe('not-direct-dependency')

    const cordis = buildEntryEvidence(facts({ moduleName: 'cordis:timer' }), evidenceContext(dir))
    expect(cordis.packageName).toBeNull()

    withPackage(dir, 'dsh-indirect')
    const indirect = buildEntryEvidence(facts({ moduleName: 'dsh-indirect' }), evidenceContext(dir))
    expect(capabilityOf(indirect, 'writable').uninstallBlockReason).toBe('not-direct-dependency')

    withPackage(dir, 'dsh-template')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-template'] } },
    }))
    const template = buildEntryEvidence(
      facts({ moduleName: 'dsh-template' }),
      evidenceContext(dir),
    )
    expect(template.isTemplateBundle).toBe(true)
    expect(capabilityOf(template, 'writable').uninstallBlockReason).toBe('template-bundle')
  })

  it('marks engine-tree packages engine-owned', () => {
    const dir = fixture()
    withPackage(dir, 'dsh-engine-pkg')
    const evidence = buildEntryEvidence(
      facts({ moduleName: 'dsh-engine-pkg' }),
      createEvidenceSession(
        dir,
        { dependencies: new Set(['dsh-engine-pkg']), bundles: [] },
        '',
        dir,
      ),
    )
    expect(evidence.insideEngineTree).toBe(true)
    expect(capabilityOf(evidence, 'writable').uninstallBlockReason).toBe('engine-owned')
  })

  it('blocks everything when the surface is read-only', () => {
    const dir = fixture()
    withPackage(dir, 'dsh-vision-router')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vision-router': '1.4.0' } }))
    const evidence = buildEntryEvidence(facts({ moduleName: 'dsh-vision-router' }), evidenceContext(dir))
    const capability = capabilityOf(evidence, 'read-only')
    expect(capability.canToggle).toBe(false)
    expect(capability.canUninstall).toBe(false)
    expect(capability.toggleBlockReason).toBe('read-only-remote')
    expect(capability.uninstallBlockReason).toBe('read-only-remote')
  })
})

describe('revision and digests', () => {
  it('is stable for equal evidence and sensitive to any drift', () => {
    const entries = [facts({ entryId: 'b' }), facts({ entryId: 'a' })]
    const digests = { manifest: 'm', lockfile: 'l', patch: 'p' }
    const first = computeRevision('web', digests, entries)
    const reordered = computeRevision('web', digests, [...entries].reverse())
    expect(first).toBe(reordered)
    expect(computeRevision('web', digests, [facts({ entryId: 'a', disabled: true })])).not.toBe(first)
    expect(computeRevision('other', digests, entries)).not.toBe(first)
    expect(computeRevision('web', { manifest: 'm2', lockfile: 'l', patch: 'p' }, entries)).not.toBe(first)
  })

  it('hashes file contents and tolerates missing files', () => {
    const dir = fixture()
    const file = join(dir, 'f.txt')
    expect(fileDigest(file)).toBe('-')
    writeFileSync(file, 'hello')
    expect(fileDigest(file)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('shallow package index (R02)', () => {
  it('prefers the profile root over the parent root for same-named packages', () => {
    const dir = fixture()
    const enginePkg = join(dir, 'node_modules', 'shared-pkg')
    const profileRoot = join(dir, 'profiles', 'web')
    const profilePkg = join(profileRoot, 'node_modules', 'shared-pkg')
    mkdirSync(enginePkg, { recursive: true })
    mkdirSync(profilePkg, { recursive: true })
    writeFileSync(join(enginePkg, 'package.json'), JSON.stringify({ name: 'shared-pkg', description: 'engine' }))
    writeFileSync(join(profilePkg, 'package.json'), JSON.stringify({ name: 'shared-pkg', description: 'profile' }))

    const session = createEvidenceSession(profileRoot, { dependencies: new Set(), bundles: [] }, '', null)
    expect(session.packageIndex.get('shared-pkg')).toBe(profilePkg)
  })

  it('indexes scoped and unscoped packages but never descends into .pnpm', () => {
    const dir = fixture()
    const profileRoot = join(dir, 'profiles', 'web')
    const scopePkg = join(profileRoot, 'node_modules', '@scope', 'pkg')
    const plainPkg = join(profileRoot, 'node_modules', 'plain-pkg')
    const pnpmNested = join(profileRoot, 'node_modules', '.pnpm', 'hidden-pkg')
    mkdirSync(scopePkg, { recursive: true })
    mkdirSync(plainPkg, { recursive: true })
    mkdirSync(pnpmNested, { recursive: true })
    writeFileSync(join(scopePkg, 'package.json'), JSON.stringify({ name: '@scope/pkg' }))
    writeFileSync(join(plainPkg, 'package.json'), JSON.stringify({ name: 'plain-pkg' }))
    writeFileSync(join(pnpmNested, 'package.json'), JSON.stringify({ name: 'hidden-pkg' }))

    const session = createEvidenceSession(profileRoot, { dependencies: new Set(), bundles: [] }, '', null)
    expect(session.packageIndex.get('@scope/pkg')).toBe(scopePkg)
    expect(session.packageIndex.get('plain-pkg')).toBe(plainPkg)
    expect(session.packageIndex.has('hidden-pkg')).toBe(false)
  })

  it('never resolves non-direct entries through the fallback resolver', () => {
    const dir = fixture()
    const profileRoot = join(dir, 'profiles', 'web')
    mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({ dependencies: {} }))

    const session = createEvidenceSession(
      profileRoot,
      readProfileManifestView(join(profileRoot, 'package.json')),
      '',
      null,
    )
    // 200 distinct uninstalled, non-direct entries must not trigger any
    // Node-resolution fallback: the shallow index answers all of them.
    for (let index = 0; index < 200; index++) {
      const evidence = buildEntryEvidence(
        facts({ moduleName: `@uninstalled/entry-${index}` }),
        session,
      )
      expect(evidence.packageName).toBeNull()
      expect(capabilityOf(evidence, 'writable').canUninstall).toBe(false)
    }
    expect(session.packageDirCache.size).toBe(0)
  })

  it('runs the bounded fallback at most once for repeated entries of one direct dependency', () => {
    const dir = fixture()
    const profileRoot = join(dir, 'profiles', 'web')
    const elsewhere = join(dir, 'elsewhere', 'direct-dep')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: 'direct-dep' }))
    mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
      dependencies: { 'direct-dep': '1.0.0' },
    }))

    const session = createEvidenceSession(
      profileRoot,
      readProfileManifestView(join(profileRoot, 'package.json')),
      '',
      null,
    )
    expect(session.packageIndex.has('direct-dep')).toBe(false)
    const first = buildEntryEvidence(facts({ moduleName: 'direct-dep' }), session)
    const second = buildEntryEvidence(facts({ moduleName: 'direct-dep' }), session)
    expect(first.packageName).toBe(second.packageName)
    expect(session.packageDirCache.size).toBeLessThanOrEqual(1)
  })

  it('fails closed when the fallback-resolved directory has a mismatched package name', () => {
    const dir = fixture()
    const profileRoot = join(dir, 'profiles', 'web')
    const elsewhere = join(dir, 'elsewhere', 'mismatch-pkg')
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: 'someone-else' }))
    writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
      dependencies: { 'mismatch-pkg': '1.0.0' },
    }))

    const session = createEvidenceSession(
      profileRoot,
      readProfileManifestView(join(profileRoot, 'package.json')),
      '',
      null,
    )
    const evidence = buildEntryEvidence(facts({ moduleName: 'mismatch-pkg' }), session)
    // The fallback resolved to a package.json whose name does not match, so
    // the entry must fail closed: not uninstallable.
    expect(capabilityOf(evidence, 'writable').canUninstall).toBe(false)
  })
})
