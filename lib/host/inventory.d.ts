/**
 * Inventory assembly: read the Loader roster once per request and decorate
 * each entry with card metadata and origin classification. This module is a
 * pure engine over injected inputs (roster rows + profile directory) — the
 * Cordis wiring lives in the host entry and the RPC channel in T04.
 */
import type { ManagerEntry, PluginOriginDiagnostic } from './protocol.ts';
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
/** Assemble the manager roster for one request. */
export declare class InventoryAssembler {
    private readonly cards;
    private readonly installSources;
    private readonly profileDir;
    private readonly localPluginsDir;
    private readonly engineTreeRoot;
    constructor(baseUrl: string | undefined);
    /** Read the profile's origin override file; invalid files yield none. */
    private readOverrides;
    /** Whether a `file:`/`link:` target lives inside the local plugins dir. */
    private fileTargetInsideLocal;
    /** Resolve one entry's origin through the override/manifest/heuristic chain. */
    private originOf;
    /** Assemble the current roster with origins and cards. */
    list(roster: readonly RosterEntry[]): InventorySnapshot;
}
//# sourceMappingURL=inventory.d.ts.map