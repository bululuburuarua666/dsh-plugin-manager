/**
 * Inventory assembly: read the Loader roster once per request and decorate
 * each entry with card metadata and origin classification. This module is a
 * pure engine over injected inputs (roster rows + profile directory) — the
 * Cordis wiring lives in the host entry and the RPC channel in T04.
 */
import { type PluginOriginOverrideEntry } from './origin.ts';
import type { ManagerEntry, PluginInventoryOrigin, PluginOriginDiagnostic } from './protocol.ts';
/** One roster row supplied by the host wiring (mirrors a non-group Loader entry). */
export interface RosterEntry {
    readonly entryId: string;
    readonly moduleName: string;
    readonly disabled: boolean;
}
/** Profile directory, or null when the Loader has no base URL. */
export declare function profileDirOf(baseUrl: string | undefined): string | null;
/** One assembled capability snapshot. */
export interface InventorySnapshot {
    readonly entries: readonly ManagerEntry[];
    readonly diagnostics: readonly PluginOriginDiagnostic[];
}
/** One module's full origin picture for the origin editor. */
export interface OriginDescription {
    /** The real package.json `name` the override is keyed by. */
    readonly packageName: string;
    /** Automatic origin (manifest → heuristic) with the user override removed. */
    readonly detected: PluginInventoryOrigin;
    /** Effective origin after applying the user override, when any. */
    readonly effective: PluginInventoryOrigin;
    /** The stored user override entry, or null when none applies. */
    readonly override: PluginOriginOverrideEntry | null;
    readonly diagnostics: readonly PluginOriginDiagnostic[];
}
/** Assemble the manager roster for one request. */
export declare class InventoryAssembler {
    private readonly cards;
    private readonly installSources;
    private readonly profileDir;
    private readonly localPluginsDir;
    constructor(baseUrl: string | undefined);
    /** Read the profile's origin override file; invalid files yield none. */
    private readOverrides;
    /** Whether a `file:`/`link:` target lives inside the local plugins dir. */
    private fileTargetInsideLocal;
    /** Evidence and manifest declaration for one module. */
    private evidenceOf;
    /** The override entry applying to one package, keyed by real package name. */
    private overrideFor;
    /**
     * Resolve one entry's origin pair through the override/manifest/heuristic
     * chain: the effective origin (override applied) and the detected origin
     * (override removed). Both derive from one evidence assembly.
     */
    private originsOf;
    /**
     * Describe one module's origin layers for the origin editor. Returns null
     * for `cordis:` builtins and unresolvable modules — they have no stable
     * package name an override could key on.
     */
    describeOrigin(moduleName: string): OriginDescription | null;
    /** Assemble the current roster with origins and cards. */
    list(roster: readonly RosterEntry[]): InventorySnapshot;
}
//# sourceMappingURL=inventory.d.ts.map