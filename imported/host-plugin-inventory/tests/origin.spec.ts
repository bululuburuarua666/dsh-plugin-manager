import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  heuristicOrigin,
  isOfficialCandidate,
  isPathInside,
  mergeOriginOverride,
  normalizeOrigin,
  normalizeRepositoryUrl,
  parseFileSpecifierTarget,
  parseOriginOverrides,
  resolveOrigin,
  stripPeerSuffix,
  type PackageResolutionEvidence,
} from '../src/origin.ts'
import { ProfileInstallSourceReader } from '../src/install-source.ts'
import { packageKeyOf, PluginInventoryCardReader, readCardFromPackageDir, resolvePluginPackageDir } from '../src/card.ts'
import type { PluginInventoryOrigin } from '../src/types.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-origin-'))
  tempDirs.push(root)
  return root
}

/** Evidence factory: every field defaults to the "unknown third party" case. */
function evidence(overrides: Partial<PackageResolutionEvidence>): PackageResolutionEvidence {
  return {
    packageName: 'third-party-plugin',
    packageDir: null,
    realPackageDir: null,
    resolutionRoot: 'unknown',
    insideEngineCheckout: false,
    insideLocalPlugins: false,
    profileSpecifier: null,
    lockfileResolution: null,
    fileTargetInsideLocal: false,
    repositoryUrl: null,
    ...overrides,
  }
}

describe('plugin origin normalization', () => {
  it('strips repository fields from personal and official kinds', () => {
    expect(normalizeOrigin({
      kind: 'personal',
      customized: true,
      upstream: 'https://github.com/a/b',
      fork: 'https://github.com/me/b',
      branch: 'mine',
    }, 'manifest')).toEqual({
      kind: 'personal',
      customized: false,
      upstream: null,
      fork: null,
      branch: null,
      note: null,
      declaredBy: 'manifest',
    })
    expect(normalizeOrigin({ kind: 'official', fork: 'https://github.com/me/b' }, 'user-override').customized).toBe(false)
  })

  it('derives customized from fork or branch but never from a note', () => {
    expect(normalizeOrigin({ kind: 'opensource' }, 'heuristic').customized).toBe(false)
    expect(normalizeOrigin({ kind: 'opensource', fork: 'https://github.com/me/x' }, 'heuristic').customized).toBe(true)
    expect(normalizeOrigin({ kind: 'opensource', branch: 'tweaks' }, 'heuristic').customized).toBe(true)
    expect(normalizeOrigin({ kind: 'opensource', note: 'just a note' }, 'heuristic').customized).toBe(false)
    expect(normalizeOrigin({ kind: 'opensource', fork: 'https://github.com/me/x', customized: false }, 'manifest').customized).toBe(false)
  })

  it('normalizes bilingual notes and caps field lengths', () => {
    const long = `x${'y'.repeat(2_100)}`
    const noteLong = `n${'o'.repeat(1_100)}`
    const origin = normalizeOrigin({
      kind: 'opensource',
      upstream: ` ${long} `,
      branch: `b${'r'.repeat(250)}`,
      note: noteLong,
    }, 'manifest')
    expect(origin.upstream).toBe(long.slice(0, 2_048))
    expect(origin.branch).toHaveLength(200)
    expect(origin.note?.zh).toBe(origin.note?.en)
    expect(origin.note?.zh.length).toBeLessThanOrEqual(1_000)
    expect(normalizeOrigin({ kind: 'opensource', upstream: '   ' }, 'manifest').upstream).toBeNull()
    expect(normalizeOrigin({ kind: 'personal', note: { zh: '中文', en: 'English' } }, 'manifest').note)
      .toEqual({ zh: '中文', en: 'English' })
  })
})

