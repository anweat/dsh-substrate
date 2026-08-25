/**
 * Aggregate the per-plugin extraction into the two ecosystem-wide views the
 * analysis exists for: which baseline component each plugin lands on, and
 * where two plugins contend for the same one.
 *
 * Contention is only reported where the DSH runtime actually makes it a
 * conflict — a `single`/`keyed` seat one entry shadows, a tool name whose
 * registry throws on collision, or a config row two layers both rewrite.
 * A `list`/`chain` seat is additive by construction and is counted, never flagged.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRecord } from './normalize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(readFileSync(join(here, 'data/baseline.json'), 'utf8'))
const repos = readFileSync(join(here, 'out/records.jsonl'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() !== '')
  .flatMap((l) => { try { return [normalizeRecord(JSON.parse(l))] } catch { return [] } })
const slotByKey = new Map(baseline.slots.map(s => [s.key, s]))
const baselineTools = new Set(baseline.tools.map(t => t.name))
const baselineRows = new Set(baseline.profiles.web.entries.filter(r => r.id).map(r => r.id))

const push = (map, key, value) => {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

/** A repo counts as a real plugin once it declares or does something DSH-specific. */
const isReal = r => r.status === 'ok'

const real = repos.filter(isReal)
const slotUse = new Map()
const toolUse = new Map()
const eventUse = new Map()
const rowOverride = new Map()
const rowInsert = new Map()
const unknownTargets = new Map()

for (const r of real) {
  for (const c of r.contributions ?? []) {
    if (c.verb === 'slot-register' && c.target !== null) {
      push(slotUse, c.target, { repo: r.repo, pkg: r.pkgName, action: c.action, entryKey: c.entryKey, source: c.source })
      if (c.action === 'unknown-target') push(unknownTargets, c.target, r.pkgName ?? r.repo)
    } else if (c.verb === 'tool-register' && c.target !== null) {
      push(toolUse, c.target, { repo: r.repo, pkg: r.pkgName, source: c.source })
    } else if (c.verb === 'event-listen' && c.target !== null) {
      push(eventUse, c.target, r.pkgName ?? r.repo)
    }
  }
  for (const j of r.patchJournal ?? []) {
    if (j.action === 'override' || j.action === 'disable') {
      push(rowOverride, j.target, { repo: r.repo, pkg: r.pkgName, action: j.action, dropped: j.droppedConfigKeys ?? [] })
    } else if (j.action === 'insert' && j.target !== null) {
      push(rowInsert, j.target, { repo: r.repo, pkg: r.pkgName, plugin: j.plugin })
    }
  }
}

const conflicts = []

// 1. Contended exclusive UI seats: `single` always shadows; `keyed` shadows per key.
for (const [key, users] of slotUse) {
  const slot = slotByKey.get(key)
  if (slot === undefined) continue
  if (slot.kind === 'single' && users.length >= 1) {
    conflicts.push({
      severity: users.length > 1 ? 'high' : 'medium',
      kind: 'slot-shadow',
      target: key,
      detail: `single seat: ${users.length} third-party entr${users.length === 1 ? 'y' : 'ies'} plus ${slot.occupants.length} shipped occupant(s); lowest priority renders, the rest are invisible`,
      parties: users.map(u => u.pkg ?? u.repo),
    })
  }
  if (slot.kind === 'keyed') {
    const byKey = new Map()
    for (const u of users) push(byKey, u.entryKey ?? '<unresolved>', u)
    for (const [k, us] of byKey) {
      // One package registering several entries is composition, not contention:
      // only distinct packages competing for one key is a conflict.
      const uniq = [...new Set(us.map(u => u.pkg ?? u.repo))]
      if (uniq.length <= 1) continue
      const proven = k !== '<unresolved>'
      conflicts.push({
        severity: proven ? 'high' : 'low',
        kind: proven ? 'slot-key-collision' : 'slot-key-unproven',
        target: `${key}[${k}]`,
        detail: proven
          ? `${uniq.length} packages register the same keyed entry; one shadows the rest`
          : `${uniq.length} packages register keyed entries here whose key is not a string literal — collision cannot be decided statically`,
        parties: uniq,
      })
    }
  }
}

// 2. Tool-name collisions — `tools.register` throws on a duplicate, so this is a hard boot failure.
for (const [name, users] of toolUse) {
  const uniq = [...new Set(users.map(u => u.pkg ?? u.repo))]
  if (baselineTools.has(name)) {
    conflicts.push({
      severity: 'critical', kind: 'tool-name-vs-shipped', target: name,
      detail: 'name already registered by a shipped tool package; tools.register() throws',
      parties: uniq,
    })
  } else if (uniq.length > 1) {
    conflicts.push({
      severity: 'critical', kind: 'tool-name-collision', target: name,
      detail: 'two plugins register the same tool name; whichever mounts second throws',
      parties: uniq,
    })
  }
}

