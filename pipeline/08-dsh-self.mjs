/**
 * Analyze the dsh checkout itself, so the tree carries the shipped side too.
 *
 * The ecosystem scan answers "what do third parties contribute"; this answers
 * "what does the product contribute", which is what an entry row in the composed
 * profile actually resolves to. Joining them on the package name completes the
 * chain from profile down to a single registration call site.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRepo, indexBaseline } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DSH = process.argv[2] ?? process.env.DSH_ROOT ?? ''
const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))
const idx = indexBaseline(baseline)

/** Every workspace package directory under packages/<group>/<pkg>. */
function packageDirs(root) {
  const out = []
  const groups = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(d => d.isDirectory())
  for (const g of groups) {
    let pkgs
    try { pkgs = readdirSync(join(root, 'packages', g.name), { withFileTypes: true }) } catch { continue }
    for (const p of pkgs) {
      if (!p.isDirectory()) continue
      const dir = join(root, 'packages', g.name, p.name)
      if (existsSync(join(dir, 'package.json'))) out.push({ group: g.name, dir })
    }
  }
  return out
}

const dirs = packageDirs(DSH)
process.stderr.write(`analyzing ${dirs.length} shipped packages\n`)

const packages = []
for (const { group, dir } of dirs) {
  try {
    const r = analyzeRepo(dir, dir, idx)
    packages.push({
      group,
      pkgName: r.pkgName,
      contributions: (r.contributions ?? [])
        .filter(c => c.verb !== 'slot-inject')
        .map(c => ({ verb: c.verb, target: c.target, source: c.source, action: c.action, slotKind: c.slotKind ?? null })),
    })
  } catch (e) {
    packages.push({ group, pkgName: null, error: String(e).slice(0, 160), contributions: [] })
  }
}

const byName = new Map(packages.filter(p => p.pkgName).map(p => [p.pkgName, p]))

/**
 * The composed web profile as ONE recursive node type, mirroring the Cordis
 * model where a child fiber is itself an effect on its parent: every level is
 * `{ label, kind, children }`, so one card renders all of them.
 */
const layerJournal = baseline.profiles.web.journal
const layers = new Map()
for (const j of layerJournal) {
  const label = j.layer.split('/')[2] ?? j.layer
  if (!layers.has(label)) layers.set(label, [])
  layers.get(label).push(j)
}

const VERB_GROUP = {
  'tool-register': 'tools',
  'slot-register': 'slots',
  'event-listen': 'events',
  'command-register': 'commands',
  'service-provide': 'services',
}

/** One entry row expanded into its package's registration groups. */
function rowNode(j) {
  const pkg = j.plugin !== null && j.plugin !== undefined ? byName.get(j.plugin) : undefined
  const groups = new Map()
  for (const c of pkg?.contributions ?? []) {
    const g = VERB_GROUP[c.verb] ?? 'other'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push({ label: c.target ?? '<非字面量>', kind: 'contribution', verb: c.verb, at: c.source, children: [] })
  }
  return {
    label: j.target ?? '(匿名行)',
    kind: 'entry',
    action: j.action,
    module: j.plugin ?? null,
    children: [...groups.entries()].map(([g, items]) => ({
      label: g, kind: 'group', children: items,
    })),
  }
}

const tree = {
  label: 'web profile',
  kind: 'profile',
  children: [...layers.entries()].map(([label, journal]) => ({
    label,
    kind: 'layer',
    children: journal.filter(j => ['insert', 'override', 'disable'].includes(j.action)).map(rowNode),
  })),
}

/** Structural mass: total descendants, the base of every display weight. */
function measure(node) {
  let n = 0
  for (const c of node.children ?? []) n += 1 + measure(c)
  node.size = n
  return n
}
measure(tree)

const covered = packages.filter(p => p.contributions.length > 0).length
const totalContrib = packages.reduce((a, p) => a + p.contributions.length, 0)
writeFileSync(join(here, 'out/dsh-tree.json'), JSON.stringify({ tree, packages: packages.length, covered, totalContrib }))

console.log(`shipped packages ${packages.length} | with registrations ${covered} | contributions ${totalContrib}`)
console.log(`tree nodes ${tree.size} | layers ${tree.children.length}`)
for (const l of tree.children) {
  console.log(`  ${l.label}: ${l.children.length} rows, subtree ${l.size}`)
}
const matched = tree.children.flatMap(l => l.children).filter(r => r.children.length > 0).length
const totalRows = tree.children.flatMap(l => l.children).length
console.log(`rows resolved to a shipped package: ${matched}/${totalRows}`)
