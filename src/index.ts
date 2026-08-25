/**
 * Host half: a real Cordis plugin. `loader` is a required injection (Cordis
 * holds this plugin until the Loader exists); `connection` is awaited
 * dynamically with `ctx.inject(['connection'], …)` so a Host without the
 * Connection RPC surface still mounts the plugin (the tab reports
 * unavailable instead of stranding the whole plugin).
 *
 * The single `/dsh-plugin-manager` channel is registered with loopback
 * authority — the official Host trust fence runs before any handler code.
 */
import { LifecycleEngine, type EngineHost } from './host/engine.ts'
import { InventoryAssembler } from './host/inventory.ts'
import {
  MANAGER_CHANNEL,
  MANAGER_ENDPOINTS,
  parseManagerRequest,
  REQUEST_BODY_MAX_BYTES,
  type ManagerEndpoint,
} from './host/channel-protocol.ts'
import { PROTOCOL_VERSION } from './host/protocol.ts'
import { ManagerFailure } from './host/failure.ts'
import type { LoaderEntry } from './host/cordis.ts'

export { MANAGER_CHANNEL, MANAGER_ENDPOINTS, PROTOCOL_VERSION }
export type { ManagerEndpoint }

/** Structural shape of the real Cordis plugin context this plugin consumes. */
interface PluginContext {
  readonly loader: { readonly ctx: { readonly baseUrl: string | undefined; entries(): Iterable<LoaderEntry> } }
  /** Dynamic dependency injection: runs the callback once `deps` are provided. */
  inject(deps: readonly string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
  readonly connection?: {
    readonly rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>,
        options: { readonly authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
  readonly webServer?: { readonly host?: string }
  readonly logger?: { info(message: string): void; warn(message: string): void }
  /** Reversible-effect registration owned by the Cordis lifecycle. */
  effect(fn: () => unknown, label?: string): unknown
}

/** Non-group roster rows shaped for the inventory assembler. */
function rosterRows(iterable: Iterable<LoaderEntry>): Array<{ entryId: string; moduleName: string; disabled: boolean }> {
  const rows: Array<{ entryId: string; moduleName: string; disabled: boolean }> = []
  for (const entry of iterable) {
    const options = entry.options as LoaderEntry['options']
    if (options.group !== undefined && options.group !== null && options.group !== false) continue
    rows.push({ entryId: entry.id, moduleName: options.name, disabled: entry.disabled })
  }
  return rows
}

/** The real Cordis plugin: required loader injection, dynamic connection. */
export default {
  inject: ['loader'],
  apply(ctx: PluginContext): void {
    const loaderContext = ctx.loader.ctx
    const baseUrl = loaderContext.baseUrl
    const entries = (): Iterable<LoaderEntry> => loaderContext.entries()
    const persistence = (): 'writable' | 'read-only' => {
      // Same stance as the official lifecycle surface: an all-interfaces
      // webserver bind serves read-only clients.
      return ctx.webServer?.host === '0.0.0.0' ? 'read-only' : 'writable'
    }
    const host: EngineHost = {
      entries,
      persistence,
    }
    const engine = new LifecycleEngine(baseUrl, host)
    const inventory = new InventoryAssembler(baseUrl)

    // Startup cleanup: settled pending removals are pruned idempotently.
    /* v8 ignore start -- the catch arm needs the lock creation itself to fail (e.g. a read-only profile directory), which Windows CI cannot stage reliably; POSIX CI covers it. */
    void engine.startupCleanup().catch(error => {
      ctx.logger?.warn(`dsh-plugin-manager: startup cleanup failed: ${String(error)}`)
    })
    /* v8 ignore stop */

    // The connection service may arrive after this plugin mounts: the
    // dynamic inject re-runs the registration whenever it (re)appears and
    // Cordis disposes the previous registration when it leaves.
    ctx.inject(['connection'], connectionCtx => {
      const rpc = (connectionCtx as PluginContext).connection?.rpc
      if (rpc === undefined) {
        connectionCtx.logger?.warn('dsh-plugin-manager: connection service present without an rpc surface; tab reports unavailable')
        return
      }
      const dispose = rpc.handle(
        MANAGER_CHANNEL,
        (endpoint, payload, signal) => managerHandler(engine, inventory, entries, endpoint, payload, signal),
        { authority: 'loopback' },
      )
      // rpc.handle() already owns its route through the CALLER's effect
      // lifecycle (the official implementation registers owner.effect
      // internally), so no second effect bridge is needed here.
      void dispose
      connectionCtx.logger?.info('dsh-plugin-manager: channel /dsh-plugin-manager registered (loopback)')
    })
  },
}

/**
 * One channel request: strict payload gate, endpoint dispatch, structured
 * errors. ManagerFailure codes pass through; anything else maps to INTERNAL
 * with a sanitized message. Read endpoints honor pre-flight abort; once
 * `execute` acknowledges an operation, later caller cancellation only stops
 * waiting — the transaction itself always runs to completion.
 */
async function managerHandler(
  engine: LifecycleEngine,
  inventory: InventoryAssembler,
  entries: () => Iterable<LoaderEntry>,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }> {
  try {
    // Size gate on the logical payload AFTER transport parsing, BEFORE zod
    // and engine. Counted in UTF-8 bytes, not UTF-16 code units.
    if (payload !== null && typeof payload === 'object') {
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized, 'utf8') > REQUEST_BODY_MAX_BYTES) {
        return { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'request payload exceeds the channel limit' } }
      }
    }
    if (!(MANAGER_ENDPOINTS as readonly string[]).includes(endpoint)) {
      return { ok: false, error: { code: 'ENDPOINT_UNKNOWN', message: `unknown endpoint ${endpoint.slice(0, 64)}` } }
    }
    const request = parseManagerRequest(endpoint as ManagerEndpoint, payload)
    if (!request.ok) {
      return { ok: false, error: { code: request.code, message: request.message } }
    }
    // Pre-flight abort for the read-only endpoints; execute deliberately
    // does not check after acknowledgement.
    if (signal.aborted && endpoint !== 'execute') {
      return { ok: false, error: { code: 'CANCELLED', message: 'the request was cancelled before dispatch' } }
    }
    switch (endpoint as ManagerEndpoint) {
      case 'capabilities': {
        const caps = engine.capabilities()
        const roster = inventory.list(rosterRows(entries()))
        return {
          ok: true,
          value: {
            protocolVersion: PROTOCOL_VERSION,
            revision: caps.revision,
            persistence: caps.persistence,
            entries: mergeEntries(roster.entries, caps.entries),
            diagnostics: roster.diagnostics,
          },
        }
      }
      case 'preview': {
        const value = engine.preview({
          entryId: request.value.entryId as string,
          action: request.value.action as 'disable' | 'enable' | 'uninstall',
          expectedRevision: request.value.expectedRevision as string,
        })
        return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } }
      }
      case 'execute': {
        // Acknowledgement point: once the token is consumed and the
        // operation queued, the result is delivered by `operation` polling
        // regardless of this call's later cancellation.
        const value = engine.execute({ token: request.value.token as string })
        return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } }
      }
      case 'operation': {
        const value = engine.operation({ operationId: request.value.operationId as string })
        return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } }
      }
    }
  } catch (error) {
    if (error instanceof ManagerFailure) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: false, error: { code: 'INTERNAL', message: 'the operation failed unexpectedly' } }
  }
}

/** Merge origin/card rows with lifecycle capabilities by entryId. */
function mergeEntries(
  originRows: readonly import('./host/protocol.ts').ManagerEntry[],
  capabilityRows: ReadonlyArray<{ entryId: string; canToggle: boolean; canUninstall: boolean; toggleBlockReason: string | null; uninstallBlockReason: string | null; packageName: string | null }>,
): Array<import('./host/protocol.ts').ManagerEntry & { canToggle: boolean; canUninstall: boolean; toggleBlockReason: string | null; uninstallBlockReason: string | null; packageName: string | null }> {
  const capabilityByEntry = new Map(capabilityRows.map(row => [row.entryId, row]))
  return originRows.map(row => ({
    ...row,
    /* v8 ignore next -- the fallback arm fires only when the roster and the engine evidence disagree mid-read (two independent reads of one mutating Loader); the engine's own queue serializes writes, so a test cannot stage the race deterministically. */
    ...(capabilityByEntry.get(row.entryId) ?? { canToggle: false, canUninstall: false, toggleBlockReason: null, uninstallBlockReason: null, packageName: null }),
  }))
}
