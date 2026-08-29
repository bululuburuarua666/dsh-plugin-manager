/**
 * Wire contract for the /dsh-plugin-manager channel: request/response
 * schemas and payload guards shared by the Host handler and the Client
 * caller. Everything fail-closes: unknown fields, wrong versions, wrong
 * shapes, and oversize payloads are rejected before the engine runs.
 */
import { z } from 'zod';
/** Maximum accepted request body size (bytes) before parsing. */
export declare const REQUEST_BODY_MAX_BYTES: number;
/** The channel every RPC flows through, pinned to loopback authority. */
export declare const MANAGER_CHANNEL = "/dsh-plugin-manager";
/** The six endpoints this channel serves; nothing else is routed. */
export declare const MANAGER_ENDPOINTS: readonly ["capabilities", "preview", "execute", "operation", "originState", "originUpdate"];
export type ManagerEndpoint = typeof MANAGER_ENDPOINTS[number];
/** capabilities request: protocol version only. */
export declare const capabilitiesRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
/** preview request: intent plus the evidence revision the user saw. */
export declare const previewRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    entryId: z.ZodString;
    action: z.ZodEnum<{
        disable: "disable";
        enable: "enable";
        uninstall: "uninstall";
    }>;
    expectedRevision: z.ZodString;
}, z.core.$strict>;
/** execute request: the opaque one-use token, nothing else. */
export declare const executeRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    token: z.ZodString;
}, z.core.$strict>;
/** operation request: the operation id to poll. */
export declare const operationRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    operationId: z.ZodString;
}, z.core.$strict>;
/** originState request: the entry whose origin layers to describe. */
export declare const originStateRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    entryId: z.ZodString;
}, z.core.$strict>;
/**
 * Wire shape of one origin override entry: the `plugin-origins.json` entry
 * schema, strict (unknown fields reject). An explicit `null` on an optional
 * field clears the inherited value during the merge.
 */
export declare const originOverrideWireSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        official: "official";
        personal: "personal";
        opensource: "opensource";
    }>;
    customized: z.ZodOptional<z.ZodBoolean>;
    upstream: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    fork: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    note: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        zh: z.ZodString;
        en: z.ZodString;
    }, z.core.$strict>]>>>;
}, z.core.$strict>;
/**
 * originUpdate request: set (`override`) or clear (`null` → restore
 * automatic detection) the classification of the entry's package. The
 * revision binds the write to the file state the user saw.
 */
export declare const originUpdateRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    entryId: z.ZodString;
    expectedOriginRevision: z.ZodString;
    override: z.ZodNullable<z.ZodObject<{
        kind: z.ZodEnum<{
            official: "official";
            personal: "personal";
            opensource: "opensource";
        }>;
        customized: z.ZodOptional<z.ZodBoolean>;
        upstream: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        fork: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        note: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            zh: z.ZodString;
            en: z.ZodString;
        }, z.core.$strict>]>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Response envelope: ok value or structured error; unknown fields dropped client-side by schema. */
export declare const managerErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Parse and validate one request payload for an endpoint. */
export declare function parseManagerRequest(endpoint: ManagerEndpoint, payload: unknown): {
    ok: true;
    value: Record<string, unknown>;
} | {
    ok: false;
    code: string;
    message: string;
};
//# sourceMappingURL=channel-protocol.d.ts.map