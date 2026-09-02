/**
 * Put the adaptive policy inside `ToolRuntime.register` itself.
 *
 * `lab-adaptive-shim.ts` established the policy: ask the registry at
 * registration time, send a free name to the global layer and a taken one to
 * the caller's own scope. It did so from outside, with the caller cooperating.
 * This asks whether the same thing works as a patch on the runtime, which is
 * what makes it apply to plugins that know nothing about it.
 *
 * The lifecycle question is the one that decides whether this is shippable. A
 * scope minted from the wrong parent would outlive the plugin that registered
 * through it, so unloading a plugin would leave its tools behind. The scope is
 * therefore created from the *calling* Context, and that is asserted rather
 * than assumed.
 *
 * Run: node --import tsx/esm lab-adaptive-runtime.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import ToolRuntime from './packages/core/tools/src/index.ts'
import SystemPrompt from './packages/core/system-prompt/src/index.ts'
import { createScope, scopeOf } from './packages/core/scope/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tool = (name: string, owner: string) => ({
  name,
  description: `${name} from ${owner}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
  execute: () => `${name}:${owner}`,
})

/** Scopes this patch minted, so a shadowed tool can still be reached. */
const minted = new Map<string, { key: symbol, ctx: Context }>()

/**
 * The patch, as it would be applied to `@deepseek-ai/dsh-tools`.
 *
 * Two decisions carry it. The scope is created from `this.ctx` — the caller's
 * Context — so the registration's lifetime stays the plugin's. And an already
 * scoped caller is passed straight through: it asked for a layer, and second-
 * guessing that would break the deliberate case to fix the accidental one.
 */
function installAdaptiveRegister(): () => void {
  const proto = ToolRuntime.prototype as unknown as {
    register: (definition: { name: string }) => () => void
    schemas: (scope?: symbol) => { name: string }[]
    ctx: Context
  }
  const original = proto.register
  proto.register = function adaptive(definition) {
    const self = this as unknown as { ctx: Context, schemas: (s?: symbol) => { name: string }[] }
    const alreadyScoped = scopeOf(self.ctx) !== undefined
    const taken = self.schemas().some(s => s.name === definition.name)
    if (alreadyScoped || !taken) return original.call(this, definition)

    const owner = (self.ctx.fiber as { name?: string } | undefined)?.name ?? 'anonymous'
    let entry = minted.get(owner)
    if (entry === undefined) {
      const key = Symbol(owner)
      // Parented on the caller so the scope, and everything registered through
      // it, disposes when that plugin does. The Context that carries the scope
      // tag is the one `createScope` hands back — the tag is a module-private
      // symbol, so constructing it by hand silently produces an unscoped
      // Context and the registration lands globally and throws.
      const scope = createScope(self.ctx, key as never) as { ctx: Context }
      entry = { key, ctx: scope.ctx }
      minted.set(owner, entry)
    }
    return original.call({ ...self, ctx: entry.ctx } as never, definition)
  }
  return () => { proto.register = original }
}

/** Mount a plugin that registers one tool, returning its fiber. */
async function pluginRegistering(root: Context, name: string, def: unknown) {
  // A throw inside `apply` does not always reach the awaiting caller, so it is
  // captured here. An earlier version of this file reported PASS for a case
  // that had in fact thrown and been swallowed.
  let failure: unknown
  const fiber = await root.plugin({
    name,
    inject: ['tools'],
    apply: (ctx: Context) => {
      try { (ctx as { tools: { register: (d: unknown) => unknown } }).tools.register(def) }
      catch (e) { failure = e }
    },
  })
  return { fiber, failure }
}

async function main(): Promise<void> {
  const root = new Context()
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, { mode: 'native' })
  const runtime = root.tools as { schemas: (scope?: symbol) => { name: string, description?: string }[] }

  console.log('\n=== 打补丁前:第二个注册者抛错 ===')
  {
    await pluginRegistering(root, 'pkg-a', tool('browser_click', 'pkg-a'))
    const second = await pluginRegistering(root, 'pkg-b', tool('browser_click', 'pkg-b'))
    check('确认基线', second.failure !== undefined, String(second.failure).slice(0, 90))
  }

  const restore = installAdaptiveRegister()

  console.log('\n=== 打补丁后 ===')
  {
    const third = await pluginRegistering(root, 'pkg-c', tool('browser_click', 'pkg-c'))
    check('第三个注册者不再抛错 —— 插件自己什么都不用知道',
      third.failure === undefined, String(third.failure).slice(0, 130))

    const global = runtime.schemas().filter(s => s.name === 'browser_click')
    check('全局仍然只有一个', global.length === 1, String(global.length))
    check('赢家还是最先注册的 pkg-a', /pkg-a/.test(String(global[0]?.description)), String(global[0]?.description))
  }

  console.log('\n=== 落败者的那一份仍可经它的 scope 取到 ===')
  {
    const key = minted.get('pkg-c')?.key
    const view = runtime.schemas(key).filter(s => s.name === 'browser_click')
    check('scope 视图里有它', view.length >= 1, String(view.length))
    check('而且是 pkg-c 那一份', /pkg-c/.test(String(view[0]?.description)), String(view[0]?.description))
  }

  console.log('\n=== 没冲突的工具行为完全不变 ===')
  {
    await pluginRegistering(root, 'pkg-d', tool('browser_a11y', 'pkg-d'))
    const global = runtime.schemas().map(s => s.name)
    check('照常进全局', global.includes('browser_a11y'), JSON.stringify(global))
    check('没有为它铸 scope —— 改动只在冲突时才发生', minted.get('pkg-d') === undefined)
  }

  console.log('\n=== 生命周期:卸载插件要带走它的工具 ===')
  {
    const { fiber, failure } = await pluginRegistering(root, 'pkg-e', tool('browser_click', 'pkg-e'))
    check('分层注册没有抛错', failure === undefined, String(failure).slice(0, 110))
    const key = minted.get('pkg-e')?.key
    check('分层注册成功', runtime.schemas(key).some(s => /pkg-e/.test(String(s.description))))
    await fiber.dispose()
    await new Promise(resolve => { setTimeout(resolve, 50) })
    check('卸载后它的那一份消失 —— scope 挂在调用方名下,不是全局',
      !runtime.schemas(key).some(s => /pkg-e/.test(String(s.description))),
      JSON.stringify(runtime.schemas(key).map(s => s.description).slice(0, 3)))
  }

  console.log('\n=== 保留名不开后门 ===')
  {
    const reserved = await pluginRegistering(root, 'pkg-f', tool('run_code', 'pkg-f'))
    check('run_code 照样抛错', reserved.failure !== undefined, String(reserved.failure).slice(0, 90))
  }

  restore()
  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}

await main()
