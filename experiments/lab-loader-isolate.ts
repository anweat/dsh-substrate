/**
 * Phase-0 experiment 3: end-to-end through the REAL loader.
 *
 * Experiments 1 and 2 exercised the Cordis primitive directly (`ctx.extend`
 * with a remapped isolate map). This one asks the question the substrate
 * actually depends on: does the LOADER's `isolate` entry option — declarable
 * from a patch layer, with no upstream change — put a shim between a consumer
 * and the real service?
 *
 * Shape under test, which is the substrate in miniature:
 *
 *   real          provides `demo` at the root
 *   sandbox       cordis:group with isolate: { demo: <realm> }
 *     shim        provides `demo` INSIDE the realm, forwarding to the root one
 *     consumer    injects `demo` and must resolve the shim, not the root
 *
 * Run: node --import tsx/esm lab-loader-isolate.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './packages/boot/app-boot/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const REAL = `
export const name = 'real'
export function apply(ctx) {
  ctx.provide('demo')
  ctx.set('demo', { who: 'real', registered: [] })
}
`

// The shim reaches the root implementation the same way the verified proxy
// does: the root context resolves service names through the ROOT isolate map,
// which a realm remap never touches.
const SHIM = `
export const name = 'shim'
export function apply(ctx) {
  const real = ctx.root.get('demo')
  ctx.provide('demo')
  ctx.set('demo', {
    who: 'shim',
    real,
    register(name, owner) {
      const taken = real.registered.some(e => e.name === name)
      const final = taken ? owner + '__' + name : name
      real.registered.push({ name: final, declared: name, owner })
      return final
    },
  })
}
`

const CONSUMER = `
export const name = 'consumer'
export const inject = ['demo']
export function apply(ctx, config) {
  const seen = ctx.demo
  globalThis.__lab ??= { consumers: [] }
  globalThis.__lab.consumers.push({
    owner: config.owner,
    resolved: seen.who,
    realWho: seen.real?.who,
    got: typeof seen.register === 'function' ? seen.register('bash', config.owner) : null,
  })
}
`

const CONFIG = `
- id: real
  name: ./real.mjs

- id: sandbox
  name: cordis:group
  group: true
  isolate:
    demo: pluginrealm
  config:
    - id: shim
      name: ./shim.mjs

    - id: plugin-a
      name: ./consumer.mjs
      config:
        owner: pkg_a

    - id: plugin-b
      name: ./consumer.mjs
      config:
        owner: pkg_b

- id: outsider
  name: ./consumer.mjs
  config:
    owner: outsider
`

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-isolate-'))
  writeFileSync(join(dir, 'real.mjs'), REAL)
  writeFileSync(join(dir, 'shim.mjs'), SHIM)
  writeFileSync(join(dir, 'consumer.mjs'), CONSUMER)
  writeFileSync(join(dir, 'cordis.yml'), CONFIG)

  console.log('\n=== loader-declared isolate: does the shim intercept? ===')
  const ctx = await boot('dsh-lab', join(dir, 'cordis.yml'))
  await new Promise(r => setTimeout(r, 300))

  const lab = (globalThis as { __lab?: { consumers: { owner: string, resolved: string, realWho?: string, got: string | null }[] } }).__lab
  const consumers = lab?.consumers ?? []
  console.log('        consumers:', JSON.stringify(consumers, null, 0))

  const inRealm = consumers.filter(c => c.owner.startsWith('pkg_'))
  const outside = consumers.find(c => c.owner === 'outsider')

  check('both in-realm consumers activated', inRealm.length === 2, `got ${inRealm.length}`)
  check('an in-realm consumer resolved the SHIM, not the root service',
    inRealm.every(c => c.resolved === 'shim'), JSON.stringify(inRealm.map(c => c.resolved)))
  check('the shim reached the ROOT implementation',
    inRealm.every(c => c.realWho === 'real'), JSON.stringify(inRealm.map(c => c.realWho)))
  check('a consumer OUTSIDE the group resolved the root service directly',
    outside?.resolved === 'real', `outsider resolved ${String(outside?.resolved)}`)

  const real = ctx.get('demo') as { registered: { name: string, owner: string }[] } | undefined
  const names = (real?.registered ?? []).map(e => e.name)
  check('both realm consumers claimed "bash" and both survived',
    names.length === 2, JSON.stringify(names))
  check('the second claim was namespaced by its owner',
    names.some(n => n.endsWith('__bash')), JSON.stringify(names))
  console.log('        root registry:', JSON.stringify(real?.registered ?? []))

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
