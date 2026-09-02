/**
 * Decide layering at registration time instead of from a catalog.
 *
 * The e2e install scoped the losers of an arbitration, which needs to know in
 * advance who loses — a catalog, which over-derives, goes stale on every DSH
 * release, and is the one piece of the substrate that cannot be made exact
 * (`lab-derived-entry-id.ts` and the baseline notes cover why).
 *
 * But a tool conflict happens when `register` is called, and a shim sits on
 * exactly that call. At that moment the question "is this name already taken"
 * has an exact answer, from the registry itself. A shim that asks it needs no
 * catalog at all: a free name goes to the global namespace as it would have,
 * and a taken one goes into the plugin's own scope.
 *
 * What has to hold for that to be worth building:
 *   - an uncontended tool still lands globally, so nothing changes for the 42
 *     names in the real browser stack that only one package claims
 *   - a contended one lands in a scope instead of throwing
 *   - the winner is the first registrant, which is deterministic given row order
 *   - the loser's tool is still reachable through its scope, not deleted
 *
 * Run: node --import tsx/esm lab-adaptive-shim.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import ToolRuntime from './packages/core/tools/src/index.ts'
import SystemPrompt from './packages/core/system-prompt/src/index.ts'
import { createScope } from './packages/core/scope/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A minimal valid tool definition; `output.render` is required or registration throws. */
const tool = (name: string, owner: string) => ({
  name,
  description: `${name} from ${owner}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
  execute: () => `${name}:${owner}`,
})

/** Carries one definition into a scope through a real plugin fiber. */
const Registrar = Object.assign(
  (ctx: Context, config: { def: unknown }) => { (ctx as { tools: { register: (d: unknown) => unknown } }).tools.register(config.def) },
  { inject: ['tools'] },
)

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const runtime = ctx.tools as {
    register: (def: unknown) => () => void
    schemas: (scope?: symbol) => { name: string }[]
  }

  /** Scopes minted per owner, so a shadowed tool stays reachable. */
  const scopes = new Map<string, { key: symbol, scope: { ctx: Context } }>()
  const layered: string[] = []

  /**
   * The whole policy: ask the registry, then choose. No catalog, no ordering
   * pass, no advance knowledge of who registers what.
   */
  function registerAdaptively(owner: string, def: { name: string }): void {
    const taken = runtime.schemas().some(s => s.name === def.name)
    if (!taken) { runtime.register(def); return }
    let entry = scopes.get(owner)
    if (entry === undefined) {
      const key = Symbol(owner)
      entry = { key, scope: createScope(ctx, key as never) as { ctx: Context } }
      scopes.set(owner, entry)
    }
    layered.push(`${def.name} (${owner})`)
    void entry.scope.ctx.plugin(Registrar, { def })
  }

  console.log('\n=== 无争用的工具照常进全局 ===')
  {
    registerAdaptively('pkg-a', tool('browser_a11y', 'pkg-a'))
    registerAdaptively('pkg-b', tool('browser_download', 'pkg-b'))
    const global = runtime.schemas().map(s => s.name)
    check('两个独有工具都在全局', global.includes('browser_a11y') && global.includes('browser_download'), JSON.stringify(global))
    check('没有任何东西被分层', layered.length === 0, JSON.stringify(layered))
  }

  console.log('\n=== 争用的工具进 scope,而不是抛错 ===')
  {
    registerAdaptively('pkg-a', tool('browser_click', 'pkg-a'))
    let threw: unknown
    try { registerAdaptively('pkg-b', tool('browser_click', 'pkg-b')) } catch (e) { threw = e }
    check('第二个注册者没有抛错', threw === undefined, String(threw).slice(0, 120))
    check('它被记为分层', layered.some(l => l.startsWith('browser_click')), JSON.stringify(layered))

    const global = runtime.schemas().map(s => s.name).filter(n => n === 'browser_click')
    check('全局命名空间里只有一个 browser_click', global.length === 1, JSON.stringify(global))
  }

  console.log('\n=== 赢家是先注册的那个 ===')
  {
    const winner = runtime.schemas().find(s => s.name === 'browser_click') as { description?: string } | undefined
    check('全局那个来自 pkg-a', /pkg-a/.test(String(winner?.description)), String(winner?.description))
  }

  console.log('\n=== 落败者的工具没被删掉,仍可经它的 scope 取到 ===')
  {
    await new Promise(resolve => { setTimeout(resolve, 50) })
    const scoped = scopes.get('pkg-b')
    const view = runtime.schemas(scoped?.key).map(s => s.name)
    check('pkg-b 的 scope 视图里有 browser_click', view.includes('browser_click'), JSON.stringify(view.slice(0, 8)))
    const inScope = runtime.schemas(scoped?.key).find(s => s.name === 'browser_click') as { description?: string } | undefined
    check('而且是 pkg-b 那一份 —— 近的遮蔽远的', /pkg-b/.test(String(inScope?.description)), String(inScope?.description))
  }

  console.log('\n=== 落败者的其它工具仍然全局可见 ===')
  {
    registerAdaptively('pkg-b', tool('browser_execute', 'pkg-b'))
    const global = runtime.schemas().map(s => s.name)
    check('输掉一个名字不牵连它的其它工具', global.includes('browser_execute'), JSON.stringify(global))
  }

  console.log('\n=== 保留名仍然被拒 ===')
  {
    let threw = false
    try { registerAdaptively('pkg-c', tool('run_code', 'pkg-c')) } catch { threw = true }
    check('run_code 照样抛错 —— 自适应不给保留名开后门', threw)
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
