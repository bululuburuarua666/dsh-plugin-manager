/**
 * Public contract of the plugin-lifecycle Remote. The renderer only ever
 * submits an `entryId` plus an `action`; every path, package spec, and
 * command decision is re-derived Host-side at execute time.
 */
/** Lifecycle actions the Remote supports. */
export type PluginLifecycleAction = 'disable' | 'enable' | 'uninstall';
/** Whether the active deployment accepts mutations from this client plane. */
export type PluginLifecyclePersistence = 'writable' | 'read-only';
/** Why a capability is denied, localized by the client. */
export type PluginLifecycleBlockReason = 'read-only-remote' | 'protected-plugin' | 'engine-owned' | 'template-bundle' | 'not-direct-dependency' | 'ambiguous-package' | 'manual-insert-unsupported';
/** Structured failure codes every mutation path may raise. */
export type PluginLifecycleErrorCode = 'READ_ONLY_REMOTE' | 'ENTRY_NOT_FOUND' | 'ENTRY_CHANGED' | 'BLOCKED_BY_ANCESTOR' | 'PROTECTED_PLUGIN' | 'NOT_DIRECT_DEPENDENCY' | 'AMBIGUOUS_PACKAGE' | 'PROFILE_CHANGED' | 'BUSY' | 'INVALID_PATCH' | 'MANAGED_BLOCK_INVALID' | 'UNSUPPORTED_PATCH_SHAPE' | 'PNPM_UNAVAILABLE' | 'PACKAGE_MANAGER_FAILED' | 'POSTCONDITION_FAILED' | 'TIMEOUT' | 'ROLLBACK_INCOMPLETE' | 'INTERNAL';
/** Per-entry capability row inside {@link PluginLifecycleCapabilities}. */
export interface PluginLifecycleEntryCapability {
    readonly entryId: string;
    /** Package the entry's module resolves to, when unambiguous. */
    readonly packageName: string | null;
    readonly canToggle: boolean;
    readonly canUninstall: boolean;
    readonly toggleBlockReason: PluginLifecycleBlockReason | null;
    readonly uninstallBlockReason: PluginLifecycleBlockReason | null;
}
/** Point-in-time capability snapshot of the active profile. */
export interface PluginLifecycleCapabilities {
    /** Evidence revision; `preview` rejects a mismatched `expectedRevision`. */
    readonly revision: string;
    readonly persistence: PluginLifecyclePersistence;
    readonly entries: readonly PluginLifecycleEntryCapability[];
}
/** Preview request: what the user intends, plus the evidence they saw. */
export interface PluginLifecyclePreviewRequest {
    readonly entryId: string;
    readonly action: PluginLifecycleAction;
    readonly expectedRevision: string;
}
/** A signed intent: one-use token binding action, entry, and evidence. */
export interface PluginLifecyclePreview {
    readonly token: string;
    readonly expiresAt: number;
    readonly action: PluginLifecycleAction;
    readonly entryId: string;
    readonly packageName: string | null;
    readonly affectedEntryIds: readonly string[];
    readonly restartRequired: boolean;
}
/** Execute request: the opaque preview token, nothing else. */
export interface PluginLifecycleExecuteRequest {
    readonly token: string;
}
/** Execute response: the started operation's id and immediate state. */
export interface PluginLifecycleExecuteResponse {
    readonly operationId: string;
    readonly state: PluginLifecycleOperationState;
}
/** Operation poll request. */
export interface PluginLifecycleOperationRequest {
    readonly operationId: string;
}
/** Operation lifecycle states; `rollback-required` is terminal. */
export type PluginLifecycleOperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rollback-required';
/** Pollable operation view; never carries paths, stdout, or stack traces. */
export interface PluginLifecycleOperationView {
    readonly operationId: string;
    readonly state: PluginLifecycleOperationState;
    readonly action: PluginLifecycleAction;
    readonly errorCode: PluginLifecycleErrorCode | null;
    readonly restartRequired: boolean;
}
//# sourceMappingURL=engine-types.d.ts.map