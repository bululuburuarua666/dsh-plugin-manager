/**
 * Source-preserving editor for the profile's user patch file
 * (`cordis.patch.yml`). Two operations only:
 *
 * - {@link applyManagedToggleRows} replaces the content of the unique
 *   BEGIN/END lifecycle marker block, leaving every other byte untouched;
 * - {@link removeManualInsertRows} splices a manual-insert entry using parsed
 *   structure plus byte ranges — never a full-file re-stringify.
 *
 * Both return candidate bytes; the caller validates and commits them.
 */
/** Marker comment delimiting the lifecycle-managed block. */
export declare const LIFECYCLE_BEGIN_MARKER = "# BEGIN DSH PLUGIN LIFECYCLE \u2014 managed, do not edit";
/** Closing marker comment of the lifecycle-managed block. */
export declare const LIFECYCLE_END_MARKER = "# END DSH PLUGIN LIFECYCLE";
/** One managed toggle row: `disabled: true` disables, `false` writes null. */
export interface ManagedToggleRow {
    /**
     * Target id in the PATCH-LAYER data space: the row's own data id, i.e. the
     * last `:`-segment of the loader tree id (`include:timer` → `timer`).
     * `applyEntryPatches` matches data ids, not tree paths — a tree id written
     * verbatim silently matches nothing.
     */
    readonly entryId: string;
    readonly disabled: boolean;
}
/**
 * The pinned id of the root Include entry (`mountRootInclude` in upstream
 * `dsh-app-boot`). Loader tree ids of rows inside the profile's root patch
 * space are exactly `include:<dataId>`; only that single-segment shape is
 * addressable by an id-targeted patch in `cordis.patch.yml`.
 */
export declare const ROOT_INCLUDE_ID = "include";
/**
 * Strict tree-id → data-id mapping: non-null only when the row's declared
 * data id composes back to the exact tree id (`include:<optionsId>`). Rows in
 * nested subtrees (agent preset realms, `include:preset:foo`), loader-root
 * rows without the prefix, and rosters that do not declare `options.id` have
 * no addressable data id — an id-targeted patch can never reach them. No
 * shape-based fallback: guessing from the tree id alone would re-introduce
 * the cross-space collision the strict check exists to prevent.
 */
export declare function patchTargetIdOf(treeId: string, optionsId: unknown): string | null;
/**
 * One-way data-id → tree-id mapping for Loader-space probes. Unconditional:
 * a legitimate data id may itself contain `:` segments, so never try to be
 * clever about already-prefixed inputs — callers here always hold data ids.
 */
export declare function treeIdOfPatchTarget(dataId: string): string;
/** Editor failure codes surfaced as lifecycle error codes. */
export type PatchEditorFailureCode = 'INVALID_PATCH' | 'MANAGED_BLOCK_INVALID' | 'UNSUPPORTED_PATCH_SHAPE';
/** Editor outcome: candidate bytes, or a structured refusal. */
export type PatchEditResult = {
    readonly ok: true;
    readonly content: string;
} | {
    readonly ok: false;
    readonly code: PatchEditorFailureCode;
    readonly message: string;
};
/** Insert-removal outcome additionally reports the removed entry ids. */
export type InsertRemovalResult = {
    readonly ok: true;
    readonly content: string;
    readonly removedEntryIds: readonly string[];
} | {
    readonly ok: false;
    readonly code: PatchEditorFailureCode;
    readonly message: string;
};
/**
 * Validate patch text with the same contract the boot path uses
 * (`app-boot`'s parsePatchList): js-yaml under the include's entry-list
 * schema, a top-level array, and mapping items.
 * @param text - candidate or source patch text.
 * @returns true when the text is a structurally valid patch list.
 */
export declare function isValidPatchListText(text: string): boolean;
/**
 * Replace the lifecycle marker block inside a patch file. With no markers the
 * block is appended after the existing top-level sequence; exactly one marker
 * pair replaces its inner rows. Duplicate, nested, or misordered markers, an
 * indented marker, or an invalid source shape refuse the edit.
 * @param source - current file text (empty string means no file yet).
 * @param rows - the complete next managed row set.
 * @returns candidate bytes or a structured refusal.
 */
export declare function applyManagedToggleRows(source: string, rows: readonly ManagedToggleRow[]): PatchEditResult;
/** Read result of the managed block, or null when no block exists. */
export type ManagedToggleReadResult = {
    readonly ok: true;
    readonly rows: ManagedToggleRow[];
} | {
    readonly ok: false;
    readonly code: PatchEditorFailureCode;
    readonly message: string;
};
/**
 * Read the current managed toggle rows from a patch file. Returns null when
 * the marker block is absent (no managed state yet); refuses with an
 * `MANAGED_BLOCK_INVALID` failure when the markers are malformed.
 * @param source - current file text.
 * @returns parsed managed rows, or null when no block exists.
 */
export declare function readManagedToggleRows(source: string): ManagedToggleReadResult | null;
/**
 * Splice the manual-insert entry rows whose `name` equals `moduleName` out of
 * a patch file. The structural match is confirmed through the parsed document
 * and removed with byte ranges; an insert list emptied by the splice loses its
 * whole top-level item. Ambiguous matches, aliases, non-sequence tops, or an
 * unparseable source refuse the edit.
 * @param source - current patch file text.
 * @param moduleName - exact package/module name to remove.
 * @returns candidate bytes plus removed entry ids, or a structured refusal.
 */
export declare function removeManualInsertRows(source: string, moduleName: string): InsertRemovalResult;
//# sourceMappingURL=patch-editor.d.ts.map