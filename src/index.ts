/**
 * Host half: mounted by the profile Loader through this package's
 * cordis.patch.yml row. T02 wires the inventory assembler onto the Loader
 * roster; the Connection RPC channel registration lands in T04.
 */
import type { HostContext, LoaderEntry } from './host/cordis.ts'
import { InventoryAssembler, type RosterEntry } from './host/inventory.ts'

export default {
  apply(ctx: HostContext): void {
    const assembler = new InventoryAssembler(ctx.loader?.ctx?.baseUrl)

    /** Read the current non-group Loader roster in Loader order. */
    const roster = (): RosterEntry[] => {
      const rows: RosterEntry[] = []
      for (const entry of ctx.loader.ctx.entries()) {
        const options = entry.options as LoaderEntry['options']
        if (options.group !== undefined && options.group !== null && options.group !== false) continue
        rows.push({ entryId: entry.id, moduleName: options.name, disabled: entry.disabled })
      }
      return rows
    }

    // T04 replaces this direct exposure with the loopback RPC channel; kept
    // as a health probe for T02–T03 isolation testing.
    ctx.logger?.info(`dsh-plugin-manager host half active (${assembler.list(roster()).entries.length} roster entries)`)
    ;(ctx as HostContext & { managerRoster?: unknown }).managerRoster = { roster, assembler }
  },
}
