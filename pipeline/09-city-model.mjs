/**
 * Build the city render model: a fixed four-level geometry the viewer draws in
 * full, plus the relatedness edges that decide where things stand.
 *
 *   layer   -> district (hexagonal plot)
 *   entry   -> block    (hexagonal plot inside a district)
 *   group   -> ONE hexagonal prism
 *   contribution -> ONE FLOOR of that prism
 *
 * Placement is not by weight order but by relation, so neighbours mean
 * something: packages from the same source group cluster, `inject` edges pull
 * a consumer next to its provider, and two entries contributing to the same
 * target are drawn together.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRepo, indexBaseline } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DSH = process.argv[2] ?? process.env.DSH_ROOT ?? ''
const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))
const view = JSON.parse(readFileSync(join(here, 'out/viewer-data.json'), 'utf8'))
const idx = indexBaseline(baseline)

/** Contended targets, keyed the way a contribution names them. */
const contended = new Map()
for (const c of view.contended) contended.set(`${c.kind}:${c.name}`, { sev: c.severity, pkgs: c.packages })
const VERB_KIND = { 'tool-register': 'tool', 'slot-register': 'slot', 'event-listen': 'event' }

/** Shipped packages, carrying the source group that makes two of them siblings. */
function shippedPackages(root) {
  const out = new Map()
  for (const g of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!g.isDirectory()) continue
    let pkgs = []
    try { pkgs = readdirSync(join(root, 'packages', g.name), { withFileTypes: true }) } catch { continue }
    for (const p of pkgs) {
      if (!p.isDirectory()) continue
      const dir = join(root, 'packages', g.name, p.name)
      if (!existsSync(join(dir, 'package.json'))) continue
      try {
        const r = analyzeRepo(dir, dir, idx)
        if (r.pkgName) out.set(r.pkgName, { group: g.name, contributions: r.contributions ?? [] })
      } catch { /* a package that fails to parse contributes nothing and is simply absent */ }
    }
  }
  return out
}

const shipped = shippedPackages(DSH)
process.stderr.write(`shipped packages indexed: ${shipped.size}\n`)

const VERB_GROUP = {
  'tool-register': 'tools', 'slot-register': 'slots', 'event-listen': 'events',
  'command-register': 'commands', 'service-provide': 'services',
}

/** Baseline entries carry the `inject` list, the tree's only real dependency edge. */
const injectOf = new Map(baseline.profiles.web.entries.filter(e => e.id).map(e => [e.id, e.inject ?? null]))

const layers = new Map()
for (const j of baseline.profiles.web.journal) {
  if (!['insert', 'override', 'disable'].includes(j.action)) continue
  const label = j.layer.split('/')[2] ?? j.layer
  if (!layers.has(label)) layers.set(label, [])
  const pkg = j.plugin !== null && j.plugin !== undefined ? shipped.get(j.plugin) : undefined
  const groups = new Map()
  for (const c of pkg?.contributions ?? []) {
    if (c.verb === 'slot-inject') continue
    const g = VERB_GROUP[c.verb] ?? 'other'
    if (!groups.has(g)) groups.set(g, [])
    const key = VERB_KIND[c.verb]
    const hit = key !== undefined && c.target !== null ? contended.get(`${key}:${c.target}`) : undefined
    groups.get(g).push({
      label: c.target ?? '<非字面量>',
      verb: c.verb,
      at: c.source,
      ...(hit ? { sev: hit.sev, pkgs: hit.pkgs } : {}),
    })
  }
  const injectRaw = injectOf.get(j.target)
  layers.get(label).push({
    label: j.target ?? '(匿名行)',
    action: j.action,
    module: j.plugin ?? null,
    pkgGroup: pkg?.group ?? null,
    inject: Array.isArray(injectRaw) ? injectRaw : (injectRaw?.required ?? []),
    groups: [...groups.entries()].map(([label, floors]) => ({ label, floors })),
  })
}

/**
 * Relatedness inside one district. Weights are ordinal, not physical: a shared
 * source group is a weak affinity, a shared contribution target is stronger
 * (they touch the same seat), and an inject edge is strongest (one cannot run
 * without the other).
 */
function edgesFor(entries) {
  const index = new Map(entries.map((e, i) => [e.label, i]))
  const pairs = new Map()
  const add = (a, b, w) => {
    if (a === b || a === undefined || b === undefined) return
    const k = a < b ? `${a}:${b}` : `${b}:${a}`
    pairs.set(k, Math.max(pairs.get(k) ?? 0, w))
  }
  // Providers are named by service key; an entry id often matches it directly.
  for (const [i, e] of entries.entries()) {
    for (const dep of e.inject ?? []) {
      const j = index.get(dep)
      if (j !== undefined) add(i, j, 3)
    }
  }
  const byTarget = new Map()
  for (const [i, e] of entries.entries()) {
    for (const g of e.groups) {
      for (const f of g.floors) {
        if (!byTarget.has(f.label)) byTarget.set(f.label, new Set())
        byTarget.get(f.label).add(i)
      }
    }
  }
  for (const set of byTarget.values()) {
    const list = [...set]
    if (list.length < 2 || list.length > 8) continue
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) add(list[a], list[b], 2)
  }
  const byGroup = new Map()
  for (const [i, e] of entries.entries()) {
    if (e.pkgGroup === null) continue
    if (!byGroup.has(e.pkgGroup)) byGroup.set(e.pkgGroup, [])
    byGroup.get(e.pkgGroup).push(i)
  }
  for (const list of byGroup.values()) {
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) add(list[a], list[b], 1)
  }
  return [...pairs.entries()].map(([k, w]) => {
    const [a, b] = k.split(':').map(Number)
    return [a, b, w]
  })
}

const model = {
  generatedAt: new Date().toISOString(),
  coverage: view.coverage,
  totals: view.totals,
  layers: [...layers.entries()].map(([label, entries]) => ({
    label,
    entries,
    edges: edgesFor(entries),
  })),
}
writeFileSync(join(here, 'out/city-model.json'), JSON.stringify(model))

const prisms = model.layers.flatMap(l => l.entries.flatMap(e => e.groups)).length
const floors = model.layers.flatMap(l => l.entries.flatMap(e => e.groups.flatMap(g => g.floors))).length
const conf = model.layers.flatMap(l => l.entries.flatMap(e => e.groups.flatMap(g => g.floors))).filter(f => f.sev).length
console.log(`districts ${model.layers.length} | blocks ${model.layers.reduce((a, l) => a + l.entries.length, 0)} | prisms ${prisms} | floors ${floors} (争用 ${conf})`)
for (const l of model.layers) {
  const groups = new Set(l.entries.map(e => e.pkgGroup).filter(Boolean))
  console.log(`  ${l.label}: blocks ${l.entries.length} | edges ${l.edges.length} | 源码组 ${groups.size}`)
}
console.log(`size ${(readFileSync(join(here, 'out/city-model.json')).length / 1024).toFixed(0)} KB`)
