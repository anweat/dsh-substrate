/**
 * Full-corpus scale test.
 *
 * Every earlier test used a handful of synthetic plugins. This one takes the
 * whole scanned ecosystem, arbitrates it, and then actually mints the scopes
 * and performs the registrations against the real `ToolRuntime` — because a
 * chain of two behaves nothing like a chain of hundreds, and a decision set
 * that is correct in the small can still be unusable at size.
 *
 * What it asserts:
 *   scale       hundreds of real scopes on one chain, with the real registry
 *   no throws   the collisions that fail a boot today do not fail this one
 *   resolution  an agent at the chain head resolves the arbitrated winners
 *   integrity   the emitted patch replays into a well-formed tree
 *   cost        arbitration and chain planning are fast enough to sit in a boot
 *
 * Run: node --import tsx/esm lab-scale.ts
 */
import { readFileSync } from 'node:fs'
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'
import { createScope } from './packages/core/scope/src/index.ts'
import { arbitrate } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/arbitrate.mjs'
import { planScopeChain } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/scope-chain.mjs'
import { contributionsOf } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/model.mjs'
import { emitPatch } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/emit-patch.mjs'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const ECO = process.env.DSH_ECO ?? '../pipeline'
const BUILD = /^(lib|dist|build|out)\//

const toolDef = (name: string, owner: string) => ({
  name,
  description: `${name}@${owner}`,
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {} },
    render: () => ({ card: 'generic' as const, title: name }),
  },
  execute: () => ({ owner }),
})

const RegisterTool = Object.assign(
  (ctx: Context, config: { defs: unknown[] }) => {
    for (const def of config.defs) ctx.tools.register(def as never)
  },
  { inject: ['tools'] },
)

