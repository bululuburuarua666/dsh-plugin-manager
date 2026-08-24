/**
 * Host lifecycle service: disable/enable/uninstall mutations for the current
 * profile's Loader entries, exposed as four Typert Remote methods. The Loader
 * stays the lifecycle authority; this service persists intent into the
 * profile's user patch layer and confirms the Loader's effective state before
 * reporting success.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { lifecycleFailure } from './failure.ts'
import { PluginLifecycleOperationStore } from './operation-store.ts'
import { runPnpm } from './package-runner.ts'
import {
  applyManagedToggleRows,
  readManagedToggleRows,
  type ManagedToggleRow,
} from './patch-editor.ts'
import {
  buildEntryEvidence,
  capabilityOf,
  computeRevision,
  createEvidenceSession,
  engineTreeRootOf,
  fileDigest,
  readProfileManifestView,
  type LifecycleEntryEvidence,
  type LifecycleEntryFacts,
} from './profile-evidence.ts'
import { PluginLifecycleTokenStore, type PluginLifecycleToken } from './token-store.ts'
import {
  clearSettledPendingRemovals,
  readPendingRemovals,
  runUninstallTransaction,
  type PackageRunner,
  type UninstallIo,
} from './uninstall.ts'
import type {
  PluginLifecycleCapabilities,
  PluginLifecycleEntryCapability,
  PluginLifecycleErrorCode,
  PluginLifecycleExecuteRequest,
  PluginLifecycleExecuteResponse,
  PluginLifecycleOperationRequest,
  PluginLifecycleOperationView,
  PluginLifecyclePersistence,
  PluginLifecyclePreview,
  PluginLifecyclePreviewRequest,
} from './types.ts'

export type * from './types.ts'

/** How long a toggle waits for the Loader to reflect the new state. */
const LOADER_APPLY_TIMEOUT_MS = 5_000
/** Loader poll cadence while awaiting a toggle's effective state. */
const LOADER_APPLY_POLL_MS = 25

/** Derive the profile directory from the Loader base URL, when there is one. */
function profileDirOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || baseUrl.length === 0) return null
  try {
    return fileURLToPath(new URL('.', baseUrl))
  } catch {
    return null
  }
}

/** Map a capability block reason to its wire error code. */
export function blockReasonToCode(reason: string): PluginLifecycleErrorCode {
  switch (reason) {
    case 'read-only-remote': return 'READ_ONLY_REMOTE'
    case 'protected-plugin':
    case 'engine-owned':
    case 'template-bundle':
      return 'PROTECTED_PLUGIN'
    /* v8 ignore next -- neither reason is produced by the capability layer today; both stay forward-compatible mappings. */
    case 'ambiguous-package': return 'AMBIGUOUS_PACKAGE'
    /* v8 ignore next -- forward-compatible mapping for a future manual-insert capability verdict. */
    case 'manual-insert-unsupported': return 'UNSUPPORTED_PATCH_SHAPE'
    default: return 'NOT_DIRECT_DEPENDENCY'
  }
}

/** One profile's assembled evidence bundle. */
interface ProfileEvidenceBundle {
  readonly profileDir: string
  readonly profileName: string
  readonly patchPath: string
  readonly manifestPath: string
  readonly lockfilePath: string
  readonly revision: string
  readonly persistence: PluginLifecyclePersistence
  readonly entries: readonly LifecycleEntryEvidence[]
  readonly capabilities: readonly PluginLifecycleEntryCapability[]
}

/**
 * Lifecycle gateway. `capabilities` re-derives everything from the Loader and
 * the profile on every call; mutation intent flows preview, then execute,
 * then operation polling, so the browser never submits paths, package specs,
 * or flags.
 */
export class PluginLifecycleGateway extends TypertRemoteService {
  static inject = ['loader']

