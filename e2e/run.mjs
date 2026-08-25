/**
 * The end-to-end install: N corpus packages on a real shipped profile, booted
 * twice.
 *
 * Every layer of this project was verified on its own and nothing had ever
 * booted whole. This is the join. It generates one plugin module per corpus
 * package registering that package's real tool names, composes them onto
 * `examples/headless-agent/cordis.yml`, boots that, then boots the same
 * composition with the substrate's arbitration applied.
 *
 * A successful second boot is not the claim on its own — an empty registry
 * boots fine too. The run also reads every scope the substrate minted and
 * counts the tools reachable only through it, so "no collision" cannot be
 * satisfied by having quietly dropped the registrations.
 *
 * Usage: node e2e/run.mjs [count]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { DSH_ROOT, require_ } from '../paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = require_(DSH_ROOT, 'DSH_ROOT', 'read the shipped profile it composes onto')
const count = process.argv[2] ?? '400'
const workspace = join(here, 'workspace')

let ok = 0, fail = 0
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const node = (script, ...args) => spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', join(here, script), ...args],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

const bootReport = (config) => {
  const run = node('boot-once.mjs', config)
  const text = `${run.stdout}`.trim()
  const start = text.indexOf('{')
  if (start === -1) return { ok: false, parseFailure: text.slice(-400) }
  try { return JSON.parse(text.slice(start)) } catch { return { ok: false, parseFailure: text.slice(-400) } }
}

console.log(`\n=== 生成 ${count} 个语料包 ===`)
console.log(node('../e2e/generate.mjs', count).stdout.trim())

console.log('=== 读出厂工具名(不猜) ===')
const shipped = node('shipped-tools.mjs', join(repoRoot, 'examples/headless-agent/cordis.yml'), join(here, 'shipped-tools.json'))
console.log(`  ${shipped.stdout.trim().split('\n')[0]}`)

const rows = JSON.parse(readFileSync(join(workspace, 'rows.json'), 'utf8'))
const registrations = rows.reduce((total, row) => total + row.tools.length, 0)

console.log('\n=== A. 真出厂 profile + 这些插件,无底座 ===')
const before = bootReport(join(workspace, 'cordis.yml'))
check('启动失败 —— 今天同装这些包就是这个结果', before.ok === false, JSON.stringify(before).slice(0, 200))
check('失败原因全是工具撞名',
  before.kinds !== undefined && Object.keys(before.kinds).every(k => /already registered/.test(k)),
  JSON.stringify(before.kinds))
console.log(`        ${before.failures} 起注册失败,${(before.ms / 1000).toFixed(1)}s`)

console.log('\n=== 裁决 ===')
console.log(node('../e2e/compose.mjs').stdout.trim().split('\n').filter(l => l.trim() !== '').join('\n'))

console.log('\n=== B. 同一组合,底座已应用 ===')
const after = bootReport(join(workspace, 'cordis.substrate.yml'))
check('启动成功', after.ok === true, JSON.stringify(after).slice(0, 300))
check('全局命名空间没有重名', after.duplicateNames === 0, String(after.duplicateNames))
check('确实建了 scope', after.scopes > 0, String(after.scopes))
check('落败者的工具进了 scope,没有被垫片吞掉',
  after.scopedOnly > 0, `scopedOnly=${after.scopedOnly}`)
check('可达工具总数与注册量同量级 —— 没有静默丢弃',
  after.globalTools + after.scopedOnly >= registrations * 0.5,
  `${after.globalTools} 全局 + ${after.scopedOnly} scope 内,注册 ${registrations}`)

console.log(`\n        ${rows.length} 包 · ${registrations} 次注册`)
console.log(`        ${after.entries} 条目 · ${after.globalTools} 全局工具 · ${after.scopes} scope · ${after.scopedOnly} scope 内工具`)
console.log(`        ${(after.ms / 1000).toFixed(1)}s`)

console.log(`\n=== 结果: ${ok} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
