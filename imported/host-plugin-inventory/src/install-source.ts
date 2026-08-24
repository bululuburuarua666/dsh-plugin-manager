/**
 * Profile install-source reader: loads the profile's package.json dependency
 * specs and pnpm-lock.yaml importer resolutions at most once per `list()` and
 * caches them by file stamp. All failures degrade to empty sources with a
 * sanitized diagnostic; this reader never throws into the inventory path.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import type { PluginOriginDiagnostic } from './types.ts'
import { stripPeerSuffix } from './origin.ts'

/** pnpm lockfile versions this reader understands. */
const SUPPORTED_LOCKFILE_VERSIONS: readonly string[] = ['9.0']

/** Direct-dependency sections read from both manifests and lockfiles. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** Per-file stamp used to invalidate the cached read. */
interface FileStamp {
  readonly mtimeMs: number
  readonly size: number
}

/** Read one file's stamp plus content; null when missing or unreadable. */
function readStamped(path: string): { stamp: FileStamp; text: string } | null {
  try {
    const stat = statSync(path)
    return { stamp: { mtimeMs: stat.mtimeMs, size: stat.size }, text: readFileSync(path, 'utf8') }
  } catch {
    return null
  }
}

/** Stable comparison key for a stamp; empty when the file is absent. */
function stampKey(stamp: FileStamp | null | undefined): string {
  return stamp === null || stamp === undefined ? '' : `${stamp.mtimeMs}:${stamp.size}`
}

/** Narrow an unknown value to a string-keyed record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

/**
 * Extract direct dependency name → specifier pairs from a parsed package.json
 * or from one lockfile importer object (whose entries carry `specifier` /
 * `version` pairs). Lockfile mode returns the bare resolution instead.
 * @param manifest - parsed JSON/YAML root.
 * @param mode - `specifier` reads package.json-style sections; `resolution`
 *   reads lockfile importer sections and returns the recorded `version`.
 * @returns collected name → spec/resolution entries.
 */
function collectDependencies(
  manifest: Record<string, unknown> | null,
  mode: 'specifier' | 'resolution',
): Map<string, string> {
  const result = new Map<string, string>()
  if (manifest === null) return result
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = asRecord(manifest[section])
    if (entries === null) continue
    for (const [name, value] of Object.entries(entries)) {
      if (result.has(name)) continue
      if (mode === 'specifier') {
        if (typeof value === 'string') result.set(name, value)
        continue
      }
      const entry = asRecord(value)
      const version = entry === null ? null : entry.version
      if (typeof version === 'string') result.set(name, stripPeerSuffix(version))
    }
  }
  return result
}

/** Snapshot of a profile's direct install sources. */
export interface ProfileInstallSources {
  /** package.json dependency spec by package name. */
  readonly specifiers: ReadonlyMap<string, string>
  /** pnpm-lock.yaml importer resolution by package name. */
  readonly resolutions: ReadonlyMap<string, string>
  /** Diagnostics collected while reading; sanitized, path-free. */
  readonly diagnostics: readonly PluginOriginDiagnostic[]
}

/**
 * Cached reader of one profile directory's install sources. Both files are
 * re-read only when their stamp changes; the lockfile is optional (a profile
 * without one still contributes its package.json specifiers).
 */
export class ProfileInstallSourceReader {
  private readonly manifestPath: string | null
  private readonly lockfilePath: string | null
  private cached: {
    readonly manifestStamp: FileStamp | null
    readonly lockfileStamp: FileStamp | null
    readonly sources: ProfileInstallSources
  } | null = null

  /**
   * @param profileDir - absolute profile directory; null disables reading and
   *   yields empty sources forever (unit harnesses without a profile).
   */
  constructor(profileDir: string | null) {
    this.manifestPath = profileDir === null ? null : join(profileDir, 'package.json')
    this.lockfilePath = profileDir === null ? null : join(profileDir, 'pnpm-lock.yaml')
  }

  /**
   * Read (and cache) the profile's install sources.
   * @returns current sources; never throws.
   */
  read(): ProfileInstallSources {
    if (this.manifestPath === null || this.lockfilePath === null) {
      return { specifiers: new Map(), resolutions: new Map(), diagnostics: [] }
    }
    const manifestFile = readStamped(this.manifestPath)
    const lockfileFile = readStamped(this.lockfilePath)
    const cached = this.cached
    if (cached !== null
      && stampKey(cached.manifestStamp) === stampKey(manifestFile?.stamp ?? null)
      && stampKey(cached.lockfileStamp) === stampKey(lockfileFile?.stamp ?? null)) {
      return cached.sources
    }
    const sources = this.readUncached(manifestFile?.text ?? null, lockfileFile?.text ?? null)
    this.cached = {
      manifestStamp: manifestFile?.stamp ?? null,
      lockfileStamp: lockfileFile?.stamp ?? null,
      sources,
    }
    return sources
  }

  /** Parse both manifests without consulting the cache. */
  private readUncached(manifestText: string | null, lockfileText: string | null): ProfileInstallSources {
    const diagnostics: PluginOriginDiagnostic[] = []
    let specifiers = new Map<string, string>()
    let resolutions = new Map<string, string>()

    if (manifestText !== null) {
      try {
        specifiers = collectDependencies(asRecord(JSON.parse(manifestText)), 'specifier')
      } catch {
        // A broken profile manifest is the launcher's own error surface; the
        // inventory simply has no specifier evidence.
      }
    }

    if (lockfileText !== null) {
      try {
        const lockfile = asRecord(parseYaml(lockfileText))
        const version = lockfile === null ? null : lockfile.lockfileVersion
        // YAML parses an unquoted 9.0 as the number 9; re-add the minor part.
        const versionText = typeof version === 'string'
          ? version
          : typeof version === 'number' && Number.isFinite(version)
            ? (Number.isInteger(version) ? `${version}.0` : String(version))
            : null
        if (lockfile === null || versionText === null || !SUPPORTED_LOCKFILE_VERSIONS.includes(versionText)) {
          diagnostics.push({ code: 'lockfile-unsupported', packageName: null })
        } else {
          const importers = asRecord(lockfile.importers)
          const importer = importers === null ? null : asRecord(importers['.'])
          resolutions = collectDependencies(importer, 'resolution')
        }
      } catch {
        diagnostics.push({ code: 'lockfile-unsupported', packageName: null })
      }
    }
    return { specifiers, resolutions, diagnostics }
  }
}
