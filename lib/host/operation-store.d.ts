/** Bounded operation ledger for lifecycle mutations. */
import type { PluginLifecycleAction, PluginLifecycleErrorCode, PluginLifecycleOperationState, PluginLifecycleOperationView } from './engine-types.ts';
/** Injectable dependencies for deterministic tests. */
export interface PluginLifecycleOperationStoreDeps {
    readonly randomHex?: (bytes: number) => string;
    readonly capacity?: number;
}
/**
 * Bounded FIFO operation ledger. Operations are created in `queued` state and
 * transition through `running` to a terminal state; the store keeps at most
 * `capacity` records so long sessions cannot grow it without bound.
 */
export declare class PluginLifecycleOperationStore {
    private readonly randomHex;
    private readonly capacity;
    private readonly records;
    constructor(deps?: PluginLifecycleOperationStoreDeps);
    /**
     * Create a queued operation.
     * @param action - the lifecycle action being run.
     * @returns the new operation id.
     */
    create(action: PluginLifecycleAction): string;
    /**
     * Transition one operation.
     * @param operationId - target operation.
     * @param update - fields to merge.
     */
    update(operationId: string, update: {
        readonly state?: PluginLifecycleOperationState;
        readonly errorCode?: PluginLifecycleErrorCode | null;
        readonly restartRequired?: boolean;
    }): void;
    /**
     * Read one operation's public view.
     * @param operationId - target operation.
     * @returns the view, or null for an unknown or evicted id.
     */
    get(operationId: string): PluginLifecycleOperationView | null;
}
//# sourceMappingURL=operation-store.d.ts.map