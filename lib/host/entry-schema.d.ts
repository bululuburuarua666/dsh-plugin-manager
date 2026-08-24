/**
 * The entry-list YAML dialect used by profile and bundle patch layers:
 * `!!js` scalars round-trip as expression nodes the Loader evaluates at
 * entry activation. Inlined from @deepseek-ai/cordis-plugin-include (MIT,
 * DeepSeek — see THIRD_PARTY_NOTICES.md) so this package stays self-contained;
 * the schema is a stable wire dialect shared with the engine.
 */
import * as yaml from 'js-yaml';
/** Sentinel marker a `!!js` scalar parses into (never evaluated here). */
export interface JsExprNode {
    readonly __jsExpr: string;
}
/** Whether an unknown parsed value is a `!!js` expression node. */
export declare function isJsExpr(value: unknown): value is JsExprNode;
/** The entry-list dialect: JSON schema plus `!!js` expression scalars. */
export declare const entryListSchema: yaml.Schema;
//# sourceMappingURL=entry-schema.d.ts.map