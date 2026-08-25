/**
 * L2 — arbitration.
 *
 * A pure function from contributions plus a policy to decisions. It touches no
 * harness API, so it can be unit-tested and replayed over the whole ecosystem
 * corpus offline, and a harness change never reaches it.
 *
 * The remedies are not interchangeable — each one is the response the runtime
 * actually permits for that kind:
 *
 *   layer        scope layering; every claimant keeps the target under its own
 *                name, precedence is the declared chain order. Tools only.
 *   rename       the loser's target is prefixed. Safe where nothing outside
 *                the tree addresses it by name (entry ids); NOT for tools,
 *                whose names the model sees.
 *   isolate      a realm-private proxy rewrites the target on the way through.
 *                For registries with no scope model (routes).
 *   drop-client  the loser's browser half is withheld. The only lever the
 *                client plane offers — it has no configuration seam.
 *   report-only  the runtime composes it fine, or no remedy exists; the
 *                decision records what will happen rather than changing it.
 *
 * @module dsh-conflict-substrate/arbitrate
 */

import { KIND_ARITY, byCell, parseCell } from './model.mjs'

/**
 * Names no layer may take, however few claimants there are.
 *
 * `run_code` is the Code Mode presentation transport: the tool registry rejects
 * it unconditionally and says it "cannot be registered or shadowed", so scope
 * layering — the remedy for every other tool-name conflict — does not apply.
 * A reserved claim has no repair; the only honest outcome is to drop it and
 * say so. Found by registering the whole corpus against the real registry, not
 * by reading the source.
 */
export const RESERVED_TOOL_NAMES = Object.freeze(['run_code'])

/** How each kind is remedied when more than one package claims one cell. */
export const DEFAULT_REMEDIES = Object.freeze({
  tool: 'layer',
  'entry-id': 'rename',
  route: 'isolate',
  'slot-single': 'drop-client',
  'slot-keyed': 'drop-client',
  'config-row': 'report-only',
  service: 'report-only',
  event: 'report-only',
})

/**
 * @typedef {object} Policy
 * @property {readonly string[]} [order] - packages in precedence order, highest first.
 * @property {'first-seen'|'alphabetical'} [fallback] - ordering for packages the policy does not name.
 * @property {Record<string,string>} [remedies] - per-kind remedy overrides.
 * @property {Set<string>} [shippedTools] - tool names the harness itself registers.
 * @property {Set<string>} [shippedRoutes] - route paths the harness itself registers.
 */

/**
 * Rank packages: named ones in declared order, the rest after them by the
 * fallback rule. A stable total order is what makes arbitration reproducible —
 * without it the same input can yield different winners between runs, which
 * would break the idempotence a config hot-reload depends on.
 */
function ranker(policy, allOwners) {
  const declared = new Map((policy.order ?? []).map((name, i) => [name, i]))
  const rest = [...allOwners].filter(o => !declared.has(o))
  if ((policy.fallback ?? 'alphabetical') === 'alphabetical') rest.sort()
  const base = declared.size
  const fallbackRank = new Map(rest.map((name, i) => [name, base + i]))
  return owner => declared.get(owner) ?? fallbackRank.get(owner) ?? Number.MAX_SAFE_INTEGER
}

/** Prefix a loser's target, keeping it a legal identifier for tools/ids. */
const prefixed = (owner, target) => `${owner.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}__${target}`

/**
 * Arbitrate a set of contributions.
 *
 * @param contributions - every contribution in the composition under test.
 * @param policy - precedence and remedy configuration.
 * @returns decisions (one per contended cell), per-package outcomes, and totals.
 */
