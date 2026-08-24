/**
 * Profile evidence assembly and capability decisions. Everything here is
 * computed fresh per call from the Loader and the profile's files — this
 * service deliberately owns no long-lived lifecycle state.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PluginLifecycleBlockReason, PluginLifecycleEntryCapability } from './types.ts'

/** Packages that may never be uninstalled through this surface. */
export const PROTECTED_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-host-plugin-lifecycle',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-base',
]

/** Loader-entry facts the evidence layer consumes. */
export interface LifecycleEntryFacts {
  readonly entryId: string
  readonly moduleName: string
  /** Effective disabled state, including disabled ancestor groups. */
  readonly disabled: boolean
  /** The entry's own (not ancestor-inherited) disabled flag. */
  readonly ownDisabled: boolean
}

/** A profile manifest's dependency and bundle-membership view. */
export interface ProfileManifestView {
  readonly dependencies: ReadonlySet<string>
  readonly bundles: readonly string[]
}

/** Read the profile package.json's dependency keys and bundle list. */
export function readProfileManifestView(manifestPath: string): ProfileManifestView {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const dependencies = typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? new Set(Object.keys(manifest.dependencies))
      : new Set<string>()
    const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null
      ? manifest.dsh as Record<string, unknown>
      : {}
    const profile = typeof dsh.profile === 'object' && dsh.profile !== null
      ? dsh.profile as Record<string, unknown>
      : {}
    const bundles = Array.isArray(profile.bundles)
      ? profile.bundles.filter((bundle): bundle is string => typeof bundle === 'string')
      : []
    return { dependencies, bundles }
  } catch {
    return { dependencies: new Set(), bundles: [] }
  }
}

/** Package-name portion of a Loader module specifier. */
export function packageKeyOf(moduleName: string): string {
  const segments = moduleName.split('/')
  if (moduleName.startsWith('@')) return segments.slice(0, 2).join('/')
  /* v8 ignore next -- split('/') always yields a first segment, so the fallback is unreachable. */
  return segments[0] ?? moduleName
}

/** Resolve a package's directory from the profile anchor; null when absent. */
export function resolvePackageDir(profileDir: string, packageName: string): string | null {
  const requireFromProfile = createRequire(join(profileDir, 'noop.js'))
  try {
    return dirname(requireFromProfile.resolve(`${packageName}/package.json`))
  } catch {
    // Fall through to entry-point resolution below.
  }
  try {
    let current = dirname(requireFromProfile.resolve(packageName))
    while (true) {
      if (existsSync(join(current, 'package.json'))) return current
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  } catch {
    return null
  }
}

/** Best-effort realpath; null when the path cannot resolve. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Separator-insensitive containment check (case-insensitive on Windows). */
export function isPathInside(candidate: string, root: string): boolean {
  const normalize = (value: string): string => {
    let result = value.replaceAll('\\', '/')
    while (result.endsWith('/')) result = result.slice(0, -1)
    /* v8 ignore next -- the case-insensitive compare executes only on Windows coverage hosts. */
    return process.platform === 'win32' ? result.toLowerCase() : result
  }
  const child = normalize(candidate)
  const parent = normalize(root)
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * This package's own install-tree root: two levels above the real package
 * directory (`node_modules` in a published layout, `packages` in the
 * monorepo). Packages resolving under this root ship with the engine.
 */
export function engineTreeRootOf(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
      if (manifest.name === '@deepseek-ai/dsh-host-plugin-lifecycle') {
        return dirname(dirname(realpathSync(dir)))
      }
    } catch {
      // Keep walking towards the filesystem root.
    }
    const parent = dirname(dir)
    /* v8 ignore next -- reaching the filesystem root means this package is uninstalled; a test cannot fabricate that. */
    if (parent === dir) return null
    dir = parent
  }
}

/** Module names owned by manual insert rows inside the user patch text. */
export function manualInsertNames(patchText: string): ReadonlySet<string> {
  const names = new Set<string>()
  let parsed: unknown
  try {
    parsed = parseYaml(patchText, { schema: entryListSchema })
  } catch {
    return names
  }
  if (!Array.isArray(parsed)) return names
  for (const patch of parsed) {
    if (typeof patch !== 'object' || patch === null) continue
    const insert = (patch as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (typeof entry !== 'object' || entry === null) continue
      const name = (entry as Record<string, unknown>).name
      if (typeof name === 'string') names.add(name)
    }
  }
  return names
}

