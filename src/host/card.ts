/** Resolve and read a plugin package's inventory hover-card metadata. */

import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInventoryCard, PluginInventoryCardText } from './protocol.ts'

/** Maximum code units kept from a README fallback paragraph. */
const README_FALLBACK_MAX = 240

/** Empty card returned for unresolvable modules and unreadable manifests. */
const EMPTY_CARD: PluginInventoryCard = { title: null, description: null }

/** Which scanned node_modules root produced a package resolution. */
export type PluginResolutionRoot = 'profile' | 'engine' | 'unknown'

/** A resolved plugin package directory with its resolution provenance. */
export interface LocatedPluginPackage {
  readonly packageDir: string
  readonly resolutionRoot: PluginResolutionRoot
}

/** Inventory-relevant metadata of one resolved plugin package. */
export interface PluginPackageMeta {
  /** Resolution location, or null when the module did not resolve. */
  readonly located: LocatedPluginPackage | null
  /** Real package.json `name`, or null when the manifest is unreadable. */
  readonly packageName: string | null
  /** `fs.realpath` of the package directory, or null when unavailable. */
  readonly realPackageDir: string | null
  readonly card: PluginInventoryCard
  /** Raw `dsh.origin` manifest value, forwarded to the origin resolver. */
  readonly manifestOrigin: unknown
  /** Raw `repository` URL declared by the package, when present. */
  readonly repositoryUrl: string | null
}

/** Fields of package.json the inventory card reader consumes. */
interface PackageManifestView {
  name?: unknown
  description?: unknown
  repository?: unknown
  dsh?: {
    inventory?: unknown
    origin?: unknown
  }
}

/**
 * Normalize a standard `dsh.inventory` field. A string is shorthand for the
 * same copy in both languages; an object must provide non-empty `zh` and
 * `en` strings.
 * @param value - raw manifest value.
 * @returns normalized bilingual text, or null when the value is invalid.
 */
export function normalizeInventoryCardText(value: unknown): PluginInventoryCardText | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length === 0 ? null : { zh: text, en: text }
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.zh !== 'string' || typeof record.en !== 'string') return null
  const zh = record.zh.trim()
  const en = record.en.trim()
  return zh.length === 0 || en.length === 0 ? null : { zh, en }
}

/**
 * Read the first prose paragraph of a README file. Heading, language-link,
 * and blank lines are skipped, matching the repository's one-line-paragraph
 * documentation convention.
 * @param path - absolute README path.
 * @returns the first paragraph capped at {@link README_FALLBACK_MAX}, or null.
 */
export function readReadmeFallback(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim()
    if (candidate.length === 0) continue
    if (candidate.startsWith('#')) continue
    if (candidate.startsWith('[English]')) continue
    if (candidate.startsWith('English |')) continue
    if (candidate.length <= README_FALLBACK_MAX) return candidate
    return `${candidate.slice(0, README_FALLBACK_MAX - 1).trimEnd()}…`
  }
  return null
}

/**
 * Resolve a Loader module specifier to its package directory.
 * @param moduleName - entry module specifier.
 * @param baseUrl - Loader base URL anchoring profile-local resolution.
 * @returns package directory, or null for builtins/unresolvable specifiers.
 */
export function resolvePluginPackageDir(moduleName: string, baseUrl: string | undefined): string | null {
  if (moduleName.startsWith('cordis:')) return null
  const anchors: string[] = []
  if (baseUrl !== undefined && baseUrl.length > 0) {
    try {
      anchors.push(new URL('noop.js', baseUrl).href)
    } catch {
      // Keep the own-package anchor below.
    }
  }
  anchors.push(import.meta.url)
  for (const anchor of anchors) {
    const requireFromAnchor = createRequire(anchor)
    try {
      return dirname(requireFromAnchor.resolve(`${moduleName}/package.json`))
    } catch {
      // Some packages do not export ./package.json. Resolve the module entry
      // and walk up to its package root instead.
    }
    try {
      const resolved = requireFromAnchor.resolve(moduleName)
      let current = dirname(resolved)
      while (true) {
        if (existsSync(join(current, 'package.json'))) return current
        const parent = dirname(current)
        if (parent === current) return null
        current = parent
      }
    } catch {
      // Try the next resolution anchor.
    }
  }
  return null
}

