/**
 * L2 unit tests. No harness, no filesystem, no corpus — arbitration is a pure
 * function and these pin its contract.
 *
 * Run: node test/arbitrate.spec.mjs
 */
import { arbitrate } from '../src/arbitrate.mjs'
import { contributionsOf, byCell } from '../src/model.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const c = (kind, target, owner, extra = {}) =>
  ({ plane: kind.startsWith('slot') ? 'client' : 'host', kind, target, owner, source: null, ...extra })

console.log('\n=== 每种 remedy 的触发与形状 ===')
{
  const r = arbitrate([c('tool', 'bash', 'pkg-a'), c('tool', 'bash', 'pkg-b')], { order: ['pkg-a', 'pkg-b'] })
  const d = r.decisions[0]
  check('工具名争用触发 layer', d.remedy === 'layer', d?.remedy)
  check('声明顺序靠前者获胜', d.winner === 'pkg-a', d?.winner)
  check('落败者被分层而非改名',
    d.actions.length === 1 && d.actions[0].action === 'layer' && d.actions[0].target === 'bash',
    JSON.stringify(d.actions))
}
{
  const r = arbitrate([c('entry-id', 'storage', 'pkg-a'), c('entry-id', 'storage', 'pkg-b')], { order: ['pkg-a'] })
  const a = r.decisions[0].actions[0]
  check('entry id 争用触发 rename', a.action === 'rename', a.action)
  check('改名带包名前缀且是合法标识符', a.to === 'pkg_a__storage' || a.to === 'pkg_b__storage', a.to)
}
{
  const r = arbitrate([c('route', '/api/x', 'pkg-a'), c('route', '/api/x', 'pkg-b')], { order: ['pkg-a'] })
  const a = r.decisions[0].actions[0]
  check('路由争用触发 isolate', a.action === 'isolate', a.action)
  check('隔离后的路径仍以 / 开头', a.to.startsWith('/'), a.to)
}
{
  const r = arbitrate([c('slot-single', 'details', 'pkg-a'), c('slot-single', 'details', 'pkg-b')], { order: ['pkg-a'] })
  check('single 槽争用只能丢弃前端半', r.decisions[0].actions[0].action === 'drop-client')
}
{
  const r = arbitrate([c('config-row', 'system-prompt', 'pkg-a'), c('config-row', 'system-prompt', 'pkg-b')])
  check('配置行争用仅报告', r.decisions[0].remedy === 'report-only')
}

console.log('\n=== 加法型不算冲突 ===')
{
  const r = arbitrate([c('slot-list', 'shell.overlay', 'a'), c('slot-list', 'shell.overlay', 'b')])
  check('list 槽记录但不判争用', r.decisions[0].contested === false && r.totals.contested === 0,
    JSON.stringify(r.totals))
  const e = arbitrate([c('event', 'agent/pre-step', 'a'), c('event', 'agent/pre-step', 'b')])
  check('事件监听不判争用', e.totals.contested === 0)
}

console.log('\n=== keyed 槽按 key 分格 ===')
{
  const same = arbitrate([
    c('slot-keyed', 'tool.call.toolview', 'a', { entryKey: 'bash' }),
    c('slot-keyed', 'tool.call.toolview', 'b', { entryKey: 'bash' }),
  ])
  const diff = arbitrate([
    c('slot-keyed', 'tool.call.toolview', 'a', { entryKey: 'bash' }),
    c('slot-keyed', 'tool.call.toolview', 'b', { entryKey: 'grep' }),
  ])
  check('同 key 判争用', same.totals.contested === 1, JSON.stringify(same.totals))
  check('不同 key 不判争用', diff.totals.contested === 0, JSON.stringify(diff.totals))
}

console.log('\n=== 同一包多次认领不是争用 ===')
{
  const r = arbitrate([c('tool', 'x', 'pkg-a'), c('tool', 'x', 'pkg-a')])
  check('一个包认领两次 = 组合,不是冲突', r.totals.contested === 0, JSON.stringify(r.totals))
}

console.log('\n=== 保留名:没有任何补救 ===')
{
  const r = arbitrate([c('tool', 'run_code', 'pkg-a')])
  const d = r.decisions[0]
  check('单个包认领保留名即判冲突', d?.contested === true && d?.reserved === true, JSON.stringify(d))
  check('补救是 drop,不是 layer', d?.remedy === 'drop', d?.remedy)
  check('赢家是 <reserved>,谁都拿不到', d?.winner === '<reserved>', d?.winner)
  check('动作注明了原因', d?.actions[0].why === 'reserved-name', JSON.stringify(d?.actions))
  check('该包被记为 degraded',
    r.outcomes.find(o => o.owner === 'pkg-a')?.status === 'degraded', JSON.stringify(r.outcomes))
  const two = arbitrate([c('tool', 'run_code', 'a'), c('tool', 'run_code', 'b')])
  check('多个认领者全部被 drop', two.decisions[0].actions.length === 2, JSON.stringify(two.decisions[0].actions))
  const custom = arbitrate([c('tool', 'mine', 'a')], { reservedToolNames: ['mine'] })
  check('保留名清单可由策略覆盖', custom.decisions[0]?.remedy === 'drop', JSON.stringify(custom.decisions))
}

