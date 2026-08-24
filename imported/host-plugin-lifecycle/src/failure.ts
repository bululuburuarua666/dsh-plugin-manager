/** Structured business failures carried verbatim through the Typert gateway. */

import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { PluginLifecycleErrorCode } from './types.ts'

/** The wire shape a lifecycle failure projects into. */
export interface PluginLifecycleFailurePayload {
  readonly code: PluginLifecycleErrorCode
  readonly message: string
  readonly details: Record<string, never>
}

/**
 * Raise a structured lifecycle failure. The Typert gateway preserves
 * {@link TypertLookupFailure} payloads instead of collapsing them into a
 * generic internal error, so the client reads `error.code` directly.
 * @param code - machine-readable failure code.
 * @param message - sanitized, path-free human context.
 * @returns the throwable failure.
 */
export function lifecycleFailure(
  code: PluginLifecycleErrorCode,
  message: string,
): TypertLookupFailure<PluginLifecycleFailurePayload> {
  return new TypertLookupFailure({ code, message, details: {} })
}
