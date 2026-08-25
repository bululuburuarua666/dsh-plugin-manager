import { MANAGER_CHANNEL, MANAGER_ENDPOINTS, type ManagerEndpoint } from './host/channel-protocol.ts';
import { PROTOCOL_VERSION } from './host/protocol.ts';
import type { LoaderEntry } from './host/cordis.ts';
export { MANAGER_CHANNEL, MANAGER_ENDPOINTS, PROTOCOL_VERSION };
export type { ManagerEndpoint };
/** Structural shape of the real Cordis plugin context this plugin consumes. */
interface PluginContext {
    readonly loader: {
        readonly ctx: {
            readonly baseUrl: string | undefined;
            entries(): Iterable<LoaderEntry>;
        };
    };
    /** Dynamic dependency injection: runs the callback once `deps` are provided. */
    inject(deps: readonly string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown;
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
    readonly webServer?: {
        readonly host?: string;
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