describe('plugin origin helpers', () => {
  it('normalizes repository URLs for allow-list comparison', () => {
    expect(normalizeRepositoryUrl('git+https://github.com/DeepSeek-AI/DeepSeek-Harness.git'))
      .toBe('https://github.com/deepseek-ai/deepseek-harness')
    expect(normalizeRepositoryUrl('https://github.com/deepseek-ai/deepseek-harness/'))
      .toBe('https://github.com/deepseek-ai/deepseek-harness')
    expect(normalizeRepositoryUrl('  ')).toBeNull()
    expect(normalizeRepositoryUrl(null)).toBeNull()
    expect(normalizeRepositoryUrl(undefined)).toBeNull()
  })

  it('compares path containment with normalized separators', () => {
    expect(isPathInside('/home/u/.dsh/plugins/local/x', '/home/u/.dsh/plugins/local')).toBe(true)
    expect(isPathInside('/home/u/.dsh/plugins/local', '/home/u/.dsh/plugins/local/')).toBe(true)
    expect(isPathInside('/home/u/.dsh/plugins/localx', '/home/u/.dsh/plugins/local')).toBe(false)
    expect(isPathInside('C:\\Users\\u\\.dsh\\plugins\\local\\x', 'c:\\users\\u\\.dsh\\plugins\\local')).toBe(process.platform === 'win32')
  })

  it('extracts file:/link: targets and strips lockfile peer suffixes', () => {
    expect(parseFileSpecifierTarget('file:../../plugins/local/x')).toBe('../../plugins/local/x')
    expect(parseFileSpecifierTarget('link:../x')).toBe('../x')
    expect(parseFileSpecifierTarget('1.4.0')).toBeNull()
    expect(parseFileSpecifierTarget(null)).toBeNull()
    expect(parseFileSpecifierTarget(undefined)).toBeNull()
    expect(stripPeerSuffix('file:../../plugins/local/x(react@18.3.1)')).toBe('file:../../plugins/local/x')
    expect(stripPeerSuffix('1.4.0')).toBe('1.4.0')
    expect(packageKeyOf('@scope/name/sub')).toBe('@scope/name')
    expect(packageKeyOf('plain/sub')).toBe('plain')
    expect(packageKeyOf('')).toBe('')
  })

  it('accepts only trusted official candidates', () => {
    expect(isOfficialCandidate(evidence({
      packageName: '@deepseek-ai/dsh-llm',
      resolutionRoot: 'engine',
    }))).toBe(true)
    expect(isOfficialCandidate(evidence({
      packageName: '@deepseek-ai/dsh-llm',
      insideEngineCheckout: true,
    }))).toBe(true)
    expect(isOfficialCandidate(evidence({
      packageName: '@deepseek-ai/dsh-llm',
      repositoryUrl: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
    }))).toBe(true)
    expect(isOfficialCandidate(evidence({
      packageName: '@deepseek-ai/fake',
      repositoryUrl: 'https://github.com/someone/deepseek-harness-fork',
    }))).toBe(false)
    expect(isOfficialCandidate(evidence({ packageName: 'dsh-vision-router', resolutionRoot: 'profile' }))).toBe(false)
  })
})

describe('plugin origin heuristics', () => {
  it('classifies the local plugins directory as personal', () => {
    expect(heuristicOrigin(evidence({ insideLocalPlugins: true })).origin.kind).toBe('personal')
    expect(heuristicOrigin(evidence({ fileTargetInsideLocal: true })).origin.kind).toBe('personal')
  })

  it('classifies trusted @deepseek-ai packages as official', () => {
    const result = heuristicOrigin(evidence({ packageName: '@deepseek-ai/dsh-web', insideEngineCheckout: true }))
    expect(result.origin).toMatchObject({ kind: 'official', customized: false, declaredBy: 'heuristic' })
    expect(result.diagnostics).toEqual([])
  })

  it('rejects untrusted @deepseek-ai names with a diagnostic', () => {
    const result = heuristicOrigin(evidence({ packageName: '@deepseek-ai/unknown', resolutionRoot: 'profile' }))
    expect(result.origin.kind).toBe('opensource')
    expect(result.diagnostics).toEqual([{ code: 'official-claim-rejected', packageName: '@deepseek-ai/unknown' }])
  })

  it('defaults registry, git, and profile-local packages to opensource with upstream', () => {
    const registry = heuristicOrigin(evidence({
      packageName: 'dsh-vision-router',
      resolutionRoot: 'profile',
      profileSpecifier: '1.4.0',
      repositoryUrl: 'git+https://github.com/ysr666/dsh-vision-router.git',
    }))
    expect(registry.origin.kind).toBe('opensource')
    expect(registry.origin.upstream).toBe('git+https://github.com/ysr666/dsh-vision-router.git')
    expect(registry.diagnostics).toEqual([])
    expect(heuristicOrigin(evidence({ packageName: '@omdsh-dev/dsh-genui', profileSpecifier: 'github:omdsh-dev/dsh-genui' })).origin.kind).toBe('opensource')
    expect(heuristicOrigin(evidence({ packageName: 'nowhere' })).origin.kind).toBe('opensource')
  })
})