/** Per-entry evidence record feeding capability decisions. */
export interface LifecycleEntryEvidence {
  readonly entryId: string
  readonly moduleName: string
  readonly disabled: boolean
  readonly ownDisabled: boolean
  readonly packageName: string | null
  readonly isDirectDependency: boolean
  readonly isBundleMember: boolean
  readonly isTemplateBundle: boolean
  readonly insideEngineTree: boolean
  readonly isProtected: boolean
  readonly isManualInsert: boolean
}

/** Shared per-call resolution caches so 150+ entries don't each re-resolve. */
export interface EvidenceSession {
  readonly profileDir: string
  readonly manifest: ProfileManifestView
  readonly patchText: string
  readonly engineTreeRoot: string | null
  readonly manualInsertNames: ReadonlySet<string>
  /**
   * Shallow node_modules index: package name → package directory, profile
   * root first (later roots never overwrite an earlier hit). Dot-entries like
   * `.pnpm` are never entered.
   */
  readonly packageIndex: ReadonlyMap<string, string>
  /** Fallback cache used only for direct dependencies missing from the index. */
  readonly packageDirCache: Map<string, string | null>
  readonly realpathCache: Map<string, string | null>
  /** Located package.json name per directory, for uninstall authorization. */
  readonly manifestNameCache: Map<string, string | null>
}

