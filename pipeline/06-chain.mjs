/**
 * Measure the Cordis ownership chain as a graph, instead of inventing a
 * grouping for it. The chain is native and identical offline and at runtime:
 *
 *   patch layer -> entryId -> module -> (fiber) -> effect label -> contribution
 *
 * `entryId` is the join key: it is what a patch targets AND what
 * `ctx.loader.entries()` reports, so the offline "who put this row here"
 * and the runtime "what did it actually register" address the same node.
 *
 * The point of measuring is the branching factor at each hop: that number, not
 * taste, decides which hops can be drawn as a graph and which must be a list.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const records = readFileSync(join(here, 'out/records.jsonl'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() !== '')
  .flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  .filter(r => r.status === 'ok')

/** Percentile of a numeric sample, nearest-rank. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function describe(name, values) {
  const s = [...values].sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    hop: name,
    n: s.length,
    total: sum,
    mean: +(sum / Math.max(1, s.length)).toFixed(2),
    p50: pct(s, 0.5),
    p90: pct(s, 0.9),
    p99: pct(s, 0.99),
    max: s[s.length - 1] ?? 0,
  }
}

// Hop 1: one plugin -> the entry rows it contributes (insert/override/disable).
const rowsPerPlugin = records.map(r =>
  (r.patchJournal ?? []).filter(j => ['insert', 'override', 'disable'].includes(j.action)).length)

// Hop 2: one plugin -> its registration call sites (the effect-label level).
const contribPerPlugin = records.map(r => (r.contributions ?? []).filter(c => c.verb !== 'slot-inject').length)

// Hop 3: one entry row id -> how many distinct plugins claim it (the contention fan-in).
const rowClaims = new Map()
for (const r of records) {
  for (const j of r.patchJournal ?? []) {
    if (j.target === null || j.target === undefined) continue
    const k = j.target
    if (!rowClaims.has(k)) rowClaims.set(k, new Set())
    rowClaims.get(k).add(r.pkgName ?? r.repo)
  }
}

// Hop 4: one contribution target (slot key / tool name) -> distinct plugins.
const targetClaims = new Map()
for (const r of records) {
  for (const c of r.contributions ?? []) {
    if (c.verb === 'slot-inject' || c.target === null) continue
    const k = `${c.verb}:${c.target}`
    if (!targetClaims.has(k)) targetClaims.set(k, new Set())
    targetClaims.get(k).add(r.pkgName ?? r.repo)
  }
}

// Effect-label shape: what a single plugin's own registration tree looks like,
// grouped by verb — this is the subtree a chain view would expand in place.
const verbMix = new Map()
for (const r of records) {
  for (const c of r.contributions ?? []) {
    if (c.verb === 'slot-inject') continue
    verbMix.set(c.verb, (verbMix.get(c.verb) ?? 0) + 1)
  }
}

const hops = [
  describe('plugin -> entry rows (配置行)', rowsPerPlugin),
  describe('plugin -> registrations (效果标签)', contribPerPlugin),
  describe('entry row <- plugins (争用扇入)', [...rowClaims.values()].map(s => s.size)),
  describe('contribution target <- plugins (争用扇入)', [...targetClaims.values()].map(s => s.size)),
]

console.log('=== 链条各跳的分支因子 (真实插件 %d 个) ===', records.length)
console.log('hop'.padEnd(40), 'n'.padStart(6), 'total'.padStart(7), 'mean'.padStart(6), 'p50'.padStart(5), 'p90'.padStart(5), 'p99'.padStart(5), 'max'.padStart(5))
for (const h of hops) {
  console.log(h.hop.padEnd(40), String(h.n).padStart(6), String(h.total).padStart(7),
    String(h.mean).padStart(6), String(h.p50).padStart(5), String(h.p90).padStart(5),
    String(h.p99).padStart(5), String(h.max).padStart(5))
}

console.log('\n=== 一个插件自己的注册构成 (效果树的内容) ===')
for (const [v, n] of [...verbMix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(n).padStart(6) + '  ' + v)
}

const contended = [...targetClaims.entries()].filter(([, s]) => s.size > 1)
const rowContended = [...rowClaims.entries()].filter(([, s]) => s.size > 1)
console.log('\n=== 密度结论 ===')
console.log(`  不同的贡献目标 (slot key / tool name / event) : ${targetClaims.size}`)
console.log(`  其中被 2 个以上插件争用的                    : ${contended.length} (${(contended.length / targetClaims.size * 100).toFixed(1)}%)`)
console.log(`  不同的 entry row id                          : ${rowClaims.size}`)
console.log(`  其中被 2 个以上插件争用的                    : ${rowContended.length} (${(rowContended.length / rowClaims.size * 100).toFixed(1)}%)`)

writeFileSync(join(here, 'out/chain-stats.json'), JSON.stringify({ hops, verbMix: [...verbMix], contendedTargets: contended.length, targets: targetClaims.size }, null, 2))
