/**
 * L3 — the realm proxy.
 *
 * Some registries have no scope model at all: `webServer` is a flat
 * `Map<path, route>` that throws on a duplicate, so two plugins claiming one
 * path cannot both mount and there is no layering to fall back on. The only
 * remedy the runtime permits is to put a proxy in front of them.
 *
 * The shape is fixed by two facts established in the lab:
 *
 *   one instance per realm   a realm holds exactly one implementation, so a
 *                            per-plugin shim is wrong — `provide()` throws on
 *                            the second registration under the same symbol.
 *   caller attribution       Cordis rebinds `this.ctx` to whichever context
 *                            reads the service, so that one instance can tell
 *                            which plugin is calling and rewrite accordingly.
 *
 * This module is the rewrite policy only — pure, testable, and free of any
 * harness import. The plugin half binds it to a real service.
 *
 * @module dsh-conflict-substrate/realm-proxy
 */

/**
 * Build the path rewriting plan a realm proxy applies.
 *
 * @param decisions - arbitration output; only `isolate` actions matter here.
 * @returns owner → (declared path → path actually registered).
 */
export function rewritePlan(decisions) {
  const plan = new Map()
  for (const d of decisions) {
    if (d.remedy !== 'isolate') continue
    for (const a of d.actions ?? []) {
      if (a.action !== 'isolate') continue
      if (!plan.has(a.owner)) plan.set(a.owner, new Map())
      plan.get(a.owner).set(a.from, a.to)
    }
  }
  return plan
}

/**
 * Resolve what a route registration should actually claim.
 *
 * Unrewritten paths pass through unchanged: a proxy that renamed everything
 * would break every plugin that documents its own endpoint, and only the
 * losing claimant of a contended path needs to move.
 *
 * @param plan - from {@link rewritePlan}.
 * @param owner - the calling package, as the proxy read it from `this.ctx`.
 * @param path - the path the plugin asked for.
 * @returns the path to register, and whether it was rewritten.
 */
export function resolveRoute(plan, owner, path) {
  const rewritten = plan.get(owner)?.get(path)
  return rewritten === undefined
    ? { path, rewritten: false }
    : { path: rewritten, rewritten: true, declared: path }
}

/**
 * A realm proxy over a route registry, as a plain object so it can be tested
 * without a harness.
 *
 * `real` is the root registry — inside a realm the substrate reaches it through
 * `ctx.root`, whose isolate map the realm remap never touched. `ownerOf` is how
 * the proxy attributes a call; in the plugin half it reads the calling
 * context's fiber, and in tests it is supplied directly.
 *
 * @param options - the real registry, the rewrite plan, and the attribution hook.
 * @returns an object with the registry's own surface.
 */
export function createRouteProxy({ real, plan, ownerOf }) {
  /** Every rewrite actually performed, for the report the substrate surfaces. */
  const applied = []

  const register = (route) => {
    const owner = ownerOf()
    const resolved = resolveRoute(plan, owner, route.path)
    if (resolved.rewritten) applied.push({ owner, declared: resolved.declared, actual: resolved.path })
    // The disposer is the real registry's: ownership of the registration stays
    // with the fiber that made it, exactly as it would without the proxy.
    return real.register({ ...route, path: resolved.path })
  }

  return {
    register,
    /** Upgrade routes contend on the same path table and take the same rewrite. */
    registerUpgrade: (route) => {
      const owner = ownerOf()
      const resolved = resolveRoute(plan, owner, route.path)
      if (resolved.rewritten) applied.push({ owner, declared: resolved.declared, actual: resolved.path })
      return real.registerUpgrade({ ...route, path: resolved.path })
    },
    /** What the proxy moved, so a UI can tell a user where an endpoint went. */
    rewrites: () => applied.slice(),
  }
}
