/** Resolve and read a plugin package's inventory hover-card metadata. */
import type { PluginInventoryCard, PluginInventoryCardText } from './protocol.ts';
/** Which scanned node_modules root produced a package resolution. */
export type PluginResolutionRoot = 'profile' | 'engine' | 'unknown';
/** A resolved plugin package directory with its resolution provenance. */
export interface LocatedPluginPackage {
    readonly packageDir: string;
    readonly resolutionRoot: PluginResolutionRoot;
}
/** Inventory-relevant metadata of one resolved plugin package. */
export interface PluginPackageMeta {
    /** Resolution location, or null when the module did not resolve. */
    readonly located: LocatedPluginPackage | null;
    /** Real package.json `name`, or null when the manifest is unreadable. */
    readonly packageName: string | null;
    /** `fs.realpath` of the package directory, or null when unavailable. */
    readonly realPackageDir: string | null;
    readonly card: PluginInventoryCard;
    /** Raw `dsh.origin` manifest value, forwarded to the origin resolver. */
    readonly manifestOrigin: unknown;
    /** Raw `repository` URL declared by the package, when present. */
    readonly repositoryUrl: string | null;
}
/**
 * Normalize a standard `dsh.inventory` field. A string is shorthand for the
 * same copy in both languages; an object must provide non-empty `zh` and
 * `en` strings.
 * @param value - raw manifest value.
 * @returns normalized bilingual text, or null when the value is invalid.
 */
export declare function normalizeInventoryCardText(value: unknown): PluginInventoryCardText | null;
/**
 * Read the first prose paragraph of a README file. Heading, language-link,
 * and blank lines are skipped, matching the repository's one-line-paragraph
 * documentation convention.
 * @param path - absolute README path.
 * @returns the first paragraph capped at {@link README_FALLBACK_MAX}, or null.
 */
export declare function readReadmeFallback(path: string): string | null;
/**
 * Resolve a Loader module specifier to its package directory.
 * @param moduleName - entry module specifier.
 * @param baseUrl - Loader base URL anchoring profile-local resolution.
 * @returns package directory, or null for builtins/unresolvable specifiers.
 */
export declare function resolvePluginPackageDir(moduleName: string, baseUrl: string | undefined): string | null;
/**
 * Read a plugin package's inventory card from an already-resolved package
 * directory.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved card, never null.
 */
/**
 * Read a plugin package's full inventory metadata from an already-resolved
 * package directory: card fields plus the raw origin declaration, repository
 * URL, and package name consumed by the origin resolver.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved metadata; scalar fields are null on unreadable manifests.
 */
export declare function readPackageMetaFromDir(packageDir: string): Omit<PluginPackageMeta, 'located' | 'realPackageDir'>;
/**
 * Read a plugin package's inventory card from an already-resolved package
 * directory.
 * @param packageDir - absolute package root containing package.json.
 * @returns resolved card, never null.
 */
export declare function readCardFromPackageDir(packageDir: string): PluginInventoryCard;
/**
 * Read a plugin package's inventory card, resolving the module against the
 * Loader base URL. Kept for focused tests and one-shot callers; the gateway
 * uses {@link PluginInventoryCardReader}, which indexes and caches package
 * directories.
 * @param moduleName - entry module specifier.
 * @param baseUrl - Loader base URL for profile-local package resolution.
 * @returns resolved card, never null.
 */
export declare function readPluginInventoryCard(moduleName: string, baseUrl: string | undefined): PluginInventoryCard;
/**
 * Package-name segments used as the node_modules index key and as the
 * specifier/resolution/override lookup key in the gateway.
 * @param moduleName - entry module specifier.
 * @returns the package portion of the specifier.
 */
export declare function packageKeyOf(moduleName: string): string;
/**
 * Cached, indexed card reader used by the inventory gateway. It scans the
 * profile's `node_modules` roots once, so `list()` does not pay Node module
 * resolution for every configured entry.
 */
export declare class PluginInventoryCardReader {
    private readonly baseUrl;
    private readonly packageDirs;
    private readonly metas;
    constructor(baseUrl: string | undefined);
    /**
     * Read (and cache) one entry's card.
     * @param moduleName - entry module specifier.
     * @returns resolved card, never null.
     */
    read(moduleName: string): PluginInventoryCard;
    /**
     * Read (and cache) one entry's full package metadata. `cordis:` builtins
     * and unresolvable modules return an empty meta with a null location.
     * @param moduleName - entry module specifier.
     * @returns resolved metadata, never null.
     */
    readMeta(moduleName: string): PluginPackageMeta;
    /** Drop the cached metadata for one module after its Loader entry changes. */
    drop(moduleName: string): void;
    private readMetaUncached;
}
//# sourceMappingURL=card.d.ts.map