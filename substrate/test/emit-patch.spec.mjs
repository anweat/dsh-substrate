/**
 * L3 patch-emitter tests, at two levels:
 *
 *   shape    the emitted rows are the ones the dialect accepts
 *   effect   replaying them through a mirror of the harness's own
 *            `applyEntryPatches` produces the tree we claimed
 *
 * The second level is the one that matters: an emitter that produces
 * plausible-looking YAML which does not compose is worse than none.
 *
 * Run: node test/emit-patch.spec.mjs
 */
import { emitPatch, renderPatchYaml, SANDBOX_ID } from '../src/emit-patch.mjs'
import { arbitrate } from '../src/arbitrate.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/**
 * Mirror of `vendor/include/src/index.ts:applyEntryPatches`, kept to the parts
 * the emitter exercises. Tests assert against composed trees, not against text.
 */
function applyEntryPatches(data, patches) {
  data = structuredClone(data)
  const index = new Map()
  const build = (entries) => {
    for (const e of entries) {
      if (e?.id) index.set(e.id, e)
      if (e?.group && Array.isArray(e.config)) build(e.config)
    }
  }
  build(data)
  const warnings = []
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (id) {
        const target = index.get(id)
        if (!target) { warnings.push(`insert: ${id} not found`); continue }
        if (!target.group) { warnings.push(`insert: ${id} is not a group`); continue }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else data.push(...insert)
      build(insert)
      continue
    }
    if (!id) { warnings.push('patch: id required'); continue }
    const target = index.get(id)
    if (!target) { warnings.push(`patch: ${id} not found`); continue }
    if (name && name !== target.name) { warnings.push(`patch: name mismatch ${id}`); continue }
    for (const [k, v] of Object.entries(overrides)) if (k !== 'id') target[k] = v
  }
  return { data, warnings }
}

const flatten = (rows, out = []) => {
  for (const r of rows) {
    out.push(r)
    if (r.group && Array.isArray(r.config)) flatten(r.config, out)
  }
  return out
}
const find = (tree, id) => flatten(tree).find(r => r.id === id)

/** A composed tree with two packages both claiming the id `storage`. */
const composed = () => ([
  { id: 'agent', name: '@deepseek-ai/dsh-agent' },
  { id: 'storage', name: '@pkg-a/storage', config: { path: './a' }, owner: 'pkg-a' },
  { id: 'ui-only', name: '@pkg-b/ui', owner: 'pkg-b' },
])
const rowsOf = tree => new Map(flatten(tree).filter(r => r.id).map(r => [r.id, r]))

console.log('\n=== 形状:发出的补丁行合乎方言 ===')
{
  const decisions = [{
    kind: 'entry-id', target: 'storage', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-a', action: 'rename', from: 'storage', to: 'pkg_a__storage' }],
  }]
  const { patch, unresolved, summary } = emitPatch({ decisions, rows: rowsOf(composed()) })
  check('第一行建 sandbox 组', patch[0].insert?.[0]?.id === SANDBOX_ID, JSON.stringify(patch[0]))
  check('组带 isolate realm',
    patch[0].insert[0].isolate !== undefined && patch[0].insert[0].group === true,
    JSON.stringify(patch[0].insert[0]))
  check('原行被禁用', patch.some(p => p.id === 'storage' && p.disabled === true), JSON.stringify(patch))
  check('新行插进组里', patch.some(p => p.id === SANDBOX_ID && Array.isArray(p.insert)), JSON.stringify(patch))
  check('无未解析项', unresolved.length === 0, JSON.stringify(unresolved))
  check('摘要计数正确', summary.rehomed === 1 && summary.withheld === 0, JSON.stringify(summary))
}