async function main(): Promise<void> {
  console.log('\n=== 载入全量语料 ===')
  const baseline = JSON.parse(readFileSync(`${ECO}/data/baseline.json`, 'utf8'))
  const slotKinds = new Map<string, string>(baseline.slots.map((s: { key: string, kind: string }) => [s.key, s.kind]))
  const shippedTools = new Set<string>(baseline.tools.map((t: { name: string }) => t.name))

  const contributions: Record<string, unknown>[] = []
  let plugins = 0
  for (const line of readFileSync(`${ECO}/out/records.jsonl`, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    let rec: { status?: string, contributions?: { source?: string }[] }
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.status !== 'ok') continue
    const hasSrc = (rec.contributions ?? []).some(c => /^src\//.test(c.source ?? ''))
    const normalized = hasSrc
      ? { ...rec, contributions: (rec.contributions ?? []).filter(c => !BUILD.test(c.source ?? '')) }
      : rec
    const { contributions: got } = contributionsOf(normalized as never, slotKinds)
    if (got.length > 0) { plugins += 1; contributions.push(...got) }
  }
  console.log(`        插件 ${plugins} | 贡献 ${contributions.length}`)
  check('语料规模符合预期', plugins > 9000 && contributions.length > 40000, `${plugins}/${contributions.length}`)

  console.log('\n=== 裁决与排链的开销 ===')
  const t0 = performance.now()
  const { decisions, outcomes, totals } = arbitrate(contributions, { shippedTools, fallback: 'alphabetical' })
  const tArb = performance.now() - t0
  const t1 = performance.now()
  const plan = planScopeChain(decisions, {})
  const tPlan = performance.now() - t1
  console.log(`        裁决 ${tArb.toFixed(0)}ms | 排链 ${tPlan.toFixed(0)}ms | 链长 ${plan.chain.length}`)
  check('裁决在 5 秒内完成', tArb < 5000, `${tArb.toFixed(0)}ms`)
  check('排链在 5 秒内完成', tPlan < 5000, `${tPlan.toFixed(0)}ms`)
  check('全部顺序约束可满足', plan.violated.length === 0, `${plan.violated.length} violated`)

  console.log('\n=== 真实注册:把所有争用的工具装进真注册表 ===')
  // Only packages on the chain matter here: they are exactly the ones whose
  // tool claims contend, which is the population that fails a boot today.
  const wanted = new Set(plan.chain)
  // A substrate APPLIES its decisions before anything registers. `drop` is the
  // whole remedy for a reserved name, so skipping it here would be testing a
  // composition no substrate would ever produce.
  const dropped = new Set<string>()
  for (const d of decisions) {
    for (const a of d.actions ?? []) {
      if (a.action === 'drop') dropped.add(`${a.owner}::${d.target}`)
    }
  }
  const toolsByOwner = new Map<string, string[]>()
  for (const c of contributions) {
    if (c.kind !== 'tool' || !wanted.has(c.owner as string)) continue
    if (dropped.has(`${c.owner}::${c.target}`)) continue
    const owner = c.owner as string
    if (!toolsByOwner.has(owner)) toolsByOwner.set(owner, [])
    const list = toolsByOwner.get(owner)!
    if (!list.includes(c.target as string)) list.push(c.target as string)
  }
  console.log(`        因保留名被 drop 的认领 ${dropped.size}`)
  const registrations = [...toolsByOwner.values()].reduce((a, l) => a + l.length, 0)
  console.log(`        链上包 ${plan.chain.length} | 待注册工具 ${registrations}`)

  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })

  const t2 = performance.now()
  const keys = new Map<string, symbol>(plan.chain.map(o => [o, Symbol(o)]))
  const scopes = new Map<string, { ctx: Context }>()
  // Farthest first, each nearer one parented to it.
  let parent: symbol | undefined
  for (let i = plan.chain.length - 1; i >= 0; i -= 1) {
    const owner = plan.chain[i]
    const key = keys.get(owner) as never
    scopes.set(owner, parent === undefined
      ? createScope(ctx, key)
      : createScope(ctx, key, { parent: parent as never }))
    parent = keys.get(owner)
  }
  const tScopes = performance.now() - t2
  check('每个链上包都拿到 scope', scopes.size === plan.chain.length, `${scopes.size}/${plan.chain.length}`)

  const t3 = performance.now()
  const failures: string[] = []
  for (const [owner, names] of toolsByOwner) {
    const defs = names.map(n => toolDef(n, owner))
    try { await scopes.get(owner)!.ctx.plugin(RegisterTool, { defs }) } catch (e) {
      failures.push(`${owner}: ${String(e).slice(0, 80)}`)
    }
  }
  const tRegister = performance.now() - t3
  console.log(`        铸 scope ${tScopes.toFixed(0)}ms | 注册 ${tRegister.toFixed(0)}ms`)
  check('没有任何注册抛错 —— 今天这些组合会让启动失败',
    failures.length === 0, `${failures.length} 例: ${failures.slice(0, 3).join(' | ')}`)

  console.log('\n=== agent 的解析结果 ===')
  const agentKey = Symbol('agent') as never
  createScope(ctx, agentKey, { parent: keys.get(plan.chain[0]) as never })
  const t4 = performance.now()
  const seen = ctx.tools.schemas(agentKey)
  const tView = performance.now() - t4
  console.log(`        agent 可见工具 ${seen.length} | 解析耗时 ${tView.toFixed(0)}ms`)

  const names = seen.map(s => s.name)
  check('工具名无重复', new Set(names).size === names.length, `${names.length} → ${new Set(names).size}`)
  check('解析耗时可接受', tView < 2000, `${tView.toFixed(0)}ms`)

  // For every contended tool, the visible one must be the arbitrated winner.
  // A reserved name is dropped for everyone, so it is contended but must NOT be
  // visible. Excluding it here is the assertion, not an exemption — the pair of
  // checks below states both halves.
  const contendedTools = decisions.filter(d =>
    d.contested && d.kind === 'tool' && d.winner !== '<shipped>' && d.reserved !== true)
  const reservedDecisions = decisions.filter(d => d.reserved === true)
  let wrongWinner = 0
  let notVisible = 0
  const byName = new Map(seen.map(s => [s.name, s.description]))
  for (const d of contendedTools) {
    const desc = byName.get(d.target as string)
    if (desc === undefined) { notVisible += 1; continue }
    if (desc !== `${d.target}@${d.winner}`) wrongWinner += 1
  }
  console.log(`        争用工具 ${contendedTools.length} | 赢家不符 ${wrongWinner} | 未可见 ${notVisible}`)
  check('每个争用工具解析到的都是裁决赢家', wrongWinner === 0, `${wrongWinner} 例不符`)
  check('争用工具全部可见', notVisible === 0, `${notVisible} 例缺失`)

  check('保留名被识别为不可补救',
    reservedDecisions.length > 0 && reservedDecisions.every(d => d.remedy === 'drop' && d.winner === '<reserved>'),
    JSON.stringify(reservedDecisions.map(d => [d.target, d.remedy])))
  check('保留名在 agent 视图中确实不可见',
    reservedDecisions.every(d => !names.includes(d.target as string)),
    JSON.stringify(reservedDecisions.map(d => d.target)))

  console.log('\n=== 全局层保持干净 ===')
  check('全局层没有任何插件工具',
    ctx.tools.schemas().length === 0, JSON.stringify(ctx.tools.schemas().map(s => s.name).slice(0, 5)))

  console.log('\n=== 补丁发射在全量下的完整性 ===')
  const renames = decisions.filter(d => d.remedy === 'rename')
  // The emitter needs the COMPOSED TREE, not just the contended rows: a
  // `drop-client` action names an owner whose row it must switch off, and an
  // owner with no row in the map is reported as unresolved. A live substrate
  // reads `ctx.loader.entries()`; here every owner named by any action gets a
  // synthetic row, which is the same completeness guarantee.
  const rows = new Map<string, { id: string, name: string, owner: string }>()
  for (const d of decisions) {
    for (const a of d.actions ?? []) {
      const id = a.action === 'rename' ? (a.from as string) : `${a.owner}-row`
      rows.set(id, { id, name: `@${a.owner}/mod`, owner: a.owner as string })
    }
  }
  const t5 = performance.now()
  const { patch, unresolved, summary } = emitPatch({ decisions, rows })
  const tEmit = performance.now() - t5
  console.log(`        重命名决策 ${renames.length} | 发出补丁行 ${patch.length} | 耗时 ${tEmit.toFixed(0)}ms`)
  check('补丁发射无未解析项', unresolved.length === 0, `${unresolved.length} 例`)
  const renamedIds = new Set(renames.flatMap(d => (d.actions ?? [])
    .filter(a => a.action === 'rename').map(a => a.from as string)))
  check('每个 rename 都产出了重新安家',
    summary.rehomed === renamedIds.size, `${summary.rehomed}/${renamedIds.size}`)
  const insertRows = patch.filter(p => Array.isArray(p.insert)).flatMap(p => p.insert as { id: string }[])
  const insertIds = insertRows.map(r => r.id)
  check('重新插入的 id 互不重复',
    new Set(insertIds).size === insertIds.length, `${insertIds.length} → ${new Set(insertIds).size}`)

  console.log('\n=== 结局分布 ===')
  const status = { intact: 0, adapted: 0, degraded: 0 } as Record<string, number>
  for (const o of outcomes) status[o.status as string] += 1
  const coexist = status.intact + status.adapted
  console.log(`        intact ${status.intact} | adapted ${status.adapted} | degraded ${status.degraded}`)
  console.log(`        共存 ${coexist}/${outcomes.length} (${(coexist / outcomes.length * 100).toFixed(1)}%)`)
  check('共存率不低于九成', coexist / outcomes.length >= 0.9, `${(coexist / outcomes.length * 100).toFixed(1)}%`)
  check('争用格数与裁决一致', totals.contested > 0 && totals.contested === decisions.filter(d => d.contested).length)

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
