/**
 * Scope-chain planner tests.
 *
 * The interesting cases are the ones a linear chain cannot express — a planner
 * that always returns an order is useless if it silently drops constraints.
 *
 * Run: node test/scope-chain.spec.mjs
 */
import { planScopeChain, bindingsFor } from '../src/scope-chain.mjs'
import { arbitrate } from '../src/arbitrate.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** A layer decision: `winner` shadows every loser on `cell`. */
const layered = (cell, winner, losers) => ({
  cell, kind: 'tool', target: cell, contested: true, remedy: 'layer', winner,
  actions: losers.map(owner => ({ owner, action: 'layer', target: cell })),
})

console.log('\n=== 基本排序 ===')
{
  const r = planScopeChain([layered('bash', 'a', ['b'])])
  check('赢家排在链上更近的位置', r.chain.indexOf('a') < r.chain.indexOf('b'), JSON.stringify(r.chain))
  check('全部约束被满足', r.satisfied === r.constraints && r.violated.length === 0, JSON.stringify(r))
}

console.log('\n=== 多个不冲突的约束可共存于一条线 ===')
{
  const r = planScopeChain([layered('bash', 'a', ['b']), layered('grep', 'b', ['c'])])
  check('传递顺序正确 a < b < c',
    r.chain.indexOf('a') < r.chain.indexOf('b') && r.chain.indexOf('b') < r.chain.indexOf('c'),
    JSON.stringify(r.chain))
  check('无违反', r.violated.length === 0)
}

console.log('\n=== 环:线性链无法同时满足 ===')
{
  // a 该赢 bash,b 该赢 grep —— 一条线放不下。
  const r = planScopeChain([layered('bash', 'a', ['b']), layered('grep', 'b', ['a'])])
  check('检出无法满足的约束', r.unsatisfiable.length > 0, JSON.stringify(r.unsatisfiable))
  check('两个包都仍在链上(不能凭空消失)',
    r.chain.includes('a') && r.chain.includes('b'), JSON.stringify(r.chain))
  check('如实报告被牺牲的约束数',
    r.violated.length === 1 && r.satisfied === 1, `satisfied=${r.satisfied} violated=${r.violated.length}`)
  check('环上的包被点名', r.cyclicOwners.length === 2, JSON.stringify(r.cyclicOwners))
}

console.log('\n=== 撞官方不进链 ===')
{
  const d = {
    cell: 'bash', kind: 'tool', target: 'bash', contested: true, remedy: 'layer',
    winner: '<shipped>', actions: [{ owner: 'a', action: 'layer', target: 'bash' }],
  }
  const r = planScopeChain([d])
  check('第三方仍需一个 scope 位置', r.chain.includes('a'), JSON.stringify(r.chain))
  check('不为 <shipped> 造节点', !r.chain.includes('<shipped>'), JSON.stringify(r.chain))
  check('无约束即无违反', r.constraints === 0 && r.violated.length === 0)
}

console.log('\n=== 确定性与声明顺序 ===')
{
  const decisions = [layered('t1', 'm', ['z']), layered('t2', 'a', ['y'])]
  const one = planScopeChain(decisions, { order: ['a', 'm'] })
  const two = planScopeChain([...decisions].reverse(), { order: ['a', 'm'] })
  check('输入顺序不影响结果链', JSON.stringify(one.chain) === JSON.stringify(two.chain),
    `${JSON.stringify(one.chain)} vs ${JSON.stringify(two.chain)}`)
  check('无约束关系时按声明顺序打破平局',
    one.chain.indexOf('a') < one.chain.indexOf('m'), JSON.stringify(one.chain))
  const undeclared = planScopeChain([layered('t', 'zzz', ['aaa'])], {})
  check('未声明的包仍按约束排,不被字典序覆盖',
    undeclared.chain.indexOf('zzz') < undeclared.chain.indexOf('aaa'), JSON.stringify(undeclared.chain))
}

console.log('\n=== 绑定顺序 ===')
{
  const bindings = bindingsFor(['near', 'mid', 'far'])
  check('从最远端开始绑,父先于子存在',
    bindings[0].owner === 'mid' && bindings[0].parent === 'far', JSON.stringify(bindings))
  check('每个非最远节点各一条绑定', bindings.length === 2, JSON.stringify(bindings))
  check('最近端的父是它的下一跳',
    bindings.some(b => b.owner === 'near' && b.parent === 'mid'), JSON.stringify(bindings))
  check('单节点链无需绑定', bindingsFor(['only']).length === 0)
  check('空链无需绑定', bindingsFor([]).length === 0)
}

console.log('\n=== 与裁决层端到端 ===')
{
  const contributions = [
    { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-a', source: null },
    { plane: 'host', kind: 'tool', target: 'bash', owner: 'pkg-b', source: null },
    { plane: 'host', kind: 'tool', target: 'grep', owner: 'pkg-b', source: null },
    { plane: 'host', kind: 'tool', target: 'grep', owner: 'pkg-c', source: null },
  ]
  const { decisions } = arbitrate(contributions, { order: ['pkg-a', 'pkg-b', 'pkg-c'] })
  const r = planScopeChain(decisions, { order: ['pkg-a', 'pkg-b', 'pkg-c'] })
  check('裁决 → 排链 全部约束可满足', r.violated.length === 0, JSON.stringify(r))
  check('链序与声明顺序一致',
    JSON.stringify(r.chain) === JSON.stringify(['pkg-a', 'pkg-b', 'pkg-c']), JSON.stringify(r.chain))
}

console.log('\n=== 边界 ===')
{
  check('空决策产出空链', planScopeChain([]).chain.length === 0)
  check('非 layer 决策不影响链',
    planScopeChain([{ remedy: 'rename', actions: [{ owner: 'x', action: 'rename' }] }]).chain.length === 0)
  const many = Array.from({ length: 50 }, (_, i) => layered(`t${i}`, `p${String(i).padStart(2, '0')}`, [`p${String(i + 1).padStart(2, '0')}`]))
  const r = planScopeChain(many)
  check('50 级传递链完整且无违反',
    r.chain.length === 51 && r.violated.length === 0, `${r.chain.length} nodes, ${r.violated.length} violated`)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
