/**
 * E3 — a working prototype of the one upstream change with a measured payoff.
 *
 * After arbitration 90.6% of the corpus coexists, and **every** remaining
 * functional loss is on the client plane: 9.4% of packages are degraded purely
 * because `BootPluginRow` carries `{ id, inject, immediately }` and nothing
 * else. The slot registry already has full priority shadowing; the manifest
 * simply has no way to say which plugin ranks where, so a contended seat can
 * only be resolved by withholding a whole plugin.
 *
 * The prototype is two files, three edits:
 *   packages/client/modules/src/client/manifest.ts   BootPluginRow.priority
 *   packages/client/runtime/src/client/slots.ts      seedPriorities + default
 *
 * This asserts what that buys: today's all-or-nothing disable becomes an
 * ordinary shadow, and the plugin that loses a seat keeps everything else.
 *
 * Run: node --import tsx/esm lab-client-priority.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import { SlotRegistry } from './packages/client/runtime/src/client/slots.ts'
import { parseBootManifest } from './packages/client/modules/src/client/manifest.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

declare module './packages/client/ui-slots/src/index.ts' {
  interface SlotMap {
    'lab.details': { kind: 'single', scope: 'root', owner: Record<string, never> }
    'lab.list': { kind: 'list', scope: 'root', owner: Record<string, never> }
  }
}

const Comp = () => null

/** A registry with the two seats under test declared on the root. */
async function registry(): Promise<SlotRegistry> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = ctx.slots as SlotRegistry
  slots.register(
    { name: 'root', children: { 'lab.details': { kind: 'single', scope: 'root' }, 'lab.list': { kind: 'list', scope: 'root' } } } as never,
    Comp as never,
  )
  return slots
}

/** Register as a named plugin would, so `registrant` carries that identity. */
function asPlugin(slots: SlotRegistry, id: string, options: Record<string, unknown>) {
  return slots.register({ ...options, registrant: id } as never, Comp as never)
}

async function main(): Promise<void> {
  console.log('\n=== 今天:两个插件抢同一个 single 座位 ===')
  {
    const slots = await registry()
    asPlugin(slots, 'pkg-a', { name: 'lab.details' })
    let threw = false
    try { asPlugin(slots, 'pkg-b', { name: 'lab.details' }) } catch { threw = true }
    check('同一 rank 上的第二个条目被拒', threw)
    check('所以今天只能整包取舍,没有让位这一说', threw)
  }

  console.log('\n=== 原型:清单给出的默认 rank 让第二个插件让位 ===')
  {
    const slots = await registry()
    // What the substrate would seed from the arbitrated order.
    slots.seedPriorities([['pkg-a', 0], ['pkg-b', 1]])
    let threw: unknown
    asPlugin(slots, 'pkg-a', { name: 'lab.details' })
    try { asPlugin(slots, 'pkg-b', { name: 'lab.details' }) } catch (e) { threw = e }
    check('第二个插件不再被拒', threw === undefined, String(threw).slice(0, 110))

    const all = slots.entries('lab.details')
    check('两个条目都在册', all.length === 2, String(all.length))
    const winners = slots.entriesOfSlot('lab.details')
    check('渲染的只有一个', winners.length === 1, String(winners.length))
    check('渲染的是 rank 最低的那个',
      (winners[0] as { registrant?: string }).registrant === 'pkg-a',
      String((winners[0] as { registrant?: string }).registrant))
  }

  console.log('\n=== 让位不等于失能:落败插件的其它贡献照常 ===')
  {
    const slots = await registry()
    slots.seedPriorities([['pkg-a', 0], ['pkg-b', 1]])
    asPlugin(slots, 'pkg-a', { name: 'lab.details' })
    asPlugin(slots, 'pkg-b', { name: 'lab.details' })
    asPlugin(slots, 'pkg-b', { name: 'lab.list', id: 'b-row' })
    const list = slots.entriesOfSlot('lab.list')
    check('输掉 single 座位的插件,它的 list 条目仍然渲染',
      list.length === 1 && (list[0] as { registrant?: string }).registrant === 'pkg-b',
      JSON.stringify(list.map(e => (e as { registrant?: string }).registrant)))
  }

  console.log('\n=== 显式 priority 仍然压过清单默认 ===')
  {
    const slots = await registry()
    slots.seedPriorities([['pkg-a', 0], ['pkg-b', 1]])
    asPlugin(slots, 'pkg-a', { name: 'lab.details' })
    // pkg-b insists on the front rank; the manifest default must not override
    // a decision the plugin author actually made.
    asPlugin(slots, 'pkg-b', { name: 'lab.details', priority: -1 })
    const winners = slots.entriesOfSlot('lab.details')
    check('自己声明 priority 的插件胜出',
      (winners[0] as { registrant?: string }).registrant === 'pkg-b',
      String((winners[0] as { registrant?: string }).registrant))
  }

  console.log('\n=== 未 seed 的组合行为与改动前完全一致 ===')
  {
    const slots = await registry()
    asPlugin(slots, 'pkg-a', { name: 'lab.details' })
    let threw = false
    try { asPlugin(slots, 'pkg-b', { name: 'lab.details' }) } catch { threw = true }
    check('没有 seed 时仍按原样抛错 —— 改动是纯增量', threw)
  }

  console.log('\n=== 清单契约:priority 可选且被校验 ===')
  {
    const base = { rev: 'r1', entries: [] as unknown[] }
    const withPriority = parseBootManifest({
      ...base,
      entries: [{ id: 'p', url: '/p.js', rev: 'r', priority: 3 }],
    } as never)
    check('带 priority 的行被解析', withPriority.plugins[0].priority === 3, JSON.stringify(withPriority.plugins[0]))
    const without = parseBootManifest({
      ...base,
      entries: [{ id: 'p', url: '/p.js', rev: 'r' }],
    } as never)
    check('省略时字段缺席,不是 0', without.plugins[0].priority === undefined, JSON.stringify(without.plugins[0]))
    let threw = false
    try {
      parseBootManifest({ ...base, entries: [{ id: 'p', url: '/p.js', rev: 'r', priority: 'high' }] } as never)
    } catch { threw = true }
    check('非数值 priority 被拒', threw)
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
