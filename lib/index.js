/**
 * Host half (T01 skeleton): mounted by the profile Loader through this
 * package's cordis.patch.yml row. The full lifecycle engine and the
 * Connection RPC channel registration land in T02–T04; for now the plugin
 * only reports that it is alive.
 */
export default {
    apply(ctx) {
        ctx.logger?.info('dsh-plugin-manager host half active (T01 skeleton)');
    },
};
//# sourceMappingURL=index.js.map