// 3. Config rows more than one plugin rewrites, and rows aimed at nothing.
for (const [id, users] of rowOverride) {
  const uniq = [...new Set(users.map(u => u.pkg ?? u.repo))]
  if (uniq.length > 1) {
    conflicts.push({
      severity: 'high', kind: 'config-row-contention', target: id,
      detail: `${uniq.length} plugins patch the same entry id; a patch replaces the whole config, so the last layer wins outright`,
      parties: uniq,
    })
  }
  const dropping = users.filter(u => u.dropped.length > 0)
  for (const d of dropping) {
    conflicts.push({
      severity: 'medium', kind: 'config-key-drop', target: id,
      detail: `override restates a partial config, dropping baseline keys: ${d.dropped.join(', ')}`,
      parties: [d.pkg ?? d.repo],
    })
  }
}
for (const [id, users] of rowInsert) {
  const uniq = [...new Set(users.map(u => u.pkg ?? u.repo))]
  if (uniq.length > 1) {
    conflicts.push({
      severity: 'medium', kind: 'entry-id-collision', target: id,
      detail: 'two plugins insert a row under the same entry id; later patch layers can only address one of them',
      parties: uniq,
    })
  }
}

const orphanRepos = real.filter(r => (r.summary?.configOrphans ?? 0) > 0)
for (const r of orphanRepos) {
  const targets = (r.patchJournal ?? []).filter(j => j.action.startsWith('orphan')).map(j => j.target)
  conflicts.push({
    severity: 'high', kind: 'orphan-patch', target: [...new Set(targets)].join(', '),
    detail: 'patch targets an entry id absent from the composed tree; applyEntryPatches only warns, so the plugin silently does nothing',
    parties: [r.pkgName ?? r.repo],
  })
}

const rank = { critical: 0, high: 1, medium: 2, low: 3 }
conflicts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.kind.localeCompare(b.kind))

const occupancy = baseline.slots.map(s => ({
  key: s.key, kind: s.kind, replaceRisk: s.replaceRisk,
  shippedOccupants: s.occupants.length,
  thirdParty: (slotUse.get(s.key) ?? []).length,
  plugins: [...new Set((slotUse.get(s.key) ?? []).map(u => u.pkg ?? u.repo))],
})).sort((a, b) => b.thirdParty - a.thirdParty)

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    recordsTotal: repos.length,
    // A clone failure is a gap in coverage, NOT a verdict about the repo, so it
    // is counted separately; folding it into "placeholder" would overstate how
    // much of the ecosystem is empty.
    cloneFailed: repos.filter(r => r.status === 'clone-failed').length,
    analyzeFailed: repos.filter(r => r.status === 'analyze-failed').length,
    inspected: repos.filter(r => r.status === 'ok' || r.status === 'no-dsh-signal').length,
    realPlugins: real.length,
    placeholders: repos.filter(r => r.status === 'no-dsh-signal').length,
    withDshField: real.filter(r => r.hasDshField).length,
    withPatchFile: real.filter(r => r.patchFiles.length > 0).length,
    withClientHalf: real.filter(r => r.dsh?.client !== undefined).length,
    withRegistrations: real.filter(r => (r.contributions?.length ?? 0) > 0).length,
    shipsSource: real.filter(r => (r.contributions ?? []).some(c => /^src\//.test(c.source ?? ''))).length,
  },
  conflicts,
  occupancy,
  toolNamespace: [...toolUse.entries()]
    .map(([name, u]) => ({ name, plugins: [...new Set(u.map(x => x.pkg ?? x.repo))] }))
    .sort((a, b) => b.plugins.length - a.plugins.length),
  eventUse: [...eventUse.entries()]
    .map(([name, plugins]) => ({ name, known: baseline.events.some(e => e.name === name), count: new Set(plugins).size }))
    .sort((a, b) => b.count - a.count),
  configTargets: [...rowOverride.entries()]
    .map(([id, u]) => ({ id, known: baselineRows.has(id), plugins: [...new Set(u.map(x => x.pkg ?? x.repo))] }))
    .sort((a, b) => b.plugins.length - a.plugins.length),
  unknownSlotTargets: [...unknownTargets.entries()].map(([key, plugins]) => ({ key, plugins: [...new Set(plugins)] })),
}
writeFileSync(join(here, 'out/report.json'), JSON.stringify(report, null, 2))

const t = report.totals
console.log('=== DSH 生态组件落位报告 ===')
console.log(`记录 ${t.recordsTotal} | 成功检视 ${t.inspected} | 克隆失败(未覆盖) ${t.cloneFailed}`)
console.log(`已检视中: 真实插件 ${t.realPlugins} (${(t.realPlugins / Math.max(1, t.inspected) * 100).toFixed(1)}%) | 空壳/占位 ${t.placeholders}`)
console.log(`  声明 dsh 字段 ${t.withDshField} | 带 cordis.patch.yml ${t.withPatchFile} | 有前端半 ${t.withClientHalf}`)
console.log(`  扫到注册调用 ${t.withRegistrations} | 发布 TS 源码 ${t.shipsSource}`)

console.log(`\n--- 冲突 ${conflicts.length} 条 ---`)
for (const c of conflicts.slice(0, 30)) {
  console.log(`  [${c.severity}] ${c.kind}  ${c.target}`)
  console.log(`      ${c.detail}`)
  console.log(`      涉及: ${c.parties.slice(0, 6).join(', ')}${c.parties.length > 6 ? ` (+${c.parties.length - 6})` : ''}`)
}

console.log('\n--- 组件占用 Top 15（第三方注册数）---')
for (const o of occupancy.filter(o => o.thirdParty > 0).slice(0, 15)) {
  console.log(`  ${String(o.thirdParty).padStart(4)}  ${o.key}  [${o.kind}${o.replaceRisk !== 'none' ? ', 遮蔽风险' : ''}]  官方占位 ${o.shippedOccupants}`)
}
console.log('\n报告 -> out/report.json')
