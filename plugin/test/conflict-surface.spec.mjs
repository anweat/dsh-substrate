import { ConflictController } from '../lib/client/conflict-controller.js'
import { CONFLICTS_ROUTE, registerConflictRpc } from '../src/conflict-rpc.mjs'

let ok = 0
let fail = 0
const check = (label, condition, detail) => {
  if (condition) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const report = {
  mode: 'default-prefix',
  modes: [
    { id: 'default-prefix', available: true, label: 'Default injection', reason: 'active' },
    { id: 'search-only', available: false, label: 'Search only', reason: 'no dispatcher' },
    { id: 'collapsed-search', available: false, label: 'Collapsed search', reason: 'no references' },
  ],
  items: [{ id: 'one', owner: 'pkg-b', originalName: 'read', exposedName: 'pkg_b__read', mode: 'default-prefix' }],
}

console.log('\n=== conflict RPC ===')
{
  let route
  const ctx = {
    inject(_deps, action) {
      action({
        effect(effect) { effect() },
        connection: { fetch: { register(spec) { route = spec; return () => {} } } },
      })
    },
  }
  registerConflictRpc(ctx, () => report)
  check('registers one exact read-only route', route.path === CONFLICTS_ROUTE && route.methods.length === 1 && route.methods[0] === 'POST')
  const response = await route.fetch(new Request('http://localhost/api/dsh-substrate/conflicts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'dsh-substrate/conflicts', payload: {} }),
  }))
  const body = await response.json()
  check('returns the current conflict report in the standard envelope', body.result.ok && body.result.value.items[0].exposedName === 'pkg_b__read', JSON.stringify(body))
  const rejected = await route.fetch(new Request('http://localhost/api/dsh-substrate/conflicts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'wrong' }),
  }))
  check('rejects any other method name', !(await rejected.json()).result.ok)
}

console.log('\n=== conflict client controller ===')
{
  const calls = []
  const controller = new ConflictController({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload })
      return { ok: true, value: report }
    },
  })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  const state = controller.inject().hooks.substrateConflicts.getSnapshot()
  check('calls the conflict endpoint through the shared connection', calls.length === 1 && calls[0].channel === '/api' && calls[0].endpoint === 'dsh-substrate/conflicts', JSON.stringify(calls))
  check('publishes aliases and mode availability', state.loaded && state.report.items.length === 1 && !state.report.modes[1].available)
  controller.dispose()
}

{
  const controller = new ConflictController({ async call() { return { ok: false, error: { message: 'denied' } } } })
  await new Promise(resolve => { setTimeout(resolve, 0) })
  const state = controller.inject().hooks.substrateConflicts.getSnapshot()
  check('publishes Host failures instead of stale data', state.loaded && state.report === undefined && state.error === 'denied', JSON.stringify(state))
  controller.dispose()
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
