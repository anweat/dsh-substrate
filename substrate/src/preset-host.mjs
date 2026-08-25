/**
 * The preset-host mode: repair rather than refuse.
 *
 * The gatekeeper can only say no, because by the time anything is running the
 * registrations have already happened. This mode intervenes where composition
 * is still being decided — at agent setup — and gives each arbitrated plugin
 * its own scope on the agent's ancestor chain, so contenders coexist under
 * their real names.
 *
 * **Why a wrapper works here.** `mount()` performs the one binding an agent
 * key gets (`bindScopeParent` refuses a second), so wrapping it and calling
 * through would leave the chain already fixed at `agent → standing`. The way
 * around is a public method the roster already exposes: `standingKeyFor(id)`
 * composes a preset's standing mount and returns its key while starting "no
 * agent, no session, and no turn". The substrate takes that key, builds the
 * plugin chain above it, and performs the agent binding itself.
 *
 *     standing ← plugin(farthest) ← … ← plugin(nearest) ← agent
 *
 * Nearer shadows farther, so the arbitrated winner is the one an agent
 * resolves — without renaming anything the model sees.
 *
 * @module dsh-conflict-substrate/preset-host
 */

/**
 * Build the plugin scope chain above a standing mount.
 *
 * @param options - `{ standingKey, chain, createScope, keyOf }`.
 *   `chain` is nearest-first, as {@link planScopeChain} returns it;
 *   `createScope(key, parent)` mints one scope; `keyOf(owner)` names it.
 * @returns the key an agent should be parented to, plus the scopes minted.
 */
export function buildPluginChain({ standingKey, chain, createScope, keyOf }) {
  if (chain.length === 0) return { head: standingKey, scopes: [] }
  const scopes = []
  // Farthest first: a parent must exist before a child can name it, and the
  // farthest plugin's parent is the preset's standing mount.
  let parent = standingKey
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const owner = chain[i]
    const key = keyOf(owner)
    scopes.push({ owner, key, parent, scope: createScope(key, parent) })
    parent = key
  }
  // `parent` now holds the nearest plugin's key — what the agent binds to.
  return { head: parent, scopes }
}

/**
 * Wrap the preset roster so agents join through the substrate's chain.
 *
 * Every method other than `mount` and `recompose` delegates untouched: they
 * read or edit the roster and have nothing to do with scope ancestry. Keeping
 * the list explicit rather than proxying by `Proxy` is deliberate — a method
 * added upstream should fail visibly here rather than silently bypass
 * arbitration.
 *
 * @param options - `{ real, plan, createScope, keyOf, bindAgent, onCompose }`.
 * @returns an object with the roster's surface.
 */
export function wrapPresetRoster({ real, plan, createScope, keyOf, bindAgent, onCompose }) {
  const composed = new Map()

  const compose = async (agentCtx, id) => {
    // Compose the preset WITHOUT letting it bind the agent.
    const standingKey = await real.standingKeyFor(id)
    const chain = plan(id) ?? []
    const built = buildPluginChain({ standingKey, chain, createScope, keyOf })
    bindAgent(agentCtx, built.head)
    composed.set(agentCtx, { id, standingKey, chain, head: built.head })
    onCompose?.({ id, standingKey, chain, head: built.head })
    return built
  }

  return {
    async mount(agentCtx, id) {
      await compose(agentCtx, id)
      return real.resolve(id)
    },
    async recompose(agentCtx, id) {
      // Recompose re-links an agent that is already bound, which only the
      // original binding may do; the roster owns that authority, so this
      // delegates rather than re-implementing the re-link.
      return real.recompose(agentCtx, id)
    },
    /** What the substrate did for one agent, for reporting and tests. */
    compositionOf: agentCtx => composed.get(agentCtx),

    list: (...args) => real.list(...args),
    resolve: (...args) => real.resolve(...args),
    read: (...args) => real.read(...args),
    copy: (...args) => real.copy(...args),
    remove: (...args) => real.remove(...args),
    composeFrom: (...args) => real.composeFrom(...args),
    composedPreset: (...args) => real.composedPreset(...args),
    standingKeyFor: (...args) => real.standingKeyFor(...args),
    serviceFor: (...args) => real.serviceFor(...args),
  }
}

/** Methods the wrapper forwards or overrides; anything else upstream adds is unhandled. */
export const WRAPPED_SURFACE = Object.freeze([
  'mount', 'recompose', 'list', 'resolve', 'read', 'copy', 'remove',
  'composeFrom', 'composedPreset', 'standingKeyFor', 'serviceFor',
])

/**
 * Check a live roster against the surface this wrapper knows.
 *
 * Run at substrate mount: a method the roster gained upstream would otherwise
 * be missing from the wrapper and fail at the call site, far from the cause.
 *
 * @param real - the roster being wrapped.
 * @returns method names present on the roster but not forwarded.
 */
export function unhandledMethods(real) {
  const known = new Set(WRAPPED_SURFACE)
  const own = new Set()
  for (let o = real; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || k.startsWith('_')) continue
      if (typeof real[k] === 'function') own.add(k)
    }
  }
  return [...own].filter(k => !known.has(k)).sort()
}
