/**
 * The preset-host mode against the real registry.
 *
 * The gatekeeper refuses; this repairs. It asserts the composition the
 * substrate would build at agent setup — standing mount, then one scope per
 * arbitrated plugin, then the agent — actually resolves the way arbitration
 * said it would, using the real `ToolRuntime` and the real `dsh-scope`.
 *
 * The wrapper's own contract is checked too: a roster method the substrate does
 * not forward must be reported, not silently bypassed.
 *
 * Run: node --import tsx/esm lab-preset-host.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'
import { createScope, bindScopeParent } from './packages/core/scope/src/index.ts'
import { arbitrate } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/arbitrate.mjs'
import { planScopeChain } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/scope-chain.mjs'
import { buildPluginChain, wrapPresetRoster, unhandledMethods } from '../dsh-plugin/plugins/dsh-conflict-substrate/src/preset-host.mjs'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tool = (name: string, owner: string) => ({
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
  (ctx: Context, config: { def: unknown }) => { ctx.tools.register(config.def as never) },
  { inject: ['tools'] },
)

async function main(): Promise<void> {
  console.log('\n=== 1. 常驻挂载 → 插件链 → agent,整条链解析正确 ===')
  {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })

    // The preset's standing mount: composed, but binding no agent — this is
    // what `standingKeyFor` gives a substrate.
    const standingKey = Symbol('standing') as never
    const standing = createScope(ctx, standingKey)
    await standing.ctx.plugin(RegisterTool, { def: tool('preset-tool', 'standing') })
    await standing.ctx.plugin(RegisterTool, { def: tool('bash', 'standing') })

    const contributions = [
      { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-a', source: null },
      { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-b', source: null },
    ]
    const policy = { order: ['pkg-b', 'pkg-a'] }
    const { decisions } = arbitrate(contributions, policy)
    const chain = planScopeChain(decisions, policy).chain
    check('裁决把 pkg-b 排在更近处', chain[0] === 'pkg-b', JSON.stringify(chain))

    const keys = new Map<string, symbol>(chain.map(o => [o, Symbol(o)]))
    const built = buildPluginChain({
      standingKey,
      chain,
      keyOf: (o: string) => keys.get(o) as never,
      createScope: (key: symbol, parent: symbol) => createScope(ctx, key as never, { parent: parent as never }),
    })
    check('每个插件都拿到一个 scope', built.scopes.length === chain.length, String(built.scopes.length))
    check('最远端插件的父是常驻挂载',
      built.scopes[0].parent === standingKey, String(built.scopes[0].owner))
    check('agent 应绑定到最近端插件', built.head === keys.get(chain[0]), String(built.head))

    for (const s of built.scopes) {
      await (s.scope as { ctx: Context }).ctx.plugin(RegisterTool, { def: tool('bash', s.owner) })
    }
    const agentKey = Symbol('agent') as never
    createScope(ctx, agentKey, { parent: built.head as never })

    const seen = ctx.tools.schemas(agentKey)
    const names = seen.map(s => s.name).sort()
    check('agent 同时看到预设的工具和插件的工具',
      names.includes('preset-tool') && names.includes('bash'), JSON.stringify(names))
    check('bash 只出现一次', seen.filter(s => s.name === 'bash').length === 1, JSON.stringify(names))
    const bash = seen.find(s => s.name === 'bash')
    check('胜出的是裁决选中的 pkg-b,而不是预设自带的那个',
      bash?.description === 'bash@pkg-b', bash?.description)
    check('名字未被改动', bash?.name === 'bash')
    check('全局层仍然干净',
      !ctx.tools.schemas().some(s => s.name === 'bash'), JSON.stringify(ctx.tools.schemas().map(s => s.name)))
  }

  console.log('\n=== 2. 无冲突时链为空,agent 直接绑到常驻挂载 ===')
  {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    const standingKey = Symbol('standing2') as never
    createScope(ctx, standingKey)
    const built = buildPluginChain({
      standingKey, chain: [], keyOf: () => Symbol('x') as never, createScope: () => ({}),
    })
    check('空链不铸任何 scope', built.scopes.length === 0)
    check('agent 直接绑常驻挂载', built.head === standingKey)
  }

  console.log('\n=== 3. 包装器:mount 不再由 roster 绑定 agent ===')
  {
    const calls: string[] = []
    const real = {
      standingKeyFor: async (id: string) => { calls.push(`standingKeyFor:${id}`); return `standing:${id}` },
      resolve: async (id: string) => { calls.push(`resolve:${id}`); return { id } },
      mount: async () => { calls.push('real.mount'); return {} },
      recompose: async () => { calls.push('real.recompose'); return {} },
      list: async () => { calls.push('list'); return [] },
      read: async () => 'x', copy: async () => {}, remove: async () => {},
      composeFrom: () => undefined, composedPreset: () => undefined, serviceFor: () => undefined,
    }
    let boundTo: unknown
    const wrapped = wrapPresetRoster({
      real,
      plan: () => ['p1', 'p2'],
      keyOf: (o: string) => `key:${o}`,
      createScope: (key: string, parent: string) => ({ key, parent }),
      bindAgent: (_ctx: unknown, head: unknown) => { boundTo = head },
    })
    const agentCtx = {}
    await wrapped.mount(agentCtx, 'standard')
    check('走的是 standingKeyFor,不是 real.mount',
      calls.includes('standingKeyFor:standard') && !calls.includes('real.mount'), JSON.stringify(calls))
    check('agent 被绑到最近端插件而不是常驻 key',
      boundTo === 'key:p1', String(boundTo))
    const record = wrapped.compositionOf(agentCtx)
    check('组合被记录下来可供报告',
      record?.chain.length === 2 && record?.standingKey === 'standing:standard', JSON.stringify(record))
    check('其余方法原样委托',
      (await wrapped.list()) !== undefined && calls.includes('list'), JSON.stringify(calls))
  }

  console.log('\n=== 4. 上游新增方法必须被发现,而不是静默绕过 ===')
  {
    const real = {
      standingKeyFor: async () => 'k', resolve: async () => ({}), mount: async () => ({}),
      recompose: async () => ({}), list: async () => [], read: async () => '', copy: async () => {},
      remove: async () => {}, composeFrom: () => undefined, composedPreset: () => undefined,
      serviceFor: () => undefined,
      brandNewUpstreamMethod: () => 'surprise',
    }
    const missing = unhandledMethods(real)
    check('未转发的方法被报出', missing.includes('brandNewUpstreamMethod'), JSON.stringify(missing))
    const clean = { ...real } as Record<string, unknown>
    delete clean.brandNewUpstreamMethod
    check('完全覆盖时不报任何遗漏', unhandledMethods(clean).length === 0, JSON.stringify(unhandledMethods(clean)))
  }

  console.log('\n=== 5. 绑定一次性:底座必须是唯一的绑定者 ===')
  {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const parentKey = Symbol('p') as never
    createScope(ctx, parentKey)
    const agentKey = Symbol('a') as never
    bindScopeParent(agentKey, parentKey)
    let threw = false
    try { bindScopeParent(agentKey, Symbol('other') as never) } catch { threw = true }
    check('第二次绑定被拒 —— 所以 roster 不能先绑,否则底座无从插入', threw)
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
