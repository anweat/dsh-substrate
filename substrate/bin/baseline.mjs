/**
 * Replay arbitration over the whole scanned ecosystem and report what changes.
 *
 * Two questions, because they answer different things:
 *
 *   all-installed  every scanned plugin in one composition. Nobody runs that,
 *                  but it is the worst case and it exercises every cell.
 *   pairwise       for pairs that contend today, would they coexist after
 *                  arbitration? This is the number a user feels.
 *
 * Usage: node bin/baseline.mjs [--records <path>] [--baseline <path>] [--pairs N]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arbitrate } from '../src/arbitrate.mjs'
import { contributionsOf, KIND_ARITY, byCell, parseCell } from '../src/model.mjs'
import { planScopeChain } from '../src/scope-chain.mjs'
import { ECO } from '../../paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}
const RECORDS = arg('--records', join(ECO, 'out/records.jsonl'))
const BASELINE = arg('--baseline', join(ECO, 'data/baseline.json'))
const PAIRS = Number(arg('--pairs', '4000'))

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const slotKinds = new Map(baseline.slots.map(s => [s.key, s.kind]))
const shippedTools = new Set(baseline.tools.map(t => t.name))
// The harness's own routes, from the shipped composition rather than guessed.
const shippedRoutes = new Set(['/plugins', '/api'])

/** Build-plane duplicates: a package shipping both src/ and lib/ reports twice. */
const BUILD = /^(lib|dist|build|out)\//
function normalize(rec) {
  const contributions = rec.contributions ?? []
  if (!contributions.some(c => /^src\//.test(c.source ?? ''))) return rec
  return { ...rec, contributions: contributions.filter(c => !BUILD.test(c.source ?? '')) }
}

process.stderr.write('reading corpus…\n')
const all = []
const droppedReasons = new Map()
for (const line of readFileSync(RECORDS, 'utf8').split(/\r?\n/)) {
  if (line.trim() === '') continue
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (rec.status !== 'ok') continue
  const { contributions, dropped } = contributionsOf(normalize(rec), slotKinds)
  for (const d of dropped) droppedReasons.set(d.why, (droppedReasons.get(d.why) ?? 0) + 1)
  if (contributions.length > 0) all.push({ owner: rec.pkgName ?? rec.repo, contributions })
}
const flat = all.flatMap(p => p.contributions)
process.stderr.write(`plugins ${all.length} | contributions ${flat.length}\n`)

// --- today: what a composition does with no substrate ----------------------
// A registry that throws takes the whole boot down, so one exclusive cell with
// two distinct claimants is a fatal composition — that is the status quo.
const fatalCells = []
for (const [cell, claims] of byCell(flat)) {
  // parseCell, never a manual split: the cell format lives in one place.
  const { kind, target } = parseCell(cell)
  if (KIND_ARITY[kind] !== 'exclusive') continue
  const distinct = new Set(claims.map(c => c.owner))
  const throws = kind === 'tool' || kind === 'route' || kind === 'service'
  const vsShipped = (kind === 'tool' && shippedTools.has(target)) || (kind === 'route' && shippedRoutes.has(target))
  if (throws && (distinct.size > 1 || vsShipped)) fatalCells.push({ cell, owners: [...distinct] })
}
const fatalOwners = new Set(fatalCells.flatMap(f => f.owners))

// --- after arbitration -----------------------------------------------------
process.stderr.write('arbitrating…\n')
const result = arbitrate(flat, { shippedTools, shippedRoutes, fallback: 'alphabetical' })
const status = { intact: 0, adapted: 0, degraded: 0 }
for (const o of result.outcomes) status[o.status] += 1

console.log('\n=== 语料 ===')
console.log(`  记录 ${all.length} | 去重包名 ${result.outcomes.length} | 贡献 ${flat.length} | 争用格 ${result.totals.contested}`)
console.log(`  归一化丢弃: ${[...droppedReasons].map(([k, v]) => `${k}=${v}`).join(', ')}`)

console.log('\n=== 现状(无底座,全部同装)===')
console.log(`  会导致注册抛错的格: ${fatalCells.length}`)
console.log(`  牵涉包: ${fatalOwners.size} (${(fatalOwners.size / result.outcomes.length * 100).toFixed(1)}%)`)
console.log('  后果: 任一格抛错即整个组合启动失败')

console.log('\n=== 裁决后 ===')
// Outcomes are keyed by package NAME, and forks republish the same name, so
// the denominator is distinct owners — not the record count.
const distinctOwners = result.outcomes.length
const pct = n => `${(n / distinctOwners * 100).toFixed(1)}%`
console.log(`  intact   ${String(status.intact).padStart(5)}  ${pct(status.intact).padStart(6)}   全部贡献保持原目标`)
console.log(`  adapted  ${String(status.adapted).padStart(5)}  ${pct(status.adapted).padStart(6)}   有分层/改名/隔离,功能完整`)
console.log(`  degraded ${String(status.degraded).padStart(5)}  ${pct(status.degraded).padStart(6)}   前端半被丢弃`)
console.log(`  共存(intact+adapted) ${status.intact + status.adapted}  ${pct(status.intact + status.adapted)}`)

console.log('\n=== 裁决动作分布 ===')
for (const [k, v] of Object.entries(result.totals.byRemedy).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`)
}
console.log('\n=== 争用格按类型 ===')
for (const [k, v] of Object.entries(result.totals.byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`)
}

// --- scope chain: can ONE linear order satisfy every layer decision? -------
// The chain is a line and a scope binds to at most one parent, so decisions
// that disagree about precedence cannot all hold. This measures how often the
// ecosystem actually produces such a disagreement.
const plan = planScopeChain(result.decisions, {})
console.log(`
=== scope 链(layer 裁决压成一条线)===`)
console.log(`  链长 ${plan.chain.length} | 顺序约束 ${plan.constraints}`)
console.log(`  可满足 ${plan.satisfied} (${(plan.satisfied / Math.max(1, plan.constraints) * 100).toFixed(1)}%)`)
console.log(`  线性链无法同时满足 ${plan.violated.length}`)
console.log(`  处于环上的包 ${plan.cyclicOwners.length}`)
if (plan.violated.length > 0) {
  console.log('  被牺牲的约束(前 5):')
  for (const v of plan.violated.slice(0, 5)) console.log(`    ${v.winner} 本应遮蔽 ${v.loser}  @ ${parseCell(v.cell).target}`)
}

// --- pairwise: the number a user feels -------------------------------------
process.stderr.write('pairwise…\n')
const pairs = new Set()
for (const { owners } of fatalCells) {
  for (let i = 0; i < owners.length && pairs.size < PAIRS; i += 1) {
    for (let j = i + 1; j < owners.length && pairs.size < PAIRS; j += 1) {
      pairs.add(owners[i] < owners[j] ? `${owners[i]}\u0000${owners[j]}` : `${owners[j]}\u0000${owners[i]}`)
    }
  }
}
const byOwner = new Map(all.map(p => [p.owner, p.contributions]))
let coexist = 0, stillDegraded = 0
for (const key of pairs) {
  const [a, b] = key.split('\u0000')
  const pairContribs = [...(byOwner.get(a) ?? []), ...(byOwner.get(b) ?? [])]
  const r = arbitrate(pairContribs, { shippedTools, shippedRoutes, fallback: 'alphabetical' })
  if (r.outcomes.every(o => o.status !== 'degraded')) coexist += 1
  else stillDegraded += 1
}
console.log('\n=== 成对共存(今天会互相炸的组合)===')
console.log(`  取样 ${pairs.size} 对`)
console.log(`  裁决后可共存 ${coexist} (${(coexist / Math.max(1, pairs.size) * 100).toFixed(1)}%)`)
console.log(`  仍有前端功能损失 ${stillDegraded} (${(stillDegraded / Math.max(1, pairs.size) * 100).toFixed(1)}%)`)

writeFileSync(join(here, '../out-baseline.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  corpus: { records: all.length, distinctOwners: result.outcomes.length, contributions: flat.length },
  today: { fatalCells: fatalCells.length, affectedPackages: fatalOwners.size },
  afterArbitration: { ...status, contested: result.totals.contested, byRemedy: result.totals.byRemedy, byKind: result.totals.byKind },
  pairwise: { sampled: pairs.size, coexist, stillDegraded },
  scopeChain: { length: plan.chain.length, constraints: plan.constraints, satisfied: plan.satisfied, violated: plan.violated.length, cyclicOwners: plan.cyclicOwners.length },
}, null, 2))
console.log('\n-> out-baseline.json')
