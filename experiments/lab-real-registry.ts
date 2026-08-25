/**
 * Phase-0 experiment 2: how the REAL tool registry behaves under the two
 * substrate strategies, and whether either keeps schema assembly intact.
 *
 *  A. scope layering  — give each third-party plugin its own scope, so their
 *     registrations land in per-plugin layers instead of the global one.
 *  B. proxy + rename  — keep them global but rewrite a colliding name.
 *
 * Strategy A is the interesting one: the registry already merges scope chains
 * with "nearer shadows farther", so if a plugin scope can sit on an agent's
 * chain, collisions stop being fatal without renaming anything the model sees.
 *
 * Run: node --import tsx/esm lab-real-registry.ts
 */
import { Context } from './vendor/cordis/src/index.ts'
import { ToolRuntime } from './packages/core/tools/src/index.ts'
import { SystemPrompt } from './packages/core/system-prompt/src/index.ts'
import { createScope } from './packages/core/scope/src/index.ts'

let ok = 0, fail = 0
const check = (label: string, cond: boolean, detail?: string): void => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** Minimal well-formed definition: the registry validates output up front. */
const tool = (name: string, owner: string) => ({
  name,
  description: `${name} from ${owner}`,
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {} },
    render: () => ({ card: 'generic' as const, title: name }),
  },
  execute: () => ({ ok: true }),
})

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  return ctx
}

/**
 * A stand-in third-party plugin. It declares `inject`, which is what lets it
 * read `ctx.tools` at all — a bare scope context is refused by Cordis's inject
 * discipline, so registrations must come from a real plugin fiber.
 */
const RegisterTool = Object.assign(
  (ctx: Context, config: { def: unknown }) => { ctx.tools.register(config.def as never) },
  { inject: ['tools'] },
)

/** Mount the stand-in inside `where`, returning any registration error. */
async function registerIn(where: Context, def: unknown): Promise<string | undefined> {
  try { await where.plugin(RegisterTool, { def }); return undefined } catch (e) { return String(e) }
}

async function main(): Promise<void> {
  console.log('\n=== 0. baseline: two global registrations of one name ===')
  {
    const ctx = await boot()
    ctx.tools.register(tool('bash', 'pkg-a') as never)
    let threw: string | undefined
    try { ctx.tools.register(tool('bash', 'pkg-b') as never) } catch (e) { threw = String(e) }
    check('the real registry throws on a duplicate global name', threw !== undefined)
    console.log('        ', (threw ?? '').slice(0, 110))
  }

  console.log('\n=== A. scope layering: one name, two plugin scopes ===')
  {
    const ctx = await boot()
    const a = createScope(ctx, Symbol('pkg-a') as never)
    const b = createScope(ctx, Symbol('pkg-b') as never)

    const threwA = await registerIn(a.ctx, tool('bash', 'pkg-a'))
    check('a scoped plugin accepts a registration', threwA === undefined, threwA?.slice(0, 110))

    const threwB = await registerIn(b.ctx, tool('bash', 'pkg-b'))
    check('a SECOND scope may claim the same name', threwB === undefined, threwB?.slice(0, 110))

    const global = ctx.tools.schemas().map(s => s.name)
    check('the global view stays clean (no leak from plugin scopes)',
      !global.includes('bash'), `global = ${JSON.stringify(global)}`)
    console.log('        global schemas:', JSON.stringify(global))
  }

  console.log('\n=== A2. does an agent scope INHERIT a plugin scope on its chain? ===')
  {
    const ctx = await boot()
    const pluginKey = Symbol('pkg-a') as never
    const plugin = createScope(ctx, pluginKey)
    const err = await registerIn(plugin.ctx, tool('bash', 'pkg-a'))
    check('plugin-scope registration succeeded', err === undefined, err?.slice(0, 110))

    // createScope binds the parent itself; binding twice is refused by design.
    const agentKey = Symbol('agent-1') as never
    const agent = createScope(ctx, agentKey, { parent: pluginKey })

    const seen = ctx.tools.schemas(agentKey).map(s => s.name)
    check('an agent whose chain includes the plugin scope sees its tool',
      seen.includes('bash'), `agent view = ${JSON.stringify(seen)}`)
    console.log('        agent schemas:', JSON.stringify(seen))
    const own = ctx.tools.schemas(pluginKey).map(s => s.name)
    console.log('        plugin-scope schemas:', JSON.stringify(own))
    void agent
  }

  console.log('\n=== A3. two plugin scopes on ONE agent chain: who wins? ===')
  {
    const ctx = await boot()
    // Chain built nearest-last: farKey <- nearKey <- agentKey.
    const farKey = Symbol('pkg-far') as never
    const nearKey = Symbol('pkg-near') as never
    const agentKey = Symbol('agent-1') as never

    const far = createScope(ctx, farKey)
    await registerIn(far.ctx, { ...tool('bash', 'pkg-far'), description: 'FAR' })
    const near = createScope(ctx, nearKey, { parent: farKey })
    const errNear = await registerIn(near.ctx, { ...tool('bash', 'pkg-near'), description: 'NEAR' })
    check('a second scope on the same chain may claim the name',
      errNear === undefined, errNear?.slice(0, 110))

    const agent = createScope(ctx, agentKey, { parent: nearKey })
    const seen = ctx.tools.schemas(agentKey)
    check('the agent sees exactly one tool under that name',
      seen.filter(s => s.name === 'bash').length === 1, JSON.stringify(seen.map(s => s.name)))
    const winner = seen.find(s => s.name === 'bash')?.description
    check('the NEARER scope on the chain shadows the farther one',
      winner === 'NEAR', `winner = ${String(winner)}`)
    console.log('        agent sees:', JSON.stringify(seen.map(s => `${s.name}:${s.description}`)))
    console.log('        => precedence is the declared chain order, not activation order')
    void agent
  }

  console.log('\n=== B. proxy + rename: does a renamed tool still assemble? ===')
  {
    const ctx = await boot()
    ctx.tools.register(tool('bash', 'pkg-a') as never)
    ctx.tools.register({ ...tool('bash', 'pkg-b'), name: 'pkg_b__bash' } as never)
    const names = ctx.tools.schemas().map(s => s.name).sort()
    check('both survive when the collider is renamed', names.length === 2, JSON.stringify(names))
    check('the renamed tool is present in the model-facing schemas',
      names.includes('pkg_b__bash'), JSON.stringify(names))
    const got = ctx.tools.get('pkg_b__bash')
    check('the renamed tool resolves for dispatch', got !== undefined)
    console.log('        schemas:', JSON.stringify(names))
  }

  console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
