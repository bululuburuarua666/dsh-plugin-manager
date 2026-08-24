/** Bounded operation ledger for lifecycle mutations. */

import { randomBytes } from 'node:crypto'
import type {
  PluginLifecycleAction,
  PluginLifecycleErrorCode,
  PluginLifecycleOperationState,
  PluginLifecycleOperationView,
} from './engine-types.ts'

/** Injectable dependencies for deterministic tests. */
export interface PluginLifecycleOperationStoreDeps {
  readonly randomHex?: (bytes: number) => string
  readonly capacity?: number
}

const DEFAULT_CAPACITY = 32

/** Internal operation record. */
interface OperationRecord {
  readonly operationId: string
  readonly action: PluginLifecycleAction
  state: PluginLifecycleOperationState
  errorCode: PluginLifecycleErrorCode | null
  restartRequired: boolean
}

/**
 * Bounded FIFO operation ledger. Operations are created in `queued` state and
 * transition through `running` to a terminal state; the store keeps at most
 * `capacity` records so long sessions cannot grow it without bound.
 */
export class PluginLifecycleOperationStore {
  private readonly randomHex: (bytes: number) => string
  private readonly capacity: number
  private readonly records = new Map<string, OperationRecord>()

  constructor(deps: PluginLifecycleOperationStoreDeps = {}) {
    this.randomHex = deps.randomHex ?? (bytes => randomBytes(bytes).toString('hex'))
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY
  }

  /**
   * Create a queued operation.
   * @param action - the lifecycle action being run.
   * @returns the new operation id.
   */
  create(action: PluginLifecycleAction): string {
    const operationId = this.randomHex(16)
    this.records.set(operationId, {
      operationId,
      action,
      state: 'queued',
      errorCode: null,
      restartRequired: false,
    })
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next()
      /* v8 ignore next -- the size bound guarantees an oldest key exists. */
      if (oldest.done) break
      this.records.delete(oldest.value)
    }
    return operationId
  }

  /**
   * Transition one operation.
   * @param operationId - target operation.
   * @param update - fields to merge.
   */
  update(
    operationId: string,
    update: {
      readonly state?: PluginLifecycleOperationState
      readonly errorCode?: PluginLifecycleErrorCode | null
      readonly restartRequired?: boolean
    },
  ): void {
    const record = this.records.get(operationId)
    if (record === undefined) return
    if (update.state !== undefined) record.state = update.state
    if (update.errorCode !== undefined) record.errorCode = update.errorCode
    if (update.restartRequired !== undefined) record.restartRequired = update.restartRequired
  }

  /**
   * Read one operation's public view.
   * @param operationId - target operation.
   * @returns the view, or null for an unknown or evicted id.
   */
  get(operationId: string): PluginLifecycleOperationView | null {
    const record = this.records.get(operationId)
    if (record === undefined) return null
    return {
      operationId: record.operationId,
      state: record.state,
      action: record.action,
      errorCode: record.errorCode,
      restartRequired: record.restartRequired,
    }
  }
}
