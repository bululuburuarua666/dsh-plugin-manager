/**
 * Recoverable package-scoped uninstall transaction. Order of operations:
 * backup touched files → disable + splice the user patch under the file lock
 * → wait for fiber disposal → run the package manager (no shell) → verify the
 * postconditions → reconcile bundle membership → record pending restart state.
 * Every rollback is hash-guarded: third-party drift is never overwritten.
 */
import type { PluginLifecycleErrorCode } from './engine-types.ts';
/** Filesystem boundary the transaction uses; fully injectable in tests. */
export interface UninstallIo {
    readonly readText: (path: string) => string;
    readonly exists: (path: string) => boolean;
    readonly writeAtomic: (path: string, content: string) => Promise<void>;
    readonly removeFile: (path: string) => Promise<void>;
    readonly mkdir: (path: string) => Promise<void>;
    readonly digest: (path: string) => string;
}
/** The package-manager boundary; never the real pnpm inside tests. */
export interface PackageRunner {
    readonly remove: (packageName: string, cwd: string) => Promise<void>;
    readonly installFrozen: (cwd: string) => Promise<void>;
}
/** Transaction inputs assembled by the service from fresh evidence. */
export interface UninstallOptions {
    readonly operationId: string;
    readonly packageName: string;
    readonly profileDir: string;
    readonly profileName: string;
    readonly patchPath: string;
    readonly manifestPath: string;
    readonly lockfilePath: string;
    readonly workspacePolicyPath: string | null;
    readonly backupsRoot: string;
    readonly pendingPath: string;
    /** Affected entry ids (Loader tree ids), in Loader order. */
    readonly affectedEntryIds: readonly string[];
    /**
     * The same entries' patch-space data ids — the bare row `id`s managed rows
     * and splice results are keyed by. Must be positionally aligned with
     * {@link UninstallOptions.affectedEntryIds}.
     */
    readonly affectedDataIds: readonly string[];
    /** Module names those entries resolve from (manual-insert splice keys). */
    readonly moduleNames: readonly string[];
    readonly io: UninstallIo;
    readonly runner: PackageRunner;
    /** Wait until each id left the tree or reports disabled; throws structured failures. */
    readonly waitForDispose: (entryIds: readonly string[]) => Promise<void>;
    /** After the transaction: which ids are still present in the tree. */
    readonly probeEntryIds: (entryIds: readonly string[]) => readonly string[];
    /** Run one read-modify-write of the patch file under its cross-process lock. */
    readonly withPatchLock: <T>(operation: () => Promise<T>) => Promise<T>;
}
/** Outcome of the transaction. */
export type UninstallOutcome = {
    readonly ok: true;
    readonly splicedEntryIds: readonly string[];
    readonly survivingEntryIds: readonly string[];
} | {
    readonly ok: false;
    readonly code: PluginLifecycleErrorCode;
};
/** Pending-removal record persisted across restarts. */
export interface PendingRemovalRecord {
    readonly packageName: string;
    readonly entryIds: readonly string[];
    readonly operationId: string;
    readonly createdAt: number;
}
/**
 * Run the full uninstall transaction. All failures after the first mutation
 * roll back through hash-guarded restores; drift downgrades the outcome to
 * ROLLBACK_INCOMPLETE instead of overwriting another writer's work.
 */
export declare function runUninstallTransaction(options: UninstallOptions): Promise<UninstallOutcome>;
/** Whether the lockfile's profile importer still declares a dependency. */
export declare function lockImporterHas(lockfileText: string, packageName: string): boolean;
/** Read the profile's pending-removals records; tolerant of a missing file. */
export declare function readPendingRemovals(io: UninstallIo, pendingPath: string): readonly PendingRemovalRecord[];
/** Drop pending records whose package and entries are both gone. */
export declare function clearSettledPendingRemovals(io: UninstallIo, pendingPath: string, predicate: (record: PendingRemovalRecord) => boolean): Promise<void>;
//# sourceMappingURL=uninstall.d.ts.map