export function arbitrate(contributions, policy = {}) {
  const remedies = { ...DEFAULT_REMEDIES, ...(policy.remedies ?? {}) }
  const shippedTools = policy.shippedTools ?? new Set()
  const shippedRoutes = policy.shippedRoutes ?? new Set()
  const owners = new Set(contributions.map(c => c.owner))
  const rankOf = ranker(policy, owners)

  const reserved = new Set(policy.reservedToolNames ?? RESERVED_TOOL_NAMES)
  const decisions = []
  for (const [cell, claims] of byCell(contributions)) {
    const { kind, target, entryKey } = parseCell(cell)
    const distinct = [...new Set(claims.map(c => c.owner))]

    // A reserved name is refused by the registry outright, so no layering,
    // renaming, or isolation makes the claim work. One claimant is already a
    // failure, and every claimant loses.
    if (kind === 'tool' && reserved.has(target)) {
      decisions.push({
        cell, kind, target, entryKey, contested: true, vsShipped: false, reserved: true,
        remedy: 'drop', winner: '<reserved>', contenders: distinct,
        actions: distinct.map(owner => ({ owner, action: 'drop', target, why: 'reserved-name' })),
        severity: 'critical',
      })
      continue
    }

    const vsShipped = (kind === 'tool' && shippedTools.has(target))
      || (kind === 'route' && shippedRoutes.has(target))

    // Additive kinds compose; recording them keeps the decision set a complete
    // account of the composition rather than only its problems.
    if (KIND_ARITY[kind] === 'additive') {
      if (distinct.length > 1) {
        decisions.push({
          cell, kind, target, entryKey, contested: false, vsShipped: false,
          remedy: 'none', winner: null, actions: [],
          note: `${distinct.length} packages compose here (${kind} is additive)`,
        })
      }
      continue
    }

    // One package claiming a cell twice is its own composition, not contention.
    if (distinct.length <= 1 && !vsShipped) continue

    const ordered = distinct.slice().sort((a, b) => rankOf(a) - rankOf(b))
    const remedy = remedies[kind] ?? 'report-only'
    // A shipped claimant always outranks a third party: the harness registered
    // first and its name is what the rest of the product refers to.
    const winner = vsShipped ? '<shipped>' : ordered[0]
    const losers = vsShipped ? ordered : ordered.slice(1)

    const actions = losers.map((owner) => {
      switch (remedy) {
        case 'layer':
          // Everyone keeps the name; the chain rank decides who an agent sees.
          return { owner, action: 'layer', target, rank: ordered.indexOf(owner) + (vsShipped ? 1 : 0) }
        case 'rename':
          return { owner, action: 'rename', from: target, to: prefixed(owner, target) }
        case 'isolate':
          return { owner, action: 'isolate', from: target, to: `/${prefixed(owner, target.replace(/^\//, ''))}` }
        case 'drop-client':
          return { owner, action: 'drop-client', target }
        default:
          return { owner, action: 'report-only', target }
      }
    })

    decisions.push({
      cell, kind, target, entryKey, contested: true, vsShipped,
      remedy, winner, contenders: ordered, actions,
      severity: vsShipped || kind === 'tool' || kind === 'route' ? 'critical'
        : kind === 'entry-id' || kind === 'config-row' ? 'high' : 'medium',
    })
  }

  return { decisions, outcomes: outcomesOf(contributions, decisions), totals: totalsOf(decisions) }
}

/**
 * Per-package outcome after arbitration.
 *
 * `intact` keeps every contribution under its declared target; `adapted` keeps
 * them all but at least one was renamed, isolated, or layered; `degraded` lost
 * its browser half. The distinction matters because only `degraded` is a
 * functional loss the user would notice — the rest still do their job.
 */
function outcomesOf(contributions, decisions) {
  const byOwner = new Map()
  for (const c of contributions) {
    if (!byOwner.has(c.owner)) byOwner.set(c.owner, { owner: c.owner, contributions: 0, adapted: [], dropped: [] })
    byOwner.get(c.owner).contributions += 1
  }
  for (const d of decisions) {
    for (const a of d.actions ?? []) {
      const rec = byOwner.get(a.owner)
      if (rec === undefined) continue
      if (a.action === 'drop-client' || a.action === 'drop') {
        rec.dropped.push({ kind: d.kind, target: d.target, ...(a.why === undefined ? {} : { why: a.why }) })
      }
      else if (a.action !== 'report-only') rec.adapted.push({ kind: d.kind, target: d.target, action: a.action })
    }
  }
  return [...byOwner.values()].map(r => ({
    ...r,
    status: r.dropped.length > 0 ? 'degraded' : r.adapted.length > 0 ? 'adapted' : 'intact',
  }))
}

/** Roll decisions and outcomes up to the numbers a report leads with. */
function totalsOf(decisions) {
  const contested = decisions.filter(d => d.contested)
  const byKind = {}
  const byRemedy = {}
  for (const d of contested) {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
    byRemedy[d.remedy] = (byRemedy[d.remedy] ?? 0) + 1
  }
  return { decisions: decisions.length, contested: contested.length, byKind, byRemedy }
}
