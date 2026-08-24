/**
 * The entry-list YAML dialect used by profile and bundle patch layers:
 * `!!js` scalars round-trip as expression nodes the Loader evaluates at
 * entry activation. Inlined from @deepseek-ai/cordis-plugin-include (MIT,
 * DeepSeek — see THIRD_PARTY_NOTICES.md) so this package stays self-contained;
 * the schema is a stable wire dialect shared with the engine.
 */
import * as yaml from 'js-yaml'

/** Sentinel marker a `!!js` scalar parses into (never evaluated here). */
export interface JsExprNode {
  readonly __jsExpr: string
}

/** Whether an unknown parsed value is a `!!js` expression node. */
export function isJsExpr(value: unknown): value is JsExprNode {
  return typeof value === 'object' && value !== null && '__jsExpr' in value
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (data) => isJsExpr(data),
  represent: (data) => (data as JsExprNode).__jsExpr,
})

/** The entry-list dialect: JSON schema plus `!!js` expression scalars. */
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
