import { MANAGER_CHANNEL, MANAGER_ENDPOINTS, type ManagerEndpoint } from './host/channel-protocol.ts';
import { PROTOCOL_VERSION } from './host/protocol.ts';
import type { LoaderEntry } from './host/cordis.ts';
export { MANAGER_CHANNEL, MANAGER_ENDPOINTS, PROTOCOL_VERSION };
export type { ManagerEndpoint };
/** Structural shape of the real Cordis plugin context this plugin consumes. */
interface PluginContext {
    readonly loader: {
        entries(): Iterable<LoaderEntry>;
        readonly ctx: {
            readonly baseUrl: string | undefined;
        };
    };
    /** Dynamic dependency injection: runs the callback once `deps` are provided. */
    inject(deps: readonly string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown;
    /**
     * Inject-requirement-free service read (the official `ctx.get`): returns
     * the live implementation or undefined without declaring a dependency.
     * Real Cordis property access (`ctx.webServer`) throws without inject.
     */
    get(name: string): unknown;
    readonly connection?: {
        readonly rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{
                ok: boolean;
                value?: unknown;
                error?: {
                    code: string;
                    message?: string;
                };
            }>, options: {
                readonly authority: 'loopback' | 'trusted-host';
            }): () => Promise<void>;
        };
    };
    readonly logger?: {
        info(message: string): void;
        warn(message: string): void;
    };
    /** Reversible-effect registration owned by the Cordis lifecycle. */
    effect(fn: () => unknown, label?: string): unknown;
}
/** The real Cordis plugin: required loader injection, dynamic connection. */
declare const _default: {
    inject: string[];
    apply(ctx: PluginContext): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map