/**
 * Realm-proxy tests.
 *
 * The registry being proxied throws on a duplicate path and has no scope
 * model, so the proxy is the only remedy — these pin that it removes the
 * throw without moving anything it did not have to.
 *
 * Run: node test/realm-proxy.spec.mjs
 */
import { rewritePlan, resolveRoute, createRouteProxy } from '../src/realm-proxy.mjs'
import { arbitrate } from '../src/arbitrate.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** Stands in for `ctx.webServer`: flat table, throws on a duplicate. */
function realRegistry() {
  const paths = new Map()
  return {
    paths,
    register(route) {
      if (paths.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      paths.set(route.path, route)
      return () => { paths.delete(route.path) }
    },
    registerUpgrade(route) { return this.register(route) },
    names() { return [...paths.keys()].sort() },
  }
}

console.log('\n=== 基线:未代理时重复路径抛错 ===')
{
  const real = realRegistry()
  real.register({ kind: 'prefix', path: '/x' })
  let threw = false
  try { real.register({ kind: 'prefix', path: '/x' }) } catch { threw = true }
  check('真注册表对重复路径抛错', threw)
}

console.log('\n=== 代理后两方共存 ===')
{
  const contributions = [
    { plane: 'host', kind: 'route', target: '/dsh-market/status', owner: 'pkg-a', source: null },
    { plane: 'host', kind: 'route', target: '/dsh-market/status', owner: 'pkg-b', source: null },
  ]
  const { decisions } = arbitrate(contributions, { order: ['pkg-a', 'pkg-b'] })
  const plan = rewritePlan(decisions)
  const real = realRegistry()
  let caller = 'pkg-a'
  const proxy = createRouteProxy({ real, plan, ownerOf: () => caller })

  proxy.register({ kind: 'exact', path: '/dsh-market/status' })
  caller = 'pkg-b'
  let threw = false
  try { proxy.register({ kind: 'exact', path: '/dsh-market/status' }) } catch { threw = true }

  check('第二方注册不再抛错', !threw)
  check('两条路由都进了真注册表', real.names().length === 2, JSON.stringify(real.names()))
  check('胜者保持原路径', real.names().includes('/dsh-market/status'), JSON.stringify(real.names()))
  check('落败者被改写且仍以 / 开头',
    real.names().some(p => p !== '/dsh-market/status' && p.startsWith('/')), JSON.stringify(real.names()))
  check('改写被记录下来可供展示',
    proxy.rewrites().length === 1 && proxy.rewrites()[0].owner === 'pkg-b',
    JSON.stringify(proxy.rewrites()))
}

console.log('\n=== 未争用的路径原样通过 ===')
{
  const plan = rewritePlan([])
  const real = realRegistry()
  const proxy = createRouteProxy({ real, plan, ownerOf: () => 'pkg-a' })
  proxy.register({ kind: 'prefix', path: '/mine' })
  check('无冲突时路径不变', real.names()[0] === '/mine', JSON.stringify(real.names()))
  check('无改写记录', proxy.rewrites().length === 0)
  const r = resolveRoute(plan, 'pkg-a', '/mine')
  check('resolveRoute 对未计划路径返回原值', r.path === '/mine' && r.rewritten === false, JSON.stringify(r))
}

console.log('\n=== 只改写该包的该路径 ===')
{
  const decisions = [{
    remedy: 'isolate', kind: 'route', target: '/shared',
    actions: [{ owner: 'pkg-b', action: 'isolate', from: '/shared', to: '/pkg_b__shared' }],
  }]
  const plan = rewritePlan(decisions)
  check('计划只覆盖落败者', plan.has('pkg-b') && !plan.has('pkg-a'), JSON.stringify([...plan.keys()]))
  check('同一包的其它路径不受影响',
    resolveRoute(plan, 'pkg-b', '/other').rewritten === false)
  check('另一包的同名路径不受影响',
    resolveRoute(plan, 'pkg-a', '/shared').rewritten === false)
}

console.log('\n=== 归属来自调用方,不是挂载方 ===')
{
  const decisions = [{
    remedy: 'isolate', kind: 'route', target: '/p',
    actions: [{ owner: 'pkg-b', action: 'isolate', from: '/p', to: '/pkg_b__p' }],
  }]
  const real = realRegistry()
  let caller = 'pkg-a'
  const proxy = createRouteProxy({ real, plan: rewritePlan(decisions), ownerOf: () => caller })
  proxy.register({ kind: 'exact', path: '/p' })
  caller = 'pkg-b'
  proxy.register({ kind: 'exact', path: '/p' })
  check('同一个代理实例按调用方分别处理',
    real.names().includes('/p') && real.names().includes('/pkg_b__p'), JSON.stringify(real.names()))
}

console.log('\n=== 处置权仍属发起注册的 fiber ===')
{
  const real = realRegistry()
  const proxy = createRouteProxy({ real, plan: new Map(), ownerOf: () => 'pkg-a' })
  const dispose = proxy.register({ kind: 'exact', path: '/z' })
  check('代理返回真注册表的处置器', typeof dispose === 'function')
  dispose()
  check('处置后路径被释放', real.names().length === 0, JSON.stringify(real.names()))
}

console.log('\n=== upgrade 路由走同一张表 ===')
{
  const decisions = [{
    remedy: 'isolate', kind: 'route', target: '/ws',
    actions: [{ owner: 'pkg-b', action: 'isolate', from: '/ws', to: '/pkg_b__ws' }],
  }]
  const real = realRegistry()
  let caller = 'pkg-a'
  const proxy = createRouteProxy({ real, plan: rewritePlan(decisions), ownerOf: () => caller })
  proxy.registerUpgrade({ kind: 'exact', path: '/ws' })
  caller = 'pkg-b'
  let threw = false
  try { proxy.registerUpgrade({ kind: 'exact', path: '/ws' }) } catch { threw = true }
  check('WebSocket 升级路由同样被改写而不抛错', !threw && real.names().length === 2, JSON.stringify(real.names()))
}

console.log('\n=== 确定性 ===')
{
  const contributions = [
    { plane: 'host', kind: 'route', target: '/r', owner: 'z-pkg', source: null },
    { plane: 'host', kind: 'route', target: '/r', owner: 'a-pkg', source: null },
  ]
  const one = rewritePlan(arbitrate(contributions, {}).decisions)
  const two = rewritePlan(arbitrate([...contributions].reverse(), {}).decisions)
  const flat = m => JSON.stringify([...m].map(([k, v]) => [k, [...v]]).sort())
  check('输入顺序不影响改写计划', flat(one) === flat(two), `${flat(one)} vs ${flat(two)}`)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
