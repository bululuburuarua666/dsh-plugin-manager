/** Read-only projection of the current Cordis Loader plugin entries. */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { packageKeyOf, PluginInventoryCardReader } from './card.ts'
import { ProfileInstallSourceReader, type ProfileInstallSources } from './install-source.ts'
import {
  isPathInside,
  normalizeOrigin,
  parseFileSpecifierTarget,
  parseOriginOverrides,
  resolveOrigin,
  type PackageResolutionEvidence,
  type PluginOriginOverrides,
} from './origin.ts'
import type {
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventoryOrigin,
  PluginInventorySnapshot,
  PluginOriginDiagnostic,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Derive the profile directory from the Loader base URL, when there is one. */
function profileDirOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) return null
  try {
    return fileURLToPath(new URL('.', baseUrl))
  } catch {
    return null
  }
}

/**
 * Locate this gateway package's own install tree root: walk up from this
 * module to its package.json, then two levels above the real package
 * directory (the scope/group dir's parent: `node_modules` in a published
 * layout, `packages` in the monorepo). Packages whose real path lives under
 * this root ship with the running engine. Null when the package cannot
 * locate itself.
 */
function engineTreeRootOf(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest === 'object' && manifest !== null
        && (manifest as Record<string, unknown>).name === '@deepseek-ai/dsh-host-plugin-inventory') {
        return dirname(dirname(realpathSync(dir)))
      }
    } catch {
      // Keep walking towards the filesystem root.
    }
    const parent = dirname(dir)
    /* v8 ignore next -- reaching the filesystem root means the gateway package is uninstalled; a test cannot fabricate that. */
    if (parent === dir) return null
    dir = parent
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

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  /** Latest observed change time per Loader entry id. */
  private readonly updatedAt = new Map<string, number>()
  /** Indexed, cached bilingual hover cards for configured packages. */
  private readonly cards: PluginInventoryCardReader
  /** Cached reader of the profile's dependency specs and lockfile. */
  private readonly installSources: ProfileInstallSourceReader
  /** Profile directory, or null when the Loader has no base URL. */
  private readonly profileDir: string | null
  /** `$DSH_HOME/plugins/local`, derived from the profile layout. */
  private readonly localPluginsDir: string | null
  /** Real-path root of the running engine's own install tree. */
  private readonly engineTreeRoot = engineTreeRootOf()

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
    this.cards = new PluginInventoryCardReader(this.ctx.loader.ctx.baseUrl)
    this.profileDir = profileDirOf(this.ctx.loader.ctx.baseUrl)
    this.installSources = new ProfileInstallSourceReader(this.profileDir)
    this.localPluginsDir = this.profileDir === null
      ? null
      : join(dirname(dirname(this.profileDir)), 'plugins', 'local')

    const touchFiber = (fiber: Fiber): void => {
      const entry = fiber.entry
        ?? [...this.ctx.loader.entries()].find(candidate => candidate.fiber === fiber)
      if (entry !== undefined) this.updatedAt.set(entry.id, Date.now())
    }
    ctx.on('internal/plugin', touchFiber)
    ctx.on('internal/status', touchFiber)
    ctx.on('loader/partial-dispose', (entry, _legacy, active) => {
      if (active) {
        this.updatedAt.set(entry.id, Date.now())
      } else {
        this.updatedAt.delete(entry.id)
      }
      this.cards.drop(entry.options.name)
    })
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
    /* v8 ignore next -- a null profileDir yields empty install sources, so callers never reach this with a target in tests. */
    if (this.profileDir === null || this.localPluginsDir === null) return false
    return isPathInside(
      isAbsolute(target) ? target : resolve(this.profileDir, target),
      this.localPluginsDir,
    )
  }

  /**
   * Resolve one Loader entry's origin. `cordis:` builtins are engine-shipped
   * framework modules and classify as official directly; every other entry
   * goes through the override / manifest / heuristic priority chain. A failure
   * here must never break the list, so unexpected errors fall back to the
   * conservative open-source default.
   */
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
        insideEngineCheckout: realDir !== null && this.engineTreeRoot !== null
          && isPathInside(realDir, this.engineTreeRoot),
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

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so the lifecycle
   * itself is never cached; only observed change timestamps are.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    const diagnostics: PluginOriginDiagnostic[] = []
    const firstObservedAt = Date.now()
    const sources = this.installSources.read()
    diagnostics.push(...sources.diagnostics)
    const overrides = this.readOverrides(diagnostics)
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      let updatedAt = this.updatedAt.get(entry.id)
      if (updatedAt === undefined) {
        updatedAt = firstObservedAt
        this.updatedAt.set(entry.id, updatedAt)
      }
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        updatedAt,
        card: this.cards.read(entry.options.name),
        origin: this.originOf(entry.options.name, overrides, sources, diagnostics),
      })
    }
    return diagnostics.length === 0 ? { entries } : { entries, diagnostics }
  }
}

export default PluginInventoryGateway
