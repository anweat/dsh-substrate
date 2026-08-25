/**
 * Prediction tests: the entry list is all a gatekeeper gets, so these pin what
 * it can and cannot conclude from it.
 *
 * The assertion that matters most is the negative one — a package the catalog
 * does not describe must be reported as unknown, never treated as harmless. A
 * clean report over a half-described composition is worse than no report.
 *
 * Run: node test/predict.spec.mjs
 */
import { predict, contributionsFromEntries, renderReport } from '../src/predict.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const entry = (id, name, extra = {}) => ({ id, name, ...extra })

console.log('\n=== 从 entry list 预测工具名冲突 ===')
{
  const catalog = new Map([
    ['@a/p', { tools: ['bash'] }],
    ['@b/p', { tools: ['bash', 'grep'] }],
  ])
  const r = predict([entry('a', '@a/p'), entry('b', '@b/p')], { catalog, policy: { order: ['@a/p'] } })
  check('预测出一处致命冲突', r.fatal.length === 1, JSON.stringify(r.fatal.map(f => f.target)))
  check('冲突的是 bash', r.fatal[0].target === 'bash', r.fatal[0].target)
  check('两个认领者都被点名', r.fatal[0].contenders.length === 2, JSON.stringify(r.fatal[0].contenders))
  check('未争用的 grep 不被报告', !r.fatal.some(f => f.target === 'grep'))
}

console.log('\n=== 只有会抛错的类型算致命 ===')
{
  const catalog = new Map([
    ['@a/p', { slots: [{ key: 'details', kind: 'single' }] }],
    ['@b/p', { slots: [{ key: 'details', kind: 'single' }] }],
  ])
  const r = predict([entry('a', '@a/p'), entry('b', '@b/p')], { catalog })
  check('single 槽争用不算致命(它降级而非中止)', r.fatal.length === 0, JSON.stringify(r.fatal))
  check('但确实被裁决为冲突', r.totals.contested >= 1, JSON.stringify(r.totals))
  check('落败者被标为 degraded',
    r.outcomes.some(o => o.status === 'degraded'), JSON.stringify(r.outcomes.map(o => [o.owner, o.status])))
}

console.log('\n=== 目录中没有的包必须如实报告为未知 ===')
{
  const catalog = new Map([['@known/p', { tools: ['x'] }]])
  const r = predict([entry('k', '@known/p'), entry('u', '@unknown/p')], { catalog })
  check('未知包被记录', r.coverage.unknown.length === 1, JSON.stringify(r.coverage.unknown))
  check('覆盖率如实反映', r.coverage.described === 1 && r.coverage.entries === 2, JSON.stringify(r.coverage))
  const lines = renderReport(r)
  check('报告里明说有无法预测的包',
    lines.some(l => l.includes('无法预测')), JSON.stringify(lines))
}

console.log('\n=== 归属是行,不是模块 ===')
{
  // 同一个模块挂两次是真实用法(shipped standard 预设对 dsh-tool-subagent 就这么做),
  // 这两个实例会互相争用;按模块名归属会把真冲突判成无冲突。
  const catalog = new Map([['@same/p', { tools: ['bash'] }]])
  const r = predict([entry('inst-a', '@same/p'), entry('inst-b', '@same/p')], { catalog })
  check('同模块的两个实例被视为两个认领者', r.fatal.length === 1, JSON.stringify(r.fatal))
  check('认领者用行 id 标识',
    JSON.stringify(r.fatal[0].contenders.slice().sort()) === JSON.stringify(['inst-a', 'inst-b']),
    JSON.stringify(r.fatal[0].contenders))
}

console.log('\n=== 活体 entry 不产生 entry-id 争用 ===')
{
  // loader 里 id 本就唯一;entry-id 撞名是补丁合成期的事,由 contributionsOf 覆盖。
  const r = predict([entry('a', '@x/p'), entry('b', '@y/p')], { catalog: new Map() })
  check('无目录时不凭空造出冲突', r.totals.contested === 0, JSON.stringify(r.totals))
}

console.log('\n=== 已禁用的行不参与预测 ===')
{
  const catalog = new Map([['@a/p', { tools: ['bash'] }], ['@b/p', { tools: ['bash'] }]])
  const r = predict([entry('a', '@a/p'), entry('b', '@b/p', { disabled: true })], { catalog })
  check('禁用行被跳过,不产生假冲突', r.fatal.length === 0, JSON.stringify(r.fatal))
  check('覆盖率把禁用行计入总数', r.coverage.entries === 2, JSON.stringify(r.coverage))
}

console.log('\n=== 撞官方工具 ===')
{
  const catalog = new Map([['@a/p', { tools: ['bash'] }]])
  const r = predict([entry('a', '@a/p')], { catalog, shippedTools: new Set(['bash']) })
  check('单个插件撞官方即判致命', r.fatal.length === 1, JSON.stringify(r.fatal))
  check('赢家是官方', r.fatal[0].winner === '<shipped>', r.fatal[0].winner)
}

console.log('\n=== 路由与服务同样致命 ===')
{
  const catalog = new Map([
    ['@a/p', { routes: ['/x'], services: ['reg'] }],
    ['@b/p', { routes: ['/x'], services: ['reg'] }],
  ])
  const r = predict([entry('a', '@a/p'), entry('b', '@b/p')], { catalog })
  const kinds = r.fatal.map(f => f.kind).sort()
  check('路由与服务争用都进致命集', JSON.stringify(kinds) === JSON.stringify(['route', 'service']), JSON.stringify(kinds))
}

console.log('\n=== 干净组合报告为空 ===')
{
  const catalog = new Map([['@a/p', { tools: ['alpha'] }], ['@b/p', { tools: ['beta'] }]])
  const r = predict([entry('a', '@a/p'), entry('b', '@b/p')], { catalog })
  check('无冲突时致命集为空', r.fatal.length === 0)
  check('无冲突时报告无告警行', renderReport(r).length === 0, JSON.stringify(renderReport(r)))
  check('全部插件 intact', r.outcomes.every(o => o.status === 'intact'), JSON.stringify(r.outcomes))
}

console.log('\n=== 归一化 ===')
{
  const catalog = new Map([['@a/p', { tools: ['t'], routes: ['/r'], services: ['s'], slots: [{ key: 'k', kind: 'keyed', entryKey: 'e' }] }]])
  const { contributions } = contributionsFromEntries([entry('a', '@a/p')], catalog)
  const kinds = contributions.map(c => c.kind).sort()
  check('四类贡献全部产出',
    JSON.stringify(kinds) === JSON.stringify(['route', 'service', 'slot-keyed', 'tool']),
    JSON.stringify(kinds))
  check('keyed 槽带上了 entryKey',
    contributions.find(c => c.kind === 'slot-keyed')?.entryKey === 'e')
  check('归属是 entry id,模块名另存',
    contributions.every(c => c.owner === 'a' && c.module === '@a/p'),
    JSON.stringify(contributions.map(c => [c.owner, c.module])))
}

console.log('\n=== 边界 ===')
{
  check('空组合不抛错', predict([]).fatal.length === 0)
  check('全部未知时不产生任何裁决',
    predict([entry('x', '@a/p'), entry('y', '@b/p')]).totals.contested === 0)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
