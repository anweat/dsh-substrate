/**
 * Pre-boot check tests.
 *
 * The assertions that matter are the ones about restraint. This command's whole
 * value is that it reports a conflict it cannot fix and says so; a version that
 * quietly emitted a patch, or that called a composition clean because it only
 * looked at part of it, would be worse than not running.
 *
 * Run: node plugin/test/check.spec.mjs
 */
import { inspect, render } from '../src/check.mjs'

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const row = (id, name, extra = {}) => ({ id, name, disabled: false, indent: 0, ...extra })

console.log('\n=== 真实案例:anweat/dsh-browser#11 ===')
{
  const result = inspect([
    row('browser', '@deepseek-ai/dsh-builtin-browser'),
    row('browser-electron', '@deepseek-ai/dsh-builtin-browser-electron'),
    row('browser', '@anweat/dsh-browser'),
    row('web-search', 'dsh-web-search-pro'),
  ])
  check('找出那一处致命冲突', result.fatal.length === 1, JSON.stringify(result.fatal))
  check('冲突的是 browser', result.fatal[0].id === 'browser', result.fatal[0].id)
  check('两个认领者都点名', result.fatal[0].claimants.length === 2, JSON.stringify(result.fatal[0].claimants))
  check('不把 browser-electron 算进去 —— 它的 id 是唯一的',
    !result.fatal.some(f => f.id === 'browser-electron'))
  check('给出两条为什么补丁层修不了', result.fatal[0].whyPatchesCannotFix.length === 2)
  check('给出三条出路,并指明谁能做', result.fatal[0].fix.length === 3, JSON.stringify(result.fatal[0].fix))
}

console.log('\n=== 被停掉的行仍然算数 ===')
{
  // This is the whole point: the reporter of #11 tried `disabled: true` and it
  // did not help, because the id check runs before `disabled` is read.
  const result = inspect([
    row('browser', 'builtin', { disabled: true }),
    row('browser', 'third-party'),
  ])
  check('停掉一行不会让冲突消失', result.fatal.length === 1, JSON.stringify(result.fatal))
}

console.log('\n=== 干净的组合 ===')
{
  const result = inspect([row('browser', 'builtin'), row('browser-pro', 'third-party')])
  check('id 唯一时无致命项', result.fatal.length === 0, JSON.stringify(result.fatal))
  const text = render(result)
  // The claim must stay scoped to what was actually examined. "No entry id
  // conflicts" is true; "no conflicts" would be a promise this command has no
  // standing to make, and the text says so in as many words.
  check('结论限定在 entry id 上', /entry id 冲突/.test(text), text.slice(0, 80))
  check('并明说这不等于没有冲突', /这不是[""]?没有冲突/.test(text), text.slice(0, 120))
  check('说明自己看不见什么', /看不见|看不到/.test(text), text.slice(0, 240))
}

console.log('\n=== 报告本身 ===')
{
  const text = render(inspect([row('a', 'x'), row('a', 'y'), row('b', 'z')]))
  check('点名两个认领者', text.includes('x') && text.includes('y'))
  check('不提没冲突的那行', !text.includes('z'), text)
  check('说清后果是整个 profile 起不来', /起不来/.test(text))
}

console.log('\n=== 补丁只在有冲突时才提 ===')
{
  const dirty = render(inspect([row('a', 'x'), row('a', 'y')]))
  check('有冲突时给出可粘贴的 pnpm-workspace.yaml 片段',
    /patchedDependencies:/.test(dirty) && /cordis-plugin-include@/.test(dirty), dirty.slice(-240))
  // pnpm 11 stopped reading the `pnpm` field in package.json; pointing someone
  // at the old location produces a WARN and a setting that silently does nothing.
  check('位置写的是 pnpm-workspace.yaml,不是 package.json',
    /pnpm-workspace\.yaml/.test(dirty) && !/package\.json/.test(dirty))

  const clean = render(inspect([row('a', 'x'), row('b', 'y')]))
  check('没冲突时不推销补丁', !/patchedDependencies/.test(clean), clean.slice(0, 120))
}

console.log('\n=== 三行抢同一个 id ===')
{
  const result = inspect([row('s', 'a'), row('s', 'b'), row('s', 'c')])
  check('算作一处冲突而不是三处', result.fatal.length === 1, String(result.fatal.length))
  check('三个认领者都列出', result.fatal[0].claimants.length === 3, JSON.stringify(result.fatal[0].claimants))
}

console.log('\n=== 边界 ===')
{
  check('空组合不报错', inspect([]).fatal.length === 0)
  check('没有 name 的行也能报', inspect([row('a', undefined), row('a', undefined)]).fatal.length === 1)
  check('行数如实回报', inspect([row('a', 'x'), row('b', 'y')]).rows === 2)
}

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
