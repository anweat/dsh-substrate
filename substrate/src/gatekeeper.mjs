/**
 * The gatekeeper plugin: predicts a composition's conflicts before the
 * registrations that would throw, and either reports or refuses.
 *
 * Two things make it work, both established by experiment:
 *
 *   it runs first    `inject` is an entry option, so the substrate's patch
 *                    layer can add `inject: [substrateGate]` to third-party
 *                    rows whose source it does not control. Cordis's dependency
 *                    resolution then activates this plugin before them. File
 *                    position alone guarantees nothing.
 *   it reads entries `ctx.loader.entries()` is complete before those fibers
 *                    apply, so the conflict is visible while it is still
 *                    preventable.
 *
 * **Injected rows depend on this plugin.** A row given `inject: [substrateGate]`
 * does not activate without it — so the patch layer should inject only the rows
 * that actually need arbitration, keeping a substrate failure from taking down
 * plugins that were never in conflict.
 *
 * @module dsh-conflict-substrate/gatekeeper
 */

import { predict, renderReport } from './predict.mjs'

/** What to do when the prediction finds something that will not boot. */
export const ON_CRITICAL = Object.freeze(['report', 'veto'])

/**
 * Apply the gatekeeper.
 *
 * @param ctx - the plugin context; needs `loader` to read the composed rows.
 * @param config - `{ catalog, policy, onCritical, shippedTools, shippedRoutes, log }`.
 * @returns nothing; the service it provides is what injected rows wait on.
 */
export function apply(ctx, config = {}) {
  const {
    catalog = new Map(),
    policy = {},
    onCritical = 'report',
    shippedTools = new Set(),
    shippedRoutes = new Set(),
    log = (line) => { ctx.logger?.('substrate')?.warn?.(line) ?? console.warn(`[substrate] ${line}`) },
  } = config

  const entries = [...ctx.loader.entries()].map(entry => ({
    id: entry.options?.id ?? entry.id,
    name: entry.options?.name ?? '',
    disabled: entry.disabled === true,
    config: entry.options?.config,
  }))

  const report = predict(entries, { catalog, policy, shippedTools, shippedRoutes })
  for (const line of renderReport(report)) log(line)

  // Refuse BEFORE providing. The rows this gatekeeper guards wait on
  // `substrateGate`, so providing it first satisfies their dependency and they
  // proceed to the very registration the veto exists to prevent — the throw
  // has to come while the gate is still shut.
  if (onCritical === 'veto' && report.fatal.length > 0) {
    const detail = report.fatal
      .map(d => `${d.kind} "${d.target}" ← ${(d.contenders ?? []).join(', ')}`)
      .join('; ')
    throw new Error(
      `dsh-conflict-substrate: 这套组合有 ${report.fatal.length} 处会导致注册抛错的冲突,已拒绝启动 — ${detail}`,
    )
  }

  ctx.provide('substrateGate')
  ctx.set('substrateGate', {
    report,
    /** Whether a given row was predicted to lose a contended cell. */
    verdictFor: (entryId) => report.decisions.filter(d =>
      (d.actions ?? []).some(a => a.owner === entryId)),
  })
}

export const name = 'dsh-conflict-gatekeeper'
export const inject = ['loader']
export default apply
