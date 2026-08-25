/**
 * The gatekeeper as a real plugin, in a real boot.
 *
 * Everything so far proved a mechanism. This asserts the product behaviour: a
 * composition that fails today with an opaque `duplicate tool "bash"` from
 * whichever fiber happened to apply second instead fails — or survives — with
 * the substrate's own account of what is wrong and who is involved.
 *
 * Three arrangements:
 *   veto      the gatekeeper refuses the composition, naming the contenders
 *   report    it warns and lets the boot proceed to its ordinary failure
 *   clean     a composition with no conflict is not disturbed
 *
 * Run: node --import tsx/esm lab-gatekeeper-plugin.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot } from './packages/boot/app-boot/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

// ESM needs a file:// URL, not a Windows drive path, in a generated module.
const SUBSTRATE = pathToFileURL(process.env.DSH_SUBSTRATE ?? '../substrate/src').href

/**
 * The gatekeeper entry, wiring the substrate's plugin to a catalog. In
 * production the catalog ships with the substrate; here it is inline so the
 * test states exactly what the prediction was given.
 */
const GATE = `
import { apply as gatekeeper } from '${SUBSTRATE}/gatekeeper.mjs'
export const name = 'gatekeeper'
export const inject = ['loader']
export function apply(ctx, config) {
  globalThis.__lines ??= []
  const catalog = new Map(Object.entries(config.catalog ?? {}))
  gatekeeper(ctx, {
    catalog,
    onCritical: config.onCritical,
    policy: { order: config.order ?? [] },
    log: (line) => { globalThis.__lines.push(line) },
  })
}
`

/** A registry that throws on a duplicate, standing in for ctx.tools. */
const REGISTRY = `
export const name = 'registry'
export function apply(ctx) {
  const names = new Set()
  ctx.provide('demoTools')
  ctx.set('demoTools', {
    register(n) {
      if (names.has(n)) throw new Error('duplicate tool "' + n + '"')
      names.add(n)
      return () => names.delete(n)
    },
  })
}
`

const CLAIMER = `
export const name = 'claimer'
export const inject = ['demoTools', 'substrateGate']
export function apply(ctx, config) {
  globalThis.__applied ??= []
  globalThis.__applied.push(config.owner)
  ctx.demoTools.register(config.tool)
}
`

interface Run { error?: unknown, lines: string[], applied: string[] }

async function run(config: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-gk-'))
  writeFileSync(join(dir, 'gate.mjs'), GATE)
  writeFileSync(join(dir, 'registry.mjs'), REGISTRY)
  writeFileSync(join(dir, 'claimer.mjs'), CLAIMER)
  writeFileSync(join(dir, 'cordis.yml'), config)
  const g = globalThis as { __lines?: string[], __applied?: string[] }
  g.__lines = []
  g.__applied = []
  let error: unknown
  try {
    await boot('dsh-lab', join(dir, 'cordis.yml'))
    await new Promise(r => setTimeout(r, 350))
  } catch (e) { error = e }
  const out = { error, lines: (g.__lines ?? []).slice(), applied: (g.__applied ?? []).slice() }
  rmSync(dir, { recursive: true, force: true })
  return out
}

const CATALOG = { './claimer.mjs': { tools: ['bash'] } }
const conflicting = (onCritical: string) => `
- id: claim-a
  name: ./claimer.mjs
  config: { owner: pkg-a, tool: bash }

- id: claim-b
  name: ./claimer.mjs
  config: { owner: pkg-b, tool: bash }

- id: registry
  name: ./registry.mjs

- id: gate
  name: ./gate.mjs
  config:
    onCritical: ${onCritical}
    order: [./claimer.mjs]
    catalog: ${JSON.stringify(CATALOG)}
`

async function main(): Promise<void> {
  console.log('\n=== veto:守门员拒绝组合,并说清是谁 ===')
  {
    const r = await run(conflicting('veto'))
    const message = String((r.error as Error)?.message ?? r.error ?? '')
    const cause = String((r.error as { cause?: unknown })?.cause ?? '')
    const all = `${message} ${cause}`
    check('启动被拒', r.error !== undefined)
    check('拒绝理由来自底座,不是 duplicate tool',
      /dsh-conflict-substrate/.test(all), all.slice(0, 160))
    check('理由里点出了冲突目标', /bash/.test(all), all.slice(0, 160))
    check('争用者一个都没能应用 —— 冲突在发生前被拦下',
      r.applied.length === 0 && /dsh-conflict-substrate/.test(all), JSON.stringify(r.applied))
    console.log('        veto:', all.slice(0, 150))
  }

  console.log('\n=== report:只告警,不阻断 ===')
  {
    const r = await run(conflicting('report'))
    check('产出了告警行', r.lines.length > 0, JSON.stringify(r.lines))
    check('告警说明会导致启动失败',
      r.lines.some(l => l.includes('会导致启动失败')), JSON.stringify(r.lines))
    check('告警点名了两个认领者',
      r.lines.some(l => l.includes('2 个插件')), JSON.stringify(r.lines))
    // Reporting does not repair: the boot still fails the ordinary way, which
    // is the honest behaviour for a mode that promised only to observe.
    check('组合仍按原样失败(report 不做修复)', r.error !== undefined)
    console.log('        report:', JSON.stringify(r.lines))
  }

  console.log('\n=== clean:无冲突的组合不被打扰 ===')
  {
    const r = await run(`
- id: claim-a
  name: ./claimer.mjs
  config: { owner: pkg-a, tool: bash }

- id: registry
  name: ./registry.mjs

- id: gate
  name: ./gate.mjs
  config:
    onCritical: veto
    catalog: ${JSON.stringify(CATALOG)}
`)
    check('启动成功', r.error === undefined, String(r.error).slice(0, 140))
    check('插件正常应用', r.applied.includes('pkg-a'), JSON.stringify(r.applied))
    check('没有冲突类告警',
      !r.lines.some(l => l.includes('会导致启动失败') || l.includes('功能会被撤下') || l.includes('分层或改写')),
      JSON.stringify(r.lines))
    // The coverage line is deliberate, not noise: infrastructure rows are not
    // in the catalog, and a report that stayed silent about what it could not
    // describe would read as proof the composition is clean.
    check('但覆盖率仍如实报告未描述的行',
      r.lines.some(l => l.includes('无法预测')), JSON.stringify(r.lines))
  }

  console.log('\n=== 依赖注入确实让守门员先跑 ===')
  {
    // claimer injects substrateGate, so with the gate row LAST in the file the
    // ordering still holds — the guarantee is the dependency, not the position.
    const r = await run(conflicting('veto'))
    const why = `${String((r.error as Error)?.message ?? '')} ${String((r.error as { cause?: unknown })?.cause ?? '')}`
    check('守门员在文件最后仍先于争用者生效',
      r.applied.length === 0 && /dsh-conflict-substrate/.test(why), why.slice(0, 140))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
