/**
 * Self-contained host types for the manager: protocol wire shapes shared by
 * the Host and Client halves (kept free of any @deepseek-ai runtime import so
 * the out-of-tree bundle stays self-contained) plus origin/card data types
 * ported from the upstream plugin-inventory surface.
 */

/** Minimal branded-string helper (upstream: @deepseek-ai/dsh-brand). */
export type Branded<T extends string> = string & { readonly __brand: T }

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Bilingual display text. */
export interface PluginInventoryCardText {
  readonly zh: string
  readonly en: string
}

/** Origin classification kinds shown in the UI. */
export type PluginOriginKind = 'official' | 'personal' | 'opensource'

/** Which layer produced the origin classification. */
export type PluginOriginDeclaredBy = 'user-override' | 'manifest' | 'heuristic'

/** One resolved plugin origin. */
export interface PluginInventoryOrigin {
  readonly kind: PluginOriginKind
  readonly customized: boolean
  readonly upstream: string | null
  readonly fork: string | null
  readonly branch: string | null
  readonly note: PluginInventoryCardText | null
  readonly declaredBy: PluginOriginDeclaredBy
}

/** Sanitized origin-resolution diagnostic (no paths, no raw payloads). */
export interface PluginOriginDiagnostic {
  readonly code:
    | 'override-file-invalid'
    | 'override-entry-invalid'
    | 'manifest-invalid'
    | 'official-claim-rejected'
    | 'lockfile-unsupported'
  readonly packageName: string | null
}

/** Hover-card view of one plugin package. */
export interface PluginInventoryCard {
  readonly title: PluginInventoryCardText | null
  readonly description: PluginInventoryCardText | null
}

/** normalizeInventoryCardText: null-safe bilingual text normalization. */
export function normalizeInventoryCardText(
  value: string | PluginInventoryCardText | null | undefined,
): PluginInventoryCardText | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : { zh: trimmed, en: trimmed }
  }
  if (typeof value === 'object' && value !== null) {
    const zh = typeof value.zh === 'string' ? value.zh.trim() : ''
    const en = typeof value.en === 'string' ? value.en.trim() : ''
    if (zh.length === 0 && en.length === 0) return null
    return { zh: zh.length > 0 ? zh : en, en: en.length > 0 ? en : zh }
  }
  return null
}

// ---------------------------------------------------------------------------
// Manager protocol v1 (channel /dsh-plugin-manager, loopback authority)
// ---------------------------------------------------------------------------

/** Protocol version carried by every request and response payload. */
export const PROTOCOL_VERSION = 1

/** One plugin row as presented by the manager tab. */
export interface ManagerEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  /** Effective origin after applying the user override, when any. */
  readonly origin: PluginInventoryOrigin
  /** Automatic origin (manifest → heuristic) with the user override removed. */
  readonly detectedOrigin: PluginInventoryOrigin
  readonly title: PluginInventoryCardText | null
  readonly description: PluginInventoryCardText | null
  readonly canToggle: boolean
  readonly canUninstall: boolean
  readonly toggleBlockReason: string | null
  readonly uninstallBlockReason: string | null
}

/** Capabilities response: the roster plus a config revision. */
export interface ManagerCapabilities {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly revision: string
  readonly entries: readonly ManagerEntry[]
}

/** Result envelope used by every protocol endpoint. */
export type ManagerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message?: string }