/** Whether a node_modules entry counts as a package directory or link. */
function isPackageDirEntry(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/**
 * Shallow-scan one node_modules root into the index: top-level packages plus
 * one scope layer. Dot-entries (`.pnpm` and friends) are never entered, so
 * the pnpm virtual store is never traversed. The first root to claim a name
 * wins; later roots never overwrite.
 */
function scanRootInto(root: string, index: Map<string, string>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const first of entries) {
    if (first.name.startsWith('.')) continue
    if (!isPackageDirEntry(first)) continue
    if (first.name.startsWith('@')) {
      let scoped: Dirent[]
      try {
        scoped = readdirSync(join(root, first.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const second of scoped) {
        if (second.name.startsWith('.')) continue
        if (!isPackageDirEntry(second)) continue
        const name = `${first.name}/${second.name}`
        if (!index.has(name)) index.set(name, join(root, first.name, second.name))
      }
    } else if (!index.has(first.name)) {
      index.set(first.name, join(root, first.name))
    }
  }
}

/**
 * Build the per-call shallow package index. Root order mirrors the inventory
 * card reader: the profile's own node_modules first, then the engine-level
 * parent directory's node_modules.
 */
function buildPackageIndex(profileDir: string): Map<string, string> {
  const index = new Map<string, string>()
  scanRootInto(join(profileDir, 'node_modules'), index)
  scanRootInto(join(dirname(profileDir), 'node_modules'), index)
  return index
}

/** Create the per-call session: patch parse, shallow index, and caches are shared. */
export function createEvidenceSession(
  profileDir: string,
  manifest: ProfileManifestView,
  patchText: string,
  engineTreeRoot: string | null,
): EvidenceSession {
  return {
    profileDir,
    manifest,
    patchText,
    engineTreeRoot,
    manualInsertNames: manualInsertNames(patchText),
    packageIndex: buildPackageIndex(profileDir),
    packageDirCache: new Map(),
    realpathCache: new Map(),
    manifestNameCache: new Map(),
  }
}

/**
 * Bounded fallback resolver: only invoked for direct dependencies missing
 * from the shallow index, so a profile with a handful of direct dependencies
 * pays at most a handful of Node resolutions per call.
 */
function cachedResolvePackageDir(session: EvidenceSession, packageName: string): string | null {
  const cached = session.packageDirCache.get(packageName)
  if (cached !== undefined) return cached
  const resolved = resolvePackageDir(session.profileDir, packageName)
  session.packageDirCache.set(packageName, resolved)
  return resolved
}

/**
 * Read a located package's manifest name. Uninstall authorization depends on
 * an exact name match: a directory that happens to sit at a package's path but
 * declares a different name must fail closed.
 */
function manifestNameOf(session: EvidenceSession, packageDir: string): string | null {
  const cached = session.manifestNameCache.get(packageDir)
  if (cached !== undefined) return cached
  let name: string | null = null
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    name = typeof manifest.name === 'string' ? manifest.name : null
  } catch {
    name = null
  }
  session.manifestNameCache.set(packageDir, name)
  return name
}

/** Cached realpath within one evidence session. */
function cachedRealpath(session: EvidenceSession, path: string): string | null {
  const cached = session.realpathCache.get(path)
  if (cached !== undefined) return cached
  const resolved = realpathOrNull(path)
  session.realpathCache.set(path, resolved)
  return resolved
}

/** Assemble one entry's evidence from profile files and resolution facts. */
export function buildEntryEvidence(
  facts: LifecycleEntryFacts,
  context: EvidenceSession,
): LifecycleEntryEvidence {
  const packageName = facts.moduleName.startsWith('cordis:') ? null : packageKeyOf(facts.moduleName)
  const isDirectDependency = packageName !== null && context.manifest.dependencies.has(packageName)
  const isBundleMember = packageName !== null && context.manifest.bundles.includes(packageName)
  // The shallow index answers every ordinary entry. Only a direct dependency
  // missing from the index may pay the bounded Node-resolution fallback;
  // non-direct entries never resolve through Node here.
  let packageDir = packageName === null ? null : (context.packageIndex.get(packageName) ?? null)
  if (packageDir === null && packageName !== null && isDirectDependency) {
    packageDir = cachedResolvePackageDir(context, packageName)
  }
  // A located directory that declares a different package name fails closed:
  // uninstall authorization requires an exact manifest-name match.
  if (packageDir !== null && packageName !== null && manifestNameOf(context, packageDir) !== packageName) {
    packageDir = null
  }
  const realPackageDir = packageDir === null ? null : cachedRealpath(context, packageDir)
  const isTemplateBundle = isBundleMember && !isDirectDependency
  const insideEngineTree = realPackageDir !== null && context.engineTreeRoot !== null
    && isPathInside(realPackageDir, context.engineTreeRoot)
  const isProtected = packageName !== null && PROTECTED_PACKAGES.includes(packageName)
  const isManualInsert = context.manualInsertNames.has(facts.moduleName)
  return {
    entryId: facts.entryId,
    moduleName: facts.moduleName,
    disabled: facts.disabled,
    ownDisabled: facts.ownDisabled,
    packageName: packageDir === null ? null : packageName,
    isDirectDependency,
    isBundleMember,
    isTemplateBundle,
    insideEngineTree,
    isProtected,
    isManualInsert,
  }
}

/**
 * Compute one entry's capability row. Toggle is available to every known
 * entry on a writable surface; uninstall additionally requires an exact
 * direct-dependency mapping outside every protected class.
 */
export function capabilityOf(
  evidence: LifecycleEntryEvidence,
  persistence: 'writable' | 'read-only',
): PluginLifecycleEntryCapability {
  const toggleBlockReason = persistence === 'writable' ? null : 'read-only-remote'
  let uninstallBlockReason: PluginLifecycleBlockReason | null = null
  if (persistence !== 'writable') uninstallBlockReason = 'read-only-remote'
  else if (evidence.packageName === null) uninstallBlockReason = 'not-direct-dependency'
  else if (evidence.isProtected) uninstallBlockReason = 'protected-plugin'
  else if (evidence.insideEngineTree) uninstallBlockReason = 'engine-owned'
  else if (evidence.isTemplateBundle) uninstallBlockReason = 'template-bundle'
  else if (!evidence.isDirectDependency) uninstallBlockReason = 'not-direct-dependency'
  return {
    entryId: evidence.entryId,
    packageName: evidence.packageName,
    canToggle: toggleBlockReason === null,
    canUninstall: uninstallBlockReason === null,
    toggleBlockReason,
    uninstallBlockReason,
  }
}

/** Hash a file's content for revision purposes; missing files hash as '-'. */
export function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return '-'
  }
}

/**
 * Compute the evidence revision: a digest over the profile identity, the
 * manifest/lockfile/patch digests, and the entry facts, canonicalized so any
 * drift flips the revision.
 */
export function computeRevision(
  profileName: string,
  digests: { readonly manifest: string; readonly lockfile: string; readonly patch: string },
  entries: readonly LifecycleEntryFacts[],
): string {
  const hash = createHash('sha256')
  hash.update(profileName)
  hash.update('\0')
  hash.update(digests.manifest)
  hash.update(digests.lockfile)
  hash.update(digests.patch)
  for (const entry of [...entries].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
    hash.update(`\0${entry.entryId}=${entry.moduleName}:${entry.disabled ? '1' : '0'}`)
  }
  return hash.digest('hex')
}
