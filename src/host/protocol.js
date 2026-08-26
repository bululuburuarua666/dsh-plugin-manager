/**
 * Self-contained host types for the manager: protocol wire shapes shared by
 * the Host and Client halves (kept free of any @deepseek-ai runtime import so
 * the out-of-tree bundle stays self-contained) plus origin/card data types
 * ported from the upstream plugin-inventory surface.
 */
/** normalizeInventoryCardText: null-safe bilingual text normalization. */
export function normalizeInventoryCardText(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length === 0 ? null : { zh: trimmed, en: trimmed };
    }
    if (typeof value === 'object' && value !== null) {
        const zh = typeof value.zh === 'string' ? value.zh.trim() : '';
        const en = typeof value.en === 'string' ? value.en.trim() : '';
        if (zh.length === 0 && en.length === 0)
            return null;
        return { zh: zh.length > 0 ? zh : en, en: en.length > 0 ? en : zh };
    }
    return null;
}
// ---------------------------------------------------------------------------
// Manager protocol v1 (channel /dsh-plugin-manager, loopback authority)
// ---------------------------------------------------------------------------
/** Protocol version carried by every request and response payload. */
export const PROTOCOL_VERSION = 1;
