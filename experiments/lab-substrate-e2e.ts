/**
 * P3 integration: the substrate end to end, against the real runtime.
 *
 * Everything before this proved a piece — that `isolate` works, that scope
 * layering resolves a name, that the emitters produce well-formed artifacts.
 * This asserts the chain itself: take two plugins that collide today, run them
 * through arbitration, apply what the emitters produce, and check the real
 * `ToolRuntime` ends up in the state the decision claimed.
 *
 * A substrate whose parts each pass but whose composition does not is worth
 * nothing, so the failures here are the ones that matter.
 *
 * Run: node --import tsx/esm lab-substrate-e2e.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'
import { createScope } from './packages/core/scope/src/index.ts'
import { arbitrate } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/arbitrate.mjs'
import { planScopeChain, bindingsFor } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/scope-chain.mjs'
import { emitPatch } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/emit-patch.mjs'
import { rewritePlan, createRouteProxy } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/realm-proxy.mjs'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tool = (name: string, owner: string) => ({
  name,
  description: `${name} from ${owner}`,
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {} },
    render: () => ({ card: 'generic' as const, title: name }),
  },
  execute: () => ({ owner }),
})

/** A stand-in third-party plugin: declares inject, so it may read `ctx.tools`. */
const RegisterTool = Object.assign(
  (ctx: Context, config: { def: unknown }) => { ctx.tools.register(config.def as never) },
  { inject: ['tools'] },
)

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  return ctx
}