/**
 * Narrow an unknown JSON value to the package-manifest fields this reader
 * consumes.
 * @param value - parsed package.json value.
 * @returns the consumed manifest view, or null for non-objects.
 */
function asPackageManifest(value: unknown): PackageManifestView | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const dsh = typeof record.dsh === 'object' && record.dsh !== null
    ? record.dsh as Record<string, unknown>
    : undefined
  return {
    name: record.name,
    description: record.description,
    repository: record.repository,
    ...(dsh === undefined ? {} : { dsh: { inventory: dsh.inventory, origin: dsh.origin } }),
  }
}

/** Extract the URL string of a package.json `repository` field. */
function repositoryUrlOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  return record !== null && typeof record.url === 'string' ? record.url : null
}

/**
 * Read a plugin package's inventory card from an already-resolved package
 * directory.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved card, never null.
 */
/**
 * Read a plugin package's full inventory metadata from an already-resolved
 * package directory: card fields plus the raw origin declaration, repository
 * URL, and package name consumed by the origin resolver.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved metadata; scalar fields are null on unreadable manifests.
 */
export function readPackageMetaFromDir(packageDir: string): Omit<PluginPackageMeta, 'located' | 'realPackageDir'> {
  let manifest: PackageManifestView | null = null
  try {
    const raw = readFileSync(join(packageDir, 'package.json'), 'utf8')
    manifest = asPackageManifest(JSON.parse(raw))
  } catch {
    return { packageName: null, card: EMPTY_CARD, manifestOrigin: undefined, repositoryUrl: null }
  }
  return {
    packageName: typeof manifest?.name === 'string' ? manifest.name : null,
    card: cardFromManifest(packageDir, manifest),
    manifestOrigin: manifest?.dsh?.origin,
    repositoryUrl: repositoryUrlOf(manifest?.repository),
  }
}

/** Compute the hover card from a parsed manifest view and README fallbacks. */
function cardFromManifest(packageDir: string, manifest: PackageManifestView | null): PluginInventoryCard {

  const rawInventory = manifest?.dsh?.inventory
  const rawTitle = rawInventory !== null && typeof rawInventory === 'object'
    ? (rawInventory as Record<string, unknown>).title
    : undefined
  const rawDescription = rawInventory !== null && typeof rawInventory === 'object'
    ? (rawInventory as Record<string, unknown>).description
    : undefined
  const title = rawTitle === undefined ? null : normalizeInventoryCardText(rawTitle)
  const declaredDescription = rawDescription === undefined ? null : normalizeInventoryCardText(rawDescription)

  if (title !== null && declaredDescription !== null) return { title, description: declaredDescription }

  const zhFallback = readReadmeFallback(join(packageDir, 'README.zh.md'))
  const enFallback = readReadmeFallback(join(packageDir, 'README.md'))
    ?? (typeof manifest?.description === 'string' ? manifest.description.trim() : null)
  const zhDescription = zhFallback ?? enFallback
  const enDescription = enFallback ?? zhFallback
  const description = declaredDescription
    ?? (zhDescription !== null && enDescription !== null
      ? { zh: zhDescription, en: enDescription }
      : null)

  return { title, description }
}

/**
 * Read a plugin package's inventory card from an already-resolved package
 * directory.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved card, never null.
 */
export function readCardFromPackageDir(packageDir: string): PluginInventoryCard {
  return readPackageMetaFromDir(packageDir).card
}

/**
 * Read a plugin package's inventory card, resolving the module against the
 * Loader base URL. Kept for focused tests and one-shot callers; the gateway
 * uses {@link PluginInventoryCardReader}, which indexes and caches package
 * directories.
 * @param moduleName - entry module specifier.
 * @param baseUrl - Loader base URL for profile-local package resolution.
 * @returns resolved card, never null.
 */
export function readPluginInventoryCard(moduleName: string, baseUrl: string | undefined): PluginInventoryCard {
  const packageDir = resolvePluginPackageDir(moduleName, baseUrl)
  return packageDir === null ? EMPTY_CARD : readCardFromPackageDir(packageDir)
}

/**
 * Package-name segments used as the node_modules index key and as the
 * specifier/resolution/override lookup key in the gateway.
 * @param moduleName - entry module specifier.
 * @returns the package portion of the specifier.
 */
