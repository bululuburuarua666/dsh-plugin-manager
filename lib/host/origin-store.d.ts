/**
 * Origin override store: safe writes to the profile's `plugin-origins.json`.
 * Every update runs the full cycle — cross-process file lock, in-lock
 * re-read, revision conflict check, strict schema validation, atomic write,
 * post-write verification — so two open pages or a manual editor can never
 * silently overwrite each other. A corrupt existing file is preserved
 * untouched and reported, never replaced by an empty configuration.
 *
 * Overrides are keyed by the stable package.json `name`, never by Loader
 * entry ids (those shift with include nesting).
 */
import { type PluginOriginOverrideEntry } from './origin.ts';
/** Revision reported for a missing override file (the fileDigest convention). */
export declare const ORIGIN_MISSING_REVISION = "-";
/** SHA-256 of one text: the origin override file's revision currency. */
export declare function originTextDigest(text: string): string;
/** Read-modify-write access to one profile's `plugin-origins.json`. */
export declare class OriginStore {
    private readonly profileDir;
    constructor(profileDir: string | null);
    /** The override file path; no profile directory means no override writes. */
    private originsPath;
    /** Current on-disk revision: the file digest, or '-' when absent. */
    revision(): string;
    /**
     * Set (`override`) or clear (`null`, restoring automatic detection) one
     * package's classification. `expectedRevision` must match the in-lock
     * re-read of the file — a stale value answers ORIGIN_CONFLICT and nothing
     * is written.
     */
    update(packageName: string, override: PluginOriginOverrideEntry | null, expectedRevision: string): Promise<{
        readonly revision: string;
    }>;
}
//# sourceMappingURL=origin-store.d.ts.map