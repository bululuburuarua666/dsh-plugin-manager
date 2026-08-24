import { InventoryAssembler } from './host/inventory.ts';
export default {
    apply(ctx) {
        const assembler = new InventoryAssembler(ctx.loader?.ctx?.baseUrl);
        /** Read the current non-group Loader roster in Loader order. */
        const roster = () => {
            const rows = [];
            for (const entry of ctx.loader.ctx.entries()) {
                const options = entry.options;
                if (options.group !== undefined && options.group !== null && options.group !== false)
                    continue;
                rows.push({ entryId: entry.id, moduleName: options.name, disabled: entry.disabled });
            }
            return rows;
        };
        // T04 replaces this direct exposure with the loopback RPC channel; kept
        // as a health probe for T02–T03 isolation testing.
        ctx.logger?.info(`dsh-plugin-manager host half active (${assembler.list(roster()).entries.length} roster entries)`);
        ctx.managerRoster = { roster, assembler };
    },
};
//# sourceMappingURL=index.js.map