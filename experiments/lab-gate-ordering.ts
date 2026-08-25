/**
 * Can a gatekeeper be GUARANTEED to run before the plugins it must inspect?
 *
 * The previous experiment showed it happening, but happening is not a
 * guarantee: the base bundle states that "row order carries no load semantics
 * (activation is service-availability driven)", so a gatekeeper that merely
 * sits first in the file is relying on an accident.
 *
 * Three arrangements, in increasing strength:
 *
 *   A. gatekeeper last in the file, nothing depends on it
 *   B. gatekeeper last, and a contender declares `inject` on a service it provides
 *   C. the same, but the `inject` is added by an entry OPTION rather than by the
 *      plugin's own source — which is what a substrate can actually do to
 *      third-party rows it does not control
 *
 * Run: node --import tsx/esm lab-gate-ordering.ts
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

/** The gatekeeper: provides a token others can be made to wait on. */
const GATE = `
export const name = 'gate'
export function apply(ctx) {
  globalThis.__order ??= []
  globalThis.__order.push('gate')
  ctx.provide('substrateGate')
  ctx.set('substrateGate', { entries: ctx.loader.entries().length })
}
`

/** An ordinary third-party plugin that declares no dependency of its own. */
const PLAIN = `
export const name = 'plain'
export function apply(ctx, config) {
  globalThis.__order ??= []
  globalThis.__order.push(config.tag)
}
`

/** One that declares the dependency in its own source (arrangement B). */
const AWARE = `
export const name = 'aware'
export const inject = ['substrateGate']
export function apply(ctx, config) {
  globalThis.__order ??= []
  globalThis.__order.push(config.tag)
}
`

async function run(label: string, files: Record<string, string>, config: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-order-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  writeFileSync(join(dir, 'cordis.yml'), config)
  ;(globalThis as { __order?: string[] }).__order = []
  try {
    await boot('dsh-lab', join(dir, 'cordis.yml'))
    await new Promise(r => setTimeout(r, 350))
  } catch (e) {
    console.log(`        ${label} boot rejected: ${String(e).slice(0, 90)}`)
  }
  const order = ((globalThis as { __order?: string[] }).__order ?? []).slice()
  rmSync(dir, { recursive: true, force: true })
  console.log(`        ${label}: ${JSON.stringify(order)}`)
  return order
}

async function main(): Promise<void> {
  console.log('\n=== A. 守门员排在文件最后,无人依赖它 ===')
  {
    const order = await run('A', { 'gate.mjs': GATE, 'plain.mjs': PLAIN }, `
- id: p1
  name: ./plain.mjs
  config: { tag: p1 }

- id: p2
  name: ./plain.mjs
  config: { tag: p2 }

- id: gate
  name: ./gate.mjs
`)
    check('三个 entry 都激活了', order.length === 3, JSON.stringify(order))
    // Whatever the observed order is, the point is that nothing enforces it.
    check('守门员没有先跑 —— 仅靠文件位置没有保证',
      order.indexOf('gate') !== 0, JSON.stringify(order))
  }

  console.log('\n=== B. 插件自己声明 inject(改不了第三方,仅作对照)===')
  {
    const order = await run('B', { 'gate.mjs': GATE, 'aware.mjs': AWARE }, `
- id: a1
  name: ./aware.mjs
  config: { tag: a1 }

- id: gate
  name: ./gate.mjs
`)
    check('声明了 inject 的插件必然后于守门员',
      order.indexOf('gate') < order.indexOf('a1'), JSON.stringify(order))
  }

  console.log('\n=== C. 由 entry 选项注入依赖(底座真正能做的)===')
  {
    // `inject` is an entry option, so a patch layer can add it to a row whose
    // source the substrate does not control — this is the actual mechanism.
    const order = await run('C', { 'gate.mjs': GATE, 'plain.mjs': PLAIN }, `
- id: p1
  name: ./plain.mjs
  inject: [substrateGate]
  config: { tag: p1 }

- id: p2
  name: ./plain.mjs
  inject: [substrateGate]
  config: { tag: p2 }

- id: gate
  name: ./gate.mjs
`)
    check('全部三个仍然激活', order.length === 3, JSON.stringify(order))
    check('守门员被强制排到最前,尽管它在文件最后',
      order.indexOf('gate') === 0, JSON.stringify(order))
    check('两个第三方插件都在其后',
      order.indexOf('p1') > 0 && order.indexOf('p2') > 0, JSON.stringify(order))
  }

  console.log('\n=== D. 守门员缺席时,被注入依赖的行会怎样 ===')
  {
    const order = await run('D', { 'plain.mjs': PLAIN }, `
- id: p1
  name: ./plain.mjs
  inject: [substrateGate]
  config: { tag: p1 }
`)
    check('依赖不满足的行不激活,而不是带病运行',
      !order.includes('p1'), JSON.stringify(order))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
