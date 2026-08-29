/**
 * Self-contained host types for the manager: protocol wire shapes shared by
 * the Host and Client halves (kept free of any @deepseek-ai runtime import so
 * the out-of-tree bundle stays self-contained) plus origin/card data types
 * ported from the upstream plugin-inventory surface.
 */
/** Minimal branded-string helper (upstream: @deepseek-ai/dsh-brand). */
export type Branded<T extends string> = string & {
    readonly __brand: T;
};
/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>;
/** Bilingual display text. */
export interface PluginInventoryCardText {
    readonly zh: string;
    readonly en: string;
}
/** Origin classification kinds shown in the UI. */
export type PluginOriginKind = 'official' | 'personal' | 'opensource';
/** Which layer produced the origin classification. */
export type PluginOriginDeclaredBy = 'user-override' | 'manifest' | 'heuristic';
/** One resolved plugin origin. */
export interface PluginInventoryOrigin {
    readonly kind: PluginOriginKind;
    readonly customized: boolean;
    readonly upstream: string | null;
    readonly fork: string | null;
    readonly branch: string | null;
    readonly note: PluginInventoryCardText | null;
    readonly declaredBy: PluginOriginDeclaredBy;
}
/** Sanitized origin-resolution diagnostic (no paths, no raw payloads). */
export interface PluginOriginDiagnostic {
    readonly code: 'override-file-invalid' | 'override-entry-invalid' | 'manifest-invalid' | 'official-claim-rejected' | 'lockfile-unsupported';
    readonly packageName: string | null;
}
/** Hover-card view of one plugin package. */
export interface PluginInventoryCard {
    readonly title: PluginInventoryCardText | null;
    readonly description: PluginInventoryCardText | null;
}
/** normalizeInventoryCardText: null-safe bilingual text normalization. */
export declare function normalizeInventoryCardText(value: string | PluginInventoryCardText | null | undefined): PluginInventoryCardText | null;
/** Protocol version carried by every request and response payload. */
export declare const PROTOCOL_VERSION = 1;
/** One plugin row as presented by the manager tab. */
export interface ManagerEntry {
    readonly entryId: string;
    readonly moduleName: string;
    readonly enabled: boolean;
    /** Effective origin after applying the user override, when any. */
    readonly origin: PluginInventoryOrigin;
    /** Automatic origin (manifest → heuristic) with the user override removed. */
    readonly detectedOrigin: PluginInventoryOrigin;
    readonly title: PluginInventoryCardText | null;
    readonly description: PluginInventoryCardText | null;
    readonly canToggle: boolean;
    readonly canUninstall: boolean;
    readonly toggleBlockReason: string | null;
    readonly uninstallBlockReason: string | null;
}
/** Capabilities response: the roster plus a config revision. */
export interface ManagerCapabilities {
    readonly protocolVersion: typeof PROTOCOL_VERSION;
    readonly revision: string;
    readonly entries: readonly ManagerEntry[];
}
/** Result envelope used by every protocol endpoint. */
export type ManagerResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly code: string;
    readonly message?: string;
};
//# sourceMappingURL=protocol.d.ts.map