console.log('\n=== 撞官方 ===')
{
  const r = arbitrate([c('tool', 'bash', 'pkg-a')], { shippedTools: new Set(['bash']) })
  const d = r.decisions[0]
  check('单个第三方撞官方工具即判争用', d?.contested === true)
  check('官方永远胜出', d?.winner === '<shipped>', d?.winner)
  check('第三方被分层而非丢弃', d?.actions[0].action === 'layer')
}

console.log('\n=== 幂等与确定性(热重载要求)===')
{
  const input = [
    c('tool', 'bash', 'z-pkg'), c('tool', 'bash', 'a-pkg'),
    c('entry-id', 'storage', 'm-pkg'), c('entry-id', 'storage', 'a-pkg'),
  ]
  const one = arbitrate(input, {})
  const two = arbitrate(input, {})
  const shuffled = arbitrate([...input].reverse(), {})
  check('同输入两次结果完全相同', JSON.stringify(one.decisions) === JSON.stringify(two.decisions))
  check('输入顺序不影响赢家',
    JSON.stringify(one.decisions.map(d => [d.cell, d.winner]).sort())
    === JSON.stringify(shuffled.decisions.map(d => [d.cell, d.winner]).sort()))
  check('未声明的包按字典序,结果可预期',
    one.decisions.find(d => d.target === 'bash')?.winner === 'a-pkg',
    one.decisions.find(d => d.target === 'bash')?.winner)
}

console.log('\n=== 每包结局 ===')
{
  const r = arbitrate([
    c('tool', 'bash', 'winner'), c('tool', 'bash', 'loser'),
    c('slot-single', 'details', 'dropped-a'), c('slot-single', 'details', 'dropped-b'),
    c('tool', 'unique', 'untouched'),
  ], { order: ['winner', 'loser', 'dropped-a', 'dropped-b'] })
  const status = Object.fromEntries(r.outcomes.map(o => [o.owner, o.status]))
  check('无争用的包保持 intact', status.untouched === 'intact', JSON.stringify(status))
  check('胜者保持 intact', status.winner === 'intact', JSON.stringify(status))
  check('被分层者记为 adapted', status.loser === 'adapted', JSON.stringify(status))
  check('丢前端半者记为 degraded', status['dropped-b'] === 'degraded', JSON.stringify(status))
}

console.log('\n=== 边界 ===')
{
  check('空输入不抛错', arbitrate([]).totals.contested === 0)
  check('单个贡献不判争用', arbitrate([c('tool', 'x', 'a')]).totals.contested === 0)
  const many = Array.from({ length: 100 }, (_, i) => c('tool', 'hot', `pkg-${String(i).padStart(3, '0')}`))
  const r = arbitrate(many, {})
  check('100 方争同一目标:一个赢家 99 个动作',
    r.decisions[0].actions.length === 99 && r.decisions[0].winner === 'pkg-000',
    `${r.decisions[0].actions.length} actions, winner ${r.decisions[0].winner}`)
  check('策略里的未知包名被忽略而非抛错',
    arbitrate([c('tool', 'x', 'a')], { order: ['not-present'] }).totals.contested === 0)
}

console.log('\n=== L1 归一化 ===')
{
  const rec = {
    pkgName: 'p', status: 'ok',
    contributions: [
      { verb: 'tool-register', target: 'a', source: 's:1' },
      { verb: 'tool-register', target: null, source: 's:2' },
      { verb: 'slot-register', target: 'shell.overlay', source: 's:3' },
      { verb: 'slot-register', target: 'unknown.slot', source: 's:4' },
      { verb: 'slot-inject', target: 'shell.overlay', source: 's:5' },
    ],
    patchJournal: [
      { action: 'insert', target: 'row-1', layer: 'p.yml' },
      { action: 'override', target: 'row-2', layer: 'p.yml', droppedConfigKeys: ['k'] },
    ],
  }
  const { contributions, dropped } = contributionsOf(rec, new Map([['shell.overlay', 'list']]))
  check('非字面量目标被丢弃并记录原因',
    dropped.some(d => d.why === 'target-not-literal'), JSON.stringify(dropped))
  check('基线里没有的槽位被丢弃而非当成冲突',
    dropped.some(d => d.why === 'slot-not-in-baseline'), JSON.stringify(dropped))
  check('slot-inject 不算贡献', !contributions.some(x => x.source === 's:5'))
  check('槽位基数来自基线', contributions.find(x => x.target === 'shell.overlay')?.kind === 'slot-list')
  check('补丁日志产出 entry-id 与 config-row',
    contributions.some(x => x.kind === 'entry-id') && contributions.some(x => x.kind === 'config-row'))
  check('byCell 对 keyed 与非 keyed 分格正确',
    byCell(contributions).size === contributions.length)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