console.log('\n=== 效果:重放后树形正确 ===')
{
  const decisions = [{
    kind: 'entry-id', target: 'storage', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-a', action: 'rename', from: 'storage', to: 'pkg_a__storage' }],
  }]
  const tree = composed()
  const { patch } = emitPatch({ decisions, rows: rowsOf(tree) })
  const { data, warnings } = applyEntryPatches(tree, patch)
  check('重放无告警', warnings.length === 0, JSON.stringify(warnings))
  check('原 id 的行已禁用', find(data, 'storage')?.disabled === true)
  check('新 id 的行存在于组内',
    find(data, SANDBOX_ID)?.config?.some(r => r.id === 'pkg_a__storage'), JSON.stringify(find(data, SANDBOX_ID)))
  check('重新插入保留了模块名与 config', (() => {
    const moved = find(data, SANDBOX_ID)?.config?.find(r => r.id === 'pkg_a__storage')
    return moved?.name === '@pkg-a/storage' && moved?.config?.path === './a'
  })())
  check('未涉及的行不受影响', find(data, 'agent')?.disabled === undefined)
}

console.log('\n=== 前端取舍:禁主机行即撤下前端半 ===')
{
  const decisions = [{
    kind: 'slot-single', target: 'details', contested: true, remedy: 'drop-client',
    actions: [{ owner: 'pkg-b', action: 'drop-client', target: 'details' }],
  }]
  const tree = composed()
  const { patch, summary } = emitPatch({ decisions, rows: rowsOf(tree) })
  const { data, warnings } = applyEntryPatches(tree, patch)
  check('拥有该槽位的包的主机行被禁', find(data, 'ui-only')?.disabled === true, JSON.stringify(patch))
  check('计入 withheld', summary.withheld === 1, JSON.stringify(summary))
  check('重放无告警', warnings.length === 0, JSON.stringify(warnings))
}

console.log('\n=== layer / isolate 不产生补丁行 ===')
{
  const decisions = [
    { kind: 'tool', target: 'bash', contested: true, remedy: 'layer',
      actions: [{ owner: 'pkg-a', action: 'layer', target: 'bash', rank: 1 }] },
    { kind: 'route', target: '/x', contested: true, remedy: 'isolate',
      actions: [{ owner: 'pkg-a', action: 'isolate', from: '/x', to: '/pkg_a__x' }] },
  ]
  const { patch, summary } = emitPatch({ decisions, rows: rowsOf(composed()) })
  check('只发出建组一行', patch.length === 1 && patch[0].insert?.[0]?.id === SANDBOX_ID, JSON.stringify(patch))
  check('没有 re-home 也没有 withhold', summary.rehomed === 0 && summary.withheld === 0, JSON.stringify(summary))
}

console.log('\n=== 缺失输入失败可见,不静默 ===')
{
  const decisions = [{
    kind: 'entry-id', target: 'ghost', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-x', action: 'rename', from: 'ghost', to: 'pkg_x__ghost' }],
  }]
  const { unresolved } = emitPatch({ decisions, rows: rowsOf(composed()) })
  check('指向组合树里没有的行 → 记为未解析',
    unresolved.some(u => u.why === 'row-not-in-composed-tree'), JSON.stringify(unresolved))
  const noOwner = emitPatch({
    decisions: [{ kind: 'slot-single', target: 'x', contested: true, remedy: 'drop-client',
      actions: [{ owner: 'nobody', action: 'drop-client', target: 'x' }] }],
    rows: rowsOf(composed()),
  })
  check('找不到属主的行 → 记为未解析',
    noOwner.unresolved.some(u => u.why === 'owner-has-no-row'), JSON.stringify(noOwner.unresolved))
}

console.log('\n=== 幂等 ===')
{
  const decisions = [{
    kind: 'entry-id', target: 'storage', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-a', action: 'rename', from: 'storage', to: 'pkg_a__storage' }],
  }]
  const rows = rowsOf(composed())
  const a = emitPatch({ decisions, rows })
  const b = emitPatch({ decisions, rows })
  check('同输入两次补丁完全相同', JSON.stringify(a.patch) === JSON.stringify(b.patch))
  // The contract is re-composition, not re-application: the layer stack runs
  // the whole patch list against the BASE tree on every compose and reload.
  const first = applyEntryPatches(composed(), a.patch)
  const second = applyEntryPatches(composed(), a.patch)
  check('对干净基线重复合成结果相同(热重载的实际路径)',
    JSON.stringify(first.data) === JSON.stringify(second.data))
  // And the failure mode the precondition warns about, asserted rather than
  // assumed: appending to an already-patched tree duplicates the group.
  const stacked = applyEntryPatches(first.data, a.patch)
  const groups = stacked.data.filter(r => r.id === SANDBOX_ID).length
  check('叠加到已打过补丁的树会重复建组(故契约要求整体重写)',
    groups === 2, `sandbox 组出现 ${groups} 次`)
}

