/**
 * Wire contract for the /dsh-plugin-manager channel: request/response
 * schemas and payload guards shared by the Host handler and the Client
 * caller. Everything fail-closes: unknown fields, wrong versions, wrong
 * shapes, and oversize payloads are rejected before the engine runs.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from "./protocol.js";
/** Maximum accepted request body size (bytes) before parsing. */
export const REQUEST_BODY_MAX_BYTES = 64 * 1024;
/** The channel every RPC flows through, pinned to loopback authority. */
export const MANAGER_CHANNEL = '/dsh-plugin-manager';
/** The six endpoints this channel serves; nothing else is routed. */
export const MANAGER_ENDPOINTS = ['capabilities', 'preview', 'execute', 'operation', 'originState', 'originUpdate'];
/** Strict object schema factory: no unknown fields survive. */
const strict = (shape) => z.object(shape).strict();
/** protocolVersion literal carried by every payload. */
const protocolVersion = z.literal(PROTOCOL_VERSION);
/** capabilities request: protocol version only. */
export const capabilitiesRequestSchema = strict({ protocolVersion });
/** preview request: intent plus the evidence revision the user saw. */
export const previewRequestSchema = strict({
    protocolVersion,
    entryId: z.string().min(1).max(256),
    action: z.enum(['disable', 'enable', 'uninstall']),
    expectedRevision: z.string().min(1).max(128),
});
/** execute request: the opaque one-use token, nothing else. */
export const executeRequestSchema = strict({
    protocolVersion,
    token: z.string().min(16).max(128),
});
/** operation request: the operation id to poll. */
export const operationRequestSchema = strict({
    protocolVersion,
    operationId: z.string().min(1).max(128),
});
/** originState request: the entry whose origin layers to describe. */
export const originStateRequestSchema = strict({
    protocolVersion,
    entryId: z.string().min(1).max(256),
});
/**
 * Wire shape of one origin override entry: the `plugin-origins.json` entry
 * schema, strict (unknown fields reject). An explicit `null` on an optional
 * field clears the inherited value during the merge.
 */
export const originOverrideWireSchema = strict({
    kind: z.enum(['official', 'personal', 'opensource']),
    customized: z.boolean().optional(),
    upstream: z.string().max(2_048).nullish(),
    fork: z.string().max(2_048).nullish(),
    branch: z.string().max(200).nullish(),
    note: z.union([
        z.string().max(1_000),
        strict({ zh: z.string().max(1_000), en: z.string().max(1_000) }),
    ]).nullish(),
});
/**
 * originUpdate request: set (`override`) or clear (`null` → restore
 * automatic detection) the classification of the entry's package. The
 * revision binds the write to the file state the user saw.
 */
export const originUpdateRequestSchema = strict({
    protocolVersion,
    entryId: z.string().min(1).max(256),
    expectedOriginRevision: z.string().min(1).max(128),
    override: originOverrideWireSchema.nullable(),
});
/** Response envelope: ok value or structured error; unknown fields dropped client-side by schema. */
export const managerErrorSchema = strict({
    code: z.string().min(1).max(64),
    message: z.string().max(512).optional(),
});
/** Parse and validate one request payload for an endpoint. */
export function parseManagerRequest(endpoint, payload) {
    const schema = endpoint === 'capabilities' ? capabilitiesRequestSchema
        : endpoint === 'preview' ? previewRequestSchema
            : endpoint === 'execute' ? executeRequestSchema
                : endpoint === 'operation' ? operationRequestSchema
                    : endpoint === 'originState' ? originStateRequestSchema
                        : originUpdateRequestSchema;
    const parsed = schema.safeParse(payload);
    if (parsed.success)
        return { ok: true, value: parsed.data };
    const first = parsed.error.issues[0];
    /* v8 ignore next -- a failed zod parse always carries at least one issue; the empty arm is defensive. */
    const where = first === undefined ? '' : ` at ${first.path.join('.')}`;
    return {
        ok: false,
        code: 'REQUEST_INVALID',
        message: `malformed ${endpoint} request${where}`,
    };
}
//# sourceMappingURL=channel-protocol.js.map