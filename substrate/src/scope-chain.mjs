/**
 * L3 — the scope chain planner.
 *
 * Turns `layer` decisions into the one thing the runtime can actually carry: a
 * linear scope chain. `dsh-scope` binds each key to at most one parent and
 * `scopeChainOf` returns a line, so an agent has exactly one ancestor order and
 * every layered decision must be satisfiable by that single order.
 *
 * That constraint is not a formality. A decision says "A shadows B on this
 * name", which on a nearest-first chain means A must precede B. Two decisions
 * can disagree — A ahead of B for one tool, B ahead of A for another — and no
 * linear chain satisfies both. This planner finds those cycles instead of
 * emitting an order that silently drops one of them.
 *
 * @module dsh-conflict-substrate/scope-chain
 */

/**
 * Plan the chain.
 *
 * @param decisions - arbitration output; only `layer` actions constrain order.
 * @param policy - `{ order }` supplies the tie-break, so an unconstrained pair
 *   still lands in a stable, declared position rather than an arbitrary one.
 * @returns the nearest-first chain, the constraints it satisfies, and the ones
 *   no linear chain can.
 */
export function planScopeChain(decisions, policy = {}) {
  /** owner → owners it must precede (it shadows them). */
  const edges = new Map()
  /** Every owner the chain has to place. */
  const nodes = new Set()
  const constraints = []

  const link = (winner, loser, cell) => {
    nodes.add(winner)
    nodes.add(loser)
    if (!edges.has(winner)) edges.set(winner, new Set())
    edges.get(winner).add(loser)
    constraints.push({ winner, loser, cell })
  }

  for (const d of decisions) {
    if (d.remedy !== 'layer') continue
    for (const a of d.actions ?? []) {
      if (a.action !== 'layer') continue
      // A shipped winner is not on the chain — the harness registers globally,
      // and every plugin scope already shadows the global layer. Only
      // third-party precedence needs ordering.
      if (d.winner === '<shipped>') { nodes.add(a.owner); continue }
      link(d.winner, a.owner, d.cell)
    }
  }

  const declared = new Map((policy.order ?? []).map((name, i) => [name, i]))
  const tieBreak = (a, b) => {
    const ra = declared.get(a) ?? Number.MAX_SAFE_INTEGER
    const rb = declared.get(b) ?? Number.MAX_SAFE_INTEGER
    return ra - rb || a.localeCompare(b)
  }

  // Kahn's algorithm, taking the tie-break's preferred node whenever several
  // are ready — that is what makes the chain reproducible across runs.
  const indegree = new Map([...nodes].map(n => [n, 0]))
  for (const [, tos] of edges) for (const to of tos) indegree.set(to, (indegree.get(to) ?? 0) + 1)

  const ready = [...nodes].filter(n => (indegree.get(n) ?? 0) === 0).sort(tieBreak)
  const chain = []
  while (ready.length > 0) {
    const next = ready.shift()
    chain.push(next)
    for (const to of edges.get(next) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1
      indegree.set(to, left)
      if (left === 0) {
        ready.push(to)
        ready.sort(tieBreak)
      }
    }
  }

  // Whatever Kahn could not place sits on at least one cycle.
  const placed = new Set(chain)
  const cyclic = [...nodes].filter(n => !placed.has(n))
  const unsatisfiable = constraints.filter(c => cyclic.includes(c.winner) && cyclic.includes(c.loser))

  // The cyclic owners still need a seat, or their contributions vanish from the
  // composition entirely. Appending them in tie-break order keeps the chain
  // total and makes exactly which constraints were sacrificed reportable.
  const appended = cyclic.slice().sort(tieBreak)
  const full = [...chain, ...appended]
  const position = new Map(full.map((owner, i) => [owner, i]))
  const violated = constraints.filter(c => position.get(c.winner) > position.get(c.loser))

  return {
    chain: full,
    satisfied: constraints.length - violated.length,
    constraints: constraints.length,
    violated,
    cyclicOwners: appended,
    unsatisfiable,
  }
}

/**
 * Render the chain as the parent bindings a substrate installs at agent setup.
 *
 * `createScope(ctx, key, { parent })` binds once and the chain reads
 * nearest-first, so the nearest scope's parent is the next one out, and the
 * farthest scope has no parent of its own.
 *
 * @param chain - nearest-first owners from {@link planScopeChain}.
 * @param keyOf - maps an owner to its scope key (a substrate-minted symbol).
 * @returns bindings in the order they must be installed, farthest first.
 */
export function bindingsFor(chain, keyOf = owner => owner) {
  const bindings = []
  // Farthest first: a parent must exist before a child names it.
  for (let i = chain.length - 1; i > 0; i -= 1) {
    bindings.push({ key: keyOf(chain[i - 1]), parent: keyOf(chain[i]), owner: chain[i - 1] })
  }
  return bindings
}
