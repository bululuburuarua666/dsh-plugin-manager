/** Bounded one-use preview token store with injectable clock and randomness. */

import { randomBytes } from 'node:crypto'
import type { PluginLifecycleAction } from './types.ts'

/** Evidence a preview token binds: execute revalidates every field. */
export interface PluginLifecycleTokenBinding {
  readonly action: PluginLifecycleAction
  readonly entryId: string
  readonly packageName: string | null
  readonly affectedEntryIds: readonly string[]
  readonly restartRequired: boolean
  /** Evidence revision the preview was computed against. */
  readonly revision: string
}

/** One issued token record. */
export interface PluginLifecycleToken extends PluginLifecycleTokenBinding {
  readonly token: string
  readonly expiresAt: number
}

/** Injectable dependencies for deterministic tests. */
export interface PluginLifecycleTokenStoreDeps {
  readonly now?: () => number
  readonly randomHex?: (bytes: number) => string
  readonly capacity?: number
  readonly ttlMs?: number
}

const DEFAULT_CAPACITY = 32
const DEFAULT_TTL_MS = 60_000

/**
 * CSPRNG one-use token store. Tokens expire after `ttlMs`; `consume` deletes
 * on first read regardless of validity, so a token can never be replayed.
 * Eviction is FIFO by issue order once the bound is exceeded.
 */
export class PluginLifecycleTokenStore {
  private readonly now: () => number
  private readonly randomHex: (bytes: number) => string
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly tokens = new Map<string, PluginLifecycleToken>()

  constructor(deps: PluginLifecycleTokenStoreDeps = {}) {
    this.now = deps.now ?? Date.now
    this.randomHex = deps.randomHex ?? (bytes => randomBytes(bytes).toString('hex'))
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  }

  /**
   * Issue a token binding the given evidence.
   * @param binding - action and evidence the token commits to.
   * @returns the token id and its expiry.
   */
  issue(binding: PluginLifecycleTokenBinding): { token: string; expiresAt: number } {
    this.sweepExpired()
    const token = this.randomHex(16)
    const expiresAt = this.now() + this.ttlMs
    this.tokens.set(token, { ...binding, token, expiresAt })
    while (this.tokens.size > this.capacity) {
      const oldest = this.tokens.keys().next()
      /* v8 ignore next -- the size bound guarantees an oldest key exists. */
      if (oldest.done) break
      this.tokens.delete(oldest.value)
    }
    return { token, expiresAt }
  }

  /**
   * Consume a token: the record is deleted on first read and returned only
   * when still unexpired.
   * @param token - the opaque token id.
   * @returns the bound evidence, or null when unknown or expired.
   */
  consume(token: string): PluginLifecycleToken | null {
    const record = this.tokens.get(token)
    if (record === undefined) return null
    this.tokens.delete(token)
    return record.expiresAt >= this.now() ? record : null
  }

  /** Drop expired tokens. */
  private sweepExpired(): void {
    const now = this.now()
    for (const [token, record] of this.tokens) {
      if (record.expiresAt < now) this.tokens.delete(token)
    }
  }
}
