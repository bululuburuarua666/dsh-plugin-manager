/**
 * Client half (T01 skeleton): contributes the Plugin manager tab to
 * Settings → Plugins. The tab body is a placeholder until T05 ports the
 * real inventory/origin/lifecycle UI; the registration wiring is final.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { zh, en } from './locales.ts'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-plugin-manager', { zh, en }), 'dsh-plugin-manager: dictionaries')

  const t = ctx.locale.bind('dsh-plugin-manager')
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manager',
    order: 20,
    label: () => t('tab'),
    locale: 'dsh-plugin-manager',
    inject: () => ({ ready: true }),
  }, PlaceholderTab))
}

function PlaceholderTab({ label }: { label: string }) {
  return <section data-plugin-manager-tab>{label}</section>
}