console.log('\n=== YAML 渲染 ===')
{
  const decisions = [{
    kind: 'entry-id', target: 'storage', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-a', action: 'rename', from: 'storage', to: 'pkg_a__storage' }],
  }]
  const { patch } = emitPatch({ decisions, rows: rowsOf(composed()) })
  const yaml = renderPatchYaml(patch)
  check('渲染出组、禁用与插入三段',
    yaml.includes('cordis:group') && yaml.includes('disabled: true') && yaml.includes('pkg_a__storage'),
    yaml.slice(0, 160))
  check('isolate 以映射形式渲染', /isolate:\n\s+webServer: true/.test(yaml), yaml.slice(0, 200))
  let threw = false
  try { renderPatchYaml([{ id: 'x', weird: () => {} }]) } catch { threw = true }
  check('渲染不了的值失败可见而非静默', threw)
}

console.log('\n=== 与裁决层端到端 ===')
{
  const contributions = [
    { plane: 'host', kind: 'entry-id', target: 'storage', owner: 'pkg-a', source: null },
    { plane: 'host', kind: 'entry-id', target: 'storage', owner: 'pkg-b', source: null },
  ]
  const { decisions } = arbitrate(contributions, { order: ['pkg-b'] })
  const tree = [
    { id: 'storage', name: '@pkg-b/storage', owner: 'pkg-b' },
    { id: 'storage-a', name: '@pkg-a/storage', owner: 'pkg-a' },
  ]
  // The loser is pkg-a; its row here carries the contended id, so re-homing
  // needs the row the arbitration named, not the owner's other rows.
  const rows = new Map([['storage', { id: 'storage', name: '@pkg-a/storage', owner: 'pkg-a' }]])
  const { patch } = emitPatch({ decisions, rows })
  const { warnings } = applyEntryPatches(tree, patch)
  check('裁决 → 发出 → 重放 全链无告警', warnings.length === 0, JSON.stringify(warnings))
  check('胜者是声明顺序靠前的 pkg-b', decisions[0].winner === 'pkg-b', decisions[0].winner)
}

console.log('\n=== 两行同 id 时,改名不是补丁层能做的事 ===')
{
  // Prompted by a real report and settled in `lab-duplicate-entry-id.ts`:
  // disabling a row does not remove it from the loader's id check, and a patch
  // cannot rewrite an id. An emitter that emitted the re-home anyway would
  // produce a patch that still fails to boot, which is worse than refusing.
  const decisions = [{
    kind: 'entry-id', target: 'browser', contested: true, remedy: 'rename',
    actions: [{ owner: 'pkg-a', action: 'rename', from: 'browser', to: 'pkg_a__browser' }],
  }]
  const rows = new Map([['browser', { id: 'browser', name: './b.mjs', owner: 'pkg-a' }]])

  const emitted = emitPatch({ decisions, rows, duplicateIds: new Set(['browser']) })
  check('拒绝发射', emitted.summary.rehomed === 0, JSON.stringify(emitted.summary))
  check('并说明原因', emitted.unresolved.some(u => u.why === 'id-claimed-by-several-rows'),
    JSON.stringify(emitted.unresolved))
  check('给出可行的方向', emitted.unresolved.some(u => typeof u.fix === 'string' && u.fix !== ''),
    JSON.stringify(emitted.unresolved))
  check('没有为它插行',
    !JSON.stringify(emitted.patch).includes('pkg_a__browser'), JSON.stringify(emitted.patch))

  // The single-claimant case is unaffected: that is what re-homing is for.
  const single = emitPatch({ decisions, rows })
  check('单行认领时照常改名', single.summary.rehomed === 1, JSON.stringify(single.summary))
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
