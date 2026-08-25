/**
 * Inventory assembly: read the Loader roster once per request and decorate
 * each entry with card metadata and origin classification. This module is a
 * pure engine over injected inputs (roster rows + profile directory) — the
 * Cordis wiring lives in the host entry and the RPC channel in T04.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import {
  PluginInventoryCardReader,
  packageKeyOf,
} from './card.ts'
import {
  isPathInside,
  parseFileSpecifierTarget,
  parseOriginOverrides,
  resolveOrigin,
  normalizeOrigin,
  type PackageResolutionEvidence,
  type PluginOriginOverrides,
} from './origin.ts'
import { ProfileInstallSourceReader, type ProfileInstallSources } from './install-source.ts'
import type {
  ManagerEntry,
  PluginInventoryCardText,
  PluginInventoryOrigin,
  PluginOriginDiagnostic,
} from './protocol.ts'

/** One roster row supplied by the host wiring (mirrors a non-group Loader entry). */
export interface RosterEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly disabled: boolean
}

/** Profile directory, or null when the Loader has no base URL. */
export function profileDirOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) return null
  try {
    return fileURLToPath(new URL('.', baseUrl))
  } catch {
    return null
  }
}

/** The fallback origin for entries whose resolution itself fails. */
const FALLBACK_ORIGIN: PluginInventoryOrigin = {
  kind: 'opensource',
  customized: false,
  upstream: null,
  fork: null,
  branch: null,
  note: null,
  declaredBy: 'heuristic',
}

/** One assembled capability snapshot. */
export interface InventorySnapshot {
  readonly entries: readonly ManagerEntry[]
  readonly diagnostics: readonly PluginOriginDiagnostic[]
}

/** Assemble the manager roster for one request. */
export class InventoryAssembler {
  private readonly cards: PluginInventoryCardReader
  private readonly installSources: ProfileInstallSourceReader
  private readonly profileDir: string | null
  private readonly localPluginsDir: string | null

  constructor(baseUrl: string | undefined) {
    this.cards = new PluginInventoryCardReader(baseUrl)
    this.profileDir = profileDirOf(baseUrl)
    this.installSources = new ProfileInstallSourceReader(this.profileDir)
    this.localPluginsDir = this.profileDir === null
      ? null
      : join(dirname(dirname(this.profileDir)), 'plugins', 'local')
  }

  /** Read the profile's origin override file; invalid files yield none. */
  private readOverrides(diagnostics: PluginOriginDiagnostic[]): PluginOriginOverrides | null {
    if (this.profileDir === null) return null
    let text: string
    try {
      text = readFileSync(join(this.profileDir, 'plugin-origins.json'), 'utf8')
    } catch {
      return null
    }
    const result = parseOriginOverrides(text)
    diagnostics.push(...result.diagnostics)
    return result.overrides
  }

  /** Whether a `file:`/`link:` target lives inside the local plugins dir. */
  private fileTargetInsideLocal(target: string): boolean {
    if (this.profileDir === null || this.localPluginsDir === null) return false
    return isPathInside(
      isAbsolute(target) ? target : resolve(this.profileDir, target),
      this.localPluginsDir,
    )
  }

  /** Resolve one entry's origin through the override/manifest/heuristic chain. */
  private originOf(
    moduleName: string,
    overrides: PluginOriginOverrides | null,
    sources: ProfileInstallSources,
    diagnostics: PluginOriginDiagnostic[],
  ): PluginInventoryOrigin {
    try {
      if (moduleName.startsWith('cordis:')) {
        return normalizeOrigin({ kind: 'official' }, 'heuristic')
      }
      const meta = this.cards.readMeta(moduleName)
      const key = packageKeyOf(moduleName)
      const packageName = meta.packageName ?? key
      const specifier = sources.specifiers.get(key) ?? null
      const resolution = sources.resolutions.get(key) ?? null
      const fileTarget = parseFileSpecifierTarget(resolution) ?? parseFileSpecifierTarget(specifier)
      const fileTargetInsideLocal = fileTarget !== null && this.fileTargetInsideLocal(fileTarget)
      const realDir = meta.realPackageDir
      const evidence: PackageResolutionEvidence = {
        packageName,
        packageDir: meta.located?.packageDir ?? null,
        realPackageDir: realDir,
        resolutionRoot: meta.located?.resolutionRoot ?? 'unknown',
        insideEngineCheckout: meta.located?.resolutionRoot === 'engine',
        insideLocalPlugins: realDir !== null && this.localPluginsDir !== null
          && isPathInside(realDir, this.localPluginsDir),
        profileSpecifier: specifier,
        lockfileResolution: resolution,
        fileTargetInsideLocal,
        repositoryUrl: meta.repositoryUrl,
      }
      const override = overrides?.packages.get(packageName)
        ?? (packageName === key ? undefined : overrides?.packages.get(key))
      const result = resolveOrigin(evidence, { override, manifest: meta.manifestOrigin })
      diagnostics.push(...result.diagnostics)
      return result.origin
      /* v8 ignore start -- defensive: the resolver chain above is total over its inputs; this catch only guards unforeseen IO races. */
    } catch {
      return FALLBACK_ORIGIN
    }
    /* v8 ignore stop */
  }

  /** Assemble the current roster with origins and cards. */
  list(roster: readonly RosterEntry[]): InventorySnapshot {
    const entries: ManagerEntry[] = []
    const diagnostics: PluginOriginDiagnostic[] = []
    const sources = this.installSources.read()
    diagnostics.push(...sources.diagnostics)
    const overrides = this.readOverrides(diagnostics)
    for (const row of roster) {
      const meta = this.cards.readMeta(row.moduleName)
      entries.push({
        entryId: row.entryId,
        moduleName: row.moduleName,
        enabled: !row.disabled,
        origin: this.originOf(row.moduleName, overrides, sources, diagnostics),
        title: meta.card.title as PluginInventoryCardText | null,
        description: meta.card.description as PluginInventoryCardText | null,
        // T03 fills the real capability gates; the T02 surface exposes the
        // roster with origins so the UI can already render rows.
        canToggle: !row.disabled,
        canUninstall: false,
        toggleBlockReason: null,
        uninstallBlockReason: 'not-direct-dependency',
      })
    }
    return { entries, diagnostics }
  }
}
