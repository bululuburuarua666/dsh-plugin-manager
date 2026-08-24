/**
 * Client-side channel caller: typed wrappers over
 * `ctx.connection.rpc.call('/dsh-plugin-manager', endpoint, payload)`.
 * Transport failures (no channel, network drop, non-JSON) surface as a
 * distinct `UNAVAILABLE` family; domain failures pass the engine's codes
 * through untouched.
 */
import { MANAGER_CHANNEL } from '../host/channel-protocol.ts'
import { PROTOCOL_VERSION } from '../host/protocol.ts'

/** Result envelope mirrored on the wire. */
export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message?: string }

/** The rpc.call face this client needs (structural, self-contained). */
export interface ChannelCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>
}

/** One manager endpoint call with the protocol version stamped on. */
async function call<T>(
  rpc: ChannelCaller,
  endpoint: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ClientResult<T>> {
  let response: { ok: boolean; value?: unknown; error?: { code: string; message?: string } }
  try {
    response = await rpc.call(MANAGER_CHANNEL, endpoint, { protocolVersion: PROTOCOL_VERSION, ...payload }, signal)
  } catch (error) {
    // Transport-level failure: the channel is absent, the Host predates the
    // Connection RPC surface, or the connection dropped mid-call.
    return { ok: false, code: 'UNAVAILABLE', message: error instanceof Error ? error.message.slice(0, 200) : 'transport failed' }
  }
  if (response.ok) return { ok: true, value: response.value as T }
  return { ok: false, code: response.error?.code ?? 'INTERNAL', message: response.error?.message }
}

/** capabilities: roster + origins + capabilities + revision. */
export function capabilities(rpc: ChannelCaller, signal?: AbortSignal): Promise<ClientResult<ClientCapabilities>> {
  return call<ClientCapabilities>(rpc, 'capabilities', {}, signal)
}

/** preview: validate intent, mint a one-use token. */
export function preview(
  rpc: ChannelCaller,
  request: { entryId: string; action: 'disable' | 'enable' | 'uninstall'; expectedRevision: string },
  signal?: AbortSignal,
): Promise<ClientResult<ClientPreview>> {
  return call<ClientPreview>(rpc, 'preview', request, signal)
}

/** execute: consume the token, start the operation. */
export function execute(rpc: ChannelCaller, token: string, signal?: AbortSignal): Promise<ClientResult<ClientExecuteResponse>> {
  return call<ClientExecuteResponse>(rpc, 'execute', { token }, signal)
}

/** operation: poll one operation's state. */
export function operation(rpc: ChannelCaller, operationId: string, signal?: AbortSignal): Promise<ClientResult<ClientOperationView>> {
  return call<ClientOperationView>(rpc, 'operation', { operationId }, signal)
}

// ---------------------------------------------------------------------------
// Client-side response views (subset the UI consumes)
// ---------------------------------------------------------------------------

export interface ClientOrigin {
  readonly kind: 'official' | 'personal' | 'opensource'
  readonly customized: boolean
  readonly upstream: string | null
  readonly fork: string | null
  readonly branch: string | null
  readonly note: { zh: string; en: string } | null
  readonly declaredBy: 'user-override' | 'manifest' | 'heuristic'
}

export interface ClientEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly origin: ClientOrigin
  readonly title: { zh: string; en: string } | null
  readonly description: { zh: string; en: string } | null
  readonly packageName: string | null
  readonly canToggle: boolean
  readonly canUninstall: boolean
  readonly toggleBlockReason: string | null
  readonly uninstallBlockReason: string | null
}

export interface ClientCapabilities {
  readonly protocolVersion: number
  readonly revision: string
  readonly persistence: 'writable' | 'read-only'
  readonly entries: readonly ClientEntry[]
  readonly diagnostics?: ReadonlyArray<{ code: string; packageName: string | null }>
}

export interface ClientPreview {
  readonly protocolVersion: number
  readonly token: string
  readonly expiresAt: number
  readonly action: 'disable' | 'enable' | 'uninstall'
  readonly entryId: string
  readonly packageName: string | null
  readonly affectedEntryIds: readonly string[]
  readonly restartRequired: boolean
}

export interface ClientExecuteResponse {
  readonly protocolVersion: number
  readonly operationId: string
  readonly state: 'queued' | 'running'
}

export interface ClientOperationView {
  readonly protocolVersion: number
  readonly operationId: string
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rollback-required'
  readonly action: 'disable' | 'enable' | 'uninstall'
  readonly errorCode: string | null
  readonly restartRequired: boolean
}
