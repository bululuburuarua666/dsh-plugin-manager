/**
 * Host half (T01 skeleton): mounted by the profile Loader through this
 * package's cordis.patch.yml row. The full lifecycle engine and the
 * Connection RPC channel registration land in T02–T04; for now the plugin
 * only reports that it is alive.
 */

/** Minimal structural shape of the Host Cordis context (keep dependency-free). */
interface HostContext {
  readonly logger?: { info(message: string): void; warn(message: string): void }
}

export default {
  apply(ctx: HostContext): void {
    ctx.logger?.info('dsh-plugin-manager host half active (T01 skeleton)')
  },
}
