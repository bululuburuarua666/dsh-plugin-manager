/**
 * Host half: mounts the manager over the official Connection RPC extension
 * surface. Registers the single `/dsh-plugin-manager` channel with loopback
 * authority (the Host trust fence executes before any handler code), wires
 * its four endpoints to the lifecycle engine plus the inventory assembler,
 * and runs the startup pending-removals cleanup.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import type { HostContext, LoaderEntry } from './host/cordis.ts'
import type { ManagerEntry } from './host/protocol.ts'

export { MANAGER_CHANNEL, MANAGER_ENDPOINTS, PROTOCOL_VERSION }
export type { ManagerEndpoint }

/** Locate this package's own install-tree root (walk up to our package.json). */
function managerTreeRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
      if (manifest.name === '@bululuburuarua666/dsh-plugin-manager') {
        return dirname(dirname(realpathSync(dir)))
      }
    } catch {
      // Keep walking towards the filesystem root.
    }
    const parent = dirname(dir)
    /* v8 ignore next -- reaching the filesystem root means this package is uninstalled; a test cannot fabricate that state. */
    if (parent === dir) return null
    dir = parent
  }
}

export default {
  apply(ctx: HostContext): void {
    const loaderContext = ctx.loader?.ctx
    const baseUrl = loaderContext?.baseUrl
    const entries = (): Iterable<LoaderEntry> => loaderContext?.entries() ?? []
    const persistence = (): 'writable' | 'read-only' => {
      // Same stance as the official lifecycle surface: an all-interfaces
      // webserver bind serves read-only clients.
      const webServer = (ctx as HostContext & { webServer?: { host?: string } }).webServer
      return webServer?.host === '0.0.0.0' ? 'read-only' : 'writable'
    }
    const host: EngineHost = {
      entries,
      persistence,
      engineTreeRoot: managerTreeRoot(),
    }
    const engine = new LifecycleEngine(baseUrl, host)
    const inventory = new InventoryAssembler(baseUrl)

    // Startup cleanup: settled pending removals are pruned idempotently.
    /* v8 ignore start -- the catch arm needs the lock creation itself to fail (e.g. a read-only profile directory), which Windows CI cannot stage reliably; POSIX CI covers it. */
    void engine.startupCleanup().catch(error => {
      ctx.logger?.warn(`dsh-plugin-manager: startup cleanup failed: ${String(error)}`)
    })
    /* v8 ignore stop */

    // The channel only exists when the official Connection RPC surface does.
    const rpc = ctx.connection?.rpc
    if (rpc === undefined) {
      ctx.logger?.warn('dsh-plugin-manager: no Connection RPC surface on this Host; the tab will report unavailable')
      return
    }

    const dispose = rpc.handle(
      MANAGER_CHANNEL,
      (endpoint, payload, signal) => managerHandler(engine, inventory, entries, endpoint, payload, signal),
      { authority: 'loopback' },
    )
    // Register a disposal bridge on the plugin context if it offers effects.
    const effectCtx = ctx as HostContext & { effect?: (fn: () => unknown, label?: string) => unknown }
    if (typeof effectCtx.effect === 'function') {
      effectCtx.effect(() => dispose, 'dsh-plugin-manager: rpc channel')
    }
    ctx.logger?.info('dsh-plugin-manager: channel /dsh-plugin-manager registered (loopback)')
  },
}

/**
 * One channel request: strict payload gate, endpoint dispatch, structured
 * errors. ManagerFailure codes pass through; anything else maps to INTERNAL
 * with a sanitized message.
 */
async function managerHandler(
  engine: LifecycleEngine,
  inventory: InventoryAssembler,
  entries: () => Iterable<LoaderEntry>,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }> {
  void signal
  try {
    if (payload !== null && typeof payload === 'object' && JSON.stringify(payload).length > REQUEST_BODY_MAX_BYTES) {
      return { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'request payload exceeds the channel limit' } }
    }
    if (!(MANAGER_ENDPOINTS as readonly string[]).includes(endpoint)) {
      return { ok: false, error: { code: 'ENDPOINT_UNKNOWN', message: `unknown endpoint ${endpoint.slice(0, 64)}` } }
    }
    const request = parseManagerRequest(endpoint as ManagerEndpoint, payload)
    if (!request.ok) {
      return { ok: false, error: { code: request.code, message: request.message } }
    }
    switch (endpoint as ManagerEndpoint) {
      case 'capabilities': {
        const caps = engine.capabilities()
        const roster = inventory.list([...rosterRows(entries())])
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

/** Merge origin/card rows with lifecycle capabilities by entryId. */
function mergeEntries(
  originRows: readonly ManagerEntry[],
  capabilityRows: ReadonlyArray<{ entryId: string; canToggle: boolean; canUninstall: boolean; toggleBlockReason: string | null; uninstallBlockReason: string | null; packageName: string | null }>,
): Array<ManagerEntry & { canToggle: boolean; canUninstall: boolean; toggleBlockReason: string | null; uninstallBlockReason: string | null; packageName: string | null }> {
  const capabilityByEntry = new Map(capabilityRows.map(row => [row.entryId, row]))
  return originRows.map(row => ({
    ...row,
    /* v8 ignore next -- the fallback arm fires only when the roster and the engine evidence disagree mid-read (two independent reads of one mutating Loader); the engine's own queue serializes writes, so a test cannot stage the race deterministically. */
    ...(capabilityByEntry.get(row.entryId) ?? { canToggle: false, canUninstall: false, toggleBlockReason: null, uninstallBlockReason: null, packageName: null }),
  }))
}
