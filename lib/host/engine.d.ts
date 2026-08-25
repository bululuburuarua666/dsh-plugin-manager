/**
 * Lifecycle engine: capabilities / preview / execute / operation over the
 * pure modules (token store, operation store, patch editor, evidence,
 * uninstall transaction). Ported from the upstream plugin-lifecycle service
 * with the Cordis shell removed — the host entry supplies the roster and the
 * file IO; the RPC channel (T04) and the UI (T05) consume this engine.
 */
import { PluginLifecycleTokenStore } from './token-store.ts';
import { PluginLifecycleOperationStore } from './operation-store.ts';
import { type PackageRunner } from './uninstall.ts';
import type { PluginLifecycleCapabilities, PluginLifecycleErrorCode, PluginLifecycleExecuteRequest, PluginLifecycleExecuteResponse, PluginLifecycleOperationRequest, PluginLifecycleOperationView, PluginLifecyclePersistence, PluginLifecyclePreview, PluginLifecyclePreviewRequest } from './engine-types.ts';
import type { LoaderEntry } from './cordis.ts';
export type * from './engine-types.ts';
/** Map a capability block reason to its wire error code. */
export declare function blockReasonToCode(reason: string): PluginLifecycleErrorCode;
/** Host-supplied runtime hooks the engine needs beyond pure functions. */
export interface EngineHost {
    /** Loader entries in Loader order (the authoritative roster). */
    entries(): Iterable<LoaderEntry>;
    /** The persistence mode of this deployment. */
    persistence(): PluginLifecyclePersistence;
    /** Override point for tests; defaults to the no-shell pnpm runner. */
    createPackageRunner?(): PackageRunner;
}
/** The lifecycle engine. All mutation intent flows preview → execute → poll. */
export declare class LifecycleEngine {
    private readonly loaderBaseUrl;
    private readonly host;
    /** One-use preview tokens binding action and evidence (bounded). */
    protected readonly tokens: PluginLifecycleTokenStore;
    /** Bounded operation ledger polled by the client. */
    protected readonly operations: PluginLifecycleOperationStore;
    /** In-process mutation serialization per profile directory. */
    private readonly mutexes;
    constructor(loaderBaseUrl: string | undefined, host: EngineHost);
    /** The no-shell package runner uninstalls delegate to. */
    protected createPackageRunner(): PackageRunner;
    /**
     * Startup cleanup: for each settled pending-removal record, remove its
     * managed rows and then the record. Ordering is fail-closed throughout:
     * the patch is re-read and re-parsed INSIDE the lock (an outside read
     * could overwrite concurrent user edits), the pending records are only
     * cleared after the patch write committed, and any parse or write failure
     * keeps the records so the next startup can retry idempotently.
     */
    startupCleanup(): Promise<void>;
    /** Capability snapshot of the active profile, rebuilt per call. */
    capabilities(): PluginLifecycleCapabilities;
    /** Begin a mutation intent: validate capability and issue a one-use token. */
    preview(request: PluginLifecyclePreviewRequest): PluginLifecyclePreview;
    /** Execute a previewed intent: single-use token, evidence re-validated. */
    execute(request: PluginLifecycleExecuteRequest): PluginLifecycleExecuteResponse;
    /** Poll one operation's state. */
    operation(request: PluginLifecycleOperationRequest): PluginLifecycleOperationView;
    /**
     * Serialize mutations per profile directory, regardless of outcome. The
     * thunk only starts when the previous queued operation settled, so no two
     * mutations on one profile can overlap; the queue entry is removed when it
     * is again the tail.
     */
    private enqueue;
    /** Effective Loader facts for every non-group entry. */
    private entryFacts;
    /** Assemble the current evidence bundle; the revision over all of it. */
    private evidence;
    /**
     * Run a disable/enable toggle: rewrite the managed block atomically under
     * the cross-process file lock, await the Loader's effective state, and on
     * failure restore the before image only while the file still matches this
     * operation's after-image.
     */
    private runToggle;
    /** Hash-guarded restore of a toggle's before image. */
    private restoreToggleImage;
    /** Drive one uninstall transaction through the uninstall module. */
    private runUninstall;
    /** The real filesystem boundary for uninstall transactions. */
    private fileIo;
    /** Wait until each id is disposed or gone; spliced ids may vanish entirely. */
    private awaitDisposal;
    /** Which of the given ids are still present in the Loader tree. */
    private presentEntryIds;
    /** Wait until the Loader's effective disabled state matches the target. */
    private awaitEffectiveState;
}
//# sourceMappingURL=engine.d.ts.map