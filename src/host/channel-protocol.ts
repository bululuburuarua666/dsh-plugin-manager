/**
 * Wire contract for the /dsh-plugin-manager channel: request/response
 * schemas and payload guards shared by the Host handler and the Client
 * caller. Everything fail-closes: unknown fields, wrong versions, wrong
 * shapes, and oversize payloads are rejected before the engine runs.
 */
import { z } from 'zod'
import { PROTOCOL_VERSION } from './protocol.ts'

/** Maximum accepted request body size (bytes) before parsing. */
export const REQUEST_BODY_MAX_BYTES = 64 * 1024

/** The channel every RPC flows through, pinned to loopback authority. */
export const MANAGER_CHANNEL = '/dsh-plugin-manager'

/** The four endpoints this channel serves; nothing else is routed. */
export const MANAGER_ENDPOINTS = ['capabilities', 'preview', 'execute', 'operation'] as const
export type ManagerEndpoint = typeof MANAGER_ENDPOINTS[number]

/** Strict object schema factory: no unknown fields survive. */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

/** protocolVersion literal carried by every payload. */
const protocolVersion = z.literal(PROTOCOL_VERSION)

/** capabilities request: protocol version only. */
export const capabilitiesRequestSchema = strict({ protocolVersion })

/** preview request: intent plus the evidence revision the user saw. */
export const previewRequestSchema = strict({
  protocolVersion,
  entryId: z.string().min(1).max(256),
  action: z.enum(['disable', 'enable', 'uninstall']),
  expectedRevision: z.string().min(1).max(128),
})

/** execute request: the opaque one-use token, nothing else. */
export const executeRequestSchema = strict({
  protocolVersion,
  token: z.string().min(16).max(128),
})

/** operation request: the operation id to poll. */
export const operationRequestSchema = strict({
  protocolVersion,
  operationId: z.string().min(1).max(128),
})

/** Response envelope: ok value or structured error; unknown fields dropped client-side by schema. */
export const managerErrorSchema = strict({
  code: z.string().min(1).max(64),
  message: z.string().max(512).optional(),
})

/** Parse and validate one request payload for an endpoint. */
export function parseManagerRequest(
  endpoint: ManagerEndpoint,
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const schema
    = endpoint === 'capabilities' ? capabilitiesRequestSchema
      : endpoint === 'preview' ? previewRequestSchema
        : endpoint === 'execute' ? executeRequestSchema
          : operationRequestSchema
  const parsed = schema.safeParse(payload)
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> }
  const first = parsed.error.issues[0]
  /* v8 ignore next -- a failed zod parse always carries at least one issue; the empty arm is defensive. */
  const where = first === undefined ? '' : ` at ${first.path.join('.')}`
  return {
    ok: false,
    code: 'REQUEST_INVALID',
    message: `malformed ${endpoint} request${where}`,
  }
}
