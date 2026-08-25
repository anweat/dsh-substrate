/**
 * When can a gatekeeper actually intervene?
 *
 * The plan assumed a plugin could veto a bad composition from a synchronous
 * `agent/created` listener. That hook does veto publication — but this checks
 * whether it fires early enough to matter for the largest conflict class.
 *
 * `tools.register` throws while a plugin's fiber applies, which happens during
 * loader activation; agents are created later by whichever surface drives the
 * host. If that ordering holds, an `agent/created` gatekeeper is too late for
 * tool-name collisions and the pre-flight has to read the ENTRY LIST — which
 * exists before the fibers that would throw.
 *
 * Run: node --import tsx/esm lab-gatekeeper-timing.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './packages/boot/app-boot/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A registry that throws on a duplicate, standing in for `ctx.tools`. */
const REGISTRY = `
export const name = 'registry'
export function apply(ctx) {
  globalThis.__timeline ??= []
  globalThis.__timeline.push('registry:provide')
  const names = new Set()
  ctx.provide('demoTools')
  ctx.set('demoTools', {
    register(n) {
      if (names.has(n)) throw new Error('duplicate tool "' + n + '"')
      names.add(n)
      globalThis.__timeline.push('register:' + n)
      return () => names.delete(n)
    },
    names: () => [...names],
  })
}
`

/** Two ordinary plugins that both claim one name — today's failure. */
const CLAIMER = `
export const name = 'claimer'
export const inject = ['demoTools']
export function apply(ctx, config) {
  globalThis.__timeline ??= []
  globalThis.__timeline.push('apply:' + config.owner)
  ctx.demoTools.register(config.tool)
}
`

/**
 * The gatekeeper as a plugin: it reads the ENTRY LIST, not the registrations,
 * so it can speak before the fibers that would throw have applied.
 */
const GATEKEEPER = `
export const name = 'gatekeeper'
export function apply(ctx) {
  globalThis.__timeline ??= []
  globalThis.__timeline.push('gatekeeper:apply')
  const seen = []
  for (const entry of ctx.loader.entries()) {
    seen.push({ id: entry.options.id, name: entry.options.name, tool: entry.options.config?.tool })
  }
  globalThis.__gateSaw = seen
}
`

const CONFIG = `
- id: gatekeeper
  name: ./gatekeeper.mjs

- id: registry
  name: ./registry.mjs

- id: claim-a
  name: ./claimer.mjs
  config:
    owner: pkg-a
    tool: bash

- id: claim-b
  name: ./claimer.mjs
  config:
    owner: pkg-b
    tool: bash
`

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-gate-'))
  writeFileSync(join(dir, 'registry.mjs'), REGISTRY)
  writeFileSync(join(dir, 'claimer.mjs'), CLAIMER)
  writeFileSync(join(dir, 'gatekeeper.mjs'), GATEKEEPER)
  writeFileSync(join(dir, 'cordis.yml'), CONFIG)

  console.log('\n=== 冲突在什么时候发生 ===')
  // The conflict is fatal at loader apply, so booting this tree is expected to
  // reject — catching it is the assertion, not an accommodation.
  let bootError: unknown
  try {
    await boot('dsh-lab', join(dir, 'cordis.yml'))
    await new Promise(r => setTimeout(r, 400))
  } catch (e) { bootError = e }

  const timeline = (globalThis as { __timeline?: string[] }).__timeline ?? []
  const saw = (globalThis as { __gateSaw?: { id: string, name: string, tool?: string }[] }).__gateSaw ?? []
  console.log('        timeline:', JSON.stringify(timeline))

  const message = bootError === undefined ? '' : String((bootError as Error)?.message ?? bootError)
  check('组合根本没有启动起来', bootError !== undefined, '启动竟然成功了')
  check('失败发生在 loader 应用 entry 时,不在任何 agent 之后',
    /failed to apply loader entry/.test(message)
    || /duplicate tool/.test(String((bootError as { cause?: unknown })?.cause ?? '')),
    message.slice(0, 120))
  check('两个 claimer 都尝试注册了同一个名字',
    timeline.filter(t => t.startsWith('apply:')).length === 2, JSON.stringify(timeline))
  check('时间线里没有任何 agent 事件 —— agent 阶段根本没到达',
    !timeline.some(t => t.includes('agent')), JSON.stringify(timeline))

  console.log('\n=== 守门员能否在冲突前看到整个 entry list ===')
  check('守门员先于 claimer 运行',
    timeline.indexOf('gatekeeper:apply') < timeline.indexOf('apply:pkg-a'), JSON.stringify(timeline))
  check('它看到了所有 entry,包括尚未应用的',
    saw.length >= 4, JSON.stringify(saw.map(s => s.id)))
  check('entry 上带着配置,足以预测冲突',
    saw.filter(s => s.tool === 'bash').length === 2, JSON.stringify(saw))

  const ids = saw.map(s => s.id)
  check('两个争用者在 entry list 里都可见',
    ids.includes('claim-a') && ids.includes('claim-b'), JSON.stringify(ids))

  // The point of the whole experiment: prediction from the entry list, before
  // the registration that would throw.
  const byTool = new Map<string, string[]>()
  for (const e of saw) {
    if (e.tool === undefined) continue
    if (!byTool.has(e.tool)) byTool.set(e.tool, [])
    byTool.get(e.tool)!.push(e.id)
  }
  const predicted = [...byTool.entries()].filter(([, owners]) => owners.length > 1)
  check('仅凭 entry list 即可预测出冲突',
    predicted.length === 1 && predicted[0][0] === 'bash',
    JSON.stringify(predicted))


  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
