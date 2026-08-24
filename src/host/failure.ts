/** Structured business failures carried through the manager RPC channel. */

import type { PluginLifecycleErrorCode } from './engine-types.ts'

/**
 * Raise a structured manager failure. The channel handler unwraps `code`
 * into the RPC error envelope; `message` must stay sanitized and path-free.
 */
export class ManagerFailure extends Error {
  readonly code: PluginLifecycleErrorCode
  readonly details: Record<string, never>

  constructor(code: PluginLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'ManagerFailure'
    this.code = code
    this.details = {}
  }
}

/** Convenience constructor matching the upstream lifecycleFailure shape. */
export function managerFailure(code: PluginLifecycleErrorCode, message: string): ManagerFailure {
  return new ManagerFailure(code, message)
}

/** Back-compat alias used by the ported engine modules. */
export const lifecycleFailure = managerFailure
export type ManagerErrorCode = PluginLifecycleErrorCode
