/**
 * Survey what the ecosystem actually modifies, and how.
 *
 * A compatibility substrate is designed from observed practice, not from the
 * extension points the product happens to document: the hooks worth
 * stabilizing are the ones many independent plugins already reach for, and the
 * ones they reach for in the same way. This ranks every modification surface by
 * how many distinct packages touch it, and pairs the surfaces that co-occur so
 * recurring combinations show up as candidate interfaces.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRecord } from './normalize.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const real = readFileSync(join(here, 'out/records.jsonl'), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() !== '')
  .flatMap((l) => { try { return [normalizeRecord(JSON.parse(l))] } catch { return [] } })
  .filter(r => r.status === 'ok')

/** Distinct packages per key, so one prolific plugin cannot inflate a surface. */
function tally(pick) {
  const m = new Map()
  for (const r of real) {
    const id = r.pkgName ?? r.repo
    for (const k of pick(r)) {
      if (k === null || k === undefined) continue
      if (!m.has(k)) m.set(k, new Set())
      m.get(k).add(id)
    }
  }
  return [...m.entries()].map(([k, s]) => [k, s.size]).sort((a, b) => b[1] - a[1])
}

const contribs = r => (r.contributions ?? []).filter(c => c.verb !== 'slot-inject')
const show = (title, rows, n = 18) => {
  console.log(`\n=== ${title} ===`)
  for (const [k, v] of rows.slice(0, n)) console.log(`  ${String(v).padStart(5)}  ${k}`)
  if (rows.length > n) console.log(`  … 共 ${rows.length} 项`)
}

console.log(`真插件 ${real.length}`)

show('修改面:插件用哪些注册动词', tally(r => contribs(r).map(c => c.verb)))
show('拦截点:监听哪些事件', tally(r => contribs(r).filter(c => c.verb === 'event-listen').map(c => c.target)), 22)
show('前端改造面:占用哪些槽位', tally(r => contribs(r).filter(c => c.verb === 'slot-register').map(c => c.target)), 20)
show('重配置面:改写哪些配置行', tally(r => (r.patchJournal ?? [])
  .filter(j => j.action === 'override' || j.action === 'disable').map(j => j.target)), 20)
show('禁用面:关掉哪些官方行', tally(r => (r.patchJournal ?? [])
  .filter(j => j.action === 'disable').map(j => j.target)), 14)

// Co-occurrence: which surfaces a single package combines. A recurring pair is
// a seam the substrate should offer as one interface instead of two.
const SURFACE = c => c.verb === 'event-listen' ? `event:${c.target}` : c.verb
const pairs = new Map()
for (const r of real) {
  const set = [...new Set(contribs(r).map(SURFACE))].sort()
  for (let a = 0; a < set.length; a += 1) {
    for (let b = a + 1; b < set.length; b += 1) {
      const k = `${set[a]}  +  ${set[b]}`
      pairs.set(k, (pairs.get(k) ?? 0) + 1)
    }
  }
}
show('常见组合:一个插件同时碰的两个面', [...pairs.entries()].sort((a, b) => b[1] - a[1]), 16)

// Loop control: the events a plugin uses to sit inside or around the agent turn.
const LOOP = new Set(['agent/pre-step', 'agent/request', 'agent/turn-stopping', 'agent/status',
  'agent/created', 'agent/disposed', 'agent/session-start', 'agent/error', 'agent/request-error',
  'agent/inbox/claimed', 'agent/inbox/discarded', 'llm/stream', 'system-prompt/assemble',
  'tools/pre-execute', 'tools/execute', 'tools/post-execute', 'tools/result'])
const loopUsers = real.filter(r => contribs(r).some(c => c.verb === 'event-listen' && LOOP.has(c.target)))
console.log(`\n=== 外置循环 / 回合干预 ===`)
console.log(`  用到回合或工具管线事件的插件: ${loopUsers.length} (${(loopUsers.length / real.length * 100).toFixed(1)}%)`)
show('  其中具体用了哪些', tally(r => contribs(r).filter(c => c.verb === 'event-listen' && LOOP.has(c.target)).map(c => c.target)), 18)

// How a package presents itself: host half, client half, or both.
let hostOnly = 0, clientOnly = 0, both = 0, neither = 0
for (const r of real) {
  const h = contribs(r).some(c => c.plane === 'host')
  const c = contribs(r).some(x => x.plane === 'client')
  if (h && c) both += 1; else if (h) hostOnly += 1; else if (c) clientOnly += 1; else neither += 1
}
console.log(`\n=== 插件的形态分布 ===`)
console.log(`  只有主机半 ${hostOnly} | 只有前端半 ${clientOnly} | 两半都有 ${both} | 只有配置无注册 ${neither}`)

const declaresPatch = real.filter(r => r.patchFiles.length > 0).length
const declaresClient = real.filter(r => r.dsh?.client !== undefined).length
const declaresBundle = real.filter(r => r.dsh?.bundle !== undefined).length
console.log(`  声明 dsh.bundle ${declaresBundle} | 声明 dsh.client ${declaresClient} | 带 patch 文件 ${declaresPatch}`)

// Every third-party plugin lands as a root-level row: that flat namespace is
// what makes 855 packages contend for the same tool names.
const rootInserts = real.reduce((a, r) => a + (r.patchJournal ?? []).filter(j => j.action === 'insert' && j.into === '<root>').length, 0)
const groupInserts = real.reduce((a, r) => a + (r.patchJournal ?? []).filter(j => j.action === 'insert' && j.into !== '<root>').length, 0)
console.log(`\n=== 挂载位置 ===`)
console.log(`  插入到根 ${rootInserts} | 插入到分组下 ${groupInserts}`)
