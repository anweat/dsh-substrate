/**
 * The substrate plugin, browser half: one card in the plugin settings tab.
 *
 * `settings.plugin.item` is a keyed slot that `ui-settings-plugins` declares
 * and renders whatever was registered into it, so a third-party card needs the
 * key and nothing else. `slots.inject` waits for that declaration rather than
 * assuming load order — the settings tab is a plugin too, and Cordis orders
 * activation by service availability, not by row position.
 */
import { createSubstrateCard, NS, type BoundSettingsScope } from './controller.js'
import { SubstrateCard } from './SubstrateCard.js'

/**
 * The part of the client Context this plugin uses.
 *
 * Declared locally rather than imported from `@deepseek-ai/dsh-client-runtime`,
 * which cannot be installed from npm today — see `controller.ts`. Everything
 * named here is resolved at runtime from the shell's module table, so the
 * missing types cost checking, not behaviour.
 */
interface ClientContext {
  slots: {
    inject(name: string, body: () => Generator<unknown>): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  settingsScope: { bind(spec: { namespace: string }): BoundSettingsScope }
  effect(action: () => () => void, label: string): void
}

export const name = 'dsh-substrate/client'
export const inject = ['slots', 'settingsScope']

/**
 * Mount the card.
 * @param ctx - the client plugin context.
 * @returns nothing.
 */
export function apply(ctx: ClientContext): void {
  const card = createSubstrateCard(ctx.settingsScope.bind({ namespace: NS }))
  ctx.effect(() => () => { card.dispose() }, 'dsh-substrate: settings card')

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      inject: () => ({ store: card.store, toggle: card.toggle }),
    }, SubstrateCard)
  })
}