describe('plugin origin priority chain', () => {
  const officialEvidence = evidence({ packageName: '@deepseek-ai/dsh-client-ui-context-panel', insideEngineCheckout: true })

  it('lets a valid manifest beat the heuristic', () => {
    const result = resolveOrigin(evidence({ packageName: 'some-plugin', resolutionRoot: 'profile' }), {
      manifest: { kind: 'personal', note: '自主构建' },
    })
    expect(result.origin).toMatchObject({ kind: 'personal', declaredBy: 'manifest', note: { zh: '自主构建', en: '自主构建' } })
    expect(result.diagnostics).toEqual([])
  })

  it('lets a user override beat both manifest and heuristic', () => {
    const result = resolveOrigin(officialEvidence, {
      manifest: { kind: 'official' },
      override: { kind: 'personal', note: { zh: '用户自建', en: 'user-built' } },
    })
    expect(result.origin.kind).toBe('personal')
    expect(result.origin.declaredBy).toBe('user-override')
  })

  it('rejects a third-party official manifest claim and falls back', () => {
    const result = resolveOrigin(evidence({ packageName: 'evil-official', resolutionRoot: 'profile' }), {
      manifest: { kind: 'official' },
    })
    expect(result.origin.kind).toBe('opensource')
    expect(result.origin.declaredBy).toBe('heuristic')
    expect(result.diagnostics).toEqual([{ code: 'official-claim-rejected', packageName: 'evil-official' }])
  })

  it('reports an invalid manifest and continues with the heuristic', () => {
    const result = resolveOrigin(evidence({ insideLocalPlugins: true }), { manifest: { kind: 'bogus' } })
    expect(result.origin.kind).toBe('personal')
    expect(result.diagnostics).toEqual([{ code: 'manifest-invalid', packageName: 'third-party-plugin' }])
  })

  it('keeps upstream details when an opensource override stays opensource', () => {
    const base = resolveOrigin(evidence({
      packageName: 'dsh-vision-router',
      resolutionRoot: 'profile',
      repositoryUrl: 'https://github.com/ysr666/dsh-vision-router',
    }), {})
    const result = resolveOrigin(evidence({
      packageName: 'dsh-vision-router',
      resolutionRoot: 'profile',
      repositoryUrl: 'https://github.com/ysr666/dsh-vision-router',
    }), { override: { kind: 'opensource', branch: 'my-tweaks' } })
    expect(base.origin.upstream).toBe('https://github.com/ysr666/dsh-vision-router')
    expect(result.origin).toMatchObject({
      kind: 'opensource',
      customized: true,
      upstream: 'https://github.com/ysr666/dsh-vision-router',
      branch: 'my-tweaks',
      declaredBy: 'user-override',
    })
  })

  it('lets an override restate repository fields and preserve an explicit customized flag', () => {
    const base = normalizeOrigin({
      kind: 'opensource', upstream: 'https://github.com/a/b', customized: true,
    }, 'manifest')
    // Same kind, untouched fork/branch: the explicit customized flag survives.
    expect(mergeOriginOverride(base, { kind: 'opensource' }).customized).toBe(true)
    // An override can restate the upstream outright.
    expect(mergeOriginOverride(base, { kind: 'opensource', upstream: 'https://github.com/a/fork' }).upstream)
      .toBe('https://github.com/a/fork')
  })

  it('clears inherited fields with explicit null and clears repository data on kind switch', () => {
    const openBase: PluginInventoryOrigin = normalizeOrigin({
      kind: 'opensource', upstream: 'https://github.com/a/b', fork: 'https://github.com/me/b', branch: 'x', note: 'n',
    }, 'manifest')
    expect(mergeOriginOverride(openBase, { kind: 'opensource', fork: null, branch: null }))
      .toMatchObject({ upstream: 'https://github.com/a/b', fork: null, branch: null, customized: false })
    expect(mergeOriginOverride(openBase, { kind: 'personal' }))
      .toMatchObject({ kind: 'personal', upstream: null, fork: null, branch: null, customized: false, note: { zh: 'n', en: 'n' } })
    expect(mergeOriginOverride(openBase, { kind: 'opensource', customized: true }).customized).toBe(true)
  })
})

