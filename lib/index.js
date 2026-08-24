/**
 * Host half: mounts the manager over the official Connection RPC extension
 * surface. Registers the single `/dsh-plugin-manager` channel with loopback
 * authority (the Host trust fence executes before any handler code), wires
 * its four endpoints to the lifecycle engine plus the inventory assembler,
 * and runs the startup pending-removals cleanup.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LifecycleEngine } from "./host/engine.js";
import { InventoryAssembler } from "./host/inventory.js";
import { MANAGER_CHANNEL, MANAGER_ENDPOINTS, parseManagerRequest, REQUEST_BODY_MAX_BYTES, } from "./host/channel-protocol.js";
import { PROTOCOL_VERSION } from "./host/protocol.js";
import { ManagerFailure } from "./host/failure.js";
export { MANAGER_CHANNEL, MANAGER_ENDPOINTS, PROTOCOL_VERSION };
/** Locate this package's own install-tree root (walk up to our package.json). */
function managerTreeRoot() {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (true) {
        try {
            const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (manifest.name === '@bululuburuarua666/dsh-plugin-manager') {
                return dirname(dirname(realpathSync(dir)));
            }
        }
        catch {
            // Keep walking towards the filesystem root.
        }
        const parent = dirname(dir);
        /* v8 ignore next -- reaching the filesystem root means this package is uninstalled; a test cannot fabricate that state. */
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export default {
    apply(ctx) {
        const loaderContext = ctx.loader?.ctx;
        const baseUrl = loaderContext?.baseUrl;
        const entries = () => loaderContext?.entries() ?? [];
        const persistence = () => {
            // Same stance as the official lifecycle surface: an all-interfaces
            // webserver bind serves read-only clients.
            const webServer = ctx.webServer;
            return webServer?.host === '0.0.0.0' ? 'read-only' : 'writable';
        };
        const host = {
            entries,
            persistence,
            engineTreeRoot: managerTreeRoot(),
        };
        const engine = new LifecycleEngine(baseUrl, host);
        const inventory = new InventoryAssembler(baseUrl);
        // Startup cleanup: settled pending removals are pruned idempotently.
        /* v8 ignore start -- the catch arm needs the lock creation itself to fail (e.g. a read-only profile directory), which Windows CI cannot stage reliably; POSIX CI covers it. */
        void engine.startupCleanup().catch(error => {
            ctx.logger?.warn(`dsh-plugin-manager: startup cleanup failed: ${String(error)}`);
        });
        /* v8 ignore stop */
        // The channel only exists when the official Connection RPC surface does.
        const rpc = ctx.connection?.rpc;
        if (rpc === undefined) {
            ctx.logger?.warn('dsh-plugin-manager: no Connection RPC surface on this Host; the tab will report unavailable');
            return;
        }
        const dispose = rpc.handle(MANAGER_CHANNEL, (endpoint, payload, signal) => managerHandler(engine, inventory, entries, endpoint, payload, signal), { authority: 'loopback' });
        // Register a disposal bridge on the plugin context if it offers effects.
        const effectCtx = ctx;
        if (typeof effectCtx.effect === 'function') {
            effectCtx.effect(() => dispose, 'dsh-plugin-manager: rpc channel');
        }
        ctx.logger?.info('dsh-plugin-manager: channel /dsh-plugin-manager registered (loopback)');
    },
};
/**
 * One channel request: strict payload gate, endpoint dispatch, structured
 * errors. ManagerFailure codes pass through; anything else maps to INTERNAL
 * with a sanitized message.
 */
async function managerHandler(engine, inventory, entries, endpoint, payload, signal) {
    void signal;
    try {
        if (payload !== null && typeof payload === 'object' && JSON.stringify(payload).length > REQUEST_BODY_MAX_BYTES) {
            return { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'request payload exceeds the channel limit' } };
        }
        if (!MANAGER_ENDPOINTS.includes(endpoint)) {
            return { ok: false, error: { code: 'ENDPOINT_UNKNOWN', message: `unknown endpoint ${endpoint.slice(0, 64)}` } };
        }
        const request = parseManagerRequest(endpoint, payload);
        if (!request.ok) {
            return { ok: false, error: { code: request.code, message: request.message } };
        }
        switch (endpoint) {
            case 'capabilities': {
                const caps = engine.capabilities();
                const roster = inventory.list([...rosterRows(entries())]);
                return {
                    ok: true,
                    value: {
                        protocolVersion: PROTOCOL_VERSION,
                        revision: caps.revision,
                        persistence: caps.persistence,
                        entries: mergeEntries(roster.entries, caps.entries),
                        diagnostics: roster.diagnostics,
                    },
                };
            }
            case 'preview': {
                const value = engine.preview({
                    entryId: request.value.entryId,
                    action: request.value.action,
                    expectedRevision: request.value.expectedRevision,
                });
                return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } };
            }
            case 'execute': {
                const value = engine.execute({ token: request.value.token });
                return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } };
            }
            case 'operation': {
                const value = engine.operation({ operationId: request.value.operationId });
                return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ...value } };
            }
        }
    }
    catch (error) {
        if (error instanceof ManagerFailure) {
            return { ok: false, error: { code: error.code, message: error.message } };
        }
        return { ok: false, error: { code: 'INTERNAL', message: 'the operation failed unexpectedly' } };
    }
}
/** Non-group roster rows shaped for the inventory assembler. */
function rosterRows(iterable) {
    const rows = [];
    for (const entry of iterable) {
        const options = entry.options;
        if (options.group !== undefined && options.group !== null && options.group !== false)
            continue;
        rows.push({ entryId: entry.id, moduleName: options.name, disabled: entry.disabled });
    }
    return rows;
}
/** Merge origin/card rows with lifecycle capabilities by entryId. */
function mergeEntries(originRows, capabilityRows) {
    const capabilityByEntry = new Map(capabilityRows.map(row => [row.entryId, row]));
    return originRows.map(row => ({
        ...row,
        /* v8 ignore next -- the fallback arm fires only when the roster and the engine evidence disagree mid-read (two independent reads of one mutating Loader); the engine's own queue serializes writes, so a test cannot stage the race deterministically. */
        ...(capabilityByEntry.get(row.entryId) ?? { canToggle: false, canUninstall: false, toggleBlockReason: null, uninstallBlockReason: null, packageName: null }),
    }));
}
//# sourceMappingURL=index.js.map