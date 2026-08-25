/**
 * What `BootPluginRow.priority` would buy, measured on the corpus.
 *
 * Today a contended client seat has exactly one remedy — withhold the losing
 * plugin's browser half — because the boot manifest carries no rank and the
 * slot registry therefore cannot shadow between plugins. With a rank it
 * becomes an ordinary shadow: the loser yields that one seat and keeps
 * everything else.
 *
 * This runs both arbitrations over the same contributions and reports the
 * difference, so the upstream request carries a number rather than a claim.
 *
 * Usage: node bin/whatif-client-priority.mjs
 */
import { readFileSync } from 'node:fs'
import { arbitrate } from '../src/arbitrate.mjs'
import { contributionsOf } from '../src/model.mjs'
import { ECO } from '../../paths.mjs'

const BUILD = /^(lib|dist|build|out)\//

const baseline = JSON.parse(readFileSync(`${ECO}/data/baseline.json`, 'utf8'))
const slotKinds = new Map(baseline.slots.map(s => [s.key, s.kind]))
const shippedTools = new Set(baseline.tools.map(t => t.name))

const contributions = []
for (const line of readFileSync(`${ECO}/out/records.jsonl`, 'utf8').split(/\r?\n/)) {
  if (line.trim() === '') continue
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (rec.status !== 'ok') continue
  const hasSrc = (rec.contributions ?? []).some(c => /^src\//.test(c.source ?? ''))
  const normalized = hasSrc
    ? { ...rec, contributions: (rec.contributions ?? []).filter(c => !BUILD.test(c.source ?? '')) }
    : rec
  contributions.push(...contributionsOf(normalized, slotKinds).contributions)
}

const tally = (result) => {
  const s = { intact: 0, adapted: 0, degraded: 0 }
  for (const o of result.outcomes) s[o.status] += 1
  return s
}

const base = { shippedTools, fallback: 'alphabetical' }
const today = tally(arbitrate(contributions, base))
// The only change: a contended client seat becomes a shadow instead of a
// withheld plugin. Everything else about the arbitration is identical.
const withPriority = tally(arbitrate(contributions, {
  ...base,
  remedies: { 'slot-single': 'layer', 'slot-keyed': 'layer' },
}))

const total = today.intact + today.adapted + today.degraded
const pct = n => `${(n / total * 100).toFixed(1)}%`
const row = (label, s) => `  ${label.padEnd(26)}${String(s.intact).padStart(7)}${String(s.adapted).padStart(10)}${String(s.degraded).padStart(11)}`

console.log(`\n包数 ${total}\n`)
console.log(`  ${''.padEnd(26)}${'intact'.padStart(7)}${'adapted'.padStart(10)}${'degraded'.padStart(11)}`)
console.log(row('现状(清单无 priority)', today))
console.log(row('有 BootPluginRow.priority', withPriority))
console.log(`\n  降级包数  ${today.degraded} → ${withPriority.degraded}`
  + `  (消除 ${today.degraded - withPriority.degraded},占全部包的 ${pct(today.degraded - withPriority.degraded)})`)
console.log(`  共存率    ${pct(today.intact + today.adapted)} → ${pct(withPriority.intact + withPriority.adapted)}`)
console.log(`\n  剩余降级 ${withPriority.degraded} 例来自保留名(drop),那不是 priority 能解决的。\n`)
