/**
 * The substrate plugin, browser half: one card in the plugin settings tab.
 *
 * `settings.plugin.item` is a keyed slot that `ui-settings-plugins` declares,
 * and its tab renders the INTERSECTION of two ledgers — the namespaces the Host
 * serves and the cards registered into the slot. Four things have to line up or
 * the card silently does not appear: no error, no console line, and the plugin
 * still listed in the boot graph:
 *
 *   - the Host half registers `NS` as a settings namespace; a card whose key no
 *     served namespace matches is dropped by `ConfigurablePluginsTabController`
 *   - `locale` in this plugin's `inject`, and a dictionary registered before
 *     the slot entry, since the card reads its copy through `t`
 *   - `locale: NS` on the registration itself
 *   - `@deepseek-ai/dsh-client-ui-settings-plugins` in `dsh.client.inject`, so
 *     this waits for the package that declares the slot
 *
 * All four were missing at one point here, and every time the symptom was
 * identical: a card that had rendered a moment earlier simply being gone.
 */
import { SubstrateCardController, type Scope, type SubstrateCardState } from './controller.js'
import { PatchController, type PatchState, type Rpc } from './patch-controller.js'
import { en, zh } from './locales.js'
import { ensureStyles } from './styles.js'
import { SubstrateCard } from './SubstrateCard.js'

/** The settings namespace, the card key, and the locale namespace are one name. */
export const NS = 'dsh-substrate'

export const name = 'dsh-substrate/client'
export const inject = ['slots', 'locale', 'settingsScope', 'connection']

/** What the card renders: locale accessor plus the two faces it drives. */
export interface SubstrateCardProps {
  /** Locale accessor bound from the registered dictionary. */
  t: (key: keyof typeof zh) => string
  /** Subscribe to the settings form state; bound from `hooks.substrateCard`. */
  useSubstrateCard: <R>(selector: (snapshot: SubstrateCardState) => R) => R
  /** Subscribe to the patch row's state; bound from `hooks.substratePatch`. */
  useSubstratePatch: <R>(selector: (snapshot: PatchState) => R) => R
  /** Stage text for the settle-window field. */
  edit: (text: string) => void
  /** Stage a clear, so the field re-inherits the composition layer. */
  reset: () => void
  /** Write the staged edit. */
  save: () => void
  /** Drop the staged edit. */
  discard: () => void
}

/** The part of the client Context this plugin uses. */
interface ClientContext {
  locale: { register(ns: string, dictionaries: Record<string, unknown>): () => void }
  settingsScope: { bind(spec: { namespace: string }): Scope }
  connection: { rpc: Rpc }
  slots: {
    inject(name: string, body: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(action: () => (() => void) | undefined, label: string): void
}

/**
 * Mount the card.
 * @param ctx - the client plugin context.
 * @returns nothing.
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-substrate: card dictionaries')

  const settings = new SubstrateCardController(ctx.settingsScope.bind({ namespace: NS }))
  ctx.effect(() => () => { settings.dispose() }, 'dsh-substrate: settings controller')

  const patch = new PatchController(ctx.connection.rpc)
  ctx.effect(() => () => { patch.dispose() }, 'dsh-substrate: patch controller')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: () => {
      const settingsFace = settings.inject()
      const patchFace = patch.inject()
      return {
        ...settingsFace,
        ...patchFace,
        hooks: { ...settingsFace.hooks, ...patchFace.hooks },
      }
    },
  }, SubstrateCard))
}
