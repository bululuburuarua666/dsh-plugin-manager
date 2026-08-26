import { PluginManagerTab } from './PluginManagerTab.tsx';
import { zh, en } from './locales.ts';
export const inject = ['slots', 'locale'];
/** The channel caller bound to the live connection, when it exists. */
function channelCallerOf(connection) {
    if (connection === undefined)
        return null;
    return { call: (channel, endpoint, payload, signal) => connection.rpc.call(channel, endpoint, payload, signal) };
}
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register('dsh-plugin-manager', { zh, en }), 'dsh-plugin-manager: dictionaries');
    const t = ctx.locale.bind('dsh-plugin-manager');
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'manager',
        order: 20,
        label: () => t('tab'),
        locale: 'dsh-plugin-manager',
        inject: () => ({ rpc: channelCallerOf(ctx.get('connection')), t }),
    }, PluginManagerTab));
}
