/**
 * Profile evidence assembly and capability decisions. Everything here is
 * computed fresh per call from the Loader and the profile's files — this
 * service deliberately owns no long-lived lifecycle state.
 */
import type { PluginLifecycleEntryCapability } from './engine-types.ts';
/** Packages that may never be uninstalled through this surface. */
export declare const PROTECTED_PACKAGES: readonly string[];
/**
 * Root-space row ids whose toggling would break the machinery this surface
 * depends on: the HMR fallback the upstream launcher mounts after boot, its
 * timer dependency, and the manager's own row.
 */
export declare const PROTECTED_TOGGLE_ENTRY_IDS: readonly string[];
/** Loader-entry facts the evidence layer consumes. */
export interface LifecycleEntryFacts {
    readonly entryId: string;
    readonly moduleName: string;
    /** Effective disabled state, including disabled ancestor groups. */
    readonly disabled: boolean;
    /** The entry's own (not ancestor-inherited) disabled flag. */
    readonly ownDisabled: boolean;
    /**
     * The PATCH-space data id this entry is addressed by inside the profile's
     * user patch layer — the bare composed row `id`. Null when the entry lives
     * outside the root include's patch space (a nested subtree, e.g. an agent
     * preset realm, or a loader-root-level row), meaning no id-targeted patch
     * can reach it.
     */
    readonly patchTargetId: string | null;
}
/** A profile manifest's dependency and bundle-membership view. */
export interface ProfileManifestView {
    readonly dependencies: ReadonlySet<string>;
    readonly bundles: readonly string[];
}
/** Read the profile package.json's dependency keys and bundle list. */
export declare function readProfileManifestView(manifestPath: string): ProfileManifestView;
/** Package-name portion of a Loader module specifier. */
export declare function packageKeyOf(moduleName: string): string;
/** Resolve a package's directory from the profile anchor; null when absent. */
export declare function resolvePackageDir(profileDir: string, packageName: string): string | null;
/** Best-effort realpath; null when the path cannot resolve. */
export declare function realpathOrNull(path: string): string | null;
/** Separator-insensitive containment check (case-insensitive on Windows). */
export declare function isPathInside(candidate: string, root: string): boolean;
/** Module names owned by manual insert rows inside the user patch text. */
export declare function manualInsertNames(patchText: string): ReadonlySet<string>;
/** Per-entry evidence record feeding capability decisions. */
export interface LifecycleEntryEvidence {
    readonly entryId: string;
    readonly moduleName: string;
    readonly disabled: boolean;
    readonly ownDisabled: boolean;
    /** PATCH-space data id, or null outside the root include's patch space. */
    readonly patchTargetId: string | null;
    readonly packageName: string | null;
    readonly isDirectDependency: boolean;
    readonly isBundleMember: boolean;
    readonly isTemplateBundle: boolean;
    readonly insideEngineTree: boolean;
    /** Package resolved from a TRUSTED root (indexed profile/engine hit). */
    readonly isResolvable: boolean;
    readonly isProtected: boolean;
    readonly isManualInsert: boolean;
}
/** Shared per-call resolution caches so 150+ entries don't each re-resolve. */
export interface EvidenceSession {
    readonly profileDir: string;
    readonly manifest: ProfileManifestView;
    readonly patchText: string;
    readonly manualInsertNames: ReadonlySet<string>;
    /**
     * Shallow node_modules index: package name → located directory plus the
     * root it resolved from. `profile` means the profile's own node_modules
     * (an ordinary installed plugin); `engine` means the shared parent-level
     * node_modules the engine itself ships from. Dot-entries like `.pnpm` are
     * never entered; the profile root wins over the engine root.
     */
    readonly packageIndex: ReadonlyMap<string, {
        dir: string;
        root: 'profile' | 'engine';
    }>;
    /** Fallback cache used only for direct dependencies missing from the index. */
    readonly packageDirCache: Map<string, string | null>;
    readonly realpathCache: Map<string, string | null>;
    /** Located package.json name per directory, for uninstall authorization. */
    readonly manifestNameCache: Map<string, string | null>;
}
/** Create the per-call session: patch parse, shallow index, and caches are shared. */
export declare function createEvidenceSession(profileDir: string, manifest: ProfileManifestView, patchText: string): EvidenceSession;
/** Assemble one entry's evidence from profile files and resolution facts. */
export declare function buildEntryEvidence(facts: LifecycleEntryFacts, context: EvidenceSession): LifecycleEntryEvidence;
/**
 * Compute one entry's capability row. Toggle requires the entry to be
 * addressable by an id-targeted patch in the profile's user patch layer (a
 * root-space data id) and not be lifecycle-critical infrastructure; uninstall
 * additionally requires an exact direct-dependency mapping outside every
 * protected class. A row outside the root patch space cannot be reached by
 * any patch, so neither action is offered for it.
 */
export declare function capabilityOf(evidence: LifecycleEntryEvidence, persistence: 'writable' | 'read-only'): PluginLifecycleEntryCapability;
/** Hash a file's content for revision purposes; missing files hash as '-'. */
export declare function fileDigest(path: string): string;
/**
 * Compute the evidence revision: a digest over the profile identity, the
 * manifest/lockfile/patch digests, and the entry facts, canonicalized so any
 * drift flips the revision.
 */
export declare function computeRevision(profileName: string, digests: {
    readonly manifest: string;
    readonly lockfile: string;
    readonly patch: string;
}, entries: readonly LifecycleEntryFacts[]): string;
//# sourceMappingURL=profile-evidence.d.ts.map