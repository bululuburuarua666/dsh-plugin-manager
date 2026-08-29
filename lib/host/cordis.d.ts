/**
 * Structural ambient types for the Host Cordis surface this plugin consumes
 * (DeepSeek Harness 0.1.1-rc.2 public contracts). The runtime provides the
 * real implementations; these shapes keep the out-of-tree host half
 * self-contained without a monorepo checkout.
 */
/** Loader entry as consumed by the roster reader. */
export interface LoaderEntry {
    readonly id: string;
    readonly options: {
        readonly name: string;
        /** The row's own data id inside the composed entry list, when declared. */
        readonly id?: unknown;
        readonly group?: unknown;
    };
    readonly disabled: boolean;
    readonly fiber?: {
        readonly state: number;
    } | undefined;
    /** Present when the row is an include/tree carrier (a composition container). */
    readonly subtree?: unknown;
    /** Present when the row is a group carrier. */
    readonly subgroup?: unknown;
}
/** Loader context face. */
export interface LoaderContext {
    readonly baseUrl: string | undefined;
    entries(): Iterable<LoaderEntry>;
}
/** Host Context: the subset of the Cordis context this plugin touches. */
export interface HostContext {
    readonly loader: {
        readonly ctx: LoaderContext;
    };
    readonly connection?: {
        readonly rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, options: {
                readonly authority: 'loopback' | 'trusted-host';
            }): () => Promise<void>;
        };
    } | undefined;
    readonly logger?: {
        info(message: string): void;
        warn(message: string): void;
    };
}
//# sourceMappingURL=cordis.d.ts.map