describe('plugin origin override file', () => {
  it('parses a valid override file', () => {
    const result = parseOriginOverrides(JSON.stringify({
      schemaVersion: 1,
      packages: {
        'dsh-update-checker': { kind: 'personal' },
        'dsh-vision-router': { kind: 'opensource', upstream: 'https://github.com/ysr666/dsh-vision-router' },
      },
    }))
    expect(result.diagnostics).toEqual([])
    expect(result.overrides?.packages.get('dsh-update-checker')).toEqual({ kind: 'personal' })
    expect(result.overrides?.packages.get('dsh-vision-router')?.upstream).toBe('https://github.com/ysr666/dsh-vision-router')
  })

  it('discards invalid JSON and invalid top-level shapes', () => {
    expect(parseOriginOverrides('not json').diagnostics).toEqual([{ code: 'override-file-invalid', packageName: null }])
    expect(parseOriginOverrides('42').diagnostics).toEqual([{ code: 'override-file-invalid', packageName: null }])
    expect(parseOriginOverrides('{"schemaVersion":2,"packages":{}}').diagnostics)
      .toEqual([{ code: 'override-file-invalid', packageName: null }])
    expect(parseOriginOverrides('{"schemaVersion":1,"packages":7}').diagnostics)
      .toEqual([{ code: 'override-file-invalid', packageName: null }])
    expect(parseOriginOverrides('{"schemaVersion":1,"packages":{}}').overrides?.packages.size).toBe(0)
  })

  it('skips invalid entries while keeping the valid ones', () => {
    const result = parseOriginOverrides(JSON.stringify({
      schemaVersion: 1,
      packages: {
        good: { kind: 'personal' },
        bad: { kind: 'bogus' },
      },
    }))
    expect(result.overrides?.packages.has('good')).toBe(true)
    expect(result.overrides?.packages.has('bad')).toBe(false)
    expect(result.diagnostics).toEqual([{ code: 'override-entry-invalid', packageName: 'bad' }])
  })
})

