/** Structured business failures carried through the manager RPC channel. */
import type { PluginLifecycleErrorCode } from './engine-types.ts';
/**
 * Raise a structured manager failure. The channel handler unwraps `code`
 * into the RPC error envelope; `message` must stay sanitized and path-free.
 */
export declare class ManagerFailure extends Error {
    readonly code: PluginLifecycleErrorCode;
    readonly details: Record<string, never>;
    constructor(code: PluginLifecycleErrorCode, message: string);
}
/** Convenience constructor matching the upstream lifecycleFailure shape. */
export declare function managerFailure(code: PluginLifecycleErrorCode, message: string): ManagerFailure;
/** Back-compat alias used by the ported engine modules. */
export declare const lifecycleFailure: typeof managerFailure;
export type ManagerErrorCode = PluginLifecycleErrorCode;
//# sourceMappingURL=failure.d.ts.map