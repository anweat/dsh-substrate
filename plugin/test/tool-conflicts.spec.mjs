import {
  installToolConflictPrefixing,
  prefixedToolName,
  toolPrefix,
  ToolConflictStore,
} from '../src/tool-conflicts.mjs'
import { apply as applyBootstrap } from '../src/bootstrap.mjs'

let ok = 0
let fail = 0
const check = (label, condition, detail) => {
  if (condition) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

class Runtime {
  constructor(layer, owner) {
    this.layer = layer
    const effects = new Set()
    this.ctx = {
      fiber: { name: owner },
      effect(action) {
        const cleanup = action()
        effects.add(cleanup)
        return () => { if (effects.delete(cleanup)) cleanup?.() }
      },
      dispose() { for (const cleanup of effects) cleanup?.(); effects.clear() },
    }
  }

  register(definition) {
    if (definition.name === 'run_code') throw new Error('tool name "run_code" is reserved')
    if (this.layer.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered (fixture)`)
    this.layer.set(definition.name, definition)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.layer.delete(definition.name)
    }
  }

  schemas() { return [...this.layer.values()] }
}

const tool = (name, owner) => ({ name, description: `${owner} ${name}`, execute: () => owner })

console.log('\n=== npm/plugin prefix ===')
check('scoped npm package becomes a stable model-safe prefix', toolPrefix('@anweat/dsh-browser@0.1.14-alpha.1') === 'anweat_dsh_browser')
check('ordinary plugin name is normalized', toolPrefix('context-console') === 'context_console')
check('long aliases stay within 64 characters', prefixedToolName('@very-long-scope/very-long-plugin-name', 'x'.repeat(80)).length <= 64)
check('same inputs produce the same alias', prefixedToolName('pkg-a', 'x'.repeat(80)) === prefixedToolName('pkg-a', 'x'.repeat(80)))

console.log('\n=== duplicate fallback ===')
{
  const layer = new Map()
  const store = new ToolConflictStore()
  const first = new Runtime(layer, 'pkg-a')
  const second = new Runtime(layer, '@scope/pkg-b')
  const restore = installToolConflictPrefixing(first, store)
  const disposeFirst = first.register(tool('browser_click', 'pkg-a'))
  const disposeSecond = second.register(tool('browser_click', 'pkg-b'))
  const names = [...layer.keys()]
  const snapshot = store.snapshot()
  check('winner keeps the original name', names.includes('browser_click'), JSON.stringify(names))
  check('duplicate receives the npm/plugin prefix', names.includes('scope_pkg_b__browser_click'), JSON.stringify(names))
  check('conflict appears in the read-only ledger', snapshot.items.length === 1 && snapshot.items[0].originalName === 'browser_click', JSON.stringify(snapshot.items))
  check('default injection is the active available mode', snapshot.mode === 'default-prefix' && snapshot.modes[0].available === true)
  check('search-only choices are listed but unavailable', snapshot.modes.slice(1).every(mode => mode.available === false))
  check('aliased tool keeps the original implementation', layer.get('scope_pkg_b__browser_click').execute() === 'pkg-b')

  const disposeThird = second.register(tool('browser_click', 'pkg-b-2'))
  check('another collision gets a deterministic ordinal', layer.has('scope_pkg_b__browser_click__2'), JSON.stringify([...layer.keys()]))
  check('every active collision is listed', store.snapshot().items.length === 2)
  disposeThird()
  check('manual disposal removes its conflict record', store.snapshot().items.length === 1)
  disposeSecond()
  check('manual disposal removes the remaining record', store.snapshot().items.length === 0)
  disposeFirst()

  let reserved = false
  try { second.register(tool('run_code', 'pkg-b')) } catch { reserved = true }
  check('reserved run_code still fails', reserved)
  restore()
  first.register(tool('plain', 'pkg-a'))
  let duplicate = false
  try { second.register(tool('plain', 'pkg-b')) } catch { duplicate = true }
  check('disposing the substrate restores the original runtime method', duplicate)
}

console.log('\n=== explicit scope behavior ===')
{
  const global = new Map([['read', tool('read', 'global')]])
  const local = new Map()
  const store = new ToolConflictStore()
  const scoped = new Runtime(local, 'agent-scope')
  scoped.schemas = () => [...global.values(), ...local.values()]
  const restore = installToolConflictPrefixing(scoped, store)
  scoped.register(tool('read', 'agent'))
  check('a name free in the explicit scope is not renamed', local.has('read'))
  check('no false conflict is recorded for normal shadowing', store.snapshot().items.length === 0)
  restore()
}

console.log('\n=== early loader bootstrap ===')
{
  const layer = new Map()
  class ToolRuntime extends Runtime {}
  let observer
  const root = {}
  const ctx = {
    root,
    get() { return undefined },
    on(name, listener, options) {
      if (name === 'internal/plugin' && options?.prepend === true) observer = listener
      return () => { observer = undefined }
    },
  }
  const dispose = applyBootstrap(ctx)
  observer({ runtime: { callback: ToolRuntime } })
  const first = new ToolRuntime(layer, 'early-a')
  const second = new ToolRuntime(layer, 'early-b')
  first.register(tool('shared', 'a'))
  second.register(tool('shared', 'b'))
  check('bootstrap patches ToolRuntime before construction', layer.has('early_b__shared'), JSON.stringify([...layer.keys()]))
  dispose()
  first.register(tool('after', 'a'))
  let duplicate = false
  try { second.register(tool('after', 'b')) } catch { duplicate = true }
  check('bootstrap disposer restores the runtime prototype', duplicate)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
