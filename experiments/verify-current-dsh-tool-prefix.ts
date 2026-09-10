/** Verify the packaged prefix shim against a real DSH source checkout. */
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toolConflictStore } from '../plugin/src/tool-conflicts.mjs'
import { apply as applyBootstrap } from '../plugin/src/bootstrap.mjs'

const checkout = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: tsx verify-current-dsh-tool-prefix.ts <dsh-checkout>')
const load = (relative: string) => import(pathToFileURL(join(checkout, relative)).href)
const { Context } = await load('vendor/cordis/src/index.ts')
const { default: ToolRuntime } = await load('packages/core/tools/src/index.ts')
const { default: SystemPrompt } = await load('packages/core/system-prompt/src/index.ts')

let ok = 0
let fail = 0
const check = (label: string, condition: boolean, detail?: string): void => {
  if (condition) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tool = (name: string, owner: string) => ({
  name,
  description: `${name} from ${owner}`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
  execute: async () => owner,
})

async function mount(root: InstanceType<typeof Context>, owner: string, name: string) {
  let failure: unknown
  const fiber = await root.plugin({
    name: owner,
    inject: ['tools'],
    apply(ctx: { tools: { register(definition: unknown): () => void } }) {
      try { ctx.tools.register(tool(name, owner)) } catch (error) { failure = error }
    },
  })
  return { fiber, failure }
}

const root = new Context()
const bootstrap = await root.plugin({ name: 'dsh-substrate-bootstrap', apply: applyBootstrap })
await root.plugin(SystemPrompt, {})
await root.plugin(ToolRuntime, { mode: 'native' })
const store = toolConflictStore(root)

const first = await mount(root, '@fixture/browser-a', 'browser_click')
const second = await mount(root, '@fixture/browser-b', 'browser_click')
check('both real plugin fibers mount', first.failure === undefined && second.failure === undefined, String(second.failure))
check('winner keeps the original name', root.tools.schemas().some((schema: { name: string }) => schema.name === 'browser_click'))
check('duplicate is globally visible under package prefix', root.tools.schemas().some((schema: { name: string }) => schema.name === 'fixture_browser_b__browser_click'))
check('real runtime conflict is recorded', store.snapshot().items[0]?.owner === '@fixture/browser-b', JSON.stringify(store.snapshot()))
await second.fiber.dispose()
await new Promise(resolve => { setTimeout(resolve, 10) })
check('fiber disposal removes the alias', !root.tools.schemas().some((schema: { name: string }) => schema.name === 'fixture_browser_b__browser_click'))
check('fiber disposal clears the ledger', store.snapshot().items.length === 0)

const reserved = await mount(root, '@fixture/reserved', 'run_code')
check('real runtime still rejects run_code', reserved.failure !== undefined)
await reserved.fiber.dispose()
await first.fiber.dispose()
await bootstrap.dispose()

console.log(`\n=== result: ${ok} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