describe('profile install source reader', () => {
  function profileFixture(): string {
    const dir = fixture()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-vision-router': '1.4.0',
        'dsh-update-checker': 'file:../../plugins/local/dsh-update-checker',
      },
      devDependencies: { 'dsh-dev-tool': 'workspace:*' },
      optionalDependencies: { 'dsh-optional': '^2.0.0' },
    }))
    return dir
  }

  it('reads package.json specifiers and lockfile resolutions once per stamp', () => {
    const dir = profileFixture()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
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
    const reader = new ProfileInstallSourceReader(dir)
    const first = reader.read()
    expect(first.diagnostics).toEqual([])
    expect(first.specifiers.get('dsh-vision-router')).toBe('1.4.0')
    expect(first.specifiers.get('dsh-dev-tool')).toBe('workspace:*')
    expect(first.specifiers.get('dsh-optional')).toBe('^2.0.0')
    expect(first.resolutions.get('dsh-update-checker')).toBe('file:../../plugins/local/dsh-update-checker')
    expect(reader.read()).toBe(first)

    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dsh-vision-router:\n        specifier: 1.5.0\n        version: 1.5.0\n")
    const second = reader.read()
    expect(second).not.toBe(first)
    expect(second.resolutions.get('dsh-vision-router')).toBe('1.5.0')
  })

  it('degrades on missing files, broken JSON, broken YAML, and unknown lockfile versions', () => {
    const missing = new ProfileInstallSourceReader(join(fixture(), 'nope')).read()
    expect(missing.specifiers.size).toBe(0)
    expect(missing.diagnostics).toEqual([])

    const brokenJson = profileFixture()
    writeFileSync(join(brokenJson, 'package.json'), '{broken')
    expect(new ProfileInstallSourceReader(brokenJson).read().specifiers.size).toBe(0)

    const brokenYaml = profileFixture()
    writeFileSync(join(brokenYaml, 'pnpm-lock.yaml'), ':\n  - [')
    expect(new ProfileInstallSourceReader(brokenYaml).read().diagnostics)
      .toEqual([{ code: 'lockfile-unsupported', packageName: null }])

    const unknownVersion = profileFixture()
    writeFileSync(join(unknownVersion, 'pnpm-lock.yaml'), "lockfileVersion: '99.0'\n")
    const degraded = new ProfileInstallSourceReader(unknownVersion).read()
    expect(degraded.diagnostics).toEqual([{ code: 'lockfile-unsupported', packageName: null }])
    expect(degraded.resolutions.size).toBe(0)
    expect(degraded.specifiers.get('dsh-vision-router')).toBe('1.4.0')

    const numericVersion = profileFixture()
    writeFileSync(join(numericVersion, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n\nimporters:\n  .:\n    dependencies:\n      dsh-vision-router:\n        specifier: 1.4.0\n        version: 1.4.0\n')
    expect(new ProfileInstallSourceReader(numericVersion).read().resolutions.get('dsh-vision-router')).toBe('1.4.0')
  })

  it('yields empty sources without a profile directory', () => {
    const sources = new ProfileInstallSourceReader(null).read()
    expect(sources.specifiers.size).toBe(0)
    expect(sources.resolutions.size).toBe(0)
  })

  it('handles degenerate manifests, duplicate names, and non-string specs', () => {
    const nullManifest = fixture()
    writeFileSync(join(nullManifest, 'package.json'), 'null')
    expect(new ProfileInstallSourceReader(nullManifest).read().specifiers.size).toBe(0)

    const dir = fixture()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { first: '1.0.0', odd: { not: 'a spec' } },
      devDependencies: { first: '2.0.0' },
    }))
    const sources = new ProfileInstallSourceReader(dir).read()
    expect(sources.specifiers.get('first')).toBe('1.0.0')
    expect(sources.specifiers.has('odd')).toBe(false)
  })

  it('skips malformed lockfile entries and importer-less lockfiles', () => {
    const dir = profileFixture()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      dsh-vision-router:',
      '        specifier: 1.4.0',
      '        version: 7',
      '      dsh-string-entry: plain-string',
      '',
    ].join('\n'))
    const sources = new ProfileInstallSourceReader(dir).read()
    expect(sources.resolutions.has('dsh-vision-router')).toBe(false)
    expect(sources.resolutions.has('dsh-string-entry')).toBe(false)

    const noImporters = profileFixture()
    writeFileSync(join(noImporters, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    expect(new ProfileInstallSourceReader(noImporters).read().resolutions.size).toBe(0)

    const nullLockfile = profileFixture()
    writeFileSync(join(nullLockfile, 'pnpm-lock.yaml'), 'null\n')
    expect(new ProfileInstallSourceReader(nullLockfile).read().diagnostics)
      .toEqual([{ code: 'lockfile-unsupported', packageName: null }])

    const infiniteVersion = profileFixture()
    writeFileSync(join(infiniteVersion, 'pnpm-lock.yaml'), 'lockfileVersion: .inf\n')
    expect(new ProfileInstallSourceReader(infiniteVersion).read().diagnostics)
      .toEqual([{ code: 'lockfile-unsupported', packageName: null }])

    const fractionalVersion = profileFixture()
    writeFileSync(join(fractionalVersion, 'pnpm-lock.yaml'), 'lockfileVersion: 9.5\n')
    expect(new ProfileInstallSourceReader(fractionalVersion).read().diagnostics)
      .toEqual([{ code: 'lockfile-unsupported', packageName: null }])
  })

  it('re-reads when a file appears or disappears between calls', () => {
    const dir = profileFixture()
    const reader = new ProfileInstallSourceReader(dir)
    const before = reader.read()
    expect(before.resolutions.size).toBe(0)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      dsh-vision-router:\n        specifier: 1.4.0\n        version: 1.4.0\n")
    const after = reader.read()
    expect(after.resolutions.get('dsh-vision-router')).toBe('1.4.0')
    rmSync(join(dir, 'pnpm-lock.yaml'))
    expect(reader.read().resolutions.size).toBe(0)
    rmSync(join(dir, 'package.json'))
    expect(reader.read().specifiers.size).toBe(0)
  })
})