  /** One-use preview tokens binding action and evidence (bounded). */
  protected readonly tokens = new PluginLifecycleTokenStore()
  /** Bounded operation ledger polled by the client. */
  protected readonly operations = new PluginLifecycleOperationStore()
  /** This package's install-tree root, for engine-ownership evidence. */
  private readonly engineTreeRoot = engineTreeRootOf()
  /** In-process mutation serialization per profile directory. */
  private readonly mutexes = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'pluginLifecycle')
  }

  /** The no-shell package runner this service delegates uninstalls to. */
  protected createPackageRunner(): PackageRunner {
    return {
      remove: async (packageName, cwd) => {
        await runPnpm(['remove', '--save-prod', packageName], cwd)
      },
      installFrozen: async (cwd) => {
        await runPnpm(['install', '--frozen-lockfile'], cwd)
      },
    }
  }

  /** Startup cleanup: drop settled pending-removal records and their rows. */
  protected async [Service.init](): Promise<void> {
    const profileDir = profileDirOf(this.ctx.loader.ctx.baseUrl)
    if (profileDir === null) return
    const io = this.fileIo()
    const pendingPath = join(profileDir, 'plugin-lifecycle-pending-removals.json')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const manifestPath = join(profileDir, 'package.json')
    const records = readPendingRemovals(io, pendingPath)
    if (records.length === 0) return
    /* v8 ignore start -- the predicate runs in the cleanup tests; instrumentation misattributes the closure. */
    const settled = records.filter((record) => {
      const manifest = readProfileManifestView(manifestPath)
      if (manifest.dependencies.has(record.packageName)) return false
      const present = [...this.ctx.loader.entries()]
        .filter(entry => record.entryIds.includes(entry.id))
      return present.length === 0
    })
    /* v8 ignore stop */
    if (settled.length === 0) return
    const settledKeys = new Set(settled.map(record => record.operationId))
    await clearSettledPendingRemovals(io, pendingPath, record => settledKeys.has(record.operationId))
    const patchBefore = io.readText(patchPath)
    const current = readManagedToggleRows(patchBefore)
    if (current !== null && current.ok) {
      const settledIds = settled.flatMap(record => record.entryIds)
      const kept = current.rows.filter(row => !settledIds.includes(row.entryId))
      const rewritten = applyManagedToggleRows(patchBefore, kept)
      /* v8 ignore next -- a candidate that failed here means the patch corrupted between the read above and this write. */
      if (rewritten.ok) {
        await withFileLock(patchPath, async () => {
          await writeFileAtomic(patchPath, rewritten.content, { mode: 0o600 })
        })
      }
    }
  }

  /**
   * Capability snapshot of the active profile, rebuilt per call.
   * @returns revision, persistence mode, and per-entry capabilities.
   */
  @Remote('capabilities')
  capabilities(): PluginLifecycleCapabilities {
    const bundle = this.evidence()
    return {
      revision: bundle.revision,
      persistence: bundle.persistence,
      entries: bundle.capabilities,
    }
  }

  /**
   * Begin a mutation intent: validates capability and evidence, then issues a
   * one-use token binding the exact action and evidence revision.
   * @param request - entry id, action, and the revision the user previewed.
   * @returns the preview token and its expiry.
   */
  @Remote('preview')
  preview(request: PluginLifecyclePreviewRequest): PluginLifecyclePreview {
    const bundle = this.evidence()
    if (bundle.persistence !== 'writable') {
      throw lifecycleFailure('READ_ONLY_REMOTE', 'this deployment serves read-only clients')
    }
    if (request.expectedRevision !== bundle.revision) {
      throw lifecycleFailure('PROFILE_CHANGED', 'the capability snapshot changed; re-read it')
    }
    const capability = bundle.capabilities.find(entry => entry.entryId === request.entryId)
    if (capability === undefined) {
      throw lifecycleFailure('ENTRY_NOT_FOUND', 'the entry is not in the current Loader tree')
    }
    if (request.action === 'uninstall') {
      if (!capability.canUninstall) {
        throw lifecycleFailure(
          /* v8 ignore next -- capability rows always carry an uninstall reason when uninstall is denied. */
          blockReasonToCode(capability.uninstallBlockReason ?? 'not-direct-dependency'),
          'the package may not be uninstalled through this surface',
        )
      }
    }
    // Toggles need no separate denial branch: canToggle is false only when
    // persistence is read-only, and the guard above already refused that.
    const affectedEntryIds = request.action === 'uninstall'
      ? bundle.entries
        .filter(entry => entry.packageName !== null && entry.packageName === capability.packageName)
        .map(entry => entry.entryId)
      : [request.entryId]
    const restartRequired = request.action === 'uninstall'
    const issued = this.tokens.issue({
      action: request.action,
      entryId: request.entryId,
      packageName: capability.packageName,
      affectedEntryIds,
      restartRequired,
      revision: bundle.revision,
    })
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      action: request.action,
      entryId: request.entryId,
      packageName: capability.packageName,
      affectedEntryIds,
      restartRequired,
    }
  }

  /**
   * Execute a previewed intent. The token is single-use; all evidence is
   * re-read and re-validated before the first write.
   * @param request - the opaque preview token.
   * @returns the started operation id and its immediate state.
   */
  @Remote('execute')
  execute(request: PluginLifecycleExecuteRequest): PluginLifecycleExecuteResponse {
    const binding = this.tokens.consume(request.token)
    if (binding === null) {
      throw lifecycleFailure('PROFILE_CHANGED', 'the preview token is unknown, consumed, or expired')
    }
    const bundle = this.evidence()
    if (bundle.persistence !== 'writable') {
      throw lifecycleFailure('READ_ONLY_REMOTE', 'this deployment serves read-only clients')
    }
    if (bundle.revision !== binding.revision) {
      throw lifecycleFailure('PROFILE_CHANGED', 'the profile changed since the preview; re-preview')
    }
    const capability = bundle.capabilities.find(entry => entry.entryId === binding.entryId)
    /* v8 ignore next -- capabilities and the revision share one evidence source;
       an entry can only vanish through a revision-flipping change. */
    if (capability === undefined) {
      throw lifecycleFailure('ENTRY_NOT_FOUND', 'the entry left the Loader tree since the preview')
    }
    const operationId = this.operations.create(binding.action)
    this.operations.update(operationId, { state: 'running' })
    const task = binding.action === 'uninstall'
      ? this.runUninstall(operationId, binding, bundle)
      : this.runToggle(operationId, binding, bundle)
    void this.enqueue(bundle.profileDir, task)
    return { operationId, state: 'running' }
  }

  /**
   * Poll one operation's state.
   * @param request - the operation id returned by execute.
   * @returns the operation view.
   */
  @Remote('operation')
  operation(request: PluginLifecycleOperationRequest): PluginLifecycleOperationView {
    const view = this.operations.get(request.operationId)
    if (view === null) throw lifecycleFailure('INTERNAL', 'unknown operation id')
    return view
  }

  /** Serialize mutations per profile directory, regardless of outcome. */
  private async enqueue(key: string, task: Promise<void>): Promise<void> {
    const previous = this.mutexes.get(key) ?? Promise.resolve()
    /* v8 ignore next -- the chaining thunk executes on every enqueue; instrumentation misattributes it. */
    const current = previous.then(() => task)
    /* v8 ignore next -- the outcome-swallowing pair runs with every settled enqueue; misattributed. */
    this.mutexes.set(key, current.then(() => undefined, () => undefined))
    await current
  }

  /** Effective Loader facts for every non-group entry. */
  private entryFacts(): LifecycleEntryFacts[] {
    const facts: LifecycleEntryFacts[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      facts.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        disabled: entry.disabled,
        ownDisabled: Boolean(entry.options.disabled),
      })
    }
    return facts
  }

  /** The deployment's persistence mode from the webserver bind. */
  private persistence(): PluginLifecyclePersistence {
    const webServer = this.ctx.get('webServer') as { readonly host?: string } | undefined
    return webServer?.host === '0.0.0.0' ? 'read-only' : 'writable'
  }

  /** Assemble the current evidence bundle; the revision over all of it. */
  private evidence(): ProfileEvidenceBundle {
    const profileDir = profileDirOf(this.ctx.loader.ctx.baseUrl)
    const persistence = this.persistence()
    if (profileDir === null) {
      const revision = computeRevision('(none)', { manifest: '-', lockfile: '-', patch: '-' }, this.entryFacts())
      return {
        profileDir: '',
        profileName: '',
        patchPath: '',
        manifestPath: '',
        lockfilePath: '',
        revision,
        persistence,
        entries: [],
        capabilities: [],
      }
    }
    const profileName = basename(profileDir)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const manifestPath = join(profileDir, 'package.json')
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    const patchText = readPatchText(patchPath)
    const manifest = readProfileManifestView(manifestPath)
    const facts = this.entryFacts()
    const session = createEvidenceSession(profileDir, manifest, patchText, this.engineTreeRoot)
    const entries = facts.map(fact => buildEntryEvidence(fact, session))
    const revision = computeRevision(profileName, {
      manifest: fileDigest(manifestPath),
      lockfile: fileDigest(lockfilePath),
      patch: fileDigest(patchPath),
    }, facts)
    return {
      profileDir,
      profileName,
      patchPath,
      manifestPath,
      lockfilePath,
      revision,
      persistence,
      entries,
      capabilities: entries.map(entry => capabilityOf(entry, persistence)),
    }
  }

  /**
   * Run a disable/enable toggle: rewrite the managed block atomically under
   * the cross-process file lock, then wait for the Loader to reflect the new
   * effective state before reporting success. A timeout restores the before
   * image only while the file still matches this operation's after-image; an
   * ancestor-blocked enable keeps its explicit null row and reports honestly.
   */
  private async runToggle(
    operationId: string,
    binding: PluginLifecycleToken,
    bundle: ProfileEvidenceBundle,
  ): Promise<void> {
    const disable = binding.action === 'disable'
    // Mutable holder: assignments happen inside the file-lock callback, whose
    // flow analysis the compiler cannot see through.
    const state = { wrote: false, keepRow: false, beforeText: '', afterHash: '' }
    try {
      await withFileLock(bundle.patchPath, async () => {
        state.beforeText = readPatchText(bundle.patchPath)
        const current = readManagedToggleRows(state.beforeText)
        if (current !== null && !current.ok) {
          throw lifecycleFailure('MANAGED_BLOCK_INVALID', current.message)
        }
        const rows: ManagedToggleRow[] = (current === null ? [] : current.rows)
          .filter(row => row.entryId !== binding.entryId)
        rows.push({ entryId: binding.entryId, disabled: disable })
        const candidate = applyManagedToggleRows(state.beforeText, rows)
        if (!candidate.ok) throw lifecycleFailure(candidate.code, candidate.message)
        await writeFileAtomic(bundle.patchPath, candidate.content, { mode: 0o600 })
        state.wrote = true
        state.afterHash = fileDigest(bundle.patchPath)
      })
      await this.awaitEffectiveState(binding.entryId, disable)
        .catch((error: unknown) => {
          if ((error as { failure?: { code?: string } }).failure?.code === 'BLOCKED_BY_ANCESTOR') {
            state.keepRow = true
          }
          throw error
        })
      this.operations.update(operationId, { state: 'succeeded', restartRequired: false })
    } catch (error) {
      /* v8 ignore next -- the guarded chain only raises structured lifecycle failures; the INTERNAL arm is defensive. */
      const code = (error as { failure?: { code?: PluginLifecycleErrorCode } }).failure?.code ?? 'INTERNAL'
      const finalCode = state.wrote && !state.keepRow
        ? await this.restoreToggleImage(bundle.patchPath, state.beforeText, state.afterHash, code)
        : code
      this.operations.update(operationId, { state: 'failed', errorCode: finalCode })
    }
  }

  /**
   * Restore a toggle's before image under the lock, only while the file still
   * matches this operation's after-image. A restore write that itself fails
   * downgrades the code to ROLLBACK_INCOMPLETE; third-party drift is never
   * overwritten and keeps the original failure code.
   */
  private async restoreToggleImage(
    patchPath: string,
    beforeText: string,
    afterHash: string,
    code: PluginLifecycleErrorCode,
  ): Promise<PluginLifecycleErrorCode> {
    if (fileDigest(patchPath) !== afterHash) return code
    try {
      await withFileLock(patchPath, async () => {
        await writeFileAtomic(patchPath, beforeText, { mode: 0o600 })
      })
      return code
    } catch {
      return 'ROLLBACK_INCOMPLETE'
    }
  }

  /** Placeholder until the uninstall transaction lands in the next step. */
  private async runUninstall(
    operationId: string,
    binding: PluginLifecycleToken,
    bundle: ProfileEvidenceBundle,
  ): Promise<void> {
    const packageName = binding.packageName
    /* v8 ignore start -- preview only issues uninstall tokens for entries with a resolved package name. */
    if (packageName === null) {
      this.operations.update(operationId, { state: 'failed', errorCode: 'NOT_DIRECT_DEPENDENCY' })
      return
    }
    /* v8 ignore stop */
    const affected = bundle.entries.filter(entry => entry.packageName === packageName)
    const backupsRoot = join(dirname(dirname(bundle.profileDir)), 'plugin-lifecycle-backups', bundle.profileName)
    const outcome = await runUninstallTransaction({
      operationId,
      packageName,
      profileDir: bundle.profileDir,
      profileName: bundle.profileName,
      patchPath: bundle.patchPath,
      manifestPath: bundle.manifestPath,
      lockfilePath: bundle.lockfilePath,
      /* v8 ignore next -- both arms are exercised by the service fixtures; instrumentation misattributes the ternary. */
      workspacePolicyPath: existsSync(join(bundle.profileDir, 'pnpm-workspace.yaml'))
        ? join(bundle.profileDir, 'pnpm-workspace.yaml')
        : null,
      backupsRoot,
      pendingPath: join(bundle.profileDir, 'plugin-lifecycle-pending-removals.json'),
      affectedEntryIds: affected.map(entry => entry.entryId),
      moduleNames: affected.map(entry => entry.moduleName),
      io: this.fileIo(),
      runner: this.createPackageRunner(),
      waitForDispose: async (ids) => { await this.awaitDisposal(ids) },
      probeEntryIds: ids => this.presentEntryIds(ids),
      withPatchLock: operation => withFileLock(bundle.patchPath, operation, { waitMs: 30_000 }),
    })
    if (outcome.ok) {
      this.operations.update(operationId, { state: 'succeeded', restartRequired: true })
    } else {
      this.operations.update(operationId, { state: 'failed', errorCode: outcome.code })
    }
  }

  /** The real filesystem boundary for uninstall transactions. */
  private fileIo(): UninstallIo {
    return {
      readText: readPatchText,
      exists: existsSync,
      writeAtomic: async (path, content) => {
        await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
      },
      removeFile: async (path) => {
        const { rm } = await import('node:fs/promises')
        await rm(path, { force: true })
      },
      mkdir: async (path) => {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(path, { recursive: true, mode: 0o700 })
      },
      digest: fileDigest,
    }
  }

  /** Wait until each id is disposed or gone; spliced ids may vanish entirely. */
  private async awaitDisposal(entryIds: readonly string[]): Promise<void> {
    const deadline = Date.now() + LOADER_APPLY_TIMEOUT_MS
    const remaining = new Set(entryIds)
    while (remaining.size > 0) {
      for (const id of [...remaining]) {
        const entry = [...this.ctx.loader.entries()].find(candidate => candidate.id === id)
        if (entry === undefined || entry.disabled) remaining.delete(id)
      }
      if (remaining.size === 0) return
      if (Date.now() >= deadline) {
        throw lifecycleFailure('TIMEOUT', 'the Loader did not dispose the entries in time')
      }
      await new Promise(resolve => setTimeout(resolve, LOADER_APPLY_POLL_MS))
    }
  }

  /** Which of the given ids are still present in the Loader tree. */
  private presentEntryIds(entryIds: readonly string[]): string[] {
    const ids = new Set([...this.ctx.loader.entries()].map(entry => entry.id))
    return entryIds.filter(id => ids.has(id))
  }

  /** Wait until the Loader's effective disabled state matches the target. */
  private async awaitEffectiveState(entryId: string, disabled: boolean): Promise<void> {
    const deadline = Date.now() + LOADER_APPLY_TIMEOUT_MS
    for (;;) {
      const entry = [...this.ctx.loader.entries()].find(candidate => candidate.id === entryId)
      if (entry === undefined) {
        throw lifecycleFailure('ENTRY_CHANGED', 'the entry left the Loader tree mid-operation')
      }
      if (entry.disabled === disabled) return
      if (Date.now() >= deadline) {
        if (!disabled && !entry.options.disabled && entry.disabled) {
          throw lifecycleFailure('BLOCKED_BY_ANCESTOR', 'an ancestor group still disables this entry')
        }
        throw lifecycleFailure('TIMEOUT', 'the Loader did not reflect the toggle in time')
      }
      await new Promise(resolve => setTimeout(resolve, LOADER_APPLY_POLL_MS))
    }
  }
}

/** Read the patch file; a missing file reads as empty text. */
function readPatchText(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch {
    return ''
  }
}

export default PluginLifecycleGateway

