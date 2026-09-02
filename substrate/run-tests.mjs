/**
 * Substrate test runner: one command, one verdict per suite.
 *
 * Mirrors the lab runner so a session can check the whole substrate without
 * reading each suite. Suites are standalone scripts that print `PASS`/`FAIL`
 * and exit non-zero; this collects them and writes STATUS.json.
 *
 * Usage:
 *   node run-tests.mjs            every suite
 *   node run-tests.mjs scope      suites whose name matches
 *   node run-tests.mjs --list     registry and last results, without running
 */
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const STATUS = join(here, 'STATUS.json')

/** Registered suites: file plus the layer and contract it pins. */
const SUITES = [
  { file: 'test/arbitrate.spec.mjs', layer: 'L1+L2', pins: '贡献归一化与裁决:五种 remedy、加法型不判争用、幂等、每包结局' },
  { file: 'test/emit-patch.spec.mjs', layer: 'L3', pins: '补丁发射:建组/重新安家/撤下前端半,并用 applyEntryPatches 镜像重放验证' },
  { file: 'test/scope-chain.spec.mjs', layer: 'L3', pins: 'scope 排链:传递顺序、环检测与降级、绑定顺序' },
  { file: 'test/realm-proxy.spec.mjs', layer: 'L3', pins: '路由 realm 代理:去掉重复路径的抛错、只改写落败者、归属取自调用方、处置权不转移' },
  { file: 'test/emit-preset.spec.mjs', layer: 'L3', pins: '预设发射:一个预设一个 scope 故争用者不可同处、服务行必须套 isolate 组、YAML 渲染' },
  { file: 'test/predict.spec.mjs', layer: '守门员', pins: '从 entry list 预测:只有会抛错的类型算致命、归属是行不是模块、未知包如实报告' },
  { file: 'test/tokens.spec.mjs', layer: 'L4', pins: '设计令牌契约:层与暗色翻转、三条规则、只有 dangling 自证是缺陷、声明发射' },
  { file: '../plugin/test/stage-patch.spec.mjs', layer: '插件', pins: '补丁投放:写进 pnpm-workspace.yaml 而非 package.json、不破坏他人内容、关闭后逐字还原、幂等' },
  { file: '../plugin/test/check.spec.mjs', layer: '插件', pins: '启动前检查:找出重复 entry id、被停的行仍算数、结论限定在自己看得见的范围' },
  { file: 'test/panel.spec.mjs', layer: 'L4', pins: '面板脚手架:路径从包名派生故不同包不撞、身份取自调用方 ctx、handler 与声明对齐、一个面板两笔贡献' },
]

const args = process.argv.slice(2)
const filter = args.find(a => !a.startsWith('--'))

if (args.includes('--list')) {
  const prev = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : { results: [] }
  const byFile = new Map((prev.results ?? []).map(r => [r.file, r]))
  console.log(`\n测试注册表(上次运行: ${prev.ranAt ?? '从未'})\n`)
  for (const s of SUITES) {
    const last = byFile.get(s.file)
    const mark = last === undefined ? ' ?  ' : last.ok ? ' ok ' : 'FAIL'
    console.log(`  [${mark}] ${last ? `${last.passed}/${last.total}`.padEnd(7) : '       '} ${s.layer.padEnd(5)} ${s.file}`)
    console.log(`             ${s.pins}`)
  }
  const known = new Set(SUITES.map(s => s.file.replace('test/', '')))
  const stray = readdirSync(join(here, 'test')).filter(f => f.endsWith('.spec.mjs') && !known.has(f))
  if (stray.length > 0) console.log(`\n  未注册的测试文件: ${stray.join(', ')}`)
  process.exit(0)
}

const targets = SUITES.filter(s => filter === undefined || s.file.includes(filter))
if (targets.length === 0) {
  console.error(`没有匹配 "${filter}" 的测试;用 --list 看注册表`)
  process.exit(1)
}

const results = []
for (const s of targets) {
  const run = spawnSync(process.execPath, [s.file], { cwd: here, encoding: 'utf8', timeout: 120000 })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const passed = (out.match(/^\s*PASS\s/gm) ?? []).length
  const failed = (out.match(/^\s*FAIL\s/gm) ?? []).length
  const ok = run.status === 0 && failed === 0
  results.push({ file: s.file, layer: s.layer, ok, passed, failed, total: passed + failed })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(passed).padStart(3)}/${String(passed + failed).padEnd(3)}  ${s.layer.padEnd(5)}  ${s.file}`)
  if (!ok) {
    for (const line of out.split('\n').filter(l => /^\s*FAIL\s/.test(l))) console.log(`        ${line.trim()}`)
    for (const line of out.trim().split('\n').slice(-3)) console.log(`        | ${line}`)
  }
}

const totalPassed = results.reduce((a, r) => a + r.passed, 0)
const totalFailed = results.reduce((a, r) => a + r.failed, 0)
writeFileSync(STATUS, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2))
console.log(`\n合计 ${totalPassed} 通过, ${totalFailed} 失败  ->  STATUS.json`)
process.exit(totalFailed === 0 && results.every(r => r.ok) ? 0 : 1)
