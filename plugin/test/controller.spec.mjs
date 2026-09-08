/**
 * Card form-state tests.
 *
 * The card's whole reason to carry a form is that the settings namespace is
 * what makes it render at all: the plugin-settings tab publishes the
 * intersection of the namespaces the Host serves and the cards registered into
 * `settings.plugin.item`, so a card whose key no served namespace matches is
 * dropped with no error and no log line. That made the namespace real, and a
 * real namespace has to round-trip: staged text reaches the document, a clear
 * gives the composition layer back, and a write that does not land says so
 * instead of showing a saved card over unsaved state.
 *
 * Runs against `lib/client/controller.js`, so `npm run build` has to have run;
 * a stale build is a stale verdict.
 *
 * Run: node plugin/test/controller.spec.mjs
 */
import { SubstrateCardController } from '../lib/client/controller.js'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/**
 * A settings scope backed by a plain object, recording every write.
 * @param {object} [initial] Starting view; `status` defaults to ready.
 * @returns {object} the scope plus the writes it received.
 */
function fakeScope(initial = {}) {
  const view = {
    status: 'ready',
    value: { settleMs: 250 },
    base: {},
    user: undefined,
    writable: true,
    ...initial,
  }
  const listeners = new Set()
  const writes = []
  return {
    writes,
    view,
    /** Replace the view and notify, as a Host commit would. */
    push(next) { Object.assign(view, next); for (const l of listeners) l() },
    getSnapshot: () => view,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async set(field, value) {
      writes.push({ kind: 'set', field, value })
      view.user = { ...view.user, [field]: value }
      view.value = { ...view.value, [field]: value }
    },
    async unset(field) {
      writes.push({ kind: 'unset', field })
      const next = { ...view.user }
      delete next[field]
      view.user = Object.keys(next).length === 0 ? undefined : next
      view.value = { ...view.value, settleMs: 250 }
    },
  }
}

console.log('\n=== 未被服务的命名空间:卡片什么也不画 ===')
{
  const controller = new SubstrateCardController(fakeScope({ status: 'loading' }))
  const face = controller.inject()
  check('available 为假', face.hooks.substrateCard.getSnapshot().available === false)
  controller.dispose()
}

console.log('\n=== 干净状态 ===')
{
  const controller = new SubstrateCardController(fakeScope())
  const state = controller.inject().hooks.substrateCard.getSnapshot()
  check('显示存储值', state.settleMs.text === '250', state.settleMs.text)
  check('没有未保存改动', !state.dirty)
  check('没有覆盖层', !state.settleMs.overridden)
  check('保存按钮的状态来源为空', !state.dirty && !state.invalid)
  controller.dispose()
}

console.log('\n=== 编辑 → 保存,值要落到文档 ===')
{
  const scope = fakeScope()
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  face.edit('800')
  check('变脏', face.hooks.substrateCard.getSnapshot().dirty)
  check('显示的是刚输入的', face.hooks.substrateCard.getSnapshot().settleMs.text === '800')
  face.save()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  const state = face.hooks.substrateCard.getSnapshot()
  check('写了一次 set', scope.writes.length === 1 && scope.writes[0].kind === 'set', JSON.stringify(scope.writes))
  check('写进去的是数字而不是文本', scope.writes[0].value === 800, typeof scope.writes[0].value)
  check('保存后不再脏', !state.dirty)
  check('保存后标记为已覆盖', state.settleMs.overridden)
  check('没有报失败', !state.failed)
  controller.dispose()
}

console.log('\n=== 填不合法的值:保存被拦住,而不是写脏数据 ===')
{
  const scope = fakeScope()
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  face.edit('abc')
  check('标记为不合法', face.hooks.substrateCard.getSnapshot().invalid)
  face.save()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  check('一次都没有写', scope.writes.length === 0, JSON.stringify(scope.writes))
  check('改动还在,没有被吞掉', face.hooks.substrateCard.getSnapshot().settleMs.text === 'abc')
  controller.dispose()
}

console.log('\n=== 负数与小数同样不合法 ===')
{
  const controller = new SubstrateCardController(fakeScope())
  const face = controller.inject()
  face.edit('-1')
  check('负数不合法', face.hooks.substrateCard.getSnapshot().invalid)
  face.edit('2.5')
  check('小数不合法', face.hooks.substrateCard.getSnapshot().invalid)
  face.edit('0')
  check('零是合法的', !face.hooks.substrateCard.getSnapshot().invalid)
  controller.dispose()
}

console.log('\n=== 恢复默认:清掉用户层,重新继承 ===')
{
  const scope = fakeScope({ user: { settleMs: 800 }, value: { settleMs: 800 }, base: { settleMs: 250 } })
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  check('先是已覆盖', face.hooks.substrateCard.getSnapshot().settleMs.overridden)
  face.reset()
  face.save()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  check('发的是 unset 而不是 set', scope.writes.length === 1 && scope.writes[0].kind === 'unset', JSON.stringify(scope.writes))
  const state = face.hooks.substrateCard.getSnapshot()
  check('覆盖标记消失', !state.settleMs.overridden)
  check('回到组合层的值', state.settleMs.text === '250', state.settleMs.text)
  controller.dispose()
}

console.log('\n=== 放弃:改动丢掉,文档不动 ===')
{
  const scope = fakeScope()
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  face.edit('999')
  face.discard()
  const state = face.hooks.substrateCard.getSnapshot()
  check('回到存储值', state.settleMs.text === '250', state.settleMs.text)
  check('不脏了', !state.dirty)
  check('没有写文档', scope.writes.length === 0)
  controller.dispose()
}

console.log('\n=== 写入失败:如实说没成功,并留住改动 ===')
{
  const scope = fakeScope()
  scope.set = async () => { throw new Error('rejected by host') }
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  face.edit('800')
  face.save()
  await new Promise(resolve => { setTimeout(resolve, 0) })
  const state = face.hooks.substrateCard.getSnapshot()
  check('标记为失败', state.failed)
  check('改动没有被清掉', state.settleMs.text === '800' && state.dirty, state.settleMs.text)
  controller.dispose()
}

console.log('\n=== 只读文档:值照看,保存不给按 ===')
{
  const controller = new SubstrateCardController(fakeScope({ writable: false }))
  const face = controller.inject()
  const state = face.hooks.substrateCard.getSnapshot()
  check('writable 为假', !state.writable)
  check('值仍然读得到', state.settleMs.text === '250', state.settleMs.text)
  controller.dispose()
}

console.log('\n=== Host 提交后:未编辑时跟随,编辑中不被覆盖 ===')
{
  const scope = fakeScope()
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  scope.push({ value: { settleMs: 500 } })
  check('没在编辑时跟随文档', face.hooks.substrateCard.getSnapshot().settleMs.text === '500',
    face.hooks.substrateCard.getSnapshot().settleMs.text)
  face.edit('700')
  scope.push({ value: { settleMs: 600 } })
  check('编辑中不被 Host 覆盖', face.hooks.substrateCard.getSnapshot().settleMs.text === '700',
    face.hooks.substrateCard.getSnapshot().settleMs.text)
  controller.dispose()
}

console.log('\n=== 处置后不再跟随 ===')
{
  const scope = fakeScope()
  const controller = new SubstrateCardController(scope)
  const face = controller.inject()
  let notified = 0
  face.hooks.substrateCard.subscribe(() => { notified += 1 })
  controller.dispose()
  scope.push({ value: { settleMs: 900 } })
  check('订阅者没有再被叫醒', notified === 0, String(notified))
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
