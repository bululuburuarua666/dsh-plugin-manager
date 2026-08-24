/** Read-only Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  PluginInventorySettingsTab,
  type PluginInventorySettingsTabInjected,
  type PluginLifecycleInjected,
  type PluginLifecycleResult,
} from './PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  // The lifecycle namespace is addressed lazily and WITHOUT the inject
  // requirement: an older Host without the service must keep the inventory
  // tab working, just without controls. `ctx.get` reads the store without
  // the inject check, so a missing service resolves to undefined and the
  // face degrades to UNAVAILABLE instead of crashing the tab. The namespace
  // is re-read on every call so a late $mount (or an HMR remount) is seen.
  const lifecycle = (): PluginLifecycleInjected => {
    const call = async (
      method: 'capabilities' | 'preview' | 'execute' | 'operation',
      args: readonly unknown[],
    ): Promise<PluginLifecycleResult<unknown>> => {
      try {
        const namespace = ctx.get('remote.pluginLifecycle') as
          | Record<string, (...rest: unknown[]) => Promise<{
            readonly ok: boolean
            readonly value?: unknown
            readonly error?: { readonly code: string }
          }>>
          | undefined
        const handler = namespace?.[method]
        if (handler === undefined) return { ok: false, code: 'UNAVAILABLE' }
        // Preserve the exact arity (zero-arg capabilities vs one-arg calls)
        // and the namespace receiver: the gateway validates argument counts
        // before dispatch, so a padded `undefined` would be rejected.
        const result = await Reflect.apply(handler, namespace, args)
        return result.ok
          ? { ok: true, value: result.value }
          : { ok: false, code: result.error?.code ?? 'INTERNAL' }
      } catch {
        return { ok: false, code: 'INTERNAL' }
      }
    }
    return {
      capabilities: () => call('capabilities', []),
      preview: input => call('preview', [input]),
      execute: input => call('execute', [input]),
      operation: input => call('operation', [input]),
    } as PluginLifecycleInjected
  }
  const injected = (): PluginInventorySettingsTabInjected => ({ list, lifecycle: lifecycle() })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}
