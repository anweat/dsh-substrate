/**
 * Predict conflicts from the ENTRY LIST, before the fibers that would throw.
 *
 * This is what makes a gatekeeper possible at all. `tools.register` throws
 * while a plugin's fiber applies, which is loader activation — long before any
 * agent exists, so an `agent/created` veto never gets its turn. But
 * `ctx.loader.entries()` is complete before those fibers activate, so a
 * gatekeeper that reads entries rather than registrations can speak first.
 *
 * What an entry carries is a module specifier, not a list of tool names, so
 * prediction needs a catalog: package name → what it contributes. That catalog
 * comes from the ecosystem scan and ships with the substrate; a package absent
 * from it is reported as unknown rather than assumed harmless.
 *
 * @module dsh-conflict-substrate/predict
 */

import { arbitrate } from './arbitrate.mjs'

/**
 * @typedef {object} LoaderEntryView
 * @property {string} id - the entry id.
 * @property {string} name - the module specifier.
 * @property {boolean} [disabled] - effective loader enablement.
 * @property {unknown} [config] - the row's config.
 */

/**
 * Turn entries into contributions using the catalog.
 *
 * **Ownership is the ROW, not the module.** One module can be mounted several
 * times with different config — the shipped `standard` preset does exactly that
 * with `dsh-tool-subagent` — and those instances contend with each other. Using
 * the module specifier as the owner would collapse them into one claimant and
 * report a real conflict as none. The specifier is still what the catalog is
 * keyed by; it just is not an identity.
 *
 * @param entries - the composed rows, as `ctx.loader.entries()` reports them.
 * @param catalog - module specifier → `{ tools?, routes?, slots?, services? }`.
 * @returns contributions, plus the entries the catalog could not describe.
 */
export function contributionsFromEntries(entries, catalog) {
  const contributions = []
  const unknown = []
  for (const entry of entries) {
    if (entry.disabled === true) continue
    const owner = entry.id
    const known = catalog.get(entry.name)
    if (known === undefined) {
      unknown.push({ id: entry.id, name: entry.name })
      continue
    }
    for (const t of known.tools ?? []) {
      contributions.push({ plane: 'host', kind: 'tool', target: t, owner, module: entry.name, source: entry.id })
    }
    for (const r of known.routes ?? []) {
      contributions.push({ plane: 'host', kind: 'route', target: r, owner, module: entry.name, source: entry.id })
    }
    for (const s of known.services ?? []) {
      contributions.push({ plane: 'host', kind: 'service', target: s, owner, module: entry.name, source: entry.id })
    }
    for (const s of known.slots ?? []) {
      contributions.push({
        plane: 'client',
        kind: `slot-${s.kind ?? 'list'}`,
        target: s.key ?? s,
        owner,
        module: entry.name,
        source: entry.id,
        entryKey: s.entryKey ?? null,
      })
    }
  }
  return { contributions, unknown }
}

/**
 * Predict what this composition will do.
 *
 * @param entries - the composed rows.
 * @param options - `{ catalog, policy, shippedTools, shippedRoutes }`.
 * @returns decisions, the fatal subset, and coverage of the prediction itself.
 */
export function predict(entries, { catalog = new Map(), policy = {}, shippedTools = new Set(), shippedRoutes = new Set() } = {}) {
  const { contributions, unknown } = contributionsFromEntries(entries, catalog)
  const { decisions, outcomes, totals } = arbitrate(contributions, { ...policy, shippedTools, shippedRoutes })

  // Only the kinds whose registry throws will actually stop a boot. The rest
  // are real conflicts but they degrade rather than abort, and reporting them
  // as fatal would train people to ignore the check.
  const fatal = decisions.filter(d => d.contested && (d.kind === 'tool' || d.kind === 'route' || d.kind === 'service'))

  return {
    decisions,
    outcomes,
    totals,
    fatal,
    coverage: {
      entries: entries.length,
      described: entries.length - unknown.length,
      unknown,
    },
  }
}

/**
 * Render a prediction as the lines a gatekeeper logs.
 *
 * Written to be read while a boot is failing: the fatal findings first, each
 * naming the rows involved, and the unknown count last so nobody reads a clean
 * report as proof when half the composition was undescribed.
 *
 * @param report - from {@link predict}.
 * @returns lines, most severe first.
 */
export function renderReport(report) {
  const lines = []
  for (const d of report.fatal) {
    const rows = (d.contenders ?? []).join(', ')
    lines.push(`会导致启动失败: ${d.kind} "${d.target}" 被 ${d.contenders?.length ?? 0} 个插件认领 — ${rows}`)
  }
  const degraded = report.outcomes.filter(o => o.status === 'degraded')
  if (degraded.length > 0) lines.push(`前端功能会被撤下: ${degraded.map(o => o.owner).join(', ')}`)
  const adapted = report.outcomes.filter(o => o.status === 'adapted')
  if (adapted.length > 0) lines.push(`将被分层或改写以共存: ${adapted.length} 个插件`)
  if (report.coverage.unknown.length > 0) {
    lines.push(`目录中没有的插件 ${report.coverage.unknown.length} 个,它们的冲突无法预测: `
      + report.coverage.unknown.slice(0, 5).map(u => u.name).join(', ')
      + (report.coverage.unknown.length > 5 ? ' …' : ''))
  }
  return lines
}