export function packageKeyOf(moduleName: string): string {
  const segments = moduleName.split('/')
  /* v8 ignore next -- split('/') always yields at least one segment, so the ?? fallback is unreachable. */
  return moduleName.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? moduleName
}

/** One tagged node_modules root candidate. */
interface IndexedRoot {
  readonly dir: string
  readonly root: Exclude<PluginResolutionRoot, 'unknown'>
}

/** Candidate node_modules roots for a Loader base URL, profile root first. */
function nodeModulesRoots(baseUrl: string | undefined): IndexedRoot[] {
  if (baseUrl === undefined || baseUrl.length === 0) return []
  try {
    const profileDir = fileURLToPath(new URL('.', baseUrl))
    return [
      { dir: join(profileDir, 'node_modules'), root: 'profile' },
      { dir: join(dirname(profileDir), 'node_modules'), root: 'engine' },
    ]
  } catch {
    return []
  }
}

/** One fs.Dirent returned by the package-index scan. */
type PackageEntry = Dirent

function isPackageEntry(entry: PackageEntry): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/** Best-effort realpath of a package directory; null when it cannot resolve. */
function realpathOf(packageDir: string): string | null {
  try {
    return realpathSync(packageDir)
  } catch {
    return null
  }
}

/**
 * Cached, indexed card reader used by the inventory gateway. It scans the
 * profile's `node_modules` roots once, so `list()` does not pay Node module
 * resolution for every configured entry.
 */
export class PluginInventoryCardReader {
  private readonly baseUrl: string | undefined
  private readonly packageDirs = new Map<string, LocatedPluginPackage>()
  private readonly metas = new Map<string, PluginPackageMeta>()

  constructor(baseUrl: string | undefined) {
    this.baseUrl = baseUrl
    for (const { dir: root, root: tag } of nodeModulesRoots(baseUrl)) {
      let entries: Dirent[]
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const first of entries) {
        if (!isPackageEntry(first)) continue
        if (first.name.startsWith('@')) {
          let scoped: Dirent[]
          try {
            scoped = readdirSync(join(root, first.name), { withFileTypes: true })
          } catch {
            continue
          }
          for (const second of scoped) {
            if (!isPackageEntry(second)) continue
            const name = `${first.name}/${second.name}`
            if (!this.packageDirs.has(name)) {
              this.packageDirs.set(name, { packageDir: join(root, first.name, second.name), resolutionRoot: tag })
            }
          }
        } else if (!this.packageDirs.has(first.name)) {
          this.packageDirs.set(first.name, { packageDir: join(root, first.name), resolutionRoot: tag })
        }
      }
    }
  }

  /**
   * Read (and cache) one entry's card.
   * @param moduleName - entry module specifier.
   * @returns resolved card, never null.
   */
  read(moduleName: string): PluginInventoryCard {
    return this.readMeta(moduleName).card
  }

  /**
   * Read (and cache) one entry's full package metadata. `cordis:` builtins
   * and unresolvable modules return an empty meta with a null location.
   * @param moduleName - entry module specifier.
   * @returns resolved metadata, never null.
   */
  readMeta(moduleName: string): PluginPackageMeta {
    const cached = this.metas.get(moduleName)
    if (cached !== undefined) return cached
    const meta = moduleName.startsWith('cordis:')
      ? { located: null, packageName: null, realPackageDir: null, card: EMPTY_CARD, manifestOrigin: undefined, repositoryUrl: null }
      : this.readMetaUncached(moduleName)
    this.metas.set(moduleName, meta)
    return meta
  }

  /** Drop the cached metadata for one module after its Loader entry changes. */
  drop(moduleName: string): void {
    this.metas.delete(moduleName)
  }

  private readMetaUncached(moduleName: string): PluginPackageMeta {
    const key = packageKeyOf(moduleName)
    let located = this.packageDirs.get(key)
    if (located === undefined) {
      const fallback = resolvePluginPackageDir(moduleName, this.baseUrl)
      if (fallback !== null) {
        located = { packageDir: fallback, resolutionRoot: 'unknown' }
        this.packageDirs.set(key, located)
      }
    }
    if (located === undefined) {
      return { located: null, packageName: null, realPackageDir: null, card: EMPTY_CARD, manifestOrigin: undefined, repositoryUrl: null }
    }
    return { located, realPackageDir: realpathOf(located.packageDir), ...readPackageMetaFromDir(located.packageDir) }
  }
}