describe('plugin package meta reader', () => {
  it('prefers the profile root over the engine root for same-named packages', () => {
    const root = fixture()
    const profileRoot = join(root, 'profiles', 'web')
    const enginePkg = join(root, 'profiles', 'node_modules', '@fixture', 'shared')
    const profilePkg = join(profileRoot, 'node_modules', '@fixture', 'shared')
    mkdirSync(enginePkg, { recursive: true })
    mkdirSync(profilePkg, { recursive: true })
    writeFileSync(join(enginePkg, 'package.json'), JSON.stringify({ name: '@fixture/shared', description: 'engine copy' }))
    writeFileSync(join(profilePkg, 'package.json'), JSON.stringify({ name: '@fixture/shared', description: 'profile copy' }))
    // Non-scoped duplicates and stray files exercise the scan's skip paths.
    mkdirSync(join(root, 'profiles', 'node_modules', 'plain-shared'), { recursive: true })
    mkdirSync(join(profileRoot, 'node_modules', 'plain-shared'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'node_modules', 'plain-shared', 'package.json'), JSON.stringify({ name: 'plain-shared' }))
    writeFileSync(join(profileRoot, 'node_modules', 'plain-shared', 'package.json'), JSON.stringify({ name: 'plain-shared' }))
    writeFileSync(join(profileRoot, 'node_modules', 'stray-file.txt'), 'not a package')
    writeFileSync(join(profileRoot, 'node_modules', '@fixture', 'stray.txt'), 'not a package')
    const baseUrl = pathToFileURL(join(profileRoot, 'cordis.yml')).href

    const reader = new PluginInventoryCardReader(baseUrl)
    const meta = reader.readMeta('@fixture/shared')
    expect(meta.located?.resolutionRoot).toBe('profile')
    expect(meta.packageName).toBe('@fixture/shared')
    expect(meta.repositoryUrl).toBeNull()
    expect(meta.manifestOrigin).toBeUndefined()
    expect(meta.realPackageDir).not.toBeNull()
    expect(reader.readMeta('plain-shared').located?.packageDir).toBe(join(profileRoot, 'node_modules', 'plain-shared'))
  })

  it('exposes the raw origin declaration and repository URL for the resolver', () => {
    const root = fixture()
    const packageDir = join(root, 'node_modules', 'origin-fixture')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: 'origin-fixture',
      repository: { type: 'git', url: 'git+https://github.com/me/origin-fixture.git' },
      dsh: { origin: { kind: 'personal', note: 'hi' } },
    }))
    const baseUrl = pathToFileURL(join(root, 'cordis.yml')).href

    const reader = new PluginInventoryCardReader(baseUrl)
    const meta = reader.readMeta('origin-fixture')
    expect(meta.manifestOrigin).toEqual({ kind: 'personal', note: 'hi' })
    expect(meta.repositoryUrl).toBe('git+https://github.com/me/origin-fixture.git')
    expect(reader.read('origin-fixture')).toEqual(meta.card)
    reader.drop('origin-fixture')
    expect(reader.readMeta('origin-fixture').packageName).toBe('origin-fixture')
    expect(reader.readMeta('cordis:builtin').located).toBeNull()
    expect(reader.readMeta('@missing/module').located).toBeNull()
  })

  it('reads repository declared as a plain string', () => {
    const root = fixture()
    const packageDir = join(root, 'node_modules', 'repo-string')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: 'repo-string',
      repository: 'https://github.com/me/repo-string',
    }))
    const reader = new PluginInventoryCardReader(pathToFileURL(join(root, 'cordis.yml')).href)
    expect(reader.readMeta('repo-string').repositoryUrl).toBe('https://github.com/me/repo-string')
  })

  it('falls back to Node resolution for packages outside the scanned roots', () => {
    const root = fixture()
    const reader = new PluginInventoryCardReader(pathToFileURL(join(root, 'cordis.yml')).href)
    // zod is a declared runtime dependency: never in the fixture index but
    // always resolvable through this package's own resolution anchor.
    const meta = reader.readMeta('zod')
    expect(meta.located?.resolutionRoot).toBe('unknown')
    expect(meta.packageName).toBe('zod')
    expect(meta.realPackageDir).not.toBeNull()
  })

  it('returns empty meta for invalid base URLs, broken manifests, and vanished directories', () => {
    const invalid = new PluginInventoryCardReader(':::')
    expect(invalid.readMeta('anything').located).toBeNull()

    const root = fixture()
    const broken = join(root, 'node_modules', 'broken-manifest')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'package.json'), '{broken')
    const nonObject = join(root, 'node_modules', 'non-object-manifest')
    mkdirSync(nonObject, { recursive: true })
    writeFileSync(join(nonObject, 'package.json'), '42')
    const odd = join(root, 'node_modules', 'odd-manifest')
    mkdirSync(odd, { recursive: true })
    writeFileSync(join(odd, 'package.json'), JSON.stringify({ name: 42, repository: 42 }))
    const reader = new PluginInventoryCardReader(pathToFileURL(join(root, 'cordis.yml')).href)
    const meta = reader.readMeta('broken-manifest')
    expect(meta.packageName).toBeNull()
    expect(meta.card).toEqual({ title: null, description: null })
    expect(meta.repositoryUrl).toBeNull()

    const nonObjectMeta = reader.readMeta('non-object-manifest')
    expect(nonObjectMeta.packageName).toBeNull()
    expect(nonObjectMeta.card).toEqual({ title: null, description: null })

    const oddMeta = reader.readMeta('odd-manifest')
    expect(oddMeta.packageName).toBeNull()
    expect(oddMeta.repositoryUrl).toBeNull()

    const vanished = join(root, 'node_modules', 'vanished')
    mkdirSync(vanished, { recursive: true })
    writeFileSync(join(vanished, 'package.json'), JSON.stringify({ name: 'vanished' }))
    const lateReader = new PluginInventoryCardReader(pathToFileURL(join(root, 'cordis.yml')).href)
    rmSync(vanished, { recursive: true, force: true })
    const vanishedMeta = lateReader.readMeta('vanished')
    expect(vanishedMeta.realPackageDir).toBeNull()
    expect(vanishedMeta.packageName).toBeNull()
  })

  it('survives an unreadable scoped directory during the index scan', () => {
    const root = fixture()
    const modulesDir = join(root, 'node_modules')
    mkdirSync(modulesDir, { recursive: true })
    // A symlink/junction whose target does not exist: the scan must skip it.
    symlinkSync(join(root, 'nowhere'), join(modulesDir, '@broken'), process.platform === 'win32' ? 'junction' : 'dir')
    const reader = new PluginInventoryCardReader(pathToFileURL(join(root, 'cordis.yml')).href)
    expect(reader.readMeta('@broken/anything').located).toBeNull()
  })

  it('walks up from the entry file when package.json is not exported, and fails cleanly without one', () => {
    const root = fixture()
    const noExport = join(root, 'node_modules', 'no-export-pkg')
    mkdirSync(noExport, { recursive: true })
    writeFileSync(join(noExport, 'package.json'), JSON.stringify({
      name: 'no-export-pkg',
      exports: { '.': './index.js' },
    }))
    writeFileSync(join(noExport, 'index.js'), 'export {}')
    const bare = join(root, 'node_modules', 'bare-pkg')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, 'index.js'), 'module.exports = {}')

    const baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
    // Direct resolution drives the Node fallback: the exports map hides
    // package.json, so the resolver walks up from the entry file instead.
    expect(resolvePluginPackageDir('no-export-pkg', baseUrl)).toBe(noExport)
    // A bare entry directory without any package.json ancestor never resolves.
    expect(resolvePluginPackageDir('bare-pkg', baseUrl)).toBeNull()

    const reader = new PluginInventoryCardReader(baseUrl)
    expect(reader.readMeta('no-export-pkg').packageName).toBe('no-export-pkg')
    expect(reader.readMeta('bare-pkg').packageName).toBeNull()
    expect(reader.readMeta('bare-pkg').card).toEqual({ title: null, description: null })
  })

  it('truncates long README paragraphs and returns null for heading-only files', () => {
    const root = fixture()
    const packageDir = join(root, 'node_modules', 'readme-pkg')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'readme-pkg' }))
    writeFileSync(join(packageDir, 'README.md'), `# Title\n\n${'x'.repeat(300)}`)
    writeFileSync(join(packageDir, 'README.zh.md'), '# 只有标题\n\n[English](README.md) | 中文\n')
    const meta = readCardFromPackageDir(packageDir)
    expect(meta.description?.en).toHaveLength(240)
    expect(meta.description?.en.endsWith('…')).toBe(true)
    expect(meta.description?.zh).toBe(meta.description?.en)
  })
})
