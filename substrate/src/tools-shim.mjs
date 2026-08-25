/**
 * L3 — the boot-time tools shim.
 *
 * Two mechanisms were verified separately and never joined. A loader `isolate`
 * entry option puts a different service instance in front of a subtree with no
 * upstream change, and the real `ToolRuntime` lets two scopes claim one tool
 * name because the registry merges scope chains with nearer-shadows-farther.
 * Joining them is what lets a boot-time plugin — which registers long before
 * any agent exists, straight into the root registry — land in a scope instead.
 *
 * This is that join: mounted inside a `cordis:group` carrying
 * `isolate: { tools: <realm> }`, it provides the `tools` every row in that
 * group resolves, and forwards each registration into a per-owner scope on the
 * root runtime. Names are never rewritten; the scope chain decides which one an
 * agent sees.
 *
 * The registration path looks indirect and is not incidental. A scope Context
 * is not a plugin fiber, and Cordis refuses a bare `ctx.tools` read without
 * `inject`, so a registration has to arrive through a real fiber mounted in the
 * scope. That is what `Registrar` is.
 *
 * @module tools-shim
 */

/** Where a root Context carries the scopes its shims minted. */
const SCOPE_LEDGER = Symbol.for('dsh-substrate: tools scopes')

/**
 * The owner-to-scope ledger on a root Context, created on first read.
 *
 * A scope nobody can name is a scope nobody can bind, and an unbound scope's
 * tools stay invisible to every agent forever — the `layer` remedy would then
 * quietly delete the capability it claims to preserve. Publishing the scopes
 * here is what lets the binding half find them.
 *
 * @param {object} root The root Context.
 * @returns {Map<string, { key: symbol, scope: object }>} Owner name to its scope key and handle.
 */
export function toolScopeLedger(root) {
  const existing = root[SCOPE_LEDGER]
  if (existing !== undefined) return existing
  const ledger = new Map()
  root[SCOPE_LEDGER] = ledger
  return ledger
}

/** Carries one definition into a scope through a real plugin fiber. */
function dshSubstrateRegistrar(ctx, config) {
  config.collect(ctx.tools.register(config.def))
}
dshSubstrateRegistrar.inject = ['tools']

/**
 * Build the shim plugin.
 *
 * Kept as a factory rather than a module-level plugin because the scope
 * constructor comes from the harness checkout under test, which a standalone
 * `.mjs` in this package cannot import by path.
 *
 * @param {(ctx: object, key: symbol) => { ctx: object }} createScope The harness `createScope`.
 * @returns {object} A Cordis plugin: `apply(ctx, config)` with `config.scope` naming the owner.
 */
export function makeToolsShim(createScope) {
  function dshSubstrateToolsShim(ctx, config = {}) {
    const owner = config.scope ?? 'dsh-substrate'
    // The root runtime, reached past this realm's own isolate remap.
    const runtime = ctx.root.get('tools')
    if (runtime === undefined) throw new Error('tools-shim: no tools service on the root context')
    // `createScope` returns no handle on the key it was given, and the key is
    // what `tools.schemas(scope)` and any later chain binding need, so both go
    // into the ledger.
    const key = Symbol(owner)
    const scope = createScope(ctx.root, key)
    toolScopeLedger(ctx.root).set(owner, { key, scope })

    ctx.provide('tools')
    ctx.set('tools', {
      ...runtime,
      /**
       * Register into this shim's scope rather than the global namespace.
       * @param {object} def Tool definition.
       * @returns {() => void} Disposer removing the registration.
       */
      register(def) {
        let dispose = () => {}
        // Mounting is synchronous for a synchronous plugin body, so the
        // disposer is captured before this returns; a caller that stores it
        // gets the real one, not a placeholder.
        void scope.ctx.plugin(dshSubstrateRegistrar, { def, collect: d => { dispose = d } })
        return () => { dispose() }
      },
    })
  }
  // No `inject: ['tools']`. Inside this group that name resolves through the
  // realm to the very service this shim provides, so declaring it would make
  // the shim wait on itself. The root runtime is read past the remap instead,
  // exactly as the verified isolate shim does.
  return dshSubstrateToolsShim
}
