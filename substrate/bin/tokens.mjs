/**
 * Generate the token contract from a dsh checkout, and check CSS against it.
 *
 * The vocabulary is read out of the shell's ambient stylesheets rather than
 * maintained by hand, so the contract cannot drift from what the shell actually
 * defines: regenerate after a theme change and a removed token turns every
 * reference to it into a finding.
 *
 * Usage:
 *   node bin/tokens.mjs emit <dsh-root> [out.d.ts]   write the declaration
 *   node bin/tokens.mjs lint <dsh-root> [scan-root]  check CSS against it
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseTokens, lintCss, summarize, renderDeclaration } from '../src/tokens.mjs'

/** Stylesheets the shell applies to `body`, whose tokens every plugin inherits. */
const AMBIENT = ['design-platform.css', 'gradient-shadow-text.css', 'base.css', 'shiki.css']
const AMBIENT_DIR = join('packages', 'client', 'ui-theme', 'src', 'styles')
const SKIP = /^(node_modules|lib|dist|out|build|\.git)$/

/** Every `.css` file under a root, skipping build output. */
function stylesheets(root) {
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (!SKIP.test(entry.name)) walk(path) }
      else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(root)
  return found
}

/** Read the ambient vocabulary out of a dsh checkout. */
function vocabularyOf(dshRoot) {
  const dir = join(dshRoot, AMBIENT_DIR)
  const sources = AMBIENT
    .map(name => ({ name, path: join(dir, name) }))
    .filter(s => existsSync(s.path))
    .map(s => ({ name: s.name, css: readFileSync(s.path, 'utf8') }))
  if (sources.length === 0) throw new Error(`no ambient stylesheet under ${dir} — is this a dsh checkout?`)
  return { ...parseTokens(sources), sources: sources.map(s => s.name) }
}

const [command, dshRoot, target] = process.argv.slice(2)
if (command === undefined || dshRoot === undefined) {
  console.error('usage: node bin/tokens.mjs <emit|lint> <dsh-root> [out.d.ts | scan-root]')
  process.exit(2)
}

const vocabulary = vocabularyOf(dshRoot)
const tiers = new Map()
for (const [name, record] of vocabulary.tokens) {
  const t = tiers.get(record.tier) ?? { total: 0, flips: 0 }
  t.total += 1
  if (record.flips) t.flips += 1
  tiers.set(record.tier, t)
  void name
}

if (command === 'emit') {
  const out = target ?? join(dshRoot, 'tokens.d.ts')
  writeFileSync(out, renderDeclaration(vocabulary))
  console.log(`\n来源 ${vocabulary.sources.join(', ')}`)
  console.log(`令牌 ${vocabulary.tokens.size}`)
  for (const [tier, t] of tiers) console.log(`  ${tier.padEnd(9)}${String(t.total).padStart(4)}  暗色重定义 ${t.flips}`)
  console.log(`\n写出 ${out}\n`)
  process.exit(0)
}

if (command !== 'lint') {
  console.error(`unknown command "${command}" — expected emit or lint`)
  process.exit(2)
}

const scanRoot = target ?? join(dshRoot, 'packages', 'client')
const ambientPath = join(dshRoot, AMBIENT_DIR)
const findings = []
for (const file of stylesheets(scanRoot)) {
  if (file.startsWith(ambientPath)) continue
  findings.push(...lintCss(readFileSync(file, 'utf8'), {
    tokens: vocabulary.tokens,
    file: relative(dshRoot, file).split(sep).join('/'),
  }))
}

const s = summarize(findings)
console.log(`\n词表 ${vocabulary.tokens.size} 个令牌 · 扫描 ${relative(dshRoot, scanRoot).split(sep).join('/') || '.'}`)
console.log(`发现 ${s.total} —— 缺陷 ${s.errors},建议 ${s.advisories}\n`)

const RULE_NOTE = {
  dangling: '引用了不存在的令牌,且无回退 —— 该声明在运行时解析为空',
  'static-on-themed': '主题属性上用了固定调色板 —— 若不是品牌色,暗色下不会跟随',
  'pinned-literal': '写死了不透明颜色 —— 若底不是两色都深的浮层,暗色下不会跟随',
}
for (const [rule, note] of Object.entries(RULE_NOTE)) {
  const hits = findings.filter(f => f.rule === rule)
  if (hits.length === 0) continue
  console.log(`[${rule}] ${hits.length} ${hits[0].severity === 'error' ? '缺陷' : '建议'} —— ${note}`)
  // A multi-line declaration reports one finding per reference; collapse them
  // so a gradient of five brand stops reads as one place to look at.
  const seen = new Set()
  for (const f of hits) {
    const where = `${f.file}:${f.line}`
    const line = `    ${where}  ${f.property}: ${f.token ?? f.value}`
    if (seen.has(line)) continue
    seen.add(line)
    console.log(line)
  }
  console.log()
}

// Advisories need a human to rule on brand colours and always-dark surfaces,
// so only proven defects decide the exit status.
process.exit(s.errors === 0 ? 0 : 1)
