/**
 * Preset-emitter tests.
 *
 * The load-bearing assertion is the exclusion rule: one preset is one standing
 * scope, so two plugins contending for a name cannot share it. An emitter that
 * admitted them would produce a preset that fails to mount.
 *
 * Run: node test/emit-preset.spec.mjs
 */
import { emitPreset, partitionForPreset, renderPresetYaml, renderPresetMetaYaml } from '../src/emit-preset.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const contrib = (kind, target, owner) => ({ plane: 'host', kind, target, owner, source: null })
const plugin = (owner, module, contributions, extra = {}) => ({ owner, module, contributions, ...extra })

console.log('\n=== 不争用的插件可共享一个预设 ===')
{
  const r = emitPreset({ plugins: [
    plugin('a', '@a/p', [contrib('tool', 'alpha', 'a')]),
    plugin('b', '@b/p', [contrib('tool', 'beta', 'b')]),
  ] })
  check('两个都被接纳', r.summary.admitted === 2 && r.summary.excluded === 0, JSON.stringify(r.summary))
  check('产出两行', r.rows.length === 2, JSON.stringify(r.rows))
  check('行带模块名', r.rows.every(x => typeof x.name === 'string'), JSON.stringify(r.rows))
}

console.log('\n=== 争用的插件不能共享一个预设(核心约束)===')
{
  const r = emitPreset({ plugins: [
    plugin('a', '@a/p', [contrib('tool', 'bash', 'a')]),
    plugin('b', '@b/p', [contrib('tool', 'bash', 'b')]),
  ] })
  check('只接纳一个', r.summary.admitted === 1, JSON.stringify(r.summary))
  check('另一个被排除且指出原因',
    r.excluded.length === 1 && r.excluded[0].conflicts[0].takenBy === 'a',
    JSON.stringify(r.excluded))
  check('被排除者不出现在组合里',
    !r.rows.some(x => x.name === '@b/p'), JSON.stringify(r.rows))
}

console.log('\n=== 加法型贡献不构成排除 ===')
{
  const r = emitPreset({ plugins: [
    plugin('a', '@a/p', [contrib('slot-list', 'shell.overlay', 'a'), contrib('event', 'agent/pre-step', 'a')]),
    plugin('b', '@b/p', [contrib('slot-list', 'shell.overlay', 'b'), contrib('event', 'agent/pre-step', 'b')]),
  ] })
  check('共用 list 槽与事件的两个插件都被接纳',
    r.summary.admitted === 2 && r.summary.excluded === 0, JSON.stringify(r.summary))
}

console.log('\n=== 同一个包重复认领自己的格不算争用 ===')
{
  const r = emitPreset({ plugins: [
    plugin('a', '@a/p', [contrib('tool', 'x', 'a'), contrib('tool', 'x', 'a')]),
  ] })
  check('自我重复不导致排除', r.summary.admitted === 1 && r.summary.excluded === 0, JSON.stringify(r.summary))
}

console.log('\n=== 提供服务的行必须包在带 isolate 的组里 ===')
{
  const r = emitPreset({ plugins: [
    plugin('svc', '@svc/p', [contrib('service', 'myRegistry', 'svc'), contrib('tool', 't', 'svc')]),
  ] })
  const group = r.rows[0]
  check('产出的是 cordis:group', group.name === 'cordis:group' && group.group === true, JSON.stringify(group))
  check('组声明了 entry-local realm',
    group.isolate?.myRegistry === true, JSON.stringify(group.isolate))
  check('真正的插件行嵌在组的 config 里',
    Array.isArray(group.config) && group.config[0].name === '@svc/p', JSON.stringify(group.config))
  check('计入 realms', r.summary.realms === 1, JSON.stringify(r.summary))
}

console.log('\n=== 不提供服务的行不套组 ===')
{
  const r = emitPreset({ plugins: [plugin('t', '@t/p', [contrib('tool', 'only', 't')])] })
  check('普通行直接落在顶层', r.rows[0].name === '@t/p' && r.rows[0].group === undefined, JSON.stringify(r.rows))
}

console.log('\n=== 接纳顺序即调用方给的优先顺序 ===')
{
  const first = emitPreset({ plugins: [
    plugin('low', '@low/p', [contrib('tool', 'c', 'low')]),
    plugin('high', '@high/p', [contrib('tool', 'c', 'high')]),
  ] })
  const second = emitPreset({ plugins: [
    plugin('high', '@high/p', [contrib('tool', 'c', 'high')]),
    plugin('low', '@low/p', [contrib('tool', 'c', 'low')]),
  ] })
  check('先给的先占位', first.rows[0].name === '@low/p' && second.rows[0].name === '@high/p',
    `${first.rows[0].name} / ${second.rows[0].name}`)
  check('调用方顺序决定谁进预设(由裁决层排好后传入)',
    first.excluded[0].owner === 'high' && second.excluded[0].owner === 'low')
}

console.log('\n=== 确定性 ===')
{
  const plugins = [
    plugin('a', '@a/p', [contrib('tool', 'x', 'a')]),
    plugin('b', '@b/p', [contrib('tool', 'x', 'b')]),
    plugin('c', '@c/p', [contrib('tool', 'y', 'c')]),
  ]
  const one = emitPreset({ plugins })
  const two = emitPreset({ plugins })
  check('同输入两次结果完全相同', JSON.stringify(one) === JSON.stringify(two))
}

console.log('\n=== YAML 渲染 ===')
{
  const r = emitPreset({ plugins: [
    plugin('svc', '@svc/p', [contrib('service', 'reg', 'svc')], { config: { limit: 5 } }),
    plugin('t', '@t/p', [contrib('tool', 'only', 't')]),
  ], meta: { name: '底座编排', order: 9 } })
  const yaml = renderPresetYaml(r.rows)
  check('渲染出组与 isolate', yaml.includes('cordis:group') && /isolate:\n\s+reg: true/.test(yaml), yaml)
  check('嵌套的插件行有缩进',
    /config:\n\s{4,}- id:/.test(yaml), yaml)
  check('config 标量被渲染', yaml.includes('limit: 5'), yaml)
  const metaYaml = renderPresetMetaYaml(r.meta)
  check('preset.yml 带 name/description/order',
    metaYaml.includes('name:') && metaYaml.includes('description:') && metaYaml.includes('order: 9'), metaYaml)
  let threw = false
  try { renderPresetYaml([{ id: 'x', bad: () => {} }]) } catch { threw = true }
  check('渲染不了的值失败可见', threw)
}

console.log('\n=== 边界 ===')
{
  check('空输入产出空组合', emitPreset({ plugins: [] }).rows.length === 0)
  const noContrib = emitPreset({ plugins: [plugin('a', '@a/p', [])] })
  check('无贡献的插件仍被编排(它可能只做副作用)', noContrib.summary.admitted === 1)
  const p = partitionForPreset([
    plugin('a', '@a/p', [contrib('entry-id', 'storage', 'a')]),
    plugin('b', '@b/p', [contrib('entry-id', 'storage', 'b')]),
  ])
  check('entry-id 争用同样触发排除', p.excluded.length === 1, JSON.stringify(p.excluded))
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
