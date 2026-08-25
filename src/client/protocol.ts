/**
 * Client-side channel caller: typed wrappers over
 * `ctx.connection.rpc.call('/dsh-plugin-manager', endpoint, payload)`.
 * Every SUCCESS response is validated against a strict schema before it
 * reaches the UI — a wrong protocol version answers INCOMPATIBLE, a
 * malformed body answers PROTOCOL_INVALID, and neither is ever surfaced
 * as success. Transport failures (no channel, network drop, non-JSON)
 * surface as a distinct `UNAVAILABLE` family.
 */
import { z } from 'zod'
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

// ---------------------------------------------------------------------------
// Strict response schemas: unknown fields are stripped, wrong shapes reject.
// ---------------------------------------------------------------------------

const protocolVersionLiteral = z.literal(PROTOCOL_VERSION)

const originSchema = z.object({
  kind: z.enum(['official', 'personal', 'opensource']),
  customized: z.boolean(),
  upstream: z.string().nullable(),
  fork: z.string().nullable(),
  branch: z.string().nullable(),
  note: z.object({ zh: z.string(), en: z.string() }).nullable(),
  declaredBy: z.enum(['user-override', 'manifest', 'heuristic']),
})

const entrySchema = z.object({
  entryId: z.string(),
  moduleName: z.string(),
  enabled: z.boolean(),
  origin: originSchema,
  title: z.object({ zh: z.string(), en: z.string() }).nullable(),
  description: z.object({ zh: z.string(), en: z.string() }).nullable(),
  packageName: z.string().nullable(),
  canToggle: z.boolean(),
  canUninstall: z.boolean(),
  toggleBlockReason: z.string().nullable(),
  uninstallBlockReason: z.string().nullable(),
})

const capabilitiesSchema = z.object({
  protocolVersion: protocolVersionLiteral,
  revision: z.string().min(1),
  persistence: z.enum(['writable', 'read-only']),
  entries: z.array(entrySchema),
  diagnostics: z.array(z.object({ code: z.string(), packageName: z.string().nullable() })).optional(),
})

const previewSchema = z.object({
  protocolVersion: protocolVersionLiteral,
  token: z.string().min(16),
  expiresAt: z.number(),
  action: z.enum(['disable', 'enable', 'uninstall']),
  entryId: z.string(),
  packageName: z.string().nullable(),
  affectedEntryIds: z.array(z.string()),
  restartRequired: z.boolean(),
})

const executeSchema = z.object({
  protocolVersion: protocolVersionLiteral,
  operationId: z.string().min(1),
  state: z.enum(['queued', 'running']),
})

const operationSchema = z.object({
  protocolVersion: protocolVersionLiteral,
  operationId: z.string(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'rollback-required']),
  action: z.enum(['disable', 'enable', 'uninstall']),
  errorCode: z.string().nullable(),
  restartRequired: z.boolean(),
})

/** One manager endpoint call: transport → error envelope → strict response parse. */
async function call<T>(
  rpc: ChannelCaller,
  endpoint: string,
  payload: Record<string, unknown>,
  responseSchema: z.ZodType<T>,
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
  if (!response.ok) {
    return { ok: false, code: response.error?.code ?? 'INTERNAL', message: response.error?.message }
  }
  const raw = response.value as { protocolVersion?: number } | null | undefined
  if (raw !== null && typeof raw === 'object' && raw.protocolVersion !== undefined && raw.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: 'INCOMPATIBLE', message: `the Host speaks protocol ${String(raw.protocolVersion)}; this client speaks ${String(PROTOCOL_VERSION)}` }
  }
  const parsed = responseSchema.safeParse(response.value)
  if (!parsed.success) {
    return { ok: false, code: 'PROTOCOL_INVALID', message: `the ${endpoint} response does not match the protocol` }
  }
  return { ok: true, value: parsed.data }
}

/** capabilities: roster + origins + capabilities + revision. */
export function capabilities(rpc: ChannelCaller, signal?: AbortSignal): Promise<ClientResult<z.infer<typeof capabilitiesSchema>>> {
  return call(rpc, 'capabilities', {}, capabilitiesSchema, signal)
}

/** preview: validate intent, mint a one-use token. */
export function preview(
  rpc: ChannelCaller,
  request: { entryId: string; action: 'disable' | 'enable' | 'uninstall'; expectedRevision: string },
  signal?: AbortSignal,
): Promise<ClientResult<z.infer<typeof previewSchema>>> {
  return call(rpc, 'preview', request, previewSchema, signal)
}

/** execute: consume the token, start the operation. */
export function execute(rpc: ChannelCaller, token: string, signal?: AbortSignal): Promise<ClientResult<z.infer<typeof executeSchema>>> {
  return call(rpc, 'execute', { token }, executeSchema, signal)
}

/** operation: poll one operation's state. */
export function operation(rpc: ChannelCaller, operationId: string, signal?: AbortSignal): Promise<ClientResult<z.infer<typeof operationSchema>>> {
  return call(rpc, 'operation', { operationId }, operationSchema, signal)
}

// Client-side view types (schema-inferred, kept named for the UI).
export type ClientOrigin = z.infer<typeof originSchema>
export type ClientEntry = z.infer<typeof entrySchema>
export type ClientCapabilities = z.infer<typeof capabilitiesSchema>
export type ClientPreview = z.infer<typeof previewSchema>
export type ClientExecuteResponse = z.infer<typeof executeSchema>
export type ClientOperationView = z.infer<typeof operationSchema>
