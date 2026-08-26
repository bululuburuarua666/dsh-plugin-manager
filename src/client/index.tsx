/**
 * Client half: registers the Plugin manager tab under Settings → Plugins.
 * The tab mounts only when the manager channel exists (ctx.get('connection')
 * is inject-requirement-free); older Hosts keep both official tabs intact
 * and this one reports unavailable instead of blanking.
 */
import type { ClientContext, ClientConnectionHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { PluginManagerTab } from './PluginManagerTab.tsx'
import type { ChannelCaller } from './protocol.ts'
import { zh, en, type ManagerLocaleKey } from './locales.ts'

export const inject = ['slots', 'locale']

/** The channel caller bound to the live connection, when it exists. */
function channelCallerOf(connection: ClientConnectionHandle | undefined): ChannelCaller | null {
  if (connection === undefined) return null
  return { call: (channel, endpoint, payload, signal) => connection.rpc.call(channel, endpoint, payload, signal) }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-plugin-manager', { zh, en }), 'dsh-plugin-manager: dictionaries')

  const t = ctx.locale.bind('dsh-plugin-manager') as (key: ManagerLocaleKey) => string
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manager',
    order: 20,
    label: () => t('tab'),
    locale: 'dsh-plugin-manager',
    inject: () => ({ rpc: channelCallerOf(ctx.get('connection') as ClientConnectionHandle | undefined), t }),
  }, PluginManagerTab))
}
