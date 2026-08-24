/** Bounded one-use preview token store with injectable clock and randomness. */
import type { PluginLifecycleAction } from './engine-types.ts';
/** Evidence a preview token binds: execute revalidates every field. */
export interface PluginLifecycleTokenBinding {
    readonly action: PluginLifecycleAction;
    readonly entryId: string;
    readonly packageName: string | null;
    readonly affectedEntryIds: readonly string[];
    readonly restartRequired: boolean;
    /** Evidence revision the preview was computed against. */
    readonly revision: string;
}
/** One issued token record. */
export interface PluginLifecycleToken extends PluginLifecycleTokenBinding {
    readonly token: string;
    readonly expiresAt: number;
}
/** Injectable dependencies for deterministic tests. */
export interface PluginLifecycleTokenStoreDeps {
    readonly now?: () => number;
    readonly randomHex?: (bytes: number) => string;
    readonly capacity?: number;
    readonly ttlMs?: number;
}
/**
 * CSPRNG one-use token store. Tokens expire after `ttlMs`; `consume` deletes
 * on first read regardless of validity, so a token can never be replayed.
 * Eviction is FIFO by issue order once the bound is exceeded.
 */
export declare class PluginLifecycleTokenStore {
    private readonly now;
    private readonly randomHex;
    private readonly capacity;
    private readonly ttlMs;
    private readonly tokens;
    constructor(deps?: PluginLifecycleTokenStoreDeps);
    /**
     * Issue a token binding the given evidence.
     * @param binding - action and evidence the token commits to.
     * @returns the token id and its expiry.
     */
    issue(binding: PluginLifecycleTokenBinding): {
        token: string;
        expiresAt: number;
    };
    /**
     * Consume a token: the record is deleted on first read and returned only
     * when still unexpired.
     * @param token - the opaque token id.
     * @returns the bound evidence, or null when unknown or expired.
     */
    consume(token: string): PluginLifecycleToken | null;
    /** Drop expired tokens. */
    private sweepExpired;
}
//# sourceMappingURL=token-store.d.ts.map