/**
 * Client-side channel caller: typed wrappers over
 * `ctx.connection.rpc.call('/dsh-plugin-manager', endpoint, payload)`.
 * Every SUCCESS response is validated against a strict schema before it
 * reaches the UI — a wrong protocol version answers INCOMPATIBLE, a
 * malformed body answers PROTOCOL_INVALID, and neither is ever surfaced
 * as success. Transport failures (no channel, network drop, non-JSON)
 * surface as a distinct `UNAVAILABLE` family.
 */
import { z } from 'zod';
import { MANAGER_CHANNEL } from '../host/channel-protocol.ts';
import { PROTOCOL_VERSION } from '../host/protocol.ts';
// ---------------------------------------------------------------------------
// Strict wire contract: the OUTER envelope and each endpoint's SUCCESS value
// are strict schemas — unknown fields and malformed shapes reject with
// PROTOCOL_INVALID instead of being silently stripped.
// ---------------------------------------------------------------------------
const protocolVersionLiteral = z.literal(PROTOCOL_VERSION);
/** Outer wire envelope: exactly one of success-with-value or error-with-code. */
const wireResponseSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        ok: z.literal(true),
        value: z.unknown(),
    }),
    z.strictObject({
        ok: z.literal(false),
        error: z.strictObject({
            code: z.string(),
            message: z.string().optional(),
        }),
    }),
]);
const originSchema = z.strictObject({
    kind: z.enum(['official', 'personal', 'opensource']),
    customized: z.boolean(),
    upstream: z.string().nullable(),
    fork: z.string().nullable(),
    branch: z.string().nullable(),
    note: z.strictObject({ zh: z.string(), en: z.string() }).nullable(),
    declaredBy: z.enum(['user-override', 'manifest', 'heuristic']),
});
const entrySchema = z.strictObject({
    entryId: z.string(),
    moduleName: z.string(),
    enabled: z.boolean(),
    origin: originSchema,
    title: z.strictObject({ zh: z.string(), en: z.string() }).nullable(),
    description: z.strictObject({ zh: z.string(), en: z.string() }).nullable(),
    packageName: z.string().nullable(),
    canToggle: z.boolean(),
    canUninstall: z.boolean(),
    toggleBlockReason: z.string().nullable(),
    uninstallBlockReason: z.string().nullable(),
});
const capabilitiesSchema = z.strictObject({
    protocolVersion: protocolVersionLiteral,
    revision: z.string().min(1),
    persistence: z.enum(['writable', 'read-only']),
    entries: z.array(entrySchema),
    diagnostics: z.array(z.strictObject({ code: z.string(), packageName: z.string().nullable() })).optional(),
});
const previewSchema = z.strictObject({
    protocolVersion: protocolVersionLiteral,
    token: z.string().min(16),
    expiresAt: z.number(),
    action: z.enum(['disable', 'enable', 'uninstall']),
    entryId: z.string(),
    packageName: z.string().nullable(),
    affectedEntryIds: z.array(z.string()),
    restartRequired: z.boolean(),
});
const executeSchema = z.strictObject({
    protocolVersion: protocolVersionLiteral,
    operationId: z.string().min(1),
    state: z.enum(['queued', 'running']),
});
const operationSchema = z.strictObject({
    protocolVersion: protocolVersionLiteral,
    operationId: z.string(),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'rollback-required']),
    action: z.enum(['disable', 'enable', 'uninstall']),
    errorCode: z.string().nullable(),
    restartRequired: z.boolean(),
});
/** One manager endpoint call: transport → strict envelope → strict value parse. */
async function call(rpc, endpoint, payload, responseSchema, signal) {
    let transportResult;
    try {
        transportResult = await rpc.call(MANAGER_CHANNEL, endpoint, { protocolVersion: PROTOCOL_VERSION, ...payload }, signal);
    }
    catch (error) {
        // Transport-level failure: the channel is absent, the Host predates the
        // Connection RPC surface, or the connection dropped mid-call.
        return { ok: false, code: 'UNAVAILABLE', message: error instanceof Error ? error.message.slice(0, 200) : 'transport failed' };
    }
    // The outer envelope must be exactly {ok:true,value} or {ok:false,error}:
    // null, primitives, missing fields, or unknown fields are all malformed.
    const envelope = wireResponseSchema.safeParse(transportResult);
    if (!envelope.success) {
        return { ok: false, code: 'PROTOCOL_INVALID', message: `the ${endpoint} response envelope is malformed` };
    }
    const response = envelope.data;
    if (!response.ok) {
        return { ok: false, code: response.error.code, message: response.error.message };
    }
    const raw = response.value;
    if (raw !== null && typeof raw === 'object' && raw.protocolVersion !== undefined && raw.protocolVersion !== PROTOCOL_VERSION) {
        return { ok: false, code: 'INCOMPATIBLE', message: `the Host speaks protocol ${String(raw.protocolVersion)}; this client speaks ${String(PROTOCOL_VERSION)}` };
    }
    const parsed = responseSchema.safeParse(response.value);
    if (!parsed.success) {
        return { ok: false, code: 'PROTOCOL_INVALID', message: `the ${endpoint} response does not match the protocol` };
    }
    return { ok: true, value: parsed.data };
}
/** capabilities: roster + origins + capabilities + revision. */
export function capabilities(rpc, signal) {
    return call(rpc, 'capabilities', {}, capabilitiesSchema, signal);
}
/** preview: validate intent, mint a one-use token. */
export function preview(rpc, request, signal) {
    return call(rpc, 'preview', request, previewSchema, signal);
}
/** execute: consume the token, start the operation. */
export function execute(rpc, token, signal) {
    return call(rpc, 'execute', { token }, executeSchema, signal);
}
/** operation: poll one operation's state. */
export function operation(rpc, operationId, signal) {
    return call(rpc, 'operation', { operationId }, operationSchema, signal);
}
