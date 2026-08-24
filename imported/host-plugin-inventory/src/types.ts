import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** Bilingual user-facing copy for one plugin inventory card field. */
export interface PluginInventoryCardText {
  /** Simplified Chinese copy. */
  readonly zh: string
  /** English copy. */
  readonly en: string
}

/**
 * Hover-card metadata projected into the Plugins settings inventory.
 *
 * Plugins publish this data under `dsh.inventory` in their package.json:
 * `title` gives the plugin's Chinese meaning, `description` gives a short
 * capability summary. Both fields accept one string (used for both
 * languages) or a `{ "zh": "...", "en": "..." }` object.
 */
export interface PluginInventoryCardManifest {
  readonly title: string | PluginInventoryCardText
  readonly description: string | PluginInventoryCardText
}

/** Resolved inventory card; fields are null when the package declares none. */
export interface PluginInventoryCard {
  readonly title: PluginInventoryCardText | null
  readonly description: PluginInventoryCardText | null
}

/** Product-level provenance class of one plugin package. */
export type PluginOriginKind = 'official' | 'personal' | 'opensource'

/** Which declaration layer produced the resolved origin. */
export type PluginOriginDeclaredBy =
  | 'user-override'
  | 'manifest'
  | 'heuristic'

/**
 * Provenance projection of one plugin entry. `customized` is an independent
 * axis from `kind`: a personal plugin is self-built (never marked customized),
 * while an open-source plugin with local modifications keeps
 * `kind: 'opensource'` with `customized: true` plus fork/branch details.
 */
export interface PluginInventoryOrigin {
  readonly kind: PluginOriginKind
  /** True only for open-source packages carrying personal modifications. */
  readonly customized: boolean
  readonly upstream: string | null
  readonly fork: string | null
  readonly branch: string | null
  readonly note: PluginInventoryCardText | null
  readonly declaredBy: PluginOriginDeclaredBy
}

/** Sanitized origin-resolution diagnostic; never carries paths or specs. */
export interface PluginOriginDiagnostic {
  readonly code:
    | 'override-file-invalid'
    | 'override-entry-invalid'
    | 'manifest-invalid'
    | 'official-claim-rejected'
    | 'lockfile-unsupported'
  readonly packageName: string | null
}

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  /**
   * Epoch milliseconds of this entry's most recent observed Loader/Fiber
   * change. Entries that changed before this inventory service started get
   * the service's first observation time, so every entry carries a sortable
   * timestamp for the current process run.
   */
  readonly updatedAt: number
  /** Bilingual display card, or an empty card when metadata is unavailable. */
  readonly card: PluginInventoryCard
  /**
   * Resolved package provenance. Optional on the wire so a newer client can
   * talk to an older host during rolling upgrades; a missing value renders
   * as "unclassified" rather than a guessed badge.
   */
  readonly origin?: PluginInventoryOrigin
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /** Sanitized resolution diagnostics; absent when nothing went wrong. */
  readonly diagnostics?: readonly PluginOriginDiagnostic[]
}
