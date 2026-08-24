/**
 * Profile install-source reader: loads the profile's package.json dependency
 * specs and pnpm-lock.yaml importer resolutions at most once per `list()` and
 * caches them by file stamp. All failures degrade to empty sources with a
 * sanitized diagnostic; this reader never throws into the inventory path.
 */
import type { PluginOriginDiagnostic } from './protocol.ts';
/** Snapshot of a profile's direct install sources. */
export interface ProfileInstallSources {
    /** package.json dependency spec by package name. */
    readonly specifiers: ReadonlyMap<string, string>;
    /** pnpm-lock.yaml importer resolution by package name. */
    readonly resolutions: ReadonlyMap<string, string>;
    /** Diagnostics collected while reading; sanitized, path-free. */
    readonly diagnostics: readonly PluginOriginDiagnostic[];
}
/**
 * Cached reader of one profile directory's install sources. Both files are
 * re-read only when their stamp changes; the lockfile is optional (a profile
 * without one still contributes its package.json specifiers).
 */
export declare class ProfileInstallSourceReader {
    private readonly manifestPath;
    private readonly lockfilePath;
    private cached;
    /**
     * @param profileDir - absolute profile directory; null disables reading and
     *   yields empty sources forever (unit harnesses without a profile).
     */
    constructor(profileDir: string | null);
    /**
     * Read (and cache) the profile's install sources.
     * @returns current sources; never throws.
     */
    read(): ProfileInstallSources;
    /** Parse both manifests without consulting the cache. */
    private readUncached;
}
//# sourceMappingURL=install-source.d.ts.map