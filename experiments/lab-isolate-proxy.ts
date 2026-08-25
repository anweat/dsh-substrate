/**
 * Phase-0 experiment 1: can a shim give an isolated subtree its own instance of
 * a service, proxy to the real one, and thereby turn a fatal duplicate
 * registration into a namespaced one?
 *
 * This is the mechanism a compatibility substrate would rest on: third-party
 * plugins keep calling `ctx.tools.register({ name: 'bash' })` unchanged, but
 * resolve `tools` to a proxy that rewrites the name before it reaches the real
 * registry, so two plugins claiming one name both survive.
 *
 * Run: node --import tsx/esm lab-isolate-proxy.ts
 */
import { Context, Service } from './vendor/cordis/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

interface ToolDef { name: string, owner?: string, declaredName?: string }

/** Stands in for `ctx.tools`: a flat registry that throws on a duplicate name. */
class RealTools extends Service {
  entries = new Map<string, ToolDef>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(def: ToolDef): () => void {
    if (this.entries.has(def.name)) throw new Error(`tool "${def.name}" is already registered`)
    this.entries.set(def.name, def)
    return () => { this.entries.delete(def.name) }
  }
  names(): string[] { return [...this.entries.keys()].sort() }
}

/** A realm-private context: exactly what the loader's `isolate` entry option builds. */
function inRealm(ctx: Context, name: string, realm: symbol): Context {
  return ctx.extend({
    [Context.isolate]: Object.assign(Object.create(ctx[Context.isolate]), { [name]: realm }),
  })
}

async function main(): Promise<void> {
  console.log('\n=== 1. baseline: a flat registry really does throw ===')
  {
    const ctx = new Context()
    await ctx.plugin(RealTools)
    ctx.tools.register({ name: 'bash', owner: 'a' })
    let threw = false
    try { ctx.tools.register({ name: 'bash', owner: 'b' }) } catch { threw = true }
    check('duplicate name throws on the shared registry', threw)
  }

  console.log('\n=== 2. isolate: does a remapped symbol give a separate instance? ===')
  {
    const ctx = new Context()
    await ctx.plugin(RealTools)
    const realm = Symbol('tools@sandbox')
    const isolated = inRealm(ctx, 'tools', realm)
    check('isolated context does not resolve the root implementation',
      isolated.get('tools') === undefined, `got ${String(isolated.get('tools'))}`)
    check('root still resolves its own implementation', ctx.tools instanceof RealTools)
    check('ctx.root from inside the realm reaches the real one',
      isolated.root.tools instanceof RealTools)
  }

  console.log('\n=== 3. proxy: shim provides into the realm and forwards outward ===')
  {
    const ctx = new Context()
    await ctx.plugin(RealTools)
    const realm = Symbol('tools@sandbox')

    /**
     * The substrate. Cordis rebinds `this.ctx` to whichever context reads the
     * service, so ONE instance can attribute every call to its caller — the
     * same trick the shipped `HostConnectionService` uses for RPC channels.
     * A realm holds exactly one implementation, so per-plugin shims are wrong.
     */
    class ProxyTools extends Service {
      real: RealTools
      constructor(ctx: Context) {
        super(ctx, 'tools')
        // The root context resolves names through the ROOT isolate map, which
        // the realm remap never touched — so this is the real registry.
        this.real = ctx.root.tools as RealTools
      }
      register(def: ToolDef): () => void {
        const owner = (this.ctx as unknown as { __owner?: string }).__owner ?? 'anonymous'
        const taken = this.real.names().includes(def.name)
        const name = taken ? `${owner}__${def.name}` : def.name
        return this.real.register({ ...def, name, declaredName: def.name, owner })
      }
      names(): string[] { return this.real.names() }
    }

    const realmCtx = inRealm(ctx, 'tools', realm)
    await realmCtx.plugin(ProxyTools)
    check('one shim provides tools inside the realm',
      (realmCtx.tools as unknown as ProxyTools) instanceof ProxyTools)
    check('shim resolved the real registry through ctx.root',
      (realmCtx.tools as unknown as ProxyTools).real instanceof RealTools)

    // Each third-party plugin gets a tagged child of the realm context.
    const pluginCtx = (owner: string): Context => realmCtx.extend({ __owner: owner })
    const a = pluginCtx('pkg-a')
    const b = pluginCtx('pkg-b')
    check('the service sees the CALLING context, not the mounting one',
      (a.tools as unknown as { ctx: { __owner?: string } }).ctx.__owner === 'pkg-a',
      `saw ${String((a.tools as unknown as { ctx: { __owner?: string } }).ctx.__owner)}`)

    a.tools.register({ name: 'bash' })
    let threw = false
    try { b.tools.register({ name: 'bash' }) } catch (e) {
      threw = true
      console.log('        threw:', String(e).slice(0, 90))
    }
    check('second plugin claiming the same name did NOT throw', !threw)
    check('both registrations survive in the real registry',
      ctx.tools.names().length === 2, `names = ${JSON.stringify(ctx.tools.names())}`)
    check('the collision was namespaced by its owner',
      ctx.tools.names().includes('pkg-b__bash'), JSON.stringify(ctx.tools.names()))
    console.log('        real registry now holds:', JSON.stringify(ctx.tools.names()))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
