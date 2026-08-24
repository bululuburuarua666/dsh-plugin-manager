/**
 * Ambient type stubs for the official DSH web-client API surface this plugin
 * consumes through the module table (`dsh.client.inject`). The shapes mirror
 * the public client contracts of DeepSeek Harness 0.1.1-rc.2; they exist so
 * this out-of-tree bundle builds without a source checkout of the monorepo.
 * Keep them in sync with the tested release in compatibility.json.
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** One registered settings/plugins tab row. */
  export interface SettingsTabEntry {
    readonly component: unknown
    readonly options: { readonly id: string; readonly order: number; readonly label: string | (() => string) }
    readonly locale: string
  }
  /** Slot registry: the settings.plugins.tab extension point owner. */
  export interface SlotRegistry {
    inject(slot: string, register: () => unknown): unknown
    register(options: {
      name: string
      id: string
      order: number
      label: string | (() => string)
      locale: string
      inject: () => unknown
    }, component: unknown): unknown
    entries(slot: string): readonly SettingsTabEntry[]
  }
  /** Browser-side Cordis context face exposed to client plugins. */
  export interface ClientContext {
    readonly slots: SlotRegistry
    readonly locale: LocaleApi
    readonly connection?: ClientConnectionHandle
    /** Register a reversible effect labeled for diagnostics. */
    effect(fn: () => unknown, label?: string): unknown
  }
  export interface LocaleApi {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: string) => string
  }
  export interface ClientConnectionHandle {
    readonly rpc: {
      call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }>
    }
  }
}