async function main(): Promise<void> {
  console.log('\n=== 1. 今天:两个插件抢 bash,第二个挂载即抛 ===')
  {
    const ctx = await boot()
    ctx.tools.register(tool('bash', 'pkg-a') as never)
    let threw = false
    try { ctx.tools.register(tool('bash', 'pkg-b') as never) } catch { threw = true }
    check('未经底座时注册抛错', threw)
  }

  console.log('\n=== 2. 裁决 → 排链 → 按链挂载 ===')
  {
    // What the scanner would have produced for these two packages.
    const contributions = [
      { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-a', source: 'src/a.ts:1' },
      { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-b', source: 'src/b.ts:1' },
      { plane: 'host', kind: 'tool', target: 'only-b', owner: 'pkg-b', source: 'src/b.ts:2' },
    ]
    const policy = { order: ['pkg-b', 'pkg-a'] } // declared precedence: pkg-b wins
    const { decisions, outcomes } = arbitrate(contributions, policy)
    const bashDecision = decisions.find(d => d.target === 'bash')
    check('裁决把工具名冲突判为 layer', bashDecision?.remedy === 'layer', bashDecision?.remedy)
    check('声明顺序决定赢家', bashDecision?.winner === 'pkg-b', bashDecision?.winner)
    check('两个包都没有被降级',
      outcomes.every(o => o.status !== 'degraded'), JSON.stringify(outcomes.map(o => [o.owner, o.status])))

    const plan = planScopeChain(decisions, policy)
    check('链序把赢家放在更近处',
      plan.chain.indexOf('pkg-b') < plan.chain.indexOf('pkg-a'), JSON.stringify(plan.chain))
    check('所有顺序约束可满足', plan.violated.length === 0, JSON.stringify(plan.violated))

    // Mount for real, following the planned chain: farthest scope first, each
    // nearer one parented to it, exactly as bindingsFor prescribes.
    const ctx = await boot()
    const keys = new Map<string, symbol>(plan.chain.map(o => [o, Symbol(o)]))
    const bindings = bindingsFor(plan.chain, o => keys.get(o) as never)
    const scopes = new Map<string, { ctx: Context }>()
    const farthest = plan.chain[plan.chain.length - 1]
    scopes.set(farthest, createScope(ctx, keys.get(farthest) as never))
    for (const b of bindings) {
      scopes.set(b.owner, createScope(ctx, keys.get(b.owner) as never, { parent: b.parent as never }))
    }
    check('链上每个包都拿到 scope', scopes.size === plan.chain.length, `${scopes.size}/${plan.chain.length}`)

    let threwA: unknown, threwB: unknown
    try { await scopes.get('pkg-a')!.ctx.plugin(RegisterTool, { def: tool('bash', 'pkg-a') }) } catch (e) { threwA = e }
    try { await scopes.get('pkg-b')!.ctx.plugin(RegisterTool, { def: tool('bash', 'pkg-b') }) } catch (e) { threwB = e }
    try { await scopes.get('pkg-b')!.ctx.plugin(RegisterTool, { def: tool('only-b', 'pkg-b') }) } catch (e) { threwB ??= e }
    check('两个包都注册成功,没有抛错',
      threwA === undefined && threwB === undefined, String(threwA ?? threwB).slice(0, 120))

    // An agent joins the near end of the chain, which is what an agent setup
    // would do; the chain then resolves `bash` to the arbitrated winner.
    const agentKey = Symbol('agent') as never
    createScope(ctx, agentKey, { parent: keys.get(plan.chain[0]) as never })
    const seen = ctx.tools.schemas(agentKey)
    const bash = seen.find(s => s.name === 'bash')
    check('agent 只看到一个 bash', seen.filter(s => s.name === 'bash').length === 1,
      JSON.stringify(seen.map(s => s.name)))
    check('名字没有被改动', bash?.name === 'bash')
    check('生效的是裁决选中的赢家', bash?.description?.includes('pkg-b') === true, bash?.description)
    check('落败者的其它工具仍然可见',
      seen.some(s => s.name === 'only-b'), JSON.stringify(seen.map(s => s.name)))
    check('全局层保持干净',
      !ctx.tools.schemas().some(s => s.name === 'bash'), JSON.stringify(ctx.tools.schemas().map(s => s.name)))
  }

  console.log('\n=== 3. 发射的补丁在镜像算法下重放正确 ===')
  {
    const contributions = [
      { plane: 'host', kind: 'entry-id', target: 'storage', owner: 'pkg-a', source: 'a.yml', module: '@a/storage' },
      { plane: 'host', kind: 'entry-id', target: 'storage', owner: 'pkg-b', source: 'b.yml', module: '@b/storage' },
    ]
    const { decisions } = arbitrate(contributions, { order: ['pkg-b'] })
    const rows = new Map([['storage', { id: 'storage', name: '@a/storage', owner: 'pkg-a' }]])
    const { patch, unresolved } = emitPatch({ decisions, rows })
    check('补丁发射无未解析项', unresolved.length === 0, JSON.stringify(unresolved))
    check('补丁先建组再禁用再重插',
      patch[0].insert?.[0]?.name === 'cordis:group'
      && patch.some(p => p.id === 'storage' && p.disabled === true)
      && patch.some(p => Array.isArray(p.insert) && p.id !== undefined),
      JSON.stringify(patch))
  }

  console.log('\n=== 4. 路由代理:争用路径不再抛错 ===')
  {
    const contributions = [
      { plane: 'host', kind: 'route', target: '/dsh-market/status', owner: 'pkg-a', source: null },
      { plane: 'host', kind: 'route', target: '/dsh-market/status', owner: 'pkg-b', source: null },
    ]
    const { decisions } = arbitrate(contributions, { order: ['pkg-a'] })
    const paths = new Map<string, unknown>()
    const real = {
      register(route: { path: string }) {
        if (paths.has(route.path)) throw new Error(`duplicate route "${route.path}"`)
        paths.set(route.path, route)
        return () => { paths.delete(route.path) }
      },
      registerUpgrade(route: { path: string }) { return this.register(route) },
    }
    let caller = 'pkg-a'
    const proxy = createRouteProxy({ real, plan: rewritePlan(decisions), ownerOf: () => caller })
    proxy.register({ path: '/dsh-market/status', kind: 'exact' })
    caller = 'pkg-b'
    let threw = false
    try { proxy.register({ path: '/dsh-market/status', kind: 'exact' }) } catch { threw = true }
    check('第二方注册不抛错', !threw)
    check('两条路由都在表里', paths.size === 2, JSON.stringify([...paths.keys()]))
    check('胜者保持原路径', paths.has('/dsh-market/